import { desc, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { attentionReportSchema } from '@everything/shared';
import { db } from '../db/client.js';
import { attentionSamples } from '../db/schema.js';
import { changes } from '../events.js';
import {
  collectDeliverable,
  expireStaleNudges,
  momentQuality,
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
let lastPersisted: { state: string; at: number } | null = null;
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
   * One round trip does everything: record what Blake is doing, refresh the
   * queue from tasks coming due, and hand back whatever has earned the right to
   * interrupt. The agent stays dumb; all the judgement lives server-side.
   */
  app.post('/api/attention', async (request) => {
    const report = attentionReportSchema.parse(request.body);
    const at = report.at ?? Date.now();

    lastWindowsDnd = { value: report.windowsDnd, at: Date.now() };

    // A stopping point is always worth a row — it's the event the app exists
    // for, and losing it to coalescing would hide why a nudge fired.
    const changed = lastPersisted?.state !== report.state;
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
      });
      lastPersisted = { state: report.state, at };
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

    const deliver = await collectDeliverable(report, request.deviceId);

    // This endpoint fires every few seconds, so it announces changes only when
    // it genuinely made one — otherwise every open client would reload on a
    // timer, which is the polling this was meant to avoid.
    if (queueChanged || deliver.length > 0) changes.emitChange('nudges');

    return {
      moment: momentQuality(report.state, report.stoppingPoint),
      deliver,
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
