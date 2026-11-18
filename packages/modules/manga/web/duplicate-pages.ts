/**
 * Two chapters of one series holding the same pictures.
 *
 * What a kept address gone stale looks like from the outside (`page-path.ts`):
 * a chapter fetched by the address of the chapter beside it has that chapter's
 * pages, byte for byte. So kept copies are compared, and two chapters whose
 * pages are the same sizes to the byte, page for page, are the same pictures:
 * two different pictures the same size to the byte is not a thing that happens,
 * which `mendManifest` in `archive.ts` relies on too.
 *
 * Compared only where both chapters have a page at the same place, and only
 * with at least three such pages, so a chapter of one or two short pages (a
 * notice, an announcement) is never taken for another. The same number of pages
 * is required too. A size of -1 (or 0) is a page not kept yet.
 *
 * No imports, so `manga-check` asserts it directly.
 */
export const MIN_SAME_PAGES = 3;

export function sameChapterTwice(chapters: ReadonlyArray<{ id: string; sizes: readonly number[] }>): Set<string> {
  const twice = new Set<string>();
  for (let i = 0; i < chapters.length; i++) {
    for (let j = i + 1; j < chapters.length; j++) {
      const a = chapters[i]!;
      const b = chapters[j]!;
      if (a.id === b.id || a.sizes.length !== b.sizes.length) continue;
      let both = 0;
      let same = true;
      for (let k = 0; k < a.sizes.length; k++) {
        const x = a.sizes[k]!;
        const y = b.sizes[k]!;
        if (!(x > 0) || !(y > 0)) continue;
        both += 1;
        if (x !== y) {
          same = false;
          break;
        }
      }
      if (same && both >= MIN_SAME_PAGES) {
        twice.add(a.id);
        twice.add(b.id);
      }
    }
  }
  return twice;
}
