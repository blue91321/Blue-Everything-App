/**
 * The database, defined once.
 *
 * Portability rules, because this will eventually move off this PC:
 *   - Text UUID primary keys, never autoincrement integers. Rows keep their
 *     identity across an export, a merge, or a restore.
 *   - Timestamps are integer epoch milliseconds. No SQLite date functions, no
 *     timezone ambiguity, and they survive a move to Postgres unchanged.
 *   - Booleans are integers, because SQLite has no boolean type.
 *   - No SQLite-only SQL anywhere in queries.
 */
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'node:crypto';

const id = () => text('id').primaryKey().$defaultFn(() => randomUUID());
const now = () => integer('created_at').notNull().$defaultFn(() => Date.now());
const touched = () =>
  integer('updated_at')
    .notNull()
    .$defaultFn(() => Date.now())
    .$onUpdateFn(() => Date.now());

/* ------------------------------------------------------------------ */

export const projects = sqliteTable('projects', {
  id: id(),
  name: text('name').notNull(),
  color: text('color'),
  archived: integer('archived').notNull().default(0),
  createdAt: now(),
  updatedAt: touched(),
});

export const tasks = sqliteTable(
  'tasks',
  {
    id: id(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    /** Self-reference gives subtasks without a second table. */
    parentId: text('parent_id'),
    title: text('title').notNull(),
    notes: text('notes'),
    status: text('status').notNull().default('todo'),
    priority: integer('priority').notNull().default(0),
    dueAt: integer('due_at'),
    /**
     * The due date has no meaningful time of day.
     *
     * `dueAt` still holds an instant — the end of that day — so every query
     * that orders or compares by it keeps working. This flag only says how to
     * *talk* about it: "due Friday" rather than "due Friday at 11:59pm", and
     * eligible to nudge from the morning rather than an hour before midnight.
     */
    dueIsAllDay: integer('due_is_all_day').notNull().default(0),
    /**
     * May this one reach the phone when you are away from the PC?
     *
     * **Nullable on purpose: null means "follow `settings.push_default`".** A
     * notNull boolean would have to be stamped with the default at creation, and
     * would then stop tracking it — changing the default later would leave every
     * existing task on the old answer, silently. Three states are the honest
     * model, because "I have not decided" is genuinely not the same as "no".
     */
    pushToPhone: integer('push_to_phone'),
    scheduledAt: integer('scheduled_at'),
    estimateMinutes: integer('estimate_minutes'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: now(),
    updatedAt: touched(),
    completedAt: integer('completed_at'),
  },
  (t) => [
    index('tasks_status_idx').on(t.status),
    index('tasks_due_idx').on(t.dueAt),
    index('tasks_parent_idx').on(t.parentId),
  ]
);

export const habits = sqliteTable('habits', {
  id: id(),
  name: text('name').notNull(),
  notes: text('notes'),
  cadence: text('cadence').notNull().default('daily'),
  targetPerPeriod: integer('target_per_period').notNull().default(1),
  active: integer('active').notNull().default(1),
  /** Hand-ordered in the Habits tab; ties fall back to name. */
  sortOrder: integer('sort_order').notNull().default(0),
  /**
   * Nag every N minutes until the target is met. Null means it only appears in
   * lists and never interrupts — the right default for most habits.
   */
  reminderEveryMinutes: integer('reminder_every_minutes'),
  /**
   * Don't start nagging until this time of day, as minutes since local
   * midnight. Null means from the moment the period begins.
   *
   * "Take a walk" wants to be raised at two in the afternoon, not at seven in
   * the morning alongside everything else — a reminder that arrives before it
   * is actionable teaches you to ignore reminders.
   */
  reminderStartMinute: integer('reminder_start_minute'),
  /** Null follows `settings.push_default` — see `tasks.push_to_phone`. */
  pushToPhone: integer('push_to_phone'),
  /**
   * JSON array of things you might say to tick this off. A JSON column rather
   * than a side table because they are only ever read and written as a whole
   * list, and there is nothing to query or join them by.
   */
  voicePhrases: text('voice_phrases').notNull().default('[]'),
  createdAt: now(),
  updatedAt: touched(),
});

/**
 * Everything a spoken phrase can do.
 *
 * Replaces `habits.voice_phrases`, which could only ever tick off a habit. That
 * column is migrated into this table and then left alone — the Voice screen is
 * the single place phrases are edited, so two sources of truth would only
 * disagree.
 */
export const voiceCommands = sqliteTable(
  'voice_commands',
  {
    id: id(),
    /** habit | note | url | hotkey | pause. */
    kind: text('kind').notNull(),
    /** JSON array of the things you might say. */
    phrases: text('phrases').notNull().default('[]'),
    /**
     * Habit id, URL, or key combo, depending on `kind`. Not a foreign key: it
     * holds three different sorts of value, and a habit that goes away should
     * leave a visibly broken command rather than silently deleting the phrase.
     */
    target: text('target'),
    /** For `pause`: minutes. Null means until switched back on by hand. */
    pauseMinutes: integer('pause_minutes'),
    label: text('label'),
    /** Whether the microphone stays open after this command fires. */
    allowFollowUp: integer('allow_follow_up').notNull().default(1),
    enabled: integer('enabled').notNull().default(1),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: now(),
    updatedAt: touched(),
  },
  (t) => [index('voice_commands_enabled_idx').on(t.enabled)]
);

export const habitEntries = sqliteTable(
  'habit_entries',
  {
    id: id(),
    habitId: text('habit_id')
      .notNull()
      .references(() => habits.id, { onDelete: 'cascade' }),
    /**
     * `YYYY-MM-DD` for daily habits, `YYYY-Www` for weekly. Storing the period
     * as a string keeps streak queries a plain GROUP BY instead of date maths,
     * and dodges the "which timezone was that midnight in" problem entirely.
     */
    periodKey: text('period_key').notNull(),
    count: integer('count').notNull().default(1),
    doneAt: integer('done_at').notNull().$defaultFn(() => Date.now()),
  },
  (t) => [index('habit_entries_habit_period_idx').on(t.habitId, t.periodKey)]
);

export const timeEntries = sqliteTable(
  'time_entries',
  {
    id: id(),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    label: text('label'),
    startedAt: integer('started_at').notNull(),
    /** Null means still running. At most one open entry at a time. */
    endedAt: integer('ended_at'),
    source: text('source').notNull().default('manual'),
    createdAt: now(),
  },
  (t) => [index('time_entries_started_idx').on(t.startedAt)]
);

export const notes = sqliteTable('notes', {
  id: id(),
  title: text('title'),
  body: text('body').notNull().default(''),
  pinned: integer('pinned').notNull().default(0),
  createdAt: now(),
  updatedAt: touched(),
});

/**
 * The nudge queue — the part of the schema the whole app exists for.
 *
 * A nudge is not a notification. It is a *request* to interrupt, which sits
 * here until the attention model says the moment is good enough.
 */
export const nudges = sqliteTable(
  'nudges',
  {
    id: id(),
    title: text('title').notNull(),
    body: text('body'),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    habitId: text('habit_id').references(() => habits.id, { onDelete: 'cascade' }),
    earliestAt: integer('earliest_at').notNull().$defaultFn(() => Date.now()),
    deadlineAt: integer('deadline_at'),
    /**
     * Drop it unfired after this. Recurring reminders set it, because a "drink
     * water" from two hours ago is worthless — without expiry a long gaming
     * session ends in a stack of identical toasts, which is worse than silence.
     */
    expiresAt: integer('expires_at'),
    minQuality: text('min_quality').notNull().default('decent'),
    /**
     * Resolved at sweep time from the task or habit and the default, so the
     * answer is the one that applied when this was queued.
     *
     * notNull here, unlike on the rows it comes from: by the time something is
     * in the queue "undecided" has been decided. Keeping it inheritable would
     * mean re-reading the source row on every delivery pass, and a nudge whose
     * task has since been deleted would have nothing to inherit from.
     */
    pushToPhone: integer('push_to_phone').notNull().default(1),
    state: text('state').notNull().default('pending'),
    snoozeUntil: integer('snooze_until'),
    deliveredAt: integer('delivered_at'),
    deliveredDeviceId: text('delivered_device_id'),
    /** How many times this has been shown — for spotting nudges being ignored. */
    attempts: integer('attempts').notNull().default(0),
    /** True when it fired on its deadline rather than at a good moment. */
    escalated: integer('escalated').notNull().default(0),
    createdAt: now(),
    updatedAt: touched(),
  },
  (t) => [index('nudges_state_earliest_idx').on(t.state, t.earliestAt)]
);

/**
 * Raw attention history. Feeds time tracking ("what was I actually doing at
 * 3pm") and, later, tuning the stopping-point heuristics against reality.
 * Expected to grow fast — prune it on a schedule rather than keeping it forever.
 */
export const attentionSamples = sqliteTable(
  'attention_samples',
  {
    id: id(),
    at: integer('at').notNull(),
    state: text('state').notNull(),
    reason: text('reason').notNull(),
    exe: text('exe'),
    title: text('title'),
    idleMs: integer('idle_ms').notNull().default(0),
    /** JSON array. Denormalised on purpose; this table is append-only log data. */
    liveGames: text('live_games').notNull().default('[]'),
    stoppingQuality: text('stopping_quality'),
    /**
     * Recorded because idle time alone can't explain why a phone nudge did or
     * didn't fire. Without it, "you were idle 52 minutes and nothing pushed" is
     * unanswerable after the fact.
     */
    audioPlaying: integer('audio_playing').notNull().default(0),
    awayFromPc: integer('away_from_pc').notNull().default(0),
    createdAt: now(),
  },
  (t) => [index('attention_samples_at_idx').on(t.at)]
);

/**
 * One row, id 'singleton'. There is one user, so preferences are columns rather
 * than a key-value bag — typed, migratable, and greppable.
 */
export const settings = sqliteTable('settings', {
  id: text('id').primaryKey().$defaultFn(() => 'singleton'),

  /**
   * Quiet hours as minutes since local midnight. Start > end wraps past
   * midnight, which is the normal case for sleep.
   *
   * `quietHoursEnabled` is a real flag rather than inferring "off" from
   * start == end. A sentinel value meant turning it off destroyed the times and
   * left nothing to turn back on.
   */
  quietHoursEnabled: integer('quiet_hours_enabled').notNull().default(0),
  quietStartMinute: integer('quiet_start_minute').notNull().default(23 * 60),
  quietEndMinute: integer('quiet_end_minute').notNull().default(7 * 60 + 30),

  /**
   * Follow Windows' own Do Not Disturb. Costs nothing — the agent already reads
   * it — and works for any sleep pattern, because it's a switch that gets
   * flipped when you actually go to bed rather than at a predicted hour.
   */
  followWindowsDnd: integer('follow_windows_dnd').notNull().default(1),

  /** Manual pause, as an absolute time. Null means not paused. */
  dndUntil: integer('dnd_until'),

  /** Master switch, so everything can be silenced without losing the settings. */
  remindersEnabled: integer('reminders_enabled').notNull().default(1),

  /**
   * Play a short tone with each popup.
   *
   * On by default, unlike voice: this is a sound attached to something you
   * already asked to be told about, not a new capability that holds a device
   * open. It is still a switch, because a noise you cannot turn off is the
   * fastest way to make someone turn the whole app off instead.
   */
  soundEnabled: integer('sound_enabled').notNull().default(1),

  /**
   * How the app looks. Stored server-side rather than in the browser so the
   * phone and the PC agree — picking a colour on one and finding the other
   * still amber would read as the setting not having saved.
   *
   * `theme` is 'dark' | 'light' | 'system'; `accent_color` is one of
   * ACCENT_COLORS. Both are validated by the schema in `shared` rather than by
   * a database constraint, so adding a colour is a one-line change there.
   */
  theme: text('theme').notNull().default('dark'),
  accentColor: text('accent_color').notNull().default('blue'),

  /** One of LOGO_SHAPES. `image` uses the uploaded file. */
  logoShape: text('logo_shape').notNull().default('pause'),
  /**
   * Bumped on every upload, and used as a cache-busting query on the icon URLs.
   *
   * Necessary because the icons live at fixed paths that browsers, the iOS home
   * screen and the Windows shell all cache hard. Without a changing URL,
   * replacing the picture would leave the old one on screen indefinitely with
   * nothing to suggest why.
   */
  logoVersion: integer('logo_version').notNull().default(0),

  /**
   * VAPID keypair for web push, generated once on first use.
   *
   * The private key is a secret, but it lives in the same gitignored database
   * as everything else personal here, so it needs no separate handling. Only
   * the public half is ever sent to a browser.
   */
  vapidPublicKey: text('vapid_public_key'),
  vapidPrivateKey: text('vapid_private_key'),

  /** Send nudges to the phone when you are away from the PC. */
  pushEnabled: integer('push_enabled').notNull().default(1),

  /**
   * What a task or habit that hasn't said gets. The master switch above is
   * still what decides whether the phone is used at all.
   *
   * Two settings rather than one because they answer different questions.
   * `pushEnabled` is "does this install push to a phone"; this is "of the
   * things that could, which do by default". Folding them together would make
   * switching push off and setting the default to no indistinguishable, and
   * only one of those leaves per-item choices intact when you switch back.
   */
  pushDefault: integer('push_default').notNull().default(1),

  /**
   * Off by default, and deliberately so: this is the only feature in the app
   * that holds the microphone open, and that should be a thing you turn on
   * rather than a thing you discover is already running.
   */
  voiceEnabled: integer('voice_enabled').notNull().default(0),

  /** Plain text, changeable at any time. See wakeWordSchema for why. */
  wakeWord: text('wake_word').notNull().default('hey everything'),

  /**
   * Reject commands that don't sound like you. With an always-on microphone
   * this is doing real work — it is what stops the television, a video, or
   * someone else in the room from logging your habits.
   */
  /**
   * Off until a voiceprint exists, and switched on by enrolment rather than
   * defaulting to on. On by default would mean the settings screen showing
   * "only respond to my voice: on" while nothing was enrolled and nothing was
   * being checked — a switch claiming a protection it was not providing.
   */
  requireKnownSpeaker: integer('require_known_speaker').notNull().default(0),
  speakerThreshold: integer('speaker_threshold_pct').notNull().default(55),

  /**
   * The enrolled voiceprint: a JSON array of floats, averaged over the
   * enrolment clips. Not a secret in the vault sense — it cannot reconstruct
   * your voice — but it is personal, so it lives here and never leaves the box.
   */
  voiceprint: text('voiceprint'),
  voiceprintSamples: integer('voiceprint_samples').notNull().default(0),

  /**
   * Which microphone to listen on, by name. Null follows the Windows default.
   * A name rather than an index because Windows renumbers inputs when devices
   * come and go, and a stale index means quietly listening to the wrong thing.
   */
  voiceInputDevice: text('voice_input_device'),

  /**
   * Listening is paused until this time. `-1` means paused until you turn it
   * back on by hand — distinct from null (not paused), so "stop listening" can
   * mean either "for a bit" or "until I say so" and the difference survives a
   * restart.
   */
  voicePausedUntil: integer('voice_paused_until'),

  /**
   * Seconds it keeps listening after answering, with no wake word needed.
   * 0 switches follow-ups off entirely — the microphone closes as soon as a
   * command is done, which is the conservative choice and a legitimate one.
   */
  voiceFollowUpSeconds: integer('voice_follow_up_seconds').notNull().default(6),
  /** The same, but after a miss — repeating yourself takes longer than adding. */
  voiceRetrySeconds: integer('voice_retry_seconds').notNull().default(8),

  /** Where the popup appears, and on which screen. Null screen = the mouse's. */
  overlayPlacement: text('overlay_placement').notNull().default('cursor'),
  overlayScreen: text('overlay_screen'),
  /**
   * An emoji, the literal `file` when you uploaded a picture, or empty for
   * none. The picture itself lives beside the database rather than in it —
   * a settings row read on every page load has no business carrying an image.
   */
  overlayAvatar: text('overlay_avatar').notNull().default(''),

  updatedAt: touched(),
});

export const devices = sqliteTable('devices', {
  id: id(),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  /** SHA-256 of the bearer token. The token itself is shown once, at pairing. */
  tokenHash: text('token_hash').notNull().unique(),
  /** Web Push subscription JSON, for the phone. Null until the PWA registers. */
  pushSubscription: text('push_subscription'),
  lastSeenAt: integer('last_seen_at'),
  revokedAt: integer('revoked_at'),
  createdAt: now(),
});

/**
 * The vault's key material. One row, id 'singleton'.
 *
 * Holds no secrets in the clear: the vault key exists here only in wrapped
 * form, and each wrapping is itself authenticated, so a wrong master password
 * fails to unwrap rather than yielding a plausible-looking wrong key.
 */
export const vault = sqliteTable('vault', {
  id: text('id').primaryKey().$defaultFn(() => 'singleton'),

  /** Argon2id salt and cost, stored so parameters can be raised later without
   *  locking you out of a vault created under the old ones. */
  kdfSalt: text('kdf_salt').notNull(),
  kdfVersion: integer('kdf_version').notNull().default(1),
  kdfMemoryKiB: integer('kdf_memory_kib').notNull(),
  kdfPasses: integer('kdf_passes').notNull(),
  kdfParallelism: integer('kdf_parallelism').notNull(),

  /** vaultKey sealed under the key derived from the master password. */
  wrappedByPassword: text('wrapped_by_password').notNull(),
  /** vaultKey sealed under the recovery code. Null if recovery was declined. */
  wrappedByRecovery: text('wrapped_by_recovery'),

  createdAt: now(),
  updatedAt: touched(),
});

/**
 * One encrypted entry per row, and *everything* is inside the blob — title,
 * username, URL, password, notes.
 *
 * No plaintext label column. This database syncs to OneDrive, and a list of
 * which services you have accounts with is worth protecting even when the
 * passwords themselves are safe. The cost is that the item list can't render
 * until the vault is unlocked, which is the correct trade.
 */
export const vaultEntries = sqliteTable('vault_entries', {
  id: id(),
  /** Base64 of nonce ‖ ciphertext ‖ GCM tag. */
  sealed: text('sealed').notNull(),
  createdAt: now(),
  updatedAt: touched(),
});

/* ------------------------------------------------------------------ */
/* App integrations                                                    */
/* ------------------------------------------------------------------ */

/**
 * One row per connected outside service. Holds the credentials.
 *
 * **These are live bearer tokens to your Spotify and Google accounts, and they
 * are not under the vault key.** That is a deliberate choice and worth stating
 * where the columns are: the vault is unlocked by typing a master password, and
 * a library sync that runs while you are out cannot type one. Putting these
 * behind it would mean the feature only worked while you were sitting there
 * having just unlocked the vault, which is not a feature.
 *
 * So they live here, in the same gitignored database as everything else
 * personal, and the mitigation is the same one the rest of the app relies on:
 * `npm run publish-check` refuses to pass on a tracked database. Every scope
 * requested is read-only, so the worst a leaked token does is read a playlist.
 */
export const integrationAccounts = sqliteTable('integration_accounts', {
  /** The provider id itself — there is one of you, so one account per service. */
  id: text('id').primaryKey(),
  /** Whatever the service calls you. Shown so you can tell which account it is. */
  accountName: text('account_name'),
  /** The service's own id for you, which display names are not a substitute for. */
  accountId: text('account_id'),

  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  /** Absolute, not a duration — a duration is only meaningful next to the
   *  moment it was issued, and that moment is exactly what a restart forgets. */
  expiresAt: integer('expires_at'),
  /**
   * What was actually granted, which is not what was asked for. Discord will
   * hand back a token with `identify` and quietly drop the presence scope; the
   * screen has to be able to say so rather than showing an empty friends list.
   */
  scopes: text('scopes').notNull().default('[]'),

  /** For `api-key` providers: the key, and whatever identifies you to them. */
  apiKey: text('api_key'),
  externalId: text('external_id'),

  /**
   * The OAuth application's own id and secret, when they were typed into the
   * app rather than left in the environment.
   *
   * On this row, next to the token, because they belong to the same connection
   * and go away with it. The env var is read only when the column is null, so
   * pasting a value here always wins — an env var that silently took precedence
   * would make re-pasting a client id appear to work and change nothing.
   *
   * A row can exist with these set and no token at all: that is "configured but
   * not connected", which is why `connected` is decided by the presence of a
   * token rather than by the row existing.
   */
  clientId: text('client_id'),
  clientSecret: text('client_secret'),

  /**
   * The provider refused this application's optional scopes, so stop asking.
   *
   * Set when the authorize page answers `invalid_scope`. That happens *before*
   * any token exists, so without remembering it the next Connect asks for the
   * same refused scope and fails identically — the account is simply
   * unconnectable, with no way out from inside the app.
   *
   * Cleared by the button on the card, for once the gated feature has been
   * enabled at the provider's end.
   */
  optionalScopesRefused: integer('optional_scopes_refused').notNull().default(0),

  /**
   * Per-provider switches that change what a sync does, as JSON.
   *
   * JSON rather than a column each, because these are provider-specific and a
   * `youtube_skip_liked` column on a table shared by five services describes the
   * wrong thing. Read whole, written whole, and validated by
   * `providerOptionsSchema` on the way in.
   */
  options: text('options').notNull().default('{}'),

  /** Per-capability sync clock, as JSON: { playlists: 1786…, follows: 1786… }. */
  syncedAt: text('synced_at').notNull().default('{}'),
  /** Last failure, kept until the next success. A connection that stopped
   *  working must say why on the screen, not just stop producing rows. */
  lastError: text('last_error'),

  createdAt: now(),
  updatedAt: touched(),
});

/**
 * A track or a video, deduplicated across every playlist it appears in.
 *
 * Keyed by (provider, provider_id) rather than by title: the same song appears
 * in six playlists with one row, so a category assigned once is a category
 * assigned everywhere. That is the whole reason this is a table and not a JSON
 * blob hanging off each playlist.
 */
export const mediaItems = sqliteTable(
  'media_items',
  {
    id: id(),
    provider: text('provider').notNull(),
    /** Spotify track id, YouTube video id. */
    providerItemId: text('provider_item_id').notNull(),
    kind: text('kind').notNull(),

    title: text('title').notNull(),
    /** Artist, or channel. One field because it answers one question. */
    creator: text('creator'),
    /**
     * The provider's ids for those artists or that channel, as a JSON array.
     *
     * `creator` is a display name — "Bicep", or "A$AP Rocky, Skepta" for a
     * collaboration — and matching a followed artist to their tracks by name
     * gets both halves wrong: a joint track does not equal either artist's
     * name, and a short name is a substring of longer ones. These are the same
     * ids `follows.provider_account_id` holds, so the join is exact.
     *
     * An array because a track genuinely has several artists and each of them
     * should count it. JSON rather than a join table because it is only ever
     * read whole, and a two-row side table per track is a lot of rows to carry
     * for a number on one screen.
     */
    creatorIds: text('creator_ids').notNull().default('[]'),
    album: text('album'),
    durationMs: integer('duration_ms'),
    url: text('url'),
    artUrl: text('art_url'),

    /** JSON array of the provider's own genre strings, kept verbatim. */
    genres: text('genres').notNull().default('[]'),
    /**
     * The family `categoriseGenres` folded those into, stored rather than
     * derived on read so the library can be grouped and counted in SQL.
     *
     * Recomputed on every sync, which makes it a cache rather than data: when
     * the keyword table gets better, the next sync fixes every row, and nothing
     * has to migrate.
     */
    category: text('category').notNull().default('unknown'),
    /** Which genre string decided it. Null means nothing did — see `unknown`. */
    categoryBecause: text('category_because'),

    releasedAt: integer('released_at'),
    createdAt: now(),
    updatedAt: touched(),
  },
  (t) => [
    // Unique, and that is the deduplication: a track in six playlists is one
    // row, so the category assigned to it is assigned once.
    uniqueIndex('media_items_provider_idx').on(t.provider, t.providerItemId),
    index('media_items_category_idx').on(t.category),
  ]
);

export const mediaCollections = sqliteTable(
  'media_collections',
  {
    id: id(),
    provider: text('provider').notNull(),
    /**
     * notNull, and the pseudo-playlists get a literal — `saved`, `subscriptions`
     * — rather than a null.
     *
     * SQLite treats every NULL as distinct in a unique index, so a nullable
     * column here would let "Liked Songs" be inserted afresh on every sync while
     * the index that was supposed to prevent exactly that reported no conflict.
     */
    providerCollectionId: text('provider_collection_id').notNull(),
    /** playlist | saved | subscriptions. */
    kind: text('kind').notNull().default('playlist'),
    name: text('name').notNull(),
    description: text('description'),
    artUrl: text('art_url'),
    /** What the provider claims, which can exceed what we managed to fetch. */
    itemCount: integer('item_count').notNull().default(0),
    /** The provider's own version marker, so an unchanged playlist is skipped. */
    snapshotId: text('snapshot_id'),
    syncedAt: integer('synced_at'),
    createdAt: now(),
    updatedAt: touched(),
  },
  (t) => [uniqueIndex('media_collections_provider_idx').on(t.provider, t.providerCollectionId)]
);

export const mediaCollectionItems = sqliteTable(
  'media_collection_items',
  {
    id: id(),
    collectionId: text('collection_id')
      .notNull()
      .references(() => mediaCollections.id, { onDelete: 'cascade' }),
    itemId: text('item_id')
      .notNull()
      .references(() => mediaItems.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    addedAt: integer('added_at'),
  },
  (t) => [index('media_collection_items_collection_idx').on(t.collectionId, t.position)]
);

/**
 * Who is online, as a current snapshot rather than a log.
 *
 * Upserted in place and never appended to, which is what keeps this feature
 * inside the leanness budget: forty friends is forty rows forever, however long
 * the app runs. A presence *history* would be the interesting thing to have and
 * is exactly what turns a cheap feature into an attention sampler for other
 * people's evenings, so it is not kept.
 */
export const friends = sqliteTable(
  'friends',
  {
    id: id(),
    provider: text('provider').notNull(),
    providerUserId: text('provider_user_id').notNull(),
    name: text('name').notNull(),
    avatarUrl: text('avatar_url'),
    /** offline | online | away | in-game. */
    state: text('state').notNull().default('offline'),
    game: text('game'),
    detail: text('detail'),
    lastOnlineAt: integer('last_online_at'),
    /**
     * Which real person this account belongs to, when you have said.
     *
     * Two rows sharing one of these are the same human on two services — a
     * Discord handle and a Steam profile — and the friends list shows them as
     * one entry. Null means unlinked, which is most of them.
     *
     * A shared id rather than a `links` table because the relation is a
     * grouping, not a pair: a third service joins by taking the same id, and
     * unlinking is setting one back to null. There is no join to write and no
     * pair to keep symmetrical.
     *
     * It survives a sync because `replaceFriends` upserts and never touches
     * this column — losing your linking every time Steam refreshed would make
     * the feature pointless.
     */
    personId: text('person_id'),
    /** When we last heard anything about this person, fresh or not. */
    seenAt: integer('seen_at').notNull().$defaultFn(() => Date.now()),
    createdAt: now(),
    updatedAt: touched(),
  },
  (t) => [
    uniqueIndex('friends_provider_user_idx').on(t.provider, t.providerUserId),
    index('friends_person_idx').on(t.personId),
  ]
);

/**
 * Accounts you follow or subscribe to — YouTube channels, Spotify artists.
 *
 * Its own table rather than a collection of channels, which is what this was
 * first. That shape stored a channel as a `media_item` of kind `video`, so every
 * subscription landed in the library with no duration, no album and no play, and
 * was counted in the Music tab's category breakdown as though it were a track.
 *
 * A followed account is a third kind of thing here: not a friend, because it has
 * no presence and never will, and not a track, because it has none of a track's
 * fields. Filing it as either is what put "Spotify — friends: not possible" on a
 * screen about who is online.
 *
 * Snapshot-shaped like `friends`, for the same reasons: upserted in place so ids
 * stay stable, pruned by `seenAt` so an unsubscribe actually disappears.
 */
export const follows = sqliteTable(
  'follows',
  {
    id: id(),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    /** channel | artist. */
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    url: text('url'),
    avatarUrl: text('avatar_url'),
    /** JSON array of the provider's genre strings. Artists only. */
    genres: text('genres').notNull().default('[]'),
    /** Folded from `genres`, so the list groups without re-deriving on read. */
    category: text('category').notNull().default('unknown'),
    categoryBecause: text('category_because'),
    followerCount: integer('follower_count'),
    seenAt: integer('seen_at').notNull().$defaultFn(() => Date.now()),
    createdAt: now(),
    updatedAt: touched(),
  },
  (t) => [uniqueIndex('follows_provider_account_idx').on(t.provider, t.providerAccountId)]
);

export const schema = {
  projects,
  tasks,
  habits,
  habitEntries,
  timeEntries,
  notes,
  nudges,
  attentionSamples,
  settings,
  devices,
  vault,
  vaultEntries,
  integrationAccounts,
  mediaItems,
  mediaCollections,
  mediaCollectionItems,
  friends,
  follows,
};

/** Used by the health check to prove the database is actually reachable. */
export const healthProbe = sql`select 1`;
