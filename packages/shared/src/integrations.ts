/**
 * App integrations: which outside services this app talks to, and — much more
 * importantly — *what each one is actually able to tell us*.
 *
 * The capability matrix below is the point of this file. Every one of these
 * seven services has a page somewhere implying you can read your playlists and
 * see who is online, and for four of them that is not true through any API a
 * personal app is allowed to use. Discovering that one provider at a time, after
 * building a screen that shows an empty list, is the expensive way to find out.
 *
 * So a capability is not a boolean. It carries a `status` and a `why`, the
 * screen renders the `why` next to the thing it explains, and a provider that
 * cannot do something says so *before* you connect it rather than after. The
 * same reasoning as `FeatureSpec.removable` being honest rather than
 * aspirational: a `true` that isn't sends somebody debugging their own code for
 * an evening.
 *
 * Kept in `shared` rather than in the server so the CLI, the server and the
 * agent read one list. The PWA is the usual exception — it does not import this
 * package — so `/api/integrations/providers` hands it the manifest as plain
 * JSON, exactly as `/api/session` does for features.
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Providers                                                           */
/* ------------------------------------------------------------------ */

export const PROVIDER_IDS = [
  'spotify',
  'youtube',
  'steam',
  'discord',
  'riot',
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * How we reach a service at all. This decides which *process* does the work,
 * which is why it is a first-class field rather than an implementation detail.
 *
 *   - `web`    the server calls an HTTP API. Survives the server moving to a VPS.
 *   - `local`  only a process on this PC can see it — a lockfile, a running
 *              client, a loopback socket the vendor opened for their own UI.
 *              That is the agent's job, and it does not move.
 *   - `import` there is no API; you export a file from the service and we read
 *              it. No provider uses this today — YouTube watch history did,
 *              until history was dropped — but it is a real third way in, and
 *              naming it keeps `reach` a description rather than a boolean.
 */
export const REACHES = ['web', 'local', 'import'] as const;
export type Reach = (typeof REACHES)[number];

/**
 * How a connection is established.
 *
 *   - `oauth2`  the ordinary redirect dance. `pkce` says whether the provider
 *               supports it; where it does we use it and store no client secret.
 *   - `api-key` a key you paste, plus whatever identifies you. Steam.
 *   - `client`  nothing to connect — the vendor's own client on this PC is the
 *               credential, and the agent reads it.
 *   - `file`    you upload an export.
 */
export const AUTH_KINDS = ['oauth2', 'api-key', 'client', 'file'] as const;
export type AuthKind = (typeof AUTH_KINDS)[number];

/**
 * What a provider might be asked for.
 *
 * `follows` and `friends` are deliberately separate, and collapsing them was the
 * original mistake. A Steam friend is a mutual relationship with somebody who is
 * either around or not; a YouTube subscription or a followed Spotify artist is a
 * one-way interest in an account that has no presence at all. Filing the second
 * under the first put "Spotify — friends: not possible" on a screen about who is
 * online, which answers a question nobody asked and buries the one they did.
 */
export const CAPABILITIES = ['playlists', 'taste', 'follows', 'friends'] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * Whether it works, and if not, why not.
 *
 * `partial` is the interesting one and is the honest answer for several of
 * these. Riot's friends list is real and complete, and readable only while the
 * League client is running; YouTube's categories come from tags that music
 * videos carry inconsistently. Reporting either as `works` would make a screen
 * look broken the first time it fell short, and `unavailable` would throw away
 * something that mostly does the job.
 *
 * `needs-approval` and `unavailable` are unused by the shipped manifest and
 * `integrations-check` asserts the second stays that way. They remain because
 * the next provider may need them.
 */
export const CAPABILITY_STATUSES = ['works', 'partial', 'needs-approval', 'unavailable'] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export interface CapabilitySpec {
  status: CapabilityStatus;
  /** One sentence, shown on the screen beside the thing it is about. */
  why: string;
  /** Where the limit comes from, for when the sentence above is not believed. */
  source?: string;
  /**
   * The page that `source` refers to, when there is one to open.
   *
   * Separate from `source` rather than inferred from it, because half of these
   * citations are not addresses — `ISteamUser/GetFriendList + GetPlayerSummaries`
   * names two endpoints, and turning that into a link would invent a page.
   */
  sourceUrl?: string;
  /**
   * How to turn this on, for a capability the provider gates.
   *
   * Attached to the capability rather than to the provider's `setup`, because
   * it is not part of connecting: you can have a working connection and still
   * not have this. Rendered next to the thing it unlocks and again in the
   * banner you get when the provider refuses the scope, which is the moment you
   * actually want it.
   */
  unlock?: SetupStep[];
}

export interface ProviderSpec {
  id: ProviderId;
  label: string;
  /** Drawn on the connection row. Emoji for the same reason avatars are. */
  glyph: string;
  blurb: string;
  reach: Reach;
  auth: AuthKind;
  /** OAuth only. Where we send you, where we swap the code, and for what. */
  oauth?: {
    authorizeUrl: string;
    tokenUrl: string;
    /** Asked for every time. A provider refusing one of these is a real failure. */
    scopes: string[];
    /**
     * Asked for, and dropped if the provider refuses them.
     *
     * **A scope the provider will not grant must not make the account
     * unconnectable**, which is what happens without this split: an authorize
     * page that answers `invalid_scope` never issues a token at all, so one
     * gated extra takes the whole connection with it — including the parts that
     * would have worked. Discord's friends scope did exactly that.
     */
    optionalScopes?: string[];
    pkce: boolean;
    /**
     * Some providers hand back a refresh token only when asked, and asking
     * looks different at each one. Extra authorize-time parameters go here so
     * the flow itself stays one function.
     */
    authorizeParams?: Record<string, string>;
    /**
     * True when the token endpoint wants the client secret as HTTP Basic rather
     * than accepting PKCE. Unused now that Battle.net has gone — every provider
     * left is a public client — and kept because a confidential one is a line
     * in this table rather than a change to the flow.
     */
    needsSecret?: boolean;
  };
  /**
   * What this provider needs before it can be connected, as fields to fill in.
   *
   * These were env vars, and only env vars, which meant setting one up read
   * "open a terminal, edit a file, restart the app" — the exact friction the
   * three double-clickable files in the repo root exist to remove. They are now
   * text boxes on the Services tab, stored with the account, and the env var
   * remains a fallback for anyone who prefers it.
   *
   * A declared list rather than a hand-written form per provider, because the
   * form and the "is this configured yet" check have to agree, and two places
   * saying which fields exist is how they stop agreeing.
   */
  credentials: CredentialField[];
  /**
   * Switches that change what a sync does, declared rather than hand-written.
   *
   * Same arrangement as `credentials` and for the same reason: the form, the
   * stored value and the code that reads it all have to agree about what
   * exists, and three places listing them is how they stop agreeing.
   */
  options: ProviderOption[];
  capabilities: Partial<Record<Capability, CapabilitySpec>>;
  /** What you have to go and do at their end. Shown before you connect. */
  setup: SetupStep[];
}

/**
 * One instruction, with the site it sends you to.
 *
 * Structured rather than a sentence with a URL inside it, because every one of
 * these steps ends in "…go to this page", and a domain rendered as plain text is
 * a step that has to be retyped into the address bar by hand. Linkifying prose
 * with a regex was the alternative and it gets the boundaries wrong exactly
 * where these strings are worst — `steamcommunity.com/dev/apikey — it asks for a
 * domain` has an em dash immediately after the path.
 *
 * `url` is always absolute and always https, which `integrations-check` asserts:
 * a relative one would resolve against the app's own origin and quietly open a
 * 404 inside the PWA.
 */
export interface SetupStep {
  text: string;
  /**
   * `url` may contain `{appId}`, which the server replaces with the client id
   * you have already pasted — so the link opens *your* application rather than
   * a list you then have to find it in. Steps carrying it fall back to the
   * generic page when nothing is stored yet, which `resolveSetupLinks` handles.
   */
  link?: { url: string; label: string; whenNoAppId?: string };
}

/**
 * Point a step's link at the connected application, when we know which one.
 *
 * The client id and the portal's application id are the same value, so the
 * moment you have pasted one the app can deep-link to your own settings page.
 * Without it the link goes to the applications list, which is correct and one
 * click worse.
 */
export function resolveSetupLinks(steps: SetupStep[], appId: string | null): SetupStep[] {
  return steps.map((step) => {
    if (!step.link?.url.includes('{appId}')) return step;

    return {
      ...step,
      link: appId
        ? { ...step.link, url: step.link.url.replace('{appId}', appId) }
        : { ...step.link, url: step.link.whenNoAppId ?? 'https://discord.com/developers/applications' },
    };
  });
}

/**
 * One thing you have to paste in before a provider can be connected.
 *
 * `key` is the column it lands in on `integration_accounts`. Only two exist and
 * that is deliberate — a free-form bag of named settings would need its own
 * table, its own validation and its own screen, to hold at most two strings per
 * provider that every OAuth provider on earth calls the same two things.
 */
export interface CredentialField {
  key: 'clientId' | 'clientSecret';
  label: string;
  /**
   * Whether the provider genuinely refuses to work without it.
   *
   * Google is the reason this is not just "clientSecret means required": a
   * Desktop-type client uses PKCE and has no secret, while a Web-type client is
   * issued one and demands it back. Both are legitimate, so the field is
   * offered and not insisted upon.
   */
  required: boolean;
  /** The environment variable that can supply this instead. */
  envVar: string;
  /** Shown under the box. Where to find the value, in their words. */
  help?: string;
  /** Masked in the UI, and never sent back to the browser once stored. */
  secret?: boolean;
}

/**
 * One checkbox on a provider's card.
 *
 * Booleans only. A setting that needed a number or a string would want
 * validation, a keyboard and an error state, and there is no such setting —
 * whereas "do not sync that one enormous playlist" is a tick.
 */
export interface ProviderOption {
  key: 'skipLikedVideos';
  label: string;
  help?: string;
  /** What it does when nothing has been chosen. */
  fallback: boolean;
}

export const providerOptionsSchema = z.object({
  skipLikedVideos: z.boolean().optional(),
});
export type ProviderOptions = z.infer<typeof providerOptionsSchema>;

/** The env vars a provider will read if its fields are left blank. */
export function envVarsFor(provider: ProviderId): string[] {
  return PROVIDERS[provider].credentials.map((field) => field.envVar);
}

/* ------------------------------------------------------------------ */

export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  spotify: {
    id: 'spotify',
    label: 'Spotify',
    glyph: '🎧',
    blurb:
      'Your playlists, saved tracks, and the artists you follow. Needs a Spotify Premium account — ' +
      'since February 2026 a Development Mode app stops working the moment the owner’s Premium lapses.',
    reach: 'web',
    auth: 'oauth2',
    oauth: {
      authorizeUrl: 'https://accounts.spotify.com/authorize',
      tokenUrl: 'https://accounts.spotify.com/api/token',
      scopes: [
        'playlist-read-private',
        'playlist-read-collaborative',
        'user-library-read',
        'user-read-recently-played',
        'user-top-read',
        // The artists you follow. Added when the Following tab arrived, so a
        // Spotify connected before that has to be connected again — a token
        // carries the scopes it was issued with, and nothing can widen it after
        // the fact. The screen reports what was granted, so this shows up.
        'user-follow-read',
      ],
      pkce: true,
    },
    credentials: [
      {
        key: 'clientId',
        label: 'Client ID',
        required: true,
        envVar: 'SPOTIFY_CLIENT_ID',
        help: 'On your app’s page in the Spotify dashboard, under the name.',
      },
      // No secret field at all: Spotify supports PKCE, so there is nothing to
      // store and nothing to leak. Offering the box anyway would invite you to
      // paste a secret this app has no use for.
    ],
    options: [],
    capabilities: {
      playlists: {
        status: 'partial',
        why:
          'Your own playlists, collaborative ones, and Liked Songs, with every track. A playlist you ' +
          'merely follow returns its name and nothing else — since February 2026 the API only returns ' +
          'contents for playlists you own or collaborate on.',
        source: 'February 2026 Web API changes',
        sourceUrl: 'https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide',
      },
      taste: {
        status: 'partial',
        why:
          'Categories come from the genres Spotify assigns each artist. The endpoints that ' +
          'measured a track — audio-features, audio-analysis and recommendations — were withdrawn ' +
          'on 27 November 2024 and return 403 to any app registered since, so nothing here infers ' +
          'energy, tempo or mood.',
        source: 'developer.spotify.com/blog/2024-11-27-changes-to-the-web-api',
        sourceUrl: 'https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api',
      },
      follows: {
        status: 'works',
        why: 'Every artist you follow, with the genres Spotify gives them.',
        source: 'GET /v1/me/following?type=artist',
      },
      /*
       * No `friends` entry at all, which is the point rather than an omission.
       *
       * It used to say "not possible — the Friend Activity panel is private",
       * and that was true and unhelpful: it put Spotify on a screen about who is
       * online, to say nothing. Following an artist is not a friendship, and the
       * question people actually have about Spotify accounts — which ones am I
       * following — is answered by `follows` above.
       */
    },
    setup: [
      {
        text: 'Create an app in the Spotify developer dashboard.',
        link: { url: 'https://developer.spotify.com/dashboard', label: 'developer.spotify.com/dashboard' },
      },
      {
        text: 'Add the redirect URI shown below as a redirect/callback URL, exactly as it appears — a trailing slash is a rejected login.',
      },
      { text: 'Paste the Client ID into the box below. There is no secret to store — this uses PKCE.' },
    ],
  },

  youtube: {
    id: 'youtube',
    label: 'YouTube',
    glyph: '📺',
    blurb: 'Playlists, liked videos, and the channels you subscribe to.',
    reach: 'web',
    auth: 'oauth2',
    oauth: {
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: ['https://www.googleapis.com/auth/youtube.readonly'],
      pkce: true,
      // Google issues a refresh token only on the first consent, and only when
      // asked twice over. Without both of these the connection silently expires
      // after an hour and looks like a bug in the token store.
      authorizeParams: { access_type: 'offline', prompt: 'consent' },
    },
    credentials: [
      {
        key: 'clientId',
        label: 'Client ID',
        required: true,
        envVar: 'GOOGLE_CLIENT_ID',
        help: 'Ends in .apps.googleusercontent.com',
      },
      {
        key: 'clientSecret',
        label: 'Client secret',
        // Optional on purpose. A Desktop-type client uses PKCE and has none; a
        // Web-type client is issued one and refuses the token exchange without
        // it. Both are legitimate ways to set this up, so the box is offered
        // rather than demanded.
        required: false,
        envVar: 'GOOGLE_CLIENT_SECRET',
        help: 'Only if you created a Web application client. Desktop clients have none.',
        secret: true,
      },
    ],
    options: [
      {
        key: 'skipLikedVideos',
        label: 'Skip Liked Videos',
        help:
          'Liked Videos is often thousands of items and years old, which swamps the library and the ' +
          '"in my playlists" counts on the Following tab. Your own playlists still sync.',
        fallback: false,
      },
    ],
    capabilities: {
      playlists: {
        status: 'works',
        why: 'Your playlists and Liked Videos, with every video in them. Liked Videos can be skipped below.',
      },
      taste: {
        status: 'partial',
        why:
          "Uses the video's own category and topic tags. Music videos carry the artist " +
          'inconsistently, so a track that Spotify also knows about is categorised better there.',
      },
      follows: {
        status: 'works',
        why: 'Every channel you subscribe to.',
        source: 'GET /youtube/v3/subscriptions?mine=true',
      },
    },
    setup: [
      {
        text: 'Create an OAuth client (type: Web application) in the Google Cloud console.',
        link: { url: 'https://console.cloud.google.com/apis/credentials', label: 'console.cloud.google.com' },
      },
      {
        text: 'Enable the YouTube Data API v3 for that same project.',
        link: {
          url: 'https://console.cloud.google.com/apis/library/youtube.googleapis.com',
          label: 'enable YouTube Data API v3',
        },
      },
      {
        text: 'Add the redirect URI shown below as a redirect/callback URL, exactly as it appears — a trailing slash is a rejected login.',
      },
      {
        text: 'Paste the Client ID into the box below, and the secret too if you created a Web application client.',
      },
    ],
  },

  steam: {
    id: 'steam',
    label: 'Steam',
    glyph: '🎮',
    blurb: "Who is online, and what they're playing.",
    reach: 'web',
    auth: 'api-key',
    /*
     * Nothing, and that is a correction rather than an omission.
     *
     * Both of Steam's credentials are typed into the app and stored with the
     * account, unlike every OAuth provider here. The distinction is real: a
     * Spotify or Discord client id identifies the *application* — registered
     * once, unchanged by a reinstall, no business being editable from a phone —
     * so it belongs in the environment. A Steam Web API key is issued to *your
     * account*. It is personal data of exactly the same kind as the Steam ID it
     * sits next to, and splitting the pair across an env var and a text box
     * made connecting a two-place job with an app restart in the middle, and
     * left the text box disabled until the other half was done.
     *
     * STEAM_API_KEY is still read as a fallback for anyone who would rather
     * keep it there, but nothing requires it.
     */
    credentials: [],
    options: [],
    capabilities: {
      friends: {
        status: 'works',
        why:
          'Full friends list with live status and current game. The one presence integration here ' +
          'that works properly, and it needs your profile and friends list set to Public.',
        source: 'ISteamUser/GetFriendList + GetPlayerSummaries',
      },
    },
    setup: [
      {
        text: 'Get a Web API key. It asks for a domain, and localhost is fine.',
        link: { url: 'https://steamcommunity.com/dev/apikey', label: 'steamcommunity.com/dev/apikey' },
      },
      { text: 'Paste it below with your profile: the URL, your custom name, or the 17-digit ID all work.' },
      {
        text: 'Set both My Profile and My Friends List to Public, or the API returns an empty list with no error at all.',
        link: { url: 'https://steamcommunity.com/my/edit/settings', label: 'your Steam privacy settings' },
      },
    ],
  },

  discord: {
    id: 'discord',
    label: 'Discord',
    glyph: '💬',
    blurb: 'Your friends and what they are playing.',
    reach: 'web',
    auth: 'oauth2',
    oauth: {
      authorizeUrl: 'https://discord.com/oauth2/authorize',
      tokenUrl: 'https://discord.com/api/oauth2/token',
      // `identify` is what proves the connection and is always granted.
      scopes: ['identify'],
      /*
       * The Social SDK scopes that carry the friends list. Optional because
       * Discord answers `invalid_scope` for an application that has not enabled
       * the Social SDK — and that answer arrives at the authorize page, before
       * any token, so asking for them unconditionally made Discord impossible
       * to connect at all rather than merely friendless.
       */
      optionalScopes: ['openid', 'sdk.social_layer_presence'],
      pkce: true,
    },
    credentials: [
      { key: 'clientId', label: 'Client ID', required: true, envVar: 'DISCORD_CLIENT_ID' },
    ],
    options: [],
    capabilities: {
      friends: {
        /*
         * Back to `needs-approval`, on evidence rather than on documentation.
         *
         * This said `works` for a while, on the understanding that the scope was
         * ungated. Discord's authorize page answered `invalid_scope — The
         * requested scope is invalid, unknown, or malformed`, which is what it
         * returns for an application that has not enabled the Social SDK.
         */
        status: 'needs-approval',
        why:
          'Connecting works and gives you your account; the friends list needs the Social SDK enabled ' +
          'for your application, which Discord grants on request. Until then the authorize page refuses ' +
          'the scope, so the app stops asking for it and connects without — you get the connection, and ' +
          'this row says why the list is empty.',
        source: 'sdk.social_layer_presence — invalid_scope until the Social SDK is enabled',
        sourceUrl: 'https://discord.com/developers/docs/discord-social-sdk/core-concepts/oauth2-scopes',
        unlock: [
          {
            // The path is Games → Social SDK. It is not a top-level entry, and
            // saying "look for Social SDK in the left menu" sent somebody
            // looking at a menu that does not have one.
            text: 'Open your application, then in the left menu expand "Games" and choose "Social SDK".',
            link: {
              url: 'https://discord.com/developers/applications/{appId}',
              label: 'open your Discord application',
              whenNoAppId: 'https://discord.com/developers/applications',
            },
          },
          {
            text:
              'Follow what that page asks for and submit it. This is a request to Discord rather than a ' +
              'switch you flip — the Social SDK is aimed at games, and access is theirs to grant.',
            link: {
              url: 'https://discord.com/developers/docs/discord-social-sdk/getting-started',
              label: 'Social SDK docs',
            },
          },
          {
            text:
              'Once it is granted, press "Ask for everything again" on this card and connect once more. ' +
              'Nothing else changes — the client ID and redirect URI you already set up stay as they are.',
          },
        ],
      },
    },
    /*
     * Written to be followed while looking at Discord's portal, naming the tab
     * and the button at each step.
     *
     * The previous version was four sentences that never said *where* anything
     * was, and ended on "request Social SDK access" — a step with no concrete
     * action, pointing at a documentation index, warning that the whole thing
     * might not work. It was left behind when the approval tag was removed and
     * it was the part that made the list unfollowable.
     */
    setup: [
      {
        text: 'Sign in and press "New Application", top right. Any name will do — it is only ever shown to you.',
        link: {
          url: 'https://discord.com/developers/applications',
          label: 'open the Discord developer portal',
        },
      },
      {
        text:
          'In the left menu, click OAuth2. Your Client ID is at the top of that page, under "Client information" — ' +
          'copy it into the Client ID box below.',
        link: {
          url: 'https://discord.com/developers/applications/{appId}',
          label: 'open your application',
          whenNoAppId: 'https://discord.com/developers/applications',
        },
      },
      {
        text:
          'Still on the OAuth2 page, find "Redirects" and press "Add Redirect". Paste the redirect URI shown ' +
          'below, then press "Save Changes" at the bottom of the page — the redirect is not stored until you do, ' +
          'and this is the step people miss.',
      },
      {
        text:
          'Come back here, press Connect, and approve it at Discord. It asks for your identity and your friends ' +
          'list; the card will say so if it was only granted the first.',
      },
    ],
  },

  riot: {
    id: 'riot',
    label: 'Riot Games',
    glyph: '⚔️',
    blurb: 'League friends and their status, read from the client running on this PC.',
    reach: 'local',
    auth: 'client',
    credentials: [],
    options: [],
    capabilities: {
      friends: {
        status: 'partial',
        why:
          'Riot publishes no friends API. The League client opens a private HTTPS port on this PC for ' +
          'its own interface, and the agent reads the friends list from it — which works properly, but ' +
          'only while the client is actually running. Close League and the list goes stale rather than empty.',
        source: 'LCU lockfile at Riot Games/League of Legends/lockfile',
      },
    },
    setup: [{ text: 'Nothing to connect. Start the League client and the agent finds it.' }],
  },

};

