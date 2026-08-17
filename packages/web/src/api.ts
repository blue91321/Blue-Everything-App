/**
 * Talking to the server.
 *
 * Row types are declared here rather than imported from @everything/shared
 * because the API returns database rows — integer booleans, nullable columns —
 * while the shared package describes the *input* schemas. They're related but
 * not the same shape, and pretending otherwise causes quiet type lies.
 *
 * All paths are relative, so the same build works on localhost and over
 * Tailscale with no configuration.
 */

const TOKEN_KEY = 'everything.token';

export const getToken = (): string => localStorage.getItem(TOKEN_KEY) ?? '';
export const setToken = (token: string): void => localStorage.setItem(TOKEN_KEY, token.trim());
export const clearToken = (): void => localStorage.removeItem(TOKEN_KEY);

/** Thrown on 401 so the UI can drop back to the pairing screen. */
export class Unauthorized extends Error {}

/**
 * Thrown when the request never reached a server.
 *
 * Distinct from `Unauthorized`, and the distinction is the point: a `fetch`
 * that rejects and a 401 both ended with no session, so both used to blank the
 * app back to the pairing screen — and "Blue Everything is not running" was
 * therefore reported as "this device is not paired", which sends you off to
 * find a token you already have.
 *
 * The shell survives the server dying because the service worker caches it, so
 * this state is genuinely reachable and worth telling apart.
 */
export class ServerUnreachable extends Error {}

/**
 * GETs for the same URL that are already in flight, so they become one.
 *
 * A single change announcement reaches every `useAsync` on screen at once, and
 * the Settings screen alone holds three separate readers of `/api/settings`
 * plus the one in `App` — so one click on a toggle produced **six identical
 * requests**, measured. They are all asking the same question at the same
 * instant and they cannot get different answers.
 *
 * Only GETs, and only while genuinely concurrent: the entry is dropped the
 * moment the response settles, so this is a coalescer and not a cache. A stale
 * read is the one thing this app cannot afford here — the whole point of the
 * live stream is that two devices never disagree.
 */
const inFlight = new Map<string, Promise<unknown>>();

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? 'GET';

  if (method === 'GET') {
    const shared = inFlight.get(path);
    if (shared) return shared as Promise<T>;

    const started = send<T>(path, init, method);
    inFlight.set(path, started);
    // `finally` on the promise rather than await/try, so the entry is cleared
    // for a rejection too — a failed fetch must not wedge the path forever.
    void started.finally(() => inFlight.delete(path));
    return started;
  }

  return send<T>(path, init, method);
}

async function send<T>(path: string, init: RequestInit, method: string): Promise<T> {
  const body = init.body ?? (method === 'GET' ? undefined : '{}');

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      body,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        authorization: `Bearer ${getToken()}`,
        ...init.headers,
      },
    });
  } catch (cause) {
    // `fetch` rejects only when the request never got a reply — the process is
    // down, the machine is asleep, the network is gone. Anything the server
    // answered, however badly, comes back as a response.
    throw new ServerUnreachable(cause instanceof Error ? cause.message : 'could not reach the server');
  }

  if (response.status === 401) throw new Unauthorized('this device is not paired');
  if (!response.ok) throw new Error(await errorMessage(response, method, path));
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * The server's own words, when it sent any.
 *
 * Every route in this app answers a failure with `{ error }`, and this used to
 * throw that away and show `POST /api/… failed (500)` instead. The effect was
 * invisible for a long time because most failures here are "the server is not
 * running", where a status code is as much as anyone can say — but the moment a
 * route had something useful to report, the screen could not show it. Steam
 * answering "that API key was rejected, keys are revoked when you change your
 * password" arrived as a 500 and a path.
 *
 * The status is kept as a fallback rather than dropped: a proxy error page or a
 * crash before the handler produces no JSON at all, and "failed (502)" is still
 * better than an empty string.
 */
async function errorMessage(response: Response, method: string, path: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error.trim() !== '') return body.error;
  } catch {
    // Not JSON, or no body. Fall through to the status.
  }
  return `${method} ${path} failed (${response.status})`;
}

const post = <T>(path: string, payload?: unknown) =>
  request<T>(path, { method: 'POST', body: payload === undefined ? undefined : JSON.stringify(payload) });
