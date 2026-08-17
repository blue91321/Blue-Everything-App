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
  gaugeLevelAt,
  habitNagMinutes,
  habitWantsDoing,
  isAwayFromPc,
  quietReason,
  qualityRank,
  resolvePush,
  type AttentionReport,
  type AttentionState,
  type DeliverableNudge,
  type NudgeQuality,
  type StoppingQuality,
} from '@everything/shared';
import { db } from './db/client.js';
import { habitEntries, habits, nudges, settings, tasks } from './db/schema.js';
import { phones } from './push-port.js';
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
 * chair is a nudge spent for nothing, so nothing fires until you are back.
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
  /** For the agent to raise as Windows toasts. Empty when you aren't there. */
  deliver: DeliverableNudge[];
  /** How many reached the phone instead. */
  pushed: number;
  channel: 'toast' | 'push' | 'none';
  /** True when the PC has been untouched and silent long enough to count as empty. */
  awayFromPc: boolean;
}

interface Winner {
  nudge: DeliverableNudge;
  escalated: boolean;
  mayPush: boolean;
}

/** "4 days", "3 hours", "20 minutes" — enough to judge by, no more. */
function roughly(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${Math.round(hours / 24)} days`;
}

/**
 * How a habit reminder describes its own progress.
 *
 * One function across all three modes, because it is called from two places —
 * the sweep that raises the nudge and the re-check just before it is delivered —
 * and the whole point of that re-check is that the line it produces is *current*.
 * Two implementations would eventually disagree, and the symptom would be a
 * nudge whose text changed for no reason on the way out.
 */
function progressLine(
  habit: {
    mode: string;
    cadence: string;
    targetPerPeriod: number;
    gaugeLevel: number;
    gaugeLevelAt: number;
    gaugeDrainPerDay: number;
    gaugeRemindAt: number;
  },
  context: { done: number; lastDoneAt: number | null },
  now: number
): string {
  if (habit.mode === 'gauge') {
    const level = Math.round(gaugeLevelAt(habit, now));
    // Says which way it is going, not just where it is. "Empty" alone reads as
    // a fault; "down to 20%, draining 50% a day" reads as the thing working.
    // And it must not claim "empty" when a threshold raised it at 30%.
    return level <= 0
      ? `empty — it drains ${habit.gaugeDrainPerDay}% a day`
      : `down to ${level}% — it drains ${habit.gaugeDrainPerDay}% a day`;
  }

  if (habit.mode === 'interval') {
    return context.lastDoneAt === null
      ? 'not done yet'
      : `last done ${roughly(now - context.lastDoneAt)} ago`;
  }

  return `${context.done} of ${habit.targetPerPeriod} so far ${habit.cadence === 'weekly' ? 'this week' : 'today'}`;
}

/** The last time this habit was ticked off, ever — not just this period. */
async function lastDoneAtOf(habitId: string): Promise<number | null> {
  const [latest] = await db
    .select({ doneAt: habitEntries.doneAt })
    .from(habitEntries)
    .where(eq(habitEntries.habitId, habitId))
    .orderBy(desc(habitEntries.doneAt))
    .limit(1);
  return latest?.doneAt ?? null;
}

/**
 * Re-check a nudge against the world in the instant before it goes out.
 *
 * A nudge can sit in the queue for hours — that is the whole point of the
 * engine — and in that time the thing it is about may have been done. Habit
 * counts are the obvious case: `"3 of 8 so far today"` is baked in when the
 * reminder is raised, and a two-hour session is plenty of time to drink five
 * more glasses. Delivering that afterwards is worse than delivering nothing,
 * because it is *confidently wrong*, and the whole value of waiting for a good
 * moment is spent saying something untrue.
 *
 * The same applies to a task finished while its nudge was held. Nothing clears
 * a queued nudge when the underlying row changes — deliberately, since the
 * queue is the record of what was asked for — so the check belongs here, at the
 * one point where it is about to matter.
 *
 * Anything whose reason for existing has gone is marked `expired`: it was
 * dropped unfired, which is exactly what that state means. It is not
 * `acknowledged` (you never saw it) and not `dismissed` (you never chose).
 */
async function freshenForDelivery(winners: Winner[], now: number): Promise<Winner[]> {
  const drop = (id: string) => db.update(nudges).set({ state: 'expired' }).where(eq(nudges.id, id));
  const kept: Winner[] = [];

  for (const winner of winners) {
    const { id, habitId, taskId } = winner.nudge;

    if (habitId) {
      const [habit] = await db.select().from(habits).where(eq(habits.id, habitId));
      // Paused or deleted between raising and delivering.
      if (!habit || !habit.active) {
        await drop(id);
        continue;
      }

      const periodKey = periodKeyFor(habit.cadence as 'daily' | 'weekly', new Date(now));
      const entries = await db
        .select()
        .from(habitEntries)
        .where(and(eq(habitEntries.habitId, habitId), eq(habitEntries.periodKey, periodKey)));
      const done = entries.reduce((sum, entry) => sum + entry.count, 0);
      const lastDoneAt = await lastDoneAtOf(habitId);

      /*
       * Dealt with while it waited. Nagging now would be the reminder arriving
       * after the thing it was reminding you about.
       *
       * `habitWantsDoing` rather than a target comparison, so this covers a
       * gauge topped up during the match and an interval habit done on the
       * phone — both of which the old check would have delivered anyway,
       * confidently and wrongly, which is the exact failure this function
       * exists to prevent.
       */
      if (!habitWantsDoing(habit, { doneThisPeriod: done, lastDoneAt }, now)) {
        await drop(id);
        continue;
      }

      const body = progressLine(habit, { done, lastDoneAt }, now);
      if (body !== winner.nudge.body) {
        // Written back as well as corrected in flight, so the queue view and
        // the history agree with what was actually shown.
        await db.update(nudges).set({ body }).where(eq(nudges.id, id));
        winner.nudge.body = body;
      }
    }

    if (taskId) {
      const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
      // A deleted task cascades its nudges away, so absent here is a race
      // rather than a normal state — and either way there is nothing to say.
      if (!task || task.status === 'done' || task.status === 'dropped') {
        await drop(id);
        continue;
      }
    }

    kept.push(winner);
  }

  return kept;
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
   * You're really gone.
   */
  const awayFromPc = isAwayFromPc(report);
  const toPhone = awayFromPc && Boolean(prefs.pushEnabled) && !quiet;

  if (toPhone && phones().isOnCooldown(now)) {
    // Leave everything queued rather than marking it delivered — it will go out
    // on the next window, or as a toast the moment you sit back down.
    return { deliver: [], pushed: 0, channel: 'none', awayFromPc };
  }

  /**
   * `minQuality` asks "how good a break is this?" — a question about the PC.
   * With the chair empty there is no match to avoid interrupting, so the phone
   * counts as the best possible moment. Using 'any' here instead would have
   * meant a nudge asking for a `prime` break could never reach the phone at
   * all, which is the opposite of the intent.
   */
  const effectiveMoment = toPhone ? ('prime' as NudgeQuality) : moment;

  const candidates = await db
    .select()
    .from(nudges)
    .where(
      and(
        or(eq(nudges.state, 'pending'), eq(nudges.state, 'snoozed')),
        lte(nudges.earliestAt, now)
      )
    );

  const winners: { nudge: DeliverableNudge; escalated: boolean; mayPush: boolean }[] = [];
  for (const nudge of candidates) {
    const decision = shouldDeliver(nudge, { now, state: report.state, moment: effectiveMoment, quiet });
    if (!decision.deliver) continue;

    winners.push({
      escalated: decision.escalated,
      mayPush: Boolean(nudge.pushToPhone),
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

  // Everything above decided *whether the moment is good*. This decides whether
  // the nudge is still **true** — see `freshenForDelivery`.
  const live = await freshenForDelivery(winners, now);
  if (live.length === 0) {
    return { deliver: [], pushed: 0, channel: 'none', awayFromPc };
  }

  /**
   * On the phone leg, drop the ones that asked not to buzz a pocket.
   *
   * They are not consumed — nothing marks them delivered — so they simply keep
   * waiting and become a toast the moment you sit back down. That is the whole
   * point of the setting: "not worth a phone" and "not worth telling me" are
   * different claims, and only the first is being made here.
   */
  const going = toPhone ? live.filter((w) => w.mayPush) : live;
  // Checked before the send so a queue of desk-only nudges cannot spend the
  // ten-minute push cooldown on a notification that was never going out.
  if (going.length === 0) return { deliver: [], pushed: 0, channel: 'none', awayFromPc };

  // Send before marking anything delivered: with no phone subscribed, or the
  // push service refusing, these must stay queued rather than vanish unseen.
  let pushed = 0;
  if (toPhone) {
    const outcome = await phones().sendToPhones(going.map((w) => w.nudge), now);
    pushed = outcome.sent;
    if (pushed === 0) return { deliver: [], pushed: 0, channel: 'none', awayFromPc };
  }

  for (const { nudge, escalated } of going) {
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
    deliver: toPhone ? [] : going.map((w) => w.nudge),
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
/**
 * Has this habit's time of day arrived?
 *
 * Only a start, not a window: "remind me to walk from 2pm" should keep asking
 * until it's done or the day ends, and quiet hours already stop it at night.
 */
export function reminderWindowOpen(startMinute: number, at: Date): boolean {
  return at.getHours() * 60 + at.getMinutes() >= startMinute;
}

export async function sweepHabitReminders(now = Date.now()): Promise<number> {
  /*
   * Every active habit, not only those with a reminder interval set.
   *
   * `interval` mode falls back to its own interval for nag spacing, so "water
   * the plants every four days" needs no separate reminder field — filtering on
   * `reminder_every_minutes IS NOT NULL` here would have made that habit
   * silent, which is the one thing it is for. `habitNagMinutes` returning null
   * is what now means "never interrupt", and it is checked per habit below.
   */
  const due = await db.select().from(habits).where(eq(habits.active, 1));

  if (due.length === 0) return 0;

  // Resolved here rather than at delivery: the queued nudge should carry the
  // answer that applied when it was raised, and its habit may be gone by then.
  const pushDefault = Boolean((await getSettings()).pushDefault);

  const live = await db
    .select({ habitId: nudges.habitId })
    .from(nudges)
    .where(or(eq(nudges.state, 'pending'), eq(nudges.state, 'snoozed')));
  const alreadyQueued = new Set(live.map((n) => n.habitId).filter(Boolean));

  let created = 0;
  for (const habit of due) {
    if (alreadyQueued.has(habit.id)) continue;

    const nagMinutes = habitNagMinutes(habit);
    // Null is "appears in lists, never interrupts", which is the default and the
    // right one for most habits.
    if (nagMinutes === null) continue;
    const intervalMs = nagMinutes * 60_000;
    if (intervalMs <= 0) continue;

    // Not yet the time of day this habit wants to be raised at.
    if (habit.reminderStartMinute !== null && !reminderWindowOpen(habit.reminderStartMinute, new Date(now))) {
      continue;
    }

    const periodKey = periodKeyFor(habit.cadence as 'daily' | 'weekly', new Date(now));
    const entries = await db
      .select()
      .from(habitEntries)
      .where(and(eq(habitEntries.habitId, habit.id), eq(habitEntries.periodKey, periodKey)));
    const done = entries.reduce((sum, e) => sum + e.count, 0);
    /*
     * The last tick *ever*, which is not the same as the last one this period.
     * `interval` and `gauge` both span periods by definition — "every four days"
     * has nothing to do with a day or a week — so reading it out of the period's
     * entries would reset the timer at midnight.
     */
    const lastDoneAt = await lastDoneAtOf(habit.id);

    // Nothing wanted right now: the target is met, the interval has not elapsed,
    // or the gauge still has something in it.
    if (!habitWantsDoing(habit, { doneThisPeriod: done, lastDoneAt }, now)) continue;

    const [previous] = await db
      .select({ createdAt: nudges.createdAt, deliveredAt: nudges.deliveredAt })
      .from(nudges)
      .where(eq(nudges.habitId, habit.id))
      .orderBy(desc(nudges.createdAt))
      .limit(1);

    const lastTick = lastDoneAt ?? 0;

    /**
     * Space reminders from whichever happened later: the last reminder that
     * actually reached you, or the last time the habit was ticked off.
     *
     * Counting only from the reminder means drinking a glass of water two
     * minutes after being nudged still gets you nudged again on the original
     * schedule — which is exactly when it feels like nagging rather than
     * helping. Doing the thing should buy you the full interval.
     *
     * **`deliveredAt`, not `createdAt`**, and that is the difference between a
     * reminder and a queue. A nudge raised at ten and held through a match
     * until eleven has only just been *said*; measuring from when it was
     * written down would make the next one due immediately, so the reward for
     * a long session was two reminders in a minute. A reminder you never saw
     * did not remind you, so an undelivered one still counts from when it was
     * raised — the fallback below is doing real work, not defending a null.
     */
    const since = Math.max(previous?.deliveredAt ?? previous?.createdAt ?? 0, lastTick);
    if (since > now - intervalMs) continue;

    await db.insert(nudges).values({
      title: habit.name,
      body: progressLine(habit, { done, lastDoneAt }, now),
      habitId: habit.id,
      earliestAt: now,
      expiresAt: now + intervalMs,
      // Habits are small and frequent; they should never break a match, and
      // never carry a deadline that would escalate.
      minQuality: 'any',
      pushToPhone: resolvePush(habit.pushToPhone, pushDefault) ? 1 : 0,
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

  /**
   * All-day tasks need a wider net than the hour-before window.
   *
   * Their stored instant is the *end* of the due day, so "bins out today" sits
   * at 23:59 and would not be picked up until 22:59 — silent all day, then
   * escalating at bedtime. Widening to the end of today catches them, and the
   * filter below decides which are genuinely eligible.
   */
  const horizon = Math.max(soon, startOfDayFor(now) + 24 * 60 * 60_000 - 1);

  const candidates = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, 'todo'), lte(tasks.dueAt, horizon), isNull(tasks.completedAt)));

  const dueTasks = candidates.filter((task) =>
    task.dueIsAllDay
      ? // Eligible from the morning of the day it's due.
        startOfDayFor(task.dueAt ?? now) <= now
      : (task.dueAt ?? 0) <= soon
  );

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
      // You have seen it and made a call. Don't re-raise it.
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
  // Read once for the batch rather than per task — see `sweepHabitReminders`.
  const pushDefault = fresh.length > 0 ? Boolean((await getSettings()).pushDefault) : true;

  for (const task of fresh) {
    /**
     * An all-day task is due *that day*, not at 23:59 — so it becomes eligible
     * from the morning rather than an hour before midnight. Using the stored
     * instant would mean a task due today sat silent until nearly bedtime and
     * then escalated, which is the worst of both.
     */
    const earliestAt = task.dueIsAllDay
      ? Math.max(now, startOfDayFor(task.dueAt ?? now))
      : Math.max(now, (task.dueAt ?? now) - DUE_SOON_WINDOW_MS);

    await db.insert(nudges).values({
      title: task.title,
      body: task.notes,
      taskId: task.id,
      earliestAt,
      // The due time itself is the deadline: before it, wait for a good moment;
      // after it, interrupt. For an all-day task that is the end of the day.
      deadlineAt: task.dueAt,
      minQuality: task.priority >= 2 ? 'decent' : 'prime',
      pushToPhone: resolvePush(task.pushToPhone, pushDefault) ? 1 : 0,
    });
  }

  return fresh.length;
}

/** Local midnight of whichever day `at` falls in. */
function startOfDayFor(at: number): number {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}
