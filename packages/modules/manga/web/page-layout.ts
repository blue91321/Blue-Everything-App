/**
 * Pages mode's rules: which pages sit side by side, whether two fit, and what
 * kind of chapter this is. No imports, so `manga-check` asserts it directly,
 * like `chapter-nav.ts`.
 *
 * Everything here works from a small reading of each page (`PageInfo`, made by
 * `page-analysis.ts`): its shape, how much colour it has, and the brightness
 * down each of its four edges. Nothing here knows about the DOM.
 */

/** What one page looks like, from a copy about a hundred pixels tall. */
export interface PageInfo {
  /** Width over height. A manga page is about 0.7; a webtoon slice is far narrower. */
  aspect: number;
  /** 0–1, how coloured the page is on average. A black-and-white scan is near 0. */
  colour: number;
  /**
   * Brightness (0–255) of the outermost line of pixels down the left and right
   * edges, top to bottom, resampled to `EDGE`. The page's own outermost line at
   * full size, not the edge of a small copy: a copy 96px tall makes each "row"
   * a band 15 to 150 pixels deep, and bands either side of a cut through one
   * picture do not match where the lines either side of it do.
   */
  left: number[];
  right: number[];
  /** And of the top and bottom lines, left to right. */
  top: number[];
  bottom: number[];
}

/** How many samples each edge is resampled to, so two edges can be compared. */
export const EDGE = 48;

/** A page wider than it is tall is a spread already, and is shown alone. */
export const isWide = (aspect: number | null | undefined): boolean => typeof aspect === 'number' && aspect > 1;

/**
 * Which pages go on each sheet, in reading order.
 *
 * `firstAlone` puts the first page on a sheet of its own, as a book's cover
 * is, and pairs from the second. Off by default: a chapter's first page is
 * nearly always a right-hand page that faces the second (printed pages 7 and 8
 * of *Tsuihousareru Tabi ni* chapter 30.1 are its images 9 and 10, and putting
 * the first image alone split them). A wide page is always alone (it is a spread
 * already), and the page after it starts a new pair, which is what keeps the
 * pairs right after one: in the printed book a spread takes both sides of a
 * sheet, so the next page starts a sheet too.
 *
 * With `twoUp` off every page is its own sheet: a phone held upright.
 */
export function pairPages(aspects: ReadonlyArray<number | null>, firstAlone: boolean, twoUp: boolean): number[][] {
  const sheets: number[][] = [];
  if (!twoUp) {
    for (let i = 0; i < aspects.length; i++) sheets.push([i]);
    return sheets;
  }
  let i = 0;
  if (firstAlone && aspects.length > 0) {
    sheets.push([0]);
    i = 1;
  }
  while (i < aspects.length) {
    if (isWide(aspects[i]) || i === aspects.length - 1 || isWide(aspects[i + 1])) {
      sheets.push([i]);
      i += 1;
    } else {
      sheets.push([i, i + 1]);
      i += 2;
    }
  }
  return sheets;
}

/**
 * Whether two pages fit side by side: two pages at seven tenths of the
 * screen's height or more. A phone held sideways and a desktop window do, half
 * of a wide monitor included; a phone or a tablet held upright does not.
 *
 * It was nine tenths, which asked for two nearly full-height pages, and a
 * window on half of a 3440×1440 monitor (about 1720×1390) then showed one: two
 * full-height pages there need 1950px. Pages a little shorter than the screen
 * are what every reader shows a spread as.
 */
export const fitsTwo = (width: number, height: number, pageAspect: number): boolean =>
  width > 0 && height > 0 && width >= height * pageAspect * 2 * 0.7;

