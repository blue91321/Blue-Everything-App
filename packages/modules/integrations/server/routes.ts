/**
 * The integrations API: every route this package answers, by group.
 *
 * | file | routes |
 * | --- | --- |
 * | `routes/accounts.ts` | what is connected, connecting and disconnecting, the OAuth callback, Sync now |
 * | `routes/spotify.ts` | Shuffle, its settings and boosts, and the desktop-app bug watcher |
 * | `routes/friends.ts` | who is online, linking accounts that are one person, the agent's presence report |
 * | `routes/follows.ts` | who you follow, who is live, starring and linking channels |
 * | `routes/music.ts` | playlists and the Music tab's breakdown |
 * | `routes/coursework.ts` | the half-hourly Canvas sync, which has no route at all |
 * | `routes/shared.ts` | what more than one group uses |
 *
 * Two rules hold across all of them:
 *
 * **Connecting and disconnecting are local-only** (`localOnly` in
 * `routes/shared.ts`). The same rule minting a device token follows. An OAuth
 * handshake redirects to a browser on this PC and a phone over Tailscale
 * cannot finish one; an API key pasted from a phone is a key travelling further
 * than it needs to. Reading the results is not restricted: the whole point of
 * the phone is seeing who is online from the sofa.
 *
 * **The OAuth callback is `/oauth/callback/:provider`, outside `/api/`.** It
 * is a redirect from the provider's site, so the browser marks it cross-site
 * and sends no bearer token; under `/api/` it was refused. What protects it
 * is the `state` parameter: random, single-use, ten minutes, and issued only
 * by the authorize route, which is local-only.
 */
import type { FastifyInstance } from 'fastify';
import { accountRoutes } from './routes/accounts.js';
import { spotifyRoutes } from './routes/spotify.js';
import { friendRoutes } from './routes/friends.js';
import { followRoutes } from './routes/follows.js';
import { musicRoutes } from './routes/music.js';
import { courseworkSync } from './routes/coursework.js';

export async function integrationRoutes(app: FastifyInstance): Promise<void> {
  await accountRoutes(app);
  await spotifyRoutes(app);
  await friendRoutes(app);
  await followRoutes(app);
  await musicRoutes(app);
  await courseworkSync(app);
}
