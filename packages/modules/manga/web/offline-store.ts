/**
 * Chapters saved on this device, to read without the server.
 *
 * ### Where they live
 *
 * In the browser's Cache Storage, under this package's own cache, keyed by the
 * very URLs the reader asks for. That is the whole trick: the reader is not
 * taught about downloads at all — `manga.reader.page` looks here before the
 * network, so a saved chapter reads the same online, offline, and faster.
 *
 * A small manifest sits in the same cache, saying what is saved — and a copy of
 * your read marks and place for each series, so the offline screen can light up
 * the right rows with no server to ask. Keeping it beside the pages means the
 * two live and die together: if iOS clears one to free space, it clears both,
 * and there is never a list of chapters whose pages are gone.
 *
 * ### What it cannot do
 *
 * Download in the background. A web app gets no time once you leave it, so a
 * download runs while the app is open, and one interrupted part-way is not
 * recorded as saved — its pages are kept, and asking again fetches only the
 * ones missing.
 *
 * Cache Storage exists only on a secure page (https, or localhost), which the
 * phone is, over `tailscale serve`. Anywhere else it says so rather than failing.
 */
import { useEffect, useState } from 'react';
import { getToken } from '@app/api';

const CACHE = 'everything-manga-offline-v1';
const MANIFEST = '/offline/manga/manifest.json';

/** Pages fetched at once per chapter — the reader's own number, for the same server. */
const IN_FLIGHT = 3;

export type SavedChapter = {
  chapterId: string;
  number: number;
  name: string;
  pages: string[];
  bytes: number;
  at: number;
};

export type SavedPlace = {
  chapter: number;
  chapterId: string;
  chapterName: string;
  page: number;
  offset: number;
  pages: number;
  at: number;
};

export type SavedSeries = {
  seriesId: string;
  title: string;
  sourceName: string;
  coverPath: string | null;
  /** As of the last time this device saw them, plus anything read here since. */
  readChapters: number[];
  position: SavedPlace | null;
  chapters: Record<string, SavedChapter>;
};

export type Manifest = { version: 1; series: Record<string, SavedSeries> };

export type Job = {
  key: string;
  seriesId: string;
  seriesTitle: string;
  chapterId: string;
  name: string;
  done: number;
  total: number | null;
  problem: string | null;
  /** Asked to stop; the pages it had already saved are removed again. */
  cancelled?: boolean;
};

export const offlineSupported = typeof window !== 'undefined' && 'caches' in window;

/* ---- the manifest, and who is listening to it ---- */

let manifest: Manifest | null = null;
let loading: Promise<Manifest> | null = null;
const jobs = new Map<string, Job>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function loadManifest(): Promise<Manifest> {
  if (manifest) return Promise.resolve(manifest);
  if (!offlineSupported) return Promise.resolve({ version: 1, series: {} });
  loading ??= (async () => {
    try {
      const hit = await (await caches.open(CACHE)).match(MANIFEST);
      const parsed = hit ? ((await hit.json()) as Manifest) : null;
      manifest = parsed?.version === 1 && parsed.series ? parsed : { version: 1, series: {} };
    } catch {
      manifest = { version: 1, series: {} };
    }
    return manifest;
  })();
  return loading;
}

async function saveManifest(next: Manifest): Promise<void> {
  manifest = next;
  notify();
  try {
    await (await caches.open(CACHE)).put(
      MANIFEST,
      new Response(JSON.stringify(next), { headers: { 'content-type': 'application/json' } })
    );
  } catch {
    // A full disk. The pages already saved still read; the list says so next time.
  }
}

