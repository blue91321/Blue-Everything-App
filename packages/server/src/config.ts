/**
 * Every environment-dependent value the server needs, in one validated place.
 *
 * Nothing else in the codebase may read `process.env`. That rule is what makes
 * relocating this server — to a VPS, a container, a different box on Tailscale —
 * a matter of changing env vars rather than hunting through source.
 */
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, resolve } from 'node:path';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Anchor a relative `file:` database to the server package, not the working
 * directory.
 *
 * Launched by hand from the package this makes no difference; launched by Task
 * Scheduler — which starts in C:\Windows\System32 — a relative path would
 * quietly create a second, empty database and the app would look wiped.
 * Absolute paths and remote URLs are left exactly as given.
 */
function anchorDatabaseUrl(url: string): string {
  if (!url.startsWith('file:')) return url;
  const path = url.slice('file:'.length);
  return isAbsolute(path) ? url : `file:${resolve(packageRoot, path)}`;
}

const envSchema = z.object({
  /**
   * `0.0.0.0` on purpose: the Windows agent and the phone both reach the server
   * over the network, even when it happens to be running on the same PC. Binding
   * to localhost would work today and break the moment it moves.
   */
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8787),

  /**
   * libsql URL. `file:` is a local SQLite file; swap in a `libsql://` or
   * `http://` URL to point at a remote database with no code change.
   */
  DATABASE_URL: z.string().default('file:./data/everything.db'),
  DATABASE_AUTH_TOKEN: z.string().optional(),

  /**
   * Disable only for throwaway local testing. Once this server is reachable
   * over Tailscale it is reachable by anything else on that tailnet.
   */
  AUTH_REQUIRED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  /**
   * Comma-separated origins allowed to call the API cross-origin. Empty by
   * default, and it should stay that way: the PWA is served from this same
   * origin, so it needs no CORS at all. A wildcard here would let any web page
   * You happen to visit read your data off 127.0.0.1.
   */
  CORS_ORIGIN: z.string().default(''),

  /**
   * VAPID `sub` claim — a contact for the push service, not an address anything
   * is sent to.
   *
   * Must be a well-formed `mailto:` or `https:` URI with a real-looking domain.
   * Apple rejects `localhost` outright with `403 BadJwtToken`, which is why the
   * obvious `mailto:...@localhost` silently broke every push to iPhone.
   */
  VAPID_SUBJECT: z
    .string()
    .default('mailto:everything-app@example.com')
    .refine((v) => /^(mailto:[^@\s]+@[^@\s.]+\.[^@\s]+|https:\/\/\S+)$/.test(v) && !v.includes('localhost'), {
      message: 'must be mailto:name@domain.tld or https://host, and cannot use localhost',
    }),

  /**
   * Which features to run, comma-separated — `vault,voice`. Overrides
   * `features.json` entirely, and naming any feature means everything unnamed
   * is off. Empty (the default) defers to the file, and an absent file defers
   * to the manifest's own defaults.
   *
   * Parsed in `features.ts`; read here only because this is the one file
   * allowed to touch `process.env`.
   */
  FEATURES: z.string().default(''),

  /**
   * Where to ask whether a newer version of anything exists.
   *
   * Empty by default and empty today: there is nowhere to ask yet. The Packages
   * screen reads this to decide whether "Check for updates" can do anything,
   * and says so plainly rather than offering a button that fails — the same
   * reasoning as the feature switches being disabled with a reason when
   * `EVERYTHING_FEATURES` overrides them.
   *
   * Nothing is fetched from it until there is a format to fetch. Declaring it
   * now is what makes turning that on a small change rather than a new concept.
   */
  UPDATE_URL: z.string().default(''),

  /* ---- app integrations ------------------------------------------ */

  /**
   * Credentials for the outside services, one app per provider, all registered
   * by you against your own accounts.
   *
   * Every one is empty by default and the Integrations screen names the missing
   * variable rather than offering a Connect button that fails — the same rule
   * the Packages screen follows for `UPDATE_URL`. They are env vars rather than
   * settings rows because they identify the *application*, not you: they belong
   * with the install, they are the same on a reinstall, and they have no
   * business being editable from a phone.
   *
   * Only Battle.net genuinely needs a secret. Spotify, Google and Discord all
   * support PKCE, so their secrets stay unset and there is nothing to leak.
   */
  SPOTIFY_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  DISCORD_CLIENT_ID: z.string().default(''),
  DISCORD_CLIENT_SECRET: z.string().default(''),
  BATTLENET_CLIENT_ID: z.string().default(''),
  BATTLENET_CLIENT_SECRET: z.string().default(''),
  STEAM_API_KEY: z.string().default(''),

  /**
   * The origin an OAuth provider redirects back to, which must match what is
   * registered at their end *character for character* — a trailing slash is a
   * rejected login.
   *
   * Defaults to the loopback IP literal rather than `localhost`, because Spotify
   * and Google both stopped accepting `http://localhost` while continuing to
   * accept `http://127.0.0.1`. They are the same machine and not the same
   * string, and the error message says neither.
   */
  OAUTH_REDIRECT_BASE: z.string().default(''),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /** Set when running behind a reverse proxy so client IPs log correctly. */
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

export const config = {
  ...parsed.data,
  DATABASE_URL: anchorDatabaseUrl(parsed.data.DATABASE_URL),
  // Derived here rather than defaulted in the schema, because it depends on
  // PORT, which is a sibling field and therefore not available to a `.default()`.
  OAUTH_REDIRECT_BASE:
    parsed.data.OAUTH_REDIRECT_BASE.replace(/\/$/, '') || `http://127.0.0.1:${parsed.data.PORT}`,
};

const configuredOrigins = config.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Same-origin only, plus browser extensions.
 *
 * The extension's requests carry `Origin: chrome-extension://<id>`, which is
 * cross-origin by definition — so without this the browser discards every
 * response even though the server answered. Allowing the scheme is not a
 * loosening worth worrying about: every `/api` route still demands a bearer
 * token, and the vault additionally demands an `extension`-kind device.
 */
export const corsOrigins =
  config.CORS_ORIGIN === '*'
    ? true
    : (origin: string | undefined, callback: (error: Error | null, allow: boolean) => void) => {
        // No Origin header at all: same-origin navigation, or a non-browser
        // client like the agent. Nothing for CORS to protect.
        if (!origin) return callback(null, true);
        if (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) {
          return callback(null, true);
        }
        callback(null, configuredOrigins.includes(origin));
      };
