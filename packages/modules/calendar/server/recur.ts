/**
 * Repeating events: which days a rule lands on. No imports but `time.ts`, so
 * `calendar-check` asserts it.
 *
 * The rule is RFC 5545's RRULE, as far as calendars actually use it:
 * FREQ (daily, weekly, monthly, yearly), INTERVAL, COUNT, UNTIL, BYDAY (with an
 * ordinal, "2MO", "-1FR", in a month or a year), BYMONTHDAY (negative from the
 * end) and BYMONTH. What is left out (BYSETPOS, BYWEEKNO, BYYEARDAY, BYHOUR
 * and the rest, hourly and finer) is rare in a personal calendar; the reader
 * says when a file used it (`ics.ts`).
 *
 * Days are worked out as dates and the event's own time put on each, so a
 * weekly 3pm meeting is at 3pm in its zone on every one of them, clock changes
 * included. Weeks start on Monday, RFC 5545's default.
 */
import { addDays, dateOf, daysInMonth, timeOf, weekday, ymd } from './time.js';

export type Freq = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface ByDay {
  /** 0 for Sunday to 6 for Saturday. */
  day: number;
  /** The nth such day in the month (or year): 2 is the second, -1 the last. Absent for every one. */
  n?: number;
}

export interface Repeat {
  freq: Freq;
  /** Every how many days, weeks, months or years. */
  interval: number;
  byDay?: ByDay[];
  byMonthDay?: number[];
  /** 1 to 12. */
  byMonth?: number[];
  /** How many occurrences in all, the first included. */
  count?: number | null;
  /** The last day it may land on, inclusive: a date, or a wall clock in the event's zone. */
  until?: string | null;
}

export interface Recurring {
  /** The first occurrence's start: "YYYY-MM-DD" all day, "YYYY-MM-DDTHH:MM" at a time. */
  start: string;
  repeat: Repeat | null;
  /** Starts of occurrences taken out (a cancelled one, or one moved to an event of its own). */
  skip?: string[];
}

/** Past this many occurrences or periods, stop looking: a rule that has run for decades is still bounded. */
const MAX_PERIODS = 50_000;
const MAX_OCCURRENCES = 20_000;

/** Monday of the week a date is in. */
const mondayOf = (date: string): string => addDays(date, -((weekday(date) + 6) % 7));

/** The days a month offers the rule. */
function daysInMonthFor(year: number, month: number, rule: Repeat, startDay: number): number[] {
  const dim = daysInMonth(year, month);
  const byMonthDay = rule.byMonthDay?.length ? rule.byMonthDay.map((d) => (d > 0 ? d : dim + d + 1)).filter((d) => d >= 1 && d <= dim) : null;
  let byDay: number[] | null = null;
  if (rule.byDay?.length) {
    const days = new Set<number>();
    const firstWeekday = weekday(ymd(year, month, 1));
    for (const bd of rule.byDay) {
      const first = 1 + ((bd.day - firstWeekday + 7) % 7);
      if (bd.n === undefined || bd.n === 0) {
        for (let d = first; d <= dim; d += 7) days.add(d);
      } else if (bd.n > 0) {
        const d = first + (bd.n - 1) * 7;
        if (d <= dim) days.add(d);
      } else {
        const last = first + Math.floor((dim - first) / 7) * 7;
        const d = last + (bd.n + 1) * 7;
        if (d >= 1) days.add(d);
      }
    }
    byDay = [...days];
  }
  if (byMonthDay && byDay) return byMonthDay.filter((d) => byDay!.includes(d));
  if (byMonthDay) return byMonthDay;
  if (byDay) return byDay;
  return startDay <= dim ? [startDay] : [];
}

