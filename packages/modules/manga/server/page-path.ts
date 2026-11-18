/**
 * A page's address at Suwayomi, as it is now.
 *
 * **Suwayomi names a chapter in a page's address by its place in the series'
 * list, not by its id.** `/api/v1/manga/12911/chapter/60/page/0` is "page 1 of
 * the chapter at position 60" (its `sourceOrder`), and that position moves when
 * a source posts a chapter late. Found on *S-Class Hunter Heals with Monsters*
 * (2026-11-18): Thunder Scans put up chapters 60 and 61, and chapter 59 half an
 * hour later. Suwayomi renumbered (59 took position 60, 60 moved to 61, 61 to
 * 62), and every address kept from before now named the chapter beside it:
 * 59 and 60 read the same pages.
 *
 * So an address is only ever an identifier of what was kept, and never trusted
 * to fetch with. Before anything is asked of Suwayomi by a kept address, the
 * chapter's position is asked afresh and the address rewritten to it. And a kept
 * page is found by its chapter as well as its address (`archivedPage`,
 * `cachedPage`), since two chapters can hold the same address.
 *
 * The position is remembered for a minute per chapter, so a chapter's pages
 * cost one small query, not one each.
 */
import { isTestMangaId } from './test-source.js';

const PAGE = /^\/api\/v1\/manga\/(\d+)\/chapter\/(\d+)\/page\/(\d+)$/;

const REMEMBER_MS = 60_000;
const known = new Map<string, { at: number; position: number | null }>();

/** The chapter's position in its series' list at Suwayomi now, or null when it will not say. */
export async function chapterPosition(baseUrl: string, chapterId: string): Promise<number | null> {
  const had = known.get(chapterId);
  if (had && Date.now() - had.at < REMEMBER_MS) return had.position;
  let position: number | null = null;
  try {
    const response = await fetch(`${baseUrl}/api/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'query Position($id: Int!) { chapter(id: $id) { sourceOrder } }',
        variables: { id: Number.parseInt(chapterId, 10) },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      const body = (await response.json()) as { data?: { chapter?: { sourceOrder?: unknown } } };
      const order = body.data?.chapter?.sourceOrder;
      if (typeof order === 'number' && Number.isSafeInteger(order)) position = order;
    }
  } catch {
    // Unknown: the address is used as it was kept, which is what happened before this.
  }
  known.set(chapterId, { at: Date.now(), position });
  return position;
}

/**
 * The address to fetch `path` by now, for the chapter it was kept for. The same
 * address when the chapter has not moved, when the chapter is not known, or for
 * the test series, whose addresses carry their chapter's id.
 */
export async function currentPagePath(baseUrl: string, chapterId: string | null | undefined, path: string): Promise<string> {
  const m = PAGE.exec(path);
  if (!m || !chapterId || !/^\d{1,12}$/.test(chapterId) || isTestMangaId(m[1])) return path;
  const position = await chapterPosition(baseUrl, chapterId);
  return movedPath(path, position);
}

/** `path` with its chapter position replaced, when a position is known and differs. No imports, for `manga-check`. */
export function movedPath(path: string, position: number | null): string {
  const m = PAGE.exec(path);
  if (!m || position === null || String(position) === m[2]) return path;
  return `/api/v1/manga/${m[1]}/chapter/${position}/page/${m[3]}`;
}

/** Forget what was asked: a chapter list was just fetched afresh, so positions may have moved. */
export function forgetPositions(): void {
  known.clear();
}
