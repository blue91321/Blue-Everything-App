/**
 * The chapter catalogue's routes (`catalogue.ts`): its state and the series
 * ahead elsewhere, the library check, mapping whole sources, its two switches,
 * and what it knows of one series' copies, for the comparison screen to show
 * before any site has answered. Not local-only: it is about your library, like
 * Find sources.
 */
import type { FastifyInstance } from 'fastify';
import { read } from '../library.js';
import {
  catalogueStatus,
  knownCopies,
  retryMapping,
  setCatalogueSettings,
  startCheck,
  startMapping,
  stopCatalogue,
} from '../catalogue.js';

export function catalogueRoutes(app: FastifyInstance): void {
  app.get('/api/manga/catalogue', async () => catalogueStatus());

  app.post('/api/manga/catalogue/check', { config: { announce: false } }, async () => startCheck());
  app.post('/api/manga/catalogue/map', { config: { announce: false } }, async () => startMapping());
  app.post('/api/manga/catalogue/stop', { config: { announce: false } }, async () => stopCatalogue());

  app.put('/api/manga/catalogue/settings', async (request) => {
    const body = (request.body ?? {}) as { nudge?: unknown; background?: unknown; automatic?: unknown };
    return setCatalogueSettings({
      ...(typeof body.nudge === 'boolean' ? { nudge: body.nudge } : {}),
      ...(typeof body.background === 'boolean' ? { background: body.background } : {}),
      ...(typeof body.automatic === 'boolean' ? { automatic: body.automatic } : {}),
    });
  });

  app.post('/api/manga/catalogue/sources/:id/retry', async (request) => {
    retryMapping((request.params as { id: string }).id);
    return catalogueStatus();
  });

  /** Every copy of one series the catalogue knows, with its count and when: no site asked, no Suwayomi needed. */
  app.get('/api/manga/:id/source/known', async (request, reply) => {
    const series = read().series.find((s) => s.id === (request.params as { id: string }).id);
    if (!series) return reply.code(404).send({ error: 'no such series' });
    return { copies: knownCopies(series) };
  });
}