/** The manifest and the downloads in progress, kept current. */
export function useOffline(): { manifest: Manifest | null; jobs: Job[] } {
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = () => bump((n) => n + 1);
    listeners.add(listener);
    void loadManifest().then(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return { manifest, jobs: [...jobs.values()] };
}

/* ---- reading from it ---- */

/** The saved page list for a chapter, or null if it is not saved here. */
export async function savedPages(seriesId: string, chapterId: string): Promise<string[] | null> {
  const m = await loadManifest();
  return m.series[seriesId]?.chapters[chapterId]?.pages ?? null;
}

/** A saved response for a URL — a page or a cover — if there is one. */
export async function cachedResponse(url: string): Promise<Response | undefined> {
  if (!offlineSupported) return undefined;
  try {
    return await (await caches.open(CACHE)).match(url, { ignoreVary: true, ignoreSearch: false });
  } catch {
    return undefined;
  }
}

/* ---- saving to it ---- */

export type SeriesInfo = {
  seriesId: string;
  title: string;
  sourceName: string;
  coverPath: string | null;
  readChapters: number[];
  position: SavedPlace | null;
};

type Queued = { series: SeriesInfo; chapter: { id: string; number: number; name: string }; pages: () => Promise<string[]> };
const queue: Queued[] = [];
/** What a failed download needs to be tried again, by job key. */
const failed = new Map<string, Queued>();
let running = false;
let asked = false;

/**
 * Save a chapter. Queued, one chapter at a time, three pages at a time, so
 * "download the next ten" does not put thirty requests on the PC at once.
 */
export function queueDownload(
  series: SeriesInfo,
  chapter: { id: string; number: number; name: string },
  pages: () => Promise<string[]>
): void {
  if (!offlineSupported) return;
  const key = `${series.seriesId}:${chapter.id}`;
  if (jobs.has(key) || manifest?.series[series.seriesId]?.chapters[chapter.id]) return;
  jobs.set(key, {
    key,
    seriesId: series.seriesId,
    seriesTitle: series.title,
    chapterId: chapter.id,
    name: chapter.name,
    done: 0,
    total: null,
    problem: null,
  });
  queue.push({ series, chapter, pages });
  failed.delete(key);
  notify();
  firstTime();
  void run();
}

/**
 * Once per session, the two things that make a first download worth keeping.
 *
 * Asking for persistent storage, which a browser may grant or ignore but never
 * holds against you for asking; and fetching the offline screen's code while
 * the server can serve it — the service worker only has what it has seen, and a
 * reading screen that was never loaded is not there on the train.
 */
function firstTime(): void {
  if (asked) return;
  asked = true;
  void navigator.storage?.persist?.().catch(() => undefined);
  void import('./offline').catch(() => undefined);
}

async function run(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const cache = await caches.open(CACHE);
    while (queue.length > 0) {
      const { series, chapter, pages } = queue[0]!;
      const key = `${series.seriesId}:${chapter.id}`;
      const job = jobs.get(key)!;
      try {
        const list = await pages();
        job.total = list.length;
        notify();

        let bytes = 0;
        let missing = 0;
        let next = 0;
        const worker = async () => {
          while (next < list.length && !job.cancelled) {
            const url = list[next++]!;
            try {
              const have = await cache.match(url);
              if (have) {
                bytes += (await have.clone().blob()).size;
              } else {
                const response = await fetch(url, { headers: { authorization: `Bearer ${getToken()}` } });
                if (!response.ok) throw new Error(String(response.status));
                const body = await response.arrayBuffer();
                bytes += body.byteLength;
                await cache.put(
                  url,
                  new Response(body, { headers: { 'content-type': response.headers.get('content-type') ?? 'image/jpeg' } })
                );
              }
            } catch {
              missing += 1;
            }
            job.done += 1;
            notify();
          }
        };
        await Promise.all(Array.from({ length: Math.min(IN_FLIGHT, list.length) }, worker));

        if (series.coverPath && !(await cache.match(series.coverPath))) {
          try {
            const cover = await fetch(series.coverPath, { headers: { authorization: `Bearer ${getToken()}` } });
            if (cover.ok) await cache.put(series.coverPath, cover);
          } catch {
            // A saved chapter with a blank where the cover was is still a saved chapter.
          }
        }

        if (job.cancelled) {
          // Stopped: take back what it had saved, rather than leave pages that
          // no list mentions using space nobody can see.
          await Promise.all(list.map((url) => cache.delete(url)));
          jobs.delete(key);
          queue.shift();
          notify();
          continue;
        }

        /*
         * Recorded as saved only when every page is here. A chapter with holes
         * saved as "downloaded" would be discovered on the train, which is the
         * one place it cannot be fixed.
         */
        if (missing > 0) {
          job.problem = `${missing} of ${list.length} pages would not download — try again while online`;
          failed.set(key, queue[0]!);
        } else {
          const m = await loadManifest();
          const current = m.series[series.seriesId];
          await saveManifest({
            ...m,
            series: {
              ...m.series,
              [series.seriesId]: {
                seriesId: series.seriesId,
                title: series.title,
                sourceName: series.sourceName,
                coverPath: series.coverPath,
                readChapters: series.readChapters,
                position: series.position ?? current?.position ?? null,
                chapters: {
                  ...(current?.chapters ?? {}),
                  [chapter.id]: { chapterId: chapter.id, number: chapter.number, name: chapter.name, pages: list, bytes, at: Date.now() },
                },
              },
            },
          });
          jobs.delete(key);
        }
      } catch (error) {
        job.problem = error instanceof Error ? error.message : 'the download failed';
        failed.set(key, queue[0]!);
      }
      queue.shift();
      notify();
    }
  } finally {
    running = false;
  }
}

