/**
 * Talking to the integrations package's endpoints.
 *
 * Its own client rather than entries on `api` in core, because core must not
 * know a package exists: deleting this folder takes its routes, its screens
 * and this file together. It goes through core's `apiRequest`, so its reads
 * are kept for offline use and its changes refused or queued by the same
 * rules as everything else. `manga-api.ts` was the first of these.
 *
 * The server half is `packages/modules/integrations/server`.
 */

import { apiRequest as request } from '@app/api';

/* ------------------------------------------------------------------ */
/* App integrations                                                    */
/* ------------------------------------------------------------------ */

/**
 * A capability, and — the point of the whole module — whether it works.
 *
 * `status` is never collapsed to a boolean on this side either. Four of the
 * seven providers cannot do what you would assume they can, for four different
 * reasons, and a screen that renders "off" for all of them sends you looking for
 * a setting that does not exist. So `why` is rendered next to the thing it is
 * about, always.
 */
export interface CapabilityInfo {
  status: 'works' | 'partial' | 'needs-approval' | 'unavailable';
  why: string;
  source?: string;
  /** Present only when `source` names a page that can actually be opened. */
  sourceUrl?: string;
  /** Steps to turn on a capability the provider gates. */
  unlock?: SetupStep[];
}

/**
 * One setup instruction, with the site it sends you to.
 *
 * `link` is structured rather than a URL buried in `text`, so the screen can
 * render a real anchor instead of a domain you have to retype.
 */
export interface SetupStep {
  text: string;
  /** Already resolved by the server — `{appId}` is substituted before it is sent. */
  link?: { url: string; label: string };
}

/**
 * One credential box on the Services tab.
 *
 * `set` and `source` rather than the value: a stored secret is never sent back
 * to the browser, so the box renders empty and says it is already set. Sending
 * it would put it in the DOM, the response cache, and any devtools left open.
 */
export interface CredentialFieldInfo {
  key: 'clientId' | 'clientSecret';
  label: string;
  required: boolean;
  envVar: string;
  help?: string;
  secret?: boolean;
  set: boolean;
  source: 'app' | 'env' | 'none';
}

export interface ProviderInfo {
  id: string;
  label: string;
  glyph: string;
  blurb: string;
  reach: 'web' | 'local' | 'import';
  auth: 'oauth2' | 'api-key' | 'client' | 'file';
  setup: SetupStep[];
  /** The fields to fill in, whether each is set, and where its value came from. */
  credentialFields: CredentialFieldInfo[];
  /** The provider refused this app's optional scopes, so it stopped asking. */
  optionalScopesRefused: boolean;
  /** What to paste into the provider's dashboard. Null for non-OAuth providers. */
  redirectUri: string | null;
  capabilities: Partial<Record<string, CapabilityInfo>>;

  connected: boolean;
  accountName: string | null;
  /** What the provider actually granted, which is not what was asked for. */
  grantedScopes: string[];
  /** Env vars still unset. Non-empty means Connect cannot work yet. */
  missingConfig: string[];
  syncedAt: Record<string, number>;
  lastError: string | null;
  /** Capabilities with code behind them, as opposed to merely described. */
  runnable: string[];
  /**
   * An env var already supplies this provider's key, so the field asking for one
   * is optional. Without this the form cannot say whether it needs filling in.
   */
  envFallback: boolean;
  local: LocalStatus | null;
}

export interface LocalStatus {
  clientRunning: boolean;
  reportedAt: number | null;
  /** The agent has gone quiet — a different problem from a closed game client. */
  stale: boolean;
  error?: string;
}

export interface IntegrationsState {
  providers: ProviderInfo[];
  capabilities: string[];
  /**
   * Services left out of the Friends and Following lists.
   *
   * Optional for the usual reason — the PWA and the server update
   * independently, and an absent list must read as "nothing hidden" rather than
   * leaving the panel unable to render.
   */
  hiddenProviders?: string[];
}

export interface SyncOutcome {
  provider: string;
  capability: string;
  ok: boolean;
  note: string;
}

