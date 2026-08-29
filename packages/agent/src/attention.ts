/**
 * The attention model: turn raw Win32 signals into "can I interrupt you
 * right now, and if not, was that just a moment where I could have?"
 *
 * Nothing here sends a notification. It only classifies the current moment and
 * announces transitions; the server decides what to do with them.
 *
 * ## Why this is more complicated than a setInterval
 *
 * A full process snapshot costs ~5ms and everything else costs ~0.1ms combined
 * (see `npm run bench`). This runs forever on a gaming PC, so the monitor pays
 * for the expensive scan only when it could plausibly change the answer:
 *
 *   - Games are found by snapshot, then *watched* by PID, which is ~2500x
 *     cheaper. Catching the end of a match — the moment the whole app exists
 *     for — never waits on a rescan.
 *   - Snapshots run often only when a launcher or game is up. You cannot start
 *     League without the client already running, so the rest of the time a
 *     minute between scans loses nothing.
 *   - Tick rate follows the state: fast while gaming, slow at an empty desk.
 */
import { EventEmitter } from 'node:events';
import {
  getForegroundWindow,
  getIdleMs,
  getNotificationState,
  listProcesses,
  processIsAlive,
  NotificationState,
  notificationStateName,
  type ForegroundWindowInfo,
  exePathForPid,
} from './win32.js';
import { audioRecentlyPlaying } from './audio.js';
import { steamUrlFor } from './steam.js';
import { looksLikeSystemApp } from '@everything/shared/games';
import { isGame, isLauncher } from './games.js';

export type AttentionState =
  /** Desktop use, nothing covering the screen. Interrupt freely. */
  | 'free'
  /** A match or session is live. Hold everything. */
  | 'in-game'
  /** Fullscreen video, a call, presentation mode, or Do Not Disturb. Hold most things. */
  | 'focused'
  /** No input for a while — they aren't at the machine to see a toast. */
  | 'away';

export interface AttentionSnapshot {
  at: Date;
  state: AttentionState;
  /** Why the classifier landed on that state, for the log and for debugging. */
  reason: string;
  foreground: ForegroundWindowInfo | null;
  idleMs: number;
  notificationState: number;
  /**
   * Windows' own Do Not Disturb is on.
   *
   * Worth reporting separately from the attention state: it's an explicit "not
   * now" from you, whereas `focused` is the sensor's inference. It also works
   * for an irregular sleep schedule, because it's flipped when you actually goes
   * to bed rather than at a predicted hour.
   */
  windowsDnd: boolean;
  /**
   * Something has played sound recently.
   *
   * The reason this exists: idle time cannot tell an empty chair apart from a
   * film. Both look identical to the keyboard, and they need opposite
   * behaviour — one should reach the phone, the other must not.
   */
  audioPlaying: boolean;
  /** Known game executables currently alive, whether focused or not. */
  liveGames: string[];
  /**
   * The executable holding exclusive fullscreen, if any.
   *
   * Reported every tick rather than announced once, because the server keeps the
   * list now: the `unknown-fullscreen-app` event fired a single time per process
   * lifetime and went to the console, which is no use to a screen somebody opens
   * an hour later.
   */
  fullscreenApp: string | null;
  /**
   * Full paths for the live games, keyed by executable.
   *
   * Read from the PID the monitor is already tracking, so it costs one call per
   * game per snapshot and only while one is running. It is what makes "run this"
   * and "show me where it is" possible at all — the executable *name* is enough
   * to recognise a game and useless for launching one.
   */
  gamePaths: Record<string, string>;
  /**
   * How to *start* each one, where that is not the same as running its
   * executable — today, Steam games. Absent for anything installed elsewhere,
   * which launches by path exactly as before.
   */
  gameUrls: Record<string, string>;
}

/**
 * A moment where interrupting is unusually welcome. `quality` ranks them so a
 * pile-up of nudges can wait for a `prime` break rather than spending itself on
 * a merely `decent` one.
 */
export interface StoppingPoint {
  at: Date;
  quality: 'prime' | 'decent';
  reason: string;
  from: AttentionState;
  to: AttentionState;
}

export const AWAY_AFTER_MS = 5 * 60_000;

/**
 * How long between ticks in each state. Fast enough while gaming to catch the
 * end of a match promptly; slow enough at an idle desk to disappear entirely.
 */
export const TICK_MS: Record<AttentionState, number> = {
  'in-game': 5_000,
  focused: 10_000,
  free: 15_000,
  away: 30_000,
};

/** Minimum gap between full process snapshots, when something could start a game. */
export const SNAPSHOT_ACTIVE_MS = 10_000;
/** Minimum gap when no launcher or game is running — nothing can start silently. */
export const SNAPSHOT_IDLE_MS = 60_000;

