/**
 * Generates the icons that have to exist as files on disk.
 *
 *   npm run icons -w @everything/web
 *   node --import tsx scripts/make-icons.mjs --accent green --shape triangle
 *
 * Most of the app's icons are no longer built here — the PWA manifest, the
 * favicon and the home-screen icon are rendered per request by the server, so
 * they follow the accent and shape settings. What is left is the handful that
 * genuinely cannot be: the Windows shortcut's `.ico`, which the shell reads
 * from a file, and the browser extension's toolbar icons, which are named in a
 * static manifest.
 *
 * Those are built from the defaults unless told otherwise. If you change the
 * accent and wants the desktop icon to match, this script takes flags — that is
 * a deliberate manual step rather than something the server reaches out and
 * does, because writing into the repo and busting the Windows icon cache is a
 * lot of machinery for an icon most people see once.
 *
 * The drawing itself is imported from the server rather than reimplemented,
 * so there is one definition of what a triangle looks like instead of two that
 * quietly disagree. Run under `node --import tsx` (see `npm run icons`), which
 * resolves the server's and shared's TypeScript imports as the server does.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drawIcon, encodeIco } from '../../server/src/icon.ts';
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
/** A stylesheet with its `@import`s read in, as the build inlines them. */
const readCss = (file) =>
  readFileSync(file, 'utf8').replace(/@import\s+'([^']+)';/g, (_, part) => readCss(resolve(dirname(file), part)));
const css = readCss(resolve(here, '../src/styles.css'));
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

/*
 * Every `var(--x)` must name a property something actually declares.
 *
 * CSS has no error for this. An undefined custom property makes the whole
 * declaration invalid, so `background: var(--card)` is not a wrong colour — it
 * is *no background at all*, silently, with the page showing through. That is
 * how `--card` survived: nine rules used it, nothing defined it, and the
 * right-click menu had been transparent for as long as it had existed.
 *
 * A typo in a property name is the same class of mistake as the palette drift
 * above — invisible until somebody happens to look at the one screen where it
 * shows — so it is refused in the same place, at build time.
 */
/*
 * Packages carry their own stylesheets (`packages/modules/<id>/web/*.css`) and
 * use core's properties, so the check reads them all: a package naming a colour
 * nothing declares is the same silent hole.
 */
const modulesDir = resolve(here, '../../modules');
const stylesheets = [{ name: 'styles.css', text: css }];
for (const id of existsSync(modulesDir) ? readdirSync(modulesDir) : []) {
  const webDir = resolve(modulesDir, id, 'web');
  if (!existsSync(webDir)) continue;
  for (const file of readdirSync(webDir).filter((f) => f.endsWith('.css'))) {
    stylesheets.push({ name: `${id}/web/${file}`, text: readFileSync(resolve(webDir, file), 'utf8') });
  }
}

const declared = new Set(stylesheets.flatMap(({ text }) => [...text.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1])));
const undeclared = new Map();

for (const { name: sheet, text } of stylesheets) {
  for (const use of text.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*(,|\))/g)) {
    // A fallback — `var(--x, red)` — is a deliberate default rather than a typo,
    // and stays legal whether or not the property is ever declared.
    if (use[2] === ',') continue;
    if (declared.has(use[1])) continue;
    const key = `${use[1]} in ${sheet}`;
    undeclared.set(key, (undeclared.get(key) ?? 0) + 1);
  }
}

if (undeclared.size > 0) {
  console.error('\nThe stylesheets use custom properties that nothing declares:\n');
  for (const [name, count] of undeclared) {
    console.error(`  ! ${name} — used ${count} time${count === 1 ? '' : 's'}, never defined`);
  }
  console.error('\nEach one silently drops the whole declaration. Define it or fix the name.\n');
  process.exit(1);
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

// The browser extension's toolbar icon, from the same mark. The extension is
// part of the vault package, so a build with that package deleted has none.
// (It was written to `packages/extension`, where the extension lived before it
// moved, so that folder was updated and the real icons never were.)
const extensionIcons = resolve(here, '../../modules/vault/extension/icons');
if (existsSync(dirname(extensionIcons))) {
  mkdirSync(extensionIcons, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    writeFileSync(resolve(extensionIcons, `icon-${size}.png`), draw(size));
  }
  console.log(`  ${'extension icons'.padEnd(22)} 16/32/48/128\n`);
}
