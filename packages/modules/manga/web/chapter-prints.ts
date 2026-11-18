/**
 * What each chapter read on this device looked like, to notice one chapter
 * showing another's pages (2026-11-18).
 *
 * A chapter's "print" is the size in bytes of each page as it came (a page made
 * smaller on the way is left out, being a size the connection chose rather
 * than the picture's). Two chapters of one series with the same print are the
 * same pictures (`sameChapterTwice`), which is what S-Class Hunter's 59 and 60
 * were: Suwayomi had renumbered its list and kept page addresses named the
 * chapter beside them (`server/page-path.ts`). The server fixes its own copies;
 * this catches what reached the device, including saved chapters, which are
 * kept by URL and so could hold another chapter's pages too.
 *
 * Per device in `localStorage`, the last 400 chapters, and nothing is sent
 * anywhere. `fixed` marks a chapter fetched again for this already, so the
 * reader does that once by itself and then asks.
 */
import { sameChapterTwice } from './duplicate-pages';

const KEY = 'manga.reader.prints';
const KEEP = 400;

type Print = { s: string; c: string; n: number; sizes: number[]; at: number; fixed?: number };

function load(): Print[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(parsed) ? (parsed as Print[]).filter((p) => p && typeof p.s === 'string' && Array.isArray(p.sizes)) : [];
  } catch {
    return [];
  }
}

function save(prints: Print[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prints.sort((a, b) => b.at - a.at).slice(0, KEEP)));
  } catch {
    // Full or refused: the check simply knows less.
  }
}

/**
 * Note a chapter's pages, and say which other chapter of the series read here
 * had the same ones, if any. Fewer than three pages known is not noted.
 */
export function notePrint(seriesId: string, chapterId: string, number: number, sizes: number[]): { chapterId: string; number: number } | null {
  if (sizes.filter((n) => n > 0).length < 3) return null;
  const prints = load();
  const had = prints.find((p) => p.s === seriesId && p.c === chapterId);
  const mine: Print = { s: seriesId, c: chapterId, n: number, sizes, at: Date.now(), ...(had?.fixed ? { fixed: had.fixed } : {}) };
  const rest = prints.filter((p) => p !== had);
  save([mine, ...rest]);
  for (const other of rest) {
    // Another entry for the same number is another edition of it, which may well be the same pictures.
    if (other.s !== seriesId || other.n === number) continue;
    if (sameChapterTwice([{ id: 'a', sizes }, { id: 'b', sizes: other.sizes }]).size > 0) return { chapterId: other.c, number: other.n };
  }
  return null;
}

/**
 * Marked in memory too, for this visit: where storage is refused (a private
 * window, a full disk) the mark would never stick, and the reader would fetch
 * the chapter again by itself for ever. Found by exactly that loop, from the
 * mark being lost another way, the first time this was tried.
 */
const fixedNow = new Set<string>();

/** Whether this chapter was already fetched again for having another's pages. */
export function wasFixed(seriesId: string, chapterId: string): boolean {
  return fixedNow.has(`${seriesId}/${chapterId}`) || Boolean(load().find((p) => p.s === seriesId && p.c === chapterId)?.fixed);
}

/** Mark it fetched again, so the reader does that by itself only once. */
export function markFixed(seriesId: string, chapterId: string): void {
  fixedNow.add(`${seriesId}/${chapterId}`);
  const prints = load();
  const had = prints.find((p) => p.s === seriesId && p.c === chapterId);
  if (had) had.fixed = Date.now();
  save(prints);
}

/** Forget a chapter's print, when it is fetched again by hand: what it looked like was what was wrong. */
export function forgetPrint(seriesId: string, chapterId: string): void {
  save(load().filter((p) => !(p.s === seriesId && p.c === chapterId)));
}
