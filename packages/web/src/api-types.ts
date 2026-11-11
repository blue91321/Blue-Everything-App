/**
 * What the server answers with: the shapes of its rows and replies.
 *
 * Declared here rather than imported from `@everything/shared`, because the
 * API returns database rows (integer booleans, nullable columns) while shared
 * describes the *input* schemas, and because this bundle does not import
 * shared at all (see the note at the top of `api.ts`). `api.ts` re-exports
 * every one, so importers write `from './api'` either way.
 */

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
  /**
   * A shape name, an emoji, or `image` for an uploaded picture.
   *
   * Opaque — an unknown value is drawn as text. `image` is a sentinel rather
   * than a separate `useCustomPicture` flag, because the two are exclusive and a
   * boolean alongside a shape would allow "custom picture *and* triangle". The
   * app logo settled the same question the same way.
   */
  gaugeShape?: string;
  /** A picture has been uploaded — not the same as the gauge being set to it. */
  hasImage?: boolean;
  /** Bumped when the picture is replaced, which is how its cache is busted. */
  updatedAt?: number;
  /**
   * The gauge right now, 0–100, computed **on the server**.
   *
   * Not worked out here, though it is one subtraction: doing it in the browser
   * would make the level depend on the device's clock, and a phone a few minutes
   * out would draw a different gauge from the PC.
   */
  gaugeNow?: number;
  /** The level at or below which it starts asking. 0 means "when empty". */
  gaugeRemindAt?: number;
  /** How long until it empties, in ms. Null if it never will. */
  gaugeEmptyInMs?: number | null;
  /**
   * How long until it starts *asking* — the number you plan around.
   *
   * Sent separately from `gaugeEmptyInMs` rather than derived here, for the same
   * reason the level is: doing the arithmetic in the browser would make both
   * countdowns follow the device's clock, and the phone would disagree with the
   * PC about when you are due.
   */
  gaugeRemindInMs?: number | null;
  active: number;
  sortOrder: number;
  reminderEveryMinutes: number | null;
  /** Minutes since midnight before reminders start; null means straight away. */
  reminderStartMinute: number | null;
  /** 1 yes, 0 no, null follows the default in Settings. */
  pushToPhone: number | null;
  /** Things you can say to tick this off, from the voice blueprints that do. */
  voicePhrases: string[];
  /**
   * The voice commands (blueprints) that tick it, and where each is edited.
   * Optional: a server older than this sends none.
   */
  spoken?: { label: string; phrases: string[]; enabled: boolean; edit: { screen: string; focus: string } }[];
  periodKey: string;
  doneThisPeriod: number;
  /** The last tick ever, not just this period. Null if never done. */
  lastDoneAt?: number | null;
  /**
   * Finished — done with, and belonging under "Finished today".
   *
   * **Not the negation of `wantsDoing`.** The two are the same question for a
   * counted habit and come apart for the other modes: a gauge is draining the
   * moment it is full, so it is never finished, while it only *wants doing* once
   * it is empty. Collapsing them put a gauge at 20% under a heading saying you
   * were done with it.
   */
  met: boolean;
  /** Wants doing right now — the question the nudge engine acts on. */
  wantsDoing?: boolean;
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
  /** How loud the app's tones are, 0 to 100. Absent on a server older than the column. */
  soundVolume?: number;
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
  /** Comma-separated words that keep being heard as the wake word. */
  wakeDecoys?: string;
  /** Other ways the wake word comes out when you say it, which count as it. */
  wakeAlikes?: string;
  requireKnownSpeaker?: number;
  /** 0-1. Stored as whole percent; converted on the way out of the server. */
  speakerThreshold?: number;
  /** The voiceprint itself is never sent — no screen has a use for 192 floats. */
  hasVoiceprint?: boolean;
  /** Enrolled under the old speaker model: kept, not enforced, and worth redoing. */
  voiceprintStale?: boolean;
  voiceprintSamples?: number;
  /** Microphone name; null follows the Windows default. */
  voiceInputDevice?: string | null;
  /** Seconds it keeps listening after answering. 0 switches follow-ups off. */
  voiceFollowUpSeconds?: number;
  voiceRetrySeconds?: number;
  /**
   * Use the follow-up time after a miss too, and hide the second slider.
   *
   * A **number**, like every other boolean on this type. SQLite has no boolean,
   * so a row carries 0 or 1 — and the update payload below takes a real boolean,
   * because that side is the zod schema rather than the row. Typing this one as
   * `boolean` made `=== true` quietly false and the card never hid.
   */
  voiceRetryMatchesFollowUp?: number;
  /** System-wide key combinations. Null or absent means none is set. */
  voiceToggleHotkey?: string | null;
  voiceListenHotkey?: string | null;
  /** Whether the listen shortcut works while voice is off. A row value, so 0/1. */
  voiceListenHotkeyWhileOff?: number;
  /**
   * How often an open Dashboard refetches on its own, in seconds. 0 is off,
   * which is the default — see the column for why nothing polls by default.
   */
  dashboardRefreshSeconds?: number;
  /** Width at or above which the menu docks itself beside the content. */
  drawerBreakpoint?: number;
  /**
   * Whether the menu starts docked on a wide screen.
   *
   * A `number`, not a `boolean` — the row returns 0 or 1 and the warning at the
   * top of this file is about exactly this. `voiceRetryMatchesFollowUp` was
   * declared `boolean` here, `=== true` was quietly false against a `1`, and
   * the card it controlled never hid while the setting saved perfectly.
   */
  drawerDocked?: number;
  gameDetectionEnabled?: number;
  interruptDuringGames?: number;
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
  /**
   * What the side column holds, in the order they are drawn.
   *
   * Optional for the usual reason: the PWA and the server update independently,
   * and a bundle newer than the process serving it must read an absent list as
   * "fall back to the single panel" rather than as "no panels".
   */
  dashboardPanels?: string[];
  /**
   * The main column's blocks, in order — the core sections and any panel put
   * among them.
   *
   * Optional for the same reason, and **empty means the built-in order** rather
   * than an empty Dashboard: see `chosenBlocks`.
   */
  dashboardBlocks?: string[];
  /**
   * What the live panel narrows to — `all` or `favourites`.
   *
   * A real pair rather than an opaque string, unlike `dashboardPanel`: these two
   * values are core's own, so an unknown one would silently mean "all".
   */
  livePanelScope?: 'all' | 'favourites';
  updatedAt?: number;
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

