/**
 * FlareSolverr: what gets a request past a Cloudflare "are you human" check,
 * by solving it in a hidden browser. Suwayomi can hand such a request to it.
 * Set up on 2026-11-09, when MangaHub put its whole site behind one and every
 * MangaHub series in the library read "source not answering".
 *
 * Two rules from Blake shape all of it.
 *
 * **Nothing runs without a reason.** FlareSolverr is not started with
 * Suwayomi. Suwayomi is told that *this server* is its FlareSolverr, and only
 * when a site actually answers with a check, and Suwayomi asks for it, is the
 * real one started and the request handed on. Ten minutes after the last
 * request it is stopped. Reading sources without Cloudflare, or not reading,
 * costs nothing but the disk it sits on.
 *
 * **No open port without measures and stopgaps.**
 * - FlareSolverr listens on 127.0.0.1 only (`HOST`), on a port picked at random
 *   each start rather than its well-known 8191, so nothing on the Wi-Fi or the
 *   tailnet can reach it, and nothing on this PC can count on finding it.
 * - The door Suwayomi uses (`/manga/flaresolverr/<secret>/v1`) is on this
 *   server, so it is held to the same checks as every local-only route
 *   (`isTrustedLocal`: from this PC, not through a proxy, not a web page), and
 *   it also needs a secret, 32 random bytes made when the server starts. It is
 *   given to Suwayomi through its settings, never on a command line, which any
 *   process can list. A web page, which is what the checks above are about,
 *   cannot learn it; a program already running as you could read Suwayomi's
 *   settings file, but such a program can read everything else here too.
 * - Only what Suwayomi uses is passed on (`ALLOWED`): fetching a page, and the
 *   sessions it keeps. The page must be http or https on a public address, so
 *   it cannot be turned on this PC, the home network or the tailnet; the name
 *   is looked up first, so a name that resolves to one of those is refused too.
 * - It cannot outlive us: stopped ten minutes after its last use, stopped
 *   with the server, killed by `stop.ps1` (which a restart runs), and, if the
 *   server was killed outright, killed when the next one starts, by the pid it
 *   leaves in a file.
 * - Installing and removing it are local-only, like everything that runs code
 *   here, and the download is checked against the SHA-256 its release
 *   publishes before anything is unpacked.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, isIP } from 'node:net';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { changes, config, dataDir } from '@everything/server/module-api';
import { read } from './library.js';
import { RUNTIME_DIR, suwayomiProcess } from './process.js';
import { effectiveUrl } from './sources.js';
import { DEFAULT_BASE_URL } from './suwayomi.js';

export const FLARE_DIR = join(RUNTIME_DIR, 'flaresolverr');
const PID_FILE = join(dataDir, 'suwayomi', 'flaresolverr.pid');
const LOG_FILE = join(dataDir, 'suwayomi', 'flaresolverr.log');
const RELEASE = 'https://api.github.com/repos/FlareSolverr/FlareSolverr/releases/latest';
const ASSET = 'flaresolverr_windows_x64.zip';
/** How long after its last request it is stopped. */
export const IDLE_STOP_MS = 10 * 60_000;
/** How long it may take to start: it opens its browser once to learn its user agent. */
const START_MS = 90_000;
/** What Suwayomi may ask of it. Anything else (a raw command, a cookie dump of other sessions) is refused. */
export const ALLOWED = new Set(['request.get', 'request.post', 'sessions.create', 'sessions.list', 'sessions.destroy']);

/** The secret in the door's address, new each time the server starts. */
const SECRET = randomBytes(32).toString('hex');

/** Where Suwayomi is told its FlareSolverr is: this server, on this PC, behind the secret. */
export function flareUrlForSuwayomi(): string {
  return `http://127.0.0.1:${config.PORT}/manga/flaresolverr/${SECRET}`;
}
export const secretMatches = (given: string) => given.length === SECRET.length && createHash('sha256').update(given).digest('hex') === createHash('sha256').update(SECRET).digest('hex');

