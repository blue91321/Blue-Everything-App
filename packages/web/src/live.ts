import { getToken } from './api';

/**
 * Keeps every open copy of the app in step.
 *
 * One shared connection for the whole page, not one per hook — a dozen
 * `useAsync` calls must not open a dozen streams.
 *
 * Deliberately not `EventSource`, which cannot send an Authorization header.
 * The alternative would be putting the bearer token in the query string, where
 * it ends up in browser history and any proxy log. Reading the stream by hand
 * costs about thirty lines and keeps the token in a header.
 */

/**
 * Which part of the app changed.
 *
 * The server has always sent this and the client used to drop it on the floor,
 * so a change to one setting reloaded every list on screen. Passing it through
 * is what lets a reader say "only wake me for the thing I am showing".
 *
 * Deliberately a plain string union rather than an import from
 * `@everything/shared` — see the note in `api.ts` about the bundle. Extra
 * scopes the client does not know about still work, because an unrecognised
 * one is treated as `all`.
 */
export type ChangeScope =
  | 'tasks'
  | 'habits'
  | 'notes'
  | 'nudges'
  | 'settings'
  | 'devices'
  | 'time'
  | 'vault'
  | 'integrations'
  | 'all';

type Listener = (scope: ChangeScope) => void;

const listeners = new Set<Listener>();

/** Collapses a burst of related changes into a single reload. */
const DEBOUNCE_MS = 150;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

let connection: AbortController | null = null;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = RECONNECT_MIN_MS;
let running = false;

/**
 * Scopes seen since the last flush.
 *
 * Debouncing collapses a burst into one notification, so the scopes have to be
 * collected rather than overwritten — a save that touches settings *and* habits
 * within 150ms must wake both readers, not only the later one.
 */
let pending = new Set<ChangeScope>();

function notify(scope: ChangeScope): void {
  pending.add(scope);
  if (notifyTimer) clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    const scopes = pending;
    pending = new Set();
    for (const listener of listeners) {
      for (const each of scopes) listener(each);
    }
  }, DEBOUNCE_MS);
}

async function readStream(signal: AbortSignal): Promise<void> {
  const response = await fetch('/api/events', {
    headers: { ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}) },
    signal,
  });

  if (!response.ok || !response.body) throw new Error(`events stream failed: ${response.status}`);

  // Connected — reset the backoff so the next genuine drop retries quickly.
  retryDelay = RECONNECT_MIN_MS;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) return;

    buffer += decoder.decode(value, { stream: true });

    // Frames are separated by a blank line. Lines starting with ':' are
    // keep-alive comments and carry no payload.
    let split = buffer.indexOf('\n\n');
    while (split !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);

      const data = frame.split('\n').find((line) => line.startsWith('data:'));
      if (data) {
        let scope: ChangeScope = 'all';
        try {
          // A server older than the scope field, or a frame we cannot read,
          // falls back to "everything changed" — the previous behaviour, and
          // the safe direction to be wrong in.
          const parsed = JSON.parse(data.slice('data:'.length)) as { scope?: string };
          if (parsed.scope) scope = parsed.scope as ChangeScope;
        } catch {
          /* keep `all` */
        }
        notify(scope);
      }

      split = buffer.indexOf('\n\n');
    }
  }
}

async function connectLoop(): Promise<void> {
  while (running) {
    connection = new AbortController();
    try {
      await readStream(connection.signal);
    } catch {
      // Server restart, sleep, tunnel blip — all handled the same way.
    }
    if (!running) return;

    await new Promise((resolve) => setTimeout(resolve, retryDelay));
    retryDelay = Math.min(retryDelay * 2, RECONNECT_MAX_MS);
  }
}

function start(): void {
  if (running) return;
  running = true;
  void connectLoop();

  // iOS suspends a backgrounded PWA and kills the stream with it. Coming back
  // to the app must therefore refetch immediately rather than waiting for a
  // reconnect that may be seconds away.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    // Anything could have happened while it was asleep, so everything refetches.
    notify('all');
    retryDelay = RECONNECT_MIN_MS;
    connection?.abort(); // forces the loop to reconnect now
  });
}

/**
 * Call the listener when server data changes. Returns an unsubscribe.
 *
 * `watch` narrows it to the scopes that reader actually shows; omit it to hear
 * everything, which is what the app did before scopes were passed through.
 * `all` always gets through — it is the server saying it does not know what
 * changed, and guessing on its behalf is how a screen goes stale.
 */
export function onDataChange(listener: Listener, watch?: readonly ChangeScope[]): () => void {
  const filtered: Listener = watch
    ? (scope) => {
        if (scope === 'all' || watch.includes(scope)) listener(scope);
      }
    : listener;

  listeners.add(filtered);
  start();
  return () => {
    listeners.delete(filtered);
  };
}
