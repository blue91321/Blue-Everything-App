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
  'battlenet',
  'epic',
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
 *              it. Not a lesser option — for YouTube history it is the *only*
 *              complete one.
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

/** What a provider might be asked for. */
export const CAPABILITIES = ['playlists', 'history', 'taste', 'friends'] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * Whether it works, and if not, why not.
 *
 * `partial` is the interesting one and exists because it is the honest answer
 * for most of this matrix. Spotify *does* return your play history — the last
 * fifty plays, and nothing older, ever. Reporting that as `works` would make the
 * history screen look broken to anyone who listened to more than fifty tracks
 * since they last opened it, and reporting it as `unavailable` would throw away
 * the one mechanism that lets a local history accumulate.
 */
export const CAPABILITY_STATUSES = ['works', 'partial', 'needs-approval', 'unavailable'] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export interface CapabilitySpec {
  status: CapabilityStatus;
  /** One sentence, shown on the screen beside the thing it is about. */
  why: string;
  /** Where the limit comes from, for when the sentence above is not believed. */
  source?: string;
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
    scopes: string[];
    pkce: boolean;
    /**
     * Some providers hand back a refresh token only when asked, and asking
     * looks different at each one. Extra authorize-time parameters go here so
     * the flow itself stays one function.
     */
    authorizeParams?: Record<string, string>;
    /**
     * True when the token endpoint wants the client secret rather than PKCE.
     * Battle.net is a confidential client; there is no way around it, and a
     * personal install that cannot keep a secret simply cannot connect it.
     */
    needsSecret?: boolean;
  };
  /** Env vars this provider needs before it can be connected at all. */
  needs: string[];
  capabilities: Partial<Record<Capability, CapabilitySpec>>;
  /** What you have to go and do at their end. Shown before you connect. */
  setup: string[];
}

/* ------------------------------------------------------------------ */

