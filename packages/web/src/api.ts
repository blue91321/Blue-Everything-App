/**
 * Talking to the server.
 *
 * Row types are declared here rather than imported from @everything/shared
 * because the API returns database rows — integer booleans, nullable columns —
 * while the shared package describes the *input* schemas. They're related but
 * not the same shape, and pretending otherwise causes quiet type lies.
 *
 * All paths are relative, so the same build works on localhost and over
 * Tailscale with no configuration.
 */

import {
  configureOffline,
  connectivity,
  hasPending,
  keepable,
  keptBlob,
  markOffline,
  markOnline,
  noteShown,
  queueable,
  queueChange,
  recall,
  remember,
  resolveIds,
  flushOutbox,
} from './offline-sync';
import './offline-effects';
import { onServersMachine, thePc, ThePc } from './device';
// The row shapes live in api-types.ts; re-exported so importers need not know.
export type * from './api-types';
import type {
  AppSettings,
  ConnectInfo,
  Device,
  FeatureState,
  Game,
  Habit,
  HabitMode,
  InstalledPackage,
  ModuleState,
  Note,
  NoteDetail,
  NoteFile,
  NoteFolder,
  NoteGraph,
  NoteImportResult,
  Nudge,
  Onboarding,
  Person,
  PersonInvite,
  Session,
  Task,
  TaskInput,
  TimeEntry,
  UpdateCheck,
} from './api-types';

const TOKEN_KEY = 'everything.token';

export const getToken = (): string => localStorage.getItem(TOKEN_KEY) ?? '';
export const setToken = (token: string): void => localStorage.setItem(TOKEN_KEY, token.trim());
export const clearToken = (): void => localStorage.removeItem(TOKEN_KEY);

/**
 * A sign-in link to a person's copy: `…/#invite=<code>`. The code is swapped
 * for this device's own token, once, and the link is taken out of the address
 * bar so it is not left in history to be tried again. Done before the session
 * is asked for, so the first thing the copy sees is a signed-in device.
 *
 * Returns what went wrong, for the pairing screen to say, or null.
 */
export async function redeemInviteInUrl(): Promise<string | null> {
  const match = /(?:^#|&)invite=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (!match) return null;
  history.replaceState(null, '', location.pathname + location.search);
  const phone = /iPhone|iPad|Android/i.test(navigator.userAgent);
  try {
    const response = await fetch('/api/invite/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: match[1],
        kind: phone ? 'phone' : 'browser',
        name: phone ? 'Phone (signed in by link)' : 'Browser (signed in by link)',
      }),
    });
    const body = (await response.json().catch(() => null)) as { token?: string; error?: string } | null;
    if (!response.ok || !body?.token) return body?.error ?? `that sign-in link did not work (${response.status})`;
    setToken(body.token);
    return null;
  } catch {
    return 'could not reach the server to sign in with that link';
  }
}

/** Thrown on 401 so the UI can drop back to the pairing screen. */
export class Unauthorized extends Error {}

/**
 * Thrown when the request never reached a server.
 *
 * Distinct from `Unauthorized`, and the distinction is the point: a `fetch`
 * that rejects and a 401 both ended with no session, so both used to blank the
 * app back to the pairing screen — and "Blue Everything is not running" was
 * therefore reported as "this device is not paired", which sends you off to
 * find a token you already have.
 *
 * The shell survives the server dying because the service worker caches it, so
 * this state is genuinely reachable and worth telling apart.
 */
export class ServerUnreachable extends Error {}

configureOffline({ token: () => getToken() });

/**
 * A habit's picture, as something an `<img>` can point at.
 *
 * **It cannot be a plain URL.** The picture lives under `/api/`, deliberately —
 * it is personal in the way the rest of the database is, unlike the icons and
 * the notification tones, which sit outside that prefix because the browser's
 * own machinery fetches them and will never send a bearer token. An `<img src>`
 * will not either, so the bytes are fetched with the token and wrapped in an
 * object URL.
 *
 * Cached by `id:updatedAt`, which the upload route bumps — so a replaced picture
 * appears immediately and an unchanged one is fetched once per page load rather
 * than once per render of every list it appears in. Nothing is revoked: there is
 * one entry per habit per version, a handful at most, and revoking on unmount
 * would break the next row that wanted the same picture.
 */
