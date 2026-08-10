/**
 * The integrations API.
 *
 * Two rules shape this file:
 *
 * **Connecting and disconnecting are local-only.** The same rule minting a
 * device token follows. An OAuth handshake redirects to a browser on this PC and
 * a phone over Tailscale cannot finish one; an API key pasted from a phone is a
 * key travelling further than it needs to. Reading the results is not restricted
 * — the whole point of the phone is seeing who is online from the sofa.
 *
 * **The callback route lives under `/api/` and that is safe here**, unlike the
 * icons and the manifest which had to be moved out. Those are fetched by the
 * browser's own machinery, which will never send a bearer token. This one is a
 * redirect from Spotify to a browser *on this machine*, so it arrives on a
 * loopback socket with a loopback Host and `isTrustedLocal` allows it — which is
 * also exactly what the `state` parameter is protecting, since anything on this
 * PC is equally trusted.
 */
import type { FastifyInstance } from 'fastify';
import {
  CAPABILITIES,
  PROVIDERS,
  PROVIDER_LIST,
  FOLLOW_PROVIDERS,
  connectSteamSchema,
  isProviderId,
  localPresenceSchema,
  presenceRank,
  syncRequestSchema,
  type Capability,
  type ProviderId,
} from '@everything/shared/integrations';
import { z } from 'zod';
import { config } from '../../config.js';
import { changes } from '../../events.js';
import { beginAuthorization, completeAuthorization, grantedScopes, missingCredentials } from './oauth.js';
import { localStatusOf, recordLocalPresence } from './providers/local.js';
import * as spotify from './providers/spotify.js';
import * as steam from './providers/steam.js';
import * as youtube from './providers/youtube.js';
import {
  allFollows,
  allFriends,
  categoryBreakdown,
  collectionsFor,
  forgetAccount,
  getAccount,
  itemsInCollection,
  listAccounts,
  recentPlays,
  saveAccount,
  followsFreshness,
  syncedAtOf,
  tasteProfile,
} from './store.js';
import { refreshPresence, runnableCapabilities, syncProvider } from './sync.js';
import { importTakeout, parseTakeout } from './takeout.js';

/** Everything the connections screen needs about one provider, in one object. */
async function providerState(id: ProviderId) {
  const account = await getAccount(id);
  const spec = PROVIDERS[id];

  return {
    ...spec,
    connected: account !== null,
    accountName: account?.accountName ?? null,
    /**
     * What was actually granted, not what was asked for. Discord hands back a
     * working token having silently dropped the presence scope, and without
     * this the screen would show a healthy connection and an empty friends list.
     */
    grantedScopes: grantedScopes(account),
    missingConfig: missingCredentials(id),
    syncedAt: syncedAtOf(account),
    lastError: account?.lastError ?? null,
    /** Which capabilities have code behind them, as opposed to being described. */
    runnable: runnableCapabilities(id),
    /**
     * An environment variable is already supplying this provider's key.
     *
     * Only Steam has one, and the form needs it to answer a question the user
     * would otherwise have to guess at: is the key box something I must fill
     * in, or is it already handled? Without this the field is indistinguishable
     * from required, which is how the previous version went wrong.
     */
    envFallback: id === 'steam' && config.STEAM_API_KEY !== '',
    /** For `local` providers: what the agent last said. */
    local: spec.reach === 'local' ? localStatusOf(id) : null,
  };
}

function parseProvider(value: string): ProviderId {
  if (!isProviderId(value)) throw Object.assign(new Error('no such provider'), { statusCode: 404 });
  return value;
}

