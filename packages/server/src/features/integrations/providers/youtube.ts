/**
 * YouTube: playlists, liked videos and subscriptions.
 *
 * Watch history is deliberately absent from this file, and not because it was
 * left for later. `contentDetails.relatedPlaylists.watchHistory` has returned
 * the literal string `HL` and an empty list for every channel since 12 September
 * 2016, and the `activities` endpoint that partly replaced it is deprecated.
 * There is no API path to your watch history at any quota level.
 *
 * The complete history *is* available — from Google Takeout, as a file. That
 * lives in `takeout.ts`, and it is the better source anyway: it goes back to
 * whenever you started rather than to whenever you connected.
 */
import { apiGet } from '../oauth.js';
import { categoriseVideo } from '@everything/shared/integrations';
import {
  markCollectionSynced,
  replaceCollectionItems,
  upsertCollection,
  upsertItems,
  type IncomingItem,
} from '../store.js';

const API = 'https://www.googleapis.com/youtube/v3';

interface Page<T> {
  items: T[];
  nextPageToken?: string;
}

interface PlaylistSnippet {
  id: string;
  snippet: { title: string; description: string; thumbnails?: { medium?: { url: string } } };
  contentDetails: { itemCount: number };
}

interface PlaylistItem {
  contentDetails: { videoId: string; videoPublishedAt?: string };
  snippet: { title: string; publishedAt: string; videoOwnerChannelTitle?: string };
}

interface VideoDetail {
  id: string;
  snippet: { title: string; channelTitle: string; publishedAt: string; categoryId?: string; thumbnails?: { medium?: { url: string } } };
  contentDetails?: { duration?: string };
  topicDetails?: { topicCategories?: string[] };
}

/* ------------------------------------------------------------------ */

export async function whoAmI(): Promise<{ id: string; name: string }> {
  const response = await apiGet<{ items?: Array<{ id: string; snippet: { title: string } }> }>(
    'youtube',
    `${API}/channels?part=snippet&mine=true`
  );
  const channel = response.items?.[0];
  if (!channel) throw new Error('that Google account has no YouTube channel');
  return { id: channel.id, name: channel.snippet.title };
}

/**
 * Page through, following `nextPageToken`.
 *
 * Bounded, like the Spotify walker and for the same reason — but lower, because
 * YouTube's quota is counted in units per day rather than requests per second.
 * A runaway loop here does not get rate-limited, it exhausts the day's quota and
 * every other call fails until midnight Pacific.
 */
async function pageThrough<T>(url: string, max = 2000): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;

  do {
    const page = await apiGet<Page<T>>('youtube', token ? `${url}&pageToken=${token}` : url);
    out.push(...page.items);
    token = page.nextPageToken;
  } while (token && out.length < max);

  return out;
}

/** `PT4M13S` → 253000. Hours, minutes and seconds are each optional. */
export function parseIsoDuration(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!match) return null;
  const [, d, h, m, s] = match;
  return ((Number(d ?? 0) * 24 + Number(h ?? 0)) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0)) * 1000;
}

/**
 * Fetch the details a playlist entry does not carry.
 *
 * `playlistItems` gives a title and a video id and nothing else useful — no
 * duration, no category, no topics — so a second pass over `videos` is required
 * for anything to be categorised at all. Fifty ids per request is the maximum,
 * and it costs one quota unit, so this is cheap in units and expensive in
 * round trips.
 */
async function detailsFor(videoIds: string[]): Promise<Map<string, VideoDetail>> {
  const found = new Map<string, VideoDetail>();

  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const response = await apiGet<{ items: VideoDetail[] }>(
      'youtube',
      `${API}/videos?part=snippet,contentDetails,topicDetails&id=${batch.join(',')}`
    );
    for (const video of response.items) found.set(video.id, video);
  }

  return found;
}

function toItem(videoId: string, detail: VideoDetail | undefined, fallbackTitle: string): IncomingItem {
  const topics = detail?.topicDetails?.topicCategories ?? [];
  const decided = categoriseVideo(detail?.snippet.categoryId ?? null, topics);

  return {
    providerItemId: videoId,
    kind: 'video',
    // A deleted or private video is absent from `videos` but still listed in the
    // playlist. Keeping the playlist's own title means the row says "Deleted
    // video" rather than vanishing, which is the truthful rendering of a
    // playlist that has holes in it.
    title: detail?.snippet.title ?? fallbackTitle,
    creator: detail?.snippet.channelTitle ?? null,
    durationMs: parseIsoDuration(detail?.contentDetails?.duration),
    url: `https://www.youtube.com/watch?v=${videoId}`,
    artUrl: detail?.snippet.thumbnails?.medium?.url ?? null,
    // The Wikipedia topic URLs, kept verbatim — they are what the category was
    // decided from, and stripping them would make a wrong label unexplainable.
    genres: topics,
    category: decided.category,
    categoryBecause: decided.because,
    releasedAt: detail?.snippet.publishedAt ? Date.parse(detail.snippet.publishedAt) || null : null,
  };
}

