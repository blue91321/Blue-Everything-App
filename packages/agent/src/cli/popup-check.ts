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

popup.stopPopups();
console.log(failures === 0 ? '\nPopup timing is correct.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
