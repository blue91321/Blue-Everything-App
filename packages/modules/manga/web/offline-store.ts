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
import { blobIsWholeImage, isWholeImage } from './image-bytes';

import {
  permission as folderPermission,
  readPage as readFolderPage,
  removeChapterFolder,
  removeSeriesFolder,
  writePage as writeFolderPage,
  rewritePage as rewriteFolderPage,
} from './folder-store';

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
  /**
   * Where each page went, when it went into a folder you chose rather than
   * into the browser — paths relative to that folder, parallel to `pages`.
   *
   * Its **presence is the record of the destination**, per chapter rather than
   * globally: switching the setting must not make what is already saved
   * unreadable, and a library part in one place and part in the other is an
   * ordinary consequence of changing your mind. Absent means Cache Storage,
   * which is also what every chapter saved before this existed says.
   */
  files?: string[];
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
    // Chapters saved into a folder on an earlier visit are findable again.
    reindexFolder(manifest);
    return manifest;
  })();
  return loading;
}

async function saveManifest(next: Manifest): Promise<void> {
  reindexFolder(next);
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

/**
 * Where each folder-saved page lives, by its URL.
 *
 * Rebuilt whenever the manifest is written rather than walked per page: the
 * reader asks once per image and a long webtoon chapter is a hundred of them,
 * so a scan of every series' every chapter would be done a hundred times to
 * answer the same question.
 */
let inFolder = new Map<string, string>();

function reindexFolder(m: Manifest): void {
  const next = new Map<string, string>();
  for (const series of Object.values(m.series)) {
    for (const chapter of Object.values(series.chapters)) {
      if (!chapter.files) continue;
      chapter.pages.forEach((url, i) => {
        const file = chapter.files![i];
        if (file) next.set(url, file);
      });
    }
  }
  inFolder = next;
}

/**
 * A saved response for a URL — a page or a cover — if there is one.
 *
 * The folder is asked first and only for pages it actually holds, so a device
 * with no folder pays one `Map.get` and behaves exactly as before. Covers are
 * always in Cache Storage: they are a few kilobytes each, they are wanted on
 * every shelf render, and putting them behind a permission that can lapse
 * would make the offline list look broken rather than merely unreadable.
 */
export async function cachedResponse(url: string): Promise<Response | undefined> {
  const path = inFolder.get(url);
  if (path) {
    const fromFolder = await readFolderPage(path);
    if (fromFolder) return fromFolder;
    // Permission gone, or the folder moved. Falling through rather than
    // failing: the browser may still hold it from before the switch.
  }
  if (!offlineSupported) return undefined;
  try {
    return await (await caches.open(CACHE)).match(url, { ignoreVary: true, ignoreSearch: false });
  } catch {
    return undefined;
  }
}

/**
 * Put a good copy of a page where a damaged saved one was.
 *
 * Only ever *replaces*: a page this device never saved stays unsaved, since
 * reading a chapter is not asking to keep it. Called by the reader whenever it
 * had to fetch a page that was meant to be here — a saved copy that would not
 * draw, or "tap to try again" — so a chapter that went bad on the device mends
 * itself the next time it is read with a connection, rather than staying broken
 * on the train for good.
 */
export async function replaceSavedPage(url: string, body: ArrayBuffer, type: string): Promise<void> {
  const path = inFolder.get(url);
  if (path) {
    await rewriteFolderPage(path, body);
    return;
  }
  if (!offlineSupported) return;
  try {
    const cache = await caches.open(CACHE);
    if (await cache.match(url, { ignoreVary: true })) {
      await cache.put(url, new Response(body, { headers: { 'content-type': type } }));
    }
  } catch {
    // Storage refused. The page still shows; it is simply not mended here.
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
        /*
         * Into the folder, when one is chosen and still permitted.
         *
         * Decided once per chapter rather than per page, so a permission that
         * lapses mid-chapter cannot split it across two places — half a
         * chapter in each is the one arrangement neither reader path can make
         * whole.
         */
        const toFolder = (await folderPermission()) === 'granted';
        const files: (string | null)[] = toFolder ? new Array<string | null>(list.length).fill(null) : [];
        const worker = async () => {
          while (next < list.length && !job.cancelled) {
            const at = next++;
            const url = list[at]!;
            try {
              const have = toFolder ? undefined : await cache.match(url);
              // A copy already here counts only if it is a whole picture — one
              // left damaged by an earlier attempt is fetched again, not kept.
              const haveBlob = have ? await have.clone().blob() : null;
              if (haveBlob && (await blobIsWholeImage(haveBlob))) {
                bytes += haveBlob.size;
              } else {
                const response = await fetch(url, { headers: { authorization: `Bearer ${getToken()}` } });
                if (!response.ok) throw new Error(String(response.status));
                const body = await response.arrayBuffer();
                /*
                 * Checked before it is kept. A page that arrived cut off, or as
                 * an error message, is a missing page — counted as one and
                 * offered again — rather than a saved page that draws as a gap
                 * on the train, which is the one place nothing can fetch it.
                 */
                if (!isWholeImage(new Uint8Array(body, 0, Math.min(32, body.byteLength)), new Uint8Array(body, Math.max(0, body.byteLength - 1024)), body.byteLength)) {
                  throw new Error('damaged');
                }
                const type = response.headers.get('content-type') ?? 'image/jpeg';
                bytes += body.byteLength;
                if (toFolder) {
                  const path = await writeFolderPage(series.title, chapter.number, at, body, type);
                  // A page the folder would not take is a missing page, counted
                  // as one: recorded as saved it would be a hole discovered on
                  // the train, which is the one place it cannot be fixed.
                  if (!path) throw new Error('folder');
                  files[at] = path;
                } else {
                  await cache.put(url, new Response(body, { headers: { 'content-type': type } }));
                }
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
          if (toFolder) await removeChapterFolder(series.title, chapter.number);
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
                  [chapter.id]: {
                  chapterId: chapter.id,
                  number: chapter.number,
                  name: chapter.name,
                  pages: list,
                  bytes,
                  at: Date.now(),
                  // Only when it went there, so absent keeps meaning the browser.
                  ...(toFolder ? { files: files as string[] } : {}),
                },
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
  // The pages of a chapter saved into a folder are files, not cache entries.
  if (chapter.files) await removeChapterFolder(series.title, chapter.number);
  const { [chapterId]: _gone, ...rest } = series.chapters;
  const nextSeries = { ...m.series };
  if (Object.keys(rest).length === 0) {
    if (series.coverPath) await cache.delete(series.coverPath);
    // Its own folder goes with the last chapter in it, rather than being left
    // as an empty tree in somebody's Downloads.
    if (Object.values(series.chapters).some((c) => c.files)) await removeSeriesFolder(series.title);
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
  if (bytes <= 0) return 'nothing';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
