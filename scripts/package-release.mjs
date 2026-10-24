/**
 * Build the release zip: `dist/release/Blue-Everything-<version>.zip`.
 *
 *   node scripts/package-release.mjs
 *
 * Run by `.github/workflows/release.yml` on every `v*` tag, and runnable here.
 *
 * What is in it: every file git tracks, plus the built PWA
 * (`packages/web/dist`, which is gitignored), plus `release-files.txt` — the list
 * of every file the release contains. That list is what lets `update.ps1`
 * update an unzipped install safely: a file the old list names and the new one
 * does not is deleted, and a file neither names is never touched. So your
 * database, your installed packages and your voice models survive an update by
 * construction, not by a list of exceptions somebody has to keep current.
 *
 * What is not: node_modules. `Blue Everything.cmd` installs them on first run,
 * for the machine it runs on — native modules are built per platform, and a
 * zip carrying this runner's would be a guess about somebody else's.
 *
 * **Two configurations** (`--config`): `everything` (the default) and
 * `just-manga`, which leaves out every package but manga and push (push sends
 * new-chapter notifications), and the libraries only voice uses. Each zip says
 * which it is in `configuration.json`, which `update.ps1` reads so an install
 * only ever updates from its own kind: a Just Manga install never downloads
 * voice, the vault or the rest. Named so neither, nor the desktop client's, is
 * matched by the `Blue-Everything-*.zip` an older updater looks for, except
 * the Everything zip it was always looking for.
 *
 * Refuses when the tag and `package.json` disagree, because a release called
 * 0.4.1 that reports 0.4.0 on its Settings screen is the failure the Versions
 * section of CLAUDE.md describes.
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

const dist = join(root, 'packages/web/dist/index.html');
if (!existsSync(dist)) {
  console.error('packages/web/dist is missing — run `npm run build -w @everything/web` first');
  process.exit(1);
}

const configIndex = process.argv.indexOf('--config');
const configName = configIndex >= 0 ? process.argv[configIndex + 1] : 'everything';
if (configName !== 'everything' && configName !== 'just-manga') {
  console.error(`--config is everything or just-manga, not ${configName}`);
  process.exit(1);
}
/** What Just Manga leaves out: every shipped package but these. */
const JUST_MANGA_KEEPS = new Set(['manga', 'push']);
/** And the libraries only a left-out package uses (voice's speech engine). */
const JUST_MANGA_DROPS = [/^sherpa-onnx/];

const name = configName === 'just-manga' ? `BlueEverything-JustManga-${version}` : `Blue-Everything-${version}`;
const out = join(root, 'dist/release');
const stage = join(out, name);
// Only this zip's own: the workflow builds several into one folder.
rmSync(stage, { recursive: true, force: true });
rmSync(join(out, `${name}.zip`), { force: true });
mkdirSync(stage, { recursive: true });

/*
 * Tracked files, and new ones not committed yet that are not ignored. Tracked
 * alone was the first version, and a local build before a commit then left a
 * new file out: the desktop client's zip had no agent closing.ts, and stopped
 * as it started. In CI everything is committed, so there it is the same list.
 */
const tracked = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  // A tracked file deleted in the working tree is not in the release.
  .filter((file) => existsSync(join(root, file)))
  .filter((file) => {
    if (configName !== 'just-manga') return true;
    const module = /^packages\/modules\/([^/]+)\//.exec(file);
    return !module || JUST_MANGA_KEEPS.has(module[1]);
  });

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
const built = walk(join(root, 'packages/web/dist')).map((full) => relative(root, full).replaceAll('\\', '/'));

// Which download it is, for update.ps1 and the server's first-run defaults.
writeFileSync(join(stage, 'configuration.json'), JSON.stringify({ configuration: configName }, null, 2) + '\n');

const files = [...new Set([...tracked, ...built, 'configuration.json'])].sort();
for (const file of files.filter((f) => f !== 'configuration.json')) {
  const to = join(stage, file);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(join(root, file), to);
}
/*
 * `--bundle`: Node.js and every dependency, so the zip runs with nothing
 * installed and nothing downloaded — the first other PC failed at "install
 * Node". Both are swapped whole by `update.ps1` rather than listed in
 * release-files.txt. npm's links to the app's own packages are left out: a zip
 * cannot hold a link, and `start.ps1` makes them offline on the first run.
 */
if (process.argv.includes('--bundle')) {
  const node = join(root, 'runtime/node/node.exe');
  if (!existsSync(node)) {
    console.error('runtime/node is missing — run scripts/node-runtime.ps1 first');
    process.exit(1);
  }
  /*
   * Without the named copies. They are hard links to node.exe beside it, so
   * they cost nothing on disk — but a zip cannot hold a link, and each would go
   * in as another whole Node. `node-runtime.ps1` makes them on the first run
   * against whatever node.exe is actually there, which is also what keeps them
   * from going stale across a Node upgrade.
   */
  cpSync(join(root, 'runtime/node'), join(stage, 'runtime/node'), {
    recursive: true,
    filter: (src) => !basename(src).startsWith('Blue Everything'),
  });
  cpSync(join(root, 'node_modules'), join(stage, 'node_modules'), {
    recursive: true,
    filter: (src) => {
      const path = src.replaceAll('\\', '/');
      if (lstatSync(src).isSymbolicLink() || path.includes('/node_modules/@everything')) return false;
      if (configName === 'just-manga') {
        const top = /\/node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(path)?.[1];
        if (top && JUST_MANGA_DROPS.some((re) => re.test(top))) return false;
      }
      return true;
    },
  });
}

writeFileSync(join(stage, 'release-files.txt'), [...files, 'release-files.txt'].map((f) => f.replaceAll('/', '\\')).join('\r\n') + '\r\n');

/*
 * `zip-folder.ps1`, which writes each entry through .NET with forward slashes.
 * Three things were tried first and all failed: Git's GNU tar (first on PATH
 * with Git Bash) cannot write a zip and reads "C:" as a remote host; Windows'
 * bsdtar crashed outright (0xC0000005) on the tens of thousands of files
 * `--bundle` brings; and `ZipFile.CreateFromDirectory` in Windows PowerShell
 * names every entry with backslashes, which only Windows reads as folders.
 */
const zip = join(out, `${name}.zip`);
execFileSync(
  'powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts/zip-folder.ps1'), '-Folder', stage, '-Zip', zip],
  { stdio: 'inherit' }
);
rmSync(stage, { recursive: true, force: true });

const size = (statSync(zip).size / 1024 / 1024).toFixed(1);
console.log(`${relative(root, zip)} — ${files.length} files, ${size} MB`);
