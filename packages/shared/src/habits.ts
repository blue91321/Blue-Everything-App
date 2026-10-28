/**
 * Habits: counted, on an interval, or a gauge that drains, and when each
 * wants doing.
 */
import { z } from 'zod';
import { patchOf } from './patch.js';

/* ------------------------------------------------------------------ */
/* Habits                                                              */
/* ------------------------------------------------------------------ */

export const cadences = ['daily', 'weekly'] as const;
export const cadenceSchema = z.enum(cadences);
export type Cadence = z.infer<typeof cadenceSchema>;

/**
 * The three shapes a habit can take.
 *
 * They differ in one question and one only — **when does this habit want
 * doing?** Everything else about a habit is shared: entries are recorded the
 * same way, reminders are spaced the same way, and the nudge engine holds and
 * releases them identically. Adding a fourth mode means answering that one
 * question again and nothing else.
 *
 *   - `target`   N times per day or week. The original, and still the default.
 *   - `interval` no target at all — due again a fixed time after you last did
 *                it. "Water the plants, every four days" is not three-a-week and
 *                pretending it is makes the count meaningless.
 *   - `gauge`    a level that drains and is topped up by doing the thing. The
 *                same information as `interval` really, drawn rather than
 *                counted — which turns out to matter, because a shape that is
 *                visibly half empty is read at a glance where "last done 2 days
 *                ago" has to be worked out.
 */
export const habitModes = ['target', 'interval', 'gauge'] as const;
export const habitModeSchema = z.enum(habitModes);
export type HabitMode = (typeof habitModes)[number];

/**
 * What the gauge is drawn as.
 *
 * Four shapes, or **any emoji**, which is the same decision the overlay avatar
 * made and for the same reason: Windows and every browser here draw emoji in
 * colour, so a gallery of pictures costs no checked-in binaries and no upload
 * route. "A picture that empties" is satisfied by 🪴 or 💧 far more cheaply
 * than by a file per habit.
 *
 * Anything that is not one of the four names is treated as the emoji to draw,
 * so this is validated for *length* rather than against a list — the same
 * opaque-value reasoning as `settings.dashboard_panel`.
 */
export const gaugeShapes = ['circle', 'square', 'triangle', 'bar'] as const;

/** A gauge is full at 100 and wants doing at 0. Percent, so the maths reads. */
export const GAUGE_FULL = 100;

/**
 * Where a draining gauge is *right now*.
 *
 * **The level is stored, not derived from the last tick**, and the difference is
 * the whole reason for the two columns. Deriving it — `full minus time since you
 * last did it` — cannot express a gauge you topped up twice in a morning, and
 * cannot express one you neglected for a fortnight and then filled halfway. Both
 * are things people actually do, and both are the state a gauge is *for*.
 *
 * What is stored is an anchor: a level, and the moment that level was true.
 * Everything between anchors is computed here. So nothing runs on a timer —
 * which this project requires of anything that would otherwise tick — and the
 * database is written once per action rather than once per minute.
 */
export function gaugeLevelAt(
  habit: { gaugeLevel: number; gaugeLevelAt: number; gaugeDrainPerDay: number },
  now = Date.now()
): number {
  const days = (now - habit.gaugeLevelAt) / 86_400_000;
  // A negative elapsed time means the clock moved backwards — a resumed laptop,
  // a corrected timezone. Draining by a negative amount would *fill* the gauge,
  // so it is clamped to the stored level rather than trusted.
  const drained = habit.gaugeLevel - habit.gaugeDrainPerDay * Math.max(0, days);
  return Math.max(0, Math.min(GAUGE_FULL, drained));
}

/**
 * The new anchor after doing the thing once.
 *
 * Topping up from the *current* level rather than jumping to full is what makes
 * a partial fill mean anything: a gauge set to fill 25% per tick takes four
 * glasses of water to refill from empty, which is the point of that setting.
 */
export function gaugeAfterFill(
  habit: { gaugeLevel: number; gaugeLevelAt: number; gaugeDrainPerDay: number; gaugeFillPercent: number },
  now = Date.now(),
  /** How many ticks at once — "I drank two waters" is two fills, not one. */
  times = 1
): { gaugeLevel: number; gaugeLevelAt: number } {
  const level = Math.min(GAUGE_FULL, gaugeLevelAt(habit, now) + habit.gaugeFillPercent * Math.max(1, times));
  return { gaugeLevel: level, gaugeLevelAt: now };
}

