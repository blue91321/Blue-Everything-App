/**
 * Setting manga up in one press: Java and Suwayomi, downloaded into the app's
 * own folder.
 *
 * It used to be three steps on somebody else's website — install Java, find the
 * right one of Suwayomi's nine downloads, paste its path — and the first person
 * to try it on another PC failed at two of them. Their Java was 17 and
 * Suwayomi needs 21 (`UnsupportedClassVersionError … class file version 65.0`),
 * and after that they chose the `.msi` installer, which is not a jar at all.
 * Neither is a mistake anybody should be able to make, so neither is asked.
 *
 * So this downloads:
 *
 *   - **Java 21**, Eclipse Temurin's runtime from Adoptium's API — about 47MB,
 *     unpacked to `suwayomi-runtime/java/`. The launcher uses this one whenever
 *     it is there, so a PC with an older Java installed is never asked to run it,
 *     and a PC with none never needs one.
 *
 *     **The folder must not be called `jre`**, and that cost an evening. Named
 *     `jre`, Suwayomi started, migrated its database and then died setting up
 *     GraphQL — "The configured packages do not contain any valid classes:
 *     [suwayomi.tachidesk.graphql]" — under Temurin's JRE and JDK alike, while
 *     the same jar ran under a Java installed anywhere else. ClassGraph, which
 *     finds those classes, reads a `java.home` ending in `jre` the Java 8 way —
 *     as the inside of a JDK — and skips everything under the folder above it
 *     as part of Java itself. The folder above it is where the jar is. Renamed
 *     to `java`, both runtimes answered.
 *   - **Suwayomi's `.jar`**, the one asset of its latest release that runs
 *     everywhere — 166MB, beside the runtime.
 *
 * Both into `packages/server/data/suwayomi-runtime/`, inside the install: nothing
 * is put anywhere else on the machine, and removing the folder removes all of
 * it. Then management is switched on, Suwayomi is started, and the extension
 * repository every install needs is added — a fresh Suwayomi lists nothing
 * until one is, which was the next place somebody would get stuck.
 *
 * About 210MB in all, and Suwayomi's first start then fetches its own web
 * interface and a 260MB browser component — see `launch` for why that no longer
 * times out.
 *
 * It reports progress through `setupState`, which the card polls while it runs.
 *
 * ### Pressed again, it is the update
 *
 * Every run asks GitHub for Suwayomi's newest release, so a run on an install
 * that already works is an update: when the newest jar is not the one in use,
 * it is downloaded, the running Suwayomi is stopped, its database is copied to
 * `data/suwayomi/backups/` (the version jump migrates it, and migrations only
 * go forward), and the new jar is started. Then every installed extension with
 * an update waiting is updated. `result` says what it did, so "nothing to do"
 * is visibly an answer rather than a button that seemed to do nothing.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { changes } from '@everything/server/module-api';
import { read, write } from './library.js';
import { dataDir } from '@everything/server/module-api';
import { RUNTIME_DIR, bundledJava, suwayomiProcess } from './process.js';
import { DEFAULT_BASE_URL, KEIYOUSHI_REPO, SuwayomiAdapter } from './suwayomi.js';

const JAVA_URL = 'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse';
const SUWAYOMI_RELEASE = 'https://api.github.com/repos/Suwayomi/Suwayomi-Server/releases/latest';

export type SetupState = {
  running: boolean;
  /** What it is doing now, in words for the screen. */
  step: string | null;
  received: number;
  total: number | null;
  done: boolean;
  problem: string | null;
  /** What the last run did, in words: "Suwayomi updated to v2.4.2366 · 3 extensions updated". */
  result: string | null;
};

let state: SetupState = { running: false, step: null, received: 0, total: null, done: false, problem: null, result: null };

export function setupState(): SetupState {
  return state;
}

async function download(url: string, to: string, step: string): Promise<void> {
  state = { ...state, step, received: 0, total: null };
  const response = await fetch(url, {
    headers: { 'user-agent': 'blue-everything' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30 * 60_000),
  });
  if (!response.ok || !response.body) throw new Error(`${step}: the download answered ${response.status}`);
  const length = Number(response.headers.get('content-length'));
  state.total = Number.isFinite(length) && length > 0 ? length : null;
  const counted = Readable.fromWeb(response.body as never);
  counted.on('data', (chunk: Buffer) => {
    state.received += chunk.length;
  });
  const part = `${to}.part`;
  await pipeline(counted, createWriteStream(part));
  renameSync(part, to);
}

/** Windows' own bsdtar reads zips; Git's GNU tar, first on PATH with Git Bash, does not. */
function unzip(zip: string, into: string): void {
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-x', '-f', zip, '-C', into], { stdio: 'ignore' });
}

export function startSetup(): SetupState {
  if (state.running) return state;
  if (process.platform !== 'win32') {
    state = { ...state, problem: 'setting up automatically is for Windows; point the card at a Suwayomi jar instead' };
    return state;
  }
  state = { running: true, step: 'Starting', received: 0, total: null, done: false, problem: null, result: null };
  void run().catch((error) => {
    state = { ...state, running: false, step: null, problem: error instanceof Error ? error.message : 'setup failed' };
    changes.emitChange('all');
  });
  return state;
}

