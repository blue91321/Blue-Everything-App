/**
 * Drawing the app mark as a PNG, at request time.
 *
 * The icons used to be generated once at build time, which was fine while the
 * mark was a constant. Now that the shape and the colour are settings, a static
 * file would mean the home-screen icon and the browser tab kept showing a
 * choice you had already changed — so the same tiny renderer runs per
 * request instead. A 512px icon takes a few milliseconds and is then cached by
 * everything downstream, so this is not on any hot path.
 *
 * Still no image library. These are four flat shapes on a rounded background,
 * and a build dependency shipping native binaries is a poor trade for that —
 * the same reasoning that kept `make-icons.mjs` hand-rolled, now shared with it.
 */
import { deflateSync } from 'node:zlib';
import { ACCENT_HEX, ICON_BACKGROUND, type AccentColor, type LogoShape } from '@everything/shared';

/* ------------------------------------------------------------------ */
/* Minimal PNG writer                                                  */
/* ------------------------------------------------------------------ */

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // truecolour with alpha
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  // Each scanline is prefixed with its filter type; 0 means none, which costs a
  // little size and saves implementing five filters nobody would read again.
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

const insideRoundedRect = (
  x: number,
  y: number,
  left: number,
  top: number,
  width: number,
  height: number,
  radius: number
): boolean => {
  const right = left + width;
  const bottom = top + height;
  if (x < left || x > right || y < top || y > bottom) return false;

  // Only the corner regions need the distance check.
  const cx = x < left + radius ? left + radius : x > right - radius ? right - radius : x;
  const cy = y < top + radius ? top + radius : y > bottom - radius ? bottom - radius : y;
  if (cx === x && cy === y) return true;
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
};

/**
 * Is this point part of the mark?
 *
 * One predicate per shape rather than a path system: every mark here is convex
 * and describable in a line or two of arithmetic, and a general path rasteriser
 * would be several hundred lines to draw a triangle.
 *
 * All four are sized to occupy roughly the same visual area, so switching
 * between them does not make the icon appear to grow or shrink. A triangle
 * inscribed in the same box as a square looks much smaller, which is why its
 * height is scaled up rather than matched.
 */
function markHit(shape: Exclude<LogoShape, 'image'>, size: number, x: number, y: number): boolean {
  const mid = size / 2;

  if (shape === 'pause') {
    const barWidth = size * 0.115;
    const barHeight = size * 0.4;
    const gap = size * 0.105;
    const top = (size - barHeight) / 2;
    return (
      insideRoundedRect(x, y, mid - gap / 2 - barWidth, top, barWidth, barHeight, barWidth / 2) ||
      insideRoundedRect(x, y, mid + gap / 2, top, barWidth, barHeight, barWidth / 2)
    );
  }

  if (shape === 'circle') {
    const radius = size * 0.23;
    return (x - mid) ** 2 + (y - mid) ** 2 <= radius ** 2;
  }

  if (shape === 'square') {
    const side = size * 0.4;
    return insideRoundedRect(x, y, mid - side / 2, mid - side / 2, side, side, size * 0.06);
  }

  // Triangle, pointing up, centred on its own centroid rather than its bounding
  // box — a triangle centred by its box reads as sitting too low.
  const half = size * 0.24;
  const height = half * 1.9;
  const top = mid - height * 0.55;
  const bottom = top + height;
  if (y < top || y > bottom) return false;
  // Half-width grows linearly from the apex down to the base.
  const spread = ((y - top) / height) * half;
  return Math.abs(x - mid) <= spread;
}

const hexToRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/** 3x3 supersampling, so the curves don't come out jagged at small sizes. */
const SAMPLES = 3;

export interface IconOptions {
  shape: Exclude<LogoShape, 'image'>;
  accent: AccentColor;
  /** Square to the edges, for the maskable icon Android crops itself. */
  fullBleed?: boolean;
}

export function drawIcon(size: number, { shape, accent, fullBleed = false }: IconOptions): Buffer {
  const rgba = Buffer.alloc(size * size * 4);
  const background = hexToRgb(ICON_BACKGROUND);
  const foreground = hexToRgb(ACCENT_HEX[accent] ?? ACCENT_HEX.blue);
  const bgRadius = fullBleed ? 0 : size * 0.22;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0;
      let markHits = 0;

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const px = x + (sx + 0.5) / SAMPLES;
          const py = y + (sy + 0.5) / SAMPLES;
          if (insideRoundedRect(px, py, 0, 0, size, size, bgRadius)) bgHits++;
          if (markHit(shape, size, px, py)) markHits++;
        }
      }

      const total = SAMPLES * SAMPLES;
      const bgAlpha = bgHits / total;
      const markAlpha = markHits / total;
      const offset = (y * size + x) * 4;

      // Mark over background, background over transparency.
      for (let c = 0; c < 3; c++) {
        rgba[offset + c] = Math.round(background[c] * (1 - markAlpha) + foreground[c] * markAlpha);
      }
      rgba[offset + 3] = Math.round(255 * Math.max(bgAlpha, markAlpha));
    }
  }

  return encodePng(size, size, rgba);
}
