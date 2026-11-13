/**
 * A small reading of each page, for pages mode and for telling a manga from a
 * webtoon — see `page-layout.ts`, which decides from it.
 *
 * Each page is decoded once at about 96 pixels tall (straight to that size
 * where the browser can, as the thumbnails are) for its colour, and its four
 * outermost lines of pixels are read at full size, for the edges. One page at a time, in order,
 * so it never competes with the pages you are reading for more than a moment;
 * a few kilobytes of numbers kept per page.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { EDGE, resample, type PageInfo } from './page-layout';
import { originalSizeOf } from './original-size';

const HEIGHT = 96;

/** A page's size, without decoding its pixels. */
function sizeOf(url: string): Promise<[number, number]> {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => ok([img.naturalWidth, img.naturalHeight]);
    img.onerror = fail;
    img.src = url;
  });
}

/**
 * One line of the page at full size (a row or a column), as `EDGE` brightness
 * samples along it — see `PageInfo.left` for why not the small copy's edge.
 */
async function line(blob: Blob, x: number, y: number, w: number, h: number): Promise<number[]> {
  const across = w > h;
  const bitmap = await createImageBitmap(blob, x, y, w, h, {
    resizeWidth: across ? EDGE : 1,
    resizeHeight: across ? 1 : EDGE,
    resizeQuality: 'medium',
  });
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const out: number[] = [];
  for (let o = 0; o < data.length; o += 4) out.push(0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]);
  return resample(out);
}

/** How deep a side edge is read, in pixels at full size. */
const SIDE_DEPTH = 4;

/**
 * A side edge (the left or the right) at full size, `SIDE_DEPTH` pixels deep,
 * as `EDGE` brightness samples, each the average of its stretch of the edge
 * (2026-11-12). `line` hands the browser the resizing, and a column one pixel
 * wide resized to 48 comes back as 48 single pixels: a white margin with a
 * panel border crossing it read as a picture, and two such margins "matched"
 * across a gutter. *MMO!* chapter 13.1 was paired one page out on that, and
 * its plain margins, flecked by the scan, did not read as paper. Averaged,
 * both read as what they are. These are read for the seams and the margins;
 * the top and bottom are left to `line`, which `cutsCarryOn` was measured on.
 */
async function sideEdge(blob: Blob, x: number, h: number): Promise<{ edge: number[]; detail: number }> {
  const bitmap = await createImageBitmap(blob, x, 0, SIDE_DEPTH, h);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const rows: number[] = [];
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let o = y * width * 4; o < (y + 1) * width * 4; o += 4) sum += 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    rows.push(sum / width);
  }
  // Each stretch's average, and how much it varies within (its detail: line art varies sharply, a gradient or flat tone hardly at all — `TONE_DETAIL`).
  let detail = 0;
  const edge = Array.from({ length: EDGE }, (_, k) => {
    const from = Math.floor((k * rows.length) / EDGE);
    const to = Math.max(from + 1, Math.floor(((k + 1) * rows.length) / EDGE));
    let sum = 0;
    let squares = 0;
    for (let i = from; i < to; i++) {
      const v = rows[i] ?? rows[rows.length - 1];
      sum += v;
      squares += v * v;
    }
    const m = sum / (to - from);
    detail += Math.sqrt(Math.max(0, squares / (to - from) - m * m));
    return m;
  });
  return { edge, detail: detail / EDGE };
}

