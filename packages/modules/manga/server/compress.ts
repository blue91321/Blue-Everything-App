/**
 * Smaller pictures, made on this PC: for reading over weak WiFi, for chapters
 * saved on a device, and for the Local collection (asked for 2026-11-11).
 *
 * Done here rather than in the browser because the point is mostly the
 * connection: a picture made smaller on the phone has already crossed it. So a
 * page route asked for `q=smaller` or `q=smallest` sends a re-encoded copy, and
 * the archive keeps one when its setting says so.
 *
 * **sharp** (libvips), the one image library worth its weight here: prebuilt
 * for Windows, macOS and Linux on x64 and arm64, Docker's included, so it keeps
 * the every-platform rule. It is imported on first use, and a sharp that will
 * not load leaves every page as it was (`available()` says so on screen).
 *
 * Measured on pages from this PC's cache (800px wide strips):
 *
 * | | a 600KB WebP | a 200KB JPEG |
 * | --- | --- | --- |
 * | smaller (≤1200px wide, WebP 80) | about 290KB | about the same |
 * | smallest (≤900px wide, WebP 60) | about 200KB | about 140KB |
 *
 * about 250ms each on this PC. **A copy that is not smaller is not sent**: an
 * already-small JPEG re-encoded can come out bigger, and the original then goes
 * as it was. WebP stops at 16383px on a side, so a taller strip is JPEG
 * (mozjpeg) instead; a GIF is left alone, since it may move.
 */
import type { Sharp } from 'sharp';

export type Quality = 'original' | 'smaller' | 'smallest';
export const QUALITIES: readonly Quality[] = ['original', 'smaller', 'smallest'];
export const isQuality = (v: unknown): v is Quality => typeof v === 'string' && (QUALITIES as readonly string[]).includes(v);
/** From a query string: anything not a smaller level is the original. */
export const qualityFrom = (v: unknown): Quality => (v === 'smaller' || v === 'smallest' ? v : 'original');

const LEVELS: Record<Exclude<Quality, 'original'>, { width: number; quality: number }> = {
  smaller: { width: 1200, quality: 80 },
  smallest: { width: 900, quality: 60 },
};
const WEBP_MAX = 16383;

type SharpFn = (input: Buffer, options?: { limitInputPixels?: number | false; animated?: boolean }) => Sharp;
let loading: Promise<SharpFn | null> | null = null;
function load(): Promise<SharpFn | null> {
  loading ??= import('sharp')
    .then((m) => {
      const sharp = (m.default ?? m) as unknown as SharpFn & { cache: (on: boolean) => void; concurrency: (n: number) => void };
      // libvips keeps no cache of its own (this file does, bounded), and uses
      // two threads a picture, so a page being made smaller mid-game is a
      // small thing rather than every core for a quarter of a second.
      sharp.cache(false);
      sharp.concurrency(2);
      return sharp as SharpFn;
    })
    .catch(() => null);
  return loading;
}

/** Whether pictures can be made smaller on this install. */
export async function available(): Promise<boolean> {
  return (await load()) !== null;
}

/** At most two at a time, so a chapter asked for at once does not take the PC. */
let running = 0;
const waiting: Array<() => void> = [];
async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= 2) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** A picture; `width` and `height` are the size it was shrunk from, where it was (sent as `x-original-size`). */
export type Picture = { body: Buffer; type: string; width?: number; height?: number };

/** A smaller copy of a picture, or the picture itself when that is not smaller or cannot be made. */
export async function compress(picture: Picture, level: Quality): Promise<Picture> {
  if (level === 'original' || /gif/i.test(picture.type)) return picture;
  const sharp = await load();
  if (!sharp) return picture;
  const { width, quality } = LEVELS[level];
  try {
    return await slot(async () => {
      const meta = await sharp(picture.body, { limitInputPixels: false }).metadata();
      if (!meta.width || !meta.height) return picture;
      const scale = Math.min(1, width / meta.width);
      const tall = Math.round(meta.height * scale) > WEBP_MAX;
      const resized = sharp(picture.body, { limitInputPixels: false }).resize({ width: Math.round(meta.width * scale), withoutEnlargement: true });
      const body = tall
        ? await resized.jpeg({ quality, mozjpeg: true }).toBuffer()
        : await resized.webp({ quality, effort: 4 }).toBuffer();
      if (body.length >= picture.body.length) return picture;
      return { body, type: tall ? 'image/jpeg' : 'image/webp', ...(scale < 1 ? { width: meta.width, height: meta.height } : {}) };
    });
  } catch {
    return picture;
  }
}

/*
 * Copies already made, for reading: a page is asked for again on a revisit, by
 * a second device, or by the reader after the background fetch, and making it
 * twice is a quarter of a second of the PC each time. Bounded by bytes (smaller
 * pictures are a few hundred KB, so this is a couple of chapters), and a copy
 * being made is shared by everyone asking for it.
 */
const MADE_BYTES = 48 * 1024 * 1024;
const made = new Map<string, Picture>();
let madeBytes = 0;
const making = new Map<string, Promise<Picture>>();

/** `compress`, remembered under `key` (the page's own path) for the level. */
/** The header saying what size a smaller copy was made from, for pages mode (`original-size.ts` in the reader). */
export const originalSizeHeader = (picture: Picture): Record<string, string> =>
  picture.width && picture.height ? { 'x-original-size': `${picture.width}x${picture.height}` } : {};

export function compressCached(key: string, picture: Picture, level: Quality): Promise<Picture> {
  if (level === 'original') return Promise.resolve(picture);
  const id = `${level}|${key}`;
  const have = made.get(id);
  if (have) {
    made.delete(id);
    made.set(id, have);
    return Promise.resolve(have);
  }
  const busy = making.get(id);
  if (busy) return busy;
  const work = compress(picture, level).then((out) => {
    made.set(id, out);
    madeBytes += out.body.length;
    for (const [k, v] of made) {
      if (madeBytes <= MADE_BYTES) break;
      made.delete(k);
      madeBytes -= v.body.length;
    }
    return out;
  });
  making.set(id, work);
  const forget = () => making.delete(id);
  work.then(forget, forget);
  return work;
}
