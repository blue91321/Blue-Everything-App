/**
 * The tasks a trip puts on your list.
 *
 * Three kinds: **check in** when online check-in opens, **leave for the
 * airport** a lead time before departure, and each **checklist item** on its
 * day relative to the trip. They are ordinary tasks once made, so the nudge
 * engine holds and releases them like anything you typed, which is the point:
 * "leave for the airport" is exactly the reminder that must not land mid-match
 * and must not be missed either, and a due time is what lets it break through
 * once it is late.
 *
 * The rules are the coursework sync's, for the reasons given there:
 *
 *   - **A deleted task stays deleted.** The link keeps `made: true` with its id
 *     gone, and a made link is never made again.
 *   - **A due date you moved is yours.** One is only moved to follow the trip
 *     while it still says what this package last set.
 *   - **Only open tasks are touched**, and removing a flight or a trip removes
 *     only its tasks that are still to do. A finished one is a record.
 *
 * Delays do not move "leave for the airport". Airlines close bag drop by the
 * timetable however late the plane is, and a reminder that slid later with
 * every delay would be the app talking you into missing it. A change to the
 * *timetable* (the airline retiming the flight) moves it.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db, tasks } from '@everything/server/module-api';
import { addDays, endOfLocalDay, localDate, mayMoveDue, spacedFlightNumber } from './rules.js';
import { tripSpan, type ChecklistItem, type Flight, type Settings, type Store, type TaskLink, type Trip } from './store.js';

const SOURCE = 'trips';
/** Still to do. `done` and `dropped` are decisions, and a decision is not moved or deleted. */
const OPEN = ['todo', 'doing'];
const MINUTE = 60_000;

/** Whether two airports are in different countries, which is what decides the lead time. */
export const isInternational = (f: Flight) => Boolean(f.from.country && f.to.country && f.from.country !== f.to.country);

function flightNotes(f: Flight, trip: Trip): string {
  return [
    `${trip.name}`,
    `${f.from.iata} → ${f.to.iata}`,
    f.confirmation ? `confirmation ${f.confirmation}` : null,
    f.seat ? `seat ${f.seat}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

interface Wanted {
  link: TaskLink;
  enabled: boolean;
  title: string;
  notes: string;
  due: number | null;
  allDay: boolean;
}

function wantedFor(trip: Trip, settings: Settings, now: number): Wanted[] {
  const out: Wanted[] = [];
  for (const f of trip.flights) {
    // A flight already gone has nothing left to remind you of.
    const ahead = f.departs > now;
    const name = spacedFlightNumber(f.number);
    out.push({
      link: f.tasks.checkIn,
      enabled: settings.checkInTask && ahead,
      title: `Check in for ${name} to ${f.to.city || f.to.iata}`,
      notes: flightNotes(f, trip),
      due: f.departs - settings.checkInHours * 60 * MINUTE,
      allDay: false,
    });
    const lead = isInternational(f) ? settings.leaveInternationalMinutes : settings.leaveDomesticMinutes;
    out.push({
      link: f.tasks.leave,
      enabled: settings.leaveTask && ahead,
      title: `Leave for ${f.from.iata} airport (${name})`,
      notes: flightNotes(f, trip),
      due: f.departs - lead * MINUTE,
      allDay: false,
    });
  }
  const { start } = tripSpan(trip, localDate);
  for (const item of trip.checklist) out.push(checklistWant(item, trip, start));
  return out;
}

function checklistWant(item: ChecklistItem, trip: Trip, start: string | null): Wanted {
  const day = start !== null && item.offsetDays !== null ? addDays(start, item.offsetDays) : null;
  return {
    link: item.task,
    enabled: true,
    title: item.text,
    notes: trip.name,
    due: day ? endOfLocalDay(day) : null,
    allDay: day !== null,
  };
}

/**
 * Make the tasks that should exist and move the ones that should move.
 *
 * Mutates the links in `store` and returns whether any task changed, so the
 * caller writes the store once and announces once.
 */
export async function syncTasks(store: Store, now = Date.now()): Promise<boolean> {
  const wants = store.trips.flatMap((t) => wantedFor(t, store.settings, now));
  const ids = wants.map((w) => w.link.id).filter((id): id is string => Boolean(id));
  const existing = ids.length ? await db.select().from(tasks).where(inArray(tasks.id, ids)) : [];
  const byId = new Map(existing.map((t) => [t.id, t]));
  let changed = false;

  for (const w of wants) {
    if (!w.link.made) {
      if (!w.enabled) continue;
      const [row] = await db
        .insert(tasks)
        .values({ title: w.title, notes: w.notes, dueAt: w.due, dueIsAllDay: w.allDay ? 1 : 0, source: SOURCE })
        .returning();
      w.link.made = true;
      w.link.id = row?.id ?? null;
      w.link.due = w.due;
      changed = true;
      continue;
    }
    if (!w.link.id) continue;
    const task = byId.get(w.link.id);
    if (!task) {
      // Deleted by hand: remember that it was, and never make it again.
      w.link.id = null;
      changed = true;
      continue;
    }
    if (!OPEN.includes(task.status) || w.due === (w.link.due ?? null)) continue;
    if (mayMoveDue(task.dueAt, w.link.due)) {
      await db
        .update(tasks)
        .set({ dueAt: w.due, dueIsAllDay: w.allDay ? 1 : 0, updatedAt: now })
        .where(eq(tasks.id, task.id));
      changed = true;
    }
    // Recorded either way: once you have moved it, the trip moving again is not a reason to.
    w.link.due = w.due;
    changed = true;
  }
  return changed;
}

/** Every task link a trip, a flight or an item holds. */
export function linksOf(thing: Trip | Flight | ChecklistItem): TaskLink[] {
  if ('flights' in thing) return [...thing.flights.flatMap(linksOf), ...thing.checklist.flatMap(linksOf)];
  if ('tasks' in thing) return [thing.tasks.checkIn, thing.tasks.leave];
  return [thing.task];
}

/** Remove the tasks still to do; leave finished ones as the record they are. */
export async function dropTasks(links: TaskLink[]): Promise<boolean> {
  const ids = links.map((l) => l.id).filter((id): id is string => Boolean(id));
  if (ids.length === 0) return false;
  await db.delete(tasks).where(and(inArray(tasks.id, ids), inArray(tasks.status, OPEN)));
  return true;
}

export const emptyLink = (): TaskLink => ({ made: false, id: null });