export const PROVIDER_LIST: ProviderSpec[] = PROVIDER_IDS.map((id) => PROVIDERS[id]);

/** Providers that can contribute anything at all to a friends list. */
export const PRESENCE_PROVIDERS: ProviderId[] = PROVIDER_LIST.filter(
  (p) => p.capabilities.friends && p.capabilities.friends.status !== 'unavailable'
).map((p) => p.id);

/** Providers that can say which accounts you follow or subscribe to. */
export const FOLLOW_PROVIDERS: ProviderId[] = PROVIDER_LIST.filter(
  (p) => p.capabilities.follows && p.capabilities.follows.status !== 'unavailable'
).map((p) => p.id);

/** Providers whose presence the agent gathers, because only this PC can see it. */
export const LOCAL_PROVIDERS: ProviderId[] = PROVIDER_LIST.filter((p) => p.reach === 'local').map((p) => p.id);

/**
 * Whether a capability is worth showing a control for.
 *
 * `unavailable` still gets rendered — as an explanation, not a button. Hiding it
 * would mean the screen answers "can I see my Battle.net friends?" with silence,
 * and silence reads as "not built yet", which sends you looking.
 */
export function capabilityIsUsable(spec: CapabilitySpec | undefined): boolean {
  return spec !== undefined && spec.status !== 'unavailable';
}

