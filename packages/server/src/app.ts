/**
 * Builds the Fastify instance without starting it, so tests and the smoke
 * script can drive the real API in-process via `app.inject()`.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ZodError } from 'zod';
import { config, corsOrigins } from './config.js';
import { authenticate } from './auth.js';
import { client } from './db/client.js';
import { eventRoutes, registerChangeAnnouncer } from './events.js';
import { attentionRoutes } from './routes/attention.js';
import { connectRoutes } from './routes/connect.js';
import { deviceRoutes } from './routes/devices.js';
import { habitRoutes } from './routes/habits.js';
import { noteRoutes } from './routes/notes.js';
import { nudgeRoutes } from './routes/nudges.js';
import { iconRoutes } from './routes/icon.js';
import { settingsRoutes } from './routes/settings.js';
import { taskRoutes } from './routes/tasks.js';
import { timeRoutes } from './routes/time.js';
import { featureNotes, isEnabled, registerFeature } from './features.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    trustProxy: config.TRUST_PROXY,
  });

  await app.register(cors, { origin: corsOrigins });

  app.addHook('onRequest', authenticate);
  // On the root instance so it sees every route, not just this plugin's.
  registerChangeAnnouncer(app);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: 'invalid request body', issues: error.issues });
    }
    request.log.error(error);
    return reply.code(error.statusCode ?? 500).send({ error: error.message ?? 'internal error' });
  });

  /** Unauthenticated on purpose — it's how you tell the box is up from a phone. */
  app.get('/health', async () => {
    await client.execute('select 1');
    return { ok: true, service: 'everything-app', at: Date.now() };
  });

  for (const note of featureNotes) app.log.warn(note);

  /* ---- core: the nudge engine and what feeds it ------------------ */
  await app.register(eventRoutes);
  await app.register(taskRoutes);
  await app.register(nudgeRoutes);
  await app.register(attentionRoutes);
  await app.register(deviceRoutes);
  await app.register(connectRoutes);
  await app.register(settingsRoutes);
  // Before the static handler, so the generated manifest wins over the one
  // sitting in dist/ from the build.
  await app.register(iconRoutes);

  /*
   * Switchable, but not removable: the Dashboard renders habits inline, and the
   * `note` voice command needs somewhere to write. Off means the routes are not
   * mounted and the app hides them; there is no folder to delete.
   */
  if (isEnabled('habits')) await app.register(habitRoutes);
  if (isEnabled('notes')) await app.register(noteRoutes);
  if (isEnabled('time')) await app.register(timeRoutes);

  /*
   * Removable. The `() => import(...)` is a literal rather than a path built
   * from the id — a dynamic `import(variable)` would be invisible to the type
   * checker and to every bundler, which is a poor trade for saving three lines.
   */
  await registerFeature(app, 'vault', () => import('./features/vault/index.js'));
  await registerFeature(app, 'voice', () => import('./features/voice/index.js'));
  await registerFeature(app, 'push', () => import('./features/push/index.js'));

  await registerWebApp(app);

  return app;
}

/**
 * Serve the built PWA from the same origin as the API.
 *
 * Same-origin means no CORS, no configured API host, and a phone that reaches
 * the app and its data over Tailscale through one URL. If the app hasn't been
 * built yet the server still runs headless — the agent doesn't need it.
 */
async function registerWebApp(app: FastifyInstance): Promise<void> {
  const distPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');

  if (!existsSync(distPath)) {
    app.log.warn(`web app not built (${distPath}) — API only. Run: npm run build -w @everything/web`);
    return;
  }

  await app.register(fastifyStatic, { root: distPath });

  // Single-page app: anything that isn't an API route or a real file is a
  // client-side route, so hand back the shell and let React sort it out.
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'no such endpoint' });
    }
    return reply.sendFile('index.html');
  });
}