const patch = <T>(path: string, payload: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(payload) });
/** Alias, because `patch` is shadowed by a parameter name inside api.vault. */
const patch2 = patch;

/* ---------- row shapes ---------- */

export type TaskStatus = 'todo' | 'doing' | 'done' | 'dropped';

export interface Task {
  id: string;
  title: string;
  notes: string | null;
  status: TaskStatus;
  priority: number;
  dueAt: number | null;
  /** The date matters, the time of day doesn't. `dueAt` is end of that day. */
  dueIsAllDay: number;
  /** 1 yes, 0 no, null follows the default in Settings. */
  pushToPhone: number | null;
  projectId: string | null;
  createdAt: number;
  completedAt: number | null;
  /**
   * Which service this came from, if it was not typed here. An opaque slug.
   *
   * A task appearing on the Dashboard that you did not write needs a word
   * saying who wrote it — "can I delete this, will it come back" is a fair
   * question and the chip is what answers it.
   */
  source: string | null;
  /** The thing itself, at that service. */
  sourceUrl: string | null;
}

/** What the API accepts for a task, as opposed to what a row looks like. */
export interface TaskInput {
  title?: string;
  notes?: string | null;
  status?: TaskStatus;
  priority?: number;
  dueAt?: number | null;
  dueIsAllDay?: boolean;
  /** null puts it back to following the default rather than meaning "no". */
  pushToPhone?: boolean | null;
}

/**
 * How a habit decides it wants doing. Mirrors `habitModes` in shared, which this
 * package cannot import.
 *
 *   - `target`   N times a day or week.
 *   - `interval` due again a fixed time after the last time you did it.
 *   - `gauge`    a level that drains, topped up by doing the thing.
 */
export type HabitMode = 'target' | 'interval' | 'gauge';

export interface Habit {
  id: string;
  name: string;
  notes: string | null;
  /** Optional: a server older than the column sends nothing, and that is target. */
  mode?: HabitMode;
  cadence: 'daily' | 'weekly';
  targetPerPeriod: number;
  /** `interval` mode: due again this long after the last tick. */
  intervalMinutes?: number | null;
  /** `gauge` mode: the stored anchor, which the server also resolves for us. */
  gaugeDrainPerDay?: number;
  gaugeFillPercent?: number;
  /** A shape name or an emoji — opaque, so an unknown value is drawn as text. */
  gaugeShape?: string;
  /**
   * The gauge right now, 0–100, computed **on the server**.
   *
   * Not worked out here, though it is one subtraction: doing it in the browser
   * would make the level depend on the device's clock, and a phone a few minutes
   * out would draw a different gauge from the PC.
   */
  gaugeNow?: number;
  /** How long until it empties, in ms. Null if it never will. */
  gaugeEmptyInMs?: number | null;
  active: number;
  sortOrder: number;
  reminderEveryMinutes: number | null;
  /** Minutes since midnight before reminders start; null means straight away. */
  reminderStartMinute: number | null;
  /** 1 yes, 0 no, null follows the default in Settings. */
  pushToPhone: number | null;
  /** Things you can say to tick this off. Empty means voice can't reach it. */
  voicePhrases: string[];
  periodKey: string;
  doneThisPeriod: number;
  /** The last tick ever, not just this period. Null if never done. */
  lastDoneAt?: number | null;
  /**
   * Nothing wanted right now — across all three modes, not just "target met".
   *
   * Widened rather than joined by a second field, so every screen that already
   * keys off it — habits left, the settling animation, Finished today — treats a
   * gauge like a habit without learning what a gauge is.
   */
  met: boolean;
}

export interface AppSettings {
  quietHoursEnabled: number;
  quietStartMinute: number;
  quietEndMinute: number;
  followWindowsDnd: number;
  dndUntil: number | null;
  remindersEnabled: number;
  /** A short tone with each popup. Absent on a server older than the column. */
  soundEnabled?: number;
  /**
   * Which tone each moment gets, by name from the agent's palette.
   *
   * Empty string means "the agent's default for that moment", which keeps
   * tracking the default rather than freezing today's choice.
   */
  soundWake?: string;
  soundOk?: string;
  soundMiss?: string;
  soundNudge?: string;
  pushEnabled: number;
  /**
   * What a task or habit that hasn't chosen gets. Optional for the same reason
   * the voice fields are — a server predating the column sends nothing, and the
   * screen should hide the control rather than render a switch stuck on.
   */
  pushDefault?: number;
  /** Public half only; the private key never leaves the server. */
  vapidPublicKey: string;
  awayFromPcIdleMinutes: number;
  /** Live from the agent, not stored. */
  windowsDnd: boolean;
  /** Whether reminders are silenced right this second, and why. */
  quietNow: boolean;
  quietReason: 'reminders-off' | 'paused' | 'quiet-hours' | 'windows-dnd' | null;