/** The typical page shape, from what has been read: the middle one, portrait pages only. 0.7 before anything is known. */
export function typicalAspect(aspects: ReadonlyArray<number | null>): number {
  const portrait = aspects.filter((a): a is number => typeof a === 'number' && a > 0.3 && a <= 1).sort((a, b) => a - b);
  return portrait.length ? portrait[Math.floor(portrait.length / 2)] : 0.7;
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
const spread = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

/**
 * Whether two edges that would touch are one picture carried across.
 *
 * True when both edges have something drawn on them (not a plain margin, white
 * or black) and match closely; false when both have something drawn and do
 * not; null when either is a plain margin, which says nothing, since nearly
 * every page has one.
 */
export function seamJoined(a: number[], b: number[]): boolean | null {
  if (a.length === 0 || a.length !== b.length) return null;
  // A plain edge has no shape down it: a margin, or a black bleed.
  if (spread(a) < 14 || spread(b) < 14) return null;
  const diff = mean(a.map((x, i) => Math.abs(x - b[i])));
  if (diff < 22) return true;
  if (diff > 45) return false;
  return null;
}

/**
 * Whether the first page should be alone, judged by where pictures carry
 * across from one page to the next.
 *
 * A two-page spread scanned as two images is drawn across the gutter, so the
 * inner edges of its halves match. Each way of pairing is scored: a joined seam
 * kept on one sheet is a point for it, a joined seam split across two sheets a
 * point against. Null when nothing decides it (no seam has a picture across
 * it), and the reader keeps its default, pairing from the first page.
 *
 * Right to left, page i is the right-hand page and i+1 the left, so the seam
 * is i's left edge against i+1's right edge; left to right, the other way.
 */
export function chooseFirstAlone(infos: ReadonlyArray<PageInfo | null>, rightToLeft: boolean): boolean | null {
  const aspects = infos.map((p) => p?.aspect ?? null);
  const joined: Array<boolean | null> = [];
  for (let i = 0; i + 1 < infos.length; i++) {
    const a = infos[i];
    const b = infos[i + 1];
    if (!a || !b || isWide(a.aspect) || isWide(b.aspect)) {
      joined.push(null);
      continue;
    }
    joined.push(rightToLeft ? seamJoined(a.left, b.right) : seamJoined(a.right, b.left));
  }
  if (!joined.some((j) => j === true)) return null;
  const score = (firstAlone: boolean) => {
    const together = new Set(
      pairPages(aspects, firstAlone, true)
        .filter((s) => s.length === 2)
        .map((s) => s[0])
    );
    let points = 0;
    joined.forEach((j, i) => {
      if (j === true) points += together.has(i) ? 1 : -1;
    });
    return points;
  };
  const alone = score(true);
  const paired = score(false);
  if (alone === paired) return null;
  return alone > paired;
}

/** A tag as written by any source, folded so "Long Strip", "long-strip" and "LongStrip" are one. */
const fold = (tag: string) => tag.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * What a series is made for, from its tags, before any picture is looked at:
 * a source that says so is more sure than a guess from six pages.
 *
 * In this order, because tags can disagree: **Long Strip** or **Webtoon**
 * (MangaDex's format tags) is a strip whatever else it says, since a Japanese
 * series published as a webtoon is still a strip; then **Manga** (the type
 * MangaFire and others give) or **4-Koma** is a book; then **Manhwa** or
 * **Manhua** is a strip, which nearly every Korean and Chinese series on these
 * sources is. Nothing else decides (Full Color is a colour manga as often as a
 * webtoon), and null leaves it to the pictures.
 */
export function formatFromTags(tags: ReadonlyArray<string> | null | undefined): 'scroll' | 'pages' | null {
  const has = new Set((tags ?? []).map(fold));
  if (has.has('longstrip') || has.has('webtoon') || has.has('webtoons')) return 'scroll';
  if (has.has('manga') || has.has('4koma')) return 'pages';
  if (has.has('manhwa') || has.has('manhua') || has.has('manwha')) return 'scroll';
  return null;
}

/** An edge that is only paper: near-white and flat. A page's own margin, so it says nothing about a cut. */
const blankPaper = (edge: number[]) => mean(edge) > 215 && spread(edge) < 14;

/**
 * Whether the cuts between images look like cuts through one picture: at a
 * cut that is not white paper on both sides, the bottom of one image and the
 * top of the next are nearly the same, most of the time.
 *
 * A strip cut into slices carries on across the cut: the same background, the
 * same colour of gutter, half a panel on either side, so the pixels either side
 * nearly match, plain or not. A printed page ends in its own margin, and the
 * next begins in its own; where the art bleeds to the edge, the two pages are
 * different drawings. White paper meeting white paper is left out, since that
 * is a printed margin as often as a white gutter in a strip.
 *
 * Measured on the first seven images of five chapters here, as the average
 * difference (of 255) across each cut: Eleceed 0, 0, 11 and Paladin Dad 2 to 5
 * at every cut; three manga 5 to 244, the closest of them *Maken Tsukai* with
 * one cut in four under 13. Hence under 13, at three cuts in four or more.
 */
export function cutsCarryOn(infos: ReadonlyArray<PageInfo>): boolean {
  let counted = 0;
  let close = 0;
  for (let i = 0; i + 1 < infos.length; i++) {
    const a = infos[i].bottom;
    const b = infos[i + 1].top;
    if (a.length === 0 || a.length !== b.length) continue;
    if (blankPaper(a) && blankPaper(b)) continue;
    counted++;
    if (mean(a.map((x, j) => Math.abs(x - b[j]))) < 13) close++;
  }
  return counted >= 2 && close / counted >= 0.75;
}

/**
 * What a chapter is made for, from its first few pages: `scroll` for a
 * webtoon, `pages` for a printed manga, null when it is not clear (and the
 * reader is left as it is). Asked only when the tags said nothing
 * (`formatFromTags`).
 *
 * - **Tall slices** are a strip, whatever else is true.
 * - **Cuts the picture carries on across** (`cutsCarryOn`): a strip cut at
 *   page-sized intervals, which some sources do.
 * - **Page-shaped and black and white** is a manga printed as pages. Colour
 *   alone does not decide it the other way, since a manga's first pages are
 *   often in colour: page-shaped and coloured says nothing.
 */
export function contentKind(infos: ReadonlyArray<PageInfo>): 'scroll' | 'pages' | null {
  if (infos.length < 3) return null;
  const tall = infos.filter((p) => p.aspect < 0.45).length;
  if (tall * 2 > infos.length) return 'scroll';
  if (cutsCarryOn(infos)) return 'scroll';
  const pageShaped = infos.filter((p) => p.aspect >= 0.5 && p.aspect <= 0.9).length;
  const grey = infos.filter((p) => p.colour < 0.08).length;
  if (pageShaped * 3 >= infos.length * 2 && grey * 2 > infos.length) return 'pages';
  return null;
}

/** Brightness samples resampled to `EDGE`, so edges of different lengths compare. */
export function resample(values: ArrayLike<number>, n = EDGE): number[] {
  const out: number[] = [];
  if (values.length === 0) return out;
  for (let i = 0; i < n; i++) out.push(values[Math.min(values.length - 1, Math.floor(((i + 0.5) * values.length) / n))]);
  return out;
}
