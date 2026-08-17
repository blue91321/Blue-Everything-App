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
  ALWAYS_IN_VOCABULARY,
  cosineSimilarity,
  spokenVariants,
  matchVoiceCommand,
  matchVoiceCommandLoosely,
  matchesWakeWord,
  segmentUtterance,
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

console.log('\nThe grammar must be able to say what people actually say');
// A grammar can only emit words it contains. "drink water" alone left the
// recogniser unable to produce "drank", so it substituted the nearest word it
// did have — which on this machine was "resume", and that paused the music.
check('"drink" offers its past tense', spokenVariants('drink').includes('drank'), true);
check('…and its -ing form', spokenVariants('drink').includes('drinking'), true);
check('…and its plural', spokenVariants('drink').includes('drinks'), true);
check('"take" offers "took"', spokenVariants('take').includes('took'), true);
check('"brush" pluralises with -es', spokenVariants('brush').includes('brushes'), true);
check('"go" is too short to inflect blindly', spokenVariants('go').includes('goed'), false);
check('…but still offers "went"', spokenVariants('go').includes('went'), true);

/*
 * Widening the grammar is only safe because every generated form stems back to
 * the word it came from — a mis-hear between two of them then still reaches the
 * same command rather than a different one.
 *
 * Checked across a spread of endings rather than one verb, because it was only
 * ever tested on "drink" and was quietly false elsewhere: `spokenVariants`
 * offered "coffees" while the stemmer reduced it to "coffe", so "I drank two
 * coffees" could not match a stored "drink coffee". A property this load-bearing
 * has to be checked on the words that break it.
 */
// Compared against what the *stored* word reduces to, not against the word
// itself: the stem is an internal token ("take" and "taking" both become "tak"),
// and asserting it equals the spelling would be testing the stemmer's output
// format rather than the property that matters — that the two sides agree.
for (const word of [
  'drink', 'coffee', 'water', 'brush', 'walk', 'read', 'book', 'take', 'go', 'box', 'pause',
  /*
   * Short verbs that double their final consonant, and words that simply end in
   * one. Both classes were broken and in opposite directions: "sip" offered the
   * grammar "siped" — a spelling nobody says and Vosk drops — while "sipped"
   * stemmed to "sipp" and matched nothing, and "press" reduced to "pres" while
   * "pressed" reduced to "press". `jog`, `plan`, `stop`, `nap`, `log` and `trim`
   * all failed the first way; `pass` and `floss` the second.
   */
  'sip', 'jog', 'plan', 'stop', 'nap', 'log', 'trim', 'run',
  'press', 'pass', 'floss', 'fall', 'call', 'row', 'play', 'stretch',
]) {
  const target = voiceTokens(word);
  for (const form of spokenVariants(word)) {
    check(`"${form}" agrees with "${word}"`, voiceTokens(form), target);
  }
}

/*
 * And the forms people actually say reach the stored word, which is the point of
 * all of the above. `spokenVariants` generating the right spelling and the
 * stemmer folding it back are two halves of one property, and only this
 * direction is the one a user would notice.
 */
for (const [stored, said] of [
  ['sip', 'sipped'], ['jog', 'jogged'], ['plan', 'planned'], ['stop', 'stopping'],
  ['press', 'pressed'], ['floss', 'flossed'], ['take', 'taking'], ['drink', 'drank'],
] as const) {
  check(`saying "${said}" reaches a stored "${stored}"`, voiceTokens(said), voiceTokens(stored));
}

// `spokenCount` reads these out of a transcript, so the grammar has to carry
// them whatever the phrases are. Without them "I drank two waters" came back as
// "waters" and matched nothing.
check('counting words always available', ALWAYS_IN_VOCABULARY.includes('two'), true);
check('…including "three"', ALWAYS_IN_VOCABULARY.includes('three'), true);
// Nothing reads it — see `segmentUtterance` — but the recogniser needs
// somewhere harmless to put the sound, or it guesses at a neighbouring word.
check('"and" is available to the grammar', ALWAYS_IN_VOCABULARY.includes('and'), true);

console.log('\nTwo commands in one breath');
const chain = (text: string) => segmentUtterance(text, habits)?.map((s) => s.match.id) ?? null;
/** The same, against a different phrase list. */
const chain2 = (text: string, list: VoiceCandidate[]) =>
  segmentUtterance(text, list)?.map((s) => s.match.id) ?? null;

check('two habits', chain('i drank water and took my vitamins'), ['water', 'vitamins']);
check('three habits', chain('drink water and read a book and go for a walk'), ['water', 'read', 'walk']);
// The wake word rides on the front of the first segment and is ignored by the
// matcher, the same as any other extra word.
check('wake word on the front is harmless', chain('hey jarvis drink water and drink coffee'), ['water', 'coffee']);
// Each segment carries its own number, which is why the split happens before
// counting rather than after.
check(
  'counts belong to their own segment',
  segmentUtterance('drank two waters and drank three coffees', habits)?.map((s) => spokenCount(s.text)),
  [2, 3]
);