export interface SensorStats {
  ticks: number;
  snapshots: number;
  /** Rough cost of the expensive call, so leanness claims stay measurable. */
  snapshotMsTotal: number;
}

export interface AttentionMonitorEvents {
  /**
   * Every poll, with the stopping point already resolved. Reporting to the
   * server needs both in the same payload, so they're emitted together rather
   * than as separate events the consumer would have to correlate.
   */
  tick: [AttentionSnapshot, StoppingPoint | null];
  change: [AttentionSnapshot, AttentionState];
  'stopping-point': [StoppingPoint];
  /** An unrecognised app held exclusive fullscreen — a candidate for games.ts. */
}

export class AttentionMonitor extends EventEmitter<AttentionMonitorEvents> {
  private timer?: NodeJS.Timeout;
  private last?: AttentionSnapshot;
  private readonly awayAfterMs: number;

  /** Game exe -> PID, so liveness is a cheap check instead of a rescan. */
  private trackedGames = new Map<string, number>();
  /** What covered the screen last snapshot, so a flicker does not get listed. */
  private lastCovering: string | null = null;
  private launcherRunning = false;
  private lastSnapshotAt = 0;
  private lastForegroundExe = '';

  readonly stats: SensorStats = { ticks: 0, snapshots: 0, snapshotMsTotal: 0 };

  constructor(opts: { awayAfterMs?: number } = {}) {
    super();
    this.awayAfterMs = opts.awayAfterMs ?? AWAY_AFTER_MS;
  }

  get current(): AttentionSnapshot | undefined {
    return this.last;
  }

