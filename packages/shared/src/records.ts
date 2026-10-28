/**
 * The things you write down: tasks and projects, time entries, and notes.
 */
import { z } from 'zod';
import { patchOf } from './patch.js';

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
  /** The date matters but the time of day doesn't. `dueAt` holds end of day. */
  dueIsAllDay: z.boolean().default(false),
  /** May this reach the phone? Null follows the default — see `resolvePush`. */
  pushToPhone: z.boolean().nullish(),
  scheduledAt: z.number().int().nullish(),
  estimateMinutes: z.number().int().positive().nullish(),
});

/** Local end of day, which is the instant an all-day task is due by. */
export function endOfDayFor(at: number): number {
  const day = new Date(at);
  day.setHours(23, 59, 59, 999);
  return day.getTime();
}
export const updateTaskSchema = patchOf(createTaskSchema);

export const createProjectSchema = z.object({
  name: z.string().min(1).max(200),
  color: z.string().max(20).nullish(),
  archived: z.boolean().default(false),
});
export const updateProjectSchema = patchOf(createProjectSchema);

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
  /*
   * Half a megabyte, raised from 200k when the importers landed. A decade of
   * Evernote arrives as a handful of genuinely enormous notes, and refusing one
   * at the boundary would fail an import with a message about a limit rather
   * than about the note.
   */
  body: z.string().max(500_000).default(''),
  /** `a/b`, or empty for the root. Cleaned by `normaliseFolder` on the way in. */
  folder: z.string().max(400).nullish(),
  pinned: z.boolean().default(false),
});
export const updateNoteSchema = patchOf(createNoteSchema);
