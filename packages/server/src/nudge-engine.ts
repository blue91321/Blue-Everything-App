/**
 * When does a nudge get to interrupt?
 *
 * The server owns this decision, not the clients. The Windows agent reports
 * what it observes and does as it's told; the phone will do the same. That way
 * there is exactly one place where "is this a good moment" is defined, and it
 * doesn't drift between devices.
 */
import { and, desc, eq, inArray, isNotNull, isNull, lt, lte, or } from 'drizzle-orm';
import {
  isAwayFromPc,
  quietReason,
  qualityRank,
  type AttentionReport,
  type AttentionState,
  type DeliverableNudge,
  type NudgeQuality,
  type StoppingQuality,
} from '@everything/shared';
import { db } from './db/client.js';
import { habitEntries, habits, nudges, settings, tasks } from './db/schema.js';
import { pushIsOnCooldown, sendPushToPhones } from './push.js';
import { periodKeyFor } from './routes/habits.js';

/**
 * The one settings row, created on first read.
 *
 * Not cached: it's a single indexed row read a few times a minute, and a stale
 * cache would mean quiet hours not taking effect until a restart.
 */
export async function getSettings() {
  const [existing] = await db.select().from(settings).limit(1);
  if (existing) return existing;

  const [created] = await db.insert(settings).values({ id: 'singleton' }).returning();
  return created;
}

/**
 * How good the current moment is, or `null` for "not a moment at all".
 *
 * `in-game` and `focused` are never interruptible on quality alone — only a
 * passed deadline gets through. `away` is separate: a toast fired at an empty
 * chair is a nudge spent for nothing, so nothing fires until Blake is back.
 */
export function momentQuality(
  state: AttentionState,
  stoppingPoint?: { quality: StoppingQuality } | null
): NudgeQuality | null {
  if (state === 'away' || state === 'in-game' || state === 'focused') return null;
  return stoppingPoint?.quality ?? 'any';
}

export interface DeliveryDecision {
  deliver: boolean;
  escalated: boolean;
  reason: string;
}

interface DecidableNudge {
  earliestAt: number;
  deadlineAt: number | null;
  expiresAt?: number | null;
  minQuality: string;
  snoozeUntil: number | null;
}

/**
 * The whole policy, in one readable place.
 *
 * Deliberately *not* handling: rate limiting, batching, or per-device routing.
 * Those belong to whatever consumes this decision, so this stays testable.
 */
export function shouldDeliver(
  nudge: DecidableNudge,
  ctx: { now: number; state: AttentionState; moment: NudgeQuality | null; quiet?: boolean }
): DeliveryDecision {
  // Quiet hours outrank everything, including a passed deadline. "Don't wake me
  // up" has to mean it, or it isn't a setting worth having.
  if (ctx.quiet) {
    return { deliver: false, escalated: false, reason: 'quiet hours' };
  }
  if (nudge.expiresAt && nudge.expiresAt <= ctx.now) {
    return { deliver: false, escalated: false, reason: 'expired' };
  }
  if (nudge.snoozeUntil && nudge.snoozeUntil > ctx.now) {
    return { deliver: false, escalated: false, reason: 'snoozed' };
  }
  if (nudge.earliestAt > ctx.now) {
    return { deliver: false, escalated: false, reason: 'not due yet' };
  }

  // A passed deadline overrides a bad moment — that is what a deadline is for.
  // It still won't fire at an empty desk, because nobody would see it.
  const pastDeadline = nudge.deadlineAt !== null && nudge.deadlineAt <= ctx.now;
  if (pastDeadline) {
    return ctx.state === 'away'
      ? { deliver: false, escalated: false, reason: 'past deadline but nobody is at the desk' }
      : { deliver: true, escalated: true, reason: 'deadline passed' };
  }

  if (ctx.moment === null) {
    return { deliver: false, escalated: false, reason: `holding while ${ctx.state}` };
  }

  const required = (nudge.minQuality as NudgeQuality) ?? 'decent';
  if (qualityRank[ctx.moment] < qualityRank[required]) {
    return { deliver: false, escalated: false, reason: `waiting for a ${required} moment` };
  }

  return { deliver: true, escalated: false, reason: `${ctx.moment} moment` };
}

/**
 * Evaluate the queue against a fresh attention report and mark whatever wins as
 * delivered. Returns what the caller should actually show.
 */