  /**
   * How the app looks. Optional for the same reason the voice fields are — a
   * server that predates the appearance migration sends neither, and the app
   * falls back to dark + blue rather than rendering an empty picker.
   */
  theme?: 'dark' | 'light' | 'system';
  accentColor?: string;
  logoShape?: 'pause' | 'circle' | 'triangle' | 'square' | 'image';
  /** Bumped on every upload; used to bust caches on the icon URLs. */
  logoVersion?: number;

  /**
   * Optional because the server can genuinely be older than this bundle — the
   * PWA is rebuilt and served by a process that may not have restarted yet.
   * Typed as present when it isn't is what turned a stale server into a blank
   * Settings screen, so the absence is in the type now and has to be handled.
   */
  voiceEnabled?: number;
  wakeWord?: string;
  requireKnownSpeaker?: number;
  /** 0-1. Stored as whole percent; converted on the way out of the server. */
  speakerThreshold?: number;
  /** The voiceprint itself is never sent — no screen has a use for 128 floats. */
  hasVoiceprint?: boolean;
  voiceprintSamples?: number;
  /** Microphone name; null follows the Windows default. */
  voiceInputDevice?: string | null;
  /** Seconds it keeps listening after answering. 0 switches follow-ups off. */
  voiceFollowUpSeconds?: number;
  voiceRetrySeconds?: number;
  overlayPlacement?: string;
  overlayScreen?: string | null;
  /** An emoji, `file` for an uploaded picture, or empty for none. */
  overlayAvatar?: string;
  /** Services left out of the friends list. Absent on an older server. */
  hiddenProviders?: string[];
  /**
   * What the Dashboard shows in its side column. Empty for one column.
   *
   * An opaque id — the panels worth having come from features that can be
   * deleted, so nothing here validates it. Optional because the server and the
   * PWA update independently, and a browser holding a newer bundle than the
   * process serving it is the ordinary case right after an edit.
   */
  dashboardPanel?: string;
  updatedAt?: number;
}

/** An `AppSettings` from a server that actually has voice support. */
export type VoiceSettings = AppSettings & Required<Pick<AppSettings, 'wakeWord' | 'speakerThreshold' | 'voiceprintSamples'>>;

export const serverSupportsVoice = (settings: AppSettings): settings is VoiceSettings =>
  settings.wakeWord !== undefined;

/** Live state of the listener, as last reported by the agent. */
export interface VoiceStatus {
  /** The setting. Whether anything is *actually* listening is `listening`. */
  enabled: boolean;
  agentRunning: boolean;
  listening: boolean;
  device: string | null;
  devices: { id: number; name: string }[];
  error: string | null;
  /** Loudest level since the agent's last report, 0-1. Drives the meter. */
  peak: number;
  lastReportAt: number | null;
  selectedDevice: string | null;
  paused: boolean;
  /** -1 means until switched back on by hand; a timestamp means until then. */
  pausedUntil: number | null;
  /** Closed because the desk is empty — distinct from off, paused and broken. */
  awayFromPc?: boolean;
  testing: boolean;
  testUntil: number;
  /** The last test ended because a command matched, not because it ran out. */
  testSucceeded: boolean;
  /** Collecting wake-word samples right now. */
  enrolling: boolean;
  enrolUntil: number;
  enrolSamples: number;
  /** How well the last sample agreed with the ones before it, 0-1. */
  enrolAgreement: number | null;
  /** Phrase words the speech model cannot pronounce, so can never be heard. */
  unknownWords: string[];
  followUpSeconds: number;
  retrySeconds: number;
  overlayPlacement: string;
  overlayScreen: string | null;
  overlayAvatar: string;
  /** Monitors the agent can see — the browser only knows about its own. */
  screens: { id: string; label: string; primary: boolean }[];
  heard: {
    /** `speech` is words heard while still waiting for the wake word. */
    kind: 'level' | 'speech' | 'wake' | 'command';
    /** Whether the transcript actually contains the wake word. */
    matchedWake: boolean;
    text: string;
    speakerScore: number | null;
    peak: number;
    at: number;
    wouldMatch: { habitName: string | null; phrase: string } | null;
  }[];
}

