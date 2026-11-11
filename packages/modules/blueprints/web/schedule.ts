/**
 * When the two timed boxes are due: *At a time of day* and *Every so often*.
 *
 * Here rather than in the server so the screen can say under the box when it
 * will next run, from the same arithmetic the server runs it by. Two copies
 * would be a box promising 9:15 and firing at 9:12. Imports only the
 * catalogue's helpers, which import nothing.
 *
 * **Every so often counts from one of three places**, because "every 15
 * minutes" means different things to different people:
 *
 *   - `clock`: from midnight, so 15 minutes is :00, :15, :30, :45. Lined up
 *     with the hour only when the interval divides 60 (or, in hours, 24), and
 *     the box says so when it does not.
 *   - `time`: from a time of day until another, each day: 9:10, 9:25 … 17:00.
 *   - `start`: from when the app started, or the blueprint was switched on or
 *     changed, whichever was last. The only one that is not about the clock.
 *
 * A day starts the count again at midnight (or at the start time), so an
 * interval that does not divide the day still begins each day the same way;
 * the last gap before midnight is then shorter, and the box says how much.
 */
import { dayMatches, minutesOf } from './catalogue.js';

const MINUTE = 60_000;
const DAY_MINUTES = 1440;

type Fields = Record<string, string | number>;

/** The interval in minutes, from a number and a unit: at least 1, at most a day. */
export function intervalMinutes(fields: Fields): number {
  const n = Math.max(1, Math.round(Number(fields.every) || 1));
  const minutes = fields.unit === 'hours' ? n * 60 : n;
  return Math.min(DAY_MINUTES, minutes);
}

/** Local midnight of the day `t` falls on, `offset` days along. */
function midnight(t: number, offset = 0): Date {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset);
}

/** A minute of a given day as an instant; `new Date` handles a clock change. */
function at(day: Date, minute: number): number {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minute).getTime();
}

/**
 * The minutes of one day a clock-based box runs at, from midnight. For
 * `time` they can pass midnight (22:00 to 02:00), so they may exceed 1440 and
 * belong to the day the window started.
 */
export function minutesOfDay(type: string, fields: Fields): number[] {
  if (type === 'on-time') return [minutesOf(String(fields.at))];
  const every = intervalMinutes(fields);
  if (fields.from === 'time') {
    const start = minutesOf(String(fields.at));
    const end = minutesOf(String(fields.until));
    // Until the same time as the start means the whole day round.
    const span = end === start ? DAY_MINUTES - 1 : (end - start + DAY_MINUTES) % DAY_MINUTES;
    const out: number[] = [];
    for (let m = 0; m <= span; m += every) out.push(start + m);
    return out;
  }
  const out: number[] = [];
  for (let m = 0; m < DAY_MINUTES; m += every) out.push(m);
  return out;
}

function isClockBased(type: string, fields: Fields): boolean {
  return type === 'on-time' || (type === 'on-every' && fields.from !== 'start');
}

/** Every time a box runs on the days around `t`, oldest first. */
function around(type: string, fields: Fields, t: number): number[] {
  const out: number[] = [];
  const minutes = minutesOfDay(type, fields);
  for (let d = -1; d <= 8; d += 1) {
    const day = midnight(t, d);
    if (!dayMatches(String(fields.days ?? 'every'), day.getDay())) continue;
    for (const m of minutes) out.push(at(day, m));
  }
  return out.sort((a, b) => a - b);
}

/**
 * Counted from `base` (`start` mode): base + k × interval, k from 1, or from
 * 0 for "straight away", which the server runs when the count starts rather
 * than here. Days are honoured by skipping, not by moving.
 */
function fromBase(fields: Fields, base: number, t: number, direction: 'next' | 'last'): number | null {
  const every = intervalMinutes(fields) * MINUTE;
  const days = String(fields.days ?? 'every');
  let k = direction === 'next' ? Math.floor((t - base) / every) + 1 : Math.floor((t - base) / every);
  for (let tries = 0; tries < 20_000; tries += 1) {
    if (k < 1) return null;
    const when = base + k * every;
    if (dayMatches(days, new Date(when).getDay())) return when;
    k += direction === 'next' ? 1 : -1;
  }
  return null;
}

