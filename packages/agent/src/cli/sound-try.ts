/**
 * Hear the notification sounds, without waiting for the events that make them.
 *
 *   npm run sound-try -w @everything/agent
 *   npm run sound-try -w @everything/agent -- wake
 *
 * They are generated arithmetic rather than checked-in files, so "does that
 * actually sound like anything" is a question only playing them can answer —
 * and tuning a tone by triggering a real nudge is a slow way to work.
 */
import { playSound, playTone, setSoundEnabled, soundNames, TONES, TONE_NAMES, toneFor, type SoundName } from '../sound.js';

const WHAT: Record<SoundName, string> = {
  wake: 'the wake word landed — it is listening',
  ok: 'a command worked',
  miss: "heard, but didn't understand",
  nudge: 'a nudge has arrived',
};

// The setting lives on the server and this runs on its own; playing nothing
// would make the CLI useless exactly when you want to check a tone.
setSoundEnabled(true);

/*
 * `--tones` plays the palette rather than the events, which is the mode you
 * want when choosing: the Settings screen lists these names, and hearing them
 * back to back is the only way to tell "chime" from "blip" before committing.
 */
if (process.argv[2] === '--tones') {
  console.log('');
  for (const tone of TONE_NAMES) {
    const total = TONES[tone].reduce((sum: number, blip: { ms: number }) => sum + blip.ms, 0);
    const used = soundNames().filter((event) => toneFor(event) === tone);
    console.log(
      `  ${tone.padEnd(8)} ${String(total).padStart(4)}ms` +
        `${used.length > 0 ? `   (currently: ${used.join(', ')})` : ''}` +
        `${total === 0 ? '   silence' : ''}`
    );
    playTone(tone);
    await new Promise((done) => setTimeout(done, total + 450));
  }
  console.log('');
  process.exit(0);
}

const asked = process.argv[2] as SoundName | undefined;
const names = asked ? [asked] : soundNames();

if (asked && !soundNames().includes(asked)) {
  console.error(`no such sound: ${asked}\ntry one of: ${soundNames().join(', ')}`);
  process.exit(1);
}

console.log('');
for (const name of names) {
  const total = TONES[toneFor(name)].reduce((sum: number, blip: { ms: number }) => sum + blip.ms, 0);
  console.log(`  ${name.padEnd(6)} ${toneFor(name).padEnd(7)} ${String(total).padStart(4)}ms   ${WHAT[name]}`);
  playSound(name);
  // Long enough for the tone to finish plus a beat, so they do not run together
  // and become one noise.
  await new Promise((done) => setTimeout(done, total + 500));
}
console.log('');

process.exit(0);
