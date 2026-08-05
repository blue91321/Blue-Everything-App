import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createNoteSchema, updateNoteSchema } from '@everything/shared';
import { db } from '../db/client.js';
import { notes } from '../db/schema.js';

export async function noteRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/notes', async () =>
    db.select().from(notes).orderBy(desc(notes.pinned), desc(notes.updatedAt)).limit(500)
  );

  app.post('/api/notes', async (request, reply) => {
    const body = createNoteSchema.parse(request.body);
    const [created] = await db
      .insert(notes)
      .values({ ...body, pinned: body.pinned ? 1 : 0 })
      .returning();
    return reply.code(201).send(created);
  });

  app.patch('/api/notes/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = updateNoteSchema.parse(request.body);
    const [updated] = await db
      .update(notes)
      .set({ ...body, ...(body.pinned === undefined ? {} : { pinned: body.pinned ? 1 : 0 }) })
      .where(eq(notes.id, id))
      .returning();
    return updated ?? reply.code(404).send({ error: 'no such note' });
  });

  app.delete('/api/notes/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await db.delete(notes).where(eq(notes.id, id));
    return reply.code(204).send();
  });
}