/* ------------------------------------------------------------------ */
/* Presence                                                            */
/* ------------------------------------------------------------------ */

/**
 * One vocabulary for "is my friend about", across services that each invented
 * their own. Steam has six numeric states, Discord has four strings, the League
 * client has its own set plus a free-text away message.
 *
 * Collapsed to four, because the question this answers is "could I say hello",
 * and the finer distinctions do not change the answer. `in-game` is kept
 * separate from `online` only because it is the one that carries a *what* —
 * which is the interesting part of a friends list.
 */
export const PRESENCE_STATES = ['offline', 'online', 'away', 'in-game'] as const;
export const presenceStateSchema = z.enum(PRESENCE_STATES);
export type PresenceState = (typeof PRESENCE_STATES)[number];

/** Sort order for the friends list: something to do about, first. */
export const presenceRank: Record<PresenceState, number> = {
  'in-game': 0,
  online: 1,
  away: 2,
  offline: 3,
};

export const friendSchema = z.object({
  provider: z.enum(PROVIDER_IDS),
  /** The provider's own id. Stable across renames, which display names are not. */
  providerUserId: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  avatarUrl: z.string().url().max(500).optional(),
  state: presenceStateSchema,
  /** What they are playing, when the provider says. */
  game: z.string().max(200).optional(),
  /** Free text the provider supplied — a rich-presence line, an away message. */
  detail: z.string().max(300).optional(),
  /** Provider's own timestamp, when it gives one. */
  lastOnlineAt: z.number().int().optional(),
});
export type Friend = z.infer<typeof friendSchema>;

