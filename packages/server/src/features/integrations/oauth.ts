/**
 * The OAuth dance, once, for every provider that does it.
 *
 * Four services, four sets of documentation, one flow — because they genuinely
 * are the same flow, and the places they differ are all data: which URL, which
 * scopes, whether PKCE is offered, and what extra query parameters are needed to
 * make a refresh token come back. Those live in the manifest in `shared`, so
 * adding a fifth provider is an entry in a table rather than a fifth copy of
 * this file with one line changed.
 *
 * **Connecting is a local-only operation**, guarded in `routes.ts`. It is the
 * same rule minting a device token follows and for the same reason: the redirect
 * comes back to a browser on this PC, and a phone over Tailscale has no business
 * starting a handshake it cannot finish.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  PROVIDERS,
  type CredentialField,
  type ProviderId,
  type ProviderSpec,
} from '@everything/shared/integrations';
import { config } from '../../config.js';
import { getAccount, saveAccount, type Account } from './store.js';

/* ------------------------------------------------------------------ */
/* Credentials                                                         */
/* ------------------------------------------------------------------ */

/**
 * Reading a named environment variable off the validated config.
 *
 * Which variable belongs to which provider is declared in the manifest, on the
 * field that needs it, rather than in a second table here — the form, the
 * "is this configured" check and the fallback all have to agree about the name,
 * and three places listing it is how they stop agreeing.
 *
 * `config` is still the only thing in the codebase that touches `process.env`;
 * this looks a value up in the parsed result.
 */
type ConfigKey = keyof typeof config;

export function envValue(name: string): string {
  const value = config[name as ConfigKey];
  return typeof value === 'string' ? value : '';
}

/**
 * The value for one credential field: what was typed in, else the env var.
 *
 * **That order is load-bearing.** An env var that won the tie would make pasting
 * a client id into the app appear to work and change nothing at all — the same
 * class of bug as `features.json` being read from a directory nobody was writing
 * to: self-consistent, convincing, and wrong.
 */
export async function credentialValue(
  provider: ProviderId,
  key: CredentialField['key']
): Promise<string> {
  const field = PROVIDERS[provider].credentials.find((f) => f.key === key);
  if (!field) return '';

  const account = await getAccount(provider);
  const stored = key === 'clientId' ? account?.clientId : account?.clientSecret;
  return stored?.trim() || envValue(field.envVar);
}

/**
 * Which required fields are still empty, by env var name.
 *
 * Named by env var because that is what the message has always said, and it is
 * still the other way to supply one. The screen now leads with the text box and
 * mentions the variable second, which is the right order for somebody who is
 * never going to open a file.
 */
export async function missingCredentials(provider: ProviderId): Promise<string[]> {
  const missing: string[] = [];
  for (const field of PROVIDERS[provider].credentials) {
    if (!field.required) continue;
    if (!(await credentialValue(provider, field.key))) missing.push(field.envVar);
  }
  return missing;
}

/** Which fields have a value at all, and where it came from. For the form. */
export async function credentialState(provider: ProviderId) {
  const account = await getAccount(provider);

  return PROVIDERS[provider].credentials.map((field) => {
    const stored = field.key === 'clientId' ? account?.clientId : account?.clientSecret;
    const fromEnv = envValue(field.envVar);
    return {
      ...field,
      /**
       * Whether anything is set, without saying what.
       *
       * The value itself is never sent back to the browser once stored — a
       * secret that round-trips through a page is a secret in the DOM, in the
       * response cache and in any devtools that were open. The box renders
       * empty with a placeholder saying it is already set, and typing replaces
       * it.
       */
      set: Boolean(stored?.trim() || fromEnv),
      source: stored?.trim() ? ('app' as const) : fromEnv ? ('env' as const) : ('none' as const),
    };
  });
}

export async function clientId(provider: ProviderId): Promise<string> {
  return credentialValue(provider, 'clientId');
}

export async function clientSecret(provider: ProviderId): Promise<string> {
  return credentialValue(provider, 'clientSecret');
}

/**
 * Where the provider sends the browser back to.
 *
 * **Outside `/api/`, and that is load-bearing** — the same reason the icons and
 * the generated manifest had to move out. `auth.ts` protects exactly that
 * prefix, and this request is a browser navigation started by Google or Spotify,
 * which will never carry a bearer token.
 *
 * It was under `/api/` first, on the reasoning that it arrives on a loopback
 * socket with a loopback Host so `isTrustedLocal` would allow it. That reasoning
 * was incomplete and the callback failed with `missing bearer token` on the
 * first real attempt: `isTrustedLocal` *also* refuses a cross-site
 * `Sec-Fetch-Site`, and an OAuth redirect from accounts.google.com is precisely
 * a cross-site navigation. That check is correct and must stay — it is what
 * stops a page you are reading from POSTing to 127.0.0.1 in the background — so
 * the route is what had to move.
 *
 * Nothing is lost by being unauthenticated. The `state` parameter is what
 * protects this endpoint and always was: 32 random bytes, single-use, ten-minute
 * window, and worthless to anybody who did not start the handshake here.
 */
