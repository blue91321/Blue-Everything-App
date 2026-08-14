/**
 * Spotify: playlists, saved tracks, and the artists you follow.
 *
 * The shape of this file is dictated by one fact worth stating up front:
 * **Spotify no longer tells you anything about how a song sounds.** The
 * `audio-features`, `audio-analysis` and `recommendations` endpoints were
 * withdrawn on 27 November 2024 and return 403 to any application registered
 * since. There is no replacement.
 *
 * So categorisation here rests entirely on the genre strings attached to
 * *artists*, which means an extra fetch per batch of artists that would
 * otherwise be unnecessary — and it means the labels are coarse. That is the
 * honest ceiling of what the API now supports, and the Music screen says so
 * rather than presenting a genre guess as if it were a measurement.
 */
import { apiGet } from '../oauth.js';
import type { FollowedAccount } from '@everything/shared/integrations';
import {
  ignoredCollectionKeys,
  markCollectionSynced,
  replaceCollectionItems,
  replaceFollows,
  upsertCollection,
  upsertItems,
  type IncomingItem,
} from '../store.js';

const API = 'https://api.spotify.com/v1';

/* ------------------------------------------------------------------ */
/* Their shapes, only the parts we use                                 */
/* ------------------------------------------------------------------ */

interface Page<T> {
  items: T[];
  next: string | null;
  total?: number;
}

interface SpotifyArtistRef {
  id: string | null;
  name: string;
}

interface SpotifyTrack {
  id: string | null;
  name: string;
  duration_ms: number;
  artists: SpotifyArtistRef[];
  album?: { name: string; release_date?: string; images?: Array<{ url: string }> };
  external_urls?: { spotify?: string };
}

interface SpotifyPlaylist {
  id: string;
  name: string;
  description: string | null;
  snapshot_id: string;
  images: Array<{ url: string }> | null;
  tracks: { total: number };
}

/* ------------------------------------------------------------------ */

export async function whoAmI(): Promise<{ id: string; name: string }> {
  const me = await apiGet<{ id: string; display_name: string | null }>('spotify', `${API}/me`);
  return { id: me.id, name: me.display_name ?? me.id };
}

/**
 * Walk a paged endpoint to the end.
 *
 * Spotify hands back an absolute `next` URL, so this follows it rather than
 * computing offsets — which is both simpler and immune to the collection
 * changing underneath a long sync.
 *
 * `max` exists because Liked Songs can be tens of thousands of tracks and an
 * unbounded loop against a rate-limited API is a good way to spend a lunch
 * hour. It is high enough not to bite a normal library and low enough to be a
 * bounded failure rather than an open-ended one.
 */
async function pageThrough<T>(firstUrl: string, max = 10_000): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = firstUrl;

  while (url && out.length < max) {
    const page: Page<T> = await apiGet<Page<T>>('spotify', url);
    out.push(...page.items);
    url = page.next;
  }

  return out;
}

/**
 * Genres, per artist, fetched in batches of fifty and remembered for the run.
 *
 * The cache is per-sync rather than persistent on purpose: a library where the
 * same forty artists account for most of the tracks turns thousands of lookups
 * into a handful of requests, and an artist's genres do drift, so carrying the
 * cache across syncs would freeze a categorisation that the next sync is
 * supposed to be an opportunity to correct.
 */
class ArtistGenres {
  private readonly known = new Map<string, string[]>();

  async load(ids: string[]): Promise<void> {
    const wanted = [...new Set(ids)].filter((id) => id && !this.known.has(id));

    for (let i = 0; i < wanted.length; i += 50) {
      const batch = wanted.slice(i, i + 50);
      const response = await apiGet<{ artists: Array<{ id: string; genres: string[] } | null> }>(
        'spotify',
        `${API}/artists?ids=${batch.join(',')}`
      );
      for (const artist of response.artists) {
        if (artist) this.known.set(artist.id, artist.genres ?? []);
      }
      // An artist the API declined to return is recorded as having none, so a
      // later lookup does not refetch it for the whole of this sync.
      for (const id of batch) if (!this.known.has(id)) this.known.set(id, []);
    }
  }

  for(track: SpotifyTrack): string[] {
    return track.artists.flatMap((a) => (a.id ? this.known.get(a.id) ?? [] : []));
  }
}

function toItem(track: SpotifyTrack, genres: string[]): IncomingItem | null {
  // Local files in a playlist have no id and cannot be referred to again, so
  // there is nothing to store and nothing that would ever match.
  if (!track.id) return null;

  return {
    providerItemId: track.id,
    kind: 'track',
    title: track.name,
    creator: track.artists.map((a) => a.name).join(', ') || null,
    // Every artist on the track, so a followed artist counts the collaborations
    // they appear on and not only what they released alone.
    creatorIds: track.artists.map((a) => a.id).filter((id): id is string => !!id),
    album: track.album?.name ?? null,
    durationMs: track.duration_ms,
    url: track.external_urls?.spotify ?? `https://open.spotify.com/track/${track.id}`,
    artUrl: track.album?.images?.[0]?.url ?? null,
    genres,
    releasedAt: parseReleaseDate(track.album?.release_date),
  };
}