/**
 * And undoing one.
 *
 * **Not a true inverse, and it cannot be.** Filling clamps at 100, so a tick
 * that would have taken a gauge to 130 loses the overflow, and there is nothing
 * left to give back. This subtracts the fill amount from wherever the gauge is
 * now, which is right in every case except the one that had already clamped —
 * where it leaves the gauge lower than it was before the tick it is undoing.
 * Storing the overflow to make undo exact would mean a level that reads 100 and
 * secretly holds 130, which is a worse lie than an imperfect undo.
 */
export function gaugeAfterUndo(
  habit: { gaugeLevel: number; gaugeLevelAt: number; gaugeDrainPerDay: number; gaugeFillPercent: number },
  now = Date.now()
): { gaugeLevel: number; gaugeLevelAt: number } {
  const level = Math.max(0, gaugeLevelAt(habit, now) - habit.gaugeFillPercent);
  return { gaugeLevel: level, gaugeLevelAt: now };
}

/**
 * How long until a draining gauge is down to `level`, in ms. Null if never.
 *
 * For the countdowns on the Dashboard rather than for anything the nudge engine
 * decides — the engine asks whether the gauge is *past its threshold now*, on
 * the sweep it already runs, and schedules nothing against this. Which is what
 * keeps a gauge free of timers: the arithmetic is only ever done when somebody
 * is looking.
 */
export function gaugeReachesInMs(
  habit: { gaugeLevel: number; gaugeLevelAt: number; gaugeDrainPerDay: number },
  level: number,
  now = Date.now()
): number | null {
  if (habit.gaugeDrainPerDay <= 0) return null;
  const current = gaugeLevelAt(habit, now);
  if (current <= level) return 0;
  return ((current - level) / habit.gaugeDrainPerDay) * 86_400_000;
}

/** How long until it is empty. The `level: 0` case, named for the common one. */
export function gaugeEmptyInMs(
  habit: { gaugeLevel: number; gaugeLevelAt: number; gaugeDrainPerDay: number },
  now = Date.now()
): number | null {
  return gaugeReachesInMs(habit, 0, now);
}

/**
 * Does this habit want doing right now?
 *
 * The one question the three modes answer differently, in one place, so the
 * sweep, the API and the screens cannot disagree — the same role `resolvePush`
 * and `quietReason` play for their own decisions.
 */
export function habitWantsDoing(
  habit: {
    mode: string;
    targetPerPeriod: number;
    intervalMinutes: number | null;
    gaugeLevel: number;
    gaugeLevelAt: number;
    gaugeDrainPerDay: number;
    gaugeRemindAt?: number;
  },
  context: { doneThisPeriod: number; lastDoneAt: number | null },
  now = Date.now()
): boolean {
  /*
   * At or below the threshold, not merely empty.
   *
   * Empty-only was the first version and it is the wrong moment for anything
   * that takes a while to act on: a plant reminds you when it is dead, and a
   * water gauge draining at 200% a day gives you no warning at all. The
   * threshold is the level at which it starts asking, and 0 — the default —
   * keeps the original behaviour exactly.
   */
  if (habit.mode === 'gauge') return gaugeLevelAt(habit, now) <= (habit.gaugeRemindAt ?? 0);

  if (habit.mode === 'interval') {
    // No interval set is a half-configured habit, not a habit that is always
    // due. Always-due would nag forever on something nobody finished setting up.
    if (!habit.intervalMinutes || habit.intervalMinutes <= 0) return false;
    // Never done is due now — that is the first reminder, and it is the one that
    // gets the habit started.
    if (context.lastDoneAt === null) return true;
    return now - context.lastDoneAt >= habit.intervalMinutes * 60_000;
  }

  return context.doneThisPeriod < habit.targetPerPeriod;
}