  start(): void {
    if (this.timer) return;
    this.tick();
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private tick(): void {
    const snapshot = this.sample();
    const previous = this.last;
    this.last = snapshot;
    this.stats.ticks++;

    const changed = previous && previous.state !== snapshot.state;
    const stoppingPoint = changed ? this.classifyTransition(previous, snapshot) : null;

    this.emit('tick', snapshot, stoppingPoint);
    if (changed) {
      this.emit('change', snapshot, previous.state);
      if (stoppingPoint) this.emit('stopping-point', stoppingPoint);
    }

    // setTimeout rather than setInterval so the rate can follow the state.
    // Deliberately *not* unref'd: this loop is the agent's entire job, and an
    // unref'd timer lets Node decide the process has nothing left to do and
    // exit after a single tick.
    this.timer = setTimeout(() => this.tick(), TICK_MS[snapshot.state]);
  }

  /**
   * Decide whether this tick needs the expensive scan.
   *
   * `trackedDied` forces one: a game vanishing is exactly the event worth
   * spending 5ms to confirm, since it's the transition the app exists for.
   */
  private refreshProcesses(now: number, foregroundExe: string, trackedDied: boolean): void {
    const foregroundChanged = foregroundExe !== this.lastForegroundExe;
    const interval = this.launcherRunning || this.trackedGames.size > 0 ? SNAPSHOT_ACTIVE_MS : SNAPSHOT_IDLE_MS;
    const stale = now - this.lastSnapshotAt >= interval;

    if (!trackedDied && !foregroundChanged && !stale) return;

    const started = process.hrtime.bigint();
    const processes = listProcesses();
    this.stats.snapshots++;
    this.stats.snapshotMsTotal += Number(process.hrtime.bigint() - started) / 1e6;

    this.trackedGames = new Map([...processes].filter(([name]) => isGame(name)));
    this.launcherRunning = [...processes.keys()].some(isLauncher);
    this.lastSnapshotAt = now;
    this.lastForegroundExe = foregroundExe;
  }

  private sample(): AttentionSnapshot {
    const at = new Date();
    const now = at.getTime();

    const foreground = getForegroundWindow();
    const idleMs = getIdleMs();
    const notificationState = getNotificationState();

    // Watch known games by PID first — two syscalls each, versus a full rescan.
    let trackedDied = false;
    for (const [exe, pid] of this.trackedGames) {
      if (!processIsAlive(pid)) {
        this.trackedGames.delete(exe);
        trackedDied = true;
      }
    }

    this.refreshProcesses(now, foreground?.exe ?? '', trackedDied);

    const liveGames = [...this.trackedGames.keys()];
    const windowsDnd =
      notificationState === NotificationState.QUIET_TIME ||
      notificationState === NotificationState.PRESENTATION_MODE;
    const audioPlaying = audioRecentlyPlaying(now).playing;
    /*
     * A candidate for the games list.
     *
     * **Not `RUNNING_D3D_FULL_SCREEN`**, which was the first version and is the
     * wrong signal: that flag means *exclusive* fullscreen, and most people play
     * borderless — so a whole library of games was invisible to discovery while
     * the one that grabs the display outright was the only thing ever found.
     *
     * `isFullScreen` is geometry instead: the window covers its monitor's full
     * bounds. A maximised window does not, because it stops at the work area, so
     * this is a genuinely narrower signal than "big window" while still catching
     * borderless — and exclusive fullscreen covers the monitor too, so nothing
     * that used to be found is lost.
     *
     * Held for two consecutive snapshots before it counts. A transition, a
     * screensaver or an installer flashing up covers the screen for an instant,
     * and a list that filled with those would be worse than one that filled
     * slowly.
     */
    /*
     * The shell is excluded before anything else. The desktop *is* a window
     * covering its whole monitor, and it is the foreground window every time you
     * alt-tab out of a game — so without this, `explorer.exe` is discovered as
     * an app that filled the screen. Which it had. Reported from real use.
     */
    const covering =
      foreground?.exe &&
      foreground.isFullScreen &&
      !isLauncher(foreground.exe) &&
      !looksLikeSystemApp(foreground.exePath)
        ? foreground.exe.toLowerCase()
        : null;
    const sustained = covering !== null && covering === this.lastCovering;
    this.lastCovering = covering;
    const fullscreenApp = sustained ? covering : null;
    const gamePaths: Record<string, string> = {};
    const gameUrls: Record<string, string> = {};
    for (const [exe, pid] of this.trackedGames) {
      const path = exePathForPid(pid);
      if (path) {
        gamePaths[exe] = path;
        const url = steamUrlFor(path);
        if (url) gameUrls[exe] = url;
      }
    }
    if (fullscreenApp && foreground?.pid) {
      const path = exePathForPid(foreground.pid);
      if (path) {
        gamePaths[fullscreenApp] = path;
        const url = steamUrlFor(path);
        if (url) gameUrls[fullscreenApp] = url;
      }
    }

    const base = {
      at,
      foreground,
      idleMs,
      notificationState,
      windowsDnd,
      audioPlaying,
      liveGames,
      fullscreenApp,
      gamePaths,
      gameUrls,
    };

    // Order matters. A live game outranks idleness: sitting in a death-cam
    // without touching the mouse is not the same as walking away, and firing a
    // nudge there would land mid-match.
    if (liveGames.length > 0) {
      return { ...base, state: 'in-game', reason: `${liveGames.join(', ')} running` };
    }

    if (notificationState === NotificationState.RUNNING_D3D_FULL_SCREEN) {
      const exe = foreground?.exe ?? '';
      /*
       * Still `in-game`: something has taken the display outright, and that is
       * not a moment to interrupt whatever it turns out to be. Discovery no
       * longer hangs off this branch — see `covering` above — because it never
       * fires for a borderless window, which is how most people actually play.
       */
      return { ...base, state: 'in-game', reason: `${exe || 'an app'} holds exclusive fullscreen` };
    }

    if (idleMs >= this.awayAfterMs) {
      return { ...base, state: 'away', reason: `no input for ${Math.round(idleMs / 60_000)}m` };
    }

    if (
      notificationState === NotificationState.PRESENTATION_MODE ||
      notificationState === NotificationState.QUIET_TIME ||
      notificationState === NotificationState.BUSY ||
      notificationState === NotificationState.APP_FULL_SCREEN
    ) {
      return { ...base, state: 'focused', reason: `Windows reports ${notificationStateName(notificationState)}` };
    }

    if (foreground?.isFullScreen && !isLauncher(foreground.exe)) {
      return { ...base, state: 'focused', reason: `${foreground.exe} is fullscreen` };
    }

    return { ...base, state: 'free', reason: foreground ? `at the desktop in ${foreground.exe}` : 'at the desktop' };
  }

  private classifyTransition(prev: AttentionSnapshot, next: AttentionSnapshot): StoppingPoint | null {
    const shared = { at: next.at, from: prev.state, to: next.state };

    // The whole point of the app: a match just ended.
    if (prev.state === 'in-game' && next.state !== 'in-game' && next.state !== 'away') {
      const ended = prev.liveGames.filter((g) => !next.liveGames.includes(g));
      const what = ended.length ? ended.join(', ') : 'the game';
      return { ...shared, quality: 'prime', reason: `${what} just ended` };
    }

    // Back from a break, hands on the keyboard, nothing covering the screen.
    if (prev.state === 'away' && next.state === 'free') {
      return { ...shared, quality: 'prime', reason: 'back at the desk' };
    }

    // Came out of a call, video, or presentation.
    if (prev.state === 'focused' && next.state === 'free') {
      return { ...shared, quality: 'decent', reason: `done with ${prev.foreground?.exe ?? 'that'}` };
    }

    return null;
  }
}
