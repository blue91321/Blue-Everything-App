/**
 * The decisions in the trips package, with nothing attached to them.
 *
 * No imports, so `trips-check` asserts each one directly: what a time typed at
 * an airport means as an instant, when a flight is next worth asking about,
 * what counts as a change worth interrupting for, and when a checklist item is
 * due. Everything that touches the disk, the database or the network is
 * elsewhere and calls these.
 */

/* ---------------------------------------------------------------- */
/* Time at a place                                                    */
/* ---------------------------------------------------------------- */

/**
 * How far a zone is ahead of UTC at an instant, in milliseconds.
 *
 * Asked of `Intl` rather than worked out, because daylight saving is a table of
 * rules per country that changes by law, and the runtime already ships it.
 */
export function zoneOffset(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asIfUtc - Math.floor(at / 1000) * 1000;
}

/**
 * "2026-11-04" and "08:30" at an airport, as an instant.
 *
 * Without a flight service the times are typed, and a departure time is a time
 * *at the airport*: 8:30 in Denver is 8:30 in Denver whichever zone the PC is
 * in. The first guess uses the zone's offset at the wrong instant, so near a
 * clock change it can be an hour out; the offset at the guess is then tried,
 * and kept if it holds. Inside the hour that does not exist (2:30 on the
 * morning the clocks go forward) neither holds, and it lands an hour later,
 * which is what the clock on the wall does. In the hour that happens twice it
 * takes the first.
 */
export function zonedToUtc(date: string, time: string, timeZone: string): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!d || !t) return null;
  const hour = Number(t[1]);
  const minute = Number(t[2]);
  if (hour > 23 || minute > 59) return null;
  const naive = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), hour, minute);
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

/** The local date at a place, as "YYYY-MM-DD". */
export function localDate(at: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
      new Date(at)
    );
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

/**
 * The service's time strings, "2026-11-04 08:30Z" and the like, as an instant.
 *
 * A space where ISO wants a `T`: some engines read that and some refuse it, so
 * it is put right first rather than left to the runtime.
 */
export function parseServiceTime(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const at = Date.parse(value.trim().replace(' ', 'T'));
  return Number.isNaN(at) ? null : at;
}

/* ---------------------------------------------------------------- */
/* Flight numbers                                                     */
/* ---------------------------------------------------------------- */

/**
 * "ua 123", "UA123", "u2 8001" → "UA123". Null when it is not one.
 *
 * Two characters for the airline (letters, or a letter and a digit: easyJet is
 * U2), or three for an ICAO code, then one to four digits and an optional
 * suffix letter.
 */
export function normaliseFlightNumber(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]+/g, '');
  const m = /^([A-Z][A-Z0-9]|[0-9][A-Z]|[A-Z]{3})(\d{1,4}[A-Z]?)$/.exec(s);
  return m ? `${m[1]}${m[2]}` : null;
}

/** "UA123" → "UA 123", for reading. */
export function spacedFlightNumber(number: string): string {
  const m = /^([A-Z0-9]{2,3}?)(\d{1,4}[A-Z]?)$/.exec(number);
  return m ? `${m[1]} ${m[2]}` : number;
}

/* ---------------------------------------------------------------- */
/* When to ask about a flight                                         */
/* ---------------------------------------------------------------- */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Nothing is asked before this: a day out, the times are the timetable's. */
export const WATCH_FROM = 24 * HOUR;
/** Until four hours out, every four hours: delays announced the night before. */
export const FAR_EVERY = 4 * HOUR;
/** From four hours out until it leaves: gates, boarding, the delays that matter. */
export const NEAR_FROM = 4 * HOUR;
export const NEAR_EVERY = 20 * MINUTE;
/** In the air, the only thing still moving is when it lands. */
export const AIR_EVERY = 60 * MINUTE;
/** Watched until a little after landing, for the baggage belt. */
export const WATCH_AFTER_LANDING = 30 * MINUTE;

/** Statuses after which nothing more will change. */
const FINAL = new Set(['Arrived', 'Canceled', 'Diverted']);

export interface Watchable {
  departs: number;
  arrives: number;
  /** When the service was last asked, successfully or not. */
  checkedAt: number | null;
  status: string | null;
}

/**
 * When this flight is next worth a request, or null for never again.
 *
 * About twenty requests a flight: five far out, twelve near, and one an hour
 * in the air. The windows are measured from the *best known* times, so a flight
 * delayed by three hours keeps being watched until it actually goes.
 */
export function nextCheckAt(f: Watchable): number | null {
  if (f.status && FINAL.has(f.status)) return null;
  const start = f.departs - WATCH_FROM;
  const end = f.arrives + WATCH_AFTER_LANDING;
  const last = f.checkedAt;
  if (last !== null && last >= end) return null;
  if (last === null || last < start) return start;
  const every = last < f.departs - NEAR_FROM ? FAR_EVERY : last < f.departs ? NEAR_EVERY : AIR_EVERY;
  return Math.min(last + every, end);
}