/** A tiny page for the OAuth redirect to land on, since it is a real navigation. */
function callbackPage(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 3rem auto; max-width: 32rem; padding: 0 1rem;
         background: #14161c; color: #e7e9ee; }
  a { color: #6aa6ff; }
  code { background: #22252e; padding: .15em .4em; border-radius: 4px; }
</style>
<h1>${title}</h1><p>${body}</p><p><a href="/">Back to Blue Everything</a></p>`;
}

export async function integrationRoutes(app: FastifyInstance): Promise<void> {
  /** Guard for everything that changes a connection. */
  const localOnly = (request: { isLocal: boolean }) => {
    if (!request.isLocal) {
      throw Object.assign(new Error('connections can only be changed from the PC running the server'), {
        statusCode: 403,
      });
    }
  };

  /* ---- what have I got ------------------------------------------- */

  app.get('/api/integrations', async () => {
    const providers = await Promise.all(PROVIDER_LIST.map((spec) => providerState(spec.id)));
    return { providers, capabilities: CAPABILITIES };
  });

  /* ---- connecting ------------------------------------------------ */

  /**
   * Hand back the URL rather than redirecting.
   *
   * The caller is `fetch` from the PWA, and a 302 to accounts.spotify.com would
   * be followed by fetch and land as an opaque CORS failure rather than as a
   * page. The screen opens the URL itself, which also means it can show what it
   * is about to do first.
   */
  app.post('/api/integrations/:provider/authorize', async (request) => {
    localOnly(request);
    const provider = parseProvider((request.params as { provider: string }).provider);
    return { url: beginAuthorization(provider).url };
  });

  app.get('/api/integrations/callback/:provider', async (request, reply) => {
    const provider = parseProvider((request.params as { provider: string }).provider);
    const query = request.query as { code?: string; state?: string; error?: string; error_description?: string };

    reply.type('text/html');

    if (query.error) {
      // Their words, not ours. `access_denied` when you press Cancel, and the
      // scope-refusal that an unapproved Discord app gets, arrive here.
      return callbackPage(
        `${PROVIDERS[provider].label} refused`,
        `It said: <code>${query.error}</code>${query.error_description ? ` — ${query.error_description}` : ''}`
      );
    }

    if (!query.code || !query.state) {
      return reply.code(400).send(callbackPage('Incomplete redirect', 'No authorization code came back.'));
    }

    try {
      await completeAuthorization(query.state, query.code);

      // Ask who we just connected as, so the screen shows an account rather
      // than the word "connected". A failure here is not a failed connection —
      // the token is stored and works — so it is caught separately.
      try {
        const who =
          provider === 'spotify'
            ? await spotify.whoAmI()
            : provider === 'youtube'
              ? await youtube.whoAmI()
              : provider === 'discord'
                ? await (await import('./providers/discord.js')).whoAmI()
                : null;
        if (who) await saveAccount(provider, { accountId: who.id, accountName: who.name });
      } catch {
        // Left unnamed on the screen rather than failing the connection.
      }

      changes.emitChange('integrations');
      return callbackPage(`${PROVIDERS[provider].label} connected`, 'You can close this tab.');
    } catch (error) {
      return reply
        .code(400)
        .send(callbackPage(`${PROVIDERS[provider].label} could not be connected`, (error as Error).message));
    }
  });

  /**
   * Steam has no OAuth: a personal API key and a profile, both typed here.
   *
   * Both, together, in one submission — that is the whole point of this route.
   * The key used to live in an environment variable, which meant connecting
   * Steam was a two-place job with an app restart between the halves, and the
   * profile box on the screen sat disabled until the other half was done.
   */
  app.post('/api/integrations/steam/connect', async (request) => {
    localOnly(request);
    const { apiKey, profile } = connectSteamSchema.parse(request.body);

    // The env var remains a fallback for anyone who would rather keep it there,
    // so an empty key field is legitimate rather than a validation error.
    const key = apiKey ?? config.STEAM_API_KEY;
    if (!key) {
      throw Object.assign(
        new Error('Steam needs an API key — get one at steamcommunity.com/dev/apikey and paste it above.'),
        { statusCode: 400 }
      );
    }

    // Verified before either is stored. A revoked key and a mistyped profile
    // both store perfectly happily and then fail on every refresh afterwards,
    // with a message about privacy settings that sends you to the wrong place.
    const me = await steam.verify(key, profile);

    await saveAccount('steam', {
      // Stored only when it was actually typed here. Copying the env var into
      // the row would make it look editable in the app while the variable was
      // still the thing that mattered on the next restart.
      ...(apiKey ? { apiKey } : {}),
      externalId: me.id,
      accountId: me.id,
      accountName: me.name,
      lastError: null,
    });

    return { connected: true, accountName: me.name, steamId: me.id };
  });

  app.delete('/api/integrations/:provider', async (request, reply) => {
    localOnly(request);
    const provider = parseProvider((request.params as { provider: string }).provider);
    await forgetAccount(provider);
    // The friends stay until the next refresh writes over them, which is the
    // wrong answer for a disconnected provider — so they go with the account.
    const { replaceFriends } = await import('./store.js');
    await replaceFriends(provider, []);
    return reply.code(204).send();
  });

  /* ---- syncing --------------------------------------------------- */

  app.post('/api/integrations/:provider/sync', async (request) => {
    const provider = parseProvider((request.params as { provider: string }).provider);
    const body = syncRequestSchema.parse(request.body ?? {});
    return { outcomes: await syncProvider(provider, body.capabilities as Capability[] | undefined) };
  });

  /* ---- friends --------------------------------------------------- */

  /**
   * The friends list, refreshed if it has gone stale.
   *
   * The refresh happens inside the read on purpose — see `refreshPresence` for
   * why there is no background poller. `?force=1` is the manual refresh button,
   * which exists because "I know they just came online" is a real thing to know.
   */
  app.get('/api/integrations/friends', async (request) => {
    const { force } = request.query as { force?: string };

    const outcomes = await refreshPresence(force === '1');
    const rows = await allFriends();

    return {
      friends: rows.sort(
        (a, b) =>
          presenceRank[a.state as keyof typeof presenceRank] - presenceRank[b.state as keyof typeof presenceRank] ||
          a.name.localeCompare(b.name)
      ),
      /** Per-provider health, so an empty list can explain itself. */
      sources: await Promise.all(
        PROVIDER_LIST.filter((p) => p.capabilities.friends).map(async (p) => {
          const account = await getAccount(p.id);
          return {
            provider: p.id,
            label: p.label,
            status: p.capabilities.friends!.status,
            why: p.capabilities.friends!.why,
            connected: account !== null,
            missingConfig: missingCredentials(p.id),
            lastError: account?.lastError ?? null,
            local: p.reach === 'local' ? localStatusOf(p.id) : null,
          };
        })
      ),
      refreshed: outcomes,
    };
  });

  /**
   * Where the agent posts what only this PC can see.
   *
   * Excluded from the change announcer in `events.ts` — it arrives on a timer
   * and `recordLocalPresence` announces only when the snapshot actually differs.
   */
  app.post('/api/integrations/presence', async (request) => {
    const report = localPresenceSchema.parse(request.body);
    await recordLocalPresence(report);
    return { ok: true };
  });

  /**
   * Accounts you follow — YouTube channels, Spotify artists.
   *
   * A plain read with no refresh-on-read, unlike friends. A subscription list
   * changes when *you* change it, perhaps monthly; presence changes minute to
   * minute. Refreshing this on every open would spend YouTube quota to confirm
   * what it said yesterday, so it is synced on demand like a playlist.
   */
  app.get('/api/integrations/follows', async () => {
    const freshness = await followsFreshness();

    return {
      follows: await allFollows(),
      sources: FOLLOW_PROVIDERS.map((id) => ({
        provider: id,
        label: PROVIDERS[id].label,
        status: PROVIDERS[id].capabilities.follows!.status,
        why: PROVIDERS[id].capabilities.follows!.why,
        syncedAt: freshness.get(id) ?? null,
      })),
    };
  });

  /* ---- the library ----------------------------------------------- */

  app.get('/api/integrations/collections', async (request) => {
    const { provider } = request.query as { provider?: string };
    return collectionsFor(provider && isProviderId(provider) ? provider : undefined);
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
   * The Music tab's summary: what the library is made of, and what has actually
   * been played lately.
   *
   * `days` bounds the taste window. Thirty is the default because a month is
   * long enough to be a habit and short enough to notice a change — a
   * whole-history figure would be dominated by whatever you liked two years ago.
   */
  app.get('/api/integrations/music', async (request) => {
    const { days } = request.query as { days?: string };
    const window = Math.min(Math.max(Number(days) || 30, 1), 365);

    return {
      breakdown: await categoryBreakdown(),
      taste: await tasteProfile(Date.now() - window * 86_400_000),
      recent: await recentPlays(60),
      windowDays: window,
    };
  });

  /* ---- YouTube watch history, from a file ------------------------ */

  const takeoutSchema = z.object({
    /** The file's contents. Sent as a string because it is JSON either way. */
    json: z.string().min(2).max(200 * 1024 * 1024),
    /** Nothing is written until this is true. See `takeout.ts` on why. */
    commit: z.boolean().default(false),
  });

  app.post('/api/integrations/youtube/takeout', async (request) => {
    localOnly(request);
    const { json, commit } = takeoutSchema.parse(request.body);

    const { plays, summary } = parseTakeout(json);
    if (!commit) return { summary, committed: false };

    const { added, videos } = await importTakeout(plays);
    changes.emitChange('integrations');
    return { summary, committed: true, added, videos };
  });
}
