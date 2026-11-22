/**
 * The last few things that went wrong on this device, for a bug report
 * (2026-11-18).
 *
 * A bug is usually seen on the phone, and nothing on the server can say what
 * the phone saw: a request the server answered with an error, a script that
 * threw, a promise nobody caught. Each was shown (or not) and forgotten. This
 * keeps the last `KEEP` of them, for `KEEP_FOR`, so a report written after the
 * fact (after a reload, even) can carry them.
 *
 * Scrubbed as they are recorded (`scrub`), so what is kept is already what a
 * report would show: never a page's address, an id, a host or a token. Per
 * device in `localStorage`, and sent nowhere: only `Feedback.tsx` reads it,
 * and only into text the person sees before sending it themselves.
 */
import { scrub } from './feedback-text';

const KEY = 'everything.recent-errors';
const KEEP = 20;
const KEEP_FOR = 3 * 24 * 60 * 60 * 1000;
const LONGEST = 240;

export interface RecentError {
  at: number;
  text: string;
}

function load(): RecentError[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as RecentError[]).filter((e) => e && typeof e.at === 'number' && typeof e.text === 'string');
  } catch {
    return [];
  }
}

/** Kept in memory too, for a device that refuses storage. */
let inMemory: RecentError[] | null = null;

export function recentErrors(): RecentError[] {
  const since = Date.now() - KEEP_FOR;
  return (inMemory ?? load()).filter((e) => e.at >= since).sort((a, b) => b.at - a.at);
}

export function noteError(text: string): void {
  const clean = scrub(text).replace(/\s+/g, ' ').trim().slice(0, LONGEST);
  if (!clean) return;
  const list = recentErrors();
  // The same failure over and over (a page retried) is one line, brought up to date.
  const same = list.find((e) => e.text === clean);
  const next = [{ at: Date.now(), text: clean }, ...list.filter((e) => e !== same)].slice(0, KEEP);
  inMemory = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Full or refused: the memory copy stands for this visit.
  }
}

export function clearErrors(): void {
  inMemory = [];
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to do.
  }
}

/** Noise every browser makes that says nothing about this app. */
const IGNORED = /ResizeObserver loop|Script error\.?$|AbortError|The user aborted|cancelled/i;

let listening = false;

/** Listen for what nobody caught. Called once, from `main.tsx`. */
export function watchForErrors(): void {
  if (listening) return;
  listening = true;
  window.addEventListener('error', (event) => {
    const message = event.message || (event.error instanceof Error ? event.error.message : '');
    if (!message || IGNORED.test(message)) return;
    const where = event.filename ? ` (${event.filename.replace(/^.*\//, '')}:${event.lineno})` : '';
    noteError(`Crashed: ${message}${where}`);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason as unknown;
    const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '';
    if (!message || IGNORED.test(message)) return;
    noteError(`Unhandled: ${message}`);
  });
}

/**
 * The screen the person was on before opening Feedback, which is the one the
 * report is most likely about. Set by `App` as it draws.
 */
let screen = '';
export function noteScreen(id: string): void {
  if (id && id !== 'feedback') screen = id;
}
export function lastScreen(): string {
  return screen;
}
