/**
 * Vocabulary shared by the server, the PWA, and the Windows agent.
 *
 * These three talk only over HTTP, so this package is the single place where
 * their understanding of a task, a nudge, or an attention state can drift.
 * Keep it free of runtime dependencies beyond zod.
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Attention                                                           */
/* ------------------------------------------------------------------ */

export const attentionStates = ['free', 'in-game', 'focused', 'away'] as const;
export const attentionStateSchema = z.enum(attentionStates);
export type AttentionState = z.infer<typeof attentionStateSchema>;

export const stoppingQualities = ['decent', 'prime'] as const;
export const stoppingQualitySchema = z.enum(stoppingQualities);
export type StoppingQuality = z.infer<typeof stoppingQualitySchema>;

/**
 * How good a moment a nudge insists on before it will interrupt.
 * `any` fires during ordinary desktop use; `prime` waits for a match to end
 * or for Blake to come back to the desk.
 */
export const nudgeQualities = ['any', 'decent', 'prime'] as const;
export const nudgeQualitySchema = z.enum(nudgeQualities);
export type NudgeQuality = z.infer<typeof nudgeQualitySchema>;

/** Ordered so a `prime` moment also satisfies anything that asked for less. */
export const qualityRank: Record<NudgeQuality, number> = { any: 0, decent: 1, prime: 2 };

export const attentionReportSchema = z.object({
  at: z.number().int().optional(),
  state: attentionStateSchema,
  reason: z.string().max(300),
  exe: z.string().max(260).nullish(),
  title: z.string().max(500).nullish(),
  idleMs: z.number().int().nonnegative().default(0),
  liveGames: z.array(z.string().max(260)).default([]),
  /** Windows' own Do Not Disturb / quiet time is switched on right now. */
  windowsDnd: z.boolean().default(false),
  /** Present only on the poll where a transition actually happened. */
  stoppingPoint: z
    .object({ quality: stoppingQualitySchema, reason: z.string().max(300) })
    .nullish(),
});
export type AttentionReport = z.infer<typeof attentionReportSchema>;

/* ------------------------------------------------------------------ */
/* Tasks & projects                                                    */
/* ------------------------------------------------------------------ */

export const taskStatuses = ['todo', 'doing', 'done', 'dropped'] as const;
export const taskStatusSchema = z.enum(taskStatuses);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const createTaskSchema = z.object({
  title: z.string().min(1).max(500),
  notes: z.string().max(20_000).nullish(),
  projectId: z.string().uuid().nullish(),
  parentId: z.string().uuid().nullish(),
  status: taskStatusSchema.default('todo'),
  /** 0 = none, 3 = urgent. */
  priority: z.number().int().min(0).max(3).default(0),
  dueAt: z.number().int().nullish(),
  scheduledAt: z.number().int().nullish(),
  estimateMinutes: z.number().int().positive().nullish(),
});
export type CreateTask = z.infer<typeof createTaskSchema>;
export const updateTaskSchema = createTaskSchema.partial();

export const createProjectSchema = z.object({
  name: z.string().min(1).max(200),
  color: z.string().max(20).nullish(),
  archived: z.boolean().default(false),
});
export const updateProjectSchema = createProjectSchema.partial();

/* ------------------------------------------------------------------ */
/* Habits                                                              */
/* ------------------------------------------------------------------ */

export const cadences = ['daily', 'weekly'] as const;
export const cadenceSchema = z.enum(cadences);
export type Cadence = z.infer<typeof cadenceSchema>;

export const createHabitSchema = z.object({
  name: z.string().min(1).max(200),
  notes: z.string().max(20_000).nullish(),
  cadence: cadenceSchema.default('daily'),
  targetPerPeriod: z.number().int().positive().default(1),
  active: z.boolean().default(true),
  sortOrder: z.number().int().optional(),
  /** Nag every N minutes until the target is met; null to never interrupt. */
  reminderEveryMinutes: z.number().int().min(5).max(24 * 60).nullish(),
});
export const updateHabitSchema = createHabitSchema.partial();

/** Whole-list reorder: ids in the order they should appear. */
export const reorderSchema = z.object({ ids: z.array(z.string().uuid()).max(500) });

/* ------------------------------------------------------------------ */
/* Time tracking                                                       */
/* ------------------------------------------------------------------ */

export const timeSources = ['manual', 'auto'] as const;
export const timeSourceSchema = z.enum(timeSources);

export const startTimeEntrySchema = z.object({
  taskId: z.string().uuid().nullish(),
  label: z.string().max(300).nullish(),
  source: timeSourceSchema.default('manual'),
  startedAt: z.number().int().optional(),
});

