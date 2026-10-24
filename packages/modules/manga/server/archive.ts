/**
 * Keeping a series, for good, on this machine's disk.
 *
 * ### This is the third thing called "download", and the only one that keeps
 *
 * The other two already exist and neither of them is a backup:
 *
 *   - `page-cache.ts` keeps **the last ten chapters opened**. It is a cache and
 *     behaves like one — the eleventh pushes the oldest out and deletes its
 *     folder. It exists so going back to check a panel is not a round trip.
 *   - the browser's downloads (`offline-store.ts`) live in **that device's**
 *     storage, which is why the manga screen says so in as many words: iOS
 *     clears a web app's storage when the phone runs short of space.
 *
 * An archive is neither. It is on the server's own disk, it is complete rather
 * than recent, **nothing evicts it**, and it is the copy that is still there
 * when the site is not. That is the whole point, so the one rule this file must
 * never break is: it does not delete anything it was not explicitly asked to.
 *
 * ### It has to survive this app
 *
 * A backup that can only be read by the program that made it is a hostage, not
 * a backup — and the scenario being planned for is the one where things go
 * away. So the folder is laid out for a person with a file manager:
 *
 * ```
 * data/manga-archive/
 *   Solo Eating (5b4d8657)/
 *     series.json          <- what it is, where it came from, what is here
 *     Chapter 0001/
 *       001.jpg  002.jpg  003.jpg  ...
 *     Chapter 0012.5/
 *       ...
 * ```
 *
 * Pages are **zero-padded and carry their real extension**, so every file
 * manager and image viewer on earth sorts and opens them in the right order
 * without being told. Chapter folders are named by *number*, not by the
 * source's chapter id, because a number means the same thing wherever you read
 * it — which is the reasoning `readChapters` already follows one level up. The
 * id is recorded in `series.json`, where it belongs: it is a fact about one
 * source rather than about the chapter.
 *
 * ### One page at a time, and the queue is on disk
 *
 * Archiving a long series is thousands of images from somebody else's server.
 * So it is strictly sequential with a pause between chapters — the same bargain
 * `matching.ts` struck for its searches — and the queue is written down, so
 * closing the app halfway through a nine-hundred-chapter series resumes rather
 * than starts again.
 *
 * ### Nothing here runs on a timer
 *
 * New chapters are caught by `sweepArchive`, which the release sweep already
 * running every half hour calls when it is done. This project requires anything
 * on a timer to justify itself against the attention loop's numbers, and a
 * second interval for something the first one is already awake for cannot.
 *
 * ### A gap is reported, never hidden
 *
 * The failure this app is built against is stale data presented as fact, and an
 * archive with holes in it presented as complete is exactly that — you would
 * find out the day the site went down. So every chapter records how many pages
 * were expected against how many are on disk, a failure is kept beside the
 * chapter it could not fetch, and the overview counts what is missing rather
 * than reporting the happy number.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { dataDir, nameFor } from '@everything/server/module-api';
import { read } from './library.js';
import { sharedPage } from './page-fetch.js';

/** Where an archive goes when nothing else has been chosen. */
export const DEFAULT_ARCHIVE_ROOT = join(dataDir, 'manga-archive');

/**
 * Where the archive is, asked each time rather than resolved once.
 *
 * A constant would be read at import and could never follow the setting, which
 * is the same trap `features.ts` describes about resolving the feature set at
 * module load — except this one has an obvious fix, because nothing here is
 * structural. The cost is one small JSON read per call, on paths that are
 * already doing disk work.
 *
 * The setting is only honoured when it is absolute. A relative path would
 * resolve against the server's working directory, and Task Scheduler starts
 * this process in `C:\Windows\System32` — so a plausible-looking `manga`
 * would quietly build an archive somewhere nobody would ever look.
 */
export function archiveRoot(): string {
  const chosen = read().archiveFolder;
  return chosen && isAbsolute(chosen) ? chosen : DEFAULT_ARCHIVE_ROOT;
}

const indexPath = (): string => join(archiveRoot(), 'index.json');

/**
 * How many times a chapter is retried before it is left alone.
 *
 * Not forever: a chapter the source has lost would otherwise sit at the head of
 * the queue retrying for the life of the app, and nothing behind it would ever
 * be fetched. It stays in the manifest with its error, which is what makes it
 * findable later rather than silently absent.
 */
export const MAX_TRIES = 3;

/** A breath between chapters. The source is somebody else's server. */
export const CHAPTER_PAUSE_MS = 1_500;

