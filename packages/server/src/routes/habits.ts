import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  GAUGE_FULL,
  createHabitSchema,
  gaugeAfterFill,
  gaugeAfterUndo,
  gaugeEmptyInMs,
  gaugeReachesInMs,
  gaugeLevelAt,
  habitIsFinished,
  habitWantsDoing,
  ticksFor,
  reorderSchema,
  updateHabitSchema,
  type Cadence,
  type SpokenAmount,
} from '@everything/shared';
import { db } from '../db/client.js';
import { habitEntries, habits } from '../db/schema.js';

/**
 * The bucket a moment belongs to: `2026-08-05` for daily habits, `2026-W32`
 * for weekly. Computed from local time on purpose — a habit done at 11pm
 * belongs to that day as you experienced it, not as UTC saw it.
 */
export function periodKeyFor(cadence: Cadence, at = new Date()): string {
  const year = at.getFullYear();
  if (cadence === 'daily') {
    const month = String(at.getMonth() + 1).padStart(2, '0');
    const day = String(at.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  // ISO week: Thursday of the current week decides which year the week is in.
  const thursday = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  thursday.setDate(thursday.getDate() + 3 - ((thursday.getDay() + 6) % 7));
  const firstThursday = new Date(thursday.getFullYear(), 0, 4);
  const week =
    1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60_000));
  return `${thursday.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * A picture of your own for a gauge, on disk beside the database.
 *
 * Not in it: a habits list is fetched on every page load and has no business
 * carrying a JPEG. Same arrangement as the app logo and the overlay avatar, and
 * the path is resolved from this file rather than the working directory for the
 * same reason they are — Task Scheduler starts the server in System32, where a
 * relative path writes somewhere nobody would ever look.
 */
const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const CONTENT_TYPE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

const imagePath = (habitId: string, extension: string): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), '../../data', `habit-${habitId}.${extension}`);

function storedImage(habitId: string): { path: string; extension: string } | null {
  for (const extension of Object.values(IMAGE_TYPES)) {
    const path = imagePath(habitId, extension);
    if (existsSync(path)) return { path, extension };
  }
  return null;
}

/** Local midnight — a habit ticked at 11pm belongs to that day as you lived it. */
function startOfTodayAt(now: number): number {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return midnight.getTime();
}

/** What a caller needs to know after ticking something off. */
export interface HabitProgress {
  habit: typeof habits.$inferSelect;
  doneThisPeriod: number;
  lastDoneAt: number | null;
  /** 0–100 for a gauge, null otherwise. */
  gaugeNow: number | null;
  /** Finished — see `habitIsFinished`. Not the negation of `wantsDoing`. */
  met: boolean;
  wantsDoing: boolean;
  /** One line to say out loud, right for whichever mode this is. */
  say: string;
}

/**
 * Record that a habit was done, whoever asked.
 *
 * **Exported because there are two callers and there were nearly two
 * implementations.** The HTTP route had one and the voice feature had another —
 * it inserted an entry itself — so when gauge mode arrived and the fill was
 * added to the route, saying "I drank water" logged the entry and left the gauge
 * exactly where it was. Reported as the voice command not updating it, and it
 * was not: it did half the job silently.
 *
 * Anything that records a completion goes through here now. Living beside
 * `periodKeyFor`, which the engine and the voice feature already both import
 * from this module for the same reason.
 */
export async function recordHabitDone(
  habitId: string,
  /**
   * A number, or `'max'` for "all the way" — which is a different number in
   * every mode, so it is resolved here where the habit is in hand rather than
   * by the caller, who would have to fetch the row to work it out.
   */
  amount: SpokenAmount = 1,
  now = Date.now()
): Promise<HabitProgress | null> {
  const [habit] = await db.select().from(habits).where(eq(habits.id, habitId));
  if (!habit) return null;

  const periodKey = periodKeyFor(habit.cadence as Cadence, new Date(now));
  const already = await db
    .select()
    .from(habitEntries)
    .where(and(eq(habitEntries.habitId, habitId), eq(habitEntries.periodKey, periodKey)));
  const count = ticksFor(habit, amount, {
    doneThisPeriod: already.reduce((sum, e) => sum + e.count, 0),
  }, now);

  await db.insert(habitEntries).values({ habitId, periodKey, count });

  /*
   * The gauge additionally moves its anchor, because the level is not derivable
   * from the entries — two ticks an hour apart leave a different level than two
   * a week apart. `count` fills that many times, so "two waters" is two.
   */
  const moved = habit.mode === 'gauge' ? gaugeAfterFill(habit, now, count) : null;
  if (moved) await db.update(habits).set(moved).where(eq(habits.id, habitId));

  return describeProgress({ ...habit, ...(moved ?? {}) }, now);
}

/** Undo one. See the route below for why a gauge is not gated on an entry. */
export async function undoHabitDone(habitId: string, now = Date.now()): Promise<HabitProgress | null> {
  const [habit] = await db.select().from(habits).where(eq(habits.id, habitId));
  if (!habit) return null;

  const key = periodKeyFor(habit.cadence as Cadence, new Date(now));
  const [latest] = await db
    .select()
    .from(habitEntries)
    .where(and(eq(habitEntries.habitId, habitId), eq(habitEntries.periodKey, key)))
    .orderBy(desc(habitEntries.doneAt))
    .limit(1);

  if (latest) await db.delete(habitEntries).where(eq(habitEntries.id, latest.id));

  const moved = habit.mode === 'gauge' ? gaugeAfterUndo(habit, now) : null;
  if (moved) await db.update(habits).set(moved).where(eq(habits.id, habitId));

  return { ...(await describeProgress({ ...habit, ...(moved ?? {}) }, now))!, removed: latest ? 1 : 0 } as
    HabitProgress & { removed: number };
}

/** The state of one habit, in the vocabulary every caller wants. */
async function describeProgress(
  habit: typeof habits.$inferSelect,
  now: number
): Promise<HabitProgress> {
  const periodKey = periodKeyFor(habit.cadence as Cadence, new Date(now));
  const entries = await db
    .select()
    .from(habitEntries)
    .where(and(eq(habitEntries.habitId, habit.id), eq(habitEntries.periodKey, periodKey)));
  const doneThisPeriod = entries.reduce((sum, e) => sum + e.count, 0);

  const [latest] = await db
    .select({ doneAt: habitEntries.doneAt })
    .from(habitEntries)
    .where(eq(habitEntries.habitId, habit.id))
    .orderBy(desc(habitEntries.doneAt))
    .limit(1);
  const lastDoneAt = latest?.doneAt ?? null;

  const context = { doneThisPeriod, lastDoneAt, startOfToday: startOfTodayAt(now) };
  const gaugeNow = habit.mode === 'gauge' ? Math.round(gaugeLevelAt(habit, now)) : null;

  /*
   * The spoken line, per mode. It was hard-coded to "3 of 8" wherever a habit
   * was ticked off, which for a gauge is a sentence about a target it does not
   * have — the voice reply said "Drink water — 1 of 16" for something whose
   * whole state is a percentage.
   */
  const say =
    habit.mode === 'gauge'
      ? `${habit.name} — ${gaugeNow}% full`
      : habit.mode === 'interval'
        ? `${habit.name} — done`
        : `${habit.name} — ${doneThisPeriod} of ${habit.targetPerPeriod}`;

  return {
    habit,
    doneThisPeriod,
    lastDoneAt,
    gaugeNow,
    met: habitIsFinished(habit, context, now),
    wantsDoing: habitWantsDoing(habit, context, now),
    say,
  };
}

/**
 * `voice_phrases` is a JSON column, so it crosses the API boundary as a real
 * array and never leaks its storage format to the PWA. A malformed value —
 * only reachable by hand-editing the database — reads as "no phrases" rather
 * than taking the habits list down with it.
 */
function parsePhrases(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/** Three states into a nullable integer — see the same helper in `tasks.ts`. */
function normalisePush(body: { pushToPhone?: boolean | null }) {
  if (body.pushToPhone === undefined) return {};
  return { pushToPhone: body.pushToPhone === null ? null : body.pushToPhone ? 1 : 0 };
}

export async function habitRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/habits', async () => {
    const now = Date.now();
    const startOfToday = startOfTodayAt(now);
    const all = await db
      .select()
      .from(habits)
      .orderBy(desc(habits.active), asc(habits.sortOrder), asc(habits.name));

    return Promise.all(
      all.map(async (habit) => {
        const key = periodKeyFor(habit.cadence as Cadence);
        const entries = await db
          .select()
          .from(habitEntries)
          .where(and(eq(habitEntries.habitId, habit.id), eq(habitEntries.periodKey, key)));
        const done = entries.reduce((sum, e) => sum + e.count, 0);

        /*
         * The last tick *ever*, not the last one this period. `interval` mode
         * spans periods by definition — "every four days" has nothing to do
         * with a day or a week — so reading it out of the period's entries
         * would reset the timer at midnight and make a four-day habit due
         * every morning.
         */
        const [lastEntry] = await db
          .select({ doneAt: habitEntries.doneAt })
          .from(habitEntries)
          .where(eq(habitEntries.habitId, habit.id))
          .orderBy(desc(habitEntries.doneAt))
          .limit(1);
        const lastDoneAt = lastEntry?.doneAt ?? null;

        return {
          ...habit,
          voicePhrases: parsePhrases(habit.voicePhrases),
          periodKey: key,
          doneThisPeriod: done,
          lastDoneAt,
          /*
           * The live gauge level, computed here rather than left to the PWA.
           *
           * The browser could do the arithmetic — it is one subtraction — but
           * then the level would depend on the *device's* clock, and a phone a
           * few minutes out would show a different gauge from the PC. The whole
           * reason settings live server-side is that two screens disagreeing
           * reads as the app being broken.
           */
          gaugeNow: Math.round(gaugeLevelAt(habit, now)),
          /*
           * Whether a picture has been uploaded, which is not the same as
           * whether the gauge is *set* to use one — somebody who uploads a
           * photo, switches to a triangle, and comes back should find the photo
           * still there. The editor needs both answers.
           */
          hasImage: storedImage(habit.id) !== null,
          gaugeEmptyInMs: gaugeEmptyInMs(habit, now),
          /*
           * And how long until it starts *asking*, which is the number you
           * actually plan around — "empty in 6 hours" is no use if it reminds
           * you at 30%. Both are sent; the row shows the second only when the
           * threshold is above zero, since at zero they are the same instant.
           */
          gaugeRemindInMs: gaugeReachesInMs(habit, habit.gaugeRemindAt, now),
          /*
           * **`met` means finished — done with, belongs under "Finished today".**
           *
           * It briefly meant "nothing wanted right now" instead, on the
           * reasoning that one word could serve both the screens and the nudge
           * engine. It cannot: the two questions are the same for a counted
           * habit and come apart for the other two, and the symptom was a gauge
           * at 20% sitting under a heading saying you were done with it. The
           * engine asks `habitWantsDoing` for itself; every screen asks this.
           */
          met: habitIsFinished(habit, { doneThisPeriod: done, lastDoneAt, startOfToday }, now),
          /** Wants doing *now* — what the nudge engine acts on, for the screens
           *  that want to say so. Not the negation of `met`; see above. */
          wantsDoing: habitWantsDoing(habit, { doneThisPeriod: done, lastDoneAt }, now),
        };
      })
    );
  });

  app.post('/api/habits', async (request, reply) => {
    const body = createHabitSchema.parse(request.body);

    // New habits go to the bottom of the hand-ordered list.
    const existing = await db.select({ sortOrder: habits.sortOrder }).from(habits);
    const nextOrder = existing.reduce((max, h) => Math.max(max, h.sortOrder), 0) + 1;

    // `pushToPhone` out of the spread — `normalisePush` contributes nothing on
    // one branch, which leaves the schema's boolean where the column wants an
    // integer. `active` is overridden unconditionally below, so it is fine.
    const { pushToPhone, ...rest } = body;
    const [created] = await db
      .insert(habits)
      .values({
        ...rest,
        ...normalisePush(body),
        active: body.active ? 1 : 0,
        sortOrder: body.sortOrder ?? nextOrder,
        voicePhrases: JSON.stringify(body.voicePhrases),
        // A new gauge starts full, from now. Without the anchor it would inherit
        // the column default of 0 — the epoch — and compute as empty the instant
        // it was created, which looks exactly like a broken feature.
        gaugeLevel: GAUGE_FULL,
        gaugeLevelAt: Date.now(),
      })
      .returning();
    return reply.code(201).send({ ...created, voicePhrases: parsePhrases(created.voicePhrases) });
  });

  app.patch('/api/habits/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    // Pulled out of the spread rather than overridden after it: the column is
    // JSON text but the schema is an array, and leaving both in scope makes the
    // written type `string | string[]`.
    const { voicePhrases, active, pushToPhone, ...body } = updateHabitSchema.parse(request.body);

    const [before] = await db.select().from(habits).where(eq(habits.id, id));
    if (!before) return reply.code(404).send({ error: 'no such habit' });

    /*
     * Turning a habit into a gauge starts it full, from now.
     *
     * A habit that has been `target` mode for a year has never had an anchor
     * written, so its `gauge_level_at` is the migration's 0 — the epoch — and it
     * would compute as bone empty the moment you switched modes. Nudging you
     * about a habit within a second of configuring it is the worst possible
     * first impression of the mode.
     *
     * Only on the *transition*, so editing the drain rate of a gauge that is
     * already half empty does not secretly refill it.
     */
    const becomingGauge = body.mode === 'gauge' && before.mode !== 'gauge';

    /*
     * The same guard `settings.logoShape` has, for the same reason: `image` with
     * nothing uploaded draws the fallback shape, which looks exactly like the
     * upload having failed. The schema cannot see the disk, so the route must.
     */
    if (body.gaugeShape === 'image' && storedImage(id) === null) {
      return reply.code(400).send({ error: 'upload a picture first — there is nothing to show yet' });
    }

    const [updated] = await db
      .update(habits)
      .set({
        ...body,
        ...normalisePush({ pushToPhone }),
        ...(active === undefined ? {} : { active: active ? 1 : 0 }),
        ...(voicePhrases === undefined ? {} : { voicePhrases: JSON.stringify(voicePhrases) }),
        ...(becomingGauge ? { gaugeLevel: GAUGE_FULL, gaugeLevelAt: Date.now() } : {}),
      })
      .where(eq(habits.id, id))
      .returning();
    if (!updated) return reply.code(404).send({ error: 'no such habit' });
    return { ...updated, voicePhrases: parsePhrases(updated.voicePhrases) };
  });

  app.delete('/api/habits/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    // habit_entries cascade, so the streak history goes with it. The picture is
    // a file rather than a row, so nothing cascades to it — without this, every
    // deleted gauge would leave a JPEG in `data/` forever.
    for (const extension of Object.values(IMAGE_TYPES)) {
      await rm(imagePath(id, extension), { force: true }).catch(() => {});
    }
    await db.delete(habits).where(eq(habits.id, id));
    return reply.code(204).send();
  });

  /** Whole-list reorder in one call, so a drag or a nudge up is one round trip. */
  app.post('/api/habits/reorder', async (request) => {
    const { ids } = reorderSchema.parse(request.body);
    await Promise.all(
      ids.map((habitId, index) => db.update(habits).set({ sortOrder: index }).where(eq(habits.id, habitId)))
    );
    return { ok: true, count: ids.length };
  });

  /** Record a completion for the current period. */
  app.post('/api/habits/:id/check', async (request, reply) => {
    const { id } = request.params as { id: string };
    // Everything is in `recordHabitDone`, which the voice feature calls too —
    // the two used to have their own copies and only one of them grew a gauge.
    const progress = await recordHabitDone(id);
    if (!progress) return reply.code(404).send({ error: 'no such habit' });

    return reply.code(201).send({
      habitId: id,
      doneThisPeriod: progress.doneThisPeriod,
      gaugeNow: progress.gaugeNow,
      met: progress.met,
      wantsDoing: progress.wantsDoing,
    });
  });

  /**
   * Undo one completion.
   *
   * Removes the most recent entry rather than zeroing the count, so a habit
   * with a target of 3 goes 3 -> 2 and a mis-tap costs one tap to fix.
   *
   * **A gauge is not gated on there being an entry in this period, and that is
   * the whole difference.** For a counted habit "nothing to undo" is a true
   * statement about today; for a gauge the level *is* the state, and it was very
   * likely last filled yesterday. Returning early left the − button working
   * exactly once and then silently doing nothing, which is indistinguishable
   * from a broken button — found by pressing it three times and watching the
   * level stop at 75%.
   */
  app.post('/api/habits/:id/uncheck', async (request, reply) => {
    const { id } = request.params as { id: string };
    const progress = await undoHabitDone(id);
    if (!progress) return reply.code(404).send({ error: 'no such habit' });

    return {
      removed: (progress as HabitProgress & { removed: number }).removed,
      doneThisPeriod: progress.doneThisPeriod,
      gaugeNow: progress.gaugeNow,
    };
  });

  /* ---- a picture of your own ------------------------------------- */

  /**
   * The gauge picture, read back.
   *
   * **Under `/api/`, unlike the icons and the tones**, and the difference is
   * what it carries. Those are a colour and a sine wave, fetched by machinery
   * that will never send a bearer token — the browser's installer, an `<audio>`
   * element. This is a picture you uploaded, which is personal in the way the
   * rest of the database is, so it stays behind auth and the PWA fetches it with
   * its token and makes an object URL. That costs a few lines in the component
   * and is the right side of the trade.
   */
  app.get('/api/habits/:id/image', async (request, reply) => {
    const { id } = request.params as { id: string };
    const stored = storedImage(id);
    if (!stored) return reply.code(404).send({ error: 'no picture for that habit' });

    return reply
      .type(CONTENT_TYPE[stored.extension] ?? 'application/octet-stream')
      // Cached hard and busted by `updatedAt` in the URL the client builds —
      // the bytes at a given version never change.
      .header('cache-control', 'private, max-age=86400')
      .send(await readFile(stored.path));
  });

  /**
   * Upload one.
   *
   * Base64 in JSON rather than multipart, matching the logo and the avatar: the
   * server registers no multipart parser and adding one for an endpoint used
   * twice a year is a dependency for nothing.
   *
   * **Not local-only**, unlike the app logo. That restriction is there because
   * the logo is a property of *this machine's* installation; a habit is your
   * data, editable from the phone like everything else about it, and a picture
   * for one is no different.
   */
  app.put('/api/habits/:id/image', async (request, reply) => {
    const { id } = request.params as { id: string };
    const [habit] = await db.select().from(habits).where(eq(habits.id, id));
    if (!habit) return reply.code(404).send({ error: 'no such habit' });

    const body = z
      .object({
        /** Bare base64, no `data:` prefix — the client strips it. */
        data: z.string().min(1).max(3 * 1024 * 1024),
        type: z.string().max(100),
      })
      .parse(request.body);

    const extension = IMAGE_TYPES[body.type];
    if (!extension) return reply.code(400).send({ error: 'needs to be a PNG, JPEG, GIF or WebP' });

    const bytes = Buffer.from(body.data, 'base64');
    if (bytes.length === 0) return reply.code(400).send({ error: 'that file was empty' });

    // One picture per habit: the old one goes, so swapping a PNG for a JPEG does
    // not leave the previous file behind for `storedImage` to find first.
    for (const old of Object.values(IMAGE_TYPES)) {
      await rm(imagePath(id, old), { force: true }).catch(() => {});
    }
    await writeFile(imagePath(id, extension), bytes);

    /*
     * Point the gauge at it and touch the row. The touch is load-bearing: the
     * PWA keys its object-URL cache on `updatedAt`, so without it a replaced
     * picture would keep showing the old one until something else changed.
     */
    const [updated] = await db
      .update(habits)
      .set({ gaugeShape: 'image', updatedAt: Date.now() })
      .where(eq(habits.id, id))
      .returning();

    return { ok: true, bytes: bytes.length, updatedAt: updated.updatedAt };
  });

  app.delete('/api/habits/:id/image', async (request, reply) => {
    const { id } = request.params as { id: string };
    const [habit] = await db.select().from(habits).where(eq(habits.id, id));
    if (!habit) return reply.code(404).send({ error: 'no such habit' });

    for (const old of Object.values(IMAGE_TYPES)) {
      await rm(imagePath(id, old), { force: true }).catch(() => {});
    }

    await db
      .update(habits)
      .set({
        // Only reset the shape if it was pointing at the file. Somebody who
        // uploaded a picture, switched to a triangle, then deleted the picture
        // should still have a triangle — the same rule the app logo follows.
        ...(habit.gaugeShape === 'image' ? { gaugeShape: 'circle' } : {}),
        updatedAt: Date.now(),
      })
      .where(eq(habits.id, id));

    return reply.code(204).send();
  });

  app.get('/api/habits/:id/entries', async (request) => {
    const { id } = request.params as { id: string };
    return db
      .select()
      .from(habitEntries)
      .where(eq(habitEntries.habitId, id))
      .orderBy(desc(habitEntries.doneAt))
      .limit(365);
  });
}
