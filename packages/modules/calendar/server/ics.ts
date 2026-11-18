/**
 * Reading an iCalendar file (`.ics`, RFC 5545): what every calendar exports
 * and what a secret calendar link serves. No imports but this package's own
 * pure files, so `calendar-check` reads real-shaped files with it.
 *
 * Only events are read (`VEVENT`). To-dos, journals and alarms in the file are
 * passed over: a calendar's alarms are its own app's, and reminders here are
 * this app's (`reminders.ts`). Time zones are taken by name. A file's own
 * `VTIMEZONE` blocks are not followed, because every calendar that writes one
 * also names a zone this runtime knows (an IANA name, or a Windows one Outlook
 * uses, mapped below); one that names neither is read in this PC's zone, and
 * the reader says so.
 */
import { addDays, dateOf, DAY, instantOf, isZone, serverZone, wallAt, ymd } from './time.js';
import { parseRule, type Repeat } from './recur.js';

export interface ParsedEvent {
  uid: string;
  title: string;
  location: string | null;
  notes: string | null;
  allDay: boolean;
  /** Walls in `tz`; an all-day end is the day after the last. */
  start: string;
  end: string;
  tz: string;
  repeat: Repeat | null;
  skip: string[];
}

export interface ParsedCalendar {
  name: string | null;
  events: ParsedEvent[];
  /** What was left out or guessed, with how many times, for the import's preview. */
  problems: string[];
}

/** Past this, the rest of a file is left out and the preview says so. */
export const MAX_EVENTS = 20_000;

interface Line {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** The file's lines, folded lines put back together (a line starting with a space or tab continues the one before). */
function unfold(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/^﻿/, '').split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && out.length) out[out.length - 1] += raw.slice(1);
    else if (raw.length) out.push(raw);
  }
  return out;
}

/** One content line: `NAME;PARAM=value;PARAM="quoted:value":VALUE`. */
function parseLine(line: string): Line | null {
  let i = 0;
  let quoted = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ':' && !quoted) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const parts: string[] = [];
  let current = '';
  quoted = false;
  for (const c of head) {
    if (c === '"') quoted = !quoted;
    if (c === ';' && !quoted) {
      parts.push(current);
      current = '';
    } else current += c;
  }
  parts.push(current);
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const at = p.indexOf('=');
    if (at > 0) params[p.slice(0, at).toUpperCase()] = p.slice(at + 1).replace(/^"|"$/g, '');
  }
  return { name: parts[0]!.toUpperCase(), params, value };
}

/** A TEXT value with its escapes undone. */
export function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

/*
 * Outlook names zones the Windows way. The ones in common use; anything else is
 * read in this PC's zone and said so. (The full table is CLDR's windowsZones;
 * these are the zones people actually meet in an invitation.)
 */
const WINDOWS_ZONES: Record<string, string> = {
  'Dateline Standard Time': 'Etc/GMT+12',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Alaskan Standard Time': 'America/Anchorage',
  'Pacific Standard Time': 'America/Los_Angeles',
  'US Mountain Standard Time': 'America/Phoenix',
  'Mountain Standard Time': 'America/Denver',
  'Central Standard Time': 'America/Chicago',
  'Central America Standard Time': 'America/Guatemala',
  'Canada Central Standard Time': 'America/Regina',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  'Eastern Standard Time': 'America/New_York',
  'US Eastern Standard Time': 'America/Indianapolis',
  'SA Pacific Standard Time': 'America/Bogota',
  'Atlantic Standard Time': 'America/Halifax',
  'Newfoundland Standard Time': 'America/St_Johns',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'Argentina Standard Time': 'America/Buenos_Aires',
  UTC: 'UTC',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw',
  'W. Central Africa Standard Time': 'Africa/Lagos',
  'GTB Standard Time': 'Europe/Bucharest',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'Israel Standard Time': 'Asia/Jerusalem',
  'Egypt Standard Time': 'Africa/Cairo',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Russian Standard Time': 'Europe/Moscow',
  'Arab Standard Time': 'Asia/Riyadh',
  'Arabian Standard Time': 'Asia/Dubai',
  'Iran Standard Time': 'Asia/Tehran',
  'Pakistan Standard Time': 'Asia/Karachi',
  'India Standard Time': 'Asia/Calcutta',
  'Nepal Standard Time': 'Asia/Katmandu',
  'Bangladesh Standard Time': 'Asia/Dhaka',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'China Standard Time': 'Asia/Shanghai',
  'Singapore Standard Time': 'Asia/Singapore',
  'Taipei Standard Time': 'Asia/Taipei',
  'W. Australia Standard Time': 'Australia/Perth',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'AUS Central Standard Time': 'Australia/Darwin',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'Tasmania Standard Time': 'Australia/Hobart',
  'New Zealand Standard Time': 'Pacific/Auckland',
};

