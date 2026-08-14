import { and, asc, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createHabitSchema, reorderSchema, updateHabitSchema, type Cadence } from '@everything/shared';
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
        return {
          ...habit,
          voicePhrases: parsePhrases(habit.voicePhrases),
          periodKey: key,
          doneThisPeriod: done,
          met: done >= habit.targetPerPeriod,
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
    const [updated] = await db
      .update(habits)
      .set({
        ...body,
        ...normalisePush({ pushToPhone }),
        ...(active === undefined ? {} : { active: active ? 1 : 0 }),
        ...(voicePhrases === undefined ? {} : { voicePhrases: JSON.stringify(voicePhrases) }),
      })
      .where(eq(habits.id, id))
      .returning();
    if (!updated) return reply.code(404).send({ error: 'no such habit' });
    return { ...updated, voicePhrases: parsePhrases(updated.voicePhrases) };
  });

  app.delete('/api/habits/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    // habit_entries cascade, so the streak history goes with it.
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
    const [habit] = await db.select().from(habits).where(eq(habits.id, id));
    if (!habit) return reply.code(404).send({ error: 'no such habit' });

    const [entry] = await db
      .insert(habitEntries)
      .values({ habitId: id, periodKey: periodKeyFor(habit.cadence as Cadence) })
      .returning();
    return reply.code(201).send(entry);
  });

  /**
   * Undo one completion in the current period.
   *
   * Removes the most recent entry rather than zeroing the count, so a habit
   * with a target of 3 goes 3 -> 2 and a mis-tap costs one tap to fix.
   */
  app.post('/api/habits/:id/uncheck', async (request, reply) => {
    const { id } = request.params as { id: string };
    const [habit] = await db.select().from(habits).where(eq(habits.id, id));
    if (!habit) return reply.code(404).send({ error: 'no such habit' });

    const key = periodKeyFor(habit.cadence as Cadence);
    const [latest] = await db
      .select()
      .from(habitEntries)
      .where(and(eq(habitEntries.habitId, id), eq(habitEntries.periodKey, key)))
      .orderBy(desc(habitEntries.doneAt))
      .limit(1);

    if (!latest) return { removed: 0 };

    await db.delete(habitEntries).where(eq(habitEntries.id, latest.id));
    return { removed: 1 };
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
