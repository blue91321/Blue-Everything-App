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
 * Refuses when the tag and `package.json` disagree, because a release called
 * 0.4.1 that reports 0.4.0 on its Settings screen is the failure the Versions
 * section of CLAUDE.md describes.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
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

const name = `Blue-Everything-${version}`;
const out = join(root, 'dist/release');
const stage = join(out, name);
rmSync(out, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  // A tracked file deleted in the working tree is not in the release.
  .filter((file) => existsSync(join(root, file)));

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
const built = walk(join(root, 'packages/web/dist')).map((full) => relative(root, full).replaceAll('\\', '/'));

const files = [...new Set([...tracked, ...built])].sort();
for (const file of files) {
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
  cpSync(join(root, 'runtime/node'), join(stage, 'runtime/node'), { recursive: true });
  cpSync(join(root, 'node_modules'), join(stage, 'node_modules'), {
    recursive: true,
    filter: (src) => !lstatSync(src).isSymbolicLink() && !src.replaceAll('\\', '/').includes('/node_modules/@everything'),
  });
}

writeFileSync(join(stage, 'release-files.txt'), [...files, 'release-files.txt'].map((f) => f.replaceAll('/', '\\')).join('\r\n') + '\r\n');

/*
 * Windows' own bsdtar, named by path: `-a` picks zip from the file name. A bare
 * `tar` finds Git's GNU tar first on a machine with Git Bash — which cannot
 * write a zip at all, and reads "C:" in a path as a remote host to connect to.
 * Relative names, run from the output folder, for the same reason.
 */
const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'bsdtar';
const zip = join(out, `${name}.zip`);
execFileSync(tar, ['-a', '-c', '-f', `${name}.zip`, name], { cwd: out, stdio: 'inherit' });
rmSync(stage, { recursive: true, force: true });

const size = (statSync(zip).size / 1024 / 1024).toFixed(1);
console.log(`${relative(root, zip)} — ${files.length} files, ${size} MB`);
