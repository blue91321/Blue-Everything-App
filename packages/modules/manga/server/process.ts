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
 * ### On demand, because the alternative fails this project's own test
 *
 * A JVM running Suwayomi sits in the 150–250MB range this repo rejected
 * Electron over, and voice's 198MB is described here as "uncomfortable". Paying
 * that all day for something used in bursts is not a trade this app makes
 * anywhere else.
 *
 * So it starts when something actually needs a source and stops after
 * `IDLE_STOP_MS` without one. The sweep already falls back to MangaUpdates when
 * no source answers, so a stopped Suwayomi degrades to the old behaviour rather
 * than to an error.
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
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { dataDir } from '@everything/server/module-api';
import { SuwayomiAdapter } from './suwayomi.js';

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
  async ensureRunning(jarPath: string, baseUrl: string): Promise<ManagedState> {
    this.touch();

    if (this.status.state === 'running') return this.status;
    if (this.starting) return this.starting;

    if (!existsSync(jarPath)) {
      // Named rather than a generic failure: "you have not downloaded it" and
      // "it will not start" are different problems with different fixes.
      this.status = { state: 'failed', problem: `no Suwayomi jar at ${jarPath}` };
      return this.status;
    }

    this.starting = this.launch(jarPath, baseUrl).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async launch(jarPath: string, baseUrl: string): Promise<ManagedState> {
    const begunAt = Date.now();
    this.status = { state: 'starting', since: begunAt };

    const port = portOf(baseUrl);
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
        this.touch();
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

  /** Push the idle deadline out. Called whenever anything asks the source something. */
  touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), IDLE_STOP_MS);
    // Must never hold the process open, or `smoke` and `features-check` hang on
    // an app that will not close.
    this.idleTimer.unref();
  }

  stop(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    // Set before killing, so the `exit` handler does not report a deliberate
    // stop as a crash.
    this.status = { state: 'off' };
    this.child?.kill();
    this.child = null;
  }
}

export const suwayomiProcess = new SuwayomiProcess();

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
