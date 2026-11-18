/**
 * Dates, times and zones, with no imports, so `calendar-check` asserts them.
 *
 * An event is kept as a **wall clock in a zone** ("2026-11-20T15:00" in
 * America/New_York), not as an instant, because that is what a repeating event
 * means: a weekly 3pm meeting is at 3pm on both sides of a clock change, which
 * an instant plus seven days is not. Instants are worked out when they are
 * needed, with `instantOf`.
 *
 * A wall is "YYYY-MM-DD" for an all-day event and "YYYY-MM-DDTHH:MM" for one
 * at a time. Dates are added up in UTC, where every day is 24 hours long.
 */

export const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The zone this server runs in: what a time with no zone (a "floating" time in a file) is taken to be in. */
export function serverZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Whether a zone name is one this runtime knows. */
export function isZone(tz: string): boolean {
  if (formatters.has(tz)) return true;
  try {
    formatterFor(tz);
    return true;
  } catch {
    return false;
  }
}

/**
 * One formatter per zone, kept: making an `Intl.DateTimeFormat` costs far more
 * than using one, and a month of a busy calendar asks thousands of times.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** How far a zone is ahead of UTC at an instant, in milliseconds. */
export function zoneOffset(at: number, timeZone: string): number {
  if (timeZone === 'UTC' || timeZone === 'Etc/UTC') return 0;
  const parts = formatterFor(timeZone).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asIfUtc - Math.floor(at / 1000) * 1000;
}

/**
 * The instant a wall clock in a zone names (the trips package's `zonedToUtc`,
 * copied, since a package may not import another). Near a clock change the
 * first guess can be an hour out, so the offset at the guess is tried and kept
 * if it holds; a time that does not exist (2:30 the morning clocks go forward)
 * lands an hour later, as a wall clock does.
 */
export function instantOf(wall: string, timeZone: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(wall);
  if (!m) return null;
  const hour = Number(m[4] ?? 0);
  const minute = Number(m[5] ?? 0);
  if (hour > 23 || minute > 59) return null;
  const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, minute);
  if (Number.isNaN(naive)) return null;
  try {
    const before = zoneOffset(naive, timeZone);
    const at = naive - before;
    const after = zoneOffset(at, timeZone);
    if (after !== before && zoneOffset(naive - after, timeZone) === after) return naive - after;
    return at;
  } catch {
    return null;
  }
}

/** The wall clock an instant reads in a zone, "YYYY-MM-DDTHH:MM". */
export function wallAt(at: number, timeZone: string): string {
  const shifted = new Date(at + zoneOffset(at, timeZone));
  return shifted.toISOString().slice(0, 16);
}

/** The date part of a wall. */
export const dateOf = (wall: string): string => wall.slice(0, 10);
/** The time part of a wall, or null for a date. */
export const timeOf = (wall: string): string | null => (wall.length > 10 ? wall.slice(11, 16) : null);

const utcOf = (date: string): number => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
const dateFromUtc = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** A date some days later (or earlier). */
export const addDays = (date: string, days: number): string => dateFromUtc(utcOf(date) + days * DAY);
/** Whole days from one date to another. */
export const daysBetween = (from: string, to: string): number => Math.round((utcOf(to) - utcOf(from)) / DAY);
/** 0 for Sunday to 6 for Saturday. */
export const weekday = (date: string): number => new Date(utcOf(date)).getUTCDay();
/** Days in a month, month 1 to 12. */
export const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();
export const ymd = (year: number, month: number, day: number): string => `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
