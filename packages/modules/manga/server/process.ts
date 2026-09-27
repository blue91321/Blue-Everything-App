/**
 * Running Suwayomi so you do not have to.
 *
 * ### Why it is still a separate process, and always will be
 *
 * Tachiyomi extensions are **Android APKs** — compiled bytecode against the
 * Android framework — and Suwayomi runs them through an Android compatibility
 * layer it implements on the JVM. Reimplementing that in Node is the hardest
 * part of Suwayomi, not a detail. And the artifact is 166MB for the bare jar,
 * 320MB with a bundled JRE, against a repo whose own rule keeps 150MB of voice
 * models out of git.
 *
 * So it cannot live *inside* the package. What it can do is stop being
 * something you launch by hand, which is what this file is for.
 *
 * ### On demand by default, and that default is argued for
 *
 * A JVM running Suwayomi sits in the 150–250MB range this repo rejected
 * Electron over, and voice's 198MB is described here as "uncomfortable". Paying
 * that all day for something used in bursts is not a trade this app makes
 * anywhere else — so `on-demand` starts it when something needs a source and
 * stops it after `IDLE_STOP_MS` unused. The sweep already falls back to
 * MangaUpdates when no source answers, so a stopped Suwayomi degrades to the old
 * behaviour rather than to an error.
 *
 * `always` is offered beside it because the trade genuinely goes the other way
 * for somebody who reads every day: it starts shortly after the app and never
 * idle-stops, so opening a chapter costs nothing instead of six seconds. The
 * setting exists because neither answer is right for everybody, not because the
 * default was a guess.
 *
 * **The honest cost is the startup.** A JVM plus extension loading is seconds,
 * not milliseconds — nothing like the 0.2s that made push-to-talk affordable for
 * voice. So this never pretends to be instant: `ensureRunning` reports that it
 * is starting, and the screen says so.
 *
 * ### Spawning is the opposite of the tray's case, deliberately
 *
 * `tray.ts` goes out of its way to make its children *outlive* the agent, via
 * `cmd /c start /b`, because `stop.ps1` kills the process that launched them.
 * Here the requirement is reversed: Suwayomi must die with the app. A child that
 * survived would leave an orphaned JVM holding port 4567, and the next start
 * would fail against a server nobody owns.
 *
 * So it is a plain `spawn` with this process as the parent, plus an `onClose`
 * hook and `stop()` on the way down.
 *
 * **`onClose` only covers a clean shutdown, and Stop is not one.** `stop.ps1`
 * force-kills the server, so no hook runs and the JVM carried on with nothing
 * on screen saying so — the tray icon gone, Suwayomi still live. `stop.ps1`
 * therefore stops it too, by command line: a Java or CEF helper process naming
 * this checkout and "suwayomi", which is the JVM (its `rootDir` is under our data folder) and its
 * CEF helpers, and never a Suwayomi somebody runs themselves from elsewhere.
 * `restart.ps1` passes `-KeepSuwayomi`, since the icon is back within seconds
 * and the server adopts the JVM rather than paying most of a minute to start
 * another.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { dataDir } from '@everything/server/module-api';
import { SuwayomiAdapter } from './suwayomi.js';
import type { SuwayomiMode } from './sources.js';

/** Stop it after this long with nothing asking it anything. */
export const IDLE_STOP_MS = 15 * 60_000;

/** How long to wait for the JVM and its extensions before giving up. */
export const START_TIMEOUT_MS = 90_000;

/** How often to ask whether it has finished starting. */
const POLL_MS = 1_000;

export type ManagedState =
  | { state: 'off' }
  | { state: 'starting'; since: number }
  | { state: 'running'; since: number; pid: number | null }
  | { state: 'failed'; problem: string };

/**
 * One manager for the process, like `popup.ts` owning the one overlay.
 *
 * Two owners would eventually both spawn, and the second would fail against the
 * first's port with an error that names neither.
 */
class SuwayomiProcess {
  private child: ChildProcess | null = null;
  private status: ManagedState = { state: 'off' };
  private idleTimer: NodeJS.Timeout | null = null;
  /** The port last used, so `stop()` can find an adopted process by it. */
  private lastPort: number | null = null;
  /** The in-flight start, so five requests at once wait on one JVM. */
  private starting: Promise<ManagedState> | null = null;

  get state(): ManagedState {
    return this.status;
  }

  /** The log, because a failed launch and an unclicked button look identical. */
  private logPath(): string {
    const dir = join(dataDir, 'logs');
    mkdirSync(dir, { recursive: true });
    return join(dir, 'suwayomi.log');
  }

