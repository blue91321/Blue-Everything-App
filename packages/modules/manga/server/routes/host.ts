/**
 * What a friend's copy may read from and add to on the host (plan A).
 *
 * Registered by `routes` in `../index.ts`, in this order with the other groups.
 */
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db, changes, copyOfDevice, devices, isGuest } from '@everything/server/module-api';
import { PageFetchError, sharedPage } from '../page-fetch.js';
import { SourceError } from '../sources.js';
import {
  archivedPage,
  archivedPageList,
  diskUsage,
  keptSeries,
  overview as archiveOverview,
  seriesProgress,
  startArchive,
} from '../archive.js';
import { archiveTools, workArchive } from './shared.js';

export function hostRoutes(app: FastifyInstance): void {
  /* ---- what copies may read and add to (plan A) ---- */

  /** A copy's key, or this PC. */
  const fromCopy = (request: unknown) => {
    const from = request as { isLocal: boolean; deviceKind: string | null };
    return !isGuest && (from.isLocal || from.deviceKind === 'instance');
  };
  const MANGA_ID = /^\d{1,25}$/;

  /** Which copy is asking, for names: `you` when it is this PC itself. */
  const askingCopy = async (request: unknown) =>
    (await copyOfDevice((request as { deviceId: string | null }).deviceId)) ?? 'you';

  app.get('/api/manga/host/archive', async (request, reply) => {
    if (!fromCopy(request)) return reply.code(403).send({ error: 'only for copies on this PC' });
    return { series: keptSeries(await askingCopy(request)) };
  });

  app.get('/api/manga/host/archive/overview', async (request, reply) => {
    if (!fromCopy(request)) return reply.code(403).send({ error: 'only for copies on this PC' });
    return { ...archiveOverview(await askingCopy(request)), disk: diskUsage() };
  });

  app.get('/api/manga/host/archive/progress', async (request, reply) => {
    if (!fromCopy(request)) return reply.code(403).send({ error: 'only for copies on this PC' });
    const { manga } = request.query as { manga?: string };
    if (!manga || !MANGA_ID.test(manga)) return reply.code(400).send({ error: 'which series?' });
    const progress = seriesProgress('', manga, await askingCopy(request));
    if (!progress) return reply.code(404).send({ error: 'this series is not archived' });
    return progress;
  });

  app.get('/api/manga/host/archive/pages', async (request, reply) => {
    if (!fromCopy(request)) return reply.code(403).send({ error: 'only for copies on this PC' });
    const { manga, chapter } = request.query as { manga?: string; chapter?: string };
    if (!manga || !MANGA_ID.test(manga) || !chapter || !MANGA_ID.test(chapter)) {
      return reply.code(400).send({ error: 'which chapter?' });
    }
    const pages = archivedPageList('', chapter, manga);
    if (!pages) return reply.code(404).send({ error: 'not kept' });
    return { pages };
  });

  /**
   * A page from the shared Suwayomi, for a friend's copy: through the host's
   * `sharedPage`, so the host and every copy asking for the same page at once
   * cause one fetch from the site. `fresh=1` is a "try again", not shared.
   */
  app.get('/api/manga/host/page', async (request, reply) => {
    if (!fromCopy(request)) return reply.code(403).send({ error: 'only for copies on this PC' });
    const { p, fresh } = request.query as { p?: string; fresh?: string };
    if (!p || !/^\/api\/v1\/manga\/\d+\/chapter\/\d+\/page\/\d+$/.test(p)) {
      return reply.code(400).send({ error: 'not a page' });
    }
    const url = await archiveTools().connect();
    if (!url) return reply.code(503).send({ error: 'the source is not running' });
    try {
      const { body, type } = await sharedPage(`${url}${p}`, { share: fresh !== '1' });
      return reply.header('content-type', type).send(body);
    } catch (error) {
      const code = error instanceof PageFetchError && error.status === 504 ? 504 : 502;
      return reply.code(code).send({ error: error instanceof Error ? error.message : 'could not fetch the page' });
    }
  });

  app.get('/api/manga/host/archive/page', async (request, reply) => {
    if (!fromCopy(request)) return reply.code(403).send({ error: 'only for copies on this PC' });
    const { manga, p } = request.query as { manga?: string; p?: string };
    if (!manga || !MANGA_ID.test(manga) || !p || !/^\/api\/v1\/manga\/\d+\/chapter\/\d+\/page\/\d+$/.test(p)) {
      return reply.code(400).send({ error: 'not a page' });
    }
    const saved = archivedPage('', p, manga);
    if (!saved) return reply.code(404).send({ error: 'not kept' });
    return reply.header('content-type', saved.type).send(saved.body);
  });

  /**
   * A copy asking to keep a series: on this PC's disk, by this copy, from the
   * Suwayomi every copy shares. Kept once whoever asks; `keptFor` says who.
   */
  app.post('/api/manga/host/archive', async (request, reply) => {
    if (!fromCopy(request)) return reply.code(403).send({ error: 'only for copies on this PC' });
    const body = request.body as { title?: unknown; source?: unknown } | null;
    const source = body?.source as { adapter?: unknown; mangaId?: unknown; sourceName?: unknown; title?: unknown } | null;
    if (
      !source ||
      typeof source.mangaId !== 'string' ||
      !MANGA_ID.test(source.mangaId) ||
      typeof source.sourceName !== 'string' ||
      typeof body?.title !== 'string'
    ) {
      return reply.code(400).send({ error: 'which series?' });
    }
    const from = request as unknown as { deviceId: string | null };
    const [device] = from.deviceId
      ? await db.select({ name: devices.name }).from(devices).where(eq(devices.id, from.deviceId))
      : [];
    const by = (device?.name ?? 'you').replace(/^copy: /, '');
    try {
      const chapters = await archiveTools().chapters(source.mangaId);
      const added = startArchive(
        {
          id: `kept-${source.mangaId}`,
          title: body.title,
          source: {
            adapter: typeof source.adapter === 'string' ? source.adapter : 'suwayomi',
            mangaId: source.mangaId,
            sourceName: source.sourceName,
            title: typeof source.title === 'string' ? source.title : body.title,
          },
        },
        chapters,
        by
      );
      workArchive();
      changes.emitChange('all');
      return { ...added, progress: seriesProgress('', source.mangaId, by) };
    } catch (error) {
      if (error instanceof SourceError) return reply.code(502).send({ error: error.message });
      throw error;
    }
  });

  /** One read-ahead run at a time per series, so a fast reader cannot stack them. */
}