/**
 * One *person*, not one account.
 *
 * Linked accounts are merged by the server: the name and picture come from
 * whichever service is highest in its identity preference (Discord first), and
 * the status from whichever one actually knows. `accounts` is what it was
 * merged from, and is what the row unlinks.
 */
export interface FriendRow {
  /** The person id when linked, otherwise a per-row key. Stable across a refresh. */
  id: string;
  personId: string | null;
  name: string;
  avatarUrl: string | null;
  /** Whose name and picture this row is wearing. */
  provider: string;
  /** `unknown` means nobody could say — not that they are away. */
  /** Mirrors `PRESENCE_STATES` in shared, which this package cannot import. */
  state: 'offline' | 'online' | 'away' | 'in-game' | 'in-game-away' | 'dnd' | 'unknown';
  game: string | null;
  detail: string | null;
  lastOnlineAt: number | null;
  seenAt: number;
  /**
   * When this state started, as far as this app has seen.
   *
   * Null means it has not been observed changing yet, and the screen shows no
   * timer rather than guessing. Every value is a lower bound — measured from
   * when the app noticed, not from when the person actually walked away.
   *
   * Optional because the server and the PWA update independently.
   */
  stateSince?: number | null;
  /** Set when the status came from a different account than the name. */
  statusFrom: string | null;
  accounts: Array<{
    id: string;
    provider: string;
    name: string;
    /** The service's own id for them, for deep links. Absent on an older server. */
    providerUserId?: string;
  }>;
}

/** One channel that is on air. Mirrors `live_streams`. */
export interface LiveStreamRow {
  id: string;
  provider: string;
  providerAccountId: string;
  streamId: string;
  channelName: string;
  title: string;
  category: string | null;
  viewers: number | null;
  startedAt: number | null;
  thumbnailUrl: string | null;
  url: string;
  seenAt: number;
  /** Starred. False when the followed-channels list has not synced them yet. */
  favourite: boolean;
}

/**
 * Why a live list might be empty, per service.
 *
 * The same job `FriendSource` does and for a sharper reason: "nobody is live",
 * "Twitch is not connected" and "YouTube cannot answer this" all render as
 * nothing, and only the first is about the people you follow.
 */
export interface LiveSource {
  provider: string;
  label: string;
  why: string;
  connected: boolean;
  missingConfig: string[];
  lastError: string | null;
}

export interface LiveView {
  streams: LiveStreamRow[];
  sources: LiveSource[];
  hiddenCount?: number;
  /**
   * What the *panel* should narrow itself to. The tab always shows everything.
   *
   * Carried on this response so the panel needs no second request for settings.
   * Optional because the server and the PWA update independently.
   */
  scope?: 'all' | 'favourites';
  refreshed: SyncOutcome[];
}

export interface LinkSuggestion {
  a: { id: string; provider: string; name: string };
  b: { id: string; provider: string; name: string };
  because: string;
}

export interface FriendSource {
  provider: string;
  label: string;
  status: CapabilityInfo['status'];
  why: string;
  connected: boolean;
  missingConfig: string[];
  lastError: string | null;
  local: LocalStatus | null;
  /**
   * How many of this service's rows are too old to still say what anybody is
   * doing, so they show as "cannot tell" instead.
   *
   * Optional because the server and the PWA update independently — a browser
   * holding this bundle against an older process must not throw over a field
   * that predates it.
   */
  unconfirmed?: number;
}

export interface FriendsView {
  friends: FriendRow[];
  /** Per-provider health, so an empty list can explain itself. */
  sources: FriendSource[];
  /**
   * Services being left out, and how many people that costs.
   *
   * Optional because the server and the PWA update independently — a browser
   * holding a newer bundle than the process serving it is the ordinary case
   * right after an edit, and a filter that reads `undefined` as "everything is
   * hidden" would empty the screen. Absent means an older server that does no
   * filtering, so the honest reading is "nothing hidden".
   */
  hiddenProviders?: string[];
  hiddenCount?: number;
  refreshed: SyncOutcome[];
}