/** The dates one period of the rule offers, unsorted, before the start and the end are applied. */
function candidates(rule: Repeat, period: number, startDate: string): string[] {
  const step = Math.max(1, rule.interval) * period;
  const sy = Number(startDate.slice(0, 4));
  const sm = Number(startDate.slice(5, 7));
  const sd = Number(startDate.slice(8, 10));
  const inMonths = (d: string) => !rule.byMonth?.length || rule.byMonth.includes(Number(d.slice(5, 7)));
  switch (rule.freq) {
    case 'daily': {
      const d = addDays(startDate, step);
      const okDay = !rule.byDay?.length || rule.byDay.some((b) => b.day === weekday(d));
      const okMonthDay = !rule.byMonthDay?.length || rule.byMonthDay.includes(Number(d.slice(8, 10)));
      return okDay && okMonthDay && inMonths(d) ? [d] : [];
    }
    case 'weekly': {
      const monday = addDays(mondayOf(startDate), step * 7);
      const wanted = rule.byDay?.length ? rule.byDay.map((b) => b.day) : [weekday(startDate)];
      const out: string[] = [];
      for (let i = 0; i < 7; i++) {
        const d = addDays(monday, i);
        if (wanted.includes(weekday(d)) && inMonths(d)) out.push(d);
      }
      return out;
    }
    case 'monthly': {
      const index = sm - 1 + step;
      const year = sy + Math.floor(index / 12);
      const month = (index % 12) + 1;
      if (rule.byMonth?.length && !rule.byMonth.includes(month)) return [];
      return daysInMonthFor(year, month, rule, sd).map((d) => ymd(year, month, d));
    }
    case 'yearly': {
      const year = sy + step;
      const months = rule.byMonth?.length ? rule.byMonth : [sm];
      return months.flatMap((month) => daysInMonthFor(year, month, rule, sd).map((d) => ymd(year, month, d)));
    }
  }
}

/** The first date a period could offer, to know when every later one is past the window. */
function periodStart(rule: Repeat, period: number, startDate: string): string {
  const step = Math.max(1, rule.interval) * period;
  switch (rule.freq) {
    case 'daily':
      return addDays(startDate, step);
    case 'weekly':
      return addDays(mondayOf(startDate), step * 7);
    case 'monthly': {
      const index = Number(startDate.slice(5, 7)) - 1 + step;
      return ymd(Number(startDate.slice(0, 4)) + Math.floor(index / 12), (index % 12) + 1, 1);
    }
    case 'yearly':
      return ymd(Number(startDate.slice(0, 4)) + step, 1, 1);
  }
}

/** A rule's last wall as comparable with an occurrence's start. */
function untilFor(until: string | null | undefined, allDay: boolean): string | null {
  if (!until) return null;
  if (allDay) return dateOf(until);
  return until.length === 10 ? `${until}T23:59` : until;
}

/**
 * The start of every occurrence that begins on or before `lastDate`, in order,
 * the first one (the event's own start) always included, and taken-out ones
 * left out. COUNT counts the taken-out ones too, as RFC 5545 has it: a
 * cancelled meeting is still one of the ten.
 */
export function occurrenceStarts(ev: Recurring, lastDate: string): string[] {
  const allDay = ev.start.length === 10;
  const startDate = dateOf(ev.start);
  const time = timeOf(ev.start);
  const wallFor = (date: string) => (allDay ? date : `${date}T${time}`);
  const skip = new Set(ev.skip ?? []);
  const out: string[] = [];
  const rule = ev.repeat;
  if (!rule) {
    if (startDate <= lastDate && !skip.has(ev.start)) out.push(ev.start);
    return out;
  }
  const until = untilFor(rule.until, allDay);
  const count = rule.count && rule.count > 0 ? rule.count : null;
  let made = 0;
  // The first occurrence is the event's own start, whether or not the rule would have landed on it.
  const take = (wall: string): boolean => {
    if (until !== null && wall > until) return false;
    made += 1;
    if (!skip.has(wall)) out.push(wall);
    return count === null || made < count;
  };
  if (startDate > lastDate) return out;
  if (!take(ev.start)) return out;
  for (let period = 0; period < MAX_PERIODS && out.length < MAX_OCCURRENCES; period++) {
    if (periodStart(rule, period, startDate) > lastDate) break;
    const dates = [...new Set(candidates(rule, period, startDate))].sort();
    for (const date of dates) {
      if (date <= startDate || date > lastDate) continue;
      const wall = wallFor(date);
      if (until !== null && wall > until) return out;
      if (!take(wall)) return out;
    }
  }
  return out;
}