/**
 * What the agent posts for the providers only it can see.
 *
 * A whole snapshot per provider rather than deltas: the agent has no memory
 * across restarts and a missing friend must mean "gone from the list", which a
 * delta stream cannot express without a tombstone nobody would remember to send.
 */
export const localPresenceSchema = z.object({
  provider: z.enum(PROVIDER_IDS),
  /**
   * Whether the client this reads from was running at all.
   *
   * The single most important field here, and separate from an empty `friends`
   * array on purpose: "League is closed" and "nobody is online" look identical
   * in a list of zero people and mean completely different things.
   */
  clientRunning: z.boolean(),
  friends: z.array(friendSchema).max(1000),
  error: z.string().max(300).optional(),
});
export type LocalPresence = z.infer<typeof localPresenceSchema>;

/* ------------------------------------------------------------------ */
/* Media                                                               */
/* ------------------------------------------------------------------ */

export const MEDIA_KINDS = ['track', 'video'] as const;
export const mediaKindSchema = z.enum(MEDIA_KINDS);
export type MediaKind = (typeof MEDIA_KINDS)[number];

/**
 * A playlist, or one of the pseudo-playlists every service has ("Liked Songs",
 * "Liked Videos") and treats as special right up until you try to read it.
 *
 * `saved` is a separate kind rather than a playlist with a reserved name,
 * because a name is a thing you can rename.
 *
 * **`subscriptions` used to be a third kind and is not any more.** Channels were
 * being stored as `media_items` of kind `video` inside a collection, which is
 * the sort of shape that works until you look at it: a channel has no duration,
 * no album and no play, and it was sitting in the middle of the music library
 * being counted as one. Followed accounts have their own table now — see
 * `FOLLOW_KINDS`.
 */
