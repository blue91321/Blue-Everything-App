/**
 * Which chapter is next, which was three answers in three files.
 *
 * `beside` lived in `Chapters.tsx`, `SeriesDetail.tsx` and `offline.tsx` as
 * three identical copies, and the skip below would have been a fourth, fifth
 * and sixth. One definition, because "what is next" is one question however
 * many screens can open a reader.
 */

/** Anything with a chapter number — the three screens each carry a different row shape. */
type Numbered = { number: number };

/**
 * The chapter next to `n` by number, one way or the other.
 *
 * By number rather than by list position, so a source listing two editions of
 * chapter 50 does not stop the arrow at the second copy of where you already
 * are. Duplicates of `n` itself are therefore skipped for free.
 */
export function beside<T extends Numbered>(list: readonly T[], n: number, direction: -1 | 1): T | undefined {
  return list
    .filter((c) => (direction === 1 ? c.number > n : c.number < n))
    .sort((a, b) => (a.number - b.number) * direction)[0];
}

/** Whole-numbered, so 2.1 and 2.5 are point chapters and 2 and 3 are not. */
const isWhole = (n: number) => Number.isInteger(n);

/**
 * The next whole-numbered chapter, when that is not simply the next chapter.
 *
 * After chapter 2 a source may list 2.1, 2.2 and then 3, and **nothing here can
 * know what those are.** Sometimes 2 is a compilation that already contains
 * them and the point chapters are the same pages split up; sometimes they are
 * side stories, or a later correction, and genuinely come next. The numbering
 * carries no signal either way, and guessing would be wrong about half the
 * libraries it met.
 *
 * So this is not a rule about which to show — it is the *second* destination,
 * offered beside the first. The arrow still goes to 2.1, because that is what
 * "next" means when nobody has said otherwise; this is how you say otherwise.
 *
 * Returns nothing when there is nothing to skip: when the next chapter already
 * is the next whole one (the ordinary case, 2 then 3), or when there is no
 * whole chapter ahead at all. A control that appeared on every chapter and did
 * the same thing as the arrow beside it would be a control nobody could learn.
 */
export function skipTarget<T extends Numbered>(list: readonly T[], n: number): T | undefined {
  const next = beside(list, n, 1);
  if (!next) return undefined;
  // Already going somewhere whole: the arrow is the only answer there is.
  if (isWhole(next.number)) return undefined;
  const whole = list
    .filter((c) => c.number > n && isWhole(c.number))
    .sort((a, b) => a.number - b.number)[0];
  return whole;
}

/**
 * The chapter numbers passed over by a skip, nearest first.
 *
 * Distinct numbers, because a source listing 2.1 twice should be one chapter
 * marked read rather than the same request sent twice — the same reason the
 * chapter list collapses duplicate numbers to one row.
 */
export function skippedBetween<T extends Numbered>(list: readonly T[], from: number, to: number): number[] {
  return [...new Set(list.filter((c) => c.number > from && c.number < to).map((c) => c.number))].sort(
    (a, b) => a - b
  );
}

/**
 * Whether you have reached the end of a chapter, so that Next finishes it.
 *
 * This was the page counter's answer — "is the counter on the last page" — and
 * that was the wrong question, which cost roughly one chapter in three when
 * reading several in a row. The counter names the page crossing a line 8px
 * from the **top** of the screen, so the last page only counts once the page
 * before it has scrolled entirely off the top. On a phone you read the last
 * page while the end of the one above is still showing, tap Next, and it was
 * taken as skipping: nothing marked, nothing sent. The server's log showed it
 * plainly — chapter 3 opened with no "chapter 2 read" before it, at 5:07 on a
 * Saturday, after five minutes in chapter 2.
 *
 * So it is asked of the **bottom** of the screen, which is where your eyes
 * are by the end of a chapter, in two ways — either is enough:
 *
 *   - the last page has come a fifth of the way up the screen, which is to say
 *     every page before it has been scrolled past; or
 *   - what is left below the screen is under a tenth of the chapter *and*
 *     under two and a half screens of it, which covers the chapter whose last
 *     page or two are credits and somebody's Discord — the pages people do
 *     not scroll through.
 *
 * Both halves of the second rule are needed. A tenth alone was the first
 * version, and on a chapter cut into 127 short strips a tenth is eleven
 * screens: it called the chapter finished well before the story was. Measured
 * in the browser at phone size, which is how it was caught.
 *
 * Asked only once every page has loaded. A strip of placeholders is short, and
 * nine tenths of a short strip is on screen the moment a chapter opens.
 *
 * No imports, so `manga-check` asserts it directly.
 */
export function reachedTheEnd(g: {
  viewportHeight: number;
  stripTop: number;
  stripHeight: number;
  lastPageTop: number;
  allLoaded: boolean;
}): boolean {
  if (!g.allLoaded || g.stripHeight <= 0) return false;
  if (g.lastPageTop <= g.viewportHeight * 0.8) return true;
  const left = g.stripTop + g.stripHeight - g.viewportHeight;
  return left <= g.stripHeight * 0.1 && left <= g.viewportHeight * 2.5;
}
