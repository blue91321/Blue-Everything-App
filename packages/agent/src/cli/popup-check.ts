/**
 * Prove the popup stays up when it is meant to, and goes when it is meant to.
 *
 *   npm run popup-check -w @everything/agent
 *
 * This exists because of one bug that was invisible from the outside and looked
 * like something else entirely. `show({forMs: 0})` means "leave it up until
 * something replaces you"; `hide(0)` means "hide now". They shared a code path,
 * so the "Listening…" popup was drawn and hidden in the same frame — and the
 * symptom was not a missing popup, it was *apparent latency*: the wake sound
 * played instantly, nothing appeared, and the first visible popup was the
 * result one a second or two later.
 *
 * Timing is asserted against `visible()` rather than by eye, since "did that
 * window flash for one frame" is not a thing anyone can check reliably.
 */
import * as popup from '../popup.js';
import { setSoundEnabled } from '../sound.js';

let failures = 0;

function check(what: string, actual: unknown, expected: unknown): void {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures++;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${what}`);
  if (!pass) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

// The tones are not the subject here and there is no server to ask.
setSoundEnabled(false);
popup.startPopups({ log: (message) => console.log(`  (${message})`) });

console.log('\nforMs: 0 means "stay up"');
popup.show({ title: 'Listening…', lines: [{ text: 'go ahead', tone: 'muted' }], forMs: 0 });
check('visible immediately', popup.visible(), true);
await wait(300);
check('…still visible after 300ms', popup.visible(), true);
await wait(1200);
check('…and after 1.5s, with no timer to take it away', popup.visible(), true);

console.log('\na replacement with a duration takes over');
popup.show({ title: 'Drink water — 3 of 8', forMs: 400 });
check('still visible right after', popup.visible(), true);
await wait(700);
check('…gone once its own time is up', popup.visible(), false);

console.log('\nthe pending timer does not outlive what it was set for');
popup.show({ title: 'first', forMs: 400 });
popup.show({ title: 'second', forMs: 0 });
await wait(700);
// If the first popup's countdown survived, it would have hidden the second.
check('an open-ended popup is not closed by the previous timer', popup.visible(), true);

console.log('\nhide(0) still means now');
popup.hide(0);
check('hidden immediately', popup.visible(), false);

/*
 * The accent the popup draws its title in, which follows the app's rather than
 * being a colour of its own.
 *
 * It was `#ffb454` hard-coded, so every popup came up amber whatever the
 * Settings screen said — and the window that appears over a fullscreen game was
 * the one place the app did not look like itself.
 *
 * The conversion is what is asserted, because getting it wrong does not throw:
 * GDI wants 0x00BBGGRR, so a byte-order slip silently draws blue as orange,
 * which is exactly the bug being fixed.
 */
console.log('\nthe accent follows the app');
const { accentFromHex } = await import('../overlay.js');
const { ACCENT_HEX } = await import('@everything/shared');

check('blue packs to GDI order', accentFromHex('#4c8dff'), 0xff8d4c);
check('  ...and amber, which is a different number', accentFromHex('#ffb454'), 0x54b4ff);
check('a missing # is fine', accentFromHex('4c8dff'), 0xff8d4c);
check('capitals are fine', accentFromHex('#4C8DFF'), 0xff8d4c);
check('every accent the app offers converts', Object.values(ACCENT_HEX).every((hex) => accentFromHex(hex) !== null), true);
check(
  '  ...and no two land on the same number',
  new Set(Object.values(ACCENT_HEX).map(accentFromHex)).size,
  Object.keys(ACCENT_HEX).length
);
check('nonsense is refused rather than drawn black', accentFromHex('not a colour'), null);
check('  ...and so is a short hex', accentFromHex('#abc'), null);

popup.stopPopups();
console.log(failures === 0 ? '\nPopup timing is correct.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
