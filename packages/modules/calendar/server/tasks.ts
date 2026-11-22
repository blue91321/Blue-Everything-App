/**
 * Tasks with a due date, on the calendar (2026-11-20).
 *
 * Asked for as "the Canvas connection should actually put stuff on the
 * calendar". Canvas assignments already arrive as ordinary tasks (the
 * integrations package's coursework sync, with `source: 'canvas'`), so the
 * calendar reads tasks rather than having a second copy written into
 * `calendar.json`: an extension moves the deadline here because it moves the
 * task, handing it in ticks it off here because it ticks the task, and there is
 * nothing to keep in step. The calendar does not import the integrations
 * package (a package may not import another); it reads core's `tasks` table,
 * which every package may.
 *
 * Shown as their own layer, read-only as events and tickable as tasks. They
 * remind through the task's own nudge, never through the calendar's, or a due
 * assignment would be said twice.
 */
import { and, gte, inArray, isNotNull, lt } from 'drizzle-orm';
import { db, schema } from '@everything/server/module-api';
import { dateOf, serverZone, wallAt } from './time.js';

/** Which tasks: every one with a due date, only those from a service (Canvas), or none. */
export type TaskLayer = 'all' | 'synced' | 'none';
export const TASK_LAYERS: readonly TaskLayer[] = ['all', 'synced', 'none'];

export interface DueTask {
  id: string;
  title: string;
  /** The instant it is due. For a task due on a day, the end of that day. */
  dueAt: number;
  allDay: boolean;
  /** The day it is due, in the server's zone, for one due on a day; the screen places a timed one by its instant. */
  date: string;
  done: boolean;
  /** Where it came from (`canvas`), or null for one typed here. */
  source: string | null;
  sourceUrl: string | null;
  /** The course, for an assignment. */
  notes: string | null;
}

/** Tasks due inside the window, done ones included (struck through), dropped ones left out. */
export async function dueTasks(fromMs: number, toMs: number, layer: TaskLayer): Promise<DueTask[]> {
  if (layer === 'none') return [];
  const t = schema.tasks;
  const rows = await db
    .select({
      id: t.id,
      title: t.title,
      dueAt: t.dueAt,
      allDay: t.dueIsAllDay,
      status: t.status,
      source: t.source,
      sourceUrl: t.sourceUrl,
      notes: t.notes,
    })
    .from(t)
    .where(and(isNotNull(t.dueAt), gte(t.dueAt, fromMs), lt(t.dueAt, toMs), inArray(t.status, ['todo', 'doing', 'done'])))
    .orderBy(t.dueAt)
    .limit(500);
  const zone = serverZone();
  return rows
    .filter((r) => r.dueAt !== null && (layer === 'all' || r.source !== null))
    .map((r) => ({
      id: r.id,
      title: r.title,
      dueAt: r.dueAt!,
      allDay: r.allDay === 1,
      date: dateOf(wallAt(r.dueAt!, zone)),
      done: r.status === 'done',
      source: r.source,
      sourceUrl: r.sourceUrl,
      notes: r.notes,
    }));
}