/** The shape Suwayomi publishes, which is also what the page route checks. */
const PAGE_PATH = /^\/api\/v1\/manga\/\d+\/chapter\/\d+\/page\/(\d+)$/;

export interface ArchivePage {
  /** The source path this page came from — how the reader asks for it again. */
  path: string;
  /** Relative to the chapter folder, e.g. `003.jpg`. */
  file: string;
  type: string;
  bytes: number;
}

export interface ArchiveChapter {
  number: number;
  name: string;
  /** The linked source's id for it. Meaningless without that source; see `library.ts`. */
  chapterId: string;
  /** Relative to the series folder, e.g. `Chapter 0012.5`. */
  folder: string;
  pages: ArchivePage[];
  /** How many the source said there were, so a short chapter is visible as short. */
  expected: number | null;
  done: boolean;
  /** Why the last attempt failed, kept beside the chapter it could not fill. */
  error: string | null;
  at: number;
  /**
   * The source's other entries for this number, which are not fetched: see
   * `pickEdition`. Kept so a reader that opened one of those still reads this
   * one from disk.
   */
  sameAs?: string[];
}

export interface ArchiveManifest {
  seriesId: string;
  title: string;
  source: { adapter: string; mangaId: string; sourceName: string; title: string } | null;
  startedAt: number;
  updatedAt: number;
  chapters: ArchiveChapter[];
}

export interface QueueItem {
  seriesId: string;
  chapterId: string;
  number: number;
  name: string;
  tries: number;
  error: string | null;
}

export interface ArchiveIndexEntry {
  seriesId: string;
  folder: string;
  title: string;
  addedAt: number;
  /**
   * Suwayomi's id for it, which is what every copy on this PC means by "this
   * series" (plan A). A series id is one copy's own: your copy and a friend's
   * call the same series by different ids, and only the Suwayomi they share
   * agrees with itself. Absent from an entry written before copies; read from
   * its manifest when needed (`mangaIdOf`).
   */
  mangaId?: string;
  /** Who asked for it to be kept: `you`, or a friend's copy by name. */
  keptFor?: string[];
}

export interface ArchiveIndex {
  series: ArchiveIndexEntry[];
  queue: QueueItem[];
}

/* ------------------------------------------------------------------ *
 * Paths
 * ------------------------------------------------------------------ */

/**
 * A series id is put into a path, so it is checked rather than trusted.
 *
 * The habit picture route is the cautionary tale this repeats the guard from:
 * `habit-${id}.png` made `habit-` its own path segment, so a `..` after it
 * climbed out of the data folder and read a file that was none of its business.
 * The same shape of mistake is available here, one directory deeper.
 */
const SAFE_ID = /^[A-Za-z0-9-]{1,64}$/;

/** What a person should see in a file manager, with nothing a path can use. */
function titleSlug(title: string): string {
  const cleaned = title
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    // Windows refuses a name ending in a dot or a space, silently, at write time.
    .replace(/[. ]+$/, '');
  return cleaned || 'Untitled';
}

/** `Solo Eating (5b4d8657)` — readable, and unique even for two of one name. */
export function folderFor(seriesId: string, title: string): string {
  if (!SAFE_ID.test(seriesId)) throw new Error('not a series id');
  return `${titleSlug(title)} (${seriesId.slice(0, 8)})`;
}

/**
 * `Chapter 0012.5` — padded so a file manager sorts it the way you read it.
 *
 * Unpadded was the first version and puts chapter 10 before chapter 2 in every
 * listing on every platform, which for a nine-hundred-chapter series makes the
 * folder unusable for exactly the person this is for.
 */
export function chapterFolder(number: number): string {
  const whole = Math.floor(Math.abs(number));
  const padded = String(whole).padStart(4, '0');
  // The decimal part as the number is written: `2.1 % 1` is 0.10000000000000009,
  // and that was a folder name.
  const written = String(Math.abs(number));
  const dot = written.indexOf('.');
  const sign = number < 0 ? '-' : '';
  return `Chapter ${sign}${padded}${dot >= 0 ? written.slice(dot) : ''}`;
}

/** `image/webp` → `webp`. Unknown types keep their bytes under a plain name. */
export function extensionFor(type: string): string {
  const known: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
  };
  return known[type.split(';')[0].trim().toLowerCase()] ?? 'img';
}

/* ------------------------------------------------------------------ *
 * The index, and each series' manifest
 * ------------------------------------------------------------------ */

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