export interface DeliveryResult {
  /** For the agent to raise as Windows toasts. Empty when Blake isn't there. */
  deliver: DeliverableNudge[];
  /** How many reached the phone instead. */
  pushed: number;
  channel: 'toast' | 'push' | 'none';
  /** True when the PC has been untouched and silent long enough to count as empty. */
  awayFromPc: boolean;
}

export async function collectDeliverable(
  report: AttentionReport,
  deviceId: string | null
): Promise<DeliveryResult> {
  const now = report.at ?? Date.now();
  const moment = momentQuality(report.state, report.stoppingPoint);

  const prefs = await getSettings();
  const quiet =
    quietReason(new Date(now), {
      quietHoursEnabled: Boolean(prefs.quietHoursEnabled),
      quietStartMinute: prefs.quietStartMinute,
      quietEndMinute: prefs.quietEndMinute,
      followWindowsDnd: Boolean(prefs.followWindowsDnd),
      dndUntil: prefs.dndUntil,
      remindersEnabled: Boolean(prefs.remindersEnabled),
      windowsDnd: report.windowsDnd,
    }) !== null;

  /**
   * With the chair empty, the PC's stopping points are meaningless — there is
   * no match to avoid interrupting. So anything already due may go to the
   * phone, which is why `isAwayFromPc` is deliberately strict about proving
   * he's really gone.
   */
  const awayFromPc = isAwayFromPc(report);
  const toPhone = awayFromPc && Boolean(prefs.pushEnabled) && !quiet;

  if (toPhone && pushIsOnCooldown(now)) {
    // Leave everything queued rather than marking it delivered — it will go out
    // on the next window, or as a toast the moment he sits back down.
    return { deliver: [], pushed: 0, channel: 'none', awayFromPc };
  }

  const effectiveMoment = toPhone ? ('any' as NudgeQuality) : moment;

  const candidates = await db
    .select()
    .from(nudges)
    .where(
      and(
        or(eq(nudges.state, 'pending'), eq(nudges.state, 'snoozed')),
        lte(nudges.earliestAt, now)
      )
    );

  const winners: { nudge: DeliverableNudge; escalated: boolean }[] = [];
  for (const nudge of candidates) {
    const decision = shouldDeliver(nudge, { now, state: report.state, moment: effectiveMoment, quiet });
    if (!decision.deliver) continue;

    winners.push({
      escalated: decision.escalated,
      nudge: {
        id: nudge.id,
        title: nudge.title,
        body: nudge.body,
        taskId: nudge.taskId,
        habitId: nudge.habitId,
        minQuality: nudge.minQuality as NudgeQuality,
        escalated: decision.escalated,
      },
    });
  }

  if (winners.length === 0) {
    return { deliver: [], pushed: 0, channel: 'none', awayFromPc };
  }

  // Send before marking anything delivered: with no phone subscribed, or the
  // push service refusing, these must stay queued rather than vanish unseen.
  let pushed = 0;
  if (toPhone) {
    const outcome = await sendPushToPhones(winners.map((w) => w.nudge), now);
    pushed = outcome.sent;
    if (pushed === 0) return { deliver: [], pushed: 0, channel: 'none', awayFromPc };
  }

  for (const { nudge, escalated } of winners) {
    await db
      .update(nudges)
      .set({
        state: 'delivered',
        deliveredAt: now,
        deliveredDeviceId: deviceId,
        attempts: (candidates.find((c) => c.id === nudge.id)?.attempts ?? 0) + 1,
        escalated: escalated ? 1 : 0,
        snoozeUntil: null,
      })
      .where(eq(nudges.id, nudge.id));
  }

  return {
    deliver: toPhone ? [] : winners.map((w) => w.nudge),
    pushed,
    channel: toPhone ? 'push' : 'toast',
    awayFromPc,
  };
}

/**
 * Drop recurring reminders that were never delivered in time.
 *
 * This is what makes "hold everything while gaming" survivable. Without it, a
 * three-hour session with a two-hourly water reminder ends in a pile of
 * identical toasts — the queue would be technically correct and practically
 * useless. A missed periodic reminder is simply missed.
 */
export async function expireStaleNudges(now = Date.now()): Promise<number> {
  const expired = await db
    .update(nudges)
    .set({ state: 'expired' })
    .where(
      and(
        or(eq(nudges.state, 'pending'), eq(nudges.state, 'snoozed')),
        isNotNull(nudges.expiresAt),
        lt(nudges.expiresAt, now)
      )
    )
    .returning({ id: nudges.id });
  return expired.length;
}

/**
 * Queue reminders for habits that ask to be nagged and haven't been done yet.
 *
 * At most one live nudge per habit, and it expires after one interval — so the
 * habit reminds you *now or not at all*, rather than accumulating a debt.
 */