export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  spotify: {
    id: 'spotify',
    label: 'Spotify',
    glyph: '🎧',
    blurb: 'Playlists, saved tracks, and a rolling record of what you actually listened to.',
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
      ],
      pkce: true,
    },
    needs: ['SPOTIFY_CLIENT_ID'],
    capabilities: {
      playlists: {
        status: 'works',
        why: 'Your own playlists, collaborative ones, and Liked Songs, with every track.',
      },
      history: {
        status: 'partial',
        why:
          'Spotify only ever returns the last 50 plays, so history is built by asking often and ' +
          'keeping what comes back. Anything you played before you connected is gone for good.',
        source: 'GET /v1/me/player/recently-played caps at 50 items',
      },
      taste: {
        status: 'partial',
        why:
          'Categories come from the genres Spotify assigns each artist. The endpoints that ' +
          'measured a track — audio-features, audio-analysis and recommendations — were withdrawn ' +
          'on 27 November 2024 and return 403 to any app registered since, so nothing here infers ' +
          'energy, tempo or mood.',
        source: 'developer.spotify.com/blog/2024-11-27-changes-to-the-web-api',
      },
      friends: {
        status: 'unavailable',
        why: 'The Friend Activity panel in the desktop app is a private endpoint with no public equivalent.',
      },
    },
    setup: [
      'Create an app at developer.spotify.com/dashboard.',
      'Add this exact redirect URI: http://127.0.0.1:8787/api/integrations/callback/spotify',
      'Put its Client ID in SPOTIFY_CLIENT_ID. There is no secret to store — this uses PKCE.',
    ],
  },

  youtube: {
    id: 'youtube',
    label: 'YouTube',
    glyph: '📺',
    blurb: 'Playlists, liked videos and subscriptions over the API; watch history from a Takeout export.',
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
    needs: ['GOOGLE_CLIENT_ID'],
    capabilities: {
      playlists: {
        status: 'works',
        why: 'Your playlists, Liked Videos, and the channels you subscribe to.',
      },
      history: {
        status: 'unavailable',
        why:
          'The watch-history playlist has returned an empty list for every channel since ' +
          '12 September 2016, and the activities endpoint that partly replaced it is deprecated. ' +
          'Import a Google Takeout export instead — it is complete, which the API never was.',
        source: 'developers.google.com/youtube/v3/revision_history (12 September 2016)',
      },
      taste: {
        status: 'partial',
        why:
          "Uses the video's own category and topic tags. Music videos carry the artist " +
          'inconsistently, so a track that Spotify also knows about is categorised better there.',
      },
    },
    setup: [
      'Create an OAuth client (type: Web application) at console.cloud.google.com.',
      'Enable the YouTube Data API v3 for that project.',
      'Add this exact redirect URI: http://127.0.0.1:8787/api/integrations/callback/youtube',
      'Put the Client ID in GOOGLE_CLIENT_ID, and the secret in GOOGLE_CLIENT_SECRET if the client type demands one.',
      'For watch history: takeout.google.com → YouTube → history → JSON, then upload watch-history.json here.',
    ],
  },

  steam: {
    id: 'steam',
    label: 'Steam',
    glyph: '🎮',
    blurb: "Who is online, and what they're playing.",
    reach: 'web',
    auth: 'api-key',
    needs: ['STEAM_API_KEY'],
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
      'Get a key at steamcommunity.com/dev/apikey and put it in STEAM_API_KEY.',
      'Find your 64-bit Steam ID (steamid.io works) and paste it when connecting.',
      'Set Steam → Privacy Settings → My profile and Friends List to Public, or the API returns an empty list.',
    ],
  },

  discord: {
    id: 'discord',
    label: 'Discord',
    glyph: '💬',
    blurb: 'Friends and their status — if Discord approves your app for it.',
    reach: 'web',
    auth: 'oauth2',
    oauth: {
      authorizeUrl: 'https://discord.com/oauth2/authorize',
      tokenUrl: 'https://discord.com/api/oauth2/token',
      // `identify` always works and is what proves the connection. The other two
      // are the Social SDK scopes that actually carry the friends list, and are
      // requested optimistically: an unapproved app is refused at the authorize
      // step, which is a clearer failure than a silent empty list.
      scopes: ['identify', 'openid', 'sdk.social_layer_presence'],
      pkce: true,
    },
    needs: ['DISCORD_CLIENT_ID'],
    capabilities: {
      friends: {
        status: 'needs-approval',
        why:
          'Reading a friends list needs the `sdk.social_layer_presence` scope, which is part of the ' +
          'Discord Social SDK and is granted per-application by Discord on request. Until yours is ' +
          'approved the authorize page refuses the scope. There is no ordinary OAuth scope for it, ' +
          'and reading your own account with a user token is against their terms.',
        source: 'Discord Social SDK OAuth2 scopes — sdk.social_layer_presence requires portal approval',
      },
    },
    setup: [
      'Create an application at discord.com/developers/applications.',
      'Add this exact redirect URI: http://127.0.0.1:8787/api/integrations/callback/discord',
      'Put the Client ID in DISCORD_CLIENT_ID.',
      'Request Social SDK access in the portal. Without it, connecting proves who you are and nothing more.',
    ],
  },

  riot: {
    id: 'riot',
    label: 'Riot Games',
    glyph: '⚔️',
    blurb: 'League friends and their status, read from the client running on this PC.',
    reach: 'local',
    auth: 'client',
    needs: [],
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
    setup: ['Nothing to connect. Start the League client and the agent finds it.'],
  },

  battlenet: {
    id: 'battlenet',
    label: 'Battle.net',
    glyph: '🛡️',
    blurb: 'Connects, but cannot tell you who is online.',
    reach: 'web',
    auth: 'oauth2',
    oauth: {
      authorizeUrl: 'https://oauth.battle.net/authorize',
      tokenUrl: 'https://oauth.battle.net/token',
      scopes: ['openid'],
      pkce: false,
      needsSecret: true,
    },
    needs: ['BATTLENET_CLIENT_ID', 'BATTLENET_CLIENT_SECRET'],
    capabilities: {
      friends: {
        status: 'unavailable',
        why:
          "Blizzard's API covers game and profile data — characters, mounts, match history. There is no " +
          'friends endpoint and no presence endpoint at any access level, so this cannot be built rather ' +
          'than merely not being built yet. The agent can tell you whether Battle.net is running on this ' +
          'PC, which is the whole of what is available.',
        source: 'develop.battle.net — no social or presence namespace exists',
      },
    },
    setup: [
      'Create a client at develop.battle.net.',
      'Add this exact redirect URI: http://127.0.0.1:8787/api/integrations/callback/battlenet',
      'Put the id and secret in BATTLENET_CLIENT_ID and BATTLENET_CLIENT_SECRET — this one is a confidential client and PKCE is not offered.',
    ],
  },

  epic: {
    id: 'epic',
    label: 'Epic Games',
    glyph: '🕹️',
    blurb: 'Whether the launcher is running here. The friends list is not reachable.',
    reach: 'local',
    auth: 'client',
    needs: [],
    capabilities: {
      friends: {
        status: 'unavailable',
        why:
          'Epic Online Services does expose friends, but only to a registered EOS product, and only for ' +
          'friends who have separately consented to that product seeing them — so it returns a subset of ' +
          'a subset, never the launcher list. The launcher itself uses private endpoints. What is left is ' +
          'local: the agent can see whether the launcher is running.',
        source: 'dev.epicgames.com — Friends Interface requires per-friend consent per product',
      },
    },
    setup: ['Nothing to connect. The agent reports whether the Epic launcher is running.'],
  },
};

export const PROVIDER_LIST: ProviderSpec[] = PROVIDER_IDS.map((id) => PROVIDERS[id]);

/** Providers that can contribute anything at all to a friends list. */
export const PRESENCE_PROVIDERS: ProviderId[] = PROVIDER_LIST.filter(
  (p) => p.capabilities.friends && p.capabilities.friends.status !== 'unavailable'
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
 * `saved` and `subscriptions` are separate kinds rather than playlists with
 * reserved names, because a name is a thing you can rename.
 */
export const COLLECTION_KINDS = ['playlist', 'saved', 'subscriptions'] as const;
export const collectionKindSchema = z.enum(COLLECTION_KINDS);
export type CollectionKind = (typeof COLLECTION_KINDS)[number];

/** Where a play came from, since the two have very different trustworthiness. */
export const PLAY_SOURCES = ['spotify-recent', 'youtube-takeout'] as const;
export const playSourceSchema = z.enum(PLAY_SOURCES);
export type PlaySource = (typeof PLAY_SOURCES)[number];

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
  /** 17 digits. Vanity URLs are resolved separately; this is the real id. */
  steamId: z.string().regex(/^\d{17}$/, 'a 64-bit Steam ID is 17 digits'),
});

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
