/**
 * Prove the trips package's decisions, without the network.
 *
 *   npm run trips-check -w @everything/server
 *
 * Inside the package, so it goes when the package does. Everything here is in
 * `rules.ts` or `flights.ts`'s parsing, which import nothing that needs a
 * database: the times a typed flight means, when a flight is worth asking
 * about, what is worth interrupting for, and how the service's answer is read.
 */
import {
  addDays,
  AIR_EVERY,
  changesWorthSaying,
  endOfLocalDay,
  FAR_EVERY,
  greatCircle,
  localDate,
  mayMoveDue,
  NEAR_EVERY,
  nextCheckAt,
  normaliseFlightNumber,
  offsetText,
  parseServiceTime,
  spacedFlightNumber,
  WATCH_AFTER_LANDING,
  WATCH_FROM,
  zonedToUtc,
  type LiveView,
} from '../rules.js';
import { toLeg } from '../flights.js';
import { cleanSettings } from '../store.js';

let failures = 0;
function check(what: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  \x1b[32m✓\x1b[0m' : '  \x1b[31m✗\x1b[0m'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const iso = (at: number | null) => (at === null ? 'null' : new Date(at).toISOString());
const HOUR = 3_600_000;
const MINUTE = 60_000;

console.log('\na time typed at an airport is that time there');
{
  check('Denver in November is UTC−7', iso(zonedToUtc('2026-11-04', '08:30', 'America/Denver')) === '2026-11-04T15:30:00.000Z', iso(zonedToUtc('2026-11-04', '08:30', 'America/Denver')));
  check('Denver in July is UTC−6', iso(zonedToUtc('2026-07-04', '08:30', 'America/Denver')) === '2026-07-04T14:30:00.000Z');
  check('Tokyo has no summer time', iso(zonedToUtc('2026-07-04', '08:30', 'Asia/Tokyo')) === '2026-07-03T23:30:00.000Z');
  check('Kolkata is half an hour off', iso(zonedToUtc('2026-01-10', '00:15', 'Asia/Kolkata')) === '2026-01-09T18:45:00.000Z');
  check('just after the clocks go forward', iso(zonedToUtc('2026-03-08', '03:30', 'America/New_York')) === '2026-03-08T07:30:00.000Z', iso(zonedToUtc('2026-03-08', '03:30', 'America/New_York')));
  check('the hour that does not exist lands an hour later', iso(zonedToUtc('2026-03-08', '02:30', 'America/New_York')) === '2026-03-08T07:30:00.000Z', iso(zonedToUtc('2026-03-08', '02:30', 'America/New_York')));
  check('the day the clocks go back', iso(zonedToUtc('2026-11-01', '08:30', 'America/New_York')) === '2026-11-01T13:30:00.000Z');
  check('the hour that happens twice takes the first', iso(zonedToUtc('2026-11-01', '01:30', 'America/New_York')) === '2026-11-01T05:30:00.000Z');
  check('nonsense is refused', zonedToUtc('2026-11-04', '25:00', 'America/Denver') === null && zonedToUtc('tomorrow', '08:30', 'UTC') === null);
  check('an unknown zone is refused, not thrown', zonedToUtc('2026-11-04', '08:30', 'Mars/Olympus') === null);
  check('the local date at a place', localDate(Date.parse('2026-11-04T03:00:00Z'), 'America/Denver') === '2026-11-03');
}

console.log('\nthe service\'s answer');
{
  check('a space where ISO wants a T', iso(parseServiceTime('2026-11-04 08:30Z')) === '2026-11-04T08:30:00.000Z');
  check('a local time with its offset', iso(parseServiceTime('2026-11-04 01:30-07:00')) === '2026-11-04T08:30:00.000Z');
  check('absent is null', parseServiceTime(undefined) === null && parseServiceTime('') === null);
  const leg = await toLeg({
    number: 'UA 123',
    status: 'Delayed',
    airline: { name: 'United' },
    departure: {
      airport: { iata: 'DEN', name: 'Denver', municipalityName: 'Denver', countryCode: 'US', timeZone: 'America/Denver', location: { lat: 39.86, lon: -104.67 } },
      scheduledTime: { utc: '2026-11-04 15:30Z' },
      revisedTime: { utc: '2026-11-04 16:10Z' },
      terminal: 'B',
      gate: 'B12',
    },
    arrival: {
      airport: { iata: 'SFO', name: 'San Francisco', municipalityName: 'San Francisco', countryCode: 'US', timeZone: 'America/Los_Angeles', location: { lat: 37.62, lon: -122.38 } },
      scheduledTime: { utc: '2026-11-04 18:05Z' },
      baggageBelt: '7',
    },
  });
  check('a leg is read', leg !== null && leg.from.iata === 'DEN' && leg.to.city === 'San Francisco');
  check('the timetable stays the timetable', iso(leg?.departs ?? null) === '2026-11-04T15:30:00.000Z');
  check('the revised time is live, not the schedule', iso(leg?.live.departs ?? null) === '2026-11-04T16:10:00.000Z');
  check('with no revised time, live is the schedule', iso(leg?.live.arrives ?? null) === '2026-11-04T18:05:00.000Z');
  check('gate, terminal and belt', leg?.live.gate === 'B12' && leg.live.terminal === 'B' && leg.live.baggageBelt === '7');
  check('the number loses its space', leg?.number === 'UA123');
  check('a flight with no times is not a leg', (await toLeg({ departure: {}, arrival: {} })) === null);
}

console.log('\nflight numbers');
{
  check('"ua 123" is UA123', normaliseFlightNumber('ua 123') === 'UA123');
  check('easyJet\'s U2 counts', normaliseFlightNumber('U2 8001') === 'U28001');
  check('an ICAO code counts', normaliseFlightNumber('BAW117') === 'BAW117');
  check('a suffix letter counts', normaliseFlightNumber('DL 1234A') === 'DL1234A');
  check('a word is not a flight', normaliseFlightNumber('hello') === null && normaliseFlightNumber('UA') === null);
  check('read with its space back', spacedFlightNumber('UA123') === 'UA 123' && spacedFlightNumber('BAW117') === 'BAW 117');
}

console.log('\nwhen a flight is worth asking about');
{
  const departs = Date.parse('2026-11-04T15:30:00Z');
  const arrives = departs + 3 * HOUR;
  const at = (checkedAt: number | null, status: string | null = null) => nextCheckAt({ departs, arrives, checkedAt, status });
  check('never asked: the day before', at(null) === departs - WATCH_FROM);
  check('asked a week ago: still the day before', at(departs - 7 * 24 * HOUR) === departs - WATCH_FROM);
  check('a day out: every four hours', at(departs - 20 * HOUR) === departs - 20 * HOUR + FAR_EVERY);
  check('three hours out: every twenty minutes', at(departs - 3 * HOUR) === departs - 3 * HOUR + NEAR_EVERY);
  check('in the air: hourly', at(departs + 10 * MINUTE) === departs + 10 * MINUTE + AIR_EVERY);
  check('the last look is just after landing', at(arrives - 10 * MINUTE) === arrives + WATCH_AFTER_LANDING);
  check('after that, never', at(arrives + WATCH_AFTER_LANDING) === null);
  check('landed, cancelled or diverted: never', at(departs, 'Arrived') === null && at(departs, 'Canceled') === null && at(departs, 'Diverted') === null);
  // Twenty-ish, which is what the budget is sized by.
  let n = 0;
  for (let c: number | null = null, i = 0; i < 200; i++) {
    const next = nextCheckAt({ departs, arrives, checkedAt: c, status: null });
    if (next === null) break;
    c = next;
    n++;
  }
  check('about twenty looks for a three-hour flight', n >= 15 && n <= 25, `${n}`);
}

console.log('\nwhat is worth interrupting for');
{
  const base: LiveView = { status: 'Expected', departs: Date.parse('2026-11-04T15:30:00Z'), arrives: 0, gate: null, terminal: 'B' };
  const t = (at: number) => new Date(at).toISOString().slice(11, 16);
  check('the first reading says nothing', changesWorthSaying(null, base, t).length === 0);
  check('ten minutes is not news', changesWorthSaying(base, { ...base, departs: base.departs + 10 * MINUTE }, t).length === 0);
  check('forty minutes is', changesWorthSaying(base, { ...base, departs: base.departs + 40 * MINUTE }, t)[0] === 'Delayed by 40 minutes, now leaves 16:10');
  check('two hours reads as hours', changesWorthSaying(base, { ...base, departs: base.departs + 120 * MINUTE }, t)[0]?.startsWith('Delayed by 2 hours') === true);
  check('a gate announced is said', changesWorthSaying(base, { ...base, gate: 'B12' }, t)[0] === 'Gate B12');
  check('a gate changed is said with both', changesWorthSaying({ ...base, gate: 'B12' }, { ...base, gate: 'C3' }, t)[0] === 'Gate changed from B12 to C3');
  check('the same gate twice is not', changesWorthSaying({ ...base, gate: 'B12' }, { ...base, gate: 'B12' }, t).length === 0);
  check('a cancellation says only that', changesWorthSaying(base, { ...base, status: 'Canceled', gate: 'B12' }, t).join() === 'Cancelled');
}

console.log('\ntasks');
{
  check('two days before', addDays('2026-11-04', -2) === '2026-11-02');
  check('across a month', addDays('2026-10-31', 1) === '2026-11-01');
  check('the end of a day is that day, here', new Date(endOfLocalDay('2026-11-04')!).getDate() === 4 && new Date(endOfLocalDay('2026-11-04')!).getHours() === 23);
  check('offsets read as words', offsetText(-1) === '1 day before' && offsetText(0) === 'the first day' && offsetText(3) === '3 days in' && offsetText(null) === 'no date');
  check('a due date still as set may move', mayMoveDue(100, 100));
  check('a due date you moved may not', !mayMoveDue(200, 100));
  check('a task cleared of its date by hand is yours too', !mayMoveDue(null, 100));
  check('a task made with no date, still none, may get one', mayMoveDue(null, null));
}

console.log('\nsettings read back');
{
  const s = cleanSettings({ checkInHours: 9999, leaveDomesticMinutes: -5, monthlyBudget: 12.7 } as never);
  check('check-in is at most three days out', s.checkInHours === 72);
  check('a lead time cannot be negative', s.leaveDomesticMinutes === 15);
  check('the budget is whole', s.monthlyBudget === 13);
  check('missing means the defaults', cleanSettings(undefined).checkInHours === 24 && cleanSettings(undefined).alerts);
}

console.log('\nthe line a flight draws');
{
  const line = greatCircle([40.64, -73.78], [35.55, 139.78], 64);
  const north = Math.max(...line.map((p) => p[0]));
  check('New York to Tokyo goes north, over Alaska', north > 60, `${north.toFixed(1)}°`);
  const jumps = line.slice(1).some((p, i) => Math.abs(p[1] - line[i]![1]) > 90);
  check('it never jumps the map at the date line', !jumps);
  check('it starts and ends at the airports', Math.abs(line[0]![0] - 40.64) < 1e-6 && Math.abs(line.at(-1)![0] - 35.55) < 1e-6);
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall good\x1b[0m');
process.exit(failures ? 1 : 0);