/** The program, where the release unpacks it. */
export function flareExe(): string | null {
  if (process.platform !== 'win32') return null;
  const exe = join(FLARE_DIR, 'flaresolverr', 'flaresolverr.exe');
  return existsSync(exe) ? exe : null;
}

/** How much disk it takes, for the screen to say. */
function sizeOf(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? sizeOf(path) : statSync(path).size;
  }
  return total;
}

// ———————————————————————————————— installing ————————————————————————————————

export interface FlareInstall {
  installed: boolean;
  version: string | null;
  bytes: number | null;
  running: boolean;
  /** When it last solved anything, for the screen. */
  lastUsedAt: number | null;
  installing: { step: string; received: number; total: number | null } | null;
  problem: string | null;
  /** Why it cannot be set up here, when it cannot. */
  unavailable: string | null;
}

let installing: FlareInstall['installing'] = null;
let installProblem: string | null = null;
let lastUsedAt: number | null = null;

export function flareState(): FlareInstall {
  const exe = flareExe();
  let version: string | null = null;
  try {
    version = readFileSync(join(FLARE_DIR, 'version.txt'), 'utf8').trim() || null;
  } catch {
    // Not recorded.
  }
  return {
    installed: exe !== null,
    version,
    bytes: exe ? sizeOf(FLARE_DIR) : null,
    running: child !== null,
    lastUsedAt,
    installing,
    problem: installProblem,
    unavailable: process.platform === 'win32' ? null : 'Setting it up from here is for Windows. Elsewhere, run FlareSolverr in Docker on 127.0.0.1 and point Suwayomi at it.',
  };
}

/** Download, check and unpack the newest release. Answers at once; the work carries on in the background. */
export function startInstall(): FlareInstall {
  if (installing || process.platform !== 'win32') return flareState();
  installProblem = null;
  installing = { step: 'Asking GitHub for the newest release', received: 0, total: null };
  void install()
    .catch((error: unknown) => {
      installProblem = error instanceof Error ? error.message : String(error);
    })
    .finally(() => {
      installing = null;
      void configureSuwayomiFlare().catch(() => undefined);
      changes.emitChange('all');
    });
  return flareState();
}

async function install(): Promise<void> {
  const release = (await (await fetch(RELEASE, { headers: { 'user-agent': 'blue-everything' }, signal: AbortSignal.timeout(30_000) })).json()) as {
    tag_name?: string;
    assets?: Array<{ name: string; size: number; digest?: string | null; browser_download_url: string }>;
  };
  const asset = release.assets?.find((a) => a.name === ASSET);
  if (!asset) throw new Error(`the newest release has no ${ASSET}`);
  // The checksum GitHub publishes for the file. Without one, nothing is installed: the point is to know it is the file they released.
  const want = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? '')?.[1]?.toLowerCase();
  if (!want) throw new Error('the release does not publish a SHA-256 for the download, so it cannot be checked');

  mkdirSync(RUNTIME_DIR, { recursive: true });
  const zip = join(RUNTIME_DIR, 'flaresolverr-download.zip');
  installing = { step: `Downloading FlareSolverr ${release.tag_name ?? ''}`.trim(), received: 0, total: asset.size };
  const response = await fetch(asset.browser_download_url, { headers: { 'user-agent': 'blue-everything' }, redirect: 'follow', signal: AbortSignal.timeout(60 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`the download answered ${response.status}`);
  const hash = createHash('sha256');
  const counting = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk);
      if (installing) installing.received += chunk.length;
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as never), counting, createWriteStream(`${zip}.part`));
  const got = hash.digest('hex');
  if (got !== want) {
    rmSync(`${zip}.part`, { force: true });
    throw new Error(`the download is not the file released (SHA-256 ${got.slice(0, 12)}…, expected ${want.slice(0, 12)}…), so it was deleted`);
  }
  renameSync(`${zip}.part`, zip);

  // Unpacked beside, then moved into place, so a failure leaves nothing that looks installed.
  installing = { step: 'Unpacking', received: 0, total: null };
  stopFlare();
  const scratch = join(RUNTIME_DIR, 'flaresolverr-unpacking');
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  // Windows' own bsdtar reads zips; Git's GNU tar, first on PATH with Git Bash, does not.
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  const result = spawnSync(tar, ['-x', '-f', zip, '-C', scratch], { stdio: 'ignore', timeout: 10 * 60_000 });
  if (result.status !== 0 || !existsSync(join(scratch, 'flaresolverr', 'flaresolverr.exe'))) {
    rmSync(scratch, { recursive: true, force: true });
    throw new Error('the download would not unpack into a FlareSolverr');
  }
  rmSync(FLARE_DIR, { recursive: true, force: true });
  renameSync(scratch, FLARE_DIR);
  writeFileSync(join(FLARE_DIR, 'version.txt'), release.tag_name ?? '');
  rmSync(zip, { force: true });
}