/**
 * Is this habit **finished** — done with, and belonging under "Finished today"?
 *
 * **Not the same question as `habitWantsDoing`, and collapsing them was a
 * mistake worth spelling out.** "Should this interrupt me right now" and "is
 * there nothing left to do today" look identical for a counted habit, where
 * hitting the target answers both. They come apart for the two newer modes, and
 * the symptom was a gauge sitting under *Finished today* at 20% full.
 *
 *   - `target`   the target is met. Period-scoped, so it clears at midnight.
 *   - `interval` you did it today *and* it is not due again yet. Both halves
 *                are needed: a four-hour habit done at nine is due again by two,
 *                and one done last Tuesday was not done today whatever its
 *                interval says.
 *   - `gauge`    **never.** A gauge is draining the moment it is full, so there
 *                is no instant at which it is finished — which is exactly why a
 *                full one still belongs in the list rather than under a heading
 *                saying you are done with it.
 */
export function habitIsFinished(
  habit: {
    mode: string;
    targetPerPeriod: number;
    intervalMinutes: number | null;
    gaugeLevel: number;
    gaugeLevelAt: number;
    gaugeDrainPerDay: number;
    gaugeRemindAt?: number;
  },
  context: { doneThisPeriod: number; lastDoneAt: number | null; startOfToday: number },
  now = Date.now()
): boolean {
  if (habit.mode === 'gauge') return false;

  if (habit.mode === 'interval') {
    if (context.lastDoneAt === null || context.lastDoneAt < context.startOfToday) return false;
    return !habitWantsDoing(habit, context, now);
  }

  return context.doneThisPeriod >= habit.targetPerPeriod;
}

/**
 * How often to nag while it wants doing.
 *
 * `interval` falls back to its own interval, so the ordinary case — "remind me
 * every four days" — is one number rather than two. Setting both is for the case
 * that genuinely needs them: due every four days, and once it *is* due, say so
 * every couple of hours until it is done.
 *
 * Null means never interrupt, which stays the default for every mode: a habit
 * you have not asked to be reminded about should appear in a list and nothing
 * more.
 */
export function habitNagMinutes(habit: {
  mode: string;
  reminderEveryMinutes: number | null;
  intervalMinutes: number | null;
}): number | null {
  if (habit.reminderEveryMinutes) return habit.reminderEveryMinutes;
  if (habit.mode === 'interval' && habit.intervalMinutes) return habit.intervalMinutes;
  return null;
}

export const createHabitSchema = z.object({
  name: z.string().min(1).max(200),
  notes: z.string().max(20_000).nullish(),
  mode: habitModeSchema.default('target'),
  cadence: cadenceSchema.default('daily'),
  targetPerPeriod: z.number().int().positive().default(1),
  /** `interval` mode: due again this long after the last time you did it. */
  intervalMinutes: z.number().int().min(5).max(365 * 24 * 60).nullish(),
  /** `gauge` mode: how much of the gauge drains away in a day. */
  gaugeDrainPerDay: z.number().int().min(1).max(1000).default(100),
  /** `gauge` mode: how much one tick puts back. */
  gaugeFillPercent: z.number().int().min(1).max(100).default(100),
  /**
   * `gauge` mode: the level at or below which it starts asking to be done.
   *
   * 0 is "when it is empty", which is where this started and stays the default.
   * Capped below full because a threshold of 100 would mean "always", which is
   * not a reminder — it is the absence of one.
   */
  gaugeRemindAt: z.number().int().min(0).max(90).default(0),
  /**
   * One of `gaugeShapes`, or an emoji. Not validated against the list — see the
   * note there; an unknown value is drawn as whatever it is.
   */
  gaugeShape: z.string().min(1).max(16).default('circle'),
  active: z.boolean().default(true),
  sortOrder: z.number().int().optional(),
  /** Nag every N minutes while it wants doing; null to never interrupt. */
  reminderEveryMinutes: z.number().int().min(5).max(24 * 60).nullish(),
  /**
   * Minutes since local midnight before reminders may start. Null means as
   * soon as the period begins.
   */
  reminderStartMinute: z.number().int().min(0).max(24 * 60 - 1).nullish(),
  /** May this reach the phone? Null follows the default — see `resolvePush`. */
  pushToPhone: z.boolean().nullish(),
  /**
   * Things you might say to tick this off — "i drank water", "had a glass".
   * Empty means the habit can't be reached by voice at all, which is the
   * default: a habit nobody has written a phrase for should never win a match.
   */
  voicePhrases: z.array(z.string().min(1).max(120)).max(20).default([]),
});
export const updateHabitSchema = patchOf(createHabitSchema);

/** Whole-list reorder: ids in the order they should appear. */
export const reorderSchema = z.object({ ids: z.array(z.string().uuid()).max(500) });