export function readIndex(): ArchiveIndex {
  try {
    const parsed = JSON.parse(readFileSync(indexPath(), 'utf8').replace(/^﻿/, '')) as Partial<ArchiveIndex>;
    return {
      series: Array.isArray(parsed.series) ? parsed.series : [],
      queue: Array.isArray(parsed.queue) ? parsed.queue : [],
    };
  } catch {
    return { series: [], queue: [] };
  }
}

export function writeIndex(index: ArchiveIndex): void {
  writeJson(indexPath(), index);
}

export function manifestPath(folder: string): string {
  return join(archiveRoot(), folder, 'series.json');
}

export function readManifest(folder: string): ArchiveManifest | null {
  try {
    return JSON.parse(readFileSync(manifestPath(folder), 'utf8').replace(/^﻿/, '')) as ArchiveManifest;
  } catch {
    return null;
  }
}

export function writeManifest(folder: string, manifest: ArchiveManifest): void {
  writeJson(manifestPath(folder), { ...manifest, updatedAt: Date.now() });
}

/** The archived series' folder, or null if it is not archived. */
export function folderOf(seriesId: string, mangaId?: string | null): string | null {
  return entryFor(readIndex(), seriesId, mangaId)?.folder ?? null;
}

export function isArchived(seriesId: string, mangaId?: string | null): boolean {
  return folderOf(seriesId, mangaId) !== null;
}

/** An entry's Suwayomi id: recorded, or read from its manifest for an older entry. */
function mangaIdOf(entry: ArchiveIndexEntry): string | null {
  return entry.mangaId ?? readManifest(entry.folder)?.source?.mangaId ?? null;
}

/**
 * The entry for a series: by this copy's id, or by the Suwayomi id every copy
 * shares, which is how your copy finds a series a friend asked to keep and a
 * friend finds one you keep. One series is kept once, whoever asked.
 */
function entryFor(index: ArchiveIndex, seriesId: string, mangaId?: string | null): ArchiveIndexEntry | undefined {
  return (
    index.series.find((s) => s.seriesId === seriesId) ??
    (mangaId ? index.series.find((s) => mangaIdOf(s) === mangaId) : undefined)
  );
}

/**
 * What a kept series is and where it came from, by its entry's own id: for a
 * series kept for a friend's copy (`kept-<id>`), which is in no library here.
 */
export function keptEntry(seriesId: string): { title: string; source: NonNullable<ArchiveManifest['source']> } | null {
  const entry = readIndex().series.find((s) => s.seriesId === seriesId);
  const manifest = entry ? readManifest(entry.folder) : null;
  return manifest?.source ? { title: manifest.title, source: manifest.source } : null;
}

