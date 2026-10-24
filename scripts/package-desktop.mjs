/**
 * Build the desktop client's zip: `dist/release/BlueEverything-Desktop-<version>.zip`.
 *
 *   node scripts/package-desktop.mjs
 *
 * The desktop client is the agent on its own, for a PC that does not run the
 * server: the tray icon, the popup above games, noticing a match end, and
 * voice, signed in to a Blue Everything somewhere else (`scripts/desktop.ps1`).
 * It is a second download beside the full app's zip, so the app can link to it
 * whenever something needs more of the PC than a browser can reach.
 *
 * What is in it, and nothing else:
 *
 *   - the agent (`packages/agent`) and the code it shares (`packages/shared`);
 *   - the agent halves of the packages that have one (voice, integrations),
 *     which the agent finds at `packages/modules/<id>/agent` as it always has;
 *   - the app's own Node (`runtime/node`) and only the libraries the agent
 *     uses, found by following their package.json files from the agent's;
 *   - the launcher, at the top: `Blue Everything Desktop.cmd`.
 *
 * No server, no PWA, no database: those are the full app's. Because there is
 * no `packages/server`, the agent knows it is the desktop client (`desktopOnly`
 * in `tray.ts`) and its tray menu goes through desktop.ps1.
 *
 * Run after `node-runtime.ps1` has filled runtime/node, as the release
 * workflow does for the full zip.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : null;
if (tag && tag.replace(/^v/, '') !== version) {
  console.error(`tag ${tag} does not match package.json ${version} — bump every version before tagging`);
  process.exit(1);
}
const node = join(root, 'runtime/node/node.exe');
if (!existsSync(node)) {
  console.error('runtime/node is missing — run scripts/node-runtime.ps1 first');
  process.exit(1);
}

// Not `Blue-Everything-*`: an older update.ps1 takes the first zip with that name.
const name = `BlueEverything-Desktop-${version}`;
const out = join(root, 'dist/release');
const stage = join(out, name);
rmSync(stage, { recursive: true, force: true });
rmSync(join(out, `${name}.zip`), { force: true });
mkdirSync(stage, { recursive: true });

/* ---- the app's own files: what git tracks, under these paths ---- */

const wanted = [
  'packages/agent/',
  'packages/shared/',
  'packages/modules/voice/agent/',
  'packages/modules/voice/package.json',
  'packages/modules/integrations/agent/',
  'packages/modules/integrations/package.json',
  'assets/everything.ico',
  'scripts/desktop.ps1',
  'scripts/app-id.ps1',
  'scripts/node-runtime.ps1',
  'scripts/name-node.mjs',
  'LICENSE',
];
/*
 * Tracked files, and new ones not committed yet that are not ignored. Tracked
 * alone was the first version, and a local build before a commit then left a
 * new file out: the desktop client's zip had no agent closing.ts, and stopped
 * as it started. In CI everything is committed, so there it is the same list.
 */
const tracked = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter((file) => file && existsSync(join(root, file)))
  .filter((file) => wanted.some((w) => (w.endsWith('/') ? file.startsWith(w) : file === w)));

for (const file of tracked) {
  const to = join(stage, file);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(join(root, file), to);
}
cpSync(join(root, 'scripts', 'Blue Everything Desktop.cmd'), join(stage, 'Blue Everything Desktop.cmd'));
// Its own name in the repo, beside the full app's Create Desktop Icon.cmd; the zip has only this one.
cpSync(join(root, 'scripts', 'Create Desktop Icon (desktop app).cmd'), join(stage, 'Create Desktop Icon.cmd'));

// The workspace's own manifest, cut to what a folder of it needs: the version.
writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify({ name: 'blue-everything-desktop', private: true, version, type: 'module', license: 'MIT' }, null, 2) + '\n'
);