export type VoiceCommandKind = 'habit' | 'note' | 'url' | 'hotkey' | 'media' | 'pause' | 'cancel';

export interface VoiceCommand {
  id: string;
  kind: VoiceCommandKind;
  phrases: string[];
  /** Habit id, URL, or key combo, depending on `kind`. */
  target: string | null;
  pauseMinutes: number | null;
  /** Server-derived display name when none was set by hand. */
  label: string | null;
  /** Whether the microphone stays open after this one fires. */
  allowFollowUp: boolean;
  enabled: boolean;
  sortOrder: number;
}

/** What `/api/voice/test` says a sentence would do. Nothing is written. */
export interface VoiceTest {
  heard: string;
  tokens: string[];
  count: number;
  match: { id: string; phrase: string; score: number; habitName: string | null } | null;
  /**
   * Set when the sentence is several commands joined by "and", in the order
   * they would run. `match` is null whenever this is present — a chain is not
   * one match, and showing the first would describe a fraction of what happens.
   *
   * Optional because a server older than chaining sends neither field.
   */
  chain?:
    | { phrase: string; kind: VoiceCommandKind; habitName: string | null; count: number }[]
    | null;
}

export interface VaultStatus {
  configured: boolean;
  hasRecovery: boolean;
  itemCount: number;
  unlocked: boolean;
  /** When the auto-lock will fire, if unlocked. */
  expiresAt: number | null;
  lockedOutUntil: number | null;
  autoLockMinutes: number;
}

/** The list view. Never carries a password — those come one at a time. */
export interface VaultSummary {
  id: string;
  title: string;
  username: string;
  url: string;
  createdAt: number;
  updatedAt: number;
}

export interface VaultSecret {
  id: string;
  password: string;
  totp: string;
  notes: string;
}

export interface ImportResult {
  preview: boolean;
  format: string;
  /** Preview only. */
  found?: number;
  wouldImport?: number;
  sample?: string[];
  /** Commit only. */
  imported?: number;
  duplicates: number;
  skippedWithoutPassword: number;
}

export interface ConnectAddress {
  url: string;
  kind: 'tailscale-https' | 'tailscale' | 'lan' | 'local';
  label: string;
  secure: boolean;
}

export interface ConnectInfo {
  addresses: ConnectAddress[];
  tailscale: { dnsName: string; serving: boolean } | null;
  hostname: string;
  port: number;
}

export interface Note {
  id: string;
  title: string | null;
  body: string;
  pinned: number;
  updatedAt: number;
}

export interface Nudge {
  id: string;
  title: string;
  body: string | null;
  taskId: string | null;
  state: string;
  minQuality: 'any' | 'decent' | 'prime';
  earliestAt: number;
  deadlineAt: number | null;
  escalated: number;
}

export interface TimeEntry {
  id: string;
  taskId: string | null;
  label: string | null;
  startedAt: number;
  endedAt: number | null;
}

/* ---------- endpoints ---------- */

export interface Session {
  ok: boolean;
  /** True when running on the PC hosting the server — no token needed. */
  local: boolean;
  deviceId: string | null;
  deviceKind: string | null;
  /** What the server is running. Absent on a server older than this field. */
  version?: string;
  /**
   * Which optional features this server runs, e.g. `['vault', 'voice']`.
   *
   * Optional for the same reason the voice settings are: the three packages
   * restart independently and `start.ps1` rebuilds the PWA when its sources are
   * newer, so a browser holding a new bundle against a server that predates
   * this field is the *ordinary* case right after an edit. Absent means "an
   * older server", which is treated as everything on — a stale server should
   * look stale, not like an app with no features.
   */
  features?: string[];
  /** Switched on but with its folder deleted. Distinct from simply off. */
  featuresMissing?: string[];
}

