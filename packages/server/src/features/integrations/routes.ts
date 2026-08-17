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
  connectCanvasSchema,
  connectSteamSchema,
  credentialsSchema,
  IDENTITY_PREFERENCE,
  isHiddenByProviders,
  isProviderId,
  linkFriendsSchema,
  localPresenceSchema,
  presenceRank,
  resolveSetupLinks,
  syncRequestSchema,
  type Capability,
  type ProviderId,
} from '@everything/shared/integrations';
import { z } from 'zod';
import { config } from '../../config.js';
import { changes } from '../../events.js';
import { getSettings } from '../../nudge-engine.js';
import { parseHiddenProviders } from '../../routes/settings.js';
import {
  beginAuthorization,
  completeAuthorization,
  credentialState,
  credentialValue,
  grantedScopes,
  missingCredentials,
  optionalScopesRefused,
  redirectUri,
} from './oauth.js';
import * as canvas from './providers/canvas.js';
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
  forgetTaskLinks,
  getAccount,
  itemsInCollection,
  linkFollows,
  linkFriends,
  setCollectionIgnored,
  setPrimaryFollow,
  suggestFriendLinks,
  unlinkFollow,
  unlinkFriend,
  unlinkPerson,
  listAccounts,
  saveAccount,
  followPlaylistCounts,
  followsFreshness,
  syncedAtOf,
} from './store.js';
import { refreshPresence, runnableCapabilities, syncProvider } from './sync.js';

