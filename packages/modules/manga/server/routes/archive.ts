/**
 * Keeping a series for good — the Local collection on the host's disk. See `../archive.ts`.
 *
 * Registered by `routes` in `../index.ts`, in this order with the other groups.
 */
import type { FastifyInstance } from 'fastify';
import { config, isGuest } from '@everything/server/module-api';
import { read, write } from '../library.js';
import { SourceError } from '../sources.js';
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  diskUsage,
  archiveRoot,
  DEFAULT_ARCHIVE_ROOT,
  isArchived,
  keptEntry,
  keptSeries,
  isRunning as archiveRunning,
  overview as archiveOverview,
  seriesProgress,
  startArchive,
  stopArchive,
} from '../archive.js';
import {
  archiveTools,
  forgetHostKept,
  hostJson,
  localOnly,
  mangaIdFor,
  present,
  reader,
  workArchive,
} from './shared.js';

export function archiveRoutes(app: FastifyInstance): void {
  /* ---- keeping a series for good - see `archive.ts` ---- */

  /**
   * Where kept chapters are written.
   *
   * The one setting here that is a path on this machine, so it is local-only
   * like minting a token or installing a package — and absolute, because a
   * relative one resolves against the working directory, which Task Scheduler
   * sets to `C:\\Windows\\System32`.
   */
  app.get('/api/manga/archive/folder', async () =>
    isGuest
      ? { folder: null, resolved: "on the host's PC", default: '', onHost: true }
      : { folder: read().archiveFolder, resolved: archiveRoot(), default: DEFAULT_ARCHIVE_ROOT }
  );

  /**
   * Point it somewhere else — another drive, a NAS, a disk with room on it.
   *
   * **What happens to what is already archived is the whole difficulty**, and
   * there are three honest answers rather than one:
   *
   *   - the new place already holds an archive (it has an `index.json`), so it
   *     is *adopted*. That is what makes "I moved the folder myself, now point
   *     at it" work, and it is the only sane reading of pointing at a folder
   *     that already has one;
   *   - the old place has files and the new one is on the same volume, so they
   *     are **moved** — a rename, which is instant whatever the size;
   *   - they are on different drives, which is the case a rename cannot do.
   *     That is **refused** rather than turned into a silent multi-gigabyte
   *     copy inside one HTTP request, with the message saying to move the
   *     folder by hand and point at it, which lands back on the first case.
   *
   * Copying it here was the obvious alternative and is the wrong shape: an
   * archive is the one thing in this app that reaches hundreds of gigabytes,
   * and a request that might run for an hour with no progress anywhere is not
   * something to start by accident.
   */
  app.put('/api/manga/archive/folder', async (request, reply) => {
    localOnly(request as unknown as { isLocal: boolean });
    const body = (request.body ?? {}) as { folder?: unknown };
    const wanted =
      typeof body.folder === 'string' && body.folder.trim() ? body.folder.trim() : null;

    if (wanted !== null && !isAbsolute(wanted)) {
      return reply.code(400).send({ error: 'that has to be a full path, like D:\\Manga' });
    }
    if (archiveRunning()) {
      // Moving the folder out from under the worker would leave it writing
      // pages into a tree the index no longer names.
      return reply.code(409).send({ error: 'something is downloading right now — try again when it has finished' });
    }

    const from = archiveRoot();
    const to = wanted ?? DEFAULT_ARCHIVE_ROOT;
    if (from === to) return { folder: read().archiveFolder, resolved: from, moved: false, adopted: false };

    try {
      mkdirSync(to, { recursive: true });
    } catch (error) {
      return reply
        .code(400)
        .send({ error: `that folder could not be made: ${error instanceof Error ? error.message : 'unknown'}` });
    }
    if (!statSync(to).isDirectory()) return reply.code(400).send({ error: 'that is a file, not a folder' });

    const adopting = existsSync(join(to, 'index.json'));
    const hasOld = existsSync(join(from, 'index.json'));
    let moved = false;

    if (!adopting && hasOld) {
      try {
        // Everything at once, so a half-moved archive is not a state that can exist.
        for (const name of readdirSync(from)) renameSync(join(from, name), join(to, name));
        moved = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return reply.code(400).send({
          error:
            code === 'EXDEV'
              ? `That is on a different drive, so the files cannot simply be moved. Move "${from}" there yourself, then set this again — a folder that already holds an archive is picked up as it is.`
              : `Could not move what is already saved: ${error instanceof Error ? error.message : 'unknown'}`,
        });
      }
    }

    write({ ...read(), archiveFolder: wanted });
    return { folder: wanted, resolved: archiveRoot(), moved, adopted: adopting };
  });

  /** Everything kept for good, what it occupies, and what is being fetched. */
  app.get('/api/manga/archive', async (_request, reply) => {
    if (!isGuest) return { ...archiveOverview(), disk: diskUsage() };
    // A guest copy shows the host's, which every copy shares and adds to.
    const got = await hostJson<Record<string, unknown>>('/api/manga/host/archive/overview');
    if ('error' in got) return reply.code(502).send({ error: got.error });
    return { ...got, onHost: true };
  });

  /** One series' archive, including the chapters it could not finish. */
  app.get('/api/manga/:id/archive', async (request, reply) => {
    const { id } = request.params as { id: string };
    const mangaId = mangaIdFor(read(), id);
    if (isGuest) {
      if (!mangaId) return reply.code(404).send({ error: 'this series is not archived' });
      const got = await hostJson<Record<string, unknown>>(`/api/manga/host/archive/progress?manga=${encodeURIComponent(mangaId)}`);
      if ('error' in got) return reply.code(got.status === 404 ? 404 : 502).send({ error: got.error });
      return { ...got, seriesId: id };
    }
    const progress = seriesProgress(id, mangaId);
    if (!progress) return reply.code(404).send({ error: 'this series is not archived' });
    return progress;
  });

  /**
   * Keep this series - every chapter it has, and everything that comes next.
   *
   * Safe to send again: it is also how "catch up on what is missing" and
   * "retry the chapters that failed" are asked for, since `startArchive`
   * queues only what is not already complete.
   */
  app.post('/api/manga/:id/archive', async (request, reply) => {
    const { id } = request.params as { id: string };

    // Kept for a friend's copy, and so in no library here: caught up from what it is.
    const forCopy = !isGuest && !read().series.some((x) => x.id === id) ? keptEntry(id) : null;
    if (forCopy) {
      try {
        const added = startArchive({ id, ...forCopy }, await archiveTools().chapters(forCopy.source.mangaId));
        workArchive();
        return { ...added, progress: seriesProgress(id) };
      } catch (error) {
        if (error instanceof SourceError) return reply.code(502).send({ error: error.message });
        throw error;
      }
    }

    const ctx = await reader(id);
    if ('error' in ctx) return reply.code(ctx.code).send({ error: ctx.error });

    /*
     * On a guest copy it is kept on the host's disk, by the host, where every
     * copy can read it: one copy of each series, one thing downloading.
     */
    if (isGuest) {
      const got = await hostJson<Record<string, unknown>>(
        '/api/manga/host/archive',
        { method: 'POST', body: JSON.stringify({ title: ctx.series.title, source: ctx.series.source }) },
        60_000
      );
      if ('error' in got) return reply.code(502).send({ error: got.error });
      forgetHostKept();
      return { ...got, progress: got.progress ? { ...(got.progress as object), seriesId: id } : null };
    }

    try {
      const list = await ctx.adapter.chapters(ctx.series.source!.mangaId, true);
      const added = startArchive(
        { id: ctx.series.id, title: ctx.series.title, source: ctx.series.source },
        list.map((c) => ({ id: c.id, number: c.number, name: c.name, uploadedAt: c.uploadedAt }))
      );
      workArchive();
      return { ...added, progress: seriesProgress(id, ctx.series.source?.mangaId) };
    } catch (error) {
      if (error instanceof SourceError) return reply.code(502).send({ error: error.message });
      throw error;
    }
  });

  /**
   * Stop archiving it.
   *
   * **Keeps the files unless `files=delete` says otherwise**, because "stop
   * saving what comes next" and "throw away what I saved" are different
   * decisions and only one of them can be undone - the distinction the notes
   * folder menu draws in as many words. The destructive path is reachable only
   * by asking for it.
   */
  app.delete('/api/manga/:id/archive', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { files } = request.query as { files?: string };
    // What is kept on the PC may be what a friend is reading: only the host lets it go.
    if (isGuest) return reply.code(403).send({ error: "Only the host stops keeping a series, since every copy reads what's kept." });
    const mangaId = mangaIdFor(read(), id);
    if (!isArchived(id, mangaId)) return reply.code(404).send({ error: 'this series is not archived' });
    return stopArchive(id, { deleteFiles: files === 'delete', mangaId });
  });

  /** Work the queue now, rather than waiting for the sweep. */
  app.post('/api/manga/archive/run', { config: { announce: false } }, async (_request, reply) => {
    if (isGuest) {
      const got = await hostJson<Record<string, unknown>>('/api/manga/host/archive/overview');
      if ('error' in got) return reply.code(502).send({ error: got.error });
      return { ...got, onHost: true };
    }
    workArchive();
    return archiveOverview();
  });

  /**
   * Browse's "On this PC": everything kept on the PC, as results a screen can
   * open and read like any other source's, in every copy. Read from the kept
   * copy, so a series whose site has gone is still here.
   */
  app.get('/api/manga/kept', async (_request, reply) => {
    const store = read();
    let list: Array<{ mangaId: string; sourceName: string; title: string; complete: number; keptFor: string[] }>;
    if (isGuest) {
      const got = await hostJson<{ series: typeof list }>('/api/manga/host/archive');
      if ('error' in got) return reply.code(502).send({ error: got.error });
      list = got.series;
    } else {
      list = keptSeries();
    }
    return {
      results: list.map((k) => ({
        ...present(store, {
          id: k.mangaId,
          title: k.title,
          sourceName: k.sourceName,
          lang: null,
          url: null,
          thumbnailUrl: `/api/v1/manga/${k.mangaId}/thumbnail`,
        }),
        chapters: k.complete,
        keptFor: k.keptFor,
      })),
    };
  });
}