export interface MediaCollection {
  id: string;
  provider: string;
  kind: 'playlist' | 'saved' | 'subscriptions';
  name: string;
  description: string | null;
  artUrl: string | null;
  itemCount: number;
  syncedAt: number | null;
  /** Ticked to be left out of syncs, and out of the "in my playlists" counts. */
  ignored: number;
}

export interface MediaItem {
  id: string;
  title: string;
  creator: string | null;
  album: string | null;
  durationMs: number | null;
  url: string | null;
  artUrl: string | null;
  category: string;
  /** Which genre string decided the category. Null means it was a guess. */
  categoryBecause: string | null;
  genres: string;
  position: number;
}

export interface FollowRow {
  id: string;
  provider: string;
  providerAccountId: string;
  kind: 'channel' | 'artist';
  name: string;
  url: string | null;
  avatarUrl: string | null;
  genres: string;
  category: string;
  categoryBecause: string | null;
  followerCount: number | null;
  seenAt: number;
  /**
   * How many of their tracks or videos are in your collections, **summed over
   * every linked account** — the list sorts by this, and counting only the main
   * channel's share would rank a creator below people you listen to less.
   */
  inPlaylists: number;
  /** Set when this row is several accounts merged; null when it stands alone. */
  groupId: string | null;
  /** Every account behind the row, the chosen main one flagged. */
  accounts: Array<{
    id: string;
    provider: string;
    name: string;
    kind: 'channel' | 'artist';
    isPrimary: boolean;
  }>;
}

export interface FollowsView {
  follows: FollowRow[];
  sources: Array<{
    provider: string;
    label: string;
    status: CapabilityInfo['status'];
    why: string;
    syncedAt: number | null;
  }>;
  /** Services left out, and what that costs. Absent on an older server. */
  hiddenProviders?: string[];
  hiddenCount?: number;
}

/** The Shuffle card's settings, held on the PC so every device shares them. */
/** Spotify's desktop app refusing the shuffle, and the forum thread watched for a fix — see `spotify-desktop-bug.ts`. */
export interface DesktopBug {
  watching: boolean;
  watchingSince: number | null;
  checkedAt: number | null;
  error: string | null;
  news: Array<{ at: string; by: string; why: 'staff' | 'fixed' | 'accepted' | 'closed'; excerpt: string; url: string }>;
  refusedAt: number | null;
  fixedAt: number | null;
  test: { at: number; ok: boolean; device: string; detail: string } | null;
  threadUrl: string;
}

export interface ShuffleSettings {
  queueAhead: number;
  picks: string[] | null;
  order: 'shuffle' | 'random';
  repeatAfter: number;
  recent: { within: number; factor: number };
  fresh: { after: number; factor: number };
  /** False until anything has been saved — see the card's hand-over. */
  saved: boolean;
}

export interface MusicView {
  breakdown: Array<{ category: string; count: number }>;
  /** Per credited artist (a video's channel), most first; counts add up to more than `items`. */
  byArtist?: { items: number; artists: Array<{ name: string; count: number }> };
}

const post = <T>(path: string, payload?: unknown) =>
  request<T>(path, { method: 'POST', body: payload === undefined ? undefined : JSON.stringify(payload) });
const patch = <T>(path: string, payload: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(payload) });

/**
 * App integrations.
 *
 * The provider manifest arrives from the server rather than being imported
 * from `@everything/shared`, for the reason `api.ts` opens with: this bundle
 * does not pull in that package. It is the same arrangement `/api/session`
 * uses for the feature list — the server owns the table of facts, and hands
 * the PWA plain JSON.
 */