const habitImages = new Map<string, Promise<string>>();

export function habitImageUrl(id: string, version: number): Promise<string> {
  const key = `${id}:${version}`;
  const known = habitImages.get(key);
  if (known) return known;

  // Kept on the device like the reads, so a gauge still has its picture offline.
  const loading = keptBlob(`/api/habits/${id}/image`, getToken()).then((blob) => URL.createObjectURL(blob));

  habitImages.set(key, loading);
  // A failed load must not be remembered, or a picture uploaded a moment later
  // would never be fetched again.
  void loading.catch(() => habitImages.delete(key));
  return loading;
}

/**
 * GETs for the same URL that are already in flight, so they become one.
 *
 * A single change announcement reaches every `useAsync` on screen at once, and
 * the Settings screen alone holds three separate readers of `/api/settings`
 * plus the one in `App` — so one click on a toggle produced **six identical
 * requests**, measured. They are all asking the same question at the same
 * instant and they cannot get different answers.
 *
 * Only GETs, and only while genuinely concurrent: the entry is dropped the
 * moment the response settles, so this is a coalescer and not a cache. A stale
 * read is the one thing this app cannot afford here — the whole point of the
 * live stream is that two devices never disagree.
 */
const inFlight = new Map<string, Promise<unknown>>();

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? 'GET';

  if (method === 'GET') {
    const shared = inFlight.get(path);
    if (shared) return shared as Promise<T>;

    const started = send<T>(path, init, method);
    inFlight.set(path, started);
    // `finally` on the promise rather than await/try, so the entry is cleared
    // for a rejection too — a failed fetch must not wedge the path forever.
    void started.finally(() => inFlight.delete(path));
    return started;
  }

  return send<T>(path, init, method);
}

/**
 * How long a read waits before the saved copy is shown instead — only for reads
 * that *have* a saved copy to fall back on. The phone reaches the PC over
 * Tailscale, and with the PC asleep a request does not fail, it hangs; waiting a
 * minute to show what is already on the device helps nobody. The session is
 * asked for first and shortest, since the whole app waits on it.
 */
const KEPT_READ_TIMEOUT_MS = 15_000;
const SESSION_TIMEOUT_MS = 6_000;
const CHANGE_TIMEOUT_MS = 15_000;

/**
 * Is the server there at all? `/health` needs no token and touches nothing, so
 * it answers in milliseconds from a server that is merely busy with something
 * else, and not at all from one that is stopped or asleep.
 */
async function serverAnswers(): Promise<boolean> {
  try {
    const response = await fetch('/health', { signal: AbortSignal.timeout(4_000), cache: 'no-store' });
    return response.ok && (response.headers.get('content-type') ?? '').includes('application/json');
  } catch {
    return false;
  }
}

