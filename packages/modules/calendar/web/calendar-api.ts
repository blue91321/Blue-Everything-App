/**
 * The calendar screen's client, and the dates and words it shows.
 *
 * Events are shown in **this device's** zone: a meeting at 3pm in New York is
 * at noon on a phone in California, as every calendar app shows it. An
 * all-day event is a date, the same date everywhere. A new event is made in
 * this device's zone, which is what "3pm" meant when you typed it.
 */
import { apiRequest } from '@app/api';

export type Freq = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface ByDay {
  day: number;
  n?: number;
}

export interface Repeat {
  freq: Freq;
  interval: number;
  byDay?: ByDay[];
  byMonthDay?: number[];
  byMonth?: number[];
  count?: number | null;
  until?: string | null;
}

export interface CalendarInfo {
  id: string;
  name: string;
  color: string;
  kind: 'own' | 'link';
  /** The link with its secret part hidden. */
  link: string | null;
  fetchedAt: number | null;
  error: string | null;
  hidden: boolean;
  remind: number[] | null;
  events: number;
}

export interface Occurrence {
  key: string;
  eventId: string;
  calendarId: string;
  title: string;
  location: string | null;
  notes: string | null;
  allDay: boolean;
  start: string;
  end: string;
  startMs: number;
  endMs: number;
  color: string;
  readOnly: boolean;
  repeating: boolean;
  remind: number[];
}

export interface Reminders {
  asked: boolean;
  enabled: boolean;
  timed: number[];
  allDay: number[];
}

export interface CalEvent {
  id: string;
  calendarId: string;
  uid: string;
  title: string;
  location: string | null;
  notes: string | null;
  allDay: boolean;
  start: string;
  end: string;
  tz: string;
  repeat: Repeat | null;
  skip: string[];
  remind: number[] | null;
  readOnly?: boolean;
}

/** A task with a due date, shown beside the events (`server/tasks.ts`). Canvas assignments are these. */
export interface DueTask {
  id: string;
  title: string;
  dueAt: number;
  allDay: boolean;
  /** The day it is due, for one due on a day. */
  date: string;
  done: boolean;
  source: string | null;
  sourceUrl: string | null;
  notes: string | null;
}

/** Which tasks the calendar shows: every one with a due date, only those from a service, or none. */
export type TaskLayer = 'all' | 'synced' | 'none';

export interface CalendarState {
  zone: string;
  calendars: CalendarInfo[];
  occurrences: Occurrence[];
  reminders: Reminders;
  /** Missing from a server older than the task layer. */
  due?: DueTask[];
  taskLayer?: TaskLayer;
}

export interface ImportPreview {
  name: string | null;
  events: number;
  repeating: number;
  first: string | null;
  last: string | null;
  sample: { title: string; start: string; allDay: boolean }[];
  problems: string[];
}

export type Scope = 'one' | 'following' | 'all';