export function redirectUri(provider: ProviderId): string {
  return `${config.OAUTH_REDIRECT_BASE}/oauth/callback/${provider}`;
}

/* ------------------------------------------------------------------ */
/* The handshake                                                       */
/* ------------------------------------------------------------------ */

interface PendingAuth {
  provider: ProviderId;
  verifier: string;
  startedAt: number;
}

/**
 * In-memory, and that is correct rather than lazy.
 *
 * A pending handshake is worthless after a restart — the provider will redirect
 * back to a process that no longer holds the verifier, and the right answer then
 * is "start again", which is exactly what an empty map produces. Persisting it
 * would buy the ability to resume a login across a server restart that happened
 * inside a thirty-second window.
 */
const pending = new Map<string, PendingAuth>();
const AUTH_WINDOW_MS = 10 * 60_000;

function sweepPending(): void {
  const cutoff = Date.now() - AUTH_WINDOW_MS;
  for (const [state, entry] of pending) {
    if (entry.startedAt < cutoff) pending.delete(state);
  }
}

const base64url = (buffer: Buffer): string => buffer.toString('base64url');

/**
 * Build the URL to send the browser to, and remember what we will need when it
 * comes back.
 *
 * The `state` is a random 32 bytes checked on return — it is what stops a page
 * you happen to be visiting from feeding this endpoint somebody else's
 * authorization code and connecting your app to their account. On a loopback
 * redirect that is not a theoretical concern: the callback URL is guessable, and
 * `isTrustedLocal` deliberately trusts anything arriving from this machine.
 */
export async function beginAuthorization(provider: ProviderId): Promise<{ url: string; state: string }> {
  const spec = PROVIDERS[provider];
  if (!spec.oauth) throw new Error(`${spec.label} does not use OAuth`);

  // Async now that a credential can live in the database rather than only in
  // the environment. The alternative was a synchronous cache of the row, which
  // is a cache to invalidate for a call made twice a year.
  const missing = await missingCredentials(provider);
  if (missing.length > 0) {
    throw Object.assign(
      new Error(
        `${spec.label} is not configured yet — fill in its ${missing.length === 1 ? 'field' : 'fields'} above ` +
          `(or set ${missing.join(' and ')}).`
      ),
      { statusCode: 400 }
    );
  }

  sweepPending();

  const state = base64url(randomBytes(32));
  const verifier = base64url(randomBytes(64));
  pending.set(state, { provider, verifier, startedAt: Date.now() });

  /*
   * The optional scopes are dropped once the provider has refused them, and
   * only then. Asking is right the first time — an application that *does* have
   * the gated feature should get it without being asked to opt in — and asking
   * again after a refusal is just the same failure on a loop.
   */
  const account = await getAccount(provider);
  const optional = account?.optionalScopesRefused ? [] : spec.oauth.optionalScopes ?? [];

  const params = new URLSearchParams({
    client_id: await clientId(provider),
    response_type: 'code',
    redirect_uri: redirectUri(provider),
    scope: [...spec.oauth.scopes, ...optional].join(' '),
    state,
    ...(spec.oauth.authorizeParams ?? {}),
  });

  if (spec.oauth.pkce) {
    params.set('code_challenge_method', 'S256');
    params.set('code_challenge', base64url(createHash('sha256').update(verifier).digest()));
  }

  return { url: `${spec.oauth.authorizeUrl}?${params}`, state };
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

async function postToken(spec: ProviderSpec, provider: ProviderId, body: URLSearchParams): Promise<TokenResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };

  // Confidential clients want the secret as HTTP Basic rather than in the body.
  // No provider here sets `needsSecret` today — the branch stays because it is
  // what a confidential client requires, and dropping it would make adding one
  // a change to the flow rather than a line in the manifest.
  if (spec.oauth?.needsSecret) {
    const secret = await clientSecret(provider);
    const id = await clientId(provider);
    headers.authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
  } else {
    body.set('client_id', await clientId(provider));
    // Google issues a "Web application" client that demands a secret even with
    // PKCE. Sent only when one is actually configured, so the PKCE-only path
    // stays secretless.
    const secret = await clientSecret(provider);
    if (secret) body.set('client_secret', secret);
  }

  const response = await fetch(spec.oauth!.tokenUrl, { method: 'POST', headers, body });
  const text = await response.text();

  if (!response.ok) {
    // The provider's own words, not ours. `invalid_grant` and
    // `redirect_uri_mismatch` are the two failures that actually happen, and
    // both are fixed by reading exactly what was sent back.
    throw new Error(`${spec.label} token endpoint said ${response.status}: ${text.slice(0, 300)}`);
  }

  return JSON.parse(text) as TokenResponse;
}

/**
 * Finish the handshake. Returns the provider so the caller can name it.
 */