/** Take it off the PC. */
export function removeFlare(): FlareInstall {
  stopFlare();
  // Retried: a file under OneDrive, or one antivirus is still reading, refuses for a moment ("EPERM"). The first real removal failed that way.
  rmSync(FLARE_DIR, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  return flareState();
}

/**
 * Tell a running Suwayomi whether it has a FlareSolverr, and where: this
 * server's door, with this run's secret. Called each time Suwayomi comes up
 * (`whenSuwayomiUp`), since the secret is new each time this server starts and
 * a Suwayomi adopted after a restart still holds the last one, and again after
 * installing or removing. Only when the app manages Suwayomi, and only while it
 * is running: never started for this.
 */
export async function configureSuwayomiFlare(): Promise<void> {
  const store = read();
  const url = effectiveUrl(store, DEFAULT_BASE_URL);
  if (!url || !store.manageSuwayomi || suwayomiProcess.state.state !== 'running') return;
  const installed = flareExe() !== null;
  const settings = installed
    ? `flareSolverrEnabled: true, flareSolverrUrl: ${JSON.stringify(flareUrlForSuwayomi())}, flareSolverrTimeout: 120, flareSolverrSessionTtl: 15`
    : 'flareSolverrEnabled: false';
  const response = await fetch(`${url.replace(/\/$/, '')}/api/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: `mutation { setSettings(input: { settings: { ${settings} } }) { settings { flareSolverrEnabled } } }` }),
    signal: AbortSignal.timeout(10_000),
  });
  const answer = (await response.json()) as { errors?: Array<{ message: string }> };
  if (answer.errors?.length) throw new Error(answer.errors[0]!.message);
}

// ———————————————————————————————— running on demand ————————————————————————————————

let child: ChildProcess | null = null;
let port: number | null = null;
let starting: Promise<number> | null = null;
let idleTimer: NodeJS.Timeout | null = null;

/** A port nothing is using, on this PC only. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no free port'))));
    });
  });
}

/** Stop it, and the browser it runs, and forget it. Safe to call when it is not running. */
export function stopFlare(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const pid = child?.pid ?? null;
  child = null;
  port = null;
  if (pid !== null) killTree(pid);
  rmSync(PID_FILE, { force: true });
}

function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 10_000 });
    else process.kill(pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
}

/**
 * One left running by a server that was killed outright, found by the pid it
 * wrote, and stopped: only if that pid is still FlareSolverr, so a pid reused
 * by something else is never touched.
 */
export function stopLeftover(): void {
  let pid: number;
  try {
    pid = Number(readFileSync(PID_FILE, 'utf8').trim());
  } catch {
    return;
  }
  rmSync(PID_FILE, { force: true });
  if (!Number.isSafeInteger(pid) || pid <= 0 || process.platform !== 'win32') return;
  const listed = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 10_000 });
  if (/flaresolverr\.exe/i.test(listed.stdout ?? '')) killTree(pid);
}

function touch(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(stopFlare, IDLE_STOP_MS);
  idleTimer.unref();
}

/** Its port, starting it first if it is not running. */
async function ensureFlare(): Promise<number> {
  if (child && port !== null) return port;
  if (starting) return starting;
  starting = launch().finally(() => {
    starting = null;
  });
  return starting;
}

async function launch(): Promise<number> {
  const exe = flareExe();
  if (!exe) throw new Error('FlareSolverr is not installed');
  const at = await freePort();
  mkdirSync(join(dataDir, 'suwayomi'), { recursive: true });
  const log = createWriteStream(LOG_FILE, { flags: 'a' });
  log.write(`\n--- starting ${new Date().toISOString()} on 127.0.0.1:${at} ---\n`);
  const proc = spawn(exe, [], {
    cwd: join(FLARE_DIR, 'flaresolverr'),
    // 127.0.0.1 only: its own default is every network interface.
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(at), LOG_LEVEL: 'info', HEADLESS: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  proc.stdout?.pipe(log, { end: false });
  proc.stderr?.pipe(log, { end: false });
  proc.on('error', () => undefined);
  proc.on('exit', () => {
    log.end();
    if (child === proc) {
      child = null;
      port = null;
      rmSync(PID_FILE, { force: true });
    }
  });
  child = proc;
  port = at;
  if (proc.pid) writeFileSync(PID_FILE, String(proc.pid));
  // Ready when it answers its own address.
  const until = Date.now() + START_MS;
  while (Date.now() < until) {
    if (child !== proc) throw new Error('FlareSolverr stopped while starting; its log is data/suwayomi/flaresolverr.log');
    try {
      const r = await fetch(`http://127.0.0.1:${at}/`, { signal: AbortSignal.timeout(2_000) });
      if (r.ok) {
        touch();
        return at;
      }
    } catch {
      // Not yet.
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  stopFlare();
  throw new Error('FlareSolverr did not start within 90 seconds');
}

// ———————————————————————————————— what may be passed on ————————————————————————————————

/** Whether an address is somewhere a request from here must never be sent: this PC, a home network, the tailnet, link-local. */
export function isPrivateAddress(address: string): boolean {
  const v = isIP(address);
  if (v === 4) {
    const [a, b] = address.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (v === 6) {
    const s = address.toLowerCase();
    if (s.startsWith('::ffff:')) return isPrivateAddress(s.slice(7));
    return s === '::' || s === '::1' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb') || s.startsWith('ff');
  }
  return true;
}

/** Why a request may not be passed on, or null when it may. Names are looked up, so one that points inside is refused too. */
export async function refusal(body: unknown, resolve: (host: string) => Promise<string[]> = defaultResolve): Promise<string | null> {
  if (!body || typeof body !== 'object') return 'not a FlareSolverr request';
  const { cmd, url } = body as { cmd?: unknown; url?: unknown };
  if (typeof cmd !== 'string' || !ALLOWED.has(cmd)) return `"${String(cmd)}" is not something Suwayomi asks for`;
  if (!cmd.startsWith('request.')) return null;
  if (typeof url !== 'string') return 'no page to fetch';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'not an address';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'only web pages';
  if (parsed.username || parsed.password) return 'no passwords in addresses';
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.ts.net') || host.endsWith('.internal')) return 'not a public site';
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => [] as string[]);
  if (!addresses.length) return 'the site has no address';
  if (addresses.some(isPrivateAddress)) return 'not a public site';
  return null;
}

async function defaultResolve(host: string): Promise<string[]> {
  return (await lookup(host, { all: true })).map((a) => a.address);
}

/** Hand one request to FlareSolverr, starting it if need be, and give back its answer. */
export async function passOn(body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
  const at = await ensureFlare();
  touch();
  // Never longer than Suwayomi will wait for it, and never unbounded.
  const maxTimeout = Math.min(Number(body.maxTimeout) || 60_000, 120_000);
  try {
    const response = await fetch(`http://127.0.0.1:${at}/v1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, maxTimeout }),
      signal: AbortSignal.timeout(maxTimeout + 15_000),
    });
    lastUsedAt = Date.now();
    return { status: response.status, json: await response.json() };
  } finally {
    touch();
  }
}