export interface EventDraft {
  calendarId?: string;
  title: string;
  location: string | null;
  notes: string | null;
  allDay: boolean;
  start: string;
  end: string;
  tz: string;
  repeat: Repeat | null;
  remind: number[] | null;
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
const q = (scope?: Scope, occurrence?: string) => (scope ? `?scope=${scope}${occurrence ? `&occurrence=${encodeURIComponent(occurrence)}` : ''}` : '');

export const calendar = {
  get: (from: number, to: number) => apiRequest<CalendarState>(`/api/calendar?from=${from}&to=${to}`),
  upcoming: (days: number, from?: number) =>
    apiRequest<{ occurrences: Occurrence[]; reminders: Reminders; calendars: number; due?: DueTask[]; taskLayer?: TaskLayer }>(
      `/api/calendar/upcoming?days=${days}${from ? `&from=${from}` : ''}`
    ),
  setTaskLayer: (layer: TaskLayer) => apiRequest<{ taskLayer: TaskLayer }>('/api/calendar/task-layer', { method: 'PUT', ...json({ layer }) }),
  event: (id: string) => apiRequest<CalEvent>(`/api/calendar/events/${encodeURIComponent(id)}`),
  addEvent: (draft: EventDraft) => apiRequest<CalEvent>('/api/calendar/events', { method: 'POST', ...json(draft) }),
  saveEvent: (id: string, patch: Partial<EventDraft>, scope?: Scope, occurrence?: string) =>
    apiRequest<CalEvent>(`/api/calendar/events/${encodeURIComponent(id)}${q(scope, occurrence)}`, { method: 'PUT', ...json(patch) }),
  deleteEvent: (id: string, scope?: Scope, occurrence?: string) =>
    apiRequest<{ ok: true }>(`/api/calendar/events/${encodeURIComponent(id)}${q(scope, occurrence)}`, { method: 'DELETE' }),
  addCalendar: (name: string, color?: string) => apiRequest<CalendarInfo>('/api/calendar/calendars', { method: 'POST', ...json({ name, color }) }),
  saveCalendar: (id: string, patch: { name?: string; color?: string; hidden?: boolean; remind?: number[] | null }) =>
    apiRequest<CalendarInfo>(`/api/calendar/calendars/${encodeURIComponent(id)}`, { method: 'PUT', ...json(patch) }),
  deleteCalendar: (id: string) => apiRequest<{ ok: true }>(`/api/calendar/calendars/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  addLink: (url: string, name?: string) => apiRequest<{ calendar: CalendarInfo; problems: string[] }>('/api/calendar/links', { method: 'POST', ...json({ url, name }) }),
  refresh: (id: string) => apiRequest<CalendarInfo>(`/api/calendar/calendars/${encodeURIComponent(id)}/refresh`, { method: 'POST' }),
  preview: (text: string) => apiRequest<ImportPreview>('/api/calendar/import', { method: 'POST', ...json({ text }) }),
  importFile: (text: string, into: string, name?: string) =>
    apiRequest<{ calendar: CalendarInfo; added: number; updated: number; removed: number; problems: string[] }>('/api/calendar/import', {
      method: 'POST',
      ...json({ text, into, name, commit: true }),
    }),
  setReminders: (patch: Partial<Reminders>) => apiRequest<Reminders>('/api/calendar/reminders', { method: 'PUT', ...json(patch) }),
};

/* ---- dates on this device ---- */

export const pad = (n: number) => String(n).padStart(2, '0');
/** A local Date as "YYYY-MM-DD". */
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** "YYYY-MM-DD" as a local Date at midnight. */
export const fromKey = (key: string) => new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));
export const addDaysKey = (key: string, n: number) => {
  const d = fromKey(key);
  d.setDate(d.getDate() + n);
  return dayKey(d);
};
/** This device's zone. */
export const deviceZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};
/** An instant as a local wall, "YYYY-MM-DDTHH:MM". */
export const localWall = (at: number) => {
  const d = new Date(at);
  return `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** The local days an occurrence covers, as keys: an all-day one by its dates, a timed one by when it runs here. */
export function daysOf(o: Occurrence): string[] {
  const out: string[] = [];
  if (o.allDay) {
    for (let k = o.start; k < o.end && out.length < 400; k = addDaysKey(k, 1)) out.push(k);
    return out.length ? out : [o.start];
  }
  const first = dayKey(new Date(o.startMs));
  // An event ending exactly at midnight does not spill into the next day.
  const last = dayKey(new Date(Math.max(o.startMs, o.endMs - 1)));
  for (let k = first; k <= last && out.length < 400; k = addDaysKey(k, 1)) out.push(k);
  return out;
}

/** The day a task is due on this device: its date when due on a day, else where its instant falls here. */
export const dueDay = (t: DueTask): string => (t.allDay ? t.date : dayKey(new Date(t.dueAt)));

/** Tasks are drawn in one colour, the calendars' amber, so they read as one layer whatever the calendars are. */
export const TASK_COLOR = '#c69026';

/** "Canvas" for `canvas`: the slug is opaque, so this only capitalises it. */
export const sourceName = (source: string | null): string | null => (source ? source.charAt(0).toUpperCase() + source.slice(1) : null);

export const timeText = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** "9:30 – 10:00 AM", "All day", or for one that spans days, where it starts or ends on this day. */
export function whenOn(o: Occurrence, day: string): string {
  if (o.allDay) return 'All day';
  const startDay = dayKey(new Date(o.startMs));
  const endDay = dayKey(new Date(Math.max(o.startMs, o.endMs - 1)));
  if (startDay !== endDay) {
    if (day === startDay) return `from ${timeText(o.startMs)}`;
    if (day === endDay) return `until ${timeText(o.endMs)}`;
    return 'All day';
  }
  return o.endMs > o.startMs ? `${timeText(o.startMs)} – ${timeText(o.endMs)}` : timeText(o.startMs);
}

export const dayTitle = (key: string, today: string) => {
  const label = fromKey(key).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  if (key === today) return `Today · ${label}`;
  if (key === addDaysKey(today, 1)) return `Tomorrow · ${label}`;
  if (key === addDaysKey(today, -1)) return `Yesterday · ${label}`;
  return label;
};

/* ---- reminders in words ---- */

/** The choices offered for an event at a time, in minutes before. */
export const TIMED_CHOICES = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080];
/** For an all-day event: minutes before midnight on its day; negative is that long after. */
export const ALL_DAY_CHOICES = [-480, -540, -720, 360, 900, 9540];

export function offsetText(offset: number, allDay: boolean): string {
  if (allDay) {
    if (offset <= 0) {
      const at = -offset;
      return `${clock(at)} on the day`;
    }
    const days = Math.ceil(offset / 1440);
    const at = days * 1440 - offset;
    return `${days === 1 ? 'The day before' : days === 7 ? 'A week before' : `${days} days before`} at ${clock(at)}`;
  }
  if (offset === 0) return 'When it starts';
  if (offset < 60) return `${offset} minutes before`;
  if (offset < 1440) return offset === 60 ? '1 hour before' : `${offset / 60} hours before`;
  if (offset === 10080) return '1 week before';
  return offset === 1440 ? '1 day before' : `${offset / 1440} days before`;
}

function clock(minuteOfDay: number): string {
  const d = new Date(2000, 0, 1, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/* ---- repeats in words ---- */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ORDINAL = ['', 'first', 'second', 'third', 'fourth', 'fifth'];

export function repeatText(r: Repeat | null, start: string): string {
  if (!r) return 'Does not repeat';
  const every = (unit: string) => (r.interval > 1 ? `Every ${r.interval} ${unit}s` : `Every ${unit}`);
  let text: string;
  switch (r.freq) {
    case 'daily':
      text = r.interval > 1 ? every('day') : 'Every day';
      break;
    case 'weekly': {
      const days = (r.byDay?.length ? r.byDay.map((b) => b.day) : [fromKey(start.slice(0, 10)).getDay()]).sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
      const names = days.length === 5 && !days.includes(0) && !days.includes(6) ? 'weekdays' : days.map((d) => WEEKDAYS[d]!.slice(0, 3)).join(', ');
      text = `${every('week')} on ${names}`;
      break;
    }
    case 'monthly': {
      const by = r.byDay?.[0];
      text =
        by && by.n
          ? `${every('month')} on the ${by.n === -1 ? 'last' : (ORDINAL[by.n] ?? `${by.n}th`)} ${WEEKDAYS[by.day]}`
          : r.byMonthDay?.[0] === -1
            ? `${every('month')} on the last day`
            : `${every('month')} on the ${ordinalDay(r.byMonthDay?.[0] ?? Number(start.slice(8, 10)))}`;
      break;
    }
    case 'yearly':
      text = `${every('year')} on ${fromKey(start.slice(0, 10)).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}`;
      break;
  }
  if (r.count) text += `, ${r.count} times`;
  else if (r.until) text += `, until ${fromKey(r.until.slice(0, 10)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  return text;
}

const ordinalDay = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

/** Which week of its month a date is in (1–5), and whether it is the last such weekday. */
export function weekOfMonth(key: string): { n: number; last: boolean } {
  const d = fromKey(key);
  const n = Math.ceil(d.getDate() / 7);
  const next = new Date(d);
  next.setDate(d.getDate() + 7);
  return { n, last: next.getMonth() !== d.getMonth() };
}

export const WEEKDAY_NAMES = WEEKDAYS;
export const ordinal = (n: number) => (n === -1 ? 'last' : (ORDINAL[n] ?? `${n}th`));