  /**
   * Start it if it is not up, and wait until it answers.
   *
   * Idempotent and safe to call from every route that needs a source: a second
   * caller during startup joins the first rather than spawning a second JVM.
   */
  async ensureRunning(jarPath: string, baseUrl: string, mode: SuwayomiMode = 'on-demand'): Promise<ManagedState> {
    this.touch(mode);

    if (this.status.state === 'running') return this.status;
    if (this.starting) return this.starting;

    /*
     * Something is already answering there — adopt it rather than spawn.
     *
     * Two ways this happens and both are ordinary: you run Suwayomi yourself and
     * switch management on afterwards, or a previous stop left part of its tree
     * behind. Spawning into an occupied port produces a JVM that cannot bind and
     * dies, reported as a start failure while a perfectly good server sits there
     * answering — the most confusing outcome available.
     *
     * **Its pid is looked up rather than left null**, and that is the whole
     * difference between adopting and merely tolerating. The first version
     * recorded `pid: null` and called that honest — but `stop()` can only kill
     * what it has a pid for, so the app reported a JVM as running and had no way
     * to stop it. Found exactly that way: `restart.ps1` force-kills the server,
     * so `onClose` never fires, the new process has no child handle, and the
     * JVM from before the restart was adopted and then unstoppable.
     */
    this.lastPort = portOf(baseUrl);
    const existing = await new SuwayomiAdapter(baseUrl).describe();
    if (existing.reachable) {
      this.status = { state: 'running', since: Date.now(), pid: pidListeningOn(portOf(baseUrl)) };
      return this.status;
    }

    if (!existsSync(jarPath)) {
      // Named rather than a generic failure: "you have not downloaded it" and
      // "it will not start" are different problems with different fixes.
      this.status = { state: 'failed', problem: `no Suwayomi jar at ${jarPath}` };
      return this.status;
    }

    this.starting = this.launch(jarPath, baseUrl, mode).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async launch(jarPath: string, baseUrl: string, mode: SuwayomiMode): Promise<ManagedState> {
    const begunAt = Date.now();
    this.status = { state: 'starting', since: begunAt };

    const port = portOf(baseUrl);
    // Remembered so `stop()` can still find it if this process loses its handle
    // — which is what a force-killed restart does.
    this.lastPort = port;
    const log = createWriteStream(this.logPath(), { flags: 'a' });
    log.write(`\n--- starting ${new Date(begunAt).toISOString()} ${jarPath} (port ${port}) ---\n`);

    try {
      this.child = spawn(
        'java',
        [
          `-Dsuwayomi.tachidesk.config.server.port=${port}`,
          // Its own folder under ours, so it never writes into the app's data
          // root beside the database.
          `-Dsuwayomi.tachidesk.config.server.rootDir=${join(dataDir, 'suwayomi')}`,
          // Suwayomi opens its web UI in the default browser every time it
          // starts, which here means a tab appearing on the PC whenever the
          // app wakes it for a chapter list — often mid-game, the one moment
          // this app exists to leave alone. Its UI is reachable from Manga →
          // More when it is actually wanted. A property rather than an edit
          // to its server.conf, so it holds on a fresh data folder too.
          '-Dsuwayomi.tachidesk.config.server.initialOpenInBrowserEnabled=false',
          // And no tray icon of its own. The app's icon is the one that says
          // Blue Everything is running, and Suwayomi now lives and dies with it
          // (see `stop.ps1`), so a second icon would only be a second thing
          // claiming to be a running app.
          '-Dsuwayomi.tachidesk.config.server.systemTrayEnabled=false',
          '-jar',
          jarPath,
        ],
        {
          cwd: dirname(jarPath),
          // Piped, never 'ignore'. The tray shipped with `stdio: 'ignore'` and
          // no logging, and the first failed launch left nothing written
          // anywhere — which is written down in this repo as a mistake to not
          // repeat.
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
    } catch (error) {
      this.status = { state: 'failed', problem: error instanceof Error ? error.message : 'could not start java' };
      return this.status;
    }

    this.child.stdout?.pipe(log);
    this.child.stderr?.pipe(log);

    this.child.on('error', (error) => {
      // The commonest one by far: no `java` on PATH. Said as itself rather than
      // as "Suwayomi failed to start", because the fix is completely different.
      this.status = {
        state: 'failed',
        problem: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'java is not on PATH' : error.message,
      };
      this.child = null;
    });

    this.child.on('exit', (code) => {
      log.write(`--- exited ${code} ---\n`);
      this.child = null;
      // An exit during normal running is a crash; after `stop()` the state is
      // already 'off' and must not be overwritten with a failure.
      if (this.status.state === 'running' || this.status.state === 'starting') {
        this.status = { state: 'failed', problem: `Suwayomi exited (${code}) — see data/logs/suwayomi.log` };
      }
    });

    const adapter = new SuwayomiAdapter(baseUrl);
    while (Date.now() - begunAt < START_TIMEOUT_MS) {
      const failed = this.failure();
      if (failed !== null) return { state: 'failed', problem: failed };
      const health = await adapter.describe();
      if (health.reachable) {
        this.status = { state: 'running', since: Date.now(), pid: this.child?.pid ?? null };
        this.touch(mode);
        return this.status;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }

    this.stop();
    this.status = { state: 'failed', problem: `Suwayomi did not answer within ${Math.round(START_TIMEOUT_MS / 1000)}s` };
    return this.status;
  }

  /**
   * The failure the `error` or `exit` handler recorded, if either has fired.
   *
   * Read through a method rather than touching `this.status` directly, and that
   * is not style. Inside `launch` TypeScript has narrowed the field to
   * `'starting'` from the assignment at the top and cannot see that the async
   * handlers reassign it — so a direct `this.status.state === 'failed'` is
   * reported as a comparison that can never be true. Crossing a method boundary
   * discards the narrowing, which is the honest fix; casting it away would
   * silence the same complaint while hiding the next real one.
   */
  private failure(): string | null {
    return this.status.state === 'failed' ? this.status.problem : null;
  }

  /**
   * Push the idle deadline out. Called whenever anything asks the source
   * something.
   *
   * In `always` mode there is no deadline to push — and any existing one is
   * cleared, so switching the mode while it is running takes effect at once
   * rather than at the next timer that was already armed.
   */
  touch(mode: SuwayomiMode = 'on-demand'): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (mode === 'always') return;

    this.idleTimer = setTimeout(() => this.stop(), IDLE_STOP_MS);
    // Must never hold the process open, or `smoke` and `features-check` hang on
    // an app that will not close.
    this.idleTimer.unref();
  }

  /**
   * Stop it, and everything it started.
   *
   * **`child.kill()` is not enough, and finding that out cost a real orphan.**
   * Suwayomi's launcher forks a *second* JVM and execs the server in it, so the
   * process we spawn is a parent that exits leaving its child running — which
   * then kept port 4567 answering HTTP 200 after `stop()` had reported `off`.
   * That child had three of its own (CEF's renderers), so this is a tree rather
   * than a pair.
   *
   * The consequence is the one this file's header warns about: an orphaned JVM
   * nobody owns, holding the port, with the next start unable to bind and unable
   * to stop it from inside the app.
   *
   * `taskkill /T /F` walks the tree. There is no portable Node equivalent —
   * `child.kill()` signals one process, and a detached process group is not a
   * thing Windows has in the POSIX sense — so this is platform-specific on
   * purpose, with a plain `kill` everywhere else.
   */
  stop(port?: number): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    // Set before killing, so the `exit` handler does not report a deliberate
    // stop as a crash.
    this.status = { state: 'off' };

    /*
     * The pid we spawned, or whatever is holding the port.
     *
     * The fallback is not defensive padding — it is the only thing that can stop
     * a JVM adopted after a restart, where this process never had a handle to
     * it. `stop()` is only reachable while the app has been told it may start
     * and stop Suwayomi, so killing what is on that port is inside the
     * permission already given.
     */
    // `port` is the caller's knowledge when this process has none: a server
    // that adopted a JVM after a restart but has not yet asked it anything.
    const knownPort = this.lastPort ?? port ?? null;
    const pid = this.child?.pid ?? (knownPort !== null ? pidListeningOn(knownPort) : null);
    this.child = null;
    if (pid === null || pid === undefined) return;

    if (process.platform === 'win32') {
      try {
        // Fire and forget: nothing waits on a stop, and a failure here is
        // logged by the caller noticing the port is still answering.
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }).unref();
      } catch {
        // Nothing left to try. The next `ensureRunning` will adopt whatever is
        // still on the port rather than spawning a second one that cannot bind.
      }
      return;
    }

    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
  }
}

