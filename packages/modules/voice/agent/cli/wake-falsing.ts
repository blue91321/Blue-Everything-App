/**
 * How often does the wake word fire on speech that was not addressed to it?
 *
 *   npm run wake-falsing -w @everything/agent
 *   WAKE_WORD="hey computer" npm run wake-falsing -w @everything/agent
 *
 * This is the number the switch from Vosk was made on. A closed grammar had to
 * put every sound somewhere, so "harvest festival" landed on "hey jarvis"; the
 * keyword spotter can say no. It feeds ordinary conversation past the spotter,
 * behind the live gate, and counts — then checks the real thing still wakes it,
 * said normally, said fast, and run into a command.
 *
 * `WAKE_ALIKES="jervis,jervice"` adds sound-alikes, which count as the wake
 * word, and checks each one wakes it as well as that nothing else does.
 *
 * `EVERYTHING_WAKE_THRESHOLD` (default 0.25) and `EVERYTHING_WAKE_SCORE`
 * (default 1.0) are read by the spotter, so a change to either can be measured
 * here before anybody lives with it.
 *
 * The synthesiser cannot reproduce everything: it says "Harley" far too clearly
 * to be mistaken, which is a limit of the tool and not evidence the problem is
 * gone. A slurred name across a room is not something this can make.
 */
import { wakeWordRequired } from '@everything/shared';
import { cleanUp, say, spot } from './speech-test.js';

const WAKE = (process.env.WAKE_WORD || 'hey jarvis').toLowerCase();
const DECOYS = (process.env.WAKE_DECOYS ?? '').split(',').map((w) => w.trim()).filter(Boolean);
const ALIKES = (process.env.WAKE_ALIKES ?? '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
// As the listener gives them: each on its own, and after the wake word's leading words.
const LEAD = WAKE.split(/\s+/).slice(0, WAKE.split(/\s+/).length - wakeWordRequired(WAKE).length).join(' ');
const ALIKE_PHRASES = ALIKES.flatMap((a) => (LEAD ? [a, `${LEAD} ${a}`] : [a]));
const PHRASES = [...new Set([WAKE, wakeWordRequired(WAKE).join(' '), ...ALIKE_PHRASES, ...DECOYS])];

/** Nothing here is addressed to the app. None of it should wake anything. */
const CHATTER = [
  'i was going to say the same thing about it',
  'yeah but have you seen how much they charge for that',
  'can you pass me the other one please',
  'harvest festival is on the weekend i think',
  'javier said he would call back later today',
  'i have no idea where it went honestly',
  'she was driving us all a bit mad about it',
  'just give us a minute and we can sort it out',
  'that is not what i meant at all',
  'they always do this at the end of the month',
  'harley come here',
  'where did harley go',
  'harley stop that right now',
  'charlie was asking about it earlier',
  'hey are you coming to dinner tonight',
  'jars of jam are in the cupboard',
  // Near the sound-alikes, which is where they would cost something.
  'the service was slow tonight',
  'i get nervous before these',
  'you deserve this one',
  'jerry is coming over later',
];

const isWake = (phrase: string) => !DECOYS.includes(phrase);

try {
  console.log(`\nwake word: "${WAKE}"   listening for: ${PHRASES.map((p) => `"${p}"`).join(', ')}`);
  console.log('none of the following is addressed to the app\n');

  let falseWakes = 0;
  for (const line of CHATTER) {
    const hits = spot(say(line), PHRASES).filter((hit) => isWake(hit.phrase));
    if (hits.length) falseWakes++;
    console.log(`  ${hits.length ? 'WOKE' : '  . '}  "${line}"${hits.length ? `  (as "${hits[0].phrase}")` : ''}`);
  }
  console.log(`\n  false wakes: ${falseWakes} / ${CHATTER.length}`);

  console.log('\nand the real thing must still work:\n');
  let missed = 0;
  const cases: Array<[string, string, number]> = [
    ['normal', WAKE, 1],
    ['fast', WAKE, 3],
    ['run together', `${WAKE} i drank two waters`, 1],
    ['name only', wakeWordRequired(WAKE).join(' '), 1],
    ...ALIKES.flatMap((alike) => [
      [`said "${alike}"`, LEAD ? `${LEAD} ${alike}` : alike, 1] as [string, string, number],
      [`"${alike}" fast`, `${LEAD ? `${LEAD} ` : ''}${alike} drink water`, 3] as [string, string, number],
    ]),
  ];
  for (const [label, text, rate] of cases) {
    const hit = spot(say(text, rate), PHRASES).find((h) => isWake(h.phrase));
    if (!hit) missed++;
    console.log(`  ${hit ? 'fires ' : 'MISSES'}  ${label.padEnd(13)} "${text}"${hit ? `  at ${hit.atMs}ms` : ''}`);
  }
  console.log('');
  process.exitCode = falseWakes > 0 || missed > 0 ? 1 : 0;
} finally {
  cleanUp();
}
