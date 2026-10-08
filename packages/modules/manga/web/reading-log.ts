/**
 * Every chapter read on this device, written down here before it is sent.
 *
 * A read used to be one request: finish a chapter, PUT it, and if that request
 * never arrived — a tunnel, a sleeping PC, the phone killing the app the moment
 * it was swiped away — the read was gone, with nothing anywhere to say it had
 * happened. So the order is reversed. The read goes into this log first, which
 * is synchronous and survives the app being closed a millisecond later, and is
 * sent from here: now if the server answers, and whenever it next does if not.
 *
 * **And the last month of it is sent again**, each time the Manga screen opens
 * (at most twice an hour). That is the part that makes it work *regardless*:
 * a read the server once had and then lost — the sweep that used to overwrite
 * the store, a restore from a backup — is put back by the device that did the
 * reading. Sending a claim twice is harmless and an old one cannot overrule a
 * newer one, which is the server's `read-marks.ts`; that rule is what makes
 * repeating everything safe instead of a way to resurrect what you took back.
 *
 * **A CSV, because it is meant to be readable.** One row per claim — when, which
 * series, which chapter, read or unread, whether the PC has it, and the title —
 * so More → Reading log can hand it over as a file a spreadsheet opens. It is
 * stored as that same text in `localStorage`, where the rest of this module's
 * per-device state lives: a browser will not let a web app write a file to
 * disk on its own, and this has to be written in the instant a chapter ends.
 *
 * Incognito writes nothing here, for the reason it sends nothing: the read was
 * deliberately not to be recorded, and a log of it is a record.
 */
import { getToken } from '@app/api';
import { onBackOnline } from '@app/offline-sync';
import { isIncognito } from './incognito';
import { HEADER, fromLine, toLine, type LogRow } from './log-csv';

const KEY = 'manga-reading-log';

/** How far back the log is sent again. The server ignores claims much older. */
const RESEND_MS = 30 * 24 * 60 * 60_000;
/** How often opening Manga re-sends it, at most. */
const RESEND_EVERY_MS = 30 * 60_000;
/** Sent rows older than this are dropped from the log. */
const KEEP_MS = 180 * 24 * 60 * 60_000;
/** And it never grows past this, oldest sent rows going first. */
const MAX_ROWS = 5000;

/*
 * Kept in memory as well, so a browser that refuses storage — a private window,
 * a full disk — still sends what was read in this session. The stored copy
 * wins whenever there is one, since another tab may have added to it.
 */
let memory: LogRow[] = [];

function load(): LogRow[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return memory;
    memory = raw
      .split('\n')
      .slice(1)
      .map(fromLine)
      .filter((r): r is LogRow => r !== null);
  } catch {
    // Storage unreadable: what this session wrote is still here.
  }
  return memory;
}

function save(rows: LogRow[]): void {
  const cutoff = Date.now() - KEEP_MS;
  let kept = rows.filter((r) => !r.sent || r.at >= cutoff);
  if (kept.length > MAX_ROWS) {
    const sentOldest = kept.filter((r) => r.sent).sort((a, b) => a.at - b.at);
    const drop = new Set(sentOldest.slice(0, kept.length - MAX_ROWS));
    kept = kept.filter((r) => !drop.has(r));
  }
  memory = kept;
  try {
    localStorage.setItem(KEY, [HEADER, ...kept.map(toLine)].join('\n'));
  } catch {
    // Refused. Held in memory and sent from there; see `memory`.
  }
}

/**
 * Write down that these chapters were read (or taken back), then send.
 *
 * Several at once for the skip button, which finishes a chapter and the point
 * chapters it passed over in one press.
 */
export function logRead(seriesId: string, chapters: readonly number[], title = '', read = true): Promise<unknown> {
  // The one place the rule is applied, so no screen that opens a reader has
  // to remember it — two of the four did not.
  if (isIncognito()) return Promise.resolve();
  const at = Date.now();
  const rows = load();
  for (const chapter of chapters) rows.push({ at, seriesId, chapter, read, sent: false, title });
  save(rows);
  return syncLog();
}