async function run(): Promise<void> {
  mkdirSync(RUNTIME_DIR, { recursive: true });

  // ---- Java 21 ----
  if (!bundledJava()) {
    const zip = join(RUNTIME_DIR, 'jre.zip');
    await download(JAVA_URL, zip, 'Downloading Java 21');
    state = { ...state, step: 'Unpacking Java' };
    const tmp = join(RUNTIME_DIR, 'java-unpack');
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp);
    unzip(zip, tmp);
    // The zip holds one folder named for the exact build; it is renamed so the
    // launcher can find it without knowing which build it was.
    const inner = readdirSync(tmp).find((name) => existsSync(join(tmp, name, 'bin')));
    if (!inner) throw new Error('the Java download did not contain a runtime');
    // `java`, never `jre` — see the note at the top.
    rmSync(join(RUNTIME_DIR, 'java'), { recursive: true, force: true });
    renameSync(join(tmp, inner), join(RUNTIME_DIR, 'java'));
    rmSync(tmp, { recursive: true, force: true });
    rmSync(zip, { force: true });
  }

  // ---- Suwayomi ----
  state = { ...state, step: 'Finding the newest Suwayomi', received: 0, total: null };
  const response = await fetch(SUWAYOMI_RELEASE, {
    headers: { 'user-agent': 'blue-everything', accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`could not ask GitHub for Suwayomi's latest release (${response.status})`);
  const release = (await response.json()) as { assets?: Array<{ name: string; browser_download_url: string }> };
  // The plain jar, not the .msi, .zip or AppImage beside it — the jar is the one
  // this launcher runs, on every platform.
  const asset = release.assets?.find((a) => /^Suwayomi-Server-v[\d.]+\.jar$/.test(a.name));
  if (!asset) throw new Error('Suwayomi\'s latest release has no .jar to download');
  const jar = join(RUNTIME_DIR, asset.name);
  if (!existsSync(jar)) await download(asset.browser_download_url, jar, `Downloading ${asset.name}`);

  // ---- a different version from the one in use: stop it and keep its database ----
  const before = read();
  const url0 = before.suwayomiUrl ?? DEFAULT_BASE_URL;
  const versionOf = (path: string | null) => (path ? /v[\d.]+(?=\.jar$)/.exec(basename(path))?.[0] ?? null : null);
  const was = versionOf(before.suwayomiJar);
  const now = versionOf(jar);
  const switching = before.suwayomiJar !== null && before.suwayomiJar !== jar;
  if (switching) {
    state = { ...state, step: `Stopping Suwayomi ${was ?? ''}`.trim(), received: 0, total: null };
    // Ours or not: an update was asked for, and the old one holds the port and the database.
    suwayomiProcess.stop(undefined, { force: true });
    await untilQuiet(url0);
    state = { ...state, step: 'Keeping a copy of its database' };
    backUpDatabase(was);
  }

  // ---- point the app at it, and start it ----
  state = { ...state, step: 'Starting Suwayomi (the first start takes a minute)', received: 0, total: null };
  const store = read();
  store.suwayomiJar = jar;
  store.manageSuwayomi = true;
  write(store);
  changes.emitChange('all');

  const url = store.suwayomiUrl ?? DEFAULT_BASE_URL;
  const started = await suwayomiProcess.ensureRunning(jar, url, store.suwayomiMode);
  if (started.state !== 'running') {
    throw new Error(started.state === 'failed' ? started.problem : 'Suwayomi did not start');
  }

  /*
   * Older jars go: one version is enough, and each is 166MB. Only now, once the
   * new one is running. They were removed straight after the download, while
   * the old one was still running from its jar — which Windows may refuse,
   * failing the whole update — and before anything knew the new one would
   * start, which left no old version to go back to if it did not.
   */
  for (const name of readdirSync(RUNTIME_DIR)) {
    if (!/^Suwayomi-Server-.*\.jar$/.test(name) || name === asset.name) continue;
    try {
      rmSync(join(RUNTIME_DIR, name), { force: true });
    } catch {
      // Still held by something: it goes on the next update.
    }
  }

  // ---- the extension list every install needs ----
  state = { ...state, step: 'Adding the extension list' };
  const adapter = new SuwayomiAdapter(url);
  const repos = await adapter.repos();
  if (!repos.includes(KEIYOUSHI_REPO)) await adapter.setRepos([...repos, KEIYOUSHI_REPO]);
  // ---- extensions with an update waiting ----
  const ext = await updateWaitingExtensions(adapter, (step) => {
    state = { ...state, step };
  });
  noteExtensionCheck(ext);

  const said = [
    switching
      ? `Suwayomi updated${was ? ` from ${was}` : ''} to ${now ?? 'the newest version'}`
      : now
        ? `Suwayomi ${now} is the newest`
        : 'Suwayomi is the newest',
    extensionNote(ext),
  ];
  state = { running: false, step: null, received: 0, total: null, done: true, problem: null, result: said.join(' · ') };
  changes.emitChange('all');
}

/* ---- extensions, updated by themselves ---- */

type ExtensionRun = { updated: string[]; failed: string[] };

/**
 * Re-read the extension list and update every installed extension that has an
 * update. It reads the list from the repositories, so it is a network fetch;
 * each update is Suwayomi downloading one small file.
 */
async function updateWaitingExtensions(adapter: SuwayomiAdapter, say: (step: string) => void = () => undefined): Promise<ExtensionRun> {
  // Read fresh, so what is waiting is what the repositories say now.
  const listed = await adapter.extensions(true).catch(() => []);
  const waiting = listed.filter((e) => e.installed && e.hasUpdate);
  const run: ExtensionRun = { updated: [], failed: [] };
  for (const [i, e] of waiting.entries()) {
    say(`Updating extensions (${i + 1} of ${waiting.length}): ${e.name}`);
    try {
      await adapter.updateExtension(e.pkg);
      run.updated.push(e.name);
    } catch {
      run.failed.push(e.name);
    }
  }
  return run;
}

function extensionNote(run: ExtensionRun): string {
  if (run.updated.length === 0 && run.failed.length === 0) return 'extensions are up to date';
  const n = run.updated.length;
  return `${n} extension${n === 1 ? '' : 's'} updated${
    run.failed.length > 0 ? `, ${run.failed.length} would not update (${run.failed.join(', ')})` : ''
  }`;
}

/**
 * When extensions were last checked and what that did, on disk so a restart
 * does not check again at once. A package cannot add a table, hence the file.
 */
const EXTENSIONS_FILE = join(dataDir, 'manga-extensions.json');
type ExtensionCheck = { at: number; note: string };

function lastExtensionCheck(): ExtensionCheck | null {
  try {
    const v = JSON.parse(readFileSync(EXTENSIONS_FILE, 'utf8').replace(/^\uFEFF/, '')) as Partial<ExtensionCheck>;
    return typeof v.at === 'number' && typeof v.note === 'string' ? { at: v.at, note: v.note } : null;
  } catch {
    return null;
  }
}

function noteExtensionCheck(run: ExtensionRun): void {
  try {
    writeFileSync(EXTENSIONS_FILE, JSON.stringify({ at: Date.now(), note: extensionNote(run) }));
  } catch {
    // Not remembered: the next sweep checks again, which costs one list read.
  }
}

/** For the card: when extensions last updated themselves, and what happened. */
export function extensionCheck(): ExtensionCheck | null {
  return lastExtensionCheck();
}

const EXTENSIONS_EVERY_MS = 24 * 60 * 60_000;

/**
 * Extensions update themselves, once a day, while Suwayomi is running.
 *
 * Called from the release sweep, which runs every half hour anyway, so this
 * adds no timer. **Never starts Suwayomi**, the rule the sweep and the tag
 * fill keep: an on-demand Suwayomi is not woken to update something nobody is
 * using, and the next day it is up is soon enough. Not during a setup or an
 * update, which does the same thing itself.
 *
 * A source extension that is out of date is the commonest reason a source
 * stops working: the site changes, the extension is fixed, and the old one
 * keeps failing until somebody presses update.
 */
export async function updateExtensionsIfDue(): Promise<void> {
  if (state.running) return;
  const last = lastExtensionCheck();
  if (last && Date.now() - last.at < EXTENSIONS_EVERY_MS) return;
  const store = read();
  const url = store.suwayomiUrl ?? DEFAULT_BASE_URL;
  if (store.manageSuwayomi && suwayomiProcess.state.state !== 'running') return;
  const adapter = new SuwayomiAdapter(url);
  if (!(await adapter.describe()).reachable) return;
  const run = await updateWaitingExtensions(adapter);
  noteExtensionCheck(run);
  if (run.updated.length > 0) changes.emitChange('all');
}

/** Wait for the old Suwayomi to let go of its port, up to half a minute. */
async function untilQuiet(url: string): Promise<void> {
  const adapter = new SuwayomiAdapter(url);
  for (let i = 0; i < 30; i++) {
    if (!(await adapter.describe()).reachable) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('the old Suwayomi would not stop, so it was left running and nothing was changed');
}

/**
 * Suwayomi's database, copied aside before a new version migrates it. Its
 * migrations only go forward, so this is the way back if the new version
 * misbehaves. The two newest copies are kept; each is the size of your
 * library's chapter lists, tens of megabytes.
 */
function backUpDatabase(version: string | null): void {
  const db = join(dataDir, 'suwayomi', 'database.mv.db');
  if (!existsSync(db)) return;
  const dir = join(dataDir, 'suwayomi', 'backups');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  copyFileSync(db, join(dir, `database-${version ?? 'old'}-${stamp}.mv.db`));
  // Newest by when they were made, not by name: "v2.10" sorts before "v2.4".
  const copies = readdirSync(dir)
    .filter((n) => /^database-.*\.mv\.db$/.test(n))
    .map((n) => ({ n, at: statSync(join(dir, n)).mtimeMs }))
    .sort((a, b) => a.at - b.at);
  for (const old of copies.slice(0, -2)) rmSync(join(dir, old.n), { force: true });
}
