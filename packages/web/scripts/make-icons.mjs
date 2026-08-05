/**
 * Generates the PWA icons.
 *
 * Written as a tiny PNG encoder rather than pulling in an image library: the
 * icons are two rounded rectangles on a background, and a build dependency that
 * ships native binaries is a poor trade for that.
 *
 * The mark is a pause glyph — the app's whole idea is holding something back
 * until the moment is right.
 *
 *   npm run icons -w @everything/web
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public');

const BACKGROUND = [0x14, 0x16, 0x1c];
const ACCENT = [0xff, 0xb4, 0x54];

/* ---------- minimal PNG writer ---------- */

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10-12 stay zero: deflate, adaptive filtering, no interlace.

  // Each scanline is prefixed with its filter type; 0 (None) keeps this simple
  // and these images compress well regardless.
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- the drawing ---------- */

const insideRoundedRect = (x, y, left, top, width, height, radius) => {
  const right = left + width;
  const bottom = top + height;
  if (x < left || x > right || y < top || y > bottom) return false;

  // Only the corner regions need the distance check.
  const cx = x < left + radius ? left + radius : x > right - radius ? right - radius : x;
  const cy = y < top + radius ? top + radius : y > bottom - radius ? bottom - radius : y;
  if (cx === x && cy === y) return true;
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
};

/** 3x3 supersampling, so the curves don't come out jagged at small sizes. */
const SAMPLES = 3;

function drawIcon(size, { fullBleed = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);

  const bgRadius = fullBleed ? 0 : size * 0.22;
  const barWidth = size * 0.115;
  const barHeight = size * 0.4;
  const gap = size * 0.105;
  const barRadius = barWidth / 2;
  const barTop = (size - barHeight) / 2;
  const leftBarX = size / 2 - gap / 2 - barWidth;
  const rightBarX = size / 2 + gap / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0;
      let barHits = 0;

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const px = x + (sx + 0.5) / SAMPLES;
          const py = y + (sy + 0.5) / SAMPLES;

          if (insideRoundedRect(px, py, 0, 0, size, size, bgRadius)) bgHits++;
          if (
            insideRoundedRect(px, py, leftBarX, barTop, barWidth, barHeight, barRadius) ||
            insideRoundedRect(px, py, rightBarX, barTop, barWidth, barHeight, barRadius)
          ) {
            barHits++;
          }
        }
      }

      const total = SAMPLES * SAMPLES;
      const bgAlpha = bgHits / total;
      const barAlpha = barHits / total;
      const offset = (y * size + x) * 4;

      // Bars over background, background over transparency.
      for (let c = 0; c < 3; c++) {
        rgba[offset + c] = Math.round(BACKGROUND[c] * (1 - barAlpha) + ACCENT[c] * barAlpha);
      }
      rgba[offset + 3] = Math.round(255 * Math.max(bgAlpha, barAlpha));
    }
  }

  return encodePng(size, size, rgba);
}

/**
 * Wrap PNGs in an .ico container for the Windows shortcut.
 *
 * Vista and later accept PNG-compressed entries directly, so this is a header
 * and an index rather than any actual bitmap encoding. Multiple sizes matter
 * because Windows picks different ones for the taskbar, Alt-Tab, and the
 * desktop, and letting it downscale a single large image looks muddy.
 */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach(({ size, png }, index) => {
    const entry = directory.subarray(index * 16);
    // 0 means 256 in this format — a single byte can't hold 256.
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette size
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
  });

  return Buffer.concat([header, directory, ...images.map((i) => i.png)]);
}

mkdirSync(outDir, { recursive: true });

const icons = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  // iOS applies its own corner mask and drops transparency, so this one is
  // drawn square and full-bleed to avoid a rounded shape inside a rounded mask.
  ['apple-touch-icon.png', 180, { fullBleed: true }],
];

for (const [name, size, options] of icons) {
  const png = drawIcon(size, options);
  writeFileSync(resolve(outDir, name), png);
  console.log(`  ${name.padEnd(22)} ${size}x${size}  ${(png.length / 1024).toFixed(1)} KB`);
}

// The desktop shortcut's icon. Lives outside the web build because it belongs
// to Windows, not to the page.
const assetsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../assets');
mkdirSync(assetsDir, { recursive: true });

const ico = encodeIco([16, 32, 48, 256].map((size) => ({ size, png: drawIcon(size) })));
writeFileSync(resolve(assetsDir, 'everything.ico'), ico);
console.log(`  ${'everything.ico'.padEnd(22)} 16/32/48/256  ${(ico.length / 1024).toFixed(1)} KB`);
