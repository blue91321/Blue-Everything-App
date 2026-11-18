/**
 * Connections: what is connected, connecting and disconnecting each service,
 * the page an OAuth sign-in comes back to, and Sync now.
 *
 * Everything that changes a connection is local-only; see `../routes.ts`.
 */
import type { FastifyInstance } from 'fastify';
import {
  CAPABILITIES,
  PROVIDERS,
  PROVIDER_LIST,
  connectCanvasSchema,
  connectSteamSchema,
  credentialsSchema,
  syncRequestSchema,
  type Capability,
} from '@everything/shared/integrations';
import { config } from '@everything/server/module-api';
import { changes } from '@everything/server/module-api';
import { getSettings } from '@everything/server/module-api';
import { parseHiddenProviders } from '@everything/server/module-api';
import { beginAuthorization, completeAuthorization, missingCredentials } from '../oauth.js';
import * as canvas from '../providers/canvas.js';
import * as spotify from '../providers/spotify.js';
import * as steam from '../providers/steam.js';
import * as youtube from '../providers/youtube.js';
import { forgetAccount, forgetTaskLinks, saveAccount } from '../store.js';
import { syncProvider } from '../sync.js';
import { providerState, parseProvider, esc, callbackPage, localOnly } from './shared.js';

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  /* ---- what have I got ------------------------------------------- */

  app.get('/api/integrations', async () => {
    const providers = await Promise.all(PROVIDER_LIST.map((spec) => providerState(spec.id)));
    // Carried here so the Services tab can render the leave-out panel from the
    // one call it already makes, rather than fetching settings a second time
    // for a list of five strings.
    const hiddenProviders = parseHiddenProviders((await getSettings()).hiddenProviders);
    return { providers, capabilities: CAPABILITIES, hiddenProviders };
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
    return { url: (await beginAuthorization(provider)).url };
  });

  /**
   * Save a provider's client id and secret, typed into the app.
   *
   * The whole reason this exists: setting one up used to mean opening a file,
   * pasting an environment variable and restarting the app — which is precisely
   * the friction the three double-clickable files in the repo root exist to
   * remove. Nobody should need a terminal to use their own app.
   *
   * Local-only, like every other write that touches credentials.
   *
   * **An empty string clears the field**, and that is distinct from omitting it.
   * Omitted means "leave what is there", which is what the form sends for a
   * secret box left blank because it is already set — the value is never sent
   * back to the browser, so a blank box cannot be allowed to mean "erase it".
   */
  app.put('/api/integrations/:provider/credentials', async (request) => {
    localOnly(request);
    const provider = parseProvider((request.params as { provider: string }).provider);
    const body = credentialsSchema.parse(request.body);

    const spec = PROVIDERS[provider];
    if (spec.credentials.length === 0) {
      throw Object.assign(new Error(`${spec.label} has nothing to configure`), { statusCode: 400 });
    }

    const values: Record<string, string | null> = {};
    for (const field of spec.credentials) {
      const given = body[field.key];
      if (given === undefined) continue;
      // Trimmed, because a trailing space pasted from a dashboard is invisible
      // and produces an authentication failure that names nothing.
      values[field.key] = given.trim() === '' ? null : given.trim();
    }

    await saveAccount(provider, values);
    changes.emitChange('integrations');

    return { saved: Object.keys(values), missingConfig: await missingCredentials(provider) };
  });

  /**
   * Where the provider redirects back to. **Deliberately outside `/api/`.**
   *
   * See `redirectUri` for the full reasoning. In short: `auth.ts` protects the
   * `/api/` prefix, and this is a navigation started by Google or Spotify that
   * will never carry a token — the same category as the icons and the manifest,
   * which had to move out for the same reason. `isTrustedLocal` refuses it too,
   * because an OAuth redirect is by definition cross-site and that check exists
   * to stop a page you are reading from talking to 127.0.0.1 behind your back.
   *
   * The `state` parameter is the protection here, and is sufficient: it is 32
   * random bytes, used once, expiring in ten minutes, and only ever issued by
   * the authorize route — which *is* local-only.
   */
  app.get('/oauth/callback/:provider', async (request, reply) => {
    const provider = parseProvider((request.params as { provider: string }).provider);
    const query = request.query as { code?: string; state?: string; error?: string; error_description?: string };

    reply.type('text/html');

    if (query.error) {
      /*
       * `invalid_scope` means one of the optional scopes is not available to
       * this application — Discord answers it for an app without the Social SDK
       * enabled. It arrives before any token, so the connection fails entirely
       * rather than merely losing the feature.
       *
       * Recorded so the next attempt does not ask for it and therefore
       * succeeds. Without this the only route out is editing the source, which
       * is not a route.
       */
      const spec = PROVIDERS[provider];
      if (query.error === 'invalid_scope' && (spec.oauth?.optionalScopes?.length ?? 0) > 0) {
        await saveAccount(provider, { optionalScopesRefused: 1 });
        changes.emitChange('integrations');

        return callbackPage(
          `${spec.label} would not grant everything`,
          `It refused <code>${(spec.oauth?.optionalScopes ?? []).join(' ')}</code>, which is what it answers ` +
            'for an application that does not have that feature enabled yet. ' +
            '<strong>Press Connect again</strong> — it will now ask only for what your application can grant, ' +
            'and the connection will go through. The card says which part is missing and how to enable it.'
        );
      }

      /*
       * Their words, not ours — `access_denied` is what pressing Cancel sends —
       * and therefore escaped. This is a query string on an unauthenticated
       * route, so "their words" means anybody's words.
       */
      return callbackPage(
        `${esc(spec.label)} refused`,
        `It said: <code>${esc(query.error)}</code>${
          query.error_description ? ` — ${esc(query.error_description)}` : ''
        }`
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
                ? await (await import('../providers/discord.js')).whoAmI()
                : /*
                   * Twitch matters more than a display name here: both of its
                   * endpoints take a `user_id` query parameter, so without this
                   * the first sync would have to identify before it could ask
                   * anything. `identify` saves the id as well as the name.
                   */
                  provider === 'twitch'
                  ? await (await import('../providers/twitch.js')).identify()
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
        .send(
          callbackPage(
            `${esc(PROVIDERS[provider].label)} could not be connected`,
            // A provider's token endpoint reply reaches this message verbatim.
            esc((error as Error).message)
          )
        );
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

  /**
   * Canvas: the school's address and an access token, in one submission.
   *
   * Same shape as Steam's route and for the same reason — both halves are
   * personal rather than an application registration, so neither belongs in an
   * environment variable and both are typed into one form. The difference is
   * that Canvas has no fixed host, so the address is not a convenience field:
   * without it there is nothing to send the token to.
   *
   * Verified before either is stored. A mistyped host and a revoked token store
   * perfectly happily and then fail on every sync afterwards, at which point the
   * message is about a failed sync rather than about the thing that was typed.
   */
  app.post('/api/integrations/canvas/connect', async (request) => {
    localOnly(request);
    const { host, token } = connectCanvasSchema.parse(request.body);

    const me = await canvas.verify(host, token);

    await saveAccount('canvas', {
      apiKey: token,
      baseUrl: me.base,
      // Both, as Steam does: `externalId` is what the rest of this module reads
      // to decide a provider is connected, and `accountId` is the service's id
      // for you. They are the same value here and mean different things.
      externalId: me.id,
      accountId: me.id,
      accountName: me.name,
      lastError: null,
    });

    return { connected: true, accountName: me.name, host: me.base };
  });

  app.delete('/api/integrations/:provider', async (request, reply) => {
    localOnly(request);
    const provider = parseProvider((request.params as { provider: string }).provider);
    await forgetAccount(provider);
    /*
     * The tasks it made stay; the memory of having made them goes.
     *
     * Deleting a fortnight of deadlines because a token was revoked would be
     * the worst possible reading of "disconnect" — they are ordinary tasks by
     * now, and may have your own notes on them. What has to go is the link
     * table, or reconnecting later would find every assignment already
     * accounted for and import nothing at all.
     */
    await forgetTaskLinks(provider);
    // The friends stay until the next refresh writes over them, which is the
    // wrong answer for a disconnected provider — so they go with the account.
    const { replaceFriends } = await import('../store.js');
    await replaceFriends(provider, []);
    return reply.code(204).send();
  });

  /* ---- syncing --------------------------------------------------- */

  app.post('/api/integrations/:provider/sync', async (request) => {
    const provider = parseProvider((request.params as { provider: string }).provider);
    const body = syncRequestSchema.parse(request.body ?? {});
    return { outcomes: await syncProvider(provider, body.capabilities as Capability[] | undefined) };
  });
}