async function syncOnePlaylist(
  providerCollectionId: string,
  name: string,
  kind: 'playlist' | 'saved',
  extra: { description?: string | null; artUrl?: string | null; itemCount?: number } = {}
): Promise<number> {
  const entries = await pageThrough<PlaylistItem>(
    `${API}/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=${providerCollectionId}`
  );

  const details = await detailsFor(entries.map((e) => e.contentDetails.videoId));
  const items = entries.map((e) =>
    toItem(e.contentDetails.videoId, details.get(e.contentDetails.videoId), e.snippet.title)
  );

  const collection = await upsertCollection('youtube', {
    providerCollectionId,
    kind,
    name,
    description: extra.description ?? null,
    artUrl: extra.artUrl ?? null,
    itemCount: extra.itemCount ?? items.length,
  });

  const ids = await upsertItems('youtube', items);
  await replaceCollectionItems(
    collection.id,
    ids,
    entries.map((e) => Date.parse(e.snippet.publishedAt) || null)
  );
  await markCollectionSynced(collection.id, null);

  return ids.length;
}

export interface SyncResult {
  notes: string[];
}

export async function syncPlaylists(): Promise<SyncResult> {
  const notes: string[] = [];

  /*
   * Liked Videos lives at a playlist id the API only tells you via your own
   * channel — it is not the literal `LL` for everyone, and hard-coding that
   * works right up until it doesn't.
   */
  const channel = await apiGet<{
    items?: Array<{ contentDetails: { relatedPlaylists: { likes?: string } } }>;
  }>('youtube', `${API}/channels?part=contentDetails&mine=true`);

  const likes = channel.items?.[0]?.contentDetails.relatedPlaylists.likes;
  if (likes) {
    try {
      const count = await syncOnePlaylist(likes, 'Liked Videos', 'saved');
      notes.push(`Liked Videos: ${count}`);
    } catch (error) {
      // Liked Videos can be set to private in a way that refuses even your own
      // token. One playlist failing must not abandon the rest of the sync.
      notes.push(`Liked Videos could not be read: ${(error as Error).message}`);
    }
  }

  const playlists = await pageThrough<PlaylistSnippet>(
    `${API}/playlists?part=snippet,contentDetails&mine=true&maxResults=50`
  );

  for (const playlist of playlists) {
    await syncOnePlaylist(playlist.id, playlist.snippet.title, 'playlist', {
      description: playlist.snippet.description,
      artUrl: playlist.snippet.thumbnails?.medium?.url ?? null,
      itemCount: playlist.contentDetails.itemCount,
    });
  }
  notes.push(`${playlists.length} playlists`);

  /*
   * Subscriptions are stored as a collection of their own rather than as
   * playlists, because a channel is not a video and pretending otherwise would
   * put channels in the middle of the music library.
   */
  const subscriptions = await pageThrough<{
    snippet: { title: string; description: string; resourceId: { channelId: string }; thumbnails?: { medium?: { url: string } } };
  }>(`${API}/subscriptions?part=snippet&mine=true&maxResults=50&order=alphabetical`);

  const subsCollection = await upsertCollection('youtube', {
    providerCollectionId: 'subscriptions',
    kind: 'subscriptions',
    name: 'Subscriptions',
    itemCount: subscriptions.length,
  });

  const subIds = await upsertItems(
    'youtube',
    subscriptions.map((s) => ({
      providerItemId: `channel:${s.snippet.resourceId.channelId}`,
      kind: 'video' as const,
      title: s.snippet.title,
      creator: s.snippet.title,
      url: `https://www.youtube.com/channel/${s.snippet.resourceId.channelId}`,
      artUrl: s.snippet.thumbnails?.medium?.url ?? null,
      // A channel has no genres of its own, and guessing one from its name would
      // put it confidently in the wrong family.
      category: 'unknown',
    }))
  );
  await replaceCollectionItems(subsCollection.id, subIds);
  await markCollectionSynced(subsCollection.id, null);
  notes.push(`${subscriptions.length} subscriptions`);

  return { notes };
}