export const COLLECTION_KINDS = ['playlist', 'saved'] as const;
export const collectionKindSchema = z.enum(COLLECTION_KINDS);
export type CollectionKind = (typeof COLLECTION_KINDS)[number];


/* ------------------------------------------------------------------ */
/* Accounts you follow                                                 */
/* ------------------------------------------------------------------ */

/**
 * A followed account, which is not a friend and not a track.
 *
 * Kept apart from both on purpose. It is not a `Friend` because there is no
 * presence — a channel is never "online" — and putting these on the friends
 * screen meant Spotify appeared there only to say it could not help. It is not a
 * `media_item` because a channel has none of the fields one has, and the
 * category counts on the Music tab were quietly including them.
 */
export const FOLLOW_KINDS = ['channel', 'artist'] as const;
export const followKindSchema = z.enum(FOLLOW_KINDS);
export type FollowKind = (typeof FOLLOW_KINDS)[number];

export const FOLLOW_KIND_LABELS: Record<FollowKind, string> = {
  channel: 'Subscribed',
  artist: 'Following',
};

export interface FollowedAccount {
  provider: ProviderId;
  providerAccountId: string;
  kind: FollowKind;
  name: string;
  url?: string;
  avatarUrl?: string;
  /** Provider genre strings, for artists. Channels have none. */
  genres?: string[];
  /** How many other people follow them, when the provider says. */
  followerCount?: number;
}