console.log('\n…and the joint never has to be heard, because it usually is not');
/*
 * The failure that killed splitting on the word.
 *
 * `spokenVariants` puts `-ing` forms of every phrase word in the grammar, so
 * `watering` is something the recogniser can emit — and "water and" sounds
 * exactly like it. Segmenting on tokens does not care: `watering` stems back to
 * `water`, the segment matches, and the sentence chains regardless of what
 * happened to the joint.
 */
check('"water and" heard as "watering" still chains', chain('drink watering go for a walk'), ['water', 'walk']);
check('…and with the joint dropped entirely', chain('drink water take vitamins'), ['water', 'vitamins']);
check('…and with it heard as a stray word', chain('drink water end take vitamins'), ['water', 'vitamins']);

console.log('\n…and a half-heard first command must not vanish into the second');
/*
 * The failure that made chaining look like it was doing one thing at random.
 *
 * A segment only has to *contain* its phrase's words, so a command whose tail
 * was clipped never closes and its words ride along until the next one closes
 * for both. "pause the [music] and I drank water" came through as tokens
 * [paus, drink, water], matched `drink water`, and the pause was silently gone —
 * one command where two were asked for, and the half that worked hid the half
 * that did not.
 */
const media: VoiceCandidate[] = [
  { id: 'water', phrases: ['drink water'] },
  { id: 'playpause', phrases: ['pause the music'] },
  { id: 'skip', phrases: ['skip this track'] },
];
const chainM = (text: string) => segmentUtterance(text, media)?.map((s) => s.match.id) ?? null;

check('both heard in full', chainM('pause the music and i drank water'), ['playpause', 'water']);
check('first one clipped is recovered', chainM('pause the and i drank water'), ['playpause', 'water']);
check('…in the other order too', chainM('i drank water and pause the'), ['water', 'playpause']);
check('…and is flagged as a guess', segmentUtterance('pause the and i drank water', media)?.[0].match.lenient, true);
// A leftover that names nothing is ignored rather than fatal, so a stray word
// the recogniser invented cannot cost a chain that is otherwise perfectly clear.
check('an unrecognisable leftover is ignored', chainM('drink water thing and skip this track'), ['water', 'skip']);
/*
 * The rule that stops leftovers inventing commands.
 *
 * A single loose candidate is not enough by itself: "went to the shops"
 * loosely matches "go for a walk", since "went" stems to "go" and the lenient
 * matcher may lose a phrase's last word. What rules it out is that "shops" is
 * accounted for by nothing in that phrase — a genuinely clipped command
 * contains only words of the command it was.
 */
check('a leftover with words of its own is not a clipped command', chain('i drank water and went to the shops'), null);
check('…while one that is purely a prefix is', chainM('i drank water and pause the'), ['water', 'playpause']);
// The wake word is a leftover by this measure and must never become a command.
check(
  'the wake word is not a clipped command',
  segmentUtterance('hey jarvis drink water and skip this track', media, { wakeWord: 'hey jarvis' })?.map((s) => s.match.id),
  ['water', 'skip']
);

console.log('\n…and a sentence that only looks like a chain must not be one');
// The guard that keeps a stored phrase containing "and" working: no prefix of
// it matches on its own, so it closes exactly one segment and is not a chain.
const salt: VoiceCandidate[] = [{ id: 'salt', phrases: ['salt and pepper'] }];
check('a phrase containing "and" is one command', chain2('salt and pepper', salt), null);
// Words left over after the last match mean part of the sentence was not
// understood, and acting on the rest would be worse than falling back.
check('an unmatched tail abandons it', chain('i drank water and went to the shops'), null);
check('one command is not a chain', chain('i drank water'), null);
check('nothing is not a chain', chain(''), null);
check('unrelated speech is not a chain', chain('what time is the meeting'), null);
// Trailing filler is not an unmatched command.
check('trailing filler is tolerated', chain('drink water and drink coffee please'), ['water', 'coffee']);

console.log('\nA phrase said as one word');
/*
 * "never mind" is stored as two words, so the grammar could only offer them
 * separately — and a closed grammar must map every sound onto something it
 * contains. Said as "nevermind", the decoder could not answer with the word
 * actually spoken and picked whatever was nearest, which on this machine was
 * "went" (in the grammar because "go" is, via "stop go away").
 *
 * `vocabularyFor` now offers the joined form so it *can* answer, and these are
 * the matcher's half of that: without them the transcript it can now produce
 * would match nothing at all.
 */
const cancel: VoiceCandidate[] = [{ id: 'cancel', phrases: ['never mind'] }];
check('"nevermind" matches "never mind"', matchVoiceCommand('nevermind', cancel)?.id, 'cancel');
check('…and still does said properly', matchVoiceCommand('never mind', cancel)?.id, 'cancel');
check('…and after the wake word', matchVoiceCommand('hey jarvis nevermind', cancel)?.id, 'cancel');
// The joined form is the whole phrase, not a licence to match half of it.
check('"never" alone still does not match', matchVoiceCommand('never', cancel), null);
check('an unrelated joined word does not match', matchVoiceCommand('nevertheless', cancel), null);
// A one-word phrase has no joined form to speak of; it must not match on empty.
check('a one-word phrase is unaffected', matchVoiceCommand('resuming', [{ id: 'r', phrases: ['resume'] }])?.id, 'r');

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
