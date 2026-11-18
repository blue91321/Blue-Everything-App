/**
 * Putting what a file said into a calendar, matched by each event's UID. Pure,
 * so `calendar-check` asserts it.
 *
 * - **A link's refresh replaces** the calendar's events with the file's, but
 *   an event still in the file keeps its id, and with it the reminders already
 *   raised for it and any reminder times you gave it here.
 * - **An import merges** into one of your own calendars: an event whose UID is
 *   already there is updated, a new one added, and nothing else touched, so
 *   importing the same file twice changes nothing the second time.
 */
import type { ParsedEvent } from './ics.js';
import type { CalEvent } from './store.js';

export interface MergeCount {
  added: number;
  updated: number;
  removed: number;
}

const same = (a: CalEvent, b: CalEvent): boolean =>
  a.title === b.title &&
  a.location === b.location &&
  a.notes === b.notes &&
  a.allDay === b.allDay &&
  a.start === b.start &&
  a.end === b.end &&
  a.tz === b.tz &&
  JSON.stringify(a.repeat) === JSON.stringify(b.repeat) &&
  JSON.stringify(a.skip) === JSON.stringify(b.skip);

export function mergeEvents(
  events: CalEvent[],
  calendarId: string,
  parsed: ParsedEvent[],
  mode: 'replace' | 'merge',
  newId: () => string
): { events: CalEvent[]; count: MergeCount; changed: string[] } {
  const mine = events.filter((e) => e.calendarId === calendarId);
  const others = events.filter((e) => e.calendarId !== calendarId);
  const byUid = new Map(mine.map((e) => [e.uid, e]));
  const count: MergeCount = { added: 0, updated: 0, removed: 0 };
  const seen = new Set<string>();
  const next: CalEvent[] = [];
  /** Ids of events that changed or went, whose waiting reminders are taken back. */
  const changed: string[] = [];
  for (const p of parsed) {
    if (seen.has(p.uid)) continue;
    seen.add(p.uid);
    const old = byUid.get(p.uid);
    const ev: CalEvent = {
      id: old?.id ?? newId(),
      calendarId,
      uid: p.uid,
      title: p.title,
      location: p.location,
      notes: p.notes,
      allDay: p.allDay,
      start: p.start,
      end: p.end,
      tz: p.tz,
      repeat: p.repeat,
      skip: p.skip,
      remind: old?.remind ?? null,
    };
    if (!old) count.added += 1;
    else if (!same(old, ev)) {
      count.updated += 1;
      changed.push(old.id);
    }
    next.push(ev);
  }
  if (mode === 'merge') {
    for (const e of mine) if (!seen.has(e.uid)) next.push(e);
  } else {
    const gone = mine.filter((e) => !seen.has(e.uid));
    count.removed = gone.length;
    changed.push(...gone.map((e) => e.id));
  }
  return { events: [...others, ...next], count, changed };
}
