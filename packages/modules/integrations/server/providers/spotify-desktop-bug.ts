/**
 * Waiting for Spotify to fix its desktop app, and saying when it has.
 *
 * Since its 2026 autumn updates (1.3.6.1921 here, on October 21), the Windows
 * and Mac desktop app answers OK to a song sent on its own, or added to the
 * queue, and stops instead of playing: the shuffle cannot run on it. The Web
 * Player, the phone and the Linux app are not affected. Spotify's forum has a
 * thread on it with no answer from Spotify yet (`THREAD`).
 *
 * Three things, all here:
 *
 * - **Watching the thread**, once a day while asked to, through the forum's
 *   public API. A reply from Spotify's staff, a volunteer saying it is known
 *   or fixed, a reply that reads as a fix, or the thread answered or closed,
 *   raises a reminder (`desktop-bug-rules.ts` decides which).
 * - **Testing the desktop app**, on a button: one song sent to it on its own,
 *   the way the shuffle sends them. Never on a timer, since a test that
 *   passes starts music on the PC and one that fails clears what it had.
 * - **Noticing by itself**: once the app has seen the refusal, a Play that
 *   the desktop app takes again marks it fixed and says so.
 *
 * While the bug stands, Play prefers the Web Player over the desktop app
 * (`preferWebPlayer`, read by `pickDevice`).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { changes, dataDir, db, getSettings, nudges } from '@everything/server/module-api';
import { resolvePush } from '@everything/shared';
import { apiGet, apiSend } from '../oauth.js';
import { isWebPlayer, newsIn, type ForumNews, type ForumReply, type ForumThread } from './desktop-bug-rules.js';

const API = 'https://api.spotify.com/v1';
const FORUM = 'https://community.spotify.com/forum/api/v2';
export const THREAD = 7552922;
export const THREAD_URL =
  'https://community.spotify.com/forum/en/discussion/7552922/web-api-me-player-play-returns-204-but-does-not-start-playback-and-clears-current-playback-desktop';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
/** A day, less an hour, so the hourly tick does not drift a check later each day. */
const CHECK_EVERY = DAY - HOUR;
const KEEP_NEWS = 10;

export interface DesktopBugState {
  /** Checking the thread once a day. */
  watching: boolean;
  watchingSince: number | null;
  checkedAt: number | null;
  /** The newest reply already looked at, so only later ones are read. */
  seenReply: number | null;
  thread: ForumThread | null;
  /** Why the last check failed, kept beside what it could not replace. */
  error: string | null;
  news: ForumNews[];
  /** When Play last met the refusal. */
  refusedAt: number | null;
  /** When the desktop app took a song again, by a test or a Play. */
  fixedAt: number | null;
  test: { at: number; ok: boolean; device: string; detail: string } | null;
}

const FILE = join(dataDir, 'spotify-desktop-bug.json');
const EMPTY: DesktopBugState = {
  watching: false,
  watchingSince: null,
  checkedAt: null,
  seenReply: null,
  thread: null,
  error: null,
  news: [],
  refusedAt: null,
  fixedAt: null,
  test: null,
};

export function readDesktopBug(): DesktopBugState {
  try {
    return { ...EMPTY, ...(JSON.parse(readFileSync(FILE, 'utf8')) as Partial<DesktopBugState>) };
  } catch {
    return { ...EMPTY };
  }
}

function write(state: DesktopBugState): DesktopBugState {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(`${FILE}.tmp`, JSON.stringify(state, null, 1));
  renameSync(`${FILE}.tmp`, FILE);
  changes.emitChange('integrations');
  return state;
}

function update(change: (s: DesktopBugState) => void): DesktopBugState {
  const s = readDesktopBug();
  change(s);
  return write(s);
}

/** Play should go to the Web Player rather than the desktop app: the bug was seen and has not been seen fixed. */
export function preferWebPlayer(): boolean {
  const s = readDesktopBug();
  return (s.refusedAt !== null || s.watching) && s.fixedAt === null;
}

/** Start or stop watching the thread. Starting checks at once. */
export async function setWatching(on: boolean): Promise<DesktopBugState> {
  update((s) => {
    s.watching = on;
    s.watchingSince = on ? (s.watchingSince ?? Date.now()) : null;
    if (on) s.fixedAt = null;
  });
  return on ? checkThread() : readDesktopBug();
}

/** A reminder through the nudge engine, held for a good moment like any other. */
async function remind(title: string, body: string): Promise<void> {
  const pushDefault = Boolean((await getSettings()).pushDefault);
  const now = Date.now();
  await db.insert(nudges).values({
    title,
    body,
    earliestAt: now,
    deadlineAt: null,
    expiresAt: now + 7 * DAY,
    minQuality: 'any',
    pushToPhone: resolvePush(null, pushDefault) ? 1 : 0,
  });
  changes.emitChange('nudges');
}

