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
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
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
  createdAt: now(),
  updatedAt: touched(),
});

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
     * didn't fire. Without it, "he was idle 52 minutes and nothing pushed" is
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
   * VAPID keypair for web push, generated once on first use.
   *
   * The private key is a secret, but it lives in the same gitignored database
   * as everything else personal here, so it needs no separate handling. Only
   * the public half is ever sent to a browser.
   */
  vapidPublicKey: text('vapid_public_key'),
  vapidPrivateKey: text('vapid_private_key'),

  /** Send nudges to the phone when Blake is away from the PC. */
  pushEnabled: integer('push_enabled').notNull().default(1),

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
   *  locking Blake out of a vault created under the old ones. */
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
 * which services Blake has accounts with is worth protecting even when the
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
};

/** Used by the health check to prove the database is actually reachable. */
export const healthProbe = sql`select 1`;
