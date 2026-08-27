import { desc, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { attentionReportSchema, isAwayFromPc } from '@everything/shared';
import { db } from '../db/client.js';
import { attentionSamples } from '../db/schema.js';
import { changes } from '../events.js';
import { gamesVersion, recordSeen } from './games.js';
import { looksLikeGameInstall, looksLikeSystemApp } from '@everything/shared/games';
import {
  collectDeliverable,
  expireStaleNudges,
  getSettings,
  resolveMoment,
  sweepDueTasks,
  sweepHabitReminders,
} from '../nudge-engine.js';

/**
 * Writing a row per report would mean ~43k rows a day and a constant trickle of
 * SSD writes for data that says "still doing the same thing". A sample is only
 * worth storing when it changes the story: a new state, or enough time passing
 * that a gap would look like missing data.
 */
export const SAMPLE_HEARTBEAT_MS = 5 * 60_000;

/** Sweeping on every report re-runs the same queries for nothing. */
export const SWEEP_INTERVAL_MS = 30_000;

/** How long attention history is kept before pruning. */
export const SAMPLE_RETENTION_MS = 90 * 24 * 60 * 60_000;

/**
 * In-memory because it's a cache, not a fact — a restart costs one extra row
 * and one extra sweep, which is the right trade for keeping it off disk.
 */
let lastPersisted: { state: string; at: number; away: boolean } | null = null;
let lastSweepAt = 0;

/**
 * The agent's most recent word on whether Windows Do Not Disturb is on.
 *
 * Live state, not history, so it's held in memory rather than added as a
 * column. Samples are coalesced anyway, so the stored log couldn't answer
 * "is it on right now" reliably.
 */
let lastWindowsDnd = { value: false, at: 0 };

/** False if the agent hasn't checked in recently — stale is not the same as off. */
export function currentWindowsDnd(now = Date.now()): boolean {
  if (now - lastWindowsDnd.at > 2 * 60_000) return false;
  return lastWindowsDnd.value;
}

export async function pruneOldSamples(now = Date.now()): Promise<number> {
  const deleted = await db
    .delete(attentionSamples)
    .where(lt(attentionSamples.at, now - SAMPLE_RETENTION_MS))
    .returning({ id: attentionSamples.id });
  return deleted.length;
}

export async function attentionRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The agent's heartbeat, and the busiest endpoint in the app.
   *
   * One round trip does everything: record what you are doing, refresh the
   * queue from tasks coming due, and hand back whatever has earned the right to
   * interrupt. The agent stays dumb; all the judgement lives server-side.
   */
  app.post('/api/attention', async (request) => {
    const report = attentionReportSchema.parse(request.body);
    const at = report.at ?? Date.now();

    lastWindowsDnd = { value: report.windowsDnd, at: Date.now() };

    // A stopping point is always worth a row — it's the event the app exists
    // for, and losing it to coalescing would hide why a nudge fired.
    const away = isAwayFromPc(report);
    const changed = lastPersisted?.state !== report.state || lastPersisted?.away !== away;
    const stale = !lastPersisted || at - lastPersisted.at >= SAMPLE_HEARTBEAT_MS;
    if (changed || stale || report.stoppingPoint) {
      await db.insert(attentionSamples).values({
        at,
        state: report.state,
        reason: report.reason,
        exe: report.exe ?? null,
        title: report.title ?? null,
        idleMs: report.idleMs,
        liveGames: JSON.stringify(report.liveGames),
        stoppingQuality: report.stoppingPoint?.quality ?? null,
        audioPlaying: report.audioPlaying ? 1 : 0,
        awayFromPc: away ? 1 : 0,
      });
      lastPersisted = { state: report.state, at, away };
    }

    let queueChanged = false;
    if (at - lastSweepAt >= SWEEP_INTERVAL_MS) {
      // Expire first, so a stale reminder can't be delivered and doesn't block
      // its habit's next one.
      const expired = await expireStaleNudges(at);
      const queuedTasks = await sweepDueTasks(at);
      const queuedHabits = await sweepHabitReminders(at);
      lastSweepAt = at;
      queueChanged = expired + queuedTasks + queuedHabits > 0;
    }

    const result = await collectDeliverable(report, request.deviceId);
    const prefs = await getSettings();

    /*
     * Record what was running, so the Games screen has something to show.
     *
     * Cheap by design: `recordSeen` remembers what this process has already
     * written and does nothing at all for an executable it has seen in the last
     * five minutes, so the steady state — the same game running for an hour —
     * costs no queries rather than one per poll.
     *
     * A fullscreen app is recorded as *not* a game. Films, browsers and photo
     * viewers all go fullscreen, and assuming otherwise would silently start
     * holding nudges back for something nobody would think to look at this list
     * about.
     */
    await recordSeen([
      ...report.liveGames.map((exe) => ({ exe, source: 'seen' as const, isGame: true, path: report.gamePaths[exe] })),
      /*
       * The shell never becomes a row, checked here as well as in the agent.
       * The two are about different things: the agent's copy stops it being
       * *reported*, this one stops an older agent — or a replayed report —
       * putting `explorer.exe` back on the list. They are the same check only
       * while both are right, which is the arrangement the zip reader's path
       * guard already uses.
       */
      ...(report.fullscreenApp &&
      !report.liveGames.includes(report.fullscreenApp) &&
      !looksLikeSystemApp(report.gamePaths[report.fullscreenApp] ?? '')
        ? [
            {
              exe: report.fullscreenApp,
              source: 'fullscreen' as const,
              /*
               * Covering the screen gets it *listed*; the path is what switches
               * it on. A browser at F11 and a film both cover the screen, so
               * that alone can only ever be a candidate — but an executable
               * living under `steamapps/common` is a game whatever shape its
               * window is, and making you tick that would be busywork.
               */
              isGame: looksLikeGameInstall(report.gamePaths[report.fullscreenApp] ?? ''),
              path: report.gamePaths[report.fullscreenApp],
            },
          ]
        : []),
    ]);

    // This endpoint fires every few seconds, so it announces changes only when
    // it genuinely made one — otherwise every open client would reload on a
    // timer, which is the polling this was meant to avoid.
    if (queueChanged || result.deliver.length > 0 || result.pushed > 0) changes.emitChange('nudges');

    return {
      /*
       * The same moment `collectDeliverable` judged by, not a second opinion.
       * They were two calls to `momentQuality` and would have disagreed the
       * moment the game settings came into it — the agent showing "in-game" on
       * a screen while the engine had already decided it was interruptible.
       */
      moment: await resolveMoment(report, prefs),
      deliver: result.deliver,
      pushed: result.pushed,
      awayFromPc: result.awayFromPc,
      /*
       * Carried on the *attention* heartbeat rather than the voice one, because
       * popups and their sounds are core: an install with `features/voice`
       * deleted still raises nudges, and the switch has to reach it. This is the
       * only request the agent always makes.
       */
      soundEnabled: Boolean(prefs.soundEnabled),
      /*
       * Game detection rides here for the same reason `soundEnabled` does: this
       * is the one request the agent always makes, whatever is installed.
       *
       * The *version* rather than the list. A hundred executables on every poll
       * would be the bandwidth equivalent of the row-per-tick cost this endpoint
       * was shaped to avoid; the agent compares the hash and fetches the list
       * only when it has actually moved.
       */
      gameDetectionEnabled: Boolean(prefs.gameDetectionEnabled),
      gamesVersion: await gamesVersion(),
      /*
       * Which tone each moment gets. On the *attention* heartbeat for the same
       * reason the on/off switch is: popups are core, so an install with voice
       * deleted still needs them, and this is the only request the agent always
       * makes. Empty means "your default" and is sent as such rather than being
       * resolved here — the palette lives in the agent.
       */
      tones: {
        wake: prefs.soundWake,
        ok: prefs.soundOk,
        miss: prefs.soundMiss,
        nudge: prefs.soundNudge,
      },
    };
  });

  app.get('/api/attention/recent', async (request) => {
    const { limit } = request.query as { limit?: string };
    return db
      .select()
      .from(attentionSamples)
      .orderBy(desc(attentionSamples.at))
      .limit(Math.min(Number(limit) || 100, 1000));
  });
}
