/**
 * Reading done without the server, waiting to be told to it.
 *
 * Two kinds: a chapter finished, and a place in a chapter. Each carries the time
 * it happened, which the server uses to keep the newest — so a place from the
 * train, sent the next morning, does not undo the one you left on the PC last
 * night. Only the latest place per series is kept here, since an older one could
 * never win.
 *
 * In `localStorage`, which this app keeps for per-device conveniences — and a
 * queue of things this device did is exactly that. It is sent the next time the
 * Manga screen opens with the server reachable.
 */
import { getToken } from '@app/api';

const KEY = 'manga-sync-queue';

export type QueuedPlace = {
  chapter: number;
  chapterId: string;
  chapterName: string;
  page: number;
  offset: number;
  pages: number;
};

export type Queued =
  | { kind: 'read'; seriesId: string; chapter: number; at: number }
  | { kind: 'position'; seriesId: string; place: QueuedPlace; at: number };

function load(): Queued[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as Queued[]) : [];
  } catch {
    return [];
  }
}

function save(items: Queued[]): void {
  try {
    if (items.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    // Storage refused. The read is still on this device's copy; it will not
    // reach the PC, which is the smaller loss.
  }
}

export function enqueue(item: Queued): void {
  const items = load().filter(
    (q) => !(item.kind === 'position' && q.kind === 'position' && q.seriesId === item.seriesId)
  );
  items.push(item);
  save(items);
}

export function pendingCount(): number {
  return load().length;
}

let flushing: Promise<number> | null = null;

/**
 * Send what is waiting, oldest first. Returns how many were delivered.
 *
 * Stops at the first network failure — still offline, try later — and drops an
 * item the server refuses outright (a series since removed), since sending it
 * again would be refused again forever.
 */
export function flushQueue(): Promise<number> {
  if (flushing) return flushing;
  const run = async (): Promise<number> => {
    let sent = 0;
    let items = load();
    while (items.length > 0) {
      const item = items[0]!;
      const [path, body] =
        item.kind === 'read'
          ? [`/api/manga/${item.seriesId}/read`, { chapter: item.chapter, read: true, at: item.at }]
          : [`/api/manga/${item.seriesId}/position`, { ...item.place, at: item.at }];
      let response: Response;
      try {
        response = await fetch(path, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken()}` },
          body: JSON.stringify(body),
        });
      } catch {
        break;
      }
      if (response.status >= 500) break;
      // Re-read rather than save the list this started with: something read
      // while this was sending was queued meanwhile, and must not be lost.
      const sentOne = JSON.stringify(item);
      items = load().filter((q) => JSON.stringify(q) !== sentOne);
      save(items);
      if (response.ok) sent += 1;
    }
    return sent;
  };
  /*
   * Cleared in `.finally` on the promise, not inside the function: an empty
   * queue finishes before the assignment would happen, and clearing first then
   * assigning would leave a settled promise here that every later flush
   * returned without sending anything.
   */
  flushing = run().finally(() => {
    flushing = null;
  });
  return flushing;
}