/** A file's zone name as one this runtime knows, or null. */
export function resolveZone(tzid: string): string | null {
  const name = tzid
    .trim()
    .replace(/^\/mozilla\.org\/[^/]+\//, '')
    .replace(/^\//, '');
  if (!name) return null;
  if (isZone(name)) return name;
  const windows = WINDOWS_ZONES[name];
  if (windows && isZone(windows)) return windows;
  return null;
}

/** A DATE or DATE-TIME value as read: the wall, and the zone it names ('UTC' for a trailing Z, null for floating). */
interface Stamp {
  date: boolean;
  wall: string;
  utc: boolean;
}

function parseStamp(value: string, params: Record<string, string>): Stamp | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const date = ymd(Number(m[1]), Number(m[2]), Number(m[3]));
  if (params.VALUE === 'DATE' || m[4] === undefined) return { date: true, wall: date, utc: false };
  return { date: false, wall: `${date}T${m[4]}:${m[5]}`, utc: m[7] === 'Z' };
}

/** A DURATION as milliseconds: `P1D`, `PT1H30M`, `P2W`, `-PT15M`. */
export function parseDuration(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!m || value.trim() === 'P' || value.trim().endsWith('T')) return null;
  const n = (i: number) => Number(m[i] ?? 0);
  const ms = ((n(2) * 7 + n(3)) * 24 * 3600 + n(4) * 3600 + n(5) * 60 + n(6)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

/**
 * Read a file. Every event's start and end are walls in its own zone; a time
 * given in UTC (a trailing Z) keeps UTC as its zone, which is what such an
 * event means, and it is shown in the screen's own zone like any other.
 */
export function parseIcs(text: string, floatingZone = serverZone()): ParsedCalendar {
  const problems = new Map<string, number>();
  const note = (p: string) => problems.set(p, (problems.get(p) ?? 0) + 1);
  const lines = unfold(text);
  let name: string | null = null;
  const masters: ParsedEvent[] = [];
  const overrides: { uid: string; recurrence: { stamp: Stamp; tzid: string | null }; event: ParsedEvent | null }[] = [];
  let stack: string[] = [];
  let props: Line[] = [];
  let truncated = false;

  // The zone of a stamp: UTC for a Z, the named zone if known, else this PC's (said once per name).
  const zoneFor = (stamp: Stamp, tzid: string | undefined): string => {
    if (stamp.utc) return 'UTC';
    if (tzid) {
      const z = resolveZone(tzid);
      if (z) return z;
      note(`Time zone "${tzid}" not recognised, so its times were read in this PC's zone`);
    }
    return floatingZone;
  };
  // A stamp as a wall in another zone (the event's), through the instant it names.
  const wallIn = (stamp: Stamp, tzid: string | undefined, tz: string, allDay: boolean): string | null => {
    if (allDay) return stamp.wall.slice(0, 10);
    if (stamp.date) return `${stamp.wall}T00:00`;
    const from = zoneFor(stamp, tzid);
    if (from === tz) return stamp.wall;
    const at = instantOf(stamp.wall, from);
    return at === null ? null : wallAt(at, tz);
  };

  const finishEvent = () => {
    const get = (n: string) => props.find((p) => p.name === n);
    const all = (n: string) => props.filter((p) => p.name === n);
    const dtstart = get('DTSTART');
    const uid = get('UID')?.value.trim() || null;
    const status = get('STATUS')?.value.trim().toUpperCase();
    const recurrenceLine = get('RECURRENCE-ID');
    if (!dtstart) {
      note('An event with no start was left out');
      return;
    }
    const start = parseStamp(dtstart.value, dtstart.params);
    if (!start) {
      note('An event whose start could not be read was left out');
      return;
    }
    const allDay = start.date;
    const tz = allDay ? floatingZone : zoneFor(start, dtstart.params.TZID);
    const startWall = start.wall;
    // The end: DTEND, else DURATION, else a day for an all-day event and nothing for one at a time.
    let endWall: string | null = null;
    const dtend = get('DTEND');
    const duration = get('DURATION');
    if (dtend) {
      const end = parseStamp(dtend.value, dtend.params);
      if (end) endWall = wallIn(end, dtend.params.TZID, tz, allDay);
    } else if (duration) {
      const ms = parseDuration(duration.value);
      if (ms !== null) {
        if (allDay) endWall = addDays(startWall, Math.max(1, Math.round(ms / DAY)));
        else {
          const at = instantOf(startWall, tz);
          if (at !== null) endWall = wallAt(at + Math.max(0, ms), tz);
        }
      }
    }
    if (!endWall || endWall < startWall) endWall = allDay ? addDays(startWall, 1) : startWall;
    if (allDay && endWall === startWall) endWall = addDays(startWall, 1);

    let repeat: Repeat | null = null;
    const rrule = get('RRULE');
    if (rrule && !recurrenceLine) {
      const parsed = parseRule(rrule.value);
      if (parsed.repeat) {
        repeat = parsed.repeat;
        if (parsed.untilRaw) {
          const until = parseStamp(parsed.untilRaw, {});
          if (until) repeat.until = allDay ? until.wall.slice(0, 10) : (wallIn(until, undefined, tz, false) ?? undefined);
        }
        for (const u of parsed.unsupported) if (u !== 'WKST') note(`A repeat rule's ${u.split('=')[0]} was left out, so some repeats may land on different days`);
      } else {
        note(`A repeat rule (${parsed.unsupported.join(', ')}) could not be followed, so the event was kept once`);
      }
    }
    const skip: string[] = [];
    for (const ex of all('EXDATE')) {
      for (const v of ex.value.split(',')) {
        const s = parseStamp(v, ex.params);
        const wall = s && wallIn(s, ex.params.TZID, tz, allDay);
        if (wall) skip.push(wall);
      }
    }
    const description = get('DESCRIPTION');
    const location = get('LOCATION');
    const event: ParsedEvent = {
      uid: uid ?? `import-${masters.length + overrides.length}-${startWall}`,
      title: unescapeText(get('SUMMARY')?.value ?? '').trim() || '(no title)',
      location: location ? unescapeText(location.value).trim() || null : null,
      notes: description ? unescapeText(description.value).trim().slice(0, 10_000) || null : null,
      allDay,
      start: startWall,
      end: endWall,
      tz,
      repeat,
      skip,
    };
    if (recurrenceLine && uid) {
      const recurrence = parseStamp(recurrenceLine.value, recurrenceLine.params);
      if (recurrence) {
        overrides.push({
          uid,
          recurrence: { stamp: recurrence, tzid: recurrenceLine.params.TZID ?? null },
          event: status === 'CANCELLED' ? null : event,
        });
        return;
      }
    }
    if (status === 'CANCELLED') return;
    masters.push(event);
  };

  for (const raw of lines) {
    const line = parseLine(raw);
    if (!line) continue;
    if (line.name === 'BEGIN') {
      stack.push(line.value.trim().toUpperCase());
      if (stack.at(-1) === 'VEVENT') props = [];
      continue;
    }
    if (line.name === 'END') {
      const ended = stack.pop();
      if (ended === 'VEVENT' && stack.at(-1) === 'VCALENDAR') {
        if (masters.length + overrides.length >= MAX_EVENTS) truncated = true;
        else finishEvent();
      }
      if (ended === 'VCALENDAR') stack = [];
      continue;
    }
    const where = stack.at(-1);
    if (where === 'VEVENT') props.push(line);
    else if (where === 'VCALENDAR' && line.name === 'X-WR-CALNAME' && !name) name = unescapeText(line.value).trim() || null;
  }

  // A moved or cancelled occurrence: taken out of its series, and (if moved) kept as an event of its own.
  const byUid = new Map(masters.map((m) => [m.uid, m]));
  for (const o of overrides) {
    const master = byUid.get(o.uid);
    if (master) {
      const wall = master.allDay
        ? o.recurrence.stamp.wall.slice(0, 10)
        : (() => {
            const s = o.recurrence.stamp;
            if (s.date) return `${s.wall}T${master.start.slice(11, 16)}`;
            const from = s.utc ? 'UTC' : o.recurrence.tzid ? (resolveZone(o.recurrence.tzid) ?? floatingZone) : master.tz;
            if (from === master.tz) return s.wall;
            const at = instantOf(s.wall, from);
            return at === null ? s.wall : wallAt(at, master.tz);
          })();
      if (!master.skip.includes(wall)) master.skip.push(wall);
    }
    if (o.event)
      masters.push({ ...o.event, uid: `${o.uid}#${dateOf(o.recurrence.stamp.wall)}${o.recurrence.stamp.date ? '' : `T${o.recurrence.stamp.wall.slice(11)}`}`, repeat: null });
  }
  if (truncated) note(`Only the first ${MAX_EVENTS.toLocaleString('en-US')} events were read`);

  return {
    name,
    events: masters,
    problems: [...problems].map(([p, n]) => (n > 1 ? `${p} (${n} times)` : p)),
  };
}

/** Whether text is a calendar at all, before trying to read it. */
export const looksLikeIcs = (text: string): boolean => /BEGIN:VCALENDAR/i.test(text.slice(0, 4096));
