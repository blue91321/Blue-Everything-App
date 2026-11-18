/**
 * What more than one group of integrations routes uses.
 */
import { PROVIDERS, isProviderId, resolveSetupLinks, type ProviderId } from '@everything/shared/integrations';
import { config } from '@everything/server/module-api';
import {
  credentialState,
  credentialValue,
  grantedScopes,
  missingCredentials,
  optionalScopesRefused,
  redirectUri,
} from '../oauth.js';
import { localStatusOf } from '../providers/local.js';
import { getAccount, syncedAtOf } from '../store.js';
import { runnableCapabilities } from '../sync.js';

/** Everything the connections screen needs about one provider, in one object. */
export async function providerState(id: ProviderId) {
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

export function parseProvider(value: string): ProviderId {
  if (!isProviderId(value)) throw Object.assign(new Error('no such provider'), { statusCode: 404 });
  return value;
}

/**
 * Anything from outside, made safe to put in HTML.
 *
 * **The callback page is the one place this app builds HTML by hand**, and it
 * interpolated the provider's `error` and `error_description` straight in. Those
 * come off the query string of an unauthenticated route, so
 * `/oauth/callback/spotify?error=<script>…` was reflected verbatim — on the same
 * origin that holds the device bearer token in `localStorage`. Confirmed with a
 * real request before this existed: HTTP 200, `text/html`, script tag intact.
 *
 * The `'` and `"` cases matter as much as the angle brackets: without them a
 * value landing inside an attribute escapes it without needing a tag at all.
 */
export function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A tiny page for the OAuth redirect to land on, since it is a real navigation. */
export function callbackPage(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 3rem auto; max-width: 32rem; padding: 0 1rem;
         background: #14161c; color: #e7e9ee; }
  a { color: #6aa6ff; }
  code { background: #22252e; padding: .15em .4em; border-radius: 4px; }
</style>
<h1>${title}</h1><p>${body}</p><p><a href="/">Back to Blue Everything</a></p>`;
}

/** Guard for everything that changes a connection. */
export const localOnly = (request: { isLocal: boolean }) => {
  if (!request.isLocal) {
    throw Object.assign(new Error('connections can only be changed from the PC running the server'), {
      statusCode: 403,
    });
  }
};