export async function analysePage(url: string): Promise<PageInfo | null> {
  /*
   * The size first, and kept whatever else fails (2026-11-12). The rest
   * (colour, the edges at full size) leans on `createImageBitmap` with a crop
   * and a resize, which a browser may refuse; a page whose reading failed used
   * to have no size at all, and then nothing could tell a page with the
   * group's credits stacked onto it from a page. Reported from an iPhone: the
   * last page of a chapter drawn whole, credits and all, and the page beside
   * it shrunk to match.
   */
  let W: number;
  let H: number;
  try {
    [W, H] = await sizeOf(url);
  } catch {
    return null;
  }
  // The size it was shrunk from, where the PC sent a smaller copy (`original-size.ts`): pairing goes by the page's real size; its pixels are read as they came.
  const [OW, OH] = originalSizeOf(url) ?? [W, H];
  // Colour unknown (NaN) until read, so a page whose reading failed is not taken for black and white.
  const sized: PageInfo = { aspect: W / Math.max(1, H), colour: NaN, left: [], right: [], top: [], bottom: [], width: OW, height: OH };
  try {
    const blob = await (await fetch(url)).blob();
    let bitmap: ImageBitmap;
    try {
      // Only the height is given, so the width keeps the page's shape.
      bitmap = await createImageBitmap(blob, { resizeHeight: HEIGHT, resizeQuality: 'low' });
    } catch {
      bitmap = await createImageBitmap(blob);
    }
    const h = HEIGHT;
    const w = Math.max(2, Math.min(256, Math.round(h * sized.aspect)));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      bitmap.close();
      return sized;
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    // The small copy is for the colour; the edges are read at full size below.
    const { data } = ctx.getImageData(0, 0, w, h);
    // The colour, and each row's brightness and colour (for `stackedPages`, which asks whether part of an image looks like a page).
    let colour = 0;
    const rowLum: number[] = [];
    const rowColour: number[] = [];
    for (let y = 0; y < h; y++) {
      let l = 0;
      let c = 0;
      for (let o = y * w * 4; o < (y + 1) * w * 4; o += 4) {
        const hi = Math.max(data[o], data[o + 1], data[o + 2]);
        const lo = Math.min(data[o], data[o + 1], data[o + 2]);
        c += (hi - lo) / 255;
        l += 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
      }
      colour += c;
      rowLum.push(l / w);
      rowColour.push(c / w);
    }
    colour /= w * h;
    sized.colour = colour;
    sized.rows = { lum: rowLum, colour: rowColour };
    // The four outermost lines at full size, where a cut or a gutter actually is.
    try {
      const left = await sideEdge(blob, 0, H);
      const right = await sideEdge(blob, Math.max(0, W - SIDE_DEPTH), H);
      sized.left = left.edge;
      sized.leftDetail = left.detail;
      sized.right = right.edge;
      sized.rightDetail = right.detail;
      sized.top = await line(blob, 0, 0, W, 1);
      sized.bottom = await line(blob, 0, H - 1, W, 1);
    } catch {
      // No edges: the seams and margins say nothing about this page, and its size and colour still count.
      sized.left = sized.right = sized.top = sized.bottom = [];
    }
    return sized;
  } catch {
    return sized;
  }
}

/**
 * The reading of each page that has arrived, in page order, up to `upTo`
 * pages (the first few are enough to tell what a chapter is; pages mode wants
 * them all). Null where a page has not been read yet.
 */
export function usePageInfo(urls: (string | null)[], upTo: number): (PageInfo | null)[] {
  const done = useRef(new Map<string, PageInfo | null>());
  const working = useRef(false);
  const [read, redraw] = useState(0);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    []
  );

  useEffect(() => {
    if (working.current) return;
    const limit = Math.min(upTo, urls.length);
    let pick = -1;
    /*
     * With every page asked for (pages mode), the last first after the first:
     * a page with the group's credits stacked onto it (`stackedPages`) is the
     * first or the last, and reading the last at the end of the queue left the
     * chapter's end laid out wrong until then.
     */
    const order = limit === urls.length && limit > 2 ? [0, limit - 1, ...Array.from({ length: limit - 2 }, (_, i) => i + 1)] : Array.from({ length: limit }, (_, i) => i);
    for (const i of order) {
      const url = urls[i];
      if (url && !done.current.has(url)) {
        pick = i;
        break;
      }
    }
    if (pick < 0) return;
    const url = urls[pick]!;
    working.current = true;
    void analysePage(url).then((info) => {
      working.current = false;
      if (!alive.current) return;
      done.current.set(url, info);
      // Old chapters' readings go, so this stays a chapter or two of numbers.
      if (done.current.size > 600) done.current.delete(done.current.keys().next().value!);
      redraw((n) => n + 1);
    });
  });

  // The same array until a page is read or the pages change, so what is worked out from it can be kept (`useMemo` in the reader).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => urls.map((url) => (url ? (done.current.get(url) ?? null) : null)), [urls, read]);
}