export const integrationsApi = {
    list: () => request<IntegrationsState>('/api/integrations'),
    /**
     * Returns a URL to open rather than redirecting, because a 302 to
     * accounts.spotify.com would be followed by `fetch` and land as an opaque
     * CORS failure instead of as a page.
     */
    authorize: (provider: string) => post<{ url: string }>(`/api/integrations/${provider}/authorize`),
    /**
     * `profile` takes a URL, a custom name or the 17-digit id — the server
     * resolves it, so the first step is no longer "go and look up a number".
     * `apiKey` is optional only because STEAM_API_KEY remains a fallback.
     */
    connectSteam: (profile: string, apiKey?: string) =>
      post<{ connected: boolean; accountName: string; steamId: string }>('/api/integrations/steam/connect', {
        profile,
        apiKey,
      }),
    /**
     * Canvas needs an address as well as a token, because every school runs its
     * own. `host` takes whatever is in the address bar — a course URL is fine,
     * only the host is kept.
     */
    connectCanvas: (host: string, token: string) =>
      post<{ connected: boolean; accountName: string; host: string }>('/api/integrations/canvas/connect', {
        host,
        token,
      }),
    /**
     * Save a provider's own client id/secret from the app rather than a file.
     * Omit a key to leave it as it is; send '' to clear it.
     */
    saveCredentials: (provider: string, values: { clientId?: string; clientSecret?: string }) =>
      request<{ saved: string[]; missingConfig: string[] }>(`/api/integrations/${provider}/credentials`, {
        method: 'PUT',
        body: JSON.stringify(values),
      }),
    /** Ask for the optional scopes again, once they have been enabled there. */
    retryScopes: (provider: string) => post<{ optionalScopesRefused: boolean }>(`/api/integrations/${provider}/retry-scopes`),
    disconnect: (provider: string) => request<void>(`/api/integrations/${provider}`, { method: 'DELETE' }),
    sync: (provider: string, capabilities?: string[]) =>
      post<{ outcomes: SyncOutcome[] }>(`/api/integrations/${provider}/sync`, { capabilities }),
    /** `force` is the refresh button; without it the read only refetches if stale. */
    friends: (force = false) => request<FriendsView>(`/api/integrations/friends${force ? '?force=1' : ''}`),
    live: (force = false) => request<LiveView>(`/api/integrations/live${force ? '?force=1' : ''}`),
    /**
     * Star a channel, by the pair a live row already carries.
     *
     * Answers 409 when the followed-channels list has not synced that channel
     * yet: there is no row to flag, and a silent success would spring the star
     * back on the next reload with nothing said.
     */
    favouriteFollow: (provider: string, providerAccountId: string, favourite: boolean) =>
      post<{ favourite: boolean }>('/api/integrations/follows/favourite', {
        provider,
        providerAccountId,
        favourite,
      }),
    /** Accounts that look like the same person. Proposals, not links. */
    linkSuggestions: () => request<{ suggestions: LinkSuggestion[] }>('/api/integrations/friends/suggestions'),
    linkFriends: (a: string, b: string) => post<{ personId: string }>('/api/integrations/friends/link', { a, b }),
    unlinkFriend: (id: string) => post<{ ok: boolean }>('/api/integrations/friends/unlink', { id }),
    /** Dissolve a whole group, which is what a merged row comes apart into. */
    unlinkPerson: (personId: string) => post<{ ok: boolean }>('/api/integrations/friends/unlink', { personId }),
    collections: () => request<MediaCollection[]>('/api/integrations/collections'),
    /** The Shuffle card: lists, the songs and artists you can boost, the boosts, and whether playback is allowed. */
    shuffleSources: () =>
      request<{
        connected: boolean;
        canPlay: boolean;
        sources: Array<{ id: string; name: string; itemCount: number; kind: string; readable: boolean }>;
        songs: Array<{ uri: string; title: string; artist: string; artistIds: string[]; lists: string[] }>;
        weights: { songs: Record<string, number>; artists: Record<string, number> };
        session: {
          active: boolean;
          order: 'shuffle' | 'random' | null;
          device: string | null;
          played: number;
          queued: number;
          lists: string[];
          repeatAfter: number | null;
          queueAhead: number;
          ended: { at: number; why: string } | null;
        };
        settings: ShuffleSettings;
      }>('/api/integrations/spotify/shuffle'),
    /** Change any of the Shuffle card's settings; shared by every device. */
    setShuffleSettings: (part: Partial<Omit<ShuffleSettings, 'saved'>>) =>
      request<ShuffleSettings>('/api/integrations/spotify/shuffle/settings', {
        method: 'PUT',
        body: JSON.stringify(part),
      }),
    /** Spotify's desktop-app bug: the forum thread watched, and the test. */
    desktopBug: () => request<DesktopBug>('/api/integrations/spotify/desktop-bug'),
    watchDesktopBug: (on: boolean) => post<DesktopBug>('/api/integrations/spotify/desktop-bug/watch', { on }),
    checkDesktopBug: () => post<DesktopBug>('/api/integrations/spotify/desktop-bug/check', {}),
    testDesktopApp: () =>
      request<DesktopBug>('/api/integrations/spotify/desktop-bug/test', {
        method: 'POST',
        body: '{}',
        // Spotify can hold a request for up to 30s on a rate limit.
        signal: AbortSignal.timeout(60_000),
      }),
    /** Whether Spotify is set up for Music, and whether shuffle is on — for the menu's dot. */
    spotifyStatus: () =>
      request<{ connected: boolean; canPlay: boolean; active: boolean }>('/api/integrations/spotify/status'),
    /** Stop keeping the queue topped up; what is queued plays on. */
    stopShuffle: (pause = false) => post<unknown>('/api/integrations/spotify/shuffle/stop', { pause }),
    /** How many songs to keep queued ahead while a session runs. */
    setQueueAhead: (queueAhead: number) =>
      request<{ queueAhead: number }>('/api/integrations/spotify/shuffle/settings', {
        method: 'PUT',
        body: JSON.stringify({ queueAhead }),
      }),
    /** Play, or queue, these collections' songs in an even shuffle or a weighted random order. */
    shuffle: (
      mode: 'play' | 'queue',
      collectionIds: string[] | undefined,
      order: 'shuffle' | 'random',
      repeatAfter: number,
      recency: { recent?: { within: number; factor: number }; fresh?: { after: number; factor: number } } = {},
      from: 'phone' | 'computer' = 'computer'
    ) =>
      request<{ songs: number; of: number; mode: 'play' | 'queue'; device: string }>('/api/integrations/spotify/shuffle', {
        method: 'POST',
        body: JSON.stringify({ mode, order, repeatAfter, collectionIds, ...recency, from }),
        /*
         * Longer than the 15s every other change gets. Play answers once the
         * music has started and queues the rest afterwards, so it is quick —
         * but a refusal from Spotify can hold every request to it for up to 30s,
         * which is slow, not gone.
         */
        signal: AbortSignal.timeout(90_000),
      }),
    /** Boost a song (by URI) or an artist (by id) for the random order; 1 removes the boost. */
    setShuffleWeight: (kind: 'song' | 'artist', id: string, weight: number) =>
      request<unknown>('/api/integrations/spotify/weights', { method: 'PUT', body: JSON.stringify({ kind, id, weight }) }),
    /** Tick or untick one playlist. */
    setCollectionIgnored: (id: string, ignored: boolean) =>
      patch<{ id: string; ignored: boolean }>(`/api/integrations/collections/${id}`, { ignored }),
    /** Channels and artists you follow. Synced on demand, not refreshed on read. */
    follows: () => request<FollowsView>('/api/integrations/follows'),
    /** Two accounts that are the same creator. May be on the same service. */
    linkFollows: (a: string, b: string) =>
      post<{ groupId: string }>('/api/integrations/follows/link', { a, b }),
    /** Which of a group's accounts the merged row wears. */
    setPrimaryFollow: (id: string) => post<{ ok: boolean }>('/api/integrations/follows/primary', { id }),
    /** Take one account out of its group, leaving the rest joined. */
    unlinkFollow: (id: string) => post<{ ok: boolean }>('/api/integrations/follows/unlink', { id }),
    collectionItems: (id: string) => request<MediaItem[]>(`/api/integrations/collections/${id}`),
    music: () => request<MusicView>('/api/integrations/music'),
};
