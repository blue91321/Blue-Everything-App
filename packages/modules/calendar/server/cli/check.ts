/**
 * Prove the calendar's decisions, without the network.
 *
 *   npm run calendar-check -w @everything/server
 *
 * Dates and zones, which days a repeat lands on, how a file is read, how a
 * link's refresh and an import merge, which addresses a link may not reach,
 * and when a reminder is due.
 */
import { addDays, instantOf, wallAt, weekday } from '../time.js';
import { cleanRepeat, occurrenceStarts, parseRule, type Repeat } from '../recur.js';
import { parseDuration, parseIcs, resolveZone } from '../ics.js';
import { mergeEvents } from '../merge.js';
import { isPrivateAddress } from '@everything/server/module-api';
import { linkAddress, maskLink } from '../link.js';
import { occurrencesIn } from '../occurrences.js';
import { cleanEvent, cleanOffsets, DEFAULT_REMINDERS, type CalEvent, type Calendar, type Store } from '../store.js';
import { nudgeFor, remindersDue, whenText } from '../reminders.js';
import { shiftSkips } from '../index.js';

let failures = 0;
function check(what: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  \x1b[32m✓\x1b[0m' : '  \x1b[31m✗\x1b[0m'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

console.log('\nTimes and zones');
{
  const ny = instantOf('2026-11-20T15:00', 'America/New_York');
  check('3pm in New York is 20:00 UTC in November', ny === Date.UTC(2026, 10, 20, 20, 0), String(ny && new Date(ny).toISOString()));
  const summer = instantOf('2026-07-20T15:00', 'America/New_York');
  check('...and 19:00 UTC in July', summer === Date.UTC(2026, 6, 20, 19, 0));
  check('a wall comes back as it went in', wallAt(ny!, 'America/New_York') === '2026-11-20T15:00');
  const gap = instantOf('2026-03-08T02:30', 'America/New_York');
  check(
    '2:30 the morning clocks go forward lands an hour later',
    gap !== null && wallAt(gap, 'America/New_York') === '2026-03-08T03:30',
    gap ? wallAt(gap, 'America/New_York') : 'null'
  );
  check('days add across a month', addDays('2026-01-31', 1) === '2026-02-01' && addDays('2026-03-01', -1) === '2026-02-28');
  check('Nov 13 2026 is a Friday', weekday('2026-11-13') === 5);
}

console.log('\nRepeats');
{
  const starts = (start: string, repeat: Repeat | null, last: string, skip: string[] = []) => occurrenceStarts({ start, repeat, skip }, last);
  check('daily, three times', eq(starts('2026-11-01T09:00', { freq: 'daily', interval: 1, count: 3 }, '2026-12-31'), ['2026-11-01T09:00', '2026-11-02T09:00', '2026-11-03T09:00']));
  check(
    'every other week on Monday and Wednesday',
    eq(starts('2026-11-02T10:00', { freq: 'weekly', interval: 2, byDay: [{ day: 1 }, { day: 3 }] }, '2026-11-20'), [
      '2026-11-02T10:00',
      '2026-11-04T10:00',
      '2026-11-16T10:00',
      '2026-11-18T10:00',
    ])
  );
  check(
    'weekly keeps 3pm across the clock change',
    eq(starts('2026-10-27T15:00', { freq: 'weekly', interval: 1 }, '2026-11-10'), ['2026-10-27T15:00', '2026-11-03T15:00', '2026-11-10T15:00'])
  );
  check('monthly on the 31st skips the short months', eq(starts('2026-01-31', { freq: 'monthly', interval: 1 }, '2026-06-30'), ['2026-01-31', '2026-03-31', '2026-05-31']));
  check(
    'monthly on the second Tuesday',
    eq(starts('2026-11-10T19:00', { freq: 'monthly', interval: 1, byDay: [{ day: 2, n: 2 }], count: 3 }, '2027-12-31'), [
      '2026-11-10T19:00',
      '2026-12-08T19:00',
      '2027-01-12T19:00',
    ])
  );
  check(
    'monthly on the last Friday',
    eq(starts('2026-11-27', { freq: 'monthly', interval: 1, byDay: [{ day: 5, n: -1 }], count: 3 }, '2027-12-31'), ['2026-11-27', '2026-12-25', '2027-01-29'])
  );
  check(
    'monthly on the last day',
    eq(starts('2026-01-31', { freq: 'monthly', interval: 1, byMonthDay: [-1], count: 3 }, '2027-12-31'), ['2026-01-31', '2026-02-28', '2026-03-31'])
  );
  check('yearly on a birthday, Feb 29 only in leap years', eq(starts('2024-02-29', { freq: 'yearly', interval: 1 }, '2032-12-31'), ['2024-02-29', '2028-02-29', '2032-02-29']));
  check(
    'yearly on the fourth Thursday of November',
    eq(starts('2026-11-26', { freq: 'yearly', interval: 1, byMonth: [11], byDay: [{ day: 4, n: 4 }], count: 3 }, '2030-12-31'), ['2026-11-26', '2027-11-25', '2028-11-23'])
  );
  check(
    'until is the last day, inclusive',
    eq(starts('2026-11-01', { freq: 'daily', interval: 1, until: '2026-11-03' }, '2026-12-31'), ['2026-11-01', '2026-11-02', '2026-11-03'])
  );
  check(
    'a taken-out occurrence is left out and still counted',
    eq(starts('2026-11-01', { freq: 'daily', interval: 1, count: 3 }, '2026-12-31', ['2026-11-02']), ['2026-11-01', '2026-11-03'])
  );
  check('a rule that started in 2015 still answers quickly', starts('2015-01-01T08:00', { freq: 'daily', interval: 1 }, '2026-11-20').at(-1) === '2026-11-20T08:00');
  const rule = parseRule('FREQ=MONTHLY;INTERVAL=1;BYDAY=2TU,-1FR;UNTIL=20271231T235959Z;BYSETPOS=1');
  check(
    'an RRULE is read',
    rule.repeat?.freq === 'monthly' &&
      eq(rule.repeat.byDay, [
        { day: 2, n: 2 },
        { day: 5, n: -1 },
      ]) &&
      rule.untilRaw === '20271231T235959Z'
  );
  check('...and what it could not follow is named', eq(rule.unsupported, ['BYSETPOS']));
  check('an hourly rule cannot be followed', parseRule('FREQ=HOURLY').repeat === null);
  check(
    'a repeat from a screen is bounded',
    eq(cleanRepeat({ freq: 'weekly', interval: 0, byDay: [{ day: 9 }, { day: 2 }] }), { freq: 'weekly', interval: 1, byDay: [{ day: 2 }] })
  );
}

console.log('\nReading .ics');
{
  const file = [
    'BEGIN:VCALENDAR',
    'X-WR-CALNAME:Work',
    'BEGIN:VTIMEZONE',
    'TZID:Eastern Standard Time',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'UID:standup@x',
    'DTSTART;TZID=Eastern Standard Time:20261102T093000',
    'DTEND;TZID=Eastern Standard Time:20261102T094500',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261130T143000Z',
    'EXDATE;TZID=Eastern Standard Time:20261104T093000',
    'SUMMARY:Standup\\, team',
    'DESCRIPTION:Line one\\nLine two',
    'BEGIN:VALARM',
    'TRIGGER:-PT10M',
    'END:VALARM',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:standup@x',
    'RECURRENCE-ID;TZID=Eastern Standard Time:20261106T093000',
    'DTSTART;TZID=Eastern Standard Time:20261106T110000',
    'DTEND;TZID=Eastern Standard Time:20261106T111500',
    'SUMMARY:Standup (moved)',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:trip@x',
    'DTSTART;VALUE=DATE:20261224',
    'DTEND;VALUE=DATE:20261227',
    'SUMMARY:Holiday',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:call@x',
    'DTSTART:20261120T200000Z',
    'DURATION:PT1H30M',
    'SUMMARY:Call with a very long name that was fold',
    ' ed onto the next line',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:gone@x',
    'DTSTART:20261120T200000Z',
    'STATUS:CANCELLED',
    'SUMMARY:Cancelled',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const cal = parseIcs(file, 'America/New_York');
  const standup = cal.events.find((e) => e.uid === 'standup@x')!;
  check('the calendar is named', cal.name === 'Work');
  check('four events kept: the series, its moved one, a holiday and a call (the cancelled one left out)', cal.events.length === 4, String(cal.events.length));
  check('an Outlook zone name is mapped', standup.tz === 'America/New_York' && standup.start === '2026-11-02T09:30' && standup.end === '2026-11-02T09:45');
  check('text escapes are undone', standup.title === 'Standup, team' && standup.notes === 'Line one\nLine two');
  check('UNTIL in UTC becomes a wall in its zone', standup.repeat?.until === '2026-11-30T09:30', String(standup.repeat?.until));
  check('the excluded day and the moved one are both taken out', eq([...standup.skip].sort(), ['2026-11-04T09:30', '2026-11-06T09:30']));
  const moved = cal.events.find((e) => e.title === 'Standup (moved)')!;
  check('the moved one is its own event at its new time', moved.start === '2026-11-06T11:00' && moved.repeat === null && moved.uid.startsWith('standup@x#'));
  const holiday = cal.events.find((e) => e.uid === 'trip@x')!;
  check('an all-day event keeps its exclusive end', holiday.allDay && holiday.start === '2026-12-24' && holiday.end === '2026-12-27');
  const call = cal.events.find((e) => e.uid === 'call@x')!;
  check('a folded line is put back together', call.title === 'Call with a very long name that was folded onto the next line');
  check('a time in UTC stays in UTC, and a duration gives the end', call.tz === 'UTC' && call.start === '2026-11-20T20:00' && call.end === '2026-11-20T21:30');
  check('durations', parseDuration('PT1H30M') === 90 * MIN && parseDuration('P1W') === 7 * DAY && parseDuration('-PT15M') === -15 * MIN && parseDuration('P') === null);
  check(
    'zones: IANA, Mozilla prefix, Windows, unknown',
    resolveZone('Europe/London') === 'Europe/London' &&
      resolveZone('/mozilla.org/20070129_1/America/Chicago') === 'America/Chicago' &&
      resolveZone('Tokyo Standard Time') === 'Asia/Tokyo' &&
      resolveZone('Mars Standard Time') === null
  );
  const unknown = parseIcs('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:a\nDTSTART;TZID=Mars Standard Time:20261101T100000\nSUMMARY:x\nEND:VEVENT\nEND:VCALENDAR', 'America/New_York');
  check("an unknown zone is read in this PC's, and said", unknown.events[0]?.tz === 'America/New_York' && unknown.problems.some((p) => p.includes('Mars')));

  // What the series comes to over November.
  const ev: CalEvent = { ...standup, id: 'e1', calendarId: 'c1', remind: null } as CalEvent;
  const moved2: CalEvent = { ...moved, id: 'e2', calendarId: 'c1', remind: null } as CalEvent;
  const calendars: Calendar[] = [{ id: 'c1', name: 'Work', color: '#4f8cff', kind: 'link', url: 'https://x', fetchedAt: 0, triedAt: 0, error: null, hidden: false, remind: null }];
  const occ = occurrencesIn([ev, moved2], calendars, DEFAULT_REMINDERS, Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 1));
  const days = occ.map((o) => o.start);
  check(
    'November: Mon/Wed/Fri to the 30th, less the 4th, with the 6th at 11',
    eq(days, [
      '2026-11-02T09:30',
      '2026-11-06T11:00',
      '2026-11-09T09:30',
      '2026-11-11T09:30',
      '2026-11-13T09:30',
      '2026-11-16T09:30',
      '2026-11-18T09:30',
      '2026-11-20T09:30',
      '2026-11-23T09:30',
      '2026-11-25T09:30',
      '2026-11-27T09:30',
      '2026-11-30T09:30',
    ]),
    days.join(' ')
  );
  check('an occurrence lasts what the first did', occ[0]!.endMs - occ[0]!.startMs === 15 * MIN);
  check(
    "a linked calendar's occurrences are read-only",
    occ.every((o) => o.readOnly)
  );
}

console.log('\nRefreshing and importing');
{
  let n = 0;
  const id = () => `new${++n}`;
  const base = (uid: string, title: string): CalEvent => ({
    id: `id-${uid}`,
    calendarId: 'L',
    uid,
    title,
    location: null,
    notes: null,
    allDay: true,
    start: '2026-11-20',
    end: '2026-11-21',
    tz: 'UTC',
    repeat: null,
    skip: [],
    remind: uid === 'a' ? [60] : null,
  });
  const parsed = (uid: string, title: string) => ({
    uid,
    title,
    location: null,
    notes: null,
    allDay: true,
    start: '2026-11-20',
    end: '2026-11-21',
    tz: 'UTC',
    repeat: null,
    skip: [],
  });
  const events = [base('a', 'A'), base('b', 'B'), { ...base('x', 'X'), calendarId: 'other' }];
  const replaced = mergeEvents(events, 'L', [parsed('a', 'A changed'), parsed('c', 'C')], 'replace', id);
  check(
    "a refresh keeps an event's id and your reminder times",
    replaced.events.find((e) => e.uid === 'a')?.id === 'id-a' && eq(replaced.events.find((e) => e.uid === 'a')?.remind, [60])
  );
  check(
    '...drops what the link no longer has, adds what is new, and leaves other calendars alone',
    eq(replaced.count, { added: 1, updated: 1, removed: 1 }) && replaced.events.some((e) => e.uid === 'x')
  );
  check('...and names the changed and removed for their reminders to be taken back', eq(replaced.changed.sort(), ['id-a', 'id-b']));
  const merged = mergeEvents(events, 'L', [parsed('a', 'A'), parsed('c', 'C')], 'merge', id);
  check('an import adds and keeps everything else', eq(merged.count, { added: 1, updated: 0, removed: 0 }) && merged.events.filter((e) => e.calendarId === 'L').length === 3);
  const twice = mergeEvents(merged.events, 'L', [parsed('a', 'A'), parsed('c', 'C')], 'merge', id);
  check('importing the same file twice changes nothing', eq(twice.count, { added: 0, updated: 0, removed: 0 }));
  check('a series moved from 3pm to 10am takes its taken-out days with it', eq(shiftSkips(['2026-11-16T15:00'], '2026-11-02T15:00', '2026-11-02T10:00'), ['2026-11-16T10:00']));
  check('...and a day later moves them a day', eq(shiftSkips(['2026-11-16', '2026-12-31'], '2026-11-02', '2026-11-03'), ['2026-11-17', '2027-01-01']));
  check('...and from a time to all day drops them', eq(shiftSkips(['2026-11-16T15:00'], '2026-11-02T15:00', '2026-11-02'), []));
}

console.log('\nLinks');
{
  check('webcal becomes https', linkAddress('webcal://calendar.google.com/calendar/ical/x/basic.ics').protocol === 'https:');
  const refused = (u: string) => {
    try {
      linkAddress(u);
      return false;
    } catch {
      return true;
    }
  };
  check(
    'http, this PC, the home network, the tailnet and a password are refused',
    refused('http://example.com/a.ics') &&
      refused('https://localhost/a.ics') &&
      refused('https://192.168.1.5/a.ics') &&
      refused('https://box.tail1234.ts.net/a.ics') &&
      refused('https://100.100.1.1/a.ics') &&
      refused('https://u:p@example.com/a.ics')
  );
  check(
    'private addresses are known as such',
    isPrivateAddress('10.1.2.3') &&
      isPrivateAddress('100.64.0.1') &&
      isPrivateAddress('::ffff:127.0.0.1') &&
      isPrivateAddress('fe80::1') &&
      !isPrivateAddress('142.250.80.46') &&
      !isPrivateAddress('2607:f8b0::1')
  );
  check(
    'a link is shown with its secret hidden',
    !maskLink('https://calendar.google.com/calendar/ical/abcdefghijklmnop%40group/private-0123456789abcdef/basic.ics').includes('0123456789abcdef/basic')
  );
}

console.log('\nReminders');
{
  const now = Date.UTC(2026, 10, 20, 14, 0); // 9:00 in New York
  const cal: Calendar = { id: 'c', name: 'Mine', color: '#e5534b', kind: 'own', url: null, fetchedAt: null, triedAt: null, error: null, hidden: false, remind: null };
  const ev = (id: string, start: string, end: string, remind: number[] | null = null): CalEvent =>
    cleanEvent({ id, calendarId: 'c', title: id, allDay: start.length === 10, start, end, tz: 'America/New_York', remind, skip: [], repeat: null })!;
  const store: Store = {
    calendars: [cal],
    events: [
      ev('meeting', '2026-11-20T09:10', '2026-11-20T10:00'), // default 15 before: due at 8:55, now
      ev('lunch', '2026-11-20T12:00', '2026-11-20T13:00'), // due at 11:45
      ev('birthday', '2026-11-20', '2026-11-21'), // 9:00 on the day: due now
      ev('yesterday', '2026-11-19T09:00', '2026-11-19T10:00'), // past
      ev('custom', '2026-11-20T09:30', '2026-11-20T10:00', [60, 5]), // 8:30 due (before the start), 9:25 next
    ],
    reminders: { ...DEFAULT_REMINDERS, asked: true },
    raised: {},
  };
  const { due, next } = remindersDue(store, now);
  const names = due.map((d) => `${d.occ.title}:${d.offset}`).sort();
  check("due now: the meeting, the birthday, and the custom one's hour-before", eq(names, ['birthday:-540', 'custom:60', 'meeting:15']), names.join(' '));
  check("the next is the custom one's five minutes before, at 9:25", next === Date.UTC(2026, 10, 20, 14, 25), next ? new Date(next).toISOString() : 'null');
  store.raised[due.find((d) => d.occ.title === 'meeting')!.key] = { at: now, nudge: null };
  check('a raised one is not raised again', !remindersDue(store, now).due.some((d) => d.occ.title === 'meeting'));
  check('nothing at all while reminders are off', remindersDue({ ...store, reminders: { ...store.reminders, enabled: false } }, now).due.length === 0);
  const hidden = { ...store, calendars: [{ ...cal, hidden: true }] };
  check('nor for a hidden calendar', remindersDue(hidden, now).due.length === 0);
  const meeting = due.find((d) => d.occ.title === 'meeting')!;
  const nudge = nudgeFor(meeting, now);
  check(
    'a timed reminder breaks through 5 minutes before the start, and expires at the end',
    nudge.deadlineAt === Date.UTC(2026, 10, 20, 14, 5) && nudge.expiresAt === Date.UTC(2026, 10, 20, 15, 0)
  );
  check("...in the calendar's colour", nudge.accent === '#e5534b');
  const birthday = nudgeFor(
    due.find((d) => d.occ.title === 'birthday')!,
    now
  );
  check('an all-day one never breaks into a game', birthday.deadlineAt === null);
  check(
    'said plainly',
    whenText(meeting.occ, now, 'America/New_York') === 'Today at 9:10 AM to 10:00 AM' &&
      whenText(due.find((d) => d.occ.title === 'birthday')!.occ, now, 'America/New_York') === 'Today, all day',
    whenText(meeting.occ, now, 'America/New_York')
  );
  check('offsets are cleaned: whole minutes, sorted, at most five', eq(cleanOffsets([15, 15.4, 'x', 60, -2000, 5, 1, 2, 3]), [1, 2, 3, 5, 15]));
}

if (failures) {
  console.log(`\n\x1b[31m${failures} failed\x1b[0m`);
  process.exit(1);
}
console.log('\nAll passed.');