export async function completeAuthorization(state: string, code: string): Promise<ProviderId> {
  sweepPending();

  const entry = pending.get(state);
  // One use only. A replayed callback is either a double-click or something
  // worse, and neither should mint a second token.
  pending.delete(state);
  if (!entry) throw new Error('this sign-in has expired or was not started here — try connecting again');

  const spec = PROVIDERS[entry.provider];
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(entry.provider),
  });
  if (spec.oauth?.pkce) body.set('code_verifier', entry.verifier);

  const token = await postToken(spec, entry.provider, body);

  await saveAccount(entry.provider, {
    accessToken: token.access_token,
    // Absent on a re-consent at most providers, and overwriting the stored one
    // with undefined is how a working connection quietly becomes unrefreshable.
    ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
    expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : null,
    scopes: JSON.stringify(token.scope ? token.scope.split(' ') : spec.oauth?.scopes ?? []),
    lastError: null,
  });

  return entry.provider;
}

/* ------------------------------------------------------------------ */
/* Using it afterwards                                                 */
/* ------------------------------------------------------------------ */

/** Refresh a minute early, so a token cannot expire between the check and the call. */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * A usable access token, refreshing first if it is about to expire.
 *
 * Throws rather than returning null, and the message is written to be read on
 * the screen: every caller is a sync that is about to fail anyway, and "Spotify
 * is not connected" is more use than a null that turns into a type error three
 * frames up.
 */
export async function accessTokenFor(provider: ProviderId): Promise<string> {
  const account = await getAccount(provider);
  if (!account?.accessToken) throw new Error(`${PROVIDERS[provider].label} is not connected`);

  if (!account.expiresAt || account.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
    return account.accessToken;
  }

  return refresh(provider, account);
}

async function refresh(provider: ProviderId, account: Account): Promise<string> {
  const spec = PROVIDERS[provider];
  if (!account.refreshToken) {
    throw new Error(
      `${spec.label} needs connecting again — its access token has expired and no refresh token was issued`
    );
  }

  const token = await postToken(
    spec,
    provider,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: account.refreshToken })
  );

  await saveAccount(provider, {
    accessToken: token.access_token,
    // Providers that rotate refresh tokens hand back a new one; those that do
    // not omit it, and the old one stays valid. Overwriting unconditionally
    // breaks the second group.
    ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
    expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : null,
    lastError: null,
  });

  return token.access_token;
}

/**
 * A GET against a provider's API with the token attached, refreshing once on a
 * 401.
 *
 * The retry is worth the complication because access tokens expire on the
 * provider's clock, not ours: a token we believe has nine minutes left is
 * revoked the moment you change your password, and without this every sync after
 * that fails until somebody notices and reconnects by hand.
 */
export async function apiGet<T>(
  provider: ProviderId,
  url: string,
  /**
   * Anything the provider wants beyond the bearer token.
   *
   * Twitch is the reason this exists: every Helix call must carry `Client-Id`
   * alongside the token, and a provider writing its own fetch to add one header
   * would lose the refresh-on-401 and the `Retry-After` handling below — the two
   * parts that are genuinely hard to get right and easy to forget.
   */
  extraHeaders: Record<string, string> = {}
): Promise<T> {
  const attempt = async (token: string) =>
    fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...extraHeaders },
    });

  let response = await attempt(await accessTokenFor(provider));

  if (response.status === 401) {
    const account = await getAccount(provider);
    if (account?.refreshToken) response = await attempt(await refresh(provider, account));
  }

  /*
   * A first library sync is hundreds of requests in a row, which is precisely
   * the shape that trips a rate limiter, so waiting is the normal path rather
   * than an error path. `Retry-After` is honoured because guessing at a backoff
   * against a service that told you the number is how you get a longer ban.
   *
   * Capped at 30s and tried once: a longer wait than that means the sync should
   * fail visibly and be started again, not sit silently holding a request open.
   */
  if (response.status === 429) {
    const wait = Math.min(Number(response.headers.get('retry-after') ?? 5) * 1000, 30_000);
    await new Promise((r) => setTimeout(r, wait));
    response = await attempt(await accessTokenFor(provider));
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${PROVIDERS[provider].label} returned ${response.status}: ${body.slice(0, 300)}`);
  }

  return (await response.json()) as T;
}

/** Which scopes the provider actually granted, which is not what we asked for. */
export function grantedScopes(account: Account | null): string[] {
  if (!account) return [];
  try {
    return JSON.parse(account.scopes) as string[];
  } catch {
    return [];
  }
}

/**
 * Whether this provider will still be asked for its optional scopes.
 *
 * Exposed so the card can say "Discord refused the friends list scope" and
 * offer to try again, rather than leaving a connection that silently asks for
 * less than it used to with nothing on screen to explain it.
 */
export async function optionalScopesRefused(provider: ProviderId): Promise<boolean> {
  return Boolean((await getAccount(provider))?.optionalScopesRefused);
}