/** Rows the server has not acknowledged yet. */
export function unsentCount(): number {
  return load().filter((r) => !r.sent).length;
}

export function logSize(): number {
  return load().length;
}

/** The whole log as a CSV file's text, header first, with Windows line ends for Notepad. */
export function logCsv(): string {
  return [HEADER, ...load().map(toLine)].join('\r\n') + '\r\n';
}

type SyncResult = { sent: number; changed: number };
let syncing: Promise<SyncResult> | null = null;
let again: { resend: boolean } | null = null;

/**
 * Send what the server has not acknowledged, and with `resend` the last month
 * again. Stops quietly on a network failure — everything stays marked unsent
 * and goes next time.
 *
 * A call made while one is already in flight is not dropped: the chapter it is
 * about was appended after the running one took its copy, so it runs again
 * once that finishes.
 */
export function syncLog(options: { resend?: boolean } = {}): Promise<SyncResult> {
  if (syncing) {
    again = { resend: (again?.resend ?? false) || options.resend === true };
    return syncing;
  }
  const run = async (): Promise<SyncResult> => {
    const rows = load();
    const since = Date.now() - RESEND_MS;
    const outgoing = rows.filter((r) => !r.sent || (options.resend && r.at >= since));
    if (outgoing.length === 0) return { sent: 0, changed: 0 };

    /*
     * Only the newest claim per chapter needs to go: the server would discard
     * the older ones anyway, and a month of re-reading one series is otherwise
     * a long list saying the same thing.
     */
    const newest = new Map<string, LogRow>();
    for (const r of outgoing) {
      const key = `${r.seriesId}|${r.chapter}`;
      const had = newest.get(key);
      if (!had || r.at >= had.at) newest.set(key, r);
    }
    const entries = [...newest.values()].map((r) => ({ seriesId: r.seriesId, chapter: r.chapter, read: r.read, at: r.at }));

    let response: Response;
    try {
      response = await fetch('/api/manga/journal', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ entries }),
      });
    } catch {
      return { sent: 0, changed: 0 };
    }
    // A server error, or a server too old to know this route: try again later
    // rather than marking anything as delivered.
    if (response.status >= 500 || response.status === 404 || response.status === 401) return { sent: 0, changed: 0 };

    let changed = 0;
    try {
      changed = ((await response.json()) as { changed?: number }).changed ?? 0;
    } catch {
      // Answered without a body worth reading; the rows still arrived.
    }
    /*
     * Marked against the log as it is *now*, not the copy this started with:
     * a chapter finished while this was in flight was appended meanwhile and
     * must stay unsent. Matched by value, since rows have no id of their own.
     */
    const delivered = new Set(outgoing.filter((r) => !r.sent).map(toLine));
    save(load().map((r) => (delivered.has(toLine(r)) ? { ...r, sent: true } : r)));
    return { sent: delivered.size, changed };
  };
  syncing = run().finally(() => {
    syncing = null;
    const next = again;
    again = null;
    if (next) void syncLog(next);
  });
  return syncing;
}

let resentAt = 0;

/**
 * Re-send the last month, at most twice an hour — called when the Manga screen
 * opens. Remembered across reloads, so a phone opening the app ten times in a
 * row sends once.
 */
export function resendRecent(): void {
  const now = Date.now();
  try {
    resentAt = Math.max(resentAt, Number(localStorage.getItem(`${KEY}.resent`)) || 0);
  } catch {
    // In memory only, then.
  }
  if (now - resentAt < RESEND_EVERY_MS) {
    void syncLog();
    return;
  }
  resentAt = now;
  try {
    localStorage.setItem(`${KEY}.resent`, String(now));
  } catch {
    // As above.
  }
  void syncLog({ resend: true });
}

onBackOnline(() => {
  void syncLog();
});