/** The Suwayomi ids of everything kept, for the library's "On this PC" filter. */
export function keptMangaIds(): Set<string> {
  const ids = new Set<string>();
  for (const entry of readIndex().series) {
    const id = mangaIdOf(entry);
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * Everything kept, as Browse's "On this PC" lists it: what it is, where it came
 * from, and how many chapters are complete.
 */
export function keptSeries(asking = 'you'): Array<{
  seriesId: string;
  mangaId: string;
  sourceName: string;
  title: string;
  complete: number;
  keptFor: string[];
}> {
  const out = [];
  for (const entry of readIndex().series) {
    const manifest = readManifest(entry.folder);
    const mangaId = entry.mangaId ?? manifest?.source?.mangaId;
    if (!mangaId || !manifest?.source) continue;
    out.push({
      seriesId: entry.seriesId,
      mangaId,
      sourceName: manifest.source.sourceName,
      title: manifest.title,
      complete: manifest.chapters.filter((c) => c.done).length,
      keptFor: (entry.keptFor ?? ['you']).map((who) => nameFor(who, asking)),
    });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

/* ------------------------------------------------------------------ *
 * Reading it back
 * ------------------------------------------------------------------ */

/**
 * The page list of an archived chapter, in the source's own path form.
 *
 * Deliberately the same shape `cachedPageList` returns, so the route that
 * serves a chapter gains one `if` rather than a second way of doing things.
 */
export function archivedPageList(seriesId: string, chapterId: string, mangaId?: string | null): string[] | null {
  const folder = folderOf(seriesId, mangaId);
  if (!folder) return null;
  // The edition kept, whichever of the source's entries for that number was opened.
  const chapter = readManifest(folder)?.chapters.find((c) => c.chapterId === chapterId || c.sameAs?.includes(chapterId));
  if (!chapter || chapter.pages.length === 0) return null;
  return chapter.pages.map((p) => p.path);
}

/** One archived page's bytes, looked up by the path the reader asks for. */
export function archivedPage(seriesId: string, path: string, mangaId?: string | null): { body: Buffer; type: string } | null {
  const folder = folderOf(seriesId, mangaId);
  if (!folder) return null;
  const manifest = readManifest(folder);
  if (!manifest) return null;

  for (const chapter of manifest.chapters) {
    const page = chapter.pages.find((p) => p.path === path);
    if (!page) continue;
    const file = join(archiveRoot(), folder, chapter.folder, page.file);
    if (!existsSync(file)) return null;
    return { body: readFileSync(file), type: page.type };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Starting, and stopping
 * ------------------------------------------------------------------ */

export interface ChapterToArchive {
  id: string;
  number: number;
  name: string;
  uploadedAt?: number | null;
}

/**
 * Which of a source's entries for one chapter number is kept.
 *
 * Sources list some numbers twice: two scanlations, or a re-upload. MangaFire
 * does it for most of Eleceed. Both are the same chapter, so keeping both is the
 * series on disk twice, and it was worse than that: the folder is named by
 * number, so the second copy wrote its pages over the first's. The rule is the
 * chapter list's (`pickOnePerNumber`): the newest upload, which is usually the
 * corrected one, else whichever the source listed first.
 */
export function pickEdition<T extends ChapterToArchive>(group: readonly T[]): T {
  return [...group].sort((a, b) => (b.uploadedAt ?? 0) - (a.uploadedAt ?? 0))[0]!;
}

/**
 * Archive this series, and queue everything not already on disk.
 *
 * Safe to call again: it is how "catch up on what is missing" works, and how a
 * series whose archive failed halfway is resumed. Nothing already complete is
 * fetched twice.
 */
export function startArchive(
  series: { id: string; title: string; source: { adapter: string; mangaId: string; sourceName: string; title: string } | null },
  chapters: readonly ChapterToArchive[],
  keptFor = 'you'
): { queued: number; already: number } {
  if (!SAFE_ID.test(series.id)) throw new Error('not a series id');

  const index = readIndex();
  // Already kept, by this id or for another copy by Suwayomi's: kept once.
  let entry = entryFor(index, series.id, series.source?.mangaId);
  if (!entry) {
    entry = { seriesId: series.id, folder: folderFor(series.id, series.title), title: series.title, addedAt: Date.now() };
    index.series.push(entry);
  }
  if (series.source?.mangaId) entry.mangaId = series.source.mangaId;
  entry.keptFor = [...new Set([...(entry.keptFor ?? ['you']), keptFor])];
  // The queue and the manifest are the entry's, whichever copy's id asked.
  const entryId = entry.seriesId;

  const manifest: ArchiveManifest = readManifest(entry.folder) ?? {
    seriesId: entryId,
    title: series.title,
    source: series.source,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    chapters: [],
  };
  // The source can be relinked after archiving started; the newest answer wins,
  // and what is already on disk is untouched by that.
  manifest.source = series.source ?? manifest.source;
  manifest.title = series.title;

  let queued = 0;
  let already = 0;

  // One copy of each chapter number; see `pickEdition`.
  const byNumber = new Map<number, ChapterToArchive[]>();
  for (const chapter of chapters) {
    const group = byNumber.get(chapter.number);
    if (group) group.push(chapter);
    else byNumber.set(chapter.number, [chapter]);
  }

  for (const [number, group] of byNumber) {
    let have = manifest.chapters.find((c) => c.number === number);
    if (!have) {
      const pick = pickEdition(group);
      have = {
        number,
        name: pick.name,
        chapterId: pick.id,
        folder: chapterFolder(number),
        pages: [],
        expected: null,
        done: false,
        error: null,
        at: 0,
      };
      manifest.chapters.push(have);
    } else if (!have.done && !group.some((c) => c.id === have!.chapterId)) {
      // The edition it was fetching has gone from the source. Its half-fetched
      // pages were never a whole chapter; one that is there is fetched instead.
      for (const page of have.pages) rmSync(join(archiveRoot(), entry.folder, have.folder, page.file), { force: true });
      const pick = pickEdition(group);
      have.chapterId = pick.id;
      have.name = pick.name;
      have.pages = [];
      have.expected = null;
    }
    const kept = have;
    const others = group.map((c) => c.id).filter((id) => id !== kept.chapterId);
    if (others.length > 0) kept.sameAs = [...new Set([...(kept.sameAs ?? []), ...others])];

    if (kept.done) {
      already += 1;
      continue;
    }
    const waiting = index.queue.find((q) => q.seriesId === entryId && q.chapterId === kept.chapterId);
    if (waiting) {
      // Asked for again by hand: a chapter that had given up gets its tries back.
      waiting.tries = 0;
      waiting.error = null;
      continue;
    }
    // Another edition of this number queued earlier is replaced by this one.
    index.queue = index.queue.filter((q) => !(q.seriesId === entryId && q.number === number));
    index.queue.push({
      seriesId: entryId,
      chapterId: kept.chapterId,
      number,
      name: kept.name,
      tries: 0,
      error: null,
    });
    queued += 1;
  }

  manifest.chapters.sort((a, b) => a.number - b.number);
  writeManifest(entry.folder, manifest);
  writeIndex(index);
  return { queued, already };
}

/**
 * One series' manifest with each chapter number down to one edition, and the
 * pages the dropped editions wrote taken off the disk.
 *
 * What keeping both did, before `pickEdition`: the two shared a folder, so the
 * one fetched second wrote `001.jpg` and on over the first's. So the edition
 * kept is the one whose every page on disk is still the size it recorded, which
 * is whole; if neither is, the one written last, with any page it lost dropped
 * so it is fetched again. A size match is the test because an overwritten page
 * is another picture, and two pictures the same size to the byte is not a thing
 * that happens.
 *
 * Exported with the folder passed in, so `manga-check` can drive it on a
 * throwaway one.
 */
export function mendManifest(
  seriesDir: string,
  manifest: ArchiveManifest
): { dropped: string[]; refetch: string[]; freed: number } {
  const sizeOf = (chapter: ArchiveChapter, file: string): number | null => {
    try {
      return statSync(join(seriesDir, chapter.folder, file)).size;
    } catch {
      return null;
    }
  };
  const intact = (c: ArchiveChapter) =>
    c.done && c.pages.length > 0 && c.pages.every((p) => sizeOf(c, p.file) === p.bytes);

  const byNumber = new Map<number, ArchiveChapter[]>();
  for (const c of manifest.chapters) {
    const group = byNumber.get(c.number);
    if (group) group.push(c);
    else byNumber.set(c.number, [c]);
  }

  const dropped: string[] = [];
  const refetch: string[] = [];
  let freed = 0;
  const keep: ArchiveChapter[] = [];
  for (const group of byNumber.values()) {
    if (group.length === 1) {
      keep.push(group[0]!);
      continue;
    }
    const kept = group.find(intact) ?? [...group].sort((a, b) => b.at - a.at)[0]!;
    if (!intact(kept)) {
      kept.pages = kept.pages.filter((p) => sizeOf(kept, p.file) === p.bytes);
      if (kept.done) {
        kept.done = false;
        kept.error = null;
      }
      refetch.push(kept.chapterId);
    }
    const ownFiles = new Set(kept.pages.map((p) => join(kept.folder, p.file)));
    for (const other of group) {
      if (other === kept) continue;
      dropped.push(other.chapterId);
      kept.sameAs = [...new Set([...(kept.sameAs ?? []), other.chapterId, ...(other.sameAs ?? [])])];
      // Only files this edition recorded, and none the kept one is using.
      for (const page of other.pages) {
        const file = join(other.folder, page.file);
        if (ownFiles.has(file)) continue;
        const size = sizeOf(other, page.file);
        if (size === null) continue;
        rmSync(join(seriesDir, file), { force: true });
        freed += size;
      }
    }
    kept.sameAs = kept.sameAs?.filter((id) => id !== kept.chapterId);
    keep.push(kept);
  }
  manifest.chapters = keep.sort((a, b) => a.number - b.number);
  return { dropped, refetch, freed };
}

/**
 * Every kept series mended, once at startup: see `mendManifest`. Does nothing
 * on a series with one edition per number, which after the first run is all of
 * them.
 */
export function mendEditions(): { series: number; dropped: number; refetch: number; freed: number } {
  const total = { series: 0, dropped: 0, refetch: 0, freed: 0 };
  if (running) return total;
  const index = readIndex();
  let indexChanged = false;
  for (const entry of index.series) {
    const manifest = readManifest(entry.folder);
    if (!manifest) continue;
    const numbers = new Set(manifest.chapters.map((c) => c.number));
    if (numbers.size === manifest.chapters.length) continue;

    const result = mendManifest(join(archiveRoot(), entry.folder), manifest);
    writeManifest(entry.folder, manifest);
    total.series += 1;
    total.dropped += result.dropped.length;
    total.refetch += result.refetch.length;
    total.freed += result.freed;

    // The queue: nothing for a dropped edition, and the kept one if it lost pages.
    const gone = new Set(result.dropped);
    index.queue = index.queue.filter((q) => !(q.seriesId === entry.seriesId && gone.has(q.chapterId)));
    for (const id of result.refetch) {
      const chapter = manifest.chapters.find((c) => c.chapterId === id)!;
      if (index.queue.some((q) => q.seriesId === entry.seriesId && q.chapterId === id)) continue;
      index.queue.push({ seriesId: entry.seriesId, chapterId: id, number: chapter.number, name: chapter.name, tries: 0, error: null });
    }
    indexChanged = true;
  }
  if (indexChanged) writeIndex(index);
  return total;
}

/**
 * Stop archiving it.
 *
 * **The files are kept unless deleting them is asked for**, and that default is
 * the whole character of this feature: "stop following what comes next" and
 * "throw away what I already saved" are different decisions, and only one of
 * them can be undone. The same distinction the notes folder menu draws between
 * removing a folder and removing the notes in it.
 */
export function stopArchive(
  seriesId: string,
  options: { deleteFiles?: boolean; mangaId?: string | null } = {}
): { removed: boolean; deleted: boolean } {
  const index = readIndex();
  const entry = entryFor(index, seriesId, options.mangaId);
  if (!entry) return { removed: false, deleted: false };

  index.series = index.series.filter((s) => s !== entry);
  index.queue = index.queue.filter((q) => q.seriesId !== entry.seriesId);
  writeIndex(index);

  if (!options.deleteFiles) return { removed: true, deleted: false };

  // Resolved from the index rather than rebuilt from the id, so this can only
  // ever remove a folder this file wrote down.
  rmSync(join(archiveRoot(), entry.folder), { recursive: true, force: true });
  return { removed: true, deleted: true };
}

/* ------------------------------------------------------------------ *
 * What is actually there
 * ------------------------------------------------------------------ */

export interface SeriesProgress {
  seriesId: string;
  title: string;
  folder: string;
  addedAt: number;
  chapters: number;
  complete: number;
  /** Chapters that were tried and could not be finished — the honest number. */
  failed: number;
  pages: number;
  bytes: number;
  queued: number;
  updatedAt: number;
  /**
   * The chapter *numbers* that are complete on disk.
   *
   * Numbers rather than the source's chapter ids, for the reason `readChapters`
   * already gives one level up: an id belongs to one source and a relink loses
   * every mark, while a number means the same thing wherever you read it.
   *
   * It exists because the chapter list needs to say which copies of a chapter
   * exist. The ✓ there means "saved on this device", and with a series being
   * archived that read as broken — the chapter plainly *had* been downloaded,
   * just onto the PC rather than into the browser. Reported that way, and the
   * answer is for the screen to name both rather than for one mark to cover
   * two different places.
   */
  savedChapters: number[];
  /** Who asked for it to be kept, by display name, or "you". See `nameFor`. */
  keptFor: string[];
}

/** `asking` is who is looking: `you` on the host, or the copy asking it. */
export function seriesProgress(seriesId: string, mangaId?: string | null, asking = 'you'): SeriesProgress | null {
  const index = readIndex();
  const entry = entryFor(index, seriesId, mangaId);
  if (!entry) return null;
  const manifest = readManifest(entry.folder);
  const chapters = manifest?.chapters ?? [];

  let pages = 0;
  let bytes = 0;
  for (const chapter of chapters) {
    for (const page of chapter.pages) {
      pages += 1;
      bytes += page.bytes;
    }
  }

  return {
    seriesId,
    title: manifest?.title ?? entry.title,
    folder: entry.folder,
    addedAt: entry.addedAt,
    chapters: chapters.length,
    complete: chapters.filter((c) => c.done).length,
    failed: chapters.filter((c) => !c.done && c.error !== null).length,
    pages,
    bytes,
    queued: index.queue.filter((q) => q.seriesId === entry.seriesId).length,
    updatedAt: manifest?.updatedAt ?? entry.addedAt,
    savedChapters: chapters.filter((c) => c.done).map((c) => c.number),
    keptFor: (entry.keptFor ?? ['you']).map((who) => nameFor(who, asking)),
  };
}

/** Everything archived, plus what the worker is doing. */
export function overview(asking = 'you'): {
  series: SeriesProgress[];
  queued: number;
  working: { seriesId: string; number: number; name: string } | null;
  bytes: number;
  root: string;
} {
  const index = readIndex();
  const series = index.series.map((s) => seriesProgress(s.seriesId, null, asking)).filter((s): s is SeriesProgress => s !== null);
  return {
    series,
    queued: index.queue.length,
    working: working ? { seriesId: working.seriesId, number: working.number, name: working.name } : null,
    bytes: series.reduce((sum, s) => sum + s.bytes, 0),
    root: archiveRoot(),
  };
}

/* ------------------------------------------------------------------ *
 * The worker
 * ------------------------------------------------------------------ */

/** The one chapter being fetched, if any. One at a time, on purpose. */
let working: QueueItem | null = null;
let running = false;

/** When each series last had a chapter fetched, for `nextInQueue`. */
const lastServed = new Map<string, number>();

/**
 * The next chapter: the first waiting for whichever series has gone longest
 * without one. Strictly in order, a series kept today waited behind every
 * chapter of one kept yesterday (The Shepherd Wizard, 0 of 41, behind a hundred
 * of Eleceed's). Within a series it is still in order.
 */
export function nextInQueue(queue: readonly QueueItem[], served: ReadonlyMap<string, number> = lastServed): QueueItem | undefined {
  let best: QueueItem | undefined;
  const seen = new Set<string>();
  for (const item of queue) {
    if (seen.has(item.seriesId)) continue;
    seen.add(item.seriesId);
    if (!best || (served.get(item.seriesId) ?? 0) < (served.get(best.seriesId) ?? 0)) best = item;
  }
  return best;
}

export function isRunning(): boolean {
  return running;
}

/** What the worker needs from the outside, so this file talks to no source. */
export interface ArchiveTools {
  /** Suwayomi's base URL, starting it if that is allowed. Null if unavailable. */
  connect: () => Promise<string | null>;
  /** A chapter's page paths, in order. */
  pages: (chapterId: string) => Promise<string[]>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Work the queue until it is empty.
 *
 * Re-entrant by design — every caller that might have added something calls it,
 * and a second call while one is running simply returns. That is the same
 * arrangement `fillChapter` uses, one level up.
 */
export async function runQueue(tools: ArchiveTools): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const index = readIndex();
      const next = nextInQueue(index.queue);
      if (!next) return;

      const url = await tools.connect();
      if (!url) {
        /*
         * Nothing to fetch from. Left in the queue rather than failed: "the
         * source is not running" is not a fact about this chapter, and marking
         * it as a failure would put a permanent hole in an archive over a JVM
         * that was asleep.
         */
        return;
      }

      working = next;
      lastServed.set(next.seriesId, Date.now());
      try {
        await fetchChapter(url, next, tools);
        dequeue(next);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'could not fetch the chapter';
        noteFailure(next, message);
      } finally {
        working = null;
      }

      await sleep(CHAPTER_PAUSE_MS);
    }
  } finally {
    running = false;
    working = null;
  }
}

function dequeue(item: QueueItem): void {
  const index = readIndex();
  index.queue = index.queue.filter((q) => !(q.seriesId === item.seriesId && q.chapterId === item.chapterId));
  writeIndex(index);
}

/**
 * Record a failed attempt, and give up after `MAX_TRIES`.
 *
 * Giving up moves it out of the queue and **leaves it in the manifest with its
 * reason**, which is the difference between an archive that knows it has a hole
 * and one that quietly pretends it does not.
 */
function noteFailure(item: QueueItem, full: string): void {
  // Suwayomi's errors carry the whole Java stack; the first line is the reason.
  const message = full.split(/\r?\n/)[0]!.trim().slice(0, 300);
  const index = readIndex();
  const waiting = index.queue.find((q) => q.seriesId === item.seriesId && q.chapterId === item.chapterId);
  if (waiting) {
    waiting.tries += 1;
    waiting.error = message;
    if (waiting.tries >= MAX_TRIES) {
      index.queue = index.queue.filter((q) => q !== waiting);
    } else {
      // To the back, so one bad chapter cannot block the rest of the series.
      index.queue = [...index.queue.filter((q) => q !== waiting), waiting];
    }
  }
  writeIndex(index);

  const folder = folderOf(item.seriesId);
  if (!folder) return;
  const manifest = readManifest(folder);
  const chapter = manifest?.chapters.find((c) => c.chapterId === item.chapterId);
  if (!manifest || !chapter) return;
  chapter.error = message;
  chapter.at = Date.now();
  writeManifest(folder, manifest);
}

/** One chapter: its page list, then its images, one at a time. */
async function fetchChapter(baseUrl: string, item: QueueItem, tools: ArchiveTools): Promise<void> {
  const folder = folderOf(item.seriesId);
  if (!folder) return; // Stopped while it was queued; nothing to do.

  const paths = await tools.pages(item.chapterId);
  if (paths.length === 0) throw new Error('the source listed no pages for this chapter');

  const manifest = readManifest(folder);
  const chapter = manifest?.chapters.find((c) => c.chapterId === item.chapterId);
  if (!manifest || !chapter) return;

  chapter.expected = paths.length;
  const dir = join(archiveRoot(), folder, chapter.folder);
  mkdirSync(dir, { recursive: true });

  for (const path of paths) {
    if (chapter.pages.some((p) => p.path === path && existsSync(join(dir, p.file)))) continue;

    /*
     * Through `sharedPage`, so a page somebody is reading as it is kept is
     * fetched once, with the reader's retries. It refuses a page that is not
     * a whole picture, which matters most here: a cut-off page archived is a
     * gap that would be served in preference to the source forever.
     */
    const { body, type } = await sharedPage(`${baseUrl}${path}`);

    /*
     * Numbered from the source's own page path rather than from the loop, so a
     * page fetched out of order — a resumed chapter filling its gaps — still
     * lands on the right filename. A path that does not match falls back to its
     * position, which is the ordinary case for a source that numbers
     * differently.
     */
    const matched = PAGE_PATH.exec(path);
    const position = matched ? Number.parseInt(matched[1], 10) + 1 : paths.indexOf(path) + 1;
    const file = `${String(position).padStart(3, '0')}.${extensionFor(type)}`;

    const tmp = join(dir, `${file}.part`);
    writeFileSync(tmp, body);
    renameSync(tmp, join(dir, file));

    chapter.pages = [...chapter.pages.filter((p) => p.path !== path), { path, file, type, bytes: body.length }].sort(
      (a, b) => a.file.localeCompare(b.file)
    );
    chapter.at = Date.now();
    // Written per page, so an interrupted chapter resumes at the page it
    // reached rather than starting the chapter again.
    writeManifest(folder, manifest);
  }

  chapter.done = chapter.pages.length >= paths.length;
  chapter.error = chapter.done ? null : 'some pages are still missing';
  chapter.at = Date.now();
  writeManifest(folder, manifest);
}

/* ------------------------------------------------------------------ *
 * Catching what comes out next
 * ------------------------------------------------------------------ */

/**
 * Queue anything new for every archived series.
 *
 * Called by the release sweep when it has finished, rather than on an interval
 * of its own — the process is already awake at that moment, and this project
 * requires a timer to justify itself.
 *
 * It re-lists chapters per archived series, which is one request each. That is
 * affordable precisely because archiving is deliberate: the list is the handful
 * you chose to keep, not the nine hundred you follow.
 */
export async function sweepArchive(
  tools: ArchiveTools & { chapters: (mangaId: string) => Promise<ChapterToArchive[]> }
): Promise<{ checked: number; queued: number }> {
  const index = readIndex();
  if (index.series.length === 0) return { checked: 0, queued: 0 };

  const url = await tools.connect();
  if (!url) return { checked: 0, queued: 0 };

  let checked = 0;
  let queued = 0;

  for (const entry of index.series) {
    const manifest = readManifest(entry.folder);
    if (!manifest?.source) continue;
    try {
      const chapters = await tools.chapters(manifest.source.mangaId);
      checked += 1;
      const added = startArchive(
        { id: entry.seriesId, title: manifest.title, source: manifest.source },
        chapters
      );
      queued += added.queued;
    } catch {
      // A source that will not answer is the ordinary case for one sweep. The
      // chapter is not marked failed for it — nothing was attempted.
    }
  }

  return { checked, queued };
}

/* ------------------------------------------------------------------ *
 * Disk
 * ------------------------------------------------------------------ */

/**
 * What the archive actually occupies, measured rather than summed.
 *
 * The manifest's byte counts are what this app wrote; this is what is on the
 * disk. They should agree, and the one that answers "will my drive fill up" is
 * this one.
 */
export function diskUsage(): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      try {
        const info = statSync(full);
        if (info.isDirectory()) walk(full);
        else {
          bytes += info.size;
          files += 1;
        }
      } catch {
        // Removed between the listing and the stat; not an error worth raising.
      }
    }
  };
  walk(archiveRoot());
  return { bytes, files };
}
