/**
 * Prove the voice matcher does what the UI promises.
 *
 *   npm run voice-check -w @everything/server
 *
 * The matcher is the part of voice most likely to be quietly wrong: everything
 * else fails loudly — a missing DLL, a silent microphone — while a matcher that
 * is slightly too loose ticks off the wrong habit and leaves no trace that
 * anything went wrong. So the cases that matter are the *negative* ones.
 *
 * Runs entirely in memory. Touches no database and needs no server.
 */
import {
  cosineSimilarity,
  matchVoiceCommand,
  matchVoiceCommandLoosely,
  matchesWakeWord,
  spokenCount,
  voiceTokens,
  wakeWordAdvice,
  type VoiceCandidate,
} from '@everything/shared';

let failures = 0;

function check(what: string, actual: unknown, expected: unknown): void {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures++;
  const mark = pass ? 'ok  ' : 'FAIL';
  console.log(`  ${mark} ${what}`);
  if (!pass) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const habits: VoiceCandidate[] = [
  { id: 'water', phrases: ['drink water'] },
  { id: 'coffee', phrases: ['drink coffee'] },
  { id: 'vitamins', phrases: ['take vitamins', 'had my vitamins'] },
  { id: 'walk', phrases: ['go for a walk'] },
  { id: 'read', phrases: ['read a book'] },
];

const matched = (text: string): string | null => matchVoiceCommand(text, habits)?.id ?? null;

console.log('\nTense and filler — the whole reason this is not string equality');
check('"i drank water"', matched('i drank water'), 'water');
check('"I drank some water"', matched('I drank some water'), 'water');
check('"just had a glass of water, drink"', matched('just drink water'), 'water');
check('"drinking water"', matched('drinking water'), 'water');
check('"i took my vitamins"', matched('i took my vitamins'), 'vitamins');
check('"went for a walk"', matched('went for a walk'), 'walk');
check('"i read a book"', matched('i read a book'), 'read');

console.log('\nThe wrong habit must never win');
check('"i drank coffee" is not water', matched('i drank coffee'), 'coffee');
check('"i drank water" is not coffee', matched('i drank water'), 'water');

console.log('\nNo match is the right answer more often than a match');
check('empty', matched(''), null);
check('filler only', matched('i just had some'), null);
check('unrelated speech', matched('what time is the meeting'), null);
check('half a phrase', matched('i drank'), null);
check('wake word alone', matched('hey everything'), null);
// The one that would be quietly destructive: a habit nobody wrote a phrase for
// must be unreachable, not matched on its name.
check('habit with no phrases', matchVoiceCommand('brush teeth', [{ id: 'teeth', phrases: [] }]), null);

console.log('\nA clipped last word still matches, but only loosely');
const loose = (text: string) => matchVoiceCommandLoosely(text, habits).map((m) => m.id).sort();
check('"take" reaches take vitamins', loose('i took'), ['vitamins']);
check('flagged as a guess', matchVoiceCommandLoosely('i took', habits)[0]?.lenient, true);
check('"read" reaches read a book', loose('i read'), ['read']);
// "drink" is the shared head of two phrases, so both surface and the caller
// asks. This is the case that makes returning every candidate necessary rather
// than picking a winner — guessing here ticks off the wrong habit.
check('"drink" surfaces both drink phrases', loose('i drank'), ['coffee', 'water']);

console.log('\n…and leniency stays narrow, because it ticks off real things');
// A *middle* word missing is not a clipped tail, it is a different sentence.
// (`for` and `a` are filler, so "go for a walk" is really the two words
// [go, walk] — "at" is not, which makes this the honest test.)
const gym: VoiceCandidate[] = [{ id: 'gym', phrases: ['exercise at the gym'] }];
check('middle word missing does not match', matchVoiceCommandLoosely('exercise gym', gym), []);
check('…but a clipped tail does', matchVoiceCommandLoosely('exercise at', gym).map((m) => m.id), ['gym']);
// One content word means there is nothing left after dropping the last.
check('one-word phrase never matches loosely', matchVoiceCommandLoosely('anything', [{ id: 'x', phrases: ['exercise'] }]), []);
check('unrelated speech still matches nothing', loose('what time is it'), []);
check('empty still matches nothing', loose(''), []);

console.log('\nSpecificity — a longer phrase beats a shorter one');
const overlapping: VoiceCandidate[] = [
  { id: 'general', phrases: ['exercise'] },
  { id: 'specific', phrases: ['exercise at the gym'] },
];
check('"exercise at the gym"', matchVoiceCommand('i did exercise at the gym', overlapping)?.id, 'specific');
check('"exercise" alone', matchVoiceCommand('i did exercise', overlapping)?.id, 'general');

console.log('\nCounts');
check('"i drank water"', spokenCount('i drank water'), 1);
check('"i drank two waters"', spokenCount('i drank two waters'), 2);
check('"i drank 3 waters"', spokenCount('i drank 3 waters'), 3);
check('"a glass of water" is not 1-by-accident', spokenCount('a glass of water'), 1);
check('"drank water twice"', spokenCount('drank water twice'), 2);

console.log('\nTokenising');
check('filler stripped', voiceTokens('I have just had some water'), ['water']);
check('punctuation stripped', voiceTokens('drink water!'), ['drink', 'water']);
check('irregular past folded', voiceTokens('drank'), ['drink']);
check('short words not over-stemmed', voiceTokens('gas'), ['gas']);

console.log('\nWake word — a dropped "hey" must not lose the wake');
check('"hey jarvis" heard whole', matchesWakeWord('hey jarvis', 'hey jarvis'), true);
check('"hey jarvis" heard as "jarvis"', matchesWakeWord('jarvis', 'hey jarvis'), true);
check('"ok computer" heard as "computer"', matchesWakeWord('computer', 'ok computer'), true);
check('one-word wake word', matchesWakeWord('jarvis', 'jarvis'), true);
check('wake word inside a longer utterance', matchesWakeWord('uh jarvis', 'hey jarvis'), true);

console.log('\n…but the distinctive part is still required');
check('bare "hey" is not the wake word', matchesWakeWord('hey', 'hey jarvis'), false);
check('empty', matchesWakeWord('', 'hey jarvis'), false);
check('unrelated word', matchesWakeWord('water', 'hey jarvis'), false);
check('wrong name', matchesWakeWord('hey computer', 'hey jarvis'), false);
// A wake word made entirely of prefixes must still require something, or it
// would match every utterance the recogniser produced.
check('"hey ok" requires "ok"', matchesWakeWord('', 'hey ok'), false);
check('"hey ok" matches "ok"', matchesWakeWord('ok', 'hey ok'), true);
check('multi-word name needs all of it', matchesWakeWord('hey jar', 'hey jar jar'), false);

console.log('\nWake word advice — warns, never refuses');
check('two words is fine', wakeWordAdvice('hey jarvis'), null);
check('one long word warns', typeof wakeWordAdvice('jarvis') === 'string', true);
check('one short word warns harder', (wakeWordAdvice('yo') ?? '').includes('short'), true);

console.log('\nSpeaker similarity');
const me = [0.2, 0.9, -0.4, 0.1];
check('identical is 1', Math.round(cosineSimilarity(me, me) * 1000) / 1000, 1);
check('scale-invariant', Math.round(cosineSimilarity(me, me.map((v) => v * 7)) * 1000) / 1000, 1);
check('opposite is -1', Math.round(cosineSimilarity(me, me.map((v) => -v)) * 1000) / 1000, -1);
check('length mismatch is 0, not a crash', cosineSimilarity(me, [1, 2]), 0);
check('empty is 0', cosineSimilarity([], []), 0);

const orthogonal = Math.abs(cosineSimilarity([1, 0, 0, 0], [0, 1, 0, 0]));
check('unrelated vectors score ~0', orthogonal < 0.001, true);

console.log(
  failures === 0
    ? '\nAll voice matching checks passed.\n'
    : `\n${failures} CHECK${failures === 1 ? '' : 'S'} FAILED — do not trust voice until this is fixed.\n`
);
process.exit(failures === 0 ? 0 : 1);