/** The first time after `t` the box is due. `base` is when the count started. */
export function nextDue(type: string, fields: Fields, t: number, base: number): number | null {
  if (type === 'on-every' && fields.from === 'start') return fromBase(fields, base, Math.max(t, base), 'next');
  if (!isClockBased(type, fields)) return null;
  return around(type, fields, t).find((when) => when > t) ?? null;
}

/** The last time at or before `t` it was due, for noticing one has come round. */
export function lastDue(type: string, fields: Fields, t: number, base: number): number | null {
  if (type === 'on-every' && fields.from === 'start') return t < base ? null : fromBase(fields, base, t, 'last');
  if (!isClockBased(type, fields)) return null;
  const list = around(type, fields, t).filter((when) => when <= t);
  return list.length ? list[list.length - 1]! : null;
}

/** A minute of the day as this device writes times: 9:10 AM, or 09:10. */
const hhmm = (minute: number) => {
  const m = ((minute % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return new Date(2000, 0, 1, 0, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};

/** Why an interval is not on the same minutes each hour, in its own terms. */
const notHourly = (every: number) =>
  every < 60 ? `${every} doesn't divide 60` : `${span(every)} isn't a whole number of hours`;

const span = (minutes: number) =>
  minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}` : minutes > 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes} minute${minutes === 1 ? '' : 's'}`;

/**
 * What an *Every so often* box will do, in a sentence or two, for under the
 * box: whether it lines up with the hour, and when it next runs. The question
 * "does 15 divide 60" is asked here so nobody has to.
 */
export function everyNote(fields: Fields, now = Date.now()): string {
  const every = intervalMinutes(fields);
  const asked = fields.unit === 'hours' ? Number(fields.every) * 60 : Number(fields.every);
  const capped = asked > DAY_MINUTES ? ' (at most once a day)' : '';
  if (fields.from === 'start') {
    return `Every ${span(every)}${capped}, counted from when the app starts, or this blueprint is switched on or changed. ${
      fields.first === 'now' ? 'The first run is straight away.' : `The first run is ${span(every)} in.`
    }`;
  }
  const minutes = minutesOfDay('on-every', fields);
  const lines: string[] = [];
  if (fields.from === 'time') {
    const shown = minutes.slice(0, 4).map(hhmm).join(', ');
    lines.push(`${shown}${minutes.length > 4 ? ` … ${hhmm(minutes[minutes.length - 1]!)}` : ''}, each day.`);
    if (every < 60 && 60 % every === 0) {
      const marks = [...new Set(minutes.map((m) => m % 60))].sort((a, b) => a - b).map((m) => `:${String(m).padStart(2, '0')}`);
      lines.push(`The same minutes every hour (${marks.join(', ')}).`);
    } else if (every < 60) {
      lines.push(`${notHourly(every)}, so the minutes move each hour.`);
    }
  } else if (every === 60) {
    lines.push('On the hour.');
  } else if (every < 60 && 60 % every === 0) {
    lines.push(`Lines up with the hour: ${minutes.slice(0, 60 / every).map((m) => `:${String(m).padStart(2, '0')}`).join(', ')}.`);
  } else if (every % 60 === 0 && 24 % (every / 60) === 0) {
    lines.push(`From midnight: ${minutes.slice(0, 4).map(hhmm).join(', ')}${minutes.length > 4 ? ' …' : '.'}`);
  } else if (DAY_MINUTES % every === 0) {
    lines.push(
      `${notHourly(every)}, so it isn't on the same minutes each hour (${minutes.slice(0, 3).map(hhmm).join(', ')} …), but it's the same times every day.`
    );
  } else {
    const gap = DAY_MINUTES - minutes[minutes.length - 1]!;
    lines.push(
      `${every % 60 === 0 ? `${every / 60} hours doesn't divide 24` : every < 60 ? `${every} doesn't divide 60 or a day` : `${span(every)} doesn't go evenly into a day`}, so it starts again at midnight: the last gap before midnight is ${span(gap)}.`
    );
  }
  const next = nextDue('on-every', fields, now, now);
  if (next !== null) lines.push(`Next: ${new Date(next).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.`);
  return `${lines.join(' ')}${capped}`;
}