async function send<T>(rawPath: string, init: RequestInit, method: string): Promise<T> {
  // Something created offline and since synced has a real id now; a screen may
  // still hold the temporary one.
  const path = resolveIds(rawPath);
  const rawBody = init.body ?? (method === 'GET' ? undefined : '{}');
  const body = typeof rawBody === 'string' ? resolveIds(rawBody) : rawBody;
  const isRead = method === 'GET';
  const kept = isRead && keepable(path);

  // Known to be offline: what this device saw, at once, rather than a wait on
  // a connection that is not there. Coming back is noticed by the live stream
  // and by a quiet probe, and everything refetches then.
  if (kept && connectivity().offline) {
    const saved = await recall(path);
    if (saved) {
      noteShown(saved.savedAt);
      return saved.data as T;
    }
  }

  // Changes take their turn behind anything already queued, or a note created
  // offline could be edited on the server before it exists there.
  if (!isRead && (connectivity().offline || hasPending()) && queueable(method, path)) {
    const answer = await queueChange(method, path, typeof body === 'string' ? body : undefined);
    if (!connectivity().offline) void flushOutbox();
    return answer as T;
  }

  // The cause is not shown — see the message below — but is kept for a debugger.
  const unreachable = async (_cause: string): Promise<T> => {
    markOffline();
    if (kept) {
      const saved = await recall(path);
      if (saved) {
        noteShown(saved.savedAt);
        return saved.data as T;
      }
    }
    if (!isRead && queueable(method, path)) {
      return (await queueChange(method, path, typeof body === 'string' ? body : undefined)) as T;
    }
    // Said as what to do rather than what failed: "Failed to fetch" on a
    // screen that simply is not kept offline explains nothing. On the PC
    // itself, offline means the app has stopped, and "needs the PC" would be
    // said to the PC.
    const needs = onServersMachine() ? 'Needs the app running' : `Needs ${thePc()}`;
    throw new ServerUnreachable(
      isRead ? `${needs} — this isn't kept for offline use` : `${needs} — this can't be done offline`
    );
  };

  /*
   * Timed out, but the server answers a ping: it is there and this one request
   * is slow. That was being called "offline" — the banner, the outbox — on a
   * PC that was busy starting the music. So nothing is marked offline and
   * nothing is queued: a change that timed out may well have happened, and
   * replaying it later would do it twice. A read with a saved copy shows that.
   */
  const slow = async (): Promise<T> => {
    if (kept) {
      const saved = await recall(path);
      if (saved) return saved.data as T;
    }
    // The whole app waits on the session, and an ordinary error there would
    // mean the pairing screen: better the offline screen, which retries.
    if (path === '/api/session') return unreachable('the server is slow to answer');
    throw new Error(
      isRead
        ? `${ThePc()} is taking too long to answer. It is running; try again in a moment.`
        : `${ThePc()} is taking too long to answer, so this may or may not have happened. It is running; check, then try again.`
    );
  };

  const timeout = path === '/api/session' ? SESSION_TIMEOUT_MS : kept ? KEPT_READ_TIMEOUT_MS : !isRead ? CHANGE_TIMEOUT_MS : null;

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      body,
      ...(timeout !== null && !init.signal ? { signal: AbortSignal.timeout(timeout) } : {}),
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        authorization: `Bearer ${getToken()}`,
        ...init.headers,
      },
    });
  } catch (cause) {
    // `fetch` rejects only when the request never got a reply — the process is
    // down, the machine is asleep, the network is gone. Anything the server
    // answered, however badly, comes back as a response.
    if (cause instanceof DOMException && cause.name === 'TimeoutError' && (await serverAnswers())) {
      return slow();
    }
    return unreachable(cause instanceof Error ? cause.message : 'could not reach the server');
  }

  /*
   * A gateway error that is not this app's own JSON is `tailscale serve`
   * answering for a PC whose app is not running — unreachable, not an error to
   * show. This server's own 502s (a manga source failing) carry JSON and are
   * left alone.
   */
  if (
    (response.status === 502 || response.status === 503 || response.status === 504) &&
    !(response.headers.get('content-type') ?? '').includes('application/json')
  ) {
    return unreachable(`the server did not answer (${response.status})`);
  }

  markOnline();
  if (response.status === 401) throw new Unauthorized('this device is not paired');
  if (!response.ok) throw new Error(await errorMessage(response, method, path));
  if (response.status === 204) return undefined as T;
  const data = (await response.json()) as T;
  if (kept) void remember(path, data);
  return data;
}

/**
 * The same request everything in core makes, for packages with their own
 * clients — so their screens are kept for offline use, and refused or queued
 * the same way, without each writing its own copy of the rules.
 */
export function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  return request<T>(path, init);
}

/**
 * The server's own words, when it sent any.
 *
 * Every route in this app answers a failure with `{ error }`, and this used to
 * throw that away and show `POST /api/… failed (500)` instead. The effect was
 * invisible for a long time because most failures here are "the server is not
 * running", where a status code is as much as anyone can say — but the moment a
 * route had something useful to report, the screen could not show it. Steam
 * answering "that API key was rejected, keys are revoked when you change your
 * password" arrived as a 500 and a path.
 *
 * The status is kept as a fallback rather than dropped: a proxy error page or a
 * crash before the handler produces no JSON at all, and "failed (502)" is still
 * better than an empty string.
 */
async function errorMessage(response: Response, method: string, path: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error.trim() !== '') return body.error;
  } catch {
    // Not JSON, or no body. Fall through to the status.
  }
  return `${method} ${path} failed (${response.status})`;
}

const post = <T>(path: string, payload?: unknown) =>
  request<T>(path, { method: 'POST', body: payload === undefined ? undefined : JSON.stringify(payload) });
