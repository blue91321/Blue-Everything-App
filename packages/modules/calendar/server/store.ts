/**
 * Calendars and events, on disk: `data/calendar.json`.
 *
 * A package cannot add a table, so this is a file, as Trips' is, and for
 * Trips' reason it is not a cache: your own events are typed, so a file that
 * will not parse is refused rather than read as empty and then saved over.
 * Written to a temporary file and renamed into place.
 *
 * A linked calendar's events are kept here too, as fetched, so the calendar
 * still shows with the link unreachable (and with the PC offline from the
 * internet), and saying when they were fetched is honest about their age.
 */
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { dataDir, writeFileAtomic } from '@everything/server/module-api';
import { cleanRepeat, type Repeat } from './recur.js';
import { DATE, DATETIME, isZone } from './time.js';

export const STORE_FILE = join(dataDir, 'calendar.json');

export interface Calendar {
  id: string;
  name: string;
  /** A hex colour, `#rrggbb`. */
  color: string;
  /** Yours to edit, or fetched from a link and read-only. */
  kind: 'own' | 'link';
  /** The link, for `kind: 'link'`. Never sent back to a browser in full: it is a secret. */
  url: string | null;
  fetchedAt: number | null;
  /** When it was last asked for, answered or not: what the next refresh counts from, so a link that keeps failing is not asked every second. */
  triedAt: number | null;
  /** Why the last fetch failed, kept beside the events it could not replace. */
  error: string | null;
  /** Left off the screen and out of reminders. */
  hidden: boolean;
  /** Minutes before each event, for this calendar; null to follow the app-wide default. */
  remind: number[] | null;
}

export interface CalEvent {
  id: string;
  calendarId: string;
  /** The file's UID, which an import or a refresh matches on. Your own events have their own. */
  uid: string;
  title: string;
  location: string | null;
  notes: string | null;
  allDay: boolean;
  /** Walls in `tz`: "YYYY-MM-DD" all day, "YYYY-MM-DDTHH:MM" at a time. An all-day end is the day after the last. */
  start: string;
  end: string;
  tz: string;
  repeat: Repeat | null;
  /** Starts of occurrences taken out. */
  skip: string[];
  /** Minutes before the start to be reminded (negative: after midnight on the day, for an all-day event); null to follow the calendar. */
  remind: number[] | null;
}

export interface ReminderPrefs {
  /** Whether the question has been put (onboarding, or the first visit to the calendar). */
  asked: boolean;
  enabled: boolean;
  /** Minutes before an event at a time. */
  timed: number[];
  /** For an all-day event: minutes before midnight on its day, negative for that many after (−540 is 9:00 on the day). */
  allDay: number[];
}

export interface Store {
  calendars: Calendar[];
  events: CalEvent[];
  reminders: ReminderPrefs;
  /** Reminders already raised, by `<occurrence key>|<offset>`, so a restart does not raise them again; the nudge, so an edit can take it back. */
  raised: Record<string, Raised>;
}

export interface Raised {
  /** When it was due to remind. */
  at: number;
  nudge: string | null;
}

export const DEFAULT_REMINDERS: ReminderPrefs = { asked: false, enabled: true, timed: [15], allDay: [-540] };

export const COLORS = ['#4f8cff', '#e5534b', '#57ab5a', '#c69026', '#a371f7', '#39c5cf', '#e0823d', '#d16ba5'];

export class StoreUnreadable extends Error {}

export const newId = (): string => randomUUID();

/** Reminder offsets read back defensively: whole minutes, up to four weeks either way, at most five. */
export function cleanOffsets(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const out = [...new Set(raw.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)).map((n) => Math.round(n)))]
    .filter((n) => n >= -24 * 60 && n <= 28 * 24 * 60)
    .sort((a, b) => a - b);
  return out.slice(0, 5);
}

export function cleanReminders(raw: Partial<ReminderPrefs> | undefined): ReminderPrefs {
  const r = raw ?? {};
  return {
    asked: r.asked === true,
    enabled: r.enabled !== false,
    timed: cleanOffsets(r.timed) ?? DEFAULT_REMINDERS.timed,
    allDay: cleanOffsets(r.allDay) ?? DEFAULT_REMINDERS.allDay,
  };
}

const isColor = (c: unknown): c is string => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