/* ------------------------------------------------------------------ */
/* Categories                                                          */
/* ------------------------------------------------------------------ */

/**
 * The taxonomy things get sorted into.
 *
 * Coarse on purpose. Spotify hands out several thousand genre strings —
 * `escape room`, `deep filthstep`, `chillwave` — which are wonderful and
 * completely useless for sorting a library, because almost every one of them
 * has a handful of artists in it and no two people agree what it means. Folding
 * them into families is what makes the label answer a question you would
 * actually ask ("what have I got that's heavy?").
 *
 * `unknown` is a real member, not a failure. An artist with no genres at all is
 * common — anything self-released — and quietly filing those under whatever came
 * closest is how a library ends up confidently wrong.
 */
export const MUSIC_CATEGORIES = [
  'rock',
  'metal',
  'punk',
  'pop',
  'hiphop',
  'rnb',
  'electronic',
  'dance',
  'jazz',
  'classical',
  'folk',
  'country',
  'latin',
  'world',
  'soundtrack',
  'ambient',
  'spoken',
  'unknown',
] as const;
export const musicCategorySchema = z.enum(MUSIC_CATEGORIES);
export type MusicCategory = (typeof MUSIC_CATEGORIES)[number];

export const MUSIC_CATEGORY_LABELS: Record<MusicCategory, string> = {
  rock: 'Rock',
  metal: 'Metal',
  punk: 'Punk',
  pop: 'Pop',
  hiphop: 'Hip-hop',
  rnb: 'R&B / Soul',
  electronic: 'Electronic',
  dance: 'Dance / House',
  jazz: 'Jazz / Blues',
  classical: 'Classical',
  folk: 'Folk / Acoustic',
  country: 'Country',
  latin: 'Latin',
  world: 'World',
  soundtrack: 'Soundtrack / Game',
  ambient: 'Ambient / Chill',
  spoken: 'Spoken word',
  unknown: 'Uncategorised',
};

