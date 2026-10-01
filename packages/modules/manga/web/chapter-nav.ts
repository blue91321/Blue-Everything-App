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
