/**
 * FlareSolverr's routes — see `flaresolverr.ts` for why it runs as it does.
 *
 * - `POST /manga/flaresolverr/<secret>[/v1]`: the door Suwayomi uses. Outside
 *   `/api/` because Suwayomi sends no token, so it carries its own checks: from
 *   this PC by the same test every local-only route uses, no browser in sight
 *   (no Origin, no cookie, no fetch metadata), the secret, and a request
 *   `refusal` lets through. Anything else is a 404, which says nothing about
 *   whether there is a door here at all.
 * - `GET /api/manga/flaresolverr`: whether it is installed and running, for any
 *   of your devices.
 * - `POST /api/manga/flaresolverr/install`, `DELETE /api/manga/flaresolverr`:
 *   local-only, since they put a program on this PC or take one off.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { isTrustedLocal } from '@everything/server/module-api';
import { configureSuwayomiFlare, flareState, passOn, refusal, removeFlare, secretMatches, startInstall } from '../flaresolverr.js';
import { localOnly } from './shared.js';

/** A request that is plainly Suwayomi, on this PC, and not a web page reaching in. */
function fromSuwayomi(request: FastifyRequest): boolean {
  if (!isTrustedLocal(request)) return false;
  const h = request.headers;
  return !h.origin && !h.cookie && !h['sec-fetch-site'] && !h['sec-fetch-mode'] && !h.referer;
}

export function flaresolverrRoutes(app: FastifyInstance): void {
  const door = async (request: FastifyRequest, reply: import('fastify').FastifyReply) => {
    const { secret } = request.params as { secret: string };
    if (!fromSuwayomi(request) || !secretMatches(secret)) return reply.code(404).send({ error: 'Not Found' });
    const why = await refusal(request.body);
    if (why) {
      request.log.warn({ why }, 'manga: refused a request to FlareSolverr');
      return reply.code(403).send({ status: 'error', message: `Refused: ${why}.` });
    }
    try {
      const { status, json } = await passOn(request.body as Record<string, unknown>);
      return reply.code(status).send(json);
    } catch (error) {
      return reply.code(502).send({ status: 'error', message: error instanceof Error ? error.message : 'FlareSolverr failed' });
    }
  };
  const options = { bodyLimit: 512 * 1024, config: { announce: false } };
  app.post('/manga/flaresolverr/:secret', options, door);
  app.post('/manga/flaresolverr/:secret/v1', options, door);

  app.get('/api/manga/flaresolverr', async () => flareState());
  app.post('/api/manga/flaresolverr/install', { config: { announce: false } }, async (request) => {
    localOnly(request as unknown as { isLocal: boolean });
    return startInstall();
  });
  app.delete('/api/manga/flaresolverr', async (request) => {
    localOnly(request as unknown as { isLocal: boolean });
    const state = removeFlare();
    await configureSuwayomiFlare().catch(() => undefined);
    return state;
  });
}