/* ---------------------------------------------------------------- */
/* What is worth interrupting for                                     */
/* ---------------------------------------------------------------- */

/** A departure moving by less than this is not news: airlines shuffle by minutes. */
export const DELAY_WORTH_SAYING = 15 * MINUTE;

export interface LiveView {
  status: string | null;
  departs: number;
  arrives: number;
  gate: string | null;
  terminal: string | null;
}

/**
 * What changed between two readings that a person would want told, in words.
 *
 * Empty for the first reading (there is nothing to compare it with, and the
 * screen shows it anyway), and for movement under fifteen minutes. A gate is
 * only news once there was one: going from unknown to B12 is the gate being
 * announced, which is said too, because that is the moment you need it.
 */
export function changesWorthSaying(before: LiveView | null, after: LiveView, timeText: (at: number) => string): string[] {
  if (!before) return [];
  const said: string[] = [];
  if (after.status !== before.status && (after.status === 'Canceled' || after.status === 'Diverted')) {
    said.push(after.status === 'Canceled' ? 'Cancelled' : 'Diverted');
    return said;
  }
  const moved = after.departs - before.departs;
  if (Math.abs(moved) >= DELAY_WORTH_SAYING) {
    const minutes = Math.round(Math.abs(moved) / MINUTE);
    const amount = minutes >= 90 ? `${Math.round((minutes / 60) * 10) / 10} hours` : `${minutes} minutes`;
    said.push(`${moved > 0 ? 'Delayed' : 'Earlier'} by ${amount}, now leaves ${timeText(after.departs)}`);
  }
  if (after.gate && after.gate !== before.gate) {
    said.push(before.gate ? `Gate changed from ${before.gate} to ${after.gate}` : `Gate ${after.gate}`);
  }
  if (after.terminal && before.terminal && after.terminal !== before.terminal) {
    said.push(`Terminal changed from ${before.terminal} to ${after.terminal}`);
  }
  return said;
}

/**
 * Close enough to leaving that a change is worth breaking into a game for.
 *
 * Three hours: inside that, a gate change or a delay changes when you get up
 * and go. Further out it waits for a stopping point like any other reminder.
 */
export const URGENT_WITHIN = 3 * HOUR;

/* ---------------------------------------------------------------- */
/* Tasks                                                              */
/* ---------------------------------------------------------------- */

/** "YYYY-MM-DD" plus a number of days, as "YYYY-MM-DD". */
export function addDays(date: string, days: number): string | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!d) return null;
  const at = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]) + days);
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * The end of a day on this machine's clock, the instant core stores for a task
 * due on a day with no time. Null when the date is not one.
 */
export function endOfLocalDay(date: string): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!d) return null;
  return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), 23, 59, 59, 999).getTime();
}

/** "3 days before", "the first day", "2 days in" — how a checklist offset reads. */
export function offsetText(days: number | null): string {
  if (days === null) return 'no date';
  if (days === 0) return 'the first day';
  if (days < 0) return `${-days} day${days === -1 ? '' : 's'} before`;
  return `${days} day${days === 1 ? '' : 's'} in`;
}

/**
 * Whether a task's due date may be moved to follow the trip.
 *
 * Only when the task still says what this package last set. Moving a due date
 * you changed yourself would be the app arguing with you, the line the
 * coursework sync draws about titles.
 */
export function mayMoveDue(taskDue: number | null, lastSet: number | null | undefined): boolean {
  return lastSet !== undefined && taskDue === (lastSet ?? null);
}

/* ---------------------------------------------------------------- */
/* Places on a map                                                    */
/* ---------------------------------------------------------------- */

/**
 * Points along the great circle between two places, for a flight's line.
 *
 * A straight line on a flat map is not the way a plane goes, and on a long
 * flight the difference is most of a continent: New York to Tokyo flies over
 * Alaska. Each point is checked against the one before so the line never jumps
 * the whole map at the date line; the longitude carries on past 180 instead,
 * which a map draws as continuing off the edge.
 */
export function greatCircle(a: [number, number], b: [number, number], steps = 64): Array<[number, number]> {
  const rad = Math.PI / 180;
  const [lat1, lon1] = [a[0] * rad, a[1] * rad];
  const [lat2, lon2] = [b[0] * rad, b[1] * rad];
  const d =
    2 *
    Math.asin(
      Math.sqrt(Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2)
    );
  if (d === 0) return [a, b];
  const out: Array<[number, number]> = [];
  let previous: number | null = null;
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
    const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
    const z = A * Math.sin(lat1) + B * Math.sin(lat2);
    const lat = Math.atan2(z, Math.sqrt(x * x + y * y)) / rad;
    let lon = Math.atan2(y, x) / rad;
    if (previous !== null) {
      while (lon - previous > 180) lon -= 360;
      while (lon - previous < -180) lon += 360;
    }
    previous = lon;
    out.push([lat, lon]);
  }
  return out;
}