export const suwayomiProcess = new SuwayomiProcess();

/**
 * Which process is listening on a port, when the platform can say.
 *
 * Windows only, via `Get-NetTCPConnection` — the one place this file asks the
 * operating system a question rather than tracking its own child. It exists for
 * the adopted case: a JVM left behind by a force-killed server has no parent to
 * ask, and without this the app can see it running and never stop it.
 *
 * Synchronous on purpose. It runs on the stop path, which has no await to hang
 * a promise off and must not leave a half-stopped state if something throws.
 * Elsewhere it returns null, and the POSIX branch of `stop()` signals the
 * process group instead.
 */
export function pidListeningOn(port: number): number | null {
  if (process.platform !== 'win32') return null;
  try {
    const out = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`,
      ],
      { encoding: 'utf8', timeout: 10_000 }
    );
    const pid = Number.parseInt((out.stdout ?? '').trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** The port out of a base URL, defaulting to Suwayomi's own. */
export function portOf(baseUrl: string): number {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.port) return Number.parseInt(parsed.port, 10);
    return parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    return 4567;
  }
}

/**
 * Jars that look like Suwayomi, in the places one usually lands.
 *
 * Only ever *offered*, never chosen automatically — the same rule the source
 * matcher follows, for the same reason: a guessed path that happens to be wrong
 * would start something nobody asked for.
 *
 * The name is matched with a prefix because releases are versioned
 * (`Suwayomi-Server-v2.3.2243.jar`), so an exact filename would find nothing on
 * the commonest case of all — a fresh download sitting in Downloads.
 */
export function findJars(home: string): string[] {
  const dirs = [join(dataDir, 'suwayomi'), join(home, 'Downloads'), join(home, 'Suwayomi'), home];
  const found: string[] = [];

  for (const dir of dirs) {
    try {
      for (const name of readdirSync(dir)) {
        if (/^Suwayomi-Server.*\.jar$/i.test(name)) found.push(join(dir, name));
      }
    } catch {
      // A directory that does not exist is the ordinary case, not a problem.
    }
  }

  return [...new Set(found)];
}
