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
  /**
   * How much detail the left and right edges have at full size: the average,
   * over `EDGE` stretches, of how much the pixels vary within a stretch. Line
   * art varies sharply; a smooth gradient, a flat tone or a black bleed hardly
   * at all (`TONE_DETAIL`). Absent in a reading from before it was read, which
   * counts as detailed, as everything did then.
   */
  leftDetail?: number;
  rightDetail?: number;
  /** The picture's size in pixels, for `apartPages`. Absent in a reading kept from before it was read. */
  width?: number;
  height?: number;
  /** Each row of the small copy, top to bottom: its mean brightness (0–255) and colour (0–1). For `stackedPages`. */
  rows?: { lum: number[]; colour: number[] };
}

/** How far a page's width or height may be from the chapter's own before it is not one of its pages. */
export const SIZE_TOLERANCE = 0.03;

/**
 * Which pages are not pages of the book: a scanlation group's notice, credits
 * or recruiting page, added at the start or the end of a chapter (2026-11-12).
 *
 * They are told by their size. A chapter's own pages come out of one scan at
 * exactly one size, and what a group adds is made separately: *MMO! Jiyuu ni
 * Game wo* chapter 1.2 is 25 pages of 1360×1920 between a 1500×2100 "WARNING"
 * notice and a 1419×1463 credits page, and *The Duke's Chef*, *The Best Noble
 * In Another World* and *Skill Lender's Retrieving* each have the same shape.
 * Paired as pages, the notice took the first page's place and every pair after
 * it was one page out, which is how it was reported.
 *
 * Only where most pages share one size (three in five and at least four
 * pages), so a chapter whose pages all differ sets nothing apart; and a page
 * whose size is not known yet is not set apart.
 */
/** The size most of a chapter's pages share, where most do (three in five and at least four pages). */
function commonSize(infos: ReadonlyArray<PageInfo | null>): [number, number] | null {
  const sizes = infos.map((p) => (p?.width && p?.height ? `${p.width}x${p.height}` : null));
  const counts = new Map<string, number>();
  for (const s of sizes) if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
  const known = sizes.filter(Boolean).length;
  let common: string | null = null;
  for (const [s, n] of counts) if (!common || n > (counts.get(common) ?? 0)) common = s;
  if (!common) return null;
  const most = counts.get(common) ?? 0;
  if (most < 4 || most < known * 0.6) return null;
  const [W, H] = common.split('x').map(Number);
  return [W, H];
}

/** An image at the start or end of a chapter this much taller than a page, at a page's width, may have a page in it (if that part looks like one: `PAGE_LIKE`). */
export const STACKED_TALLER = 1.05;

/**
 * Where a book page sits inside a taller image, with the group's notice or
 * credits stacked onto it in one picture (2026-11-12): the first image of
 * *MMO! Jiyuu ni Game wo* chapter 12.1 is 1363×4872, a notice above the
 * chapter's first page of 1363×1920, and its last 1363×3326, the last page
 * above the credits. So the first image of a chapter at the page width and
 * taller keeps its **bottom**, a page tall, and the last keeps its **top**.
 * Pages mode shows only that part and pairs it as the page it is; scroll mode
 * shows the whole image, as it always did. Null for every other page.
 *
 * **And only where that part looks like a page.** A tall image at the page
 * width can be the notice alone: chapters 2.1, 2.2 and 13.1 of the same series
 * open with an 800×1734 "WARNING" before pages of 800×1127, and cutting its
 * bottom out made half a notice "page 1", paired with the real first page.
 * The part kept is compared with the chapter's pages by brightness and colour
 * (`PAGE_LIKE`): measured over every such image in that series, a real page
 * part was 0.12 to 0.32 from its chapter's pages, a part of a notice 0.65.
 * An image whose rows were not read is cut by its size alone, as before.
 */
