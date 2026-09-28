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
 */
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { changes } from '@everything/server/module-api';
import { read, write } from './library.js';
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
};

let state: SetupState = { running: false, step: null, received: 0, total: null, done: false, problem: null };

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
  state = { running: true, step: 'Starting', received: 0, total: null, done: false, problem: null };
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
  if (!existsSync(jar)) {
    await download(asset.browser_download_url, jar, `Downloading ${asset.name}`);
    // Older jars go: one version is enough, and each is 166MB.
    for (const name of readdirSync(RUNTIME_DIR)) {
      if (/^Suwayomi-Server-.*\.jar$/.test(name) && name !== asset.name) rmSync(join(RUNTIME_DIR, name), { force: true });
    }
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

  // ---- the extension list every install needs ----
  state = { ...state, step: 'Adding the extension list' };
  const adapter = new SuwayomiAdapter(url);
  const repos = await adapter.repos();
  if (!repos.includes(KEIYOUSHI_REPO)) await adapter.setRepos([...repos, KEIYOUSHI_REPO]);
  // And read it, so Manage extensions opens on a list rather than an empty page.
  await adapter.extensions(true).catch(() => []);

  state = { running: false, step: null, received: 0, total: null, done: true, problem: null };
  changes.emitChange('all');
}
