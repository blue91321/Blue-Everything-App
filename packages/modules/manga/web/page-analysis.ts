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
import { useEffect, useRef, useState } from 'react';
import { EDGE, resample, type PageInfo } from './page-layout';

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

export async function analysePage(url: string): Promise<PageInfo | null> {
  try {
    const blob = await (await fetch(url)).blob();
    let bitmap: ImageBitmap;
    try {
      // Only the height is given, so the width keeps the page's shape.
      bitmap = await createImageBitmap(blob, { resizeHeight: HEIGHT, resizeQuality: 'low' });
    } catch {
      bitmap = await createImageBitmap(blob);
    }
    const aspect = bitmap.width / Math.max(1, bitmap.height);
    const h = HEIGHT;
    const w = Math.max(2, Math.min(256, Math.round(h * aspect)));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      bitmap.close();
      return null;
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    // The small copy is for the colour; the edges are read at full size below.
    const { data } = ctx.getImageData(0, 0, w, h);
    let colour = 0;
    for (let o = 0; o < data.length; o += 4) {
      const hi = Math.max(data[o], data[o + 1], data[o + 2]);
      const lo = Math.min(data[o], data[o + 1], data[o + 2]);
      colour += (hi - lo) / 255;
    }
    colour /= w * h;
    // The four outermost lines at full size, where a cut or a gutter actually is.
    const [W, H] = await sizeOf(url);
    return {
      aspect: W / Math.max(1, H),
      colour,
      left: await line(blob, 0, 0, 1, H),
      right: await line(blob, W - 1, 0, 1, H),
      top: await line(blob, 0, 0, W, 1),
      bottom: await line(blob, 0, H - 1, W, 1),
    };
  } catch {
    return null;
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
  const [, redraw] = useState(0);
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
    for (let i = 0; i < limit; i++) {
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

  return urls.map((url) => (url ? (done.current.get(url) ?? null) : null));
}
