/**
 * Spotify: playlists, saved tracks, and a history built one fetch at a time.
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
import {
  findItemIds,
  markCollectionSynced,
  recordPlays,
  replaceCollectionItems,
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

  /* Liked Songs first — it is the one everybody actually has. */
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

  /* Then the playlists proper. */
  const playlists = await pageThrough<SpotifyPlaylist>(`${API}/me/playlists?limit=50`);

  for (const playlist of playlists) {
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

  notes.push(`${playlists.length} playlists`);
  return { notes };
}

/**
 * Fetch the last fifty plays and keep the ones we did not already have.
 *
 * Fifty is the whole of what Spotify will ever return — there is no cursor into
 * older history, and `before`/`after` only move within what it still holds. So
 * the local history is built by asking repeatedly and keeping the overlap out,
 * which is what the unique index on `media_plays` is for.
 *
 * The practical consequence is worth being blunt about on the screen: play
 * fifty-one tracks between two syncs and the first one is gone permanently. It
 * is not a bug to be fixed later; it is the endpoint.
 */
export async function syncHistory(): Promise<SyncResult> {
  const response = await apiGet<{ items: Array<{ track: SpotifyTrack; played_at: string }> }>(
    'spotify',
    `${API}/me/player/recently-played?limit=50`
  );

  if (response.items.length === 0) return { notes: ['no recent plays'] };

  /*
   * Tracks already in the library are the common case — you mostly play things
   * from your own playlists — so they are looked up first and only the genuinely
   * new ones cost an artist-genre fetch.
   */
  const known = await findItemIds(
    'spotify',
    response.items.map((i) => i.track.id).filter((id): id is string => !!id)
  );

  const unknown = response.items.map((i) => i.track).filter((t) => t.id && !known.has(t.id));
  if (unknown.length > 0) {
    const artists = new ArtistGenres();
    const ids = await storeTracks(unknown, artists);
    unknown.forEach((track, index) => {
      if (track.id && ids[index]) known.set(track.id, ids[index]);
    });
  }

  const plays = response.items
    .map((entry) => {
      const itemId = entry.track.id ? known.get(entry.track.id) : undefined;
      const playedAt = Date.parse(entry.played_at);
      return itemId && !Number.isNaN(playedAt)
        ? { itemId, playedAt, source: 'spotify-recent' as const }
        : null;
    })
    .filter((p): p is { itemId: string; playedAt: number; source: 'spotify-recent' } => p !== null);

  const added = await recordPlays(plays);
  return {
    notes: [
      added === 0
        ? 'nothing new — all 50 recent plays were already recorded'
        : `${added} new ${added === 1 ? 'play' : 'plays'} (of the 50 Spotify keeps)`,
    ],
  };
}
