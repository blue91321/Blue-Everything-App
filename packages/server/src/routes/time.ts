import { desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { startTimeEntrySchema } from '@everything/shared';
import { db } from '../db/client.js';
import { timeEntries } from '../db/schema.js';

export async function timeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/time/current', async () => {
    const [open] = await db.select().from(timeEntries).where(isNull(timeEntries.endedAt)).limit(1);
    return open ?? null;
  });

  app.get('/api/time', async (request) => {
    const { limit } = request.query as { limit?: string };
    return db
      .select()
      .from(timeEntries)
      .orderBy(desc(timeEntries.startedAt))
      .limit(Math.min(Number(limit) || 100, 1000));
  });

  app.post('/api/time/start', async (request, reply) => {
    const body = startTimeEntrySchema.parse(request.body);
    const now = body.startedAt ?? Date.now();

    // One clock at a time. Starting a new entry closes whatever was running,
    // which is what "switch to this now" means in practice.
    await db.update(timeEntries).set({ endedAt: now }).where(isNull(timeEntries.endedAt));

    const [created] = await db
      .insert(timeEntries)
      .values({ ...body, startedAt: now })
      .returning();
    return reply.code(201).send(created);
  });

  app.post('/api/time/stop', async () => {
    const now = Date.now();
    const stopped = await db
      .update(timeEntries)
      .set({ endedAt: now })
      .where(isNull(timeEntries.endedAt))
      .returning();
    return { stopped: stopped.length, at: now };
  });

  app.delete('/api/time/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await db.delete(timeEntries).where(eq(timeEntries.id, id));
    return reply.code(204).send();
  });
}
