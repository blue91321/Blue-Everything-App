/**
 * Generates the icons that have to exist as files on disk.
 *
 *   npm run icons -w @everything/web
 *   node scripts/make-icons.mjs --accent green --shape triangle
 *
 * Most of the app's icons are no longer built here — the PWA manifest, the
 * favicon and the home-screen icon are rendered per request by the server, so
 * they follow the accent and shape settings. What is left is the handful that
 * genuinely cannot be: the Windows shortcut's `.ico`, which the shell reads
 * from a file, and the browser extension's toolbar icons, which are named in a
 * static manifest.
 *
 * Those are built from the defaults unless told otherwise. If Blake changes the
 * accent and wants the desktop icon to match, this script takes flags — that is
 * a deliberate manual step rather than something the server reaches out and
 * does, because writing into the repo and busting the Windows icon cache is a
 * lot of machinery for an icon most people see once.
 *
 * The drawing itself is imported from the server rather than reimplemented.
 * Node strips the types on the way in, so there is one definition of what a
 * triangle looks like instead of two that quietly disagree.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drawIcon } from '../../server/src/icon.ts';
import { ACCENT_COLORS, ACCENT_HEX, LOGO_SHAPES } from '../../shared/src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../public');

/* ---------- flags ---------- */

const flag = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};

const accent = flag('accent', 'blue');
const shape = flag('shape', 'pause');

if (!ACCENT_COLORS.includes(accent)) {
  console.error(`--accent must be one of: ${ACCENT_COLORS.join(', ')}`);
  process.exit(1);
}
if (!LOGO_SHAPES.includes(shape) || shape === 'image') {
  console.error(`--shape must be one of: ${LOGO_SHAPES.filter((s) => s !== 'image').join(', ')}`);
  process.exit(1);
}

/* ---------- the palette must not drift ---------- */

/*
 * `ACCENT_HEX` in shared and the `[data-accent=…]` rules in styles.css are the
 * same colours written twice, because the PWA deliberately does not import
 * shared and CSS cannot import TypeScript. Neither copy can be removed, so the
 * next best thing is refusing to build when they disagree — a logo that is a
 * slightly different blue from the app it belongs to is exactly the sort of
 * thing nobody notices for months.
 */
const css = readFileSync(resolve(here, '../src/styles.css'), 'utf8');
const drift = [];

for (const name of ACCENT_COLORS) {
  // The first (dark-theme) declaration for this accent; the light overrides are
  // qualified with [data-theme='light'] and are a separate set of values.
  const match = css.match(new RegExp(`(?<!light'\\]\\)?)\\[data-accent='${name}'\\]\\s*\\{[^}]*--accent:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) {
    drift.push(`${name}: no [data-accent='${name}'] rule in styles.css`);
  } else if (match[1].toLowerCase() !== ACCENT_HEX[name].toLowerCase()) {
    drift.push(`${name}: styles.css says ${match[1]}, shared says ${ACCENT_HEX[name]}`);
  }
}

if (drift.length > 0) {
  console.error('\nThe accent palette has drifted between styles.css and shared:\n');
  for (const line of drift) console.error(`  ! ${line}`);
  console.error('\nMake them agree before building.\n');
  process.exit(1);
}

/* ---------- .ico container ---------- */

/**
 * Wrap PNGs in an .ico for the Windows shortcut.
 *
 * Vista and later accept PNG-compressed entries directly, so this is a header
 * and an index rather than any actual bitmap encoding. Multiple sizes matter
 * because Windows picks different ones for the taskbar, Alt-Tab and the
 * desktop, and letting it downscale one large image looks muddy.
 */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;

  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    // 256 is stored as 0 — the field is a single byte.
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

/* ---------- write them ---------- */

const draw = (size, options = {}) => drawIcon(size, { shape, accent, ...options });

console.log(`\n  mark: ${shape} in ${accent} (${ACCENT_HEX[accent]})\n`);

mkdirSync(outDir, { recursive: true });

/*
 * Kept as files even though the server renders these too: they are the
 * fallback if someone opens `dist/` without a server, and `index.html`
 * references one before any JavaScript has run.
 */
for (const [name, size, options] of [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  // iOS applies its own corner mask and drops transparency, so this one is
  // drawn square and full-bleed to avoid a rounded shape inside a rounded mask.
  ['apple-touch-icon.png', 180, { fullBleed: true }],
]) {
  const png = draw(size, options);
  writeFileSync(resolve(outDir, name), png);
  console.log(`  ${name.padEnd(22)} ${size}x${size}  ${(png.length / 1024).toFixed(1)} KB`);
}

// The desktop shortcut's icon. Lives outside the web build because it belongs
// to Windows, not to the page.
const assetsDir = resolve(here, '../../../assets');
mkdirSync(assetsDir, { recursive: true });

const ico = encodeIco([16, 32, 48, 256].map((size) => ({ size, png: draw(size) })));
writeFileSync(resolve(assetsDir, 'everything.ico'), ico);
console.log(`  ${'everything.ico'.padEnd(22)} 16/32/48/256  ${(ico.length / 1024).toFixed(1)} KB`);

// The browser extension's toolbar icon, from the same mark.
const extensionIcons = resolve(here, '../../extension/icons');
mkdirSync(extensionIcons, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(resolve(extensionIcons, `icon-${size}.png`), draw(size));
}
console.log(`  ${'extension icons'.padEnd(22)} 16/32/48/128\n`);