async function forum<T>(path: string): Promise<T> {
  const res = await fetch(`${FORUM}${path}`, {
    headers: { accept: 'application/json', 'user-agent': 'BlueEverything/1 (personal app watching one thread)' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`the forum answered ${res.status}`);
  return (await res.json()) as T;
}

type ApiReply = {
  commentID: number;
  dateInserted: string;
  body?: string;
  url?: string;
  insertUser?: { name?: string; label?: string };
};

/** Look at the thread now: two requests, the thread and its newest replies. */
export async function checkThread(): Promise<DesktopBugState> {
  const before = readDesktopBug();
  try {
    const d = await forum<{ closed?: boolean; attributes?: { question?: { status?: string; dateAccepted?: string | null } } }>(
      `/discussions/${THREAD}`
    );
    const thread: ForumThread = {
      accepted: d.attributes?.question?.status === 'accepted' || Boolean(d.attributes?.question?.dateAccepted),
      closed: d.closed === true,
    };
    const raw = await forum<ApiReply[]>(`/comments?discussionID=${THREAD}&limit=50&sort=-dateInserted&expand=insertUser`);
    const replies: ForumReply[] = raw.map((c) => ({
      id: c.commentID,
      at: c.dateInserted,
      by: c.insertUser?.name ?? 'somebody',
      label: c.insertUser?.label ?? '',
      body: c.body ?? '',
      url: c.url ?? THREAD_URL,
    }));
    const newest = replies.reduce((m, r) => Math.max(m, r.id), before.seenReply ?? 0);
    // The first look takes a baseline: what was already there is not news.
    const unseen = before.seenReply === null ? [] : replies.filter((r) => r.id > before.seenReply!);
    const news = newsIn(thread, before.thread, unseen, THREAD_URL);

    const after = update((s) => {
      s.checkedAt = Date.now();
      s.seenReply = newest || null;
      s.thread = thread;
      s.error = null;
      s.news = [...news.reverse(), ...s.news].slice(0, KEEP_NEWS);
    });
    if (news.length > 0) {
      const first = news[0]!;
      await remind(
        'Spotify desktop bug: news on the forum',
        `${first.by}: ${first.excerpt}${news.length > 1 ? ` (and ${news.length - 1} more)` : ''}. Music → Shuffle has the link, and a button to test the desktop app.`
      );
    }
    return after;
  } catch (error) {
    return update((s) => {
      s.checkedAt = Date.now();
      s.error = error instanceof Error ? error.message : String(error);
    });
  }
}

/** Called hourly: looks at the thread if watching and a day has passed. One request pair a day. */
export async function checkIfDue(): Promise<void> {
  const s = readDesktopBug();
  if (!s.watching) return;
  if (s.checkedAt !== null && Date.now() - s.checkedAt < CHECK_EVERY) return;
  await checkThread();
}

/** Play met the refusal on a desktop device. */
export function noteRefused(): void {
  update((s) => {
    s.refusedAt = Date.now();
    s.fixedAt = null;
  });
}

/**
 * Play got a song started on its own on a desktop device. If the refusal had
 * been seen, that is the fix: say so, and stop watching.
 */
export async function noteTaken(device: { name: string }): Promise<void> {
  const s = readDesktopBug();
  if (isWebPlayer(device) || s.fixedAt !== null || (s.refusedAt === null && !s.watching)) return;
  update((x) => {
    x.fixedAt = Date.now();
    x.watching = false;
  });
  await remind(
    'Spotify fixed its desktop app',
    `${device.name} played a song sent to it by the shuffle. Play goes to the desktop app again.`
  );
}

type Device = { id: string | null; name: string; type?: string; is_active: boolean; is_restricted: boolean };
type Player = {
  is_playing: boolean;
  progress_ms: number | null;
  device?: { id: string | null; name: string } | null;
  item?: { uri: string; linked_from?: { uri: string } } | null;
} | null;

/**
 * Send one song, on its own, to the desktop app, and see whether it plays.
 *
 * Refused while anything is playing: a test that passes moves playback to the
 * desktop app, and one that fails stops it. Uses the song that is paused if
 * there is one, at the point it reached, so a pass leaves it as it was; with
 * nothing paused, `fallback` (a song from the shuffle's lists). A pass is
 * paused straight away.
 */
export async function testDesktopApp(fallback: string | null): Promise<DesktopBugState> {
  const { devices } = (await apiGet<{ devices: Device[] }>('spotify', `${API}/me/player/devices`)) ?? { devices: [] };
  const desktop = devices.find((d) => d.id && !d.is_restricted && (d.type ?? '').toLowerCase() === 'computer' && !isWebPlayer(d));
  if (!desktop?.id) throw new Error("Open Spotify's desktop app first. It doesn't have to be playing.");
  const player = await apiGet<Player>('spotify', `${API}/me/player`).catch(() => null);
  if (player?.is_playing) {
    throw new Error(`Music is playing on ${player.device?.name ?? 'a device'}. Pause it first: the test plays a song on ${desktop.name}.`);
  }
  const uri = player?.item?.uri ?? fallback;
  if (!uri) throw new Error('No song to test with. Sync your playlists on the Services tab first.');
  const position = player?.item?.uri === uri ? (player.progress_ms ?? 0) : 0;

  const id = encodeURIComponent(desktop.id);
  await apiSend('spotify', 'PUT', `${API}/me/player/play?device_id=${id}`, { uris: [uri], position_ms: position });
  let ok = false;
  for (let i = 0; i < 8 && !ok; i++) {
    await new Promise((done) => setTimeout(done, 800));
    const now = await apiGet<Player>('spotify', `${API}/me/player`).catch(() => null);
    ok = Boolean(
      now?.is_playing && now.device?.id === desktop.id && (now.item?.uri === uri || now.item?.linked_from?.uri === uri)
    );
  }
  if (ok) await apiSend('spotify', 'PUT', `${API}/me/player/pause?device_id=${id}`, null).catch(() => undefined);

  return update((s) => {
    s.test = {
      at: Date.now(),
      ok,
      device: desktop.name,
      detail: ok
        ? 'It played the song sent to it, and is paused again.'
        : 'Spotify said OK and nothing played. The bug is still there.',
    };
    if (ok) {
      s.fixedAt = Date.now();
      s.watching = false;
    } else {
      s.refusedAt = Date.now();
      s.fixedAt = null;
    }
  });
}
