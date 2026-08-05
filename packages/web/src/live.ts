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

type Listener = () => void;

const listeners = new Set<Listener>();

/** Collapses a burst of related changes into a single reload. */
const DEBOUNCE_MS = 150;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

let connection: AbortController | null = null;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = RECONNECT_MIN_MS;
let running = false;

function notify(): void {
  if (notifyTimer) clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    for (const listener of listeners) listener();
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
      if (frame.split('\n').some((line) => line.startsWith('data:'))) notify();
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
    notify();
    retryDelay = RECONNECT_MIN_MS;
    connection?.abort(); // forces the loop to reconnect now
  });
}

/** Call the listener whenever server data changes. Returns an unsubscribe. */
export function onDataChange(listener: Listener): () => void {
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
  };
}