/** `2019`, `2019-03`, or `2019-03-14` — all three are legal here. */
function parseReleaseDate(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value.length === 4 ? `${value}-01-01` : value.length === 7 ? `${value}-01` : value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Store a batch of tracks, having first looked up their artists' genres.
 *
 * Genres are loaded for the whole batch before anything is written, so the
 * fifty-artists-per-request budget is spent once per playlist rather than once
 * per track.
 */
async function storeTracks(tracks: SpotifyTrack[], artists: ArtistGenres): Promise<string[]> {
  await artists.load(tracks.flatMap((t) => t.artists.map((a) => a.id).filter((id): id is string => !!id)));

  const items = tracks.map((t) => toItem(t, artists.for(t))).filter((i): i is IncomingItem => i !== null);
  return upsertItems('spotify', items);
}

/* ------------------------------------------------------------------ */
/* Capabilities                                                        */
/* ------------------------------------------------------------------ */

export interface SyncResult {
  /** One line per thing done, shown on the screen after a sync. */
  notes: string[];
}

export async function syncPlaylists(): Promise<SyncResult> {
  const artists = new ArtistGenres();
  const notes: string[] = [];

  // Ticked off on the Music tab, same as YouTube's.
  const ignored = await ignoredCollectionKeys('spotify');

  /* Liked Songs first — it is the one everybody actually has. */
  if (ignored.has('saved')) {
    notes.push('Liked Songs ignored');
  } else {
    const saved = await pageThrough<{ added_at: string; track: SpotifyTrack }>(`${API}/me/tracks?limit=50`);
    const savedCollection = await upsertCollection('spotify', {
      providerCollectionId: 'saved',
      kind: 'saved',
      name: 'Liked Songs',
      itemCount: saved.length,
    });
    const savedIds = await storeTracks(
      saved.map((s) => s.track),
      artists
    );
    await replaceCollectionItems(
      savedCollection.id,
      savedIds,
      saved.map((s) => Date.parse(s.added_at) || null)
    );
    await markCollectionSynced(savedCollection.id, null);
    notes.push(`Liked Songs: ${savedIds.length} tracks`);
  }

  /* Then the playlists proper. */
  const playlists = await pageThrough<SpotifyPlaylist>(`${API}/me/playlists?limit=50`);

  let skipped = 0;
  for (const playlist of playlists) {
    if (ignored.has(playlist.id)) {
      skipped += 1;
      continue;
    }

    const collection = await upsertCollection('spotify', {
      providerCollectionId: playlist.id,
      kind: 'playlist',
      name: playlist.name,
      description: playlist.description,
      artUrl: playlist.images?.[0]?.url ?? null,
      itemCount: playlist.tracks.total,
      snapshotId: playlist.snapshot_id,
    });

    /*
     * `snapshot_id` changes whenever a playlist's contents change, so an
     * untouched playlist costs one request instead of one per fifty tracks.
     * On a library of eighty playlists that is the difference between a sync
     * that takes a minute and one that takes ten — and it is the reason the
     * column is stored at all.
     */
    if (collection.snapshotId === playlist.snapshot_id) continue;

    const entries = await pageThrough<{ added_at: string; track: SpotifyTrack | null }>(
      `${API}/playlists/${playlist.id}/tracks?limit=100`
    );
    // Episodes in a music playlist come back as nulls, as do tracks pulled from
    // the catalogue since they were added.
    const present = entries.filter((e): e is { added_at: string; track: SpotifyTrack } => e.track !== null);

    const ids = await storeTracks(
      present.map((e) => e.track),
      artists
    );
    await replaceCollectionItems(
      collection.id,
      ids,
      present.map((e) => Date.parse(e.added_at) || null)
    );
    await markCollectionSynced(collection.id, playlist.snapshot_id);
  }

  notes.push(`${playlists.length - skipped} playlists${skipped > 0 ? `, ${skipped} ignored` : ''}`);
  return { notes };
}

/**
 * The artists you follow.
 *
 * Paged differently from everything else here, and that is Spotify's doing
 * rather than a choice: `/me/following` nests its cursor under an `artists` key
 * and pages by `after` rather than by offset, so the walker above cannot be
 * pointed at it. Bounded for the same reason the others are.
 *
 * Needs `user-follow-read`. A connection made before that scope was added
 * carries a token without it and gets a 403 — which is why the screen reports
 * granted scopes rather than assuming.
 */
export async function syncFollows(): Promise<SyncResult> {
  const accounts: FollowedAccount[] = [];
  let after: string | undefined;

  do {
    const query = new URLSearchParams({ type: 'artist', limit: '50' });
    if (after) query.set('after', after);

    const page = await apiGet<{
      artists: {
        items: Array<{
          id: string;
          name: string;
          genres?: string[];
          followers?: { total?: number };
          images?: Array<{ url: string }>;
          external_urls?: { spotify?: string };
        }>;
        next: string | null;
        cursors?: { after?: string | null };
      };
    }>('spotify', `${API}/me/following?${query}`);

    for (const artist of page.artists.items) {
      accounts.push({
        provider: 'spotify',
        providerAccountId: artist.id,
        kind: 'artist',
        name: artist.name,
        url: artist.external_urls?.spotify ?? `https://open.spotify.com/artist/${artist.id}`,
        // The smallest image, not the first: the first is 640px, and a list of
        // three hundred artists should not pull three hundred large images.
        avatarUrl: artist.images?.[artist.images.length - 1]?.url,
        genres: artist.genres ?? [],
        followerCount: artist.followers?.total,
      });
    }

    // `next` going null is the end; the cursor only means anything while it
    // does not. Checking both means a malformed page ends the loop rather than
    // spinning on the same `after` forever.
    after = page.artists.next ? page.artists.cursors?.after ?? undefined : undefined;
  } while (after && accounts.length < 5000);

  await replaceFollows('spotify', accounts);
  return { notes: [`${accounts.length} artists followed`] };
}
