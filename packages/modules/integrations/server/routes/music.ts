/**
 * Music: your playlists, leaving one out, and the Music tab's breakdown.
 */
import type { FastifyInstance } from 'fastify';
import { isProviderId } from '@everything/shared/integrations';
import { z } from 'zod';
import { changes } from '@everything/server/module-api';
import {
  categoryBreakdown,
  artistBreakdown,
  collectionsFor,
  itemsInCollection,
  setCollectionIgnored,
} from '../store.js';
import { localOnly } from './shared.js';

export async function musicRoutes(app: FastifyInstance): Promise<void> {
  /* ---- the library ----------------------------------------------- */

  app.get('/api/integrations/collections', async (request) => {
    const { provider } = request.query as { provider?: string };
    return collectionsFor(provider && isProviderId(provider) ? provider : undefined);
  });

  /**
   * Tick or untick one playlist.
   *
   * Replaces a provider-wide "skip Liked Videos" switch. The reason to skip a
   * playlist is that it is enormous and drowns out the rest, and that is a
   * property of the playlist rather than of the service it came from — so the
   * box belongs next to the playlist, in the list of them.
   */
  app.patch('/api/integrations/collections/:id', async (request) => {
    localOnly(request);
    const { id } = request.params as { id: string };
    const { ignored } = z.object({ ignored: z.boolean() }).parse(request.body);

    const all = await collectionsFor();
    if (!all.some((c) => c.id === id)) {
      throw Object.assign(new Error('no such playlist'), { statusCode: 404 });
    }

    await setCollectionIgnored(id, ignored);
    changes.emitChange('integrations');
    return { id, ignored };
  });

  app.get('/api/integrations/collections/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const items = await itemsInCollection(id);
    if (items.length === 0) {
      // An empty playlist and a missing one are different, and only one of them
      // is worth a 404 — so the collection itself is checked.
      const all = await collectionsFor();
      if (!all.some((c) => c.id === id)) return reply.code(404).send({ error: 'no such collection' });
    }
    return items;
  });

  /**
   * The Music tab's summary: what the library is made of.
   *
   * It carried a play history too — what you listened to, by family, over a
   * window. That went with history itself. What is left is the library, which
   * is the part that was ever a fact rather than an inference.
   */
  app.get('/api/integrations/music', async () => ({ breakdown: await categoryBreakdown(), byArtist: await artistBreakdown() }));
}
