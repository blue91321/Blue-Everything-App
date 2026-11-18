/**
 * Events as the occurrences a screen draws and a reminder is about. Pure:
 * the store's types only, so `calendar-check` asserts it.
 */
import { occurrenceStarts } from './recur.js';
import { addDays, dateOf, daysBetween, DAY, instantOf, MINUTE, wallAt } from './time.js';
import type { CalEvent, Calendar, ReminderPrefs } from './store.js';

export interface Occurrence {
  /** `<event id>|<start wall>`: one occurrence of one event, the same however the window is drawn. */
  key: string;
  eventId: string;
  calendarId: string;
  title: string;
  location: string | null;
  notes: string | null;
  allDay: boolean;
  /** Walls in the event's zone. All day: the first day, and the day after the last. */
  start: string;
  end: string;
  /** The instants it runs between (all day: midnight to midnight in its zone). */
  startMs: number;
  endMs: number;
  color: string;
  readOnly: boolean;
  repeating: boolean;
  /** The reminder offsets that apply to it, worked out (event, else calendar, else the app's). */
  remind: number[];
}

/** Which offsets remind about an event: its own, else its calendar's, else the app's for its kind. None while reminders are off. */
export function offsetsFor(ev: Pick<CalEvent, 'remind' | 'allDay'>, cal: Pick<Calendar, 'remind'> | undefined, prefs: ReminderPrefs): number[] {
  if (!prefs.enabled) return [];
  return ev.remind ?? cal?.remind ?? (ev.allDay ? prefs.allDay : prefs.timed);
}

/** When an offset reminds: minutes before the start, or for an all-day event before midnight on its day (negative: after). */
export const remindAt = (o: Pick<Occurrence, 'startMs'>, offset: number): number => o.startMs - offset * MINUTE;

/**
 * Every occurrence of these events that overlaps the window, sorted by start.
 * Hidden calendars are left out unless asked for.
 */
export function occurrencesIn(events: CalEvent[], calendars: Calendar[], prefs: ReminderPrefs, fromMs: number, toMs: number, includeHidden = false): Occurrence[] {
  const byId = new Map(calendars.map((c) => [c.id, c]));
  const out: Occurrence[] = [];
  for (const ev of events) {
    const cal = byId.get(ev.calendarId);
    if (!cal || (cal.hidden && !includeHidden)) continue;
    // Dates are walked in the event's zone, a day past the window either way.
    const lastDate = addDays(dateOf(wallAt(toMs, ev.tz)), 1);
    const firstDate = addDays(dateOf(wallAt(fromMs, ev.tz)), -1);
    const startMs0 = instantOf(ev.start, ev.tz);
    const endMs0 = instantOf(ev.end, ev.tz);
    if (startMs0 === null || endMs0 === null) continue;
    const lengthMs = Math.max(0, endMs0 - startMs0);
    const lengthDays = Math.max(1, daysBetween(ev.start, ev.end));
    const remind = offsetsFor(ev, cal, prefs);
    for (const start of occurrenceStarts(ev, lastDate)) {
      // A long event can start before the window and run into it, so only those ending before the window's first day are passed over cheaply.
      if (ev.allDay ? addDays(start, lengthDays) < firstDate : dateOf(start) < addDays(firstDate, -Math.ceil(lengthMs / DAY))) continue;
      const startMs = instantOf(start, ev.tz);
      if (startMs === null) continue;
      const end = ev.allDay ? addDays(start, lengthDays) : wallAt(startMs + lengthMs, ev.tz);
      const endMs = ev.allDay ? (instantOf(end, ev.tz) ?? startMs + lengthDays * DAY) : startMs + lengthMs;
      // Overlaps the window; one with no length counts while it is inside it.
      if (!(endMs > fromMs || (endMs === startMs && startMs >= fromMs)) || startMs >= toMs) continue;
      out.push({
        key: `${ev.id}|${start}`,
        eventId: ev.id,
        calendarId: ev.calendarId,
        title: ev.title,
        location: ev.location,
        notes: ev.notes,
        allDay: ev.allDay,
        start,
        end,
        startMs,
        endMs,
        color: cal.color,
        readOnly: cal.kind !== 'own',
        repeating: ev.repeat !== null,
        remind,
      });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs || Number(b.allDay) - Number(a.allDay) || a.title.localeCompare(b.title));
}
