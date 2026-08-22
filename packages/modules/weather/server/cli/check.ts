/**
 * Prove the weather module's decisions, without the network.
 *
 *   npm run weather-check -w @everything/server
 *
 * Inside the package, so it stops existing when the package does — the same
 * arrangement the voice CLIs have, and the same reasoning: a check script for a
 * package that is not installed is worse than no script at all.
 *
 * The interesting part is `isDue`, because it *is* the feature. "Only when I
 * ask" has to mean it, and a staleness window that quietly fires in manual mode
 * would be the one bug here that nobody would notice until they looked at a
 * request log.
 *
 * Pass `--live` to also fetch a real forecast. Off by default: a suite that
 * needs the internet is a suite that fails on a train.
 */
import { describe, isDue, DAILY_MS, findPlaces, fetchReading, type Place } from '../weather.js';

let failures = 0;
function check(what: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  \x1b[32m✓\x1b[0m' : '  \x1b[31m✗\x1b[0m'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const PLACE: Place = { name: 'Testville', detail: 'Nowhere', latitude: 40, longitude: -75, timezone: 'auto' };
const NOW = 1_700_000_000_000;

const base = { units: 'f' as const, place: PLACE, reading: null, error: null };

console.log('\nwhen it goes and looks\n');

check(
  'daily, never fetched — due',
  isDue({ ...base, mode: 'daily', fetchedAt: null }, NOW)
);
check(
  'daily, fetched a minute ago — not due',
  !isDue({ ...base, mode: 'daily', fetchedAt: NOW - 60_000 }, NOW)
);
check(
  'daily, fetched 23 hours ago — not due',
  !isDue({ ...base, mode: 'daily', fetchedAt: NOW - 23 * 60 * 60 * 1000 }, NOW)
);
check(
  'daily, fetched exactly a day ago — due',
  isDue({ ...base, mode: 'daily', fetchedAt: NOW - DAILY_MS }, NOW)
);
check(
  'daily, fetched a week ago — due',
  isDue({ ...base, mode: 'daily', fetchedAt: NOW - 7 * DAILY_MS }, NOW)
);

/*
 * The load-bearing pair. Manual must never be due, including the two cases that
 * would tempt a "well, just this once": nothing fetched yet, and a reading old
 * enough that any reasonable person would want it refreshed.
 */
check('manual, never fetched — NOT due', !isDue({ ...base, mode: 'manual', fetchedAt: null }, NOW));
check(
  'manual, fetched a month ago — NOT due',
  !isDue({ ...base, mode: 'manual', fetchedAt: NOW - 30 * DAILY_MS }, NOW)
);

check(
  'no place set — not due, whatever the mode',
  !isDue({ ...base, place: null, mode: 'daily', fetchedAt: null }, NOW)
);

/*
 * A clock that went backwards — a resumed laptop, a corrected timezone. The
 * gauge already had this bug once, where a negative elapsed time refilled it.
 * Here the worst case is only an early fetch, but "only" is doing work: with a
 * badly wrong clock it would be an early fetch on every single read.
 */
check(
  'a reading from the future does not read as due',
  !isDue({ ...base, mode: 'daily', fetchedAt: NOW + DAILY_MS }, NOW)
);

console.log('\nweather codes\n');

check('clear by day is a sun', describe(0, true).glyph === '☀️');
check('clear by night is a moon', describe(0, false).glyph === '🌙');
check('overcast reads the same either way', describe(3, true).label === describe(3, false).label);
check('thunderstorm is named', describe(95).label === 'Thunderstorm');
check('freezing rain is not merely "rain"', describe(66).label === 'Freezing rain');

/*
 * An unknown code is reported as unknown rather than mapped to the nearest
 * thing. A wrong label on a forecast is worse than an honest shrug: it is the
 * kind of wrong you act on.
 */
const unknown = describe(1234);
check('an unknown code says so', unknown.label.includes('1234') && unknown.glyph === '❓');

// Every code the service documents should land somewhere deliberate.
const documented = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99];
const unmapped = documented.filter((code) => describe(code).glyph === '❓');
check('every documented WMO code is mapped', unmapped.length === 0, unmapped.length ? `missed ${unmapped.join(', ')}` : '');

if (process.argv.includes('--live')) {
  console.log('\nagainst the real service\n');
  try {
    const places = await findPlaces('Philadelphia');
    check('the geocoder answers', places.length > 0, `${places.length} hits`);

    if (places[0]) {
      const reading = await fetchReading(places[0], 'f');
      check('a forecast comes back', Number.isFinite(reading.temperature), `${reading.temperature}°F ${reading.label}`);
      check('  ...with days attached', reading.days.length >= 3, `${reading.days.length} days`);
      check('  ...and a real label, not a code', !reading.label.startsWith('Code '), reading.label);
    }
  } catch (error) {
    check(`live fetch — ${(error as Error).message}`, false);
  }
} else {
  console.log('\n  (skipping the live fetch — pass --live to include it)');
}

console.log('');
if (failures > 0) {
  console.log(`\x1b[31m${failures} check${failures === 1 ? '' : 's'} failed.\x1b[0m\n`);
  process.exit(1);
}
console.log('\x1b[32mAll weather checks passed.\x1b[0m\n');