/**
 * Keywords that place a provider genre string into a family, most specific
 * first *within* each list, and the whole table scanned in the order below.
 *
 * Order is load-bearing and the reason this is an array rather than a record.
 * `melodic death metal` contains both "metal" and "death"; `pop punk` contains
 * both "pop" and "punk"; `jazz rap` contains both. Whichever family is checked
 * first wins, so the narrow families go before the broad ones and `pop` — which
 * appears inside dozens of unrelated genre names — goes very nearly last.
 */
const CATEGORY_KEYWORDS: Array<[MusicCategory, string[]]> = [
  ['metal', ['metal', 'metalcore', 'deathcore', 'grindcore', 'djent', 'doom', 'sludge', 'thrash']],
  ['punk', ['punk', 'hardcore', 'emo', 'screamo', 'ska']],
  ['classical', ['classical', 'baroque', 'opera', 'orchestra', 'orchestral', 'symphony', 'choral', 'chamber']],
  ['soundtrack', ['soundtrack', 'video game', 'vgm', 'anime', 'score', 'musical', 'theme']],
  // Before jazz, because `jazz rap` and `jazzy hip hop` are hip-hop with a jazz
  // flavour rather than the other way round — and nothing in the jazz list is a
  // substring of anything here, so the reverse ordering costs nothing.
  ['hiphop', ['hip hop', 'hip-hop', 'hiphop', 'rap', 'trap', 'grime', 'drill', 'boom bap']],
  ['jazz', ['jazz', 'blues', 'bebop', 'swing', 'ragtime', 'dixieland']],
  ['rnb', ['r&b', 'rnb', 'soul', 'motown', 'funk', 'neo soul', 'gospel']],
  ['country', ['country', 'bluegrass', 'americana', 'honky', 'nashville']],
  ['folk', ['folk', 'acoustic', 'singer-songwriter', 'singer songwriter', 'bluegrass']],
  ['latin', ['latin', 'reggaeton', 'salsa', 'bachata', 'cumbia', 'bossa', 'samba', 'flamenco', 'tango']],
  ['ambient', ['ambient', 'chill', 'lo-fi', 'lofi', 'downtempo', 'new age', 'drone', 'meditation', 'sleep']],
  ['dance', ['house', 'techno', 'trance', 'edm', 'dance', 'disco', 'garage', 'rave', 'hardstyle', 'eurodance']],
  ['electronic', ['electronic', 'electronica', 'dubstep', 'drum and bass', "drum'n'bass", 'dnb', 'idm', 'synth', 'breakbeat', 'industrial', 'vaporwave', 'glitch']],
  ['world', ['world', 'afrobeat', 'afro', 'k-pop', 'j-pop', 'reggae', 'dancehall', 'celtic', 'klezmer', 'bollywood']],
  ['spoken', ['spoken', 'podcast', 'audiobook', 'comedy', 'poetry']],
  ['rock', ['rock', 'grunge', 'shoegaze', 'britpop', 'psychedelic', 'garage rock', 'indie rock']],
  // Last of the real families. "pop" is a substring of "pop punk", "j-pop",
  // "psychedelic pop", "power pop" and a hundred others, so anything it would
  // have caught wrongly has already been claimed above.
  ['pop', ['pop', 'boy band', 'girl group', 'schlager']],
];

export interface Categorised {
  category: MusicCategory;
  /**
   * Which genre string decided it. Kept because a category nobody can explain is
   * a category nobody trusts, and one wrong label in a list of five hundred is
   * otherwise impossible to chase down.
   */
  because: string | null;
}

/**
 * Fold a pile of provider genre strings into one family.
 *
 * Deliberately not a score across all of them. Genre lists are heavily
 * weighted toward whatever the artist is *mostly* known for, so the first
 * confident hit is nearly always right, and a voting scheme mostly manages to
 * turn one clear signal into a tie. Where it matters — an artist tagged both
 * `pop punk` and `pop rock` — the table order above already made the call.
 */
export function categoriseGenres(genres: readonly string[]): Categorised {
  const cleaned = genres.map((g) => g.toLowerCase().trim()).filter(Boolean);
  if (cleaned.length === 0) return { category: 'unknown', because: null };

  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    for (const genre of cleaned) {
      for (const keyword of keywords) {
        if (genre.includes(keyword)) return { category, because: genre };
      }
    }
  }

  // Genres present but none recognised. Still `unknown`, but `because` carries
  // the string that went unmatched, which is how the keyword table gets better.
  return { category: 'unknown', because: cleaned[0] };
}