const patch = <T>(path: string, payload: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(payload) });
/** Alias, because `patch` is a parameter name inside `api.games.update`. */
const patch2 = patch;

export const api = {
  health: () => request<{ ok: boolean }>('/health'),
  /**
   * Is the server answering *right now*?
   *
   * Deliberately not `api.health()`: that goes through the coalescer, which
   * would hand every poll the same in-flight promise, and it carries the bearer
   * token for no reason. This is a bare liveness ping used while waiting for a
   * server that is starting up.
   */
  isUp: async (): Promise<boolean> => {
    try {
      const response = await fetch(`/health?t=${Date.now()}`, { cache: 'no-store' });
      return response.ok;
    } catch {
      return false;
    }
  },
  session: () => request<Session>('/api/session'),

  devices: {
    list: () => request<Device[]>('/api/devices'),
    create: (payload: { name: string; kind: 'phone' | 'browser' | 'windows-agent' | 'extension' }) =>
      post<Device & { token: string }>('/api/devices', payload),
    revoke: (id: string) => post(`/api/devices/${id}/revoke`),
    /** A short code to sign one more device in to this copy, from a device already signed in. */
    handoff: () => post<{ code: string; expiresAt: number }>('/api/devices/handoff'),
    /** Only works on an already-revoked device — the server enforces that. */
    remove: (id: string) => request<void>(`/api/devices/${id}`, { method: 'DELETE' }),
  },

  /** What closing the app's window does: see `closing.ts` on the server. */
  closing: {
    get: (side: 'host' | 'desktop') =>
      request<{ mode: 'keep' | 'quit'; noticeShown: boolean; side: string; keeps: string[] }>(`/api/closing?side=${side}`),
    set: (mode: 'keep' | 'quit') =>
      request<{ mode: 'keep' | 'quit' }>('/api/closing', { method: 'PUT', body: JSON.stringify({ mode }) }),
  },

  /** Blue Everything Desktop, from this server: see `routes/desktop-app.ts`. */
  desktopApp: {
    get: () => request<{ version: string; ready: boolean; bytes: number | null; releases: string }>('/api/desktop-app'),
    // The first time, the server may be fetching 60MB from GitHub before it answers.
    ticket: () =>
      request<{ url: string; bytes: number | null }>('/api/desktop-app/ticket', { method: 'POST', signal: AbortSignal.timeout(10 * 60_000) }),
  },

  /** What this person is called, to friends on this PC. Null takes it off. */
  profile: {
    setName: (name: string | null) =>
      request<{ name: string | null }>('/api/profile/name', { method: 'PUT', body: JSON.stringify({ name }) }),
  },

  /** Onboarding: finish it, start it again, or choose which screens show. */
  onboarding: {
    set: (patch: { done?: boolean; shown?: string[] | null; preset?: Onboarding['preset']; known?: string[] }) =>
      request<Onboarding>('/api/onboarding', { method: 'PUT', body: JSON.stringify(patch) }),
  },

  /**
   * People: a copy of the server each, on the host's PC (Settings → People).
   * Making and starting one waits for a server to boot, so those get longer
   * than the 15s an ordinary change does.
   */
  people: {
    list: () => request<{ people: Person[] }>('/api/people'),
    create: (name: string) =>
      request<PersonInvite>('/api/people', { method: 'POST', body: JSON.stringify({ name }), signal: AbortSignal.timeout(90_000) }),
    start: (name: string) =>
      request<Person>(`/api/people/${encodeURIComponent(name)}/start`, { method: 'POST', signal: AbortSignal.timeout(60_000) }),
    stop: (name: string) => post<Person>(`/api/people/${encodeURIComponent(name)}/stop`),
    invite: (name: string) => post<PersonInvite>(`/api/people/${encodeURIComponent(name)}/invite`),
    /** Moves their folder aside rather than deleting it; `confirm` is the name typed again. */
    remove: (name: string) =>
      request<{ ok: true }>(`/api/people/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirm: name }),
        signal: AbortSignal.timeout(30_000),
      }),
  },

  tasks: {
    list: (status = 'todo,doing') => request<Task[]>(`/api/tasks?status=${encodeURIComponent(status)}`),
    create: (payload: TaskInput & { title: string }) => post<Task>('/api/tasks', payload),
    // Not Partial<Task>: the row stores dueIsAllDay as 0/1, but the API takes a
    // boolean, and letting the row type through here sends the wrong one.
    update: (id: string, payload: TaskInput) => patch<Task>(`/api/tasks/${id}`, payload),
    remove: (id: string) => request<void>(`/api/tasks/${id}`, { method: 'DELETE' }),
  },

  habits: {
    list: () => request<Habit[]>('/api/habits'),
    create: (payload: {
      name: string;
      mode?: HabitMode;
      cadence?: 'daily' | 'weekly';
      targetPerPeriod?: number;
    }) => post<Habit>('/api/habits', payload),
    update: (
      id: string,
      payload: {
        name?: string;
        mode?: HabitMode;
        cadence?: 'daily' | 'weekly';
        targetPerPeriod?: number;
        intervalMinutes?: number | null;
        gaugeDrainPerDay?: number;
        gaugeFillPercent?: number;
        gaugeRemindAt?: number;
        gaugeShape?: string;
        active?: boolean;
        reminderEveryMinutes?: number | null;
        reminderStartMinute?: number | null;
        pushToPhone?: boolean | null;
        voicePhrases?: string[];
      }
    ) => patch<Habit>(`/api/habits/${id}`, payload),
    remove: (id: string) => request<void>(`/api/habits/${id}`, { method: 'DELETE' }),
    reorder: (ids: string[]) => post('/api/habits/reorder', { ids }),
    check: (id: string) => post(`/api/habits/${id}/check`),
    uncheck: (id: string) => post(`/api/habits/${id}/uncheck`),
    /**
     * Put the tally at a value, rather than nudging it by one.
     *
     * A `PUT`, so sending it twice leaves the same state — which is what makes
     * it safe to fire on both Enter and the blur that Enter causes.
     */
    setValue: (id: string, value: number) =>
      request<{ habitId: string; doneThisPeriod: number; gaugeNow: number | null }>(
        `/api/habits/${id}/value`,
        { method: 'PUT', body: JSON.stringify({ value }) }
      ),
    /**
     * A picture of your own for the gauge.
     *
     * Base64 in JSON rather than multipart, like the logo and the avatar — the
     * server registers no multipart parser, and one endpoint used twice a year
     * does not justify a dependency.
     */
    uploadImage: (id: string, file: File) =>
      new Promise<{ ok: boolean; bytes: number; updatedAt: number }>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('could not read that file'));
        reader.onload = () => {
          const result = String(reader.result);
          // Strip the `data:image/png;base64,` prefix the reader adds.
          const data = result.slice(result.indexOf(',') + 1);
          request<{ ok: boolean; bytes: number; updatedAt: number }>(`/api/habits/${id}/image`, {
            method: 'PUT',
            body: JSON.stringify({ data, type: file.type }),
          }).then(resolve, reject);
        };
        reader.readAsDataURL(file);
      }),
    removeImage: (id: string) => request<void>(`/api/habits/${id}/image`, { method: 'DELETE' }),
  },

  connectInfo: () => request<ConnectInfo>('/api/connect-info'),

  /** What the newest release is, and installing it — see `routes/update.ts`. */
  /** The app's own logs, by name — see `routes/update.ts`. */
  logs: {
    tail: (name: string) => request<{ lines: string[] }>(`/api/logs/${encodeURIComponent(name)}`),
    /** In Notepad, on the PC. */
    open: (name: string) => request<{ ok: boolean }>(`/api/logs/${encodeURIComponent(name)}/open`, { method: 'POST' }),
  },

  updates: {
    check: () => request<UpdateCheck>('/api/updates/check'),
    /** Local-only. Answers at once; the app stops, updates and starts itself. */
    apply: () => request<{ ok: boolean; updating: boolean; log: string }>('/api/updates/apply', { method: 'POST' }),
  },

  features: {
    get: () => request<FeatureState>('/api/features'),
    /** Local-only, and it takes a restart — the response says whether one is owed. */
    set: (id: string, enabled: boolean) =>
      patch<{ ok: boolean; id: string; wanted: boolean; pendingRestart: boolean }>('/api/features', {
        id,
        enabled,
      }),
  },

  /**
   * Restarting from inside the app.
   *
   * Its own top-level entry rather than living under `modules`, because it is
   * not about packages — it is the way out of anything that needs a boot, and
   * the one control that has to keep working when a package has broken
   * something else.
   */
  games: {
    list: () => request<Game[]>('/api/games'),
    update: (
      exe: string,
      patch: {
        label?: string;
        isGame?: boolean;
        allowInterruptions?: boolean | null;
        launchPath?: string | null;
        /** `''` clears it and falls back to the path. */
        launchUrl?: string | null;
      }
    ) =>
      patch2<Game>(`/api/games/${encodeURIComponent(exe)}`, patch),
    add: (exe: string, extra: { label?: string; launchPath?: string } = {}) => post<Game>('/api/games', { exe, ...extra }),
    forget: (exe: string) => request<{ ok: boolean }>(`/api/games/${encodeURIComponent(exe)}`, { method: 'DELETE' }),
    /** Local-only: the path comes from the row, never from the caller. */
    launch: (exe: string) => post<{ ok: boolean; launched: string }>(`/api/games/${encodeURIComponent(exe)}/launch`),
    showFolder: (exe: string) => post<{ ok: boolean; folder: string }>(`/api/games/${encodeURIComponent(exe)}/folder`),
  },

  restart: {
    status: () => request<{ available: boolean; local: boolean; script: string | null }>('/api/restart'),
    now: () => post<{ ok: boolean; restarting: boolean }>('/api/restart'),
  },

  /**
   * The Desktop and Start Menu shortcuts, made from inside the app.
   *
   * `create` waits and reports, unlike `restart.now` — nothing is being stopped
   * here, and the paths it comes back with are the answer to "where did it
   * go", which a redirected Desktop makes a real question.
   */
  desktopIcon: {
    status: () => request<{ available: boolean; local: boolean; script: string | null }>('/api/desktop-icon'),
    create: () => post<{ ok: boolean; created: string[] }>('/api/desktop-icon'),
  },

  /**
   * Starting the Windows agent, without restarting the server it is talking to.
   *
   * Separate from `restart` because the two answer different questions: the
   * server being fine is not in doubt when this is what you need.
   */
  agent: {
    canStart: () => request<{ available: boolean; local: boolean; script: string | null }>('/api/agent/start'),
    start: () => post<{ ok: boolean; starting: boolean }>('/api/agent/start'),
  },

  modules: {
    get: () => request<ModuleState>('/api/modules'),
    /**
     * Send a `.zip` to be unpacked into `modules/`.
     *
     * Base64 in JSON rather than multipart, like the habit picture and the
     * logo — the server registers no multipart parser, and adding one for a
     * screen visited twice a year is a dependency for nothing.
     */
    install: (file: File) =>
      new Promise<InstalledPackage>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('could not read that file'));
        reader.onload = () => {
          const result = String(reader.result);
          // Strip the `data:application/zip;base64,` prefix the reader adds.
          const data = result.slice(result.indexOf(',') + 1);
          post<InstalledPackage>('/api/modules', { data, filename: file.name }).then(resolve, reject);
        };
        reader.readAsDataURL(file);
      }),
    set: (id: string, enabled: boolean) =>
      patch2<{ ok: boolean; id: string; enabled: boolean; pendingRestart: boolean }>(
        `/api/modules/${encodeURIComponent(id)}`,
        { enabled }
      ),
    remove: (id: string) =>
      request<{ ok: boolean; id: string }>(`/api/modules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    /** Local-only: a file manager can only open on the machine it runs on. */
    openFolder: () => post<{ ok: boolean; folder: string }>('/api/modules/folder'),
    /**
     * A package's browser half, as source text.
     *
     * Its own fetch rather than `request`, which parses JSON — this is
     * JavaScript, and it is deliberately fetched *with the token* so the route
     * can stay behind auth. `packages.tsx` turns it into a blob and imports it;
     * see the note there on why a URL import would not do.
     */
    web: async (id: string): Promise<string> => {
      let response: Response;
      try {
        response = await fetch(`/api/modules/${encodeURIComponent(id)}/web`, {
          headers: { authorization: `Bearer ${getToken()}` },
        });
      } catch (cause) {
        throw new ServerUnreachable(cause instanceof Error ? cause.message : 'could not reach the server');
      }
      if (response.status === 401) throw new Unauthorized('this device is not paired');
      if (!response.ok) throw new Error(await errorMessage(response, 'GET', `/api/modules/${id}/web`));
      return response.text();
    },
  },

  settings: {
    get: () => request<AppSettings>('/api/settings'),
    update: (payload: {
      theme?: 'dark' | 'light' | 'system';
      accentColor?: string;
      logoShape?: 'pause' | 'circle' | 'triangle' | 'square' | 'image';
      quietHoursEnabled?: boolean;
      quietStartMinute?: number;
      quietEndMinute?: number;
      followWindowsDnd?: boolean;
      dndUntil?: number | null;
      remindersEnabled?: boolean;
      soundEnabled?: boolean;
      soundWake?: string;
      soundOk?: string;
      soundMiss?: string;
      soundNudge?: string;
      pushEnabled?: boolean;
      pushDefault?: boolean;
      voiceEnabled?: boolean;
      wakeWord?: string;
      wakeDecoys?: string;
      requireKnownSpeaker?: boolean;
      speakerThreshold?: number;
      voiceInputDevice?: string | null;
      voiceFollowUpSeconds?: number;
      voiceRetryMatchesFollowUp?: boolean;
      /** '' clears it. */
      voiceToggleHotkey?: string | null;
      voiceListenHotkey?: string | null;
      voiceListenHotkeyWhileOff?: boolean;
      dashboardRefreshSeconds?: number;
      drawerBreakpoint?: number;
      // Sent as a boolean, stored as 0/1 — the write side speaks JSON, the read
      // side speaks SQLite, and they are deliberately different types.
      drawerDocked?: boolean;
      gameDetectionEnabled?: boolean;
      interruptDuringGames?: boolean;
      voiceRetrySeconds?: number;
      overlayPlacement?: string;
      overlayScreen?: string | null;
      overlayAvatar?: string;
      hiddenProviders?: string[];
      /** Opaque panel id, or '' for one column. Kept in step with the list. */
      dashboardPanel?: string;
      /** The side column's panels, in order. Deduplicated by the server. */
      dashboardPanels?: string[];
      /** The main column's blocks, in order. Deduplicated by the server. */
      dashboardBlocks?: string[];
      /** What the live panel narrows to. The Live tab always shows everything. */
      livePanelScope?: 'all' | 'favourites';
    }) => patch<AppSettings>('/api/settings', payload),
  },

  /** Your wording for the app's, from edit mode: see `ui-text.tsx` and the server's `ui-text.ts`. */
  uiText: {
    /** `hidden` is absent from an older server. */
    get: () => request<{ text: Record<string, string>; hidden?: string[] }>('/api/ui-text'),
    /** `text: null` goes back to the app's own wording; a key left out is left alone. */
    set: (id: string, change: { text?: string | null; hidden?: boolean }) =>
      request<{ id: string; text: string | null; hidden?: boolean }>('/api/ui-text', {
        method: 'PUT',
        body: JSON.stringify({ id, ...change }),
      }),
  },

  logo: {
    /**
     * Upload a picture to use as the mark.
     *
     * Sent as base64 in JSON rather than multipart, matching the voice avatar:
     * the server has no multipart parser registered and adding one for a single
     * endpoint used once in a blue moon is a dependency for nothing.
     */
    upload: (file: File) =>
      new Promise<{ ok: boolean; bytes: number }>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('could not read that file'));
        reader.onload = () => {
          const result = String(reader.result);
          // Strip the `data:image/png;base64,` prefix the reader adds.
          const data = result.slice(result.indexOf(',') + 1);
          request<{ ok: boolean; bytes: number }>('/api/logo', {
            method: 'PUT',
            body: JSON.stringify({ data, type: file.type }),
          }).then(resolve, reject);
        };
        reader.readAsDataURL(file);
      }),

    remove: () => request<{ ok: boolean }>('/api/logo', { method: 'DELETE' }),
  },

  push: {
    subscribe: (subscription: unknown) => post('/api/devices/me/push', subscription),
  },

  notes: {
    list: (query: { folder?: string; tag?: string; q?: string } = {}) => {
      const search = new URLSearchParams();
      // Only what was asked for: an empty `folder=` means the root, which is a
      // different question from "every folder".
      if (query.folder !== undefined) search.set('folder', query.folder);
      if (query.tag) search.set('tag', query.tag);
      if (query.q) search.set('q', query.q);
      const qs = search.toString();
      return request<Note[]>(`/api/notes${qs ? `?${qs}` : ''}`);
    },
    get: (id: string) => request<NoteDetail>(`/api/notes/${id}`),
    create: (payload: { title?: string | null; body?: string; folder?: string | null }) =>
      post<Note>('/api/notes', payload),
    update: (
      id: string,
      payload: { title?: string | null; body?: string; folder?: string | null; pinned?: boolean }
    ) => patch<Note>(`/api/notes/${id}`, payload),
    remove: (id: string) => request<void>(`/api/notes/${id}`, { method: 'DELETE' }),

    tree: () => request<{ folders: NoteFolder[] }>('/api/notes/tree'),
    tags: () => request<{ tags: { tag: string; count: number }[] }>('/api/notes/tags'),
    graph: () => request<NoteGraph>('/api/notes/graph'),
    renameFolder: (from: string, to: string) =>
      post<{ moved: number; folder: string }>('/api/notes/folder/rename', { from, to }),
    /** Make one that has nothing in it yet. Making an existing one is a no-op. */
    createFolder: (path: string) => post<{ folder: string }>('/api/notes/folder', { path }),
    /**
     * Refused with a 409 while it holds notes, unless `withNotes` says to take
     * them too — which cannot be undone, so it is never the default.
     */
    removeFolder: (path: string, withNotes = false) =>
      request<{ folder: string; notesDeleted: number }>(
        `/api/notes/folder?path=${encodeURIComponent(path)}${withNotes ? '&notes=delete' : ''}`,
        { method: 'DELETE' }
      ),
    reindex: () => post<{ reindexed: number }>('/api/notes/reindex', {}),

    formats: () =>
      request<{
        import: { id: string; label: string; hint: string }[];
        export: { id: string; label: string; hint: string }[];
      }>('/api/notes/formats'),

    /** Preview writes nothing; `commit` is the second call with the same bytes. */
    import: (payload: { name: string; data: string; commit?: boolean; folder?: string }) =>
      post<NoteImportResult>('/api/notes/import', payload),

    /**
     * Downloads through a blob rather than a link, because `/api/` needs a
     * bearer token and an `<a download>` sends none — the same reason the habit
     * pictures are fetched rather than used as an `<img src>`.
     */
    export: async (payload: { format: string; ids?: string[]; folder?: string }) => {
      const response = await fetch('/api/notes/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken()}` },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const problem = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(problem.error ?? `export failed (${response.status})`);
      }
      const disposition = response.headers.get('content-disposition') ?? '';
      return {
        fileName: /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'notes',
        blob: await response.blob(),
      };
    },

    /**
     * An attachment's bytes, for wrapping in an object URL.
     *
     * `<img src="/api/…">` sends no bearer token, so the picture has to be
     * fetched like any other API call — the same move the habit pictures make.
     */
    // Kept like the reads, so a note's pictures open on the train with the note.
    fetchFile: (path: string): Promise<Blob> => keptBlob(path, getToken()),

    uploadFile: (payload: { name: string; data: string; noteId?: string | null }) =>
      post<NoteFile & { markdown: string }>('/api/notes/files', payload),
    removeFile: (id: string) => request<void>(`/api/notes/files/${id}`, { method: 'DELETE' }),
  },

  nudges: {
    queue: () => request<Nudge[]>('/api/nudges/queue'),
    create: (payload: { title: string; body?: string; minQuality?: string; deadlineAt?: number | null }) =>
      post<Nudge>('/api/nudges', payload),
    snooze: (id: string, minutes: number) => post(`/api/nudges/${id}/snooze`, { minutes }),
    dismiss: (id: string) => post(`/api/nudges/${id}/dismiss`),
  },

  time: {
    current: () => request<TimeEntry | null>('/api/time/current'),
    start: (payload: { taskId?: string | null; label?: string | null }) => post<TimeEntry>('/api/time/start', payload),
    stop: () => post<{ stopped: number }>('/api/time/stop'),
  },
};
