import { desc, eq, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createNudgeSchema, snoozeNudgeSchema } from '@everything/shared';
import { db } from '../db/client.js';
import { nudges } from '../db/schema.js';

export async function nudgeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/nudges', async (request) => {
    const { state } = request.query as { state?: string };
    return db
      .select()
      .from(nudges)
      .where(state ? eq(nudges.state, state) : undefined)
      .orderBy(desc(nudges.createdAt))
      .limit(200);
  });

  /** The queue as it currently stands — what's waiting for a good moment. */
  app.get('/api/nudges/queue', async () =>
    db
      .select()
      .from(nudges)
      .where(or(eq(nudges.state, 'pending'), eq(nudges.state, 'snoozed')))
      .orderBy(desc(nudges.earliestAt))
  );

  app.post('/api/nudges', async (request, reply) => {
    const body = createNudgeSchema.parse(request.body);
    const [created] = await db.insert(nudges).values(body).returning();
    return reply.code(201).send(created);
  });

  /** Blake saw it and acted on it. */
  app.post('/api/nudges/:id/ack', async (request, reply) => {
    const { id } = request.params as { id: string };
    const [updated] = await db
      .update(nudges)
      .set({ state: 'acknowledged' })
      .where(eq(nudges.id, id))
      .returning();
    return updated ?? reply.code(404).send({ error: 'no such nudge' });
  });

  /**
   * Back into the queue, later. Snoozing returns it to `pending` rather than
   * leaving it delivered, so it gets a fresh shot at a good moment instead of
   * reappearing at whatever moment the timer happens to land on.
   */
  app.post('/api/nudges/:id/snooze', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { minutes } = snoozeNudgeSchema.parse(request.body);
    const until = Date.now() + minutes * 60_000;

    const [updated] = await db
      .update(nudges)
      .set({ state: 'pending', snoozeUntil: until, earliestAt: until })
      .where(eq(nudges.id, id))
      .returning();
    return updated ?? reply.code(404).send({ error: 'no such nudge' });
  });

  app.post('/api/nudges/:id/dismiss', async (request, reply) => {
    const { id } = request.params as { id: string };
    const [updated] = await db
      .update(nudges)
      .set({ state: 'dismissed' })
      .where(eq(nudges.id, id))
      .returning();
    return updated ?? reply.code(404).send({ error: 'no such nudge' });
  });

  app.delete('/api/nudges/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await db.delete(nudges).where(eq(nudges.id, id));
    return reply.code(204).send();
  });
}