function cleanCalendar(raw: Partial<Calendar>, i: number): Calendar | null {
  if (typeof raw.id !== 'string') return null;
  return {
    id: raw.id,
    name: text(raw.name, 100) ?? 'Calendar',
    color: isColor(raw.color) ? raw.color : COLORS[i % COLORS.length]!,
    kind: raw.kind === 'link' ? 'link' : 'own',
    url: raw.kind === 'link' ? text(raw.url, 2000) : null,
    fetchedAt: typeof raw.fetchedAt === 'number' ? raw.fetchedAt : null,
    triedAt: typeof raw.triedAt === 'number' ? raw.triedAt : null,
    error: text(raw.error, 500),
    hidden: raw.hidden === true,
    remind: raw.remind === null || raw.remind === undefined ? null : cleanOffsets(raw.remind),
  };
}

/** An event as checked, from the file or from a screen. Null when it is not one. */
export function cleanEvent(raw: Partial<CalEvent>): CalEvent | null {
  if (typeof raw.id !== 'string' || typeof raw.calendarId !== 'string') return null;
  const allDay = raw.allDay === true;
  const shape = allDay ? DATE : DATETIME;
  if (typeof raw.start !== 'string' || !shape.test(raw.start)) return null;
  let end = typeof raw.end === 'string' && shape.test(raw.end) && raw.end >= raw.start ? raw.end : raw.start;
  if (allDay && end <= raw.start) end = nextDay(raw.start);
  return {
    id: raw.id,
    calendarId: raw.calendarId,
    uid: text(raw.uid, 500) ?? raw.id,
    title: text(raw.title, 300) ?? '(no title)',
    location: text(raw.location, 500),
    notes: text(raw.notes, 10_000),
    allDay,
    start: raw.start,
    end,
    tz: typeof raw.tz === 'string' && isZone(raw.tz) ? raw.tz : 'UTC',
    repeat: cleanRepeat(raw.repeat),
    skip: Array.isArray(raw.skip) ? raw.skip.filter((s): s is string => typeof s === 'string' && (DATE.test(s) || DATETIME.test(s))).slice(0, 5000) : [],
    remind: raw.remind === null || raw.remind === undefined ? null : cleanOffsets(raw.remind),
  };
}

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const EMPTY = (): Store => ({
  // A fixed id, so the calendar a screen saw before anything was ever saved is still the one there.
  calendars: [{ id: 'mine', name: 'My calendar', color: COLORS[0]!, kind: 'own', url: null, fetchedAt: null, triedAt: null, error: null, hidden: false, remind: null }],
  events: [],
  reminders: { ...DEFAULT_REMINDERS },
  raised: {},
});

export function read(): Store {
  if (!existsSync(STORE_FILE)) return EMPTY();
  let parsed: Partial<Store>;
  try {
    const raw = readFileSync(STORE_FILE, 'utf8');
    parsed = JSON.parse(raw.startsWith('﻿') ? raw.slice(1) : raw) as Partial<Store>;
  } catch (error) {
    throw new StoreUnreadable(`data/calendar.json could not be read (${(error as Error).message}). Nothing has been changed; fix the file or move it aside to start again.`);
  }
  const calendars = (Array.isArray(parsed.calendars) ? parsed.calendars : []).map(cleanCalendar).filter((c): c is Calendar => c !== null);
  if (!calendars.some((c) => c.kind === 'own')) calendars.unshift(EMPTY().calendars[0]!);
  const ids = new Set(calendars.map((c) => c.id));
  const events = (Array.isArray(parsed.events) ? parsed.events : []).map(cleanEvent).filter((e): e is CalEvent => e !== null && ids.has(e.calendarId));
  const raised: Record<string, Raised> = {};
  if (parsed.raised && typeof parsed.raised === 'object') {
    for (const [k, v] of Object.entries(parsed.raised)) {
      if (v && typeof v === 'object' && typeof (v as Raised).at === 'number')
        raised[k] = { at: (v as Raised).at, nudge: typeof (v as Raised).nudge === 'string' ? (v as Raised).nudge : null };
    }
  }
  return { calendars, events, reminders: cleanReminders(parsed.reminders), raised };
}

export function write(next: Store): void {
  writeFileAtomic(STORE_FILE, `${JSON.stringify(next)}\n`);
}

/** The calendar your own events go in when none is named: the first of your own. */
export const defaultCalendar = (store: Store): Calendar => store.calendars.find((c) => c.kind === 'own')!;