writeFileSync(
  join(stage, 'START HERE.txt'),
  [
    `Blue Everything Desktop ${version}`,
    '',
    'For a Windows PC that does not run Blue Everything itself: your copy is on',
    'somebody else\'s PC, or this is your second PC. It adds what a web browser',
    'cannot do: an icon in the tray, popups above games, noticing when a match',
    'ends, and voice. The app itself opens in its own window as before.',
    '',
    '1. Unzip this folder anywhere (Windows 10 or 11, 64-bit).',
    '2. Double-click "Blue Everything Desktop.cmd". "Create Desktop Icon.cmd" puts',
    '   an icon for it on the Desktop and in the Start Menu.',
    '3. In the app (on your phone, say), open Settings, then Devices, then',
    '   Sign in another device. Type the address and the code it shows.',
    '',
    'It is optional: the app works in a browser and on a phone without it. It',
    'runs in the background (an icon in the tray) only while you want popups',
    'over games and voice; tick "Start when I sign in to Windows" to keep it on.',
    'To sign in again: right-click the tray icon, Stop, then run',
    'scripts\\desktop.ps1 -SignIn, or delete packages\\agent\\agent.config.json.',
    '',
  ].join('\r\n')
);

/* ---- Node, without the named copies (see package-release.mjs) ---- */

cpSync(join(root, 'runtime/node'), join(stage, 'runtime/node'), {
  recursive: true,
  filter: (src) => !basename(src).startsWith('Blue Everything'),
});

/* ---- the libraries the agent uses, and theirs ---- */

const manifestOf = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
const depsOf = (manifest) =>
  Object.keys({ ...(manifest.dependencies ?? {}), ...(manifest.optionalDependencies ?? {}) });

/** Where Node would find `dep` from `fromDir`: up the folders, as it resolves. */
function resolveDep(dep, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', dep);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dir === root || dirname(dir) === dir) return null;
  }
}

const copied = new Set();
function bring(dep, fromDir) {
  if (dep.startsWith('@everything/')) return; // the app's own: a junction desktop.ps1 makes
  const dir = resolveDep(dep, fromDir);
  if (!dir) return; // an optional dependency for another platform
  if (copied.has(dir)) return;
  copied.add(dir);
  for (const next of depsOf(manifestOf(dir))) bring(next, dir);
}

const starts = [
  ...depsOf(manifestOf(join(root, 'packages/agent'))),
  // Run with `--import tsx`, so a dependency at runtime whatever package.json calls it.
  'tsx',
  ...depsOf(manifestOf(join(root, 'packages/shared'))),
];
for (const dep of starts) bring(dep, join(root, 'packages/agent'));

for (const dir of copied) {
  // A nested one comes with the folder it is nested in.
  const rel = relative(join(root, 'node_modules'), dir);
  if (rel.split(/[\\/]/).includes('node_modules')) continue;
  cpSync(dir, join(stage, 'node_modules', rel), {
    recursive: true,
    filter: (src) => !lstatSync(src).isSymbolicLink(),
  });
}

/* ---- every relative import has its file, or no zip ---- */

/*
 * A missing file is an agent that stops as it starts, on somebody else's PC,
 * with a stack trace in a message box. So before zipping, every `./x.js`
 * import in the staged code must have its `.ts`, `.js` or `.mjs` beside it.
 */
const missing = [];
const walkStage = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry === 'runtime') return [];
    return statSync(full).isDirectory() ? walkStage(full) : [full];
  });
for (const file of walkStage(join(stage, 'packages'))) {
  if (!/\.(ts|mjs|js)$/.test(file)) continue;
  // Comments mention old paths; only code counts.
  const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const match of text.matchAll(/(?:from|import\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const target = join(dirname(file), match[1]);
    const candidates = [target, target.replace(/\.js$/, '.ts'), target.replace(/\.js$/, '.mjs')];
    if (!candidates.some((c) => existsSync(c))) missing.push(`${relative(stage, file)} imports ${match[1]}`);
  }
}
if (missing.length > 0) {
  console.error(`the desktop zip would be missing files:\n  ${missing.join('\n  ')}`);
  rmSync(stage, { recursive: true, force: true });
  process.exit(1);
}

/* ---- zipped the way package-release.mjs zips ---- */

const zip = join(out, `${name}.zip`);
execFileSync(
  'powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts/zip-folder.ps1'), '-Folder', stage, '-Zip', zip],
  { stdio: 'inherit' }
);
rmSync(stage, { recursive: true, force: true });

const size = (statSync(zip).size / 1024 / 1024).toFixed(1);
console.log(`${relative(root, zip)} — ${tracked.length} app files, ${copied.size} libraries, ${size} MB`);