export function stackedPages(infos: ReadonlyArray<PageInfo | null>): Array<{ keep: 'top' | 'bottom'; share: number } | null> {
  const out: Array<{ keep: 'top' | 'bottom'; share: number } | null> = infos.map(() => null);
  const size = commonSize(infos);
  if (!size || infos.length < 3) return out;
  const [W, H] = size;
  const typical = typicalLook(infos, W, H);
  const stacked = (p: PageInfo | null, keep: 'top' | 'bottom'): number | null => {
    if (!p?.width || !p?.height || Math.abs(p.width - W) / W > SIZE_TOLERANCE || p.height <= H * STACKED_TALLER) return null;
    const share = (H * p.width) / W / p.height;
    const rows = p.rows;
    if (typical && rows && rows.lum.length > 0) {
      const n = Math.max(1, Math.round(rows.lum.length * share));
      const part = (xs: number[]) => (keep === 'top' ? xs.slice(0, n) : xs.slice(xs.length - n));
      const lum = average(part(rows.lum));
      const colour = average(part(rows.colour));
      if (Math.abs(lum - typical.lum) / 255 + 2 * Math.abs(colour - typical.colour) > PAGE_LIKE) return null;
    }
    return share;
  };
  /*
   * The first of the book's images, past up to two of the group's own pages of
   * another size: *The Duke's Chef* chapter 28 opens with a 1500×2100
   * "WARNING", then page 2 with a slim "read at en-thunderscans.com" banner
   * stacked on top (1127×1835 against pages of 1127×1600, 14.7% taller), and
   * only the very first image was looked at, and only one 15% taller: pages 2
   * and 3 were left on their own (2026-11-12). A page-sized image ends the
   * search: the book has begun. The same from the end for the last.
   */
  const pageSized = (p: PageInfo | null) =>
    !!p?.width && !!p?.height && Math.abs(p.width - W) / W <= SIZE_TOLERANCE && Math.abs(p.height - H) / H <= SIZE_TOLERANCE;
  const find = (order: number[], keep: 'top' | 'bottom') => {
    for (const i of order) {
      const share = stacked(infos[i], keep);
      if (share !== null) {
        out[i] = { keep, share };
        return;
      }
      if (!infos[i] || pageSized(infos[i])) return;
    }
  };
  const n = infos.length;
  find([0, 1, 2].filter((i) => i < n), 'bottom');
  find([n - 1, n - 2, n - 3].filter((i) => i >= 0 && !out[i]), 'top');
  return out;
}

/** How far (brightness over 255, plus twice the colour) a stacked image's page part may be from the chapter's pages. */
export const PAGE_LIKE = 0.45;

const average = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** The brightness and colour of a chapter's own pages (those at its common size), by the median; null with none read. */
function typicalLook(infos: ReadonlyArray<PageInfo | null>, W: number, H: number): { lum: number; colour: number } | null {
  const pages = infos.filter((p): p is PageInfo & { rows: { lum: number[]; colour: number[] } } => !!p?.rows && p.rows.lum.length > 0 && p.width === W && p.height === H);
  if (pages.length === 0) return null;
  return { lum: median(pages.map((p) => average(p.rows.lum))), colour: median(pages.map((p) => average(p.rows.colour))) };
}

/**
 * The reading pages mode pairs by: a stacked image (`stackedPages`) as the
 * page inside it, its shape a page's and its edges only that part's. Every
 * other page as read.
 */
export function asBookPages(infos: ReadonlyArray<PageInfo | null>): Array<PageInfo | null> {
  const stacked = stackedPages(infos);
  return infos.map((p, i) => {
    const st = stacked[i];
    if (!p || !st) return p;
    const n = Math.max(1, Math.round(p.left.length * st.share));
    const part = (edge: number[]) => (st.keep === 'top' ? edge.slice(0, n) : edge.slice(edge.length - n));
    return { ...p, aspect: p.aspect / st.share, height: Math.round((p.height ?? 0) * st.share), left: part(p.left), right: part(p.right) };
  });
}

/**
 * Which pages are not pages of the book: a scanlation group's notice, credits
 * or recruiting page, added at the start or the end of a chapter (2026-11-12).
 *
 * They are told by their size. A chapter's own pages come out of one scan at
 * exactly one size, and what a group adds is made separately: *MMO! Jiyuu ni
 * Game wo* chapter 1.2 is 25 pages of 1360×1920 between a 1500×2100 "WARNING"
 * notice and a 1419×1463 credits page, and *The Duke's Chef*, *The Best Noble
 * In Another World* and *Skill Lender's Retrieving* each have the same shape.
 * Paired as pages, the notice took the first page's place and every pair after
 * it was one page out, which is how it was reported.
 *
 * Only where most pages share one size (three in five and at least four
 * pages), so a chapter whose pages all differ sets nothing apart; a page
 * whose size is not known yet is not set apart; and nor is an image with a
 * page stacked in it (`stackedPages`), which is that page.
 */