/**
 * One switchable part of the app.
 *
 * `running` is what the server booted with; `wanted` is what `features.json`
 * now says. They differ exactly when a restart is owed, which is the whole
 * reason both are sent rather than one.
 */
export interface FeatureInfo {
  id: string;
  label: string;
  blurb: string;
  /** What it costs to have on, measured. Null when negligible. */
  cost: string | null;
  /** Its own version, or the app's when it ships with the app. */
  version: string;
  /** True when it has no version of its own and moves with the app. */
  bundled: boolean;
  /** Whether its folders can be deleted, as opposed to merely switched off. */
  removable: boolean;
  defaultEnabled: boolean;
  running: boolean;
  wanted: boolean;
  /** On, but its folders are gone from disk — a different problem from off. */
  missing: boolean;
  active: boolean;
  owns: string[];
}

export interface FeatureState {
  /** `EVERYTHING_FEATURES` is set and overrides the file, so the switches can't apply. */
  lockedByEnv: boolean;
  /** The file no longer matches what is running. */
  pendingRestart: boolean;
  hasFile: boolean;
  /** Absent on a server older than per-package versions. */
  appVersion?: string;
  /** Whether there is anywhere to check for updates yet. */
  updates?: { configured: boolean; source: string | null };
  features: FeatureInfo[];
}