/* ---- reading and writing the rule as text ---- */

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const FREQS: Record<string, Freq> = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' };

const intList = (value: string, min: number, max: number): number[] =>
  value
    .split(',')
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n !== 0 && Math.abs(n) >= min && Math.abs(n) <= max);

/**
 * An RRULE's text as a `Repeat`, with `until` given back raw for the caller
 * to place in the event's zone. `unsupported` names what was left out, and a
 * rule that cannot be followed at all (hourly) is null.
 */
export function parseRule(text: string): { repeat: Repeat | null; untilRaw: string | null; unsupported: string[] } {
  const parts = new Map<string, string>();
  for (const piece of text.split(';')) {
    const at = piece.indexOf('=');
    if (at > 0) parts.set(piece.slice(0, at).toUpperCase(), piece.slice(at + 1));
  }
  const unsupported = [...parts.keys()].filter((k) => !['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'WKST'].includes(k));
  const freq = FREQS[(parts.get('FREQ') ?? '').toUpperCase()];
  if (!freq) return { repeat: null, untilRaw: null, unsupported: [`FREQ=${parts.get('FREQ') ?? '?'}`] };
  const interval = Math.max(1, Math.min(1000, Number(parts.get('INTERVAL') ?? 1) || 1));
  const repeat: Repeat = { freq, interval };
  const count = Number(parts.get('COUNT'));
  if (Number.isInteger(count) && count > 0) repeat.count = Math.min(count, 100_000);
  const byDay = (parts.get('BYDAY') ?? '')
    .split(',')
    .map((v) => /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(v.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => {
      const bd: ByDay = { day: DAY_CODES.indexOf(m[2]!.toUpperCase()) };
      if (m[1]) bd.n = Number(m[1]);
      return bd;
    });
  if (byDay.length) repeat.byDay = byDay;
  const byMonthDay = intList(parts.get('BYMONTHDAY') ?? '', 1, 31);
  if (byMonthDay.length) repeat.byMonthDay = byMonthDay;
  const byMonth = intList(parts.get('BYMONTH') ?? '', 1, 12).filter((n) => n > 0);
  if (byMonth.length) repeat.byMonth = byMonth;
  return { repeat, untilRaw: parts.get('UNTIL') ?? null, unsupported };
}

/** A `Repeat` as checked and bounded, from anything a screen sent. Null when it is not one. */
export function cleanRepeat(raw: unknown): Repeat | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const freq = typeof r.freq === 'string' && (Object.values(FREQS) as string[]).includes(r.freq) ? (r.freq as Freq) : null;
  if (!freq) return null;
  const interval = Number.isInteger(r.interval) ? Math.max(1, Math.min(1000, r.interval as number)) : 1;
  const out: Repeat = { freq, interval };
  if (Array.isArray(r.byDay)) {
    const days = r.byDay
      .filter((b): b is ByDay => !!b && typeof b === 'object' && Number.isInteger((b as ByDay).day) && (b as ByDay).day >= 0 && (b as ByDay).day <= 6)
      .map((b) => (Number.isInteger(b.n) && b.n !== 0 && Math.abs(b.n!) <= 53 ? { day: b.day, n: b.n } : { day: b.day }));
    if (days.length) out.byDay = days.slice(0, 14);
  }
  if (Array.isArray(r.byMonthDay)) {
    const days = r.byMonthDay.filter((n): n is number => Number.isInteger(n) && n !== 0 && Math.abs(n) <= 31);
    if (days.length) out.byMonthDay = days.slice(0, 31);
  }
  if (Array.isArray(r.byMonth)) {
    const months = r.byMonth.filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= 12);
    if (months.length) out.byMonth = months;
  }
  if (Number.isInteger(r.count) && (r.count as number) > 0) out.count = Math.min(r.count as number, 100_000);
  if (typeof r.until === 'string' && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(r.until)) out.until = r.until;
  return out;
}