/**
 * A row in the list, which deliberately carries no body.
 *
 * The sidebar holds every note and the editor holds one, so sending bodies with
 * the list meant a megabyte of Markdown on every keystroke of the search box.
 * `preview` is the rendered first line or two, which is all a row shows.
 */
export interface Note {
  id: string;
  /** Always something — the server falls back to the first meaningful line. */
  title: string;
  /** Null when the note has no title of its own, so the editor can tell. */
  storedTitle: string | null;
  folder: string;
  pinned: number;
  preview: string;
  createdAt: number;
  updatedAt: number;
}

export interface NoteLinkRow {
  id: string;
  title: string;
  folder: string;
  /** The line the link sits on, so a backlink says something. */
  context: string;
}

export interface NoteFile {
  id: string;
  name: string;
  ext: string;
  mime: string;
  bytes: number;
}

/** One note, opened. */
export interface NoteDetail extends Note {
  body: string;
  backlinks: NoteLinkRow[];
  /** `id` is null for a link to a note that does not exist yet. */
  outgoing: { target: string; display: string; id: string | null; title: string }[];
  files: NoteFile[];
}

export interface NoteFolder {
  path: string;
  name: string;
  count: number;
}

export interface NoteGraph {
  nodes: { id: string; title: string; folder: string; degree: number }[];
  edges: { from: string; to: string }[];
}

export interface ImportedNotePreview {
  title: string;
  body: string;
  folder: string;
  tags: string[];
}

