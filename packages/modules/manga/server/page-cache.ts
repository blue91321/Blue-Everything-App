/**
 * The last ten chapters opened, kept on this machine's disk.
 *
 * Going back to check something — a name, a panel, where a fight started — was
 * a round trip to the source for every page, through a Suwayomi that may be
 * asleep, to a site that may be slow or down. Now the page list and every image
 * of the ten chapters most recently opened are in `data/manga-pages/`, and the
 * reader is served from there before anything else is asked. A cached chapter
 * opens with Suwayomi stopped.
 *
 * ### Filled behind you, not before you
 *
 * A chapter is remembered the moment its page list is fetched, and its images
 * are downloaded one at a time in the background while you read — the reader's
 * own requests are not held up, and a page it asks for before the fill reaches
 * it is fetched as before and kept then.
 *
 * ### Ten, by when they were opened
 *
 * Opening a chapter puts it at the front; the eleventh pushes the oldest out
 * and its folder is deleted. That bounds the disk by chapters rather than
 * bytes, and a long webtoon chapter can be tens of megabytes, so ten is a few
 * hundred at most.
 *
 * `index.json` is the only record. A folder it does not name is removed on the
 * next write, so a crash mid-eviction cannot leave strays for good.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '@everything/server/module-api';

export const KEEP_CHAPTERS = 10;

const ROOT = join(dataDir, 'manga-pages');
const INDEX = join(ROOT, 'index.json');

/** The one shape Suwayomi publishes, and what the page route already checks. */
const PAGE = /^\/api\/v1\/manga\/(\d+)\/chapter\/(\d+)\/page\/(\d+)$/;

type Entry = {
  seriesId: string;
  chapterId: string;
  /** Suwayomi page paths, in order. */
  pages: string[];
  /** Page path → content type, for the ones on disk. */
  stored: Record<string, string>;
  at: number;
};

type Index = { chapters: Entry[] };

const folderOf = (e: Pick<Entry, 'seriesId' | 'chapterId'>) =>
  join(ROOT, `${e.seriesId.replace(/[^A-Za-z0-9-]/g, '')}-${e.chapterId.replace(/[^0-9]/g, '')}`);

function fileOf(e: Entry, path: string): string | null {
  const m = PAGE.exec(path);
  return m ? join(folderOf(e), `${m[3]}.img`) : null;
}

function readIndex(): Index {
  try {
    const parsed = JSON.parse(readFileSync(INDEX, 'utf8')) as Index;
    return Array.isArray(parsed.chapters) ? parsed : { chapters: [] };
  } catch {
    return { chapters: [] };
  }
}

function writeIndex(index: Index): void {
  mkdirSync(ROOT, { recursive: true });
  const tmp = `${INDEX}.tmp`;
  writeFileSync(tmp, JSON.stringify(index));
  renameSync(tmp, INDEX);
  // Anything the index does not name goes: an evicted chapter, or a stray.
  const keep = new Set(index.chapters.map((e) => folderOf(e)));
  for (const name of readdirSync(ROOT)) {
    const full = join(ROOT, name);
    if (name === 'index.json' || name === 'index.json.tmp' || keep.has(full)) continue;
    rmSync(full, { recursive: true, force: true });
  }
}

/** The page list of a chapter kept on disk, or null. */
export function cachedPageList(seriesId: string, chapterId: string): string[] | null {
  const e = readIndex().chapters.find((c) => c.seriesId === seriesId && c.chapterId === chapterId);
  return e && e.pages.length > 0 ? e.pages : null;
}

/** A page's bytes from disk, or null. */
export function cachedPage(seriesId: string, path: string): { body: Buffer; type: string } | null {
  for (const e of readIndex().chapters) {
    if (e.seriesId !== seriesId || !(path in e.stored)) continue;
    const file = fileOf(e, path);
    if (file && existsSync(file)) return { body: readFileSync(file), type: e.stored[path] };
  }
  return null;
}

/**
 * Put a chapter at the front, keeping ten. Returns whether it still needs pages
 * fetched.
 *
 * `at` exists for read-ahead, and the ordering it buys is load-bearing. The ten
 * are evicted by when they were opened, and a chapter fetched *ahead* of you
 * was never opened at all — recorded with `Date.now()` it would sit in front of
 * the chapter you are reading, so the one in your hands would be thrown out
 * before three you have not looked at. Read-ahead passes a moment just behind
 * the current chapter instead, which puts them exactly where they belong: ahead
 * of your older history, behind what you are reading.
 */
export function rememberChapter(seriesId: string, chapterId: string, pages: string[], at = Date.now()): boolean {
  const index = readIndex();
  const had = index.chapters.find((c) => c.seriesId === seriesId && c.chapterId === chapterId);
  const entry: Entry = had ? { ...had, pages, at } : { seriesId, chapterId, pages, stored: {}, at };
  // Sorted rather than unshifted, because `at` is no longer always "now".
  index.chapters = [entry, ...index.chapters.filter((c) => c !== had)]
    .sort((a, b) => b.at - a.at)
    .slice(0, KEEP_CHAPTERS);
  writeIndex(index);
  return pages.some((p) => !(p in entry.stored));
}

/**
 * Where the nth chapter fetched ahead sits in the order.
 *
 * Named and exported so it can be asserted, because getting it wrong is silent:
 * the cache still works, it just evicts the chapter in your hands first.
 *
 * **`openedAt`, never `Date.now()`.** This is computed while the prefetch runs,
 * which is however long the current chapter took to download — so a value taken
 * now is *newer* than the chapter being read, not older. That was the bug.
 */
export function readAheadAt(openedAt: number, nth: number): number {
  return openedAt - 1 - nth;
}

/** Is this chapter in the ten, with every page already on disk? */
export function chapterIsComplete(seriesId: string, chapterId: string): boolean {
  const e = readIndex().chapters.find((c) => c.seriesId === seriesId && c.chapterId === chapterId);
  return Boolean(e && e.pages.length > 0 && e.pages.every((page) => page in e.stored));
}

/** Keep one page's bytes, if its chapter is still one of the ten. */
export function keepPage(seriesId: string, path: string, body: Buffer, type: string): void {
  const index = readIndex();
  const e = index.chapters.find((c) => c.seriesId === seriesId && c.pages.includes(path));
  const file = e ? fileOf(e, path) : null;
  if (!e || !file) return;
  mkdirSync(folderOf(e), { recursive: true });
  writeFileSync(file, body);
  e.stored[path] = type;
  writeIndex(index);
}

const filling = new Set<string>();

/**
 * Fetch the pages of a remembered chapter that are not on disk yet, one at a
 * time. Stops if the chapter is pushed out meanwhile.
 */
export async function fillChapter(baseUrl: string, seriesId: string, chapterId: string): Promise<void> {
  const key = `${seriesId}:${chapterId}`;
  if (filling.has(key)) return;
  filling.add(key);
  try {
    for (;;) {
      const e = readIndex().chapters.find((c) => c.seriesId === seriesId && c.chapterId === chapterId);
      const next = e?.pages.find((p) => !(p in e.stored));
      if (!e || !next) return;
      const response = await fetch(`${baseUrl}${next}`, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) return;
      keepPage(seriesId, next, Buffer.from(await response.arrayBuffer()), response.headers.get('content-type') ?? 'image/jpeg');
    }
  } catch {
    // The rest is fetched as the reader asks for it, and kept then.
  } finally {
    filling.delete(key);
  }
}