/** Everything the connections screen needs about one provider, in one object. */
async function providerState(id: ProviderId) {
  const account = await getAccount(id);
  const spec = PROVIDERS[id];

  /*
   * The portal's application id and the OAuth client id are the same value, so
   * the moment one has been pasted every "open your application" link can go
   * straight there instead of to a list you then search. Resolved here rather
   * than in the browser: the client id is not sent to it, deliberately.
   */
  const appId = (await credentialValue(id, 'clientId')) || null;

  return {
    ...spec,
    setup: resolveSetupLinks(spec.setup, appId),
    capabilities: Object.fromEntries(
      Object.entries(spec.capabilities).map(([name, capability]) => [
        name,
        capability?.unlock ? { ...capability, unlock: resolveSetupLinks(capability.unlock, appId) } : capability,
      ])
    ),
    /**
     * Connected means there is a *credential to act with*, not that a row
     * exists.
     *
     * The row is created the moment you save a client id, which is "configured
     * but not connected" — a state that did not exist before the fields moved
     * into the app. Reading `account !== null` here would have shown Spotify as
     * connected the instant you pasted its id, hidden the Connect button, and
     * left no way to finish.
     */
    connected: Boolean(account?.accessToken || account?.externalId),
    accountName: account?.accountName ?? null,
    /** The fields to fill in, whether each is set, and where it came from. */
    credentialFields: await credentialState(id),
    /**
     * The provider refused this app's optional scopes, so it has stopped asking.
     *
     * Surfaced because the alternative is a connection that quietly requests
     * less than it was designed to, with an empty list and nothing saying why.
     */
    optionalScopesRefused: await optionalScopesRefused(id),
    /**
     * What to paste into the provider's dashboard, character for character.
     *
     * Sent rather than written into the setup text because it depends on
     * OAUTH_REDIRECT_BASE and on the port — a hard-coded one in the
     * instructions would be wrong for anybody who changed either, and wrong in
     * a way whose only symptom is a rejected login.
     */
    redirectUri: spec.auth === 'oauth2' ? redirectUri(id) : null,
    /**
     * What was actually granted, not what was asked for. Discord hands back a
     * working token having silently dropped the presence scope, and without
     * this the screen would show a healthy connection and an empty friends list.
     */
    grantedScopes: grantedScopes(account),
    missingConfig: await missingCredentials(id),
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

      // Their words, not ours. `access_denied` is what pressing Cancel sends.
      return callbackPage(
        `${spec.label} refused`,
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

    /*
     * One row per person, not per account.
     *
     * Linked accounts were each returned separately, so a person you had
     * matched up appeared twice — which is the opposite of what linking them
     * was for. They are merged here, and the merge answers two questions from
     * two different rows:
     *
     *   - *who is this* comes from `IDENTITY_PREFERENCE`, Discord first,
     *     because that is where somebody chose a name and a picture for
     *     themselves rather than whatever their Steam persona happens to be;
     *   - *what are they doing* comes from whichever account actually knows,
     *     which is never Discord — its API carries no presence at all.
     *
     * Done on read rather than stored: the underlying rows refresh on their own
     * schedules, and a merged copy in the database would be a third thing to
     * keep in step.
     */
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = row.personId ?? `solo:${row.id}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }

    const identityRank = (provider: string) => {
      const index = IDENTITY_PREFERENCE.indexOf(provider as ProviderId);
      return index === -1 ? IDENTITY_PREFERENCE.length : index;
    };

    const resolved = [...groups.entries()].map(([key, group]) => {
      const identity = [...group].sort((a, b) => identityRank(a.provider) - identityRank(b.provider))[0];

      // The best thing anybody can actually vouch for. `unknown` is excluded
      // rather than ranked, so a Discord row never outvotes a Steam one that
      // knows the answer.
      const knows = group
        .filter((r) => r.state !== 'unknown')
        .sort(
          (x, y) =>
            presenceRank[x.state as keyof typeof presenceRank] - presenceRank[y.state as keyof typeof presenceRank]
        )[0];

      const speaking = knows ?? identity;

      return {
        id: key,
        personId: identity.personId,
        name: identity.name,
        avatarUrl: identity.avatarUrl,
        provider: identity.provider,
        state: speaking.state,
        game: speaking.game,
        detail: speaking.detail,
        lastOnlineAt: speaking.lastOnlineAt,
        seenAt: identity.seenAt,
        /** Named when the status came from a different account than the name. */
        statusFrom: knows && knows.provider !== identity.provider ? knows.provider : null,
        /** Every service this person is on, for the row and for unlinking. */
        accounts: group.map((r) => ({
          id: r.id,
          provider: r.provider,
          name: r.name,
          /*
           * The service's own id, which is what a deep link needs — the `id`
           * beside it is this app's row key and means nothing to Discord.
           * Carried for every provider rather than only the one that uses it
           * today, since it is already in hand and a second provider with a
           * "message them" link would otherwise be a second change here.
           */
          providerUserId: r.providerUserId,
        })),
      };
    });

    /*
     * Services you have chosen to leave out.
     *
     * **Only when *every* account a person has is on a hidden service.** That is
     * the whole distinction: hiding Riot should drop the hundred people you know
     * only from League, and must not drop the friend you play League *and* talk
     * to on Discord with — that person is still someone you wanted to see, and
     * quietly losing them is exactly what makes a filter untrustworthy.
     *
     * Filtered here rather than in the PWA because the rule has to live once,
     * and the PWA cannot import `shared` to share it. This way the phone gets
     * the same list without a second copy of the condition.
     */
    const hidden = parseHiddenProviders((await getSettings()).hiddenProviders);
    const visible = resolved.filter((entry) => !isHiddenByProviders(entry.accounts, hidden));

    return {
      friends: visible.sort(
        (a, b) =>
          presenceRank[a.state as keyof typeof presenceRank] - presenceRank[b.state as keyof typeof presenceRank] ||
          a.name.localeCompare(b.name)
      ),
      /**
       * What is being left out, and how many.
       *
       * Reported rather than merely applied: this screen's whole principle is
       * that a short list explains itself, and "nobody is online" reads as a
       * broken integration when the real answer is a filter you set weeks ago.
       */
      hiddenProviders: hidden,
      hiddenCount: resolved.length - visible.length,
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
   * Say that two accounts are the same person.
   *
   * Local-only like every other write here. The pairing is a claim about people
   * you know, and it is the sort of thing that should not be editable from a
   * phone left on a table.
   */
  app.post('/api/integrations/friends/link', async (request) => {
    localOnly(request);
    const { a, b } = linkFriendsSchema.parse(request.body);
    const personId = await linkFriends(a, b);
    changes.emitChange('integrations');
    return { personId };
  });

  /**
   * Undo a link.
   *
   * By `personId` for a merged row, which is one thing on screen and should
   * come apart in one action; by `id` to take a single account out of a group
   * of three and leave the rest joined. The screen uses the first, and the
   * second exists because a group is not always a pair.
   */
  app.post('/api/integrations/friends/unlink', async (request) => {
    localOnly(request);
    const body = z
      .object({ id: z.string().min(1).optional(), personId: z.string().min(1).optional() })
      .refine((v) => v.id || v.personId, { message: 'give an id or a personId' })
      .parse(request.body);

    if (body.personId) await unlinkPerson(body.personId);
    else if (body.id) await unlinkFriend(body.id);

    changes.emitChange('integrations');
    return { ok: true };
  });

  /* ---- the same, for accounts you follow -------------------------- */

  /**
   * Say that two followed accounts are the same creator.
   *
   * Deliberately **not** `linkFriendsSchema`, which would be the obvious reuse:
   * that one exists next to a rule that the two must be different services, and
   * here they very often are not — a main channel and a clips channel is the
   * commonest case. Sharing the schema would have invited sharing the rule.
   */
  app.post('/api/integrations/follows/link', async (request) => {
    localOnly(request);
    const { a, b } = z.object({ a: z.string().min(1), b: z.string().min(1) }).parse(request.body);
    const groupId = await linkFollows(a, b);
    changes.emitChange('integrations');
    return { groupId };
  });

  /** Which of a group's accounts the merged row wears. */
  app.post('/api/integrations/follows/primary', async (request) => {
    localOnly(request);
    const { id } = z.object({ id: z.string().min(1) }).parse(request.body);
    await setPrimaryFollow(id);
    changes.emitChange('integrations');
    return { ok: true };
  });

  /**
   * Take one account out of its group.
   *
   * By account rather than by group, unlike the friends version. A creator's
   * group can hold several channels, and dissolving all of them to correct one
   * wrong link would be a poor trade — whereas a friends row is nearly always a
   * pair, where the two are the same action.
   */
  app.post('/api/integrations/follows/unlink', async (request) => {
    localOnly(request);
    const { id } = z.object({ id: z.string().min(1) }).parse(request.body);
    await unlinkFollow(id);
    changes.emitChange('integrations');
    return { ok: true };
  });

  /**
   * Accounts whose names look like the same person.
   *
   * Suggestions only — Discord will not tell us a friend's Steam profile, so
   * there is nothing authoritative to import and a name is a guess. Confirmed
   * one at a time by the person who knows.
   */
  app.get('/api/integrations/friends/suggestions', async () => ({
    suggestions: await suggestFriendLinks(),
  }));

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
    const counts = await followPlaylistCounts();
    const rows = await allFollows();

    /*
     * The same setting as the friends list, applied the only way that makes
     * sense here.
     *
     * A follow belongs to exactly one service — a YouTube channel is not also a
     * Spotify artist — so there is no equivalent of "they are on two of these
     * and one is hidden". Hiding YouTube leaves out its channels and hiding
     * Spotify leaves out its artists, which is the plain reading of the switch,
     * and `isHiddenByProviders` gives it for free: with one account the
     * every-account test *is* the single-provider test.
     */
    const hidden = parseHiddenProviders((await getSettings()).hiddenProviders);
    const visible = rows.filter((row) => !isHiddenByProviders([{ provider: row.provider }], hidden));

    /*
     * One row per creator, not per account — the same merge the friends list
     * does, for the same reason: a main channel and its clips channel linked
     * together should stop being two entries.
     *
     * Two things differ from friends. The identity is the member you *chose*
     * rather than one a preference order picked, because no rule can say which
     * of two YouTube channels is the main one. And `inPlaylists` is **summed**
     * across the group rather than taken from the identity: the number is what
     * the list sorts by, and showing only the main channel's share would rank a
     * creator below people you listen to far less.
     */
    const groups = new Map<string, typeof visible>();
    for (const row of visible) {
      const key = row.groupId ?? `solo:${row.id}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }

    const merged = [...groups.entries()].map(([key, group]) => {
      // `ensurePrimary` guarantees one, but a row read mid-write should still
      // render rather than throw — so fall back rather than assume.
      const identity = group.find((row) => row.isPrimary === 1) ?? group[0];

      return {
        ...identity,
        id: key,
        /** Null when this stands alone, so the UI can tell a group from a row. */
        groupId: identity.groupId,
        inPlaylists: group.reduce(
          (total, row) => total + (counts.get(`${row.provider}:${row.providerAccountId}`) ?? 0),
          0
        ),
        /** Every account behind this row, for the chips and for unlinking. */
        accounts: group.map((row) => ({
          id: row.id,
          provider: row.provider,
          name: row.name,
          kind: row.kind,
          isPrimary: row.isPrimary === 1,
        })),
      };
    });

    return {
      /*
       * Each one carries how many of its tracks or videos are in your
       * collections, because that is what the tab sorts by out of the box —
       * "who am I following that I actually listen to" is a more useful first
       * screen than an alphabetical list of four hundred names.
       */
      follows: merged,
      /** What is being left out, so a short list can explain itself. */
      hiddenProviders: hidden,
      hiddenCount: rows.length - visible.length,
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
  app.get('/api/integrations/music', async () => ({ breakdown: await categoryBreakdown() }));

  /* ---- the one thing here on a timer ----------------------------- */

  /**
   * Coursework, brought in without being asked.
   *
   * **The only background timer in this module, and it needs the argument this
   * project asks of anything on a clock.** Everything else here is
   * refresh-on-read: a friends list nobody is looking at does not need to be
   * right, so a 60-second poller was refused at 1,440 requests a day.
   *
   * Coursework is the opposite case, and the difference is what the data is
   * *for*. A friends list is something you go and look at, so reading it is the
   * moment it has to be true. A deadline's whole job is to reach the nudge
   * queue while you are thinking about something else — an assignment set on
   * Monday has to be in the queue on Thursday whether or not you have opened
   * the Services tab since. A "Sync now" button as the only route in would mean
   * the one feature that exists to remember things for you had to be
   * remembered.
   *
   * The number: **48 requests a day while connected, none at all otherwise**,
   * against a friends poller that was refused at 1,440 and an attention loop
   * budgeted at ~1,500 database rows a day. Half an hour is chosen against the
   * sweep, which queues a task within an hour of its due time — so the worst
   * case is that something set half an hour ago is half an hour late into a
   * queue it was never going to fire from yet.
   *
   * Owned by the feature rather than hung off the attention heartbeat, so it
   * goes away with the folder and core never learns it exists.
   */
  const COURSEWORK_EVERY_MS = 30 * 60_000;

  const sweepCoursework = async () => {
    // Costs one row read when nothing is connected, which is the ordinary case
    // for anybody who has not set Canvas up. No account, no request.
    const account = await getAccount('canvas');
    if (!account?.apiKey || !account.baseUrl) return;

    try {
      await syncProvider('canvas', ['assignments']);
    } catch (error) {
      // Never allowed to escape: this runs on a timer with nobody waiting on
      // it, and an unhandled rejection here would take the server down over a
      // school VPN being off. `syncProvider` has already recorded the failure
      // against the account, which is where the screen reads it from.
      app.log.warn({ err: error }, 'canvas sweep failed');
    }
  };

  // Shortly after boot as well as on the interval, or a restart means half an
  // hour of not knowing about anything set while the machine was off.
  const firstRun = setTimeout(() => void sweepCoursework(), 30_000);
  const repeat = setInterval(() => void sweepCoursework(), COURSEWORK_EVERY_MS);
  // Neither may hold the process open — `smoke` and `features-check` build an
  // app, assert, and close it, and a live interval would leave them hanging.
  firstRun.unref();
  repeat.unref();
  app.addHook('onClose', () => {
    clearTimeout(firstRun);
    clearInterval(repeat);
  });
}