export async function sweepHabitReminders(now = Date.now()): Promise<number> {
  const due = await db
    .select()
    .from(habits)
    .where(and(eq(habits.active, 1), isNotNull(habits.reminderEveryMinutes)));

  if (due.length === 0) return 0;

  const live = await db
    .select({ habitId: nudges.habitId })
    .from(nudges)
    .where(or(eq(nudges.state, 'pending'), eq(nudges.state, 'snoozed')));
  const alreadyQueued = new Set(live.map((n) => n.habitId).filter(Boolean));

  let created = 0;
  for (const habit of due) {
    if (alreadyQueued.has(habit.id)) continue;

    const intervalMs = (habit.reminderEveryMinutes ?? 0) * 60_000;
    if (intervalMs <= 0) continue;

    // Already hit the target for this period — nothing to nag about.
    const periodKey = periodKeyFor(habit.cadence as 'daily' | 'weekly', new Date(now));
    const entries = await db
      .select()
      .from(habitEntries)
      .where(and(eq(habitEntries.habitId, habit.id), eq(habitEntries.periodKey, periodKey)));
    const done = entries.reduce((sum, e) => sum + e.count, 0);
    if (done >= habit.targetPerPeriod) continue;

    // Space reminders by the interval, measured from the last one raised —
    // whether it was delivered, ignored, or expired unseen.
    const [previous] = await db
      .select({ createdAt: nudges.createdAt })
      .from(nudges)
      .where(eq(nudges.habitId, habit.id))
      .orderBy(desc(nudges.createdAt))
      .limit(1);
    if (previous && previous.createdAt > now - intervalMs) continue;

    await db.insert(nudges).values({
      title: habit.name,
      body: `${done} of ${habit.targetPerPeriod} so far today`,
      habitId: habit.id,
      earliestAt: now,
      expiresAt: now + intervalMs,
      // Habits are small and frequent; they should never break a match, and
      // never carry a deadline that would escalate.
      minQuality: 'any',
    });
    created++;
  }

  return created;
}

/** How far ahead of a task's due time to start queueing a nudge for it. */
export const DUE_SOON_WINDOW_MS = 60 * 60_000;

/**
 * How long a task stays quiet after being nudged before it may nudge again.
 *
 * Without this the sweep re-queues a task the instant its nudge leaves the
 * pending set, and since the agent reports every couple of seconds, one ignored
 * task becomes a notification every couple of seconds. Ignoring a nudge is
 * information — it means "not now" — so the answer is to back off, not to
 * repeat.
 */
export const RENUDGE_COOLDOWN_MS = 45 * 60_000;

/**
 * Turn tasks that are coming due into queued nudges.
 *
 * Idempotent, so calling it on every attention report keeps the queue current
 * without a separate scheduler process.
 */
export async function sweepDueTasks(now = Date.now()): Promise<number> {
  const soon = now + DUE_SOON_WINDOW_MS;

  const dueTasks = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, 'todo'), lte(tasks.dueAt, soon), isNull(tasks.completedAt)));

  if (dueTasks.length === 0) return 0;

  const existing = await db
    .select({ taskId: nudges.taskId, state: nudges.state, deliveredAt: nudges.deliveredAt })
    .from(nudges)
    .where(inArray(nudges.taskId, dueTasks.map((t) => t.id)));

  const spokenFor = new Set<string>();
  for (const nudge of existing) {
    if (!nudge.taskId) continue;
    switch (nudge.state) {
      // Already waiting its turn.
      case 'pending':
      case 'snoozed':
      // Blake has seen it and made a call. Don't re-raise it.
      case 'acknowledged':
      case 'dismissed':
        spokenFor.add(nudge.taskId);
        break;
      case 'delivered':
        if ((nudge.deliveredAt ?? 0) > now - RENUDGE_COOLDOWN_MS) spokenFor.add(nudge.taskId);
        break;
    }
  }

  const fresh = dueTasks.filter((t) => !spokenFor.has(t.id));
  for (const task of fresh) {
    await db.insert(nudges).values({
      title: task.title,
      body: task.notes,
      taskId: task.id,
      earliestAt: Math.max(now, (task.dueAt ?? now) - DUE_SOON_WINDOW_MS),
      // The due time itself is the deadline: before it, wait for a good moment;
      // after it, interrupt.
      deadlineAt: task.dueAt,
      minQuality: task.priority >= 2 ? 'decent' : 'prime',
    });
  }

  return fresh.length;
}