/** Let a failed download be asked for again. */
export function clearProblem(key: string): void {
  const job = jobs.get(key);
  if (job?.problem) {
    jobs.delete(key);
    failed.delete(key);
    notify();
  }
}

/** Try a failed download again, from the Downloads tab. */
export function retryDownload(key: string): void {
  const item = failed.get(key);
  if (!item) return;
  jobs.delete(key);
  failed.delete(key);
  queueDownload(item.series, item.chapter, item.pages);
}

/**
 * Stop a download. One still waiting is simply taken off the list; the one in
 * progress stops after the pages already in flight, and what it saved is
 * removed again.
 */
export function cancelDownload(key: string): void {
  const job = jobs.get(key);
  if (!job) return;
  const at = queue.findIndex((q) => `${q.series.seriesId}:${q.chapter.id}` === key);
  if (at > 0) {
    queue.splice(at, 1);
    jobs.delete(key);
  } else if (at === 0) {
    job.cancelled = true;
  } else {
    jobs.delete(key);
    failed.delete(key);
  }
  notify();
}

/* ---- removing ---- */

export async function removeChapter(seriesId: string, chapterId: string): Promise<void> {
  const m = await loadManifest();
  const series = m.series[seriesId];
  const chapter = series?.chapters[chapterId];
  if (!series || !chapter) return;
  const cache = await caches.open(CACHE);
  await Promise.all(chapter.pages.map((url) => cache.delete(url)));
  const { [chapterId]: _gone, ...rest } = series.chapters;
  const nextSeries = { ...m.series };
  if (Object.keys(rest).length === 0) {
    if (series.coverPath) await cache.delete(series.coverPath);
    delete nextSeries[seriesId];
  } else {
    nextSeries[seriesId] = { ...series, chapters: rest };
  }
  await saveManifest({ ...m, series: nextSeries });
}

export async function removeSeries(seriesId: string): Promise<void> {
  const m = await loadManifest();
  for (const chapterId of Object.keys(m.series[seriesId]?.chapters ?? {})) await removeChapter(seriesId, chapterId);
}

/* ---- keeping the copy of your reading current ---- */

/**
 * Update what this device knows about your reading of a saved series — from
 * the server when online, or from reading here when not. Nothing happens for a
 * series with nothing saved, so this is cheap to call from anywhere.
 */
export async function updateSnapshot(
  seriesId: string,
  change: { readChapters?: number[]; read?: number; position?: SavedPlace | null }
): Promise<void> {
  const m = await loadManifest();
  const series = m.series[seriesId];
  if (!series) return;
  const readChapters = change.readChapters ?? series.readChapters;
  const next: SavedSeries = {
    ...series,
    readChapters:
      change.read === undefined ? readChapters : [...new Set([...readChapters, change.read])].sort((a, b) => a - b),
    position: change.position === undefined ? series.position : change.position,
  };
  if (JSON.stringify(next) === JSON.stringify(series)) return;
  await saveManifest({ ...m, series: { ...m.series, [seriesId]: next } });
}

/** How much is saved, and how much the browser says it may use. */
export async function usage(): Promise<{ saved: number; quota: number | null }> {
  const m = await loadManifest();
  const saved = Object.values(m.series)
    .flatMap((s) => Object.values(s.chapters))
    .reduce((sum, c) => sum + c.bytes, 0);
  let quota: number | null = null;
  try {
    quota = (await navigator.storage?.estimate?.())?.quota ?? null;
  } catch {
    // Not every browser says.
  }
  return { saved, quota };
}

export function sizeText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