/* ------------------------------------------------------------------ */
/* Notes                                                               */
/* ------------------------------------------------------------------ */

export const createNoteSchema = z.object({
  title: z.string().max(300).nullish(),
  body: z.string().max(200_000).default(''),
  pinned: z.boolean().default(false),
});
export const updateNoteSchema = createNoteSchema.partial();

/* ------------------------------------------------------------------ */
/* Nudges                                                              */
/* ------------------------------------------------------------------ */

export const nudgeStates = ['pending', 'delivered', 'acknowledged', 'snoozed', 'dismissed', 'expired'] as const;
export const nudgeStateSchema = z.enum(nudgeStates);
export type NudgeState = z.infer<typeof nudgeStateSchema>;

export const createNudgeSchema = z.object({
  title: z.string().min(1).max(300),
  body: z.string().max(2000).nullish(),
  taskId: z.string().uuid().nullish(),
  habitId: z.string().uuid().nullish(),
  /** Don't even consider delivering before this. Defaults to now. */
  earliestAt: z.number().int().optional(),
  /**
   * Past this, the nudge stops being polite and interrupts anyway — except
   * when Blake is away from the machine, where a toast would just be missed.
   */
  deadlineAt: z.number().int().nullish(),
  /** Drop it unfired after this. Recurring reminders set it; one-offs don't. */
  expiresAt: z.number().int().nullish(),
  minQuality: nudgeQualitySchema.default('decent'),
});
export type CreateNudge = z.infer<typeof createNudgeSchema>;

export const snoozeNudgeSchema = z.object({ minutes: z.number().int().positive().max(60 * 24) });

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const minuteOfDay = z.number().int().min(0).max(24 * 60 - 1);

export const updateSettingsSchema = z.object({
  quietHoursEnabled: z.boolean().optional(),
  quietStartMinute: minuteOfDay.optional(),
  quietEndMinute: minuteOfDay.optional(),
  followWindowsDnd: z.boolean().optional(),
  /** Absolute time; null clears the manual pause. */
  dndUntil: z.number().int().nullish(),
  remindersEnabled: z.boolean().optional(),
});

/**
 * Is `at` inside the quiet window?
 *
 * Start > end wraps past midnight, which is the normal case for sleep. Whether
 * quiet hours apply at all is a separate flag — don't infer it from the times.
 */
export function isQuietHour(at: Date, startMinute: number, endMinute: number): boolean {
  if (startMinute === endMinute) return false;
  const minute = at.getHours() * 60 + at.getMinutes();
  return startMinute < endMinute
    ? minute >= startMinute && minute < endMinute
    : minute >= startMinute || minute < endMinute;
}

/** Why reminders are currently silent, or null if they aren't. */
export type QuietReason = 'reminders-off' | 'paused' | 'quiet-hours' | 'windows-dnd';

export interface QuietInputs {
  quietHoursEnabled: boolean;
  quietStartMinute: number;
  quietEndMinute: number;
  followWindowsDnd: boolean;
  dndUntil: number | null;
  remindersEnabled: boolean;
  windowsDnd?: boolean;
}

/**
 * One place that decides whether anything is allowed to interrupt, so the
 * server, the phone and the settings screen can never disagree about why it's
 * gone quiet.
 */
export function quietReason(at: Date, input: QuietInputs): QuietReason | null {
  if (!input.remindersEnabled) return 'reminders-off';
  if (input.dndUntil && input.dndUntil > at.getTime()) return 'paused';
  if (input.quietHoursEnabled && isQuietHour(at, input.quietStartMinute, input.quietEndMinute)) return 'quiet-hours';
  if (input.followWindowsDnd && input.windowsDnd) return 'windows-dnd';
  return null;
}

/* ------------------------------------------------------------------ */
/* Devices                                                             */
/* ------------------------------------------------------------------ */

export const deviceKinds = ['windows-agent', 'phone', 'browser'] as const;
export const deviceKindSchema = z.enum(deviceKinds);
export type DeviceKind = z.infer<typeof deviceKindSchema>;

export const registerDeviceSchema = z.object({
  name: z.string().min(1).max(120),
  kind: deviceKindSchema,
});

/** Shape the API returns for a nudge the client should show right now. */
export interface DeliverableNudge {
  id: string;
  title: string;
  body: string | null;
  taskId: string | null;
  habitId: string | null;
  minQuality: NudgeQuality;
  /** True when this fired because its deadline passed, not because the moment was good. */
  escalated: boolean;
}