export function apartPages(infos: ReadonlyArray<PageInfo | null>): boolean[] {
  const size = commonSize(infos);
  if (!size) return infos.map(() => false);
  const [W, H] = size;
  const stacked = stackedPages(infos);
  return infos.map((p, i) => {
    if (!p?.width || !p?.height || stacked[i]) return false;
    return Math.abs(p.width - W) / W > SIZE_TOLERANCE || Math.abs(p.height - H) / H > SIZE_TOLERANCE;
  });
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
 * sheet, so the next page starts a sheet too. A page in `apart` (not one of
 * the book's, see `apartPages`) is alone the same way, and `firstAlone` is
 * then about the first page that is not.
 *
 * With `twoUp` off every page is its own sheet: a phone held upright.
 */
export function pairPages(
  aspects: ReadonlyArray<number | null>,
  firstAlone: boolean,
  twoUp: boolean,
  apart: ReadonlyArray<boolean> = []
): number[][] {
  const sheets: number[][] = [];
  if (!twoUp) {
    for (let i = 0; i < aspects.length; i++) sheets.push([i]);
    return sheets;
  }
  // Alone: a spread, or a page that is not one of the book's (`apartPages`).
  const single = (j: number) => isWide(aspects[j]) || apart[j] === true;
  let i = 0;
  // Pages set apart before the first of the book's own are alone, and `firstAlone` is about that first one.
  while (i < aspects.length && single(i)) {
    sheets.push([i]);
    i += 1;
  }
  if (firstAlone && i < aspects.length) {
    sheets.push([i]);
    i += 1;
  }
  while (i < aspects.length) {
    if (single(i) || i === aspects.length - 1 || single(i + 1)) {
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
/**
 * Whether an edge carries a picture rather than paper: a quarter of it darker
 * than paper (2026-11-12). An edge of plain margin crossed by a few panel
 * borders has shape enough to pass the spread test, and two such edges match
 * by being white in the same places, which is no picture across a gutter at
 * all: *MMO!* chapter 13.1 was paired one page out on exactly that.
 */
export const SEAM_INK = 0.25;
/** The share of an edge darker than paper. */
const inkShare = (edge: number[]) => edge.filter((x) => x < 200).length / Math.max(1, edge.length);
const inked = (edge: number[]) => inkShare(edge) >= SEAM_INK;

/**
 * Below this, an edge is tone, not drawing: a smooth gradient run to the edge
 * of the page, a flat tone, a black bleed (2026-11-12, asked for as "page wide
 * gradients that go to the margin" not being taken for a clue). Measured over
 * 155 inked side edges in six chapters of five series: scanlators' dark credit
 * pages, black bleeds and flat colour backgrounds 0 to 2.0; drawn edges 2.7 and
 * up, median 21.7, including edges whose averaged values move as slowly as a
 * gradient's (a page of large panels). A smooth gradient is about 1 to 2, the
 * scan's own noise. Screentone, being dots, is detail, and counts as drawing.
 */
export const TONE_DETAIL = 2.5;
/** An edge with a picture down it: inked, and drawn rather than a gradient or flat tone. */
const drawn = (edge: number[], detail: number | undefined) => inkShare(edge) >= 0.15 && (detail ?? Infinity) >= TONE_DETAIL;

export function seamJoined(a: number[], b: number[], detailA?: number, detailB?: number): boolean | null {
  if (a.length === 0 || a.length !== b.length) return null;
  // A plain edge has no shape down it: a margin, or a black bleed.
  if (spread(a) < 14 || spread(b) < 14) return null;
  if (!inked(a) || !inked(b)) return null;
  // A gradient or a flat tone at either edge is not a picture carried across: two pages fading to the same grey match without being one picture.
  if ((detailA ?? Infinity) < TONE_DETAIL || (detailB ?? Infinity) < TONE_DETAIL) return null;
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
/**
 * Each seam between neighbouring pages: true where a picture is drawn across
 * it, false where the two edges are drawn and do not match, null where it
 * cannot say. Right to left, page i's left edge against i+1's right edge.
 */
export function seams(infos: ReadonlyArray<PageInfo | null>, rightToLeft: boolean): Array<boolean | null> {
  const apart = apartPages(infos);
  const pages = asBookPages(infos);
  const joined: Array<boolean | null> = [];
  for (let i = 0; i + 1 < pages.length; i++) {
    const a = pages[i];
    const b = pages[i + 1];
    if (!a || !b || isWide(a.aspect) || isWide(b.aspect) || apart[i] || apart[i + 1]) {
      joined.push(null);
      continue;
    }
    joined.push(
      rightToLeft ? seamJoined(a.left, b.right, a.leftDetail, b.rightDetail) : seamJoined(a.right, b.left, a.rightDetail, b.leftDetail)
    );
  }
  return joined;
}

/**
 * The pairing the pictures drawn across gutters say, alone: null where none
 * is, or they split evenly. What a series learns its margin side from by
 * itself (`learnMargins`), since a picture across the fold is the surest clue
 * there is to which pages face each other.
 */
export function seamsDecide(infos: ReadonlyArray<PageInfo | null>, rightToLeft: boolean): boolean | null {
  const joined = seams(infos, rightToLeft);
  if (!joined.some((j) => j === true)) return null;
  const apart = apartPages(infos);
  const aspects = asBookPages(infos).map((p) => p?.aspect ?? null);
  const score = (firstAlone: boolean) => {
    const together = new Set(
      pairPages(aspects, firstAlone, true, apart)
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
  return alone === paired ? null : alone > paired;
}

/**
 * The side a series keeps its plain margins on when nobody has said: the
 * **inner**, at the fold (2026-11-12, asked for as "look for the white fold").
 * It is the printed convention, the art kept out of the binding and run off
 * the outside edges, and every picture drawn across a gutter in the library
 * agreed (*MMO!* 11.2, *The Duke's Chef* 27 and 28). *Tsuihousareru* keeps
 * them outside and is set so; a series that does is taught by **Move along
 * one**, or by its first spread.
 */
export const DEFAULT_MARGINS: MarginSide = 'inner';

export function chooseFirstAlone(
  infos: ReadonlyArray<PageInfo | null>,
  rightToLeft: boolean,
  margins: MarginSide | null = null
): boolean | null {
  // A picture drawn across a gutter first: it says which pages face each other outright.
  const bySeams = seamsDecide(infos, rightToLeft);
  if (bySeams !== null) return bySeams;
  // Then the margins, on the side the series keeps them, or the fold's where nobody has said.
  const { alone, paired } = marginScores(infos, rightToLeft, margins ?? DEFAULT_MARGINS);
  if (Math.abs(alone - paired) < MARGIN_DECIDES) return null;
  return alone > paired;
}

/**
 * Which edge of a page this series' scans keep plain paper on: the **inner**
 * one, at the spine, or the **outer** one. A page with paper down one side
 * and the picture running off the other says which side of the book it was
 * on, once that is known (2026-11-12).
 *
 * Asked about because *MMO! Jiyuu ni Game wo* chapter 12.1 pairs 2 and 3, 12
 * and 13, and nothing else says so: no picture crosses a gutter, and its
 * notice is stacked onto the first page. Its plain margins are on the inner
 * edge (pages 3, 5, 7 and 11 plain on the right and 4 and 6 on the left, read
 * right to left). But *Tsuihousareru Tabi ni* chapter 30.1, the same group,
 * keeps them on the **outer** edge, where its printed page numbers are (7 at
 * the outer edge of image 9, 8 of image 10, which face each other): it
 * depends on the raws, not the scanlators. So the side is per series, set
 * once (on the PC, `Series.pageMargins`), learned from **Move along one**
 * (`learnMargins`), and unknown means margins decide nothing. Measured, the
 * margins are about 8% of the page wide in both.
 */
export type MarginSide = 'inner' | 'outer';

/** How much more margin evidence one pairing needs than the other to decide it. */
export const MARGIN_DECIDES = 3;

/** +1 for a page with paper down its left edge and a picture down its right, −1 the other way round, else 0. */
export function marginLean(page: PageInfo | null): -1 | 0 | 1 {
  if (!page) return 0;
  // By how much of the edge is inked (`inkShare`), not by its spread: a margin flecked by the scan or crossed by a panel border has spread and no picture.
  const paper = (e: number[]) => e.length > 0 && mean(e) > 200 && inkShare(e) <= 0.1;
  // And drawn, not a gradient or flat tone run to the edge (`TONE_DETAIL`), which says nothing about where the fold was.
  if (paper(page.left) && page.right.length > 0 && drawn(page.right, page.rightDetail)) return 1;
  if (paper(page.right) && page.left.length > 0 && drawn(page.left, page.leftDetail)) return -1;
  return 0;
}

/**
 * How well each way of pairing agrees with the margins, if this series keeps
 * them on `side`: a point for every page whose plain edge lands where the
 * series keeps it, one against for every page whose plain edge does not.
 */
export function marginScores(
  infos: ReadonlyArray<PageInfo | null>,
  rightToLeft: boolean,
  side: MarginSide
): { alone: number; paired: number } {
  const apart = apartPages(infos);
  const pages = asBookPages(infos);
  const aspects = pages.map((p) => p?.aspect ?? null);
  // The two halves of a picture drawn across the fold are drawn at it by design, so their margins say nothing; the picture itself is the clue (`seamsDecide`).
  const joined = seams(infos, rightToLeft);
  const spread = (i: number) => joined[i - 1] === true || joined[i] === true;
  const leans = pages.map((p, i) => (apart[i] || spread(i) ? 0 : marginLean(p)));
  const score = (firstAlone: boolean) => {
    let points = 0;
    for (const sheet of pairPages(aspects, firstAlone, true, apart)) {
      if (sheet.length !== 2) continue;
      // Which page is on the right of the sheet: the first, reading right to left.
      const [onRight, onLeft] = rightToLeft ? sheet : [sheet[1], sheet[0]];
      // On the right, the inner edge is the page's left: paper there is +1.
      const inner = (leans[onRight] ?? 0) - (leans[onLeft] ?? 0);
      points += side === 'inner' ? inner : -inner;
    }
    return points;
  };
  return { alone: score(true), paired: score(false) };
}

/**
 * Which side the margins must be on for this chapter to pair as somebody just
 * said it does (`firstAlone`, after **Move along one**): null when the
 * margins do not say clearly either way, so a press on a chapter with no plain
 * edges teaches nothing.
 */
export function learnMargins(infos: ReadonlyArray<PageInfo | null>, rightToLeft: boolean, firstAlone: boolean): MarginSide | null {
  const { alone, paired } = marginScores(infos, rightToLeft, 'inner');
  if (Math.abs(alone - paired) < MARGIN_DECIDES) return null;
  return alone > paired === firstAlone ? 'inner' : 'outer';
}

/** A tag as written by any source, folded so "Long Strip", "long-strip" and "LongStrip" are one. */
const fold = (tag: string) => tag.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * What a series is made for, from its tags, when they settle it before any
 * picture is looked at: a source that says so is more sure than a guess from
 * six pages.
 *
 * **Long Strip** or **Webtoon** (MangaDex's format tags) is a strip whatever
 * else it says, since a Japanese series published as a webtoon is still a
 * strip; and **Manhwa** or **Manhua** is a strip, which nearly every Korean
 * and Chinese series on these sources is, unless it says Manga too. Nothing
 * else settles it: see `leanFromTags` for Manga, and Full Color is a colour
 * manga as often as a webtoon. Null leaves it to the pictures.
 */
export function formatFromTags(tags: ReadonlyArray<string> | null | undefined): 'scroll' | null {
  const has = new Set((tags ?? []).map(fold));
  if (has.has('longstrip') || has.has('webtoon') || has.has('webtoons')) return 'scroll';
  if (has.has('manga')) return null;
  if (has.has('manhwa') || has.has('manhua') || has.has('manwha')) return 'scroll';
  return null;
}

/**
 * Which way the tags lean, where they do not settle it: **Manga** or
 * **4-Koma** leans to pages. A lean opens the chapter that way and the
 * pictures are still asked, and they win (2026-11-12).
 *
 * Manga settled it until *Houfuku no Ansatsu Ningyou* opened as pages: MangaFire
 * gives the type Manga to nearly every Japanese series, including ones drawn
 * as a webtoon. That one is 106 page-shaped colour slices a chapter, and every
 * cut between them that is not blank paper differs by 3.6 to 9.8 of 255
 * (`cutsCarryOn`), which is a strip.
 */
export function leanFromTags(tags: ReadonlyArray<string> | null | undefined): 'pages' | null {
  const has = new Set((tags ?? []).map(fold));
  if (formatFromTags(tags)) return null;
  return has.has('manga') || has.has('4koma') ? 'pages' : null;
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
