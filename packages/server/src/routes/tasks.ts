import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  createProjectSchema,
  createTaskSchema,
  updateProjectSchema,
  updateTaskSchema,
} from '@everything/shared';
import { db } from '../db/client.js';
import { projects, tasks } from '../db/schema.js';

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/tasks', async (request) => {
    const { status, projectId } = request.query as { status?: string; projectId?: string };
    const filters = [
      status ? inArray(tasks.status, status.split(',')) : undefined,
      projectId ? eq(tasks.projectId, projectId) : undefined,
    ].filter(Boolean);

    return db
      .select()
      .from(tasks)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(tasks.priority), asc(tasks.dueAt), asc(tasks.sortOrder));
  });

  app.get('/api/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
    return task ?? reply.code(404).send({ error: 'no such task' });
  });

  app.post('/api/tasks', async (request, reply) => {
    const body = createTaskSchema.parse(request.body);
    const [created] = await db.insert(tasks).values(body).returning();
    return reply.code(201).send(created);
  });

  app.patch('/api/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = updateTaskSchema.parse(request.body);

    // Completing a task is the one update with a side effect worth recording.
    const completedAt =
      body.status === 'done' ? Date.now() : body.status && body.status !== 'done' ? null : undefined;

    const [updated] = await db
      .update(tasks)
      .set({ ...body, ...(completedAt !== undefined ? { completedAt } : {}) })
      .where(eq(tasks.id, id))
      .returning();

    return updated ?? reply.code(404).send({ error: 'no such task' });
  });

  app.delete('/api/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await db.delete(tasks).where(eq(tasks.id, id));
    return reply.code(204).send();
  });

  /* ---------------- projects ---------------- */

  app.get('/api/projects', async () => db.select().from(projects).orderBy(asc(projects.name)));

  app.post('/api/projects', async (request, reply) => {
    const body = createProjectSchema.parse(request.body);
    const [created] = await db
      .insert(projects)
      .values({ ...body, archived: body.archived ? 1 : 0 })
      .returning();
    return reply.code(201).send(created);
  });

  app.patch('/api/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = updateProjectSchema.parse(request.body);
    const [updated] = await db
      .update(projects)
      .set({ ...body, ...(body.archived === undefined ? {} : { archived: body.archived ? 1 : 0 }) })
      .where(eq(projects.id, id))
      .returning();
    return updated ?? reply.code(404).send({ error: 'no such project' });
  });
}