/**
 * YouTube's numeric video categories, for the handful worth keeping.
 *
 * Only the ones that map cleanly. `22 People & Blogs` covers roughly half of
 * YouTube and means nothing; guessing at it would be worse than `unknown`.
 */
const YOUTUBE_CATEGORY_MAP: Record<string, MusicCategory> = {
  '10': 'pop', // Music — a starting point, refined by topic tags below
  '20': 'soundtrack', // Gaming
  '23': 'spoken', // Comedy
  '25': 'spoken', // News & Politics
  '27': 'spoken', // Education
};

/**
 * Categorise a YouTube video from what the API is willing to say about it.
 *
 * `topicDetails` carries Wikipedia URLs — `.../wiki/Heavy_metal_music` — which
 * are far better genre evidence than the numeric category, so they are tried
 * first and the number is only a fallback. A music video with no topics lands
 * on `pop` via category 10, which is a coin-flip dressed as an answer, so it is
 * reported with `because: null` and the screen can say the label is a guess.
 */
export function categoriseVideo(categoryId: string | null, topics: readonly string[]): Categorised {
  const fromTopics = categoriseGenres(
    topics.map((t) => t.split('/wiki/').pop()?.replace(/_/g, ' ') ?? t)
  );
  if (fromTopics.category !== 'unknown') return fromTopics;

  const mapped = categoryId ? YOUTUBE_CATEGORY_MAP[categoryId] : undefined;
  return mapped ? { category: mapped, because: null } : { category: 'unknown', because: null };
}

/* ------------------------------------------------------------------ */
/* API shapes                                                          */
/* ------------------------------------------------------------------ */

export const connectSteamSchema = z.object({
  /**
   * Optional only because `STEAM_API_KEY` is still honoured as a fallback.
   * Given here it is stored with the account, which is where it belongs.
   */
  apiKey: z.string().trim().min(10).max(200).optional(),
  /**
   * Your profile, in whatever form you have it to hand.
   *
   * Deliberately not a 17-digit regex. That was the original shape and it made
   * the first step of connecting Steam "go to a third-party site and look up a
   * number", which is a chore the API can do itself: `ResolveVanityURL` turns a
   * custom name into the id, and a profile URL contains one or the other. So
   * the box takes a URL, a custom name, or the raw id, and the server sorts it
   * out — see `steamProfileInput`.
   */
  profile: z.string().trim().min(1).max(300),
});

/**
 * Work out what somebody pasted into the profile box.
 *
 * Pure, and in `shared` rather than beside the fetch, so the parsing half is
 * covered by `integrations-check` without a network. Only the vanity case needs
 * Steam to resolve it; the other two are already the answer.
 */
export function steamProfileInput(raw: string): { steamId: string } | { vanity: string } {
  // Trailing slashes are how a copied URL usually arrives.
  const input = raw.trim().replace(/\/+$/, '');

  if (/^\d{17}$/.test(input)) return { steamId: input };

  // .../profiles/76561198000000000 — already an id, wearing a URL.
  const byId = /steamcommunity\.com\/profiles\/(\d{17})/i.exec(input);
  if (byId) return { steamId: byId[1] };

  // .../id/somename — a custom URL, which needs resolving.
  const byVanity = /steamcommunity\.com\/id\/([^/?#]+)/i.exec(input);
  if (byVanity) return { vanity: decodeURIComponent(byVanity[1]) };

  // Anything else is treated as the custom name typed on its own. A wrong
  // guess here fails with "Steam does not know that profile", which is the
  // right message for a mistyped name as well as for a mistyped URL.
  return { vanity: input };
}

/**
 * Saving an OAuth application's own credentials from the app.
 *
 * Both optional, and the distinction between *absent* and *empty* is the whole
 * shape of it: absent means "leave whatever is stored", empty means "clear it".
 * The form has to be able to send the first, because a secret is never sent back
 * to the browser and so a blank box is the normal state for a field that is
 * already set — treating that as "erase it" would wipe the secret every time
 * somebody corrected the id next to it.
 */
export const credentialsSchema = z.object({
  clientId: z.string().max(400).optional(),
  clientSecret: z.string().max(400).optional(),
});
export type CredentialsInput = z.infer<typeof credentialsSchema>;

export const syncRequestSchema = z.object({
  /** Omitted means everything this provider can do. */
  capabilities: z.array(z.enum(CAPABILITIES)).optional(),
});

/**
 * How stale a presence snapshot may be before a read refreshes it.
 *
 * Refresh-on-read rather than a background poll, and that is a leanness
 * decision with a number behind it: a 60-second poller is 1,440 requests a day
 * forever, against a project whose whole attention loop is tuned down to 1,500
 * database rows a day. Nobody is watching a friends list at four in the morning,
 * and a list nobody is looking at does not need to be right.
 */
export const PRESENCE_STALE_MS = 60_000;

/** How long a `local` provider's snapshot stays believable once the agent stops reporting. */
export const LOCAL_PRESENCE_STALE_MS = 5 * 60_000;