export interface NoteImportResult {
  format: string;
  formatLabel: string;
  notes: ImportedNotePreview[];
  skipped: { name: string; why: string }[];
  total: number;
  committed: number;
  folder?: string;
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

/** A package's contribution to the app's chrome, from `/api/session`. */
export interface SessionPackage {
  id: string;
  label: string;
  tab: { label: string; glyph: string; order: number } | null;
  panels: { id: string; label: string; hint?: string }[];
}

export interface Session {
  ok: boolean;
  /** True when running on the PC hosting the server — no token needed. */
  local: boolean;
  deviceId: string | null;
  deviceKind: string | null;
  /** What the server is running. Absent on a server older than this field. */
  version?: string;
  /**
   * Installed packages that draw something. Absent on a server that predates
   * them, which is read as "none" rather than as an error — the same treatment
   * `features` gets, and for the same reason.
   */
  packages?: SessionPackage[];
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
  /**
   * Which person's copy of the server this is, or null on the host: your own,
   * which manages the others (Settings → People). Absent from an older server.
   */
  copy?: string | null;
  /** Been through onboarding, and which screens to show (null for all). Absent from an older server. */
  onboarding?: Onboarding;
  /** What this person is called, to friends on this PC; null until chosen. Absent from an older server. */
  displayName?: string | null;
  /** What they are called until they choose: the name the host gave this copy, or "user". */
  defaultName?: string;
}

/** One person's copy of the server, as Settings → People lists it. */
/** Onboarding's answers. See `onboarding.ts` on the server. */
export interface Onboarding {
  done: boolean;
  shown: string[] | null;
  /** Absent from an older server. */
  preset?: 'manga' | 'everything' | 'custom';
  known?: string[] | null;
}

export interface Person {
  name: string;
  /** What they chose to be called, or null until they have. */
  displayName: string | null;
  port: number;
  running: boolean;
  autostart: boolean;
  created: string | null;
  /** `https://<machine>.ts.net:<port>`, once Tailscale publishes it. */
  address: string | null;
  localAddress: string;
}

/** A single-use sign-in link for a person's copy. */
export interface PersonInvite {
  url: string;
  expiresAt: number;
  person: Person;
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

/** The newest release, against the one running. */
export interface UpdateCheck {
  current: string;
  latest: string | null;
  newer: boolean;
  name?: string | null;
  notes?: string | null;
  url?: string | null;
  publishedAt?: string | null;
  /** Whether this machine can install it from here: local, with the script present. */
  canApply?: boolean;
  kind?: 'git' | 'release';
  /** Set when there is nothing published at all yet. */
  note?: string;
}

/* ------------------------------------------------------------------ */
/* Installed packages                                                  */
/* ------------------------------------------------------------------ */

/** What is wrong with a package, named field by field. */
export interface ModuleProblem {
  field: string;
  message: string;
}

/**
 * One folder under `modules/`.
 *
 * Unlike a `FeatureInfo`, most of this is nullable — a package whose manifest
 * will not parse is still *listed*, with its problems, because a bad zip that
 * produced no row at all would be indistinguishable from a drag that never
 * worked. `usable` is the one field that says whether it can run.
 */
export interface ModuleInfo {
  id: string;
  /** Ships with the app rather than having been installed. Not removable. */
  shipped: boolean;
  label: string;
  blurb: string | null;
  version: string | null;
  author: string | null;
  notes: string | null;
  /** It has a server entry point, which means installing it runs code. */
  code: boolean;
  bytes: number;
  enabled: boolean;
  /** Loaded into the running process — false until a restart. */
  running: boolean;
  pendingRestart: boolean;
  problems: ModuleProblem[];
  usable: boolean;
}

export interface ModuleState {
  /** Absolute path, or null when the caller is not on the server's machine. */
  folder: string | null;
  canInstall: boolean;
  modules: ModuleInfo[];
}

export interface InstalledPackage {
  ok: boolean;
  id: string;
  label: string;
  version: string;
  replaced: boolean;
  files: number;
}

/** One executable this machine has been seen running. */
export interface Game {
  exe: string;
  label: string;
  isGame: number;
  /** 1 yes, 0 no, null follows `interruptDuringGames` — three states on purpose. */
  allowInterruptions: number | null;
  launchPath: string | null;
  /**
   * A `steam://` address, when running the executable is not how you start it.
   *
   * Wins over the path. Optional because the server and the PWA update
   * independently, and a bundle newer than the process serving it must not
   * throw over a field that predates it.
   */
  launchUrl?: string | null;
  source: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface Device {
  id: string;
  name: string;
  kind: string;
  lastSeenAt: number | null;
  revokedAt: number | null;
}
