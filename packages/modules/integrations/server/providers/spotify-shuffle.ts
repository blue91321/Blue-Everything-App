/**
 * Play your songs in a properly random order, without making a playlist.
 *
 * Spotify's own shuffle is the complaint this answers. On a playlist of a
 * thousand songs it keeps returning to the same fifty or so — its shuffle is
 * weighted, deliberately — and it carries that order across devices, so
 * switching from the phone to the PC picks the same sequence back up.
 *
 * So the order is decided here and handed to Spotify through its queue, where
 * it plays in order: skip and back work, and another device continues it.
 *
 * - **Play** starts the first song and queues the next few behind it.
 *   Spotify's shuffle is switched off, or it would reshuffle them its own way.
 * - **Add to queue** puts them after whatever is already playing.
 *
 * Either way a session then keeps the queue topped up to a set number of songs
 * ahead, for as long as you are listening to it — see "keeping the queue
 * topped up" below.
 *
 * It was first written to fill a playlist called "Shuffled"; that was not what
 * was wanted — a new playlist in the library to avoid making one — and is gone.
 *
 * The sources are what the last sync stored, Liked Songs and your playlists,
 * so a sync runs first. A song in several lists appears once.
 */
import { randomInt, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { changes, dataDir, db, schema } from '@everything/server/module-api';
import { apiGet, apiSend, grantedScopes } from '../oauth.js';
import { getAccount } from '../store.js';
import { syncPlaylists } from './spotify.js';
import { dealer, oneEach, songKey, type Recency, type Song, type Weights } from './shuffle-rules.js';

const API = 'https://api.spotify.com/v1';
const { mediaItems, mediaCollections, mediaCollectionItems } = schema;

/** Starting and steering playback, and seeing which devices there are. */
export const SHUFFLE_SCOPES = ['user-modify-playback-state', 'user-read-playback-state'];


/**
 * Every Spotify collection, with what is stored of it. `readable` is whether
 * any songs could be fetched: a playlist you saved from somebody else never
 * has any — a Development Mode app may not read a playlist you do not own —
 * and is listed so the card can say why, never offered as a source.
 */
export async function shuffleSources() {
  const rows = await db
    .select({
      id: mediaCollections.id,
      name: mediaCollections.name,
      kind: mediaCollections.kind,
      listed: mediaCollections.itemCount,
      stored: sql<number>`count(${mediaCollectionItems.itemId})`,
    })
    .from(mediaCollections)
    .leftJoin(mediaCollectionItems, eq(mediaCollectionItems.collectionId, mediaCollections.id))
    /*
     * Not one you have ticked "ignore" on (Music → Playlists): that tick says
     * the playlist should not count, and the shuffle listing or playing it
     * would make the tick a half-measure — the rule `categoryBreakdown` keeps.
     * Its songs stay stored; they are simply not offered or dealt.
     */
    .where(and(eq(mediaCollections.provider, 'spotify'), eq(mediaCollections.ignored, 0)))
    .groupBy(mediaCollections.id);
  return rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      readable: Number(r.stored) > 0,
      itemCount: Number(r.stored) > 0 ? Number(r.stored) : r.listed,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type ShuffleMode = 'play' | 'queue';
/**
 * `shuffle`: every song once, evenly. `random`: drawn with replacement, a song
 * kept out for `repeatAfter` songs after it plays, boosts applied.
 */
export type ShuffleOrder = 'shuffle' | 'random';
export type ShuffleResult = { songs: number; of: number; mode: ShuffleMode; device: string };

type Device = { id: string | null; name: string; is_active: boolean; is_restricted: boolean };

/* ---- boosts ------------------------------------------------------ */

/**
 * Boosts live in `data/spotify-weights.json`: a package cannot add a table (see
 * "A package cannot add a table"), and this is a few dozen numbers. Keyed by
 * track URI and by Spotify artist id. Absent means 1; a boost set back to 1 is
 * removed rather than stored.
 */
const WEIGHTS = join(dataDir, 'spotify-weights.json');

export function readWeights(): Weights {
  if (!existsSync(WEIGHTS)) return { songs: {}, artists: {} };
  try {
    const v = JSON.parse(readFileSync(WEIGHTS, 'utf8').replace(/^\uFEFF/, '')) as Partial<Weights>;
    return { songs: v.songs ?? {}, artists: v.artists ?? {} };
  } catch {
    return { songs: {}, artists: {} };
  }
}

export function setWeight(kind: 'song' | 'artist', id: string, weight: number): Weights {
  const w = readWeights();
  const table = kind === 'song' ? w.songs : w.artists;
  if (weight === 1) delete table[id];
  else table[id] = weight;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(`${WEIGHTS}.tmp`, JSON.stringify(w, null, 2));
  renameSync(`${WEIGHTS}.tmp`, WEIGHTS);
  return w;
}

/* ---- the songs --------------------------------------------------- */

/**
 * Every song in these collections, once each — see `oneEach` — with the lists
 * it is in, so the card can show only what the ticked lists hold. A song
 * listed twice under two ids (single and album) carries both lists.
 */
export async function songsIn(collectionIds: string[]): Promise<Array<Song & { artist: string; lists: string[] }>> {
  if (collectionIds.length === 0) return [];
  const rows = await db
    .selectDistinct({
      list: mediaCollectionItems.collectionId,
      id: mediaItems.providerItemId,
      title: mediaItems.title,
      creator: mediaItems.creator,
      creatorIds: mediaItems.creatorIds,
    })
    .from(mediaCollectionItems)
    .innerJoin(mediaItems, eq(mediaItems.id, mediaCollectionItems.itemId))
    .where(and(inArray(mediaCollectionItems.collectionId, collectionIds), eq(mediaItems.provider, 'spotify')));
  const songs = rows.map((r) => {
    let artistIds: string[] = [];
    try {
      artistIds = JSON.parse(r.creatorIds) as string[];
    } catch {
      // A row from before ids were stored: matched by title alone.
    }
    return { uri: `spotify:track:${r.id}`, title: r.title, artist: r.creator ?? '', artistIds, list: r.list };
  });
  const lists = new Map<string, Set<string>>();
  for (const s of songs) {
    const k = songKey(s);
    (lists.get(k) ?? lists.set(k, new Set()).get(k)!).add(s.list);
  }
  return oneEach(songs).map((s) => {
    const { list: _list, ...rest } = s as (typeof songs)[number];
    return { ...rest, lists: [...(lists.get(songKey(s)) ?? [])] };
  });
}

/** [0, 1) from the system's random source, for the weighted draw. */
const rand01 = () => randomBytes(6).readUIntBE(0, 6) / 2 ** 48;

/**
 * One start at a time. Two presses together — a double tap, or the phone and
 * the PC at once — each ran in full: two deals into one queue, and the first
 * session's timer left running with nothing to do. The second is refused
 * while the first is still starting, and says so.
 */
let starting = false;

/**
 * The sync before Play runs at most this often. Pressing Play three times in
 * a minute — as testing it does — need not ask Spotify for every playlist
 * three times; songs added in the last ten minutes wait for the next one.
 */
const PRE_PLAY_SYNC_MS = 10 * 60_000;
let lastPrePlaySync = 0;

export async function shuffleOnSpotify(...args: Parameters<typeof startShuffle>): Promise<ShuffleResult> {
  if (starting) throw new Error('Already starting one, give it a moment.');
  starting = true;
  try {
    return await startShuffle(...args);
  } finally {
    starting = false;
  }
}

async function startShuffle(
  mode: ShuffleMode,
  collectionIds: string[] | undefined,
  order: ShuffleOrder = 'shuffle',
  repeatAfter = 50,
  recency: Omit<Recency, 'history'> = {},
  /** What kind of device Play was pressed on, so the music starts there — see `pickDevice`. */
  from: 'phone' | 'computer' | null = null
): Promise<ShuffleResult> {
  const account = await getAccount('spotify');
  if (!account) throw new Error('Spotify is not connected.');
  const granted = grantedScopes(account);
  if (!SHUFFLE_SCOPES.every((s) => granted.includes(s))) {
    throw new Error(
      'Spotify has not let this app control playback yet. Press Connect on Spotify (Connections → Services, on the PC) once to allow it.'
    );
  }

  /*
   * What you added since the last sync belongs in the deal — but a sync that
   * fails (Spotify having a bad minute) must not stop the music: what is
   * already stored is a perfectly good deal.
   */
  if (Date.now() - lastPrePlaySync > PRE_PLAY_SYNC_MS) {
    await syncPlaylists().catch(() => undefined);
    lastPrePlaySync = Date.now();
  }

  const sources = (await shuffleSources()).filter((s) => s.readable && (!collectionIds || collectionIds.includes(s.id)));
  if (sources.length === 0) throw new Error('Pick at least one list to shuffle from.');

  const pool = await songsIn(sources.map((s) => s.id));
  if (pool.length === 0) {
    throw new Error(
      'No songs are stored for those lists yet. Their songs arrive with a sync: press Sync now on Spotify, then try again.'
    );
  }
  /*
   * What you heard before pressing Play, so Random's gap and recency settings
   * start from the truth rather than from a blank. Spotify remembers fifty.
   * Optional: a failure here costs only that head start.
   */
  let history: string[] = [];
  if (order === 'random') {
    try {
      const recent = await apiGet<{ items: Array<{ track: { uri: string } | null }> }>(
        'spotify',
        `${API}/me/player/recently-played?limit=50`
      );
      history = (recent?.items ?? []).flatMap((i) => (i.track ? [i.track.uri] : []));
    } catch {
      // Played as though nothing had come before.
    }
  }
  /*
   * And the song on now, most recent of all. Spotify's recently-played lists
   * only songs that have finished, so the one playing when Play was pressed
   * was in neither list — and Random dealt "Through the Fire and the Flames"
   * second, while it was still playing, with a gap of five. In Shuffle it
   * keeps the song on out of the first round for the same reason.
   */
  // Asked once, and used again below for carrying the song on.
  type Player = { is_playing: boolean; progress_ms: number | null; item: { uri: string } | null };
  let player = null as Player | null;
  try {
    player = await apiGet<Player | null>('spotify', `${API}/me/player`);
    const on = player?.item?.uri;
    if (on) history = [on, ...history.filter((u) => u !== on)];
  } catch {
    // Not known: the gap starts from what had finished.
  }
  const next = dealer(pool, order, readWeights(), repeatAfter, (n) => randomInt(n), rand01, { ...recency, history });
  /*
   * The first song is dealt knowing what is already waiting in the queue. It
   * was dealt blind, so a song left from an earlier shuffle could be chosen
   * first — played at once, and again a few songs later when its leftover copy
   * came round.
   */
  const waitingAtStart = (await readQueue()) ?? [];
  const first = next(new Set(waitingAtStart));
  if (!first) {
    throw new Error(
      waitingAtStart.some((u) => pool.some((x) => x.uri === u))
        ? 'Every song in those lists is already waiting in your Spotify queue.'
        : 'Every song in those lists is set to never. Lift a boost, or tick another list.'
    );
  }

  /*
   * Playback needs somewhere to happen. The active device if there is one;
   * otherwise the first that Spotify lists, so a phone with the app open but
   * nothing playing still works. With none at all there is nothing to do but
   * say so — Spotify cannot start an app on your phone for you.
   */
  const { devices } = (await apiGet<{ devices: (Device & { type?: string })[] }>('spotify', `${API}/me/player/devices`)) ?? {
    devices: [],
  };
  const usable = devices.filter((d) => d.id && !d.is_restricted);
  const device = pickDevice(usable, player?.is_playing === true, from);
  if (!device?.id) {
    throw new Error('Spotify is not open anywhere. Open it on your phone or PC (it does not have to be playing), then try again.');
  }
  // Spotify queues behind what is playing, and answers a bare 404 when nothing
  // is. Said in words instead, with what to do.
  if (mode === 'queue' && !usable.some((d) => d.is_active)) {
    throw new Error('Nothing is playing to add to. Press Play instead, or start something in Spotify first.');
  }

  stopSession('replaced by a new one');
  // Never fewer queued than the repeat gap in Random — see `minAhead`.
  // Never more queued than there are songs — past that it is only repeats —
  // and never fewer than the repeat gap in Random, which is itself held below it.
  const minAhead = order === 'random' ? Math.min(pool.length, QUEUE_AHEAD_MAX, Math.max(1, repeatAfter)) : 1;
  const ahead = Math.min(pool.length, QUEUE_AHEAD_MAX, Math.max(readShuffleSettings().queueAhead, minAhead));
  const s: Session = {
    deviceId: device.id,
    deviceName: device.name,
    order,
    minAhead,
    next,
    sent: [],
    played: 0,
    pool: pool.length,
    lists: sources.map((x) => x.name),
    repeatAfter: order === 'random' ? repeatAfter : null,
    quietSince: null,
    timer: null,
    stopped: false,
    foreign: new Set(),
    resume: { collectionIds: sources.map((x) => x.id), repeatAfter, recency },
  };
  const inPool = new Set(pool.map((x) => x.uri));

  /*
   * Play lets the song on finish. It was a choice, "cut it off" or not, and
   * the choice went: nothing here can empty a queue, so it is all adding to
   * one, and cutting the song off bought only a skip. Spotify has no way to
   * empty a queue, so instead the
   * song already playing is started again as the only thing playing, at the
   * point it had reached, and the shuffle is queued behind it. What was lined
   * up after it — the rest of an album or playlist — is gone, the song carries
   * on with at most a blip, and the shuffle begins when it ends. Songs you
   * queued by hand in Spotify stay: the API cannot reach those.
   */
  let carryOn: { uri: string; at: number } | null = null;
  if (mode === 'play' && player?.is_playing && player.item?.uri.startsWith('spotify:track:')) {
    // A moment has passed since it was asked; the song is put back where it was then.
    carryOn = { uri: player.item.uri, at: player.progress_ms ?? 0 };
  }

  /*
   * If something fails after the music has started — the eighth song refused
   * on its way into the queue — what was queued is kept and the session runs:
   * its first check tops the queue up. Throwing it all away left music playing
   * with nothing to follow it and an error on the card.
   */
  try {
    if (mode === 'play' && carryOn) {
      await apiSend('spotify', 'PUT', `${API}/me/player/play?device_id=${encodeURIComponent(device.id)}`, {
        uris: [carryOn.uri],
        position_ms: carryOn.at,
      });
      await apiSend('spotify', 'PUT', `${API}/me/player/shuffle?state=false&device_id=${encodeURIComponent(device.id)}`, null);
      // What is still queued from before plays next; take it over, then add ours.
      const waiting = ((await readQueue()) ?? []).filter((u) => u !== carryOn!.uri);
      s.foreign.add(carryOn.uri);
      const taken = adopt(s, waiting, inPool);
      const dealt = await queueFirst(s, first.uri, waiting);
      await enqueue(s, ahead - taken - dealt, waiting);
    } else if (mode === 'play') {
      // One song as the thing playing, the rest queued behind it — so the queue
      // is the whole list, and topping it up keeps the order intact.
      await apiSend('spotify', 'PUT', `${API}/me/player/play?device_id=${encodeURIComponent(device.id)}`, { uris: [first.uri] });
      // Off, or Spotify reshuffles what was just shuffled, its own way.
      await apiSend('spotify', 'PUT', `${API}/me/player/shuffle?state=false&device_id=${encodeURIComponent(device.id)}`, null);
      s.sent.push(first.uri);
      // Playing `first` replaced the album or playlist that was on, but songs
      // queued earlier — a previous shuffle's — are still waiting after it.
      const waiting = ((await readQueue()) ?? []).filter((u) => u !== first.uri);
      const taken = adopt(s, waiting, inPool);
      await enqueue(s, ahead - taken, waiting);
    } else {
      /*
       * Behind whatever is on: the queue there is mostly the album or playlist
       * playing, which is not ours to take over. It is only kept from being
       * dealt twice.
       */
      const waiting = (await readQueue()) ?? [];
      for (const uri of waiting) s.foreign.add(uri);
      const dealt = await queueFirst(s, first.uri, waiting);
      await enqueue(s, ahead - dealt, waiting);
    }
  } catch (error) {
    if (s.sent.length === 0) throw error;
  }
  if (s.sent.length === 0) {
    throw new Error('Every song in those lists is already waiting in the queue.');
  }

  run(s);
  return { songs: s.sent.length, of: pool.length, mode, device: device.name };
}

/** Make `s` the running session: its timer, its file, and the announcement. */
function run(s: Session): void {
  s.timer = setInterval(() => void tick(s), TICK_MS);
  s.timer.unref?.();
  session = s;
  lastEnded = null;
  persist(s);
  changes.emitChange('integrations');
}

/* ---- surviving a restart -------------------------------------------- */

/**
 * The session, on disk, so a restart does not end it.
 *
 * Restarts are ordinary here — an update, the tray's Restart, a crash — and
 * each one silently stopped the topping up: the queued songs played out and
 * then nothing. So what is needed to carry on is written whenever it changes
 * (a song finished, a top-up, a device switch; minutes apart, never per check)
 * and read back at boot. The dealer is rebuilt with what was sent as its
 * history, so Random's gap and Shuffle's deck carry on rather than restart.
 *
 * Only a session that was still alive recently is resumed: one whose music
 * stopped long ago is over, and resuming it would poll an empty room.
 */
const SESSION_FILE = join(dataDir, 'spotify-shuffle-session.json');

type Saved = {
  deviceId: string;
  deviceName: string;
  order: ShuffleOrder;
  minAhead: number;
  sent: string[];
  played: number;
  pool: number;
  lists: string[];
  repeatAfter: number | null;
  resume: Session['resume'];
  savedAt: number;
};

function persist(s: Session): void {
  // The last thousand sent is plenty to know where playback is.
  const drop = Math.max(0, s.sent.length - 1000);
  const saved: Saved = {
    deviceId: s.deviceId,
    deviceName: s.deviceName,
    order: s.order,
    minAhead: s.minAhead,
    sent: s.sent.slice(drop),
    played: Math.max(0, s.played - drop),
    pool: s.pool,
    lists: s.lists,
    repeatAfter: s.repeatAfter,
    resume: s.resume,
    savedAt: Date.now(),
  };
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(`${SESSION_FILE}.tmp`, JSON.stringify(saved));
    renameSync(`${SESSION_FILE}.tmp`, SESSION_FILE);
  } catch {
    // Not saved: a restart will end it, as it always did.
  }
}

function forget(): void {
  try {
    rmSync(SESSION_FILE, { force: true });
  } catch {
    // Nothing to forget.
  }
}

/** Pick up a session the last run left going. Called once, at boot. */
export async function resumeSession(): Promise<void> {
  if (session || !existsSync(SESSION_FILE)) return;
  let saved: Saved;
  try {
    saved = JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as Saved;
  } catch {
    forget();
    return;
  }
  if (Date.now() - saved.savedAt > QUIET_MS) {
    forget();
    return;
  }
  const account = await getAccount('spotify');
  if (!account || !SHUFFLE_SCOPES.every((x) => grantedScopes(account).includes(x))) return forget();
  const sources = (await shuffleSources()).filter((x) => x.readable && saved.resume.collectionIds.includes(x.id));
  const pool = await songsIn(sources.map((x) => x.id));
  if (pool.length === 0) return forget();
  const history = [...saved.sent].reverse();
  const next = dealer(pool, saved.order, readWeights(), saved.resume.repeatAfter, (n) => randomInt(n), rand01, {
    ...saved.resume.recency,
    history,
  });
  run({
    deviceId: saved.deviceId,
    deviceName: saved.deviceName,
    order: saved.order,
    minAhead: saved.minAhead,
    next,
    sent: saved.sent,
    played: saved.played,
    pool: pool.length,
    lists: sources.map((x) => x.name),
    repeatAfter: saved.repeatAfter,
    quietSince: null,
    timer: null,
    stopped: false,
    foreign: new Set(),
    resume: saved.resume,
  });
}

/**
 * Where to play.
 *
 * Spotify's "active" device is the one that played last, playing or not — so
 * pressing Play on the phone, with the PC paused from earlier, started the
 * music on the PC: the phone was listed, just not active. Now:
 *
 * 1. Something **playing** keeps its device. Music already on is never moved.
 * 2. Otherwise the kind of device Play was pressed on: a phone for the phone,
 *    a computer for the PC. Voice counts as the PC, where the microphone is.
 * 3. Otherwise Spotify's active device, then the first it lists.
 */
export function pickDevice<D extends { is_active: boolean; type?: string }>(
  usable: D[],
  playing: boolean,
  from: 'phone' | 'computer' | null
): D | undefined {
  const active = usable.find((d) => d.is_active);
  if (playing && active) return active;
  if (from) {
    const kind = (d: D) => (d.type ?? '').toLowerCase();
    const same = usable.filter((d) =>
      from === 'phone' ? ['smartphone', 'tablet'].includes(kind(d)) : kind(d) === 'computer'
    );
    // The active one of that kind if there is one, else the first of them.
    const pick = same.find((d) => d.is_active) ?? same[0];
    if (pick) return pick;
  }
  return active ?? usable[0];
}

/* ---- keeping the queue topped up ---------------------------------- */

/**
 * A session: the songs this app has put into Spotify's queue, and the dealer
 * that makes more. Held in memory and saved to disk as it changes, so a
 * restart picks it up again — see "surviving a restart".
 *
 * **The one timer here, and only while a session runs.** Spotify will not tell
 * anybody when a song ends, so the only way to know the queue is running low is
 * to ask. Every `TICK_MS` it asks what is playing, and tops up when fewer than
 * the setting are still ahead. It ends itself when you play something that is
 * not from it, when nothing has played for `QUIET_MS`, or when Stop is pressed,
 * so a session nobody is listening to does not poll for ever.
 */
type Session = {
  deviceId: string;
  deviceName: string;
  order: ShuffleOrder;
  /** The fewest songs kept ahead: the repeat gap in Random, else 1. */
  minAhead: number;
  next: (avoid?: ReadonlySet<string>) => Song | null;
  /**
   * Songs that were in Spotify's queue when the session began and are not
   * from its lists — queued by hand, or left from something else. They play
   * before ours; meeting one is waiting, not "something else started".
   */
  foreign: Set<string>;
  /** Every URI queued, in order, the first being the one started with. */
  sent: string[];
  /** How far through `sent` playback has got. */
  played: number;
  pool: number;
  /**
   * What it is playing from, and the gap — reported so the bar can say it. The
   * card's choices are per device, so the phone's Settings describe the phone's
   * ticks, not a session the PC started; the bar is where they agree.
   */
  lists: string[];
  repeatAfter: number | null;
  /** Set by `stopSession`, so a top-up already under way stops adding songs. */
  stopped: boolean;
  /** A check is running; the next one waits its turn. */
  checking?: boolean;
  /** What a restart needs to build the dealer again — see `resumeSession`. */
  resume: { collectionIds: string[]; repeatAfter: number; recency: Omit<Recency, 'history'> };
  quietSince: number | null;
  timer: ReturnType<typeof setInterval> | null;
};

const TICK_MS = 45_000;
const QUIET_MS = 30 * 60_000;
let session: Session | null = null;
let lastEnded: { at: number; why: string } | null = null;

async function queueOne(s: Session, uri: string): Promise<void> {
  await apiSend(
    'spotify',
    'POST',
    `${API}/me/player/queue?uri=${encodeURIComponent(uri)}&device_id=${encodeURIComponent(s.deviceId)}`,
    null
  );
}

/**
 * What is waiting in Spotify's queue now — what is playing and what comes
 * after it. Read before adding anything, because Spotify keeps songs an app
 * queued exactly as it keeps ones queued by hand: a second Play while the
 * first's songs are still waiting put the same songs in again, a few places
 * apart. Null when it cannot be read; the caller then carries on without it.
 */
async function readQueue(): Promise<string[] | null> {
  try {
    const q = await apiGet<{
      currently_playing: { uri: string } | null;
      queue: Array<{ uri: string } | null>;
    } | null>('spotify', `${API}/me/player/queue`);
    if (!q) return [];
    return [q.currently_playing?.uri, ...q.queue.map((x) => x?.uri)].filter((u): u is string => Boolean(u));
  } catch {
    return null;
  }
}

async function enqueue(s: Session, count: number, waiting: readonly string[] = []): Promise<void> {
  // Never deal a song already waiting, nor one this top-up has just added.
  const avoid = new Set([...waiting, ...s.sent.slice(s.played)]);
  for (let i = 0; i < count; i++) {
    // Stop pressed mid-top-up: no more after it.
    if (s.stopped) return;
    const song = s.next(avoid);
    if (!song) return;
    await queueOne(s, song.uri);
    s.sent.push(song.uri);
    avoid.add(song.uri);
  }
}

/**
 * Take over what an earlier shuffle left in the queue.
 *
 * Those songs will play whatever happens — Spotify cannot be told to drop
 * them — so they are counted as this session's: not dealt again, counted
 * toward "queued ahead", and followed as playback reaches them. Anything else
 * waiting there is noted as foreign, so meeting it is not mistaken for you
 * choosing other music. Returns how many were taken over.
 */
/** Queue the song dealt first, unless it is already waiting. Answers how many were added. */
async function queueFirst(s: Session, uri: string, waiting: readonly string[]): Promise<number> {
  if (waiting.includes(uri) || s.sent.includes(uri)) return 0;
  await queueOne(s, uri);
  s.sent.push(uri);
  return 1;
}

function adopt(s: Session, waiting: readonly string[], pool: ReadonlySet<string>): number {
  let taken = 0;
  for (const uri of waiting) {
    if (s.sent.includes(uri)) continue;
    if (pool.has(uri)) {
      s.sent.push(uri);
      taken += 1;
    } else s.foreign.add(uri);
  }
  return taken;
}

async function tick(s: Session): Promise<void> {
  // One check at a time: a slow top-up still adding songs when the next check
  // came round had both adding, and the queue over-filled.
  if (session !== s || s.checking) return;
  s.checking = true;
  try {
    const now = await apiGet<{
      is_playing: boolean;
      item: { uri: string } | null;
      device?: { id: string | null; name: string } | null;
    } | null>('spotify', `${API}/me/player`);
    if (session !== s) return;
    if (!now?.is_playing) {
      s.quietSince ??= Date.now();
      if (Date.now() - s.quietSince > QUIET_MS) stopSession('nothing has played for half an hour');
      return;
    }
    s.quietSince = null;
    /*
     * Follow the music to whichever device is playing it. Switching from the PC
     * to the phone in Spotify carries the queue across, so the session carries
     * on — but it must add songs where the music now is: named by the old
     * device, a top-up either fails once that device is idle or pulls playback
     * back to it. Announced, so "Shuffle is on · iPhone" updates.
     */
    if (now.device?.id && now.device.id !== s.deviceId) {
      s.deviceId = now.device.id;
      s.deviceName = now.device.name;
      persist(s);
      changes.emitChange('integrations');
    }
    const current = now.item?.uri ?? null;
    /*
     * Searched forward from where playback last was, not back from the end. In
     * Random the same song can be queued twice when the repeat gap is shorter
     * than the queue; the later copy is not the one playing, and finding it
     * made the session think it was further on — and add too many songs. The
     * search from the end is the fallback, for a skip back to an earlier song.
     */
    const fromHere = current ? s.sent.indexOf(current, Math.max(0, s.played - 1)) : -1;
    const at = fromHere !== -1 ? fromHere : current ? s.sent.lastIndexOf(current) : -1;
    if (at === -1) {
      // Not one of ours. Before the first of ours has played (they are queued
      // behind what was already on), or one that was already waiting in the
      // queue when this began, that is waiting; otherwise it is you choosing
      // other music, and the session steps aside.
      if (s.played > 0 && !(current && s.foreign.has(current))) {
        /*
         * A song you added by hand mid-shuffle is not you leaving it: Spotify
         * plays the shuffle's queued songs after it regardless. So it steps
         * aside only when its own songs have gone from the queue; while they
         * are still waiting, this is an interlude.
         */
        const waiting = await readQueue();
        const ours = new Set(s.sent.slice(s.played));
        if (waiting && waiting.some((u) => ours.has(u))) {
          if (current) s.foreign.add(current);
        } else stopSession('something else started playing');
      }
      return;
    }
    /*
     * Announced when a song has finished, so an open Music tab, the menu's dot
     * and the Home tile follow along. Once a song — every few minutes — not
     * every check; an unchanged count says nothing worth reloading for.
     */
    if (at + 1 > s.played) {
      s.played = at + 1;
      persist(s);
      changes.emitChange('integrations');
    }
    const ahead = s.sent.length - s.played;
    const want = Math.min(s.pool, QUEUE_AHEAD_MAX, Math.max(readShuffleSettings().queueAhead, s.minAhead));
    if (ahead < want) {
      // What is waiting now, so nothing already there is dealt again.
      await enqueue(s, want - ahead, (await readQueue()) ?? []);
      if (!s.stopped) persist(s);
      /*
       * Announced again once the top-up is in. The announcement above went out
       * the moment a song had finished, before the songs were added one by one,
       * so a screen reloading on it read "7 played, 13 queued" — and kept
       * reading it until the next song ended, as though the top-up had failed.
       */
      changes.emitChange('integrations');
    }
  } catch (error) {
    // One failed check is not the end: the next tries again. A lost permission
    // or a vanished device keeps failing, and the quiet rule ends it.
    s.quietSince ??= Date.now();
    if (Date.now() - s.quietSince > QUIET_MS) {
      stopSession(error instanceof Error ? error.message : 'Spotify stopped answering');
    }
  } finally {
    s.checking = false;
  }
}

export function stopSession(why = 'stopped'): void {
  if (!session) return;
  if (session.timer) clearInterval(session.timer);
  session.stopped = true;
  session = null;
  forget();
  lastEnded = { at: Date.now(), why };
  // However it ended — Stop, other music, silence — every screen showing it should know.
  changes.emitChange('integrations');
}

/** The server is closing: stop the timer, keep the file, so the next start resumes. */
export function pauseSession(): void {
  if (!session) return;
  if (session.timer) clearInterval(session.timer);
  session.stopped = true;
  session = null;
}

/**
 * Stop, and pause the music too: what "Stop" means to somebody looking at a
 * "Shuffle is on" bar. Pausing is tried and not insisted on — the music may
 * already have stopped, or the device gone — since ending the session is the
 * part that must happen.
 */
export async function stopAndPause(): Promise<void> {
  const s = session;
  stopSession('stopped from the app');
  if (!s) return;
  try {
    await apiSend('spotify', 'PUT', `${API}/me/player/pause?device_id=${encodeURIComponent(s.deviceId)}`, null);
  } catch {
    // Already paused, or nowhere to pause.
  }
}

export function sessionStatus() {
  const s = session;
  return {
    active: s !== null,
    order: s?.order ?? null,
    device: s?.deviceName ?? null,
    played: s?.played ?? 0,
    queued: s ? s.sent.length - s.played : 0,
    lists: s?.lists ?? [],
    repeatAfter: s?.repeatAfter ?? null,
    queueAhead: readShuffleSettings().queueAhead,
    ended: lastEnded,
  };
}

/* ---- the setting ---------------------------------------------------- */

/**
 * How many songs are kept queued ahead. Server-side, beside the boosts, because
 * the session that reads it runs on the server: a per-device setting would be
 * whichever device started it, and the phone and PC would disagree about a
 * queue they share.
 */
const SETTINGS = join(dataDir, 'spotify-shuffle.json');
export const QUEUE_AHEAD_MIN = 1;
/**
 * A hundred at most. Each queued song is a request of its own, and a few
 * hundred at once is what runs into Spotify's rate limit; a hundred songs is
 * five or six hours ahead, and the queue is topped up as they play.
 */
export const QUEUE_AHEAD_MAX = 100;
const QUEUE_AHEAD_DEFAULT = 20;

export function readShuffleSettings(): { queueAhead: number } {
  try {
    const v = JSON.parse(readFileSync(SETTINGS, 'utf8').replace(/^\uFEFF/, '')) as { queueAhead?: unknown };
    const n = typeof v.queueAhead === 'number' ? Math.round(v.queueAhead) : QUEUE_AHEAD_DEFAULT;
    return { queueAhead: Math.min(QUEUE_AHEAD_MAX, Math.max(QUEUE_AHEAD_MIN, n)) };
  } catch {
    return { queueAhead: QUEUE_AHEAD_DEFAULT };
  }
}

export function setQueueAhead(n: number): { queueAhead: number } {
  const queueAhead = Math.min(QUEUE_AHEAD_MAX, Math.max(QUEUE_AHEAD_MIN, Math.round(n)));
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(`${SETTINGS}.tmp`, JSON.stringify({ queueAhead }, null, 2));
  renameSync(`${SETTINGS}.tmp`, SETTINGS);
  return { queueAhead };
}