export interface Device {
  id: string;
  name: string;
  kind: string;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

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
  state: 'offline' | 'online' | 'away' | 'in-game' | 'dnd' | 'unknown';
  game: string | null;
  detail: string | null;
  lastOnlineAt: number | null;
  seenAt: number;
  /** Set when the status came from a different account than the name. */
  statusFrom: string | null;
  accounts: Array<{ id: string; provider: string; name: string }>;
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

export interface MusicView {
  breakdown: Array<{ category: string; count: number }>;
}

export const api = {
  health: () => request<{ ok: boolean }>('/health'),
  /**
   * Is the server answering *right now*?
   *
   * Deliberately not `api.health()`: that goes through the coalescer, which
   * would hand every poll the same in-flight promise, and it carries the bearer
   * token for no reason. This is a bare liveness ping used while waiting for a
   * server that is starting up.
   */
  isUp: async (): Promise<boolean> => {
    try {
      const response = await fetch(`/health?t=${Date.now()}`, { cache: 'no-store' });
      return response.ok;
    } catch {
      return false;
    }
  },
  session: () => request<Session>('/api/session'),

  devices: {
    list: () => request<Device[]>('/api/devices'),
    create: (payload: { name: string; kind: 'phone' | 'browser' | 'windows-agent' | 'extension' }) =>
      post<Device & { token: string }>('/api/devices', payload),
    revoke: (id: string) => post(`/api/devices/${id}/revoke`),
    /** Only works on an already-revoked device — the server enforces that. */
    remove: (id: string) => request<void>(`/api/devices/${id}`, { method: 'DELETE' }),
  },

  tasks: {
    list: (status = 'todo,doing') => request<Task[]>(`/api/tasks?status=${encodeURIComponent(status)}`),
    create: (payload: TaskInput & { title: string }) => post<Task>('/api/tasks', payload),
    // Not Partial<Task>: the row stores dueIsAllDay as 0/1, but the API takes a
    // boolean, and letting the row type through here sends the wrong one.
    update: (id: string, payload: TaskInput) => patch<Task>(`/api/tasks/${id}`, payload),
    remove: (id: string) => request<void>(`/api/tasks/${id}`, { method: 'DELETE' }),
  },

  habits: {
    list: () => request<Habit[]>('/api/habits'),
    create: (payload: {
      name: string;
      mode?: HabitMode;
      cadence?: 'daily' | 'weekly';
      targetPerPeriod?: number;
    }) => post<Habit>('/api/habits', payload),
    update: (
      id: string,
      payload: {
        name?: string;
        mode?: HabitMode;
        cadence?: 'daily' | 'weekly';
        targetPerPeriod?: number;
        intervalMinutes?: number | null;
        gaugeDrainPerDay?: number;
        gaugeFillPercent?: number;
        gaugeShape?: string;
        active?: boolean;
        reminderEveryMinutes?: number | null;
        reminderStartMinute?: number | null;
        pushToPhone?: boolean | null;
        voicePhrases?: string[];
      }
    ) => patch<Habit>(`/api/habits/${id}`, payload),
    remove: (id: string) => request<void>(`/api/habits/${id}`, { method: 'DELETE' }),
    reorder: (ids: string[]) => post('/api/habits/reorder', { ids }),
    check: (id: string) => post(`/api/habits/${id}/check`),
    uncheck: (id: string) => post(`/api/habits/${id}/uncheck`),
  },

  connectInfo: () => request<ConnectInfo>('/api/connect-info'),

  features: {
    get: () => request<FeatureState>('/api/features'),
    /** Local-only, and it takes a restart — the response says whether one is owed. */
    set: (id: string, enabled: boolean) =>
      patch<{ ok: boolean; id: string; wanted: boolean; pendingRestart: boolean }>('/api/features', {
        id,
        enabled,
      }),
  },

  settings: {
    get: () => request<AppSettings>('/api/settings'),
    update: (payload: {
      theme?: 'dark' | 'light' | 'system';
      accentColor?: string;
      logoShape?: 'pause' | 'circle' | 'triangle' | 'square' | 'image';
      quietHoursEnabled?: boolean;
      quietStartMinute?: number;
      quietEndMinute?: number;
      followWindowsDnd?: boolean;
      dndUntil?: number | null;
      remindersEnabled?: boolean;
      soundEnabled?: boolean;
      soundWake?: string;
      soundOk?: string;
      soundMiss?: string;
      soundNudge?: string;
      pushEnabled?: boolean;
      pushDefault?: boolean;
      voiceEnabled?: boolean;
      wakeWord?: string;
      requireKnownSpeaker?: boolean;
      speakerThreshold?: number;
      voiceInputDevice?: string | null;
      voiceFollowUpSeconds?: number;
      voiceRetrySeconds?: number;
      overlayPlacement?: string;
      overlayScreen?: string | null;
      overlayAvatar?: string;
      hiddenProviders?: string[];
      /** Opaque panel id, or '' for one column. */
      dashboardPanel?: string;
    }) => patch<AppSettings>('/api/settings', payload),
  },

  logo: {
    /**
     * Upload a picture to use as the mark.
     *
     * Sent as base64 in JSON rather than multipart, matching the voice avatar:
     * the server has no multipart parser registered and adding one for a single
     * endpoint used once in a blue moon is a dependency for nothing.
     */
    upload: (file: File) =>
      new Promise<{ ok: boolean; bytes: number }>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('could not read that file'));
        reader.onload = () => {
          const result = String(reader.result);
          // Strip the `data:image/png;base64,` prefix the reader adds.
          const data = result.slice(result.indexOf(',') + 1);
          request<{ ok: boolean; bytes: number }>('/api/logo', {
            method: 'PUT',
            body: JSON.stringify({ data, type: file.type }),
          }).then(resolve, reject);
        };
        reader.readAsDataURL(file);
      }),

    remove: () => request<{ ok: boolean }>('/api/logo', { method: 'DELETE' }),
  },

  voice: {
    /** Dry run: what would this sentence do? Writes nothing. */
    test: (text: string) => post<VoiceTest>('/api/voice/test', { text }),
    forgetVoice: () => request<void>('/api/voice/enrol', { method: 'DELETE' }),
    status: () => request<VoiceStatus>('/api/voice/status'),
    commands: () => request<VoiceCommand[]>('/api/voice/commands'),
    createCommand: (payload: Partial<VoiceCommand>) => post<VoiceCommand>('/api/voice/commands', payload),
    updateCommand: (id: string, payload: Partial<VoiceCommand>) =>
      patch<VoiceCommand>(`/api/voice/commands/${id}`, payload),
    removeCommand: (id: string) => request<void>(`/api/voice/commands/${id}`, { method: 'DELETE' }),
    resume: () => post('/api/voice/resume'),
    uploadAvatar: (data: string, type: string) =>
      request<{ ok: boolean }>('/api/voice/avatar', {
        method: 'PUT',
        body: JSON.stringify({ data, type }),
      }),
    startEnrol: () => post<{ enrolUntil: number }>('/api/voice/enrol/start'),
    stopEnrol: () => post('/api/voice/enrol/stop'),
    startListening: () => post<{ testUntil: number }>('/api/voice/test-listen'),
    stopListening: () => post('/api/voice/test-listen/stop'),
  },

  push: {
    subscribe: (subscription: unknown) => post('/api/devices/me/push', subscription),
  },

  vault: {
    status: () => request<VaultStatus>('/api/vault/status'),
    setup: (masterPassword: string, withRecovery: boolean) =>
      post<{ recoveryShares: { a: string; b: string } | null }>('/api/vault/setup', { masterPassword, withRecovery }),
    unlock: (masterPassword: string) => post<VaultStatus>('/api/vault/unlock', { masterPassword }),
    lock: () => post<VaultStatus>('/api/vault/lock'),
    items: () => request<VaultSummary[]>('/api/vault/items'),
    secret: (id: string) => request<VaultSecret>(`/api/vault/items/${id}/secret`),
    create: (item: Partial<VaultSecret> & { title: string; username?: string; url?: string }) =>
      post<VaultSummary>('/api/vault/items', item),
    update: (id: string, patch: Record<string, string>) => patch2(`/api/vault/items/${id}`, patch),
    remove: (id: string) => request<void>(`/api/vault/items/${id}`, { method: 'DELETE' }),
    recover: (shareA: string, shareB: string, newMasterPassword: string) =>
      post('/api/vault/recover', { shareA, shareB, newMasterPassword }),
    changePassword: (currentPassword: string, newPassword: string) =>
      post('/api/vault/change-password', { currentPassword, newPassword }),
    importCsv: (csv: string, commit: boolean, includeDuplicates = false) =>
      post<ImportResult>('/api/vault/import', { csv, commit, includeDuplicates }),
    regenerateRecovery: () =>
      post<{ recoveryShares: { a: string; b: string } }>('/api/vault/recovery/regenerate'),
    destroy: (masterPassword: string) =>
      post<{ ok: boolean; deletedEntries: number }>('/api/vault/destroy', { masterPassword }),
  },

  notes: {
    list: () => request<Note[]>('/api/notes'),
    create: (payload: { title?: string | null; body: string }) => post<Note>('/api/notes', payload),
    update: (id: string, payload: { title?: string | null; body?: string; pinned?: boolean }) =>
      patch<Note>(`/api/notes/${id}`, payload),
    remove: (id: string) => request<void>(`/api/notes/${id}`, { method: 'DELETE' }),
  },

  nudges: {
    queue: () => request<Nudge[]>('/api/nudges/queue'),
    create: (payload: { title: string; body?: string; minQuality?: string; deadlineAt?: number | null }) =>
      post<Nudge>('/api/nudges', payload),
    snooze: (id: string, minutes: number) => post(`/api/nudges/${id}/snooze`, { minutes }),
    dismiss: (id: string) => post(`/api/nudges/${id}/dismiss`),
  },

  /**
   * App integrations.
   *
   * The provider manifest arrives from the server rather than being imported
   * from `@everything/shared`, for the reason `api.ts` opens with: this bundle
   * does not pull in that package. It is the same arrangement `/api/session`
   * uses for the feature list — the server owns the table of facts, and hands
   * the PWA plain JSON.
   */
  integrations: {
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
    /** Accounts that look like the same person. Proposals, not links. */
    linkSuggestions: () => request<{ suggestions: LinkSuggestion[] }>('/api/integrations/friends/suggestions'),
    linkFriends: (a: string, b: string) => post<{ personId: string }>('/api/integrations/friends/link', { a, b }),
    unlinkFriend: (id: string) => post<{ ok: boolean }>('/api/integrations/friends/unlink', { id }),
    /** Dissolve a whole group, which is what a merged row comes apart into. */
    unlinkPerson: (personId: string) => post<{ ok: boolean }>('/api/integrations/friends/unlink', { personId }),
    collections: () => request<MediaCollection[]>('/api/integrations/collections'),
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
  },

  time: {
    current: () => request<TimeEntry | null>('/api/time/current'),
    start: (payload: { taskId?: string | null; label?: string | null }) => post<TimeEntry>('/api/time/start', payload),
    stop: () => post<{ stopped: number }>('/api/time/stop'),
  },
};
