/**
 * Prove the blueprint rules, with no database, no network and nothing real
 * changed.
 *
 *   npm run blueprints-check -w @everything/server
 *
 * What is worth a suite is what decides whether a blueprint does what its
 * picture says: what a saved graph may hold, which way a run goes, that a loop
 * stops, and when a time box is next due.
 */
import { HOTKEY_KEYS } from '@everything/shared';
import { VK } from '../../../../agent/src/keys.js';
import { NODES, dayMatches, fieldPort, fieldValue, fill, gate, inputsOf, isBetween, letterPort, phrasesOf, specOf } from '../../web/catalogue.js';
import { evaluate, formatNumber, lettersOf, parseMath } from '../../web/maths.js';
import { cleanGraph, everyLabel, everyMs, nextAll, pickRandom, randomRange, RunStopped, unreachable, walk, LIMITS, type Effects, type Graph } from '../../web/engine.js';
import { chainsBack, loopWarnings } from '../../web/loops.js';
import { searchBoxes } from '../../web/search.js';
import { blueprintIn, fromCode, toCode, withBlueprint } from '../../web/share-png.js';
import { deflateSync } from 'node:zlib';
import { designLength, designOf, designSamples, designWav, localSoundPath, MAX_SOUND_MS, parseSoundShape, SHAPE_LIMITS, SOUND_RATE, soundShapeText } from '../../web/sound-design.js';
import { harmonicsOf, helloFormants, helloVoiced } from '../../web/sound-examples.js';
import { normalText, parseVoiceEdit, planSpeech, speechLength, textToSounds, voiceEditText, type SpeechInput } from '../../web/speech.js';
import { TONE_NAMES } from '@everything/shared/sound';
import { backspace, fromText, left, right, selectAll, selectedText, selection, toText, type as typeIn, vertical, type Doc } from '../../web/math-doc.js';
import { describePreview, previewField, previewNumber, previewSum } from '../../web/preview.js';
import { KEY_NAMES, normalKeys, parseKeys, parseTimeline, playable, runTimeline, soonerIfSkipped, timelineLength } from '../../web/keys.js';
import { TEMPLATES, gameName, graphFor, nameFor, staysFor, type OldCommand } from '../rules.js';
import { everyNote, intervalMinutes, lastDue, nextDue } from '../../web/schedule.js';

let failures = 0;
function check(what: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  \x1b[32m✓\x1b[0m' : '  \x1b[31m✗\x1b[0m'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

console.log('\nThe boxes');
check('every type is listed once', new Set(NODES.map((n) => n.type)).size === NODES.length);
check('an event leads on by "then" alone', NODES.filter((n) => n.kind === 'event').every((n) => n.outputs.length === 1 && n.outputs[0]!.id === 'then'));
check('a check leads on by yes and no, and gives its answer', NODES.filter((n) => n.kind === 'branch').every((n) => n.outputs.map((o) => o.id).join() === 'yes,no,value'));
check('every choice has its default among its options', NODES.every((n) => n.fields.every((f) => f.kind !== 'choice' || f.options!.some((o) => o.id === f.default))));
const minutes = specOf('wait')!.fields[0]!;
check('a number is clamped', fieldValue(minutes, 999999) === 100000 && fieldValue(minutes, -3) === 0.001);
check('a wait keeps three decimals', fieldValue(minutes, 0.0254) === 0.025 && fieldValue(minutes, 1.5) === 1.5);
check('a one-decimal field still keeps one', fieldValue({ key: 'x', label: '', kind: 'number', default: 1, step: 0.1 }, 0.26) === 0.3);
check('a number that is not one is the default', fieldValue(minutes, 'soon') === 30);
check('a time that is not one is the default', fieldValue(specOf('on-time')!.fields[0]!, '25:00') === '09:00');
check('a choice not on offer is the default', fieldValue(specOf('if-doing')!.fields[0]!, 'asleep') === 'free');

console.log('\nTimes and words');
check('09:00 to 22:00 holds 12:00', isBetween(12 * 60, '09:00', '22:00'));
check('and not 23:00', !isBetween(23 * 60, '09:00', '22:00'));
check('22:00 to 06:00 wraps past midnight', isBetween(1 * 60, '22:00', '06:00') && isBetween(23 * 60, '22:00', '06:00') && !isBetween(12 * 60, '22:00', '06:00'));
check('Saturday is a weekend, Monday a weekday', dayMatches('weekends', 6) && dayMatches('weekdays', 1) && !dayMatches('weekdays', 0));
check('{game} is filled in', fill('Good game of {game}', { game: 'Warframe' }) === 'Good game of Warframe');
check('a word nothing gave is left as written', fill('At {place}', {}) === 'At {place}');
check('a game is named without its file', gameName('Warframe.x64.exe') === 'Warframe' && gameName('League of Legends.exe') === 'League of Legends');

console.log('\nWhat a saved graph may hold');
const messy = cleanGraph({
  nodes: [
    { id: 'a', type: 'on-button', x: 0, y: 0, fields: {} },
    { id: 'b', type: 'if-time', x: 300, y: 0, fields: { from: 'noon', to: '10:00', extra: 'x' } },
    { id: 'c', type: 'nudge', x: 600, y: 0, fields: { title: 'Hi', stays: 1e9 } },
    { id: 'd', type: 'rm-rf', x: 0, y: 0, fields: {} },
    { id: 'a', type: 'nudge', x: 0, y: 0, fields: {} },
    { id: '../x', type: 'nudge', x: 0, y: 0, fields: {} },
  ],
  wires: [
    { id: 'w1', from: 'a', pin: 'then', to: 'b' },
    { id: 'w2', from: 'b', pin: 'yes', to: 'c' },
    { id: 'w3', from: 'b', pin: 'yes', to: 'a' },
    { id: 'w4', from: 'b', pin: 'maybe', to: 'c' },
    { id: 'w5', from: 'c', pin: 'then', to: 'd' },
    { id: 'w6', from: 'c', pin: 'then', to: 'a' },
    { id: 'w7', from: 'c', pin: 'then', to: 'c' },
  ],
});
check('an unknown box, a repeated id and a strange id are dropped', messy.nodes.map((n) => n.id).join() === 'a,b,c');
check('fields are only the box’s own, with bad values made defaults', JSON.stringify(messy.nodes[1]!.fields) === '{"from":"09:00","to":"10:00"}');
check('a number past its limit is clamped', messy.nodes[2]!.fields.stays === 1440);
check('no wire twice, and none into an event', messy.wires.filter((w) => w.from === 'b').length === 1);
check('the same wire twice is kept once', cleanGraph({ nodes: [{ id: 'a', type: 'on-button', fields: {} }, { id: 'b', type: 'wait', fields: {} }], wires: [{ id: 'x', from: 'a', pin: 'then', to: 'b' }, { id: 'y', from: 'a', pin: 'then', to: 'b' }] }).wires.length === 1);
check('a wire into an event, to nowhere, from no such pin or to itself is dropped', messy.wires.map((w) => w.id).join() === 'w1,w2');
check('too many boxes are cut at the limit', cleanGraph({ nodes: Array.from({ length: 300 }, (_, i) => ({ id: `n${i}`, type: 'wait', fields: {} })), wires: [] }).nodes.length === LIMITS.nodes);
check('nonsense is an empty graph', cleanGraph('nope').nodes.length === 0 && cleanGraph(null).wires.length === 0);
// A notification no longer waits for a good break: a saved "when" is dropped as it is read, so it shows at once.
check('a notification saved with a When loses it', !('when' in cleanGraph({ nodes: [{ id: 'n', type: 'nudge', fields: { title: 'x', when: 'good' } }], wires: [] }).nodes[0]!.fields));

console.log('\nWhich way a run goes');
const graph: Graph = cleanGraph({
  nodes: [
    { id: 'go', type: 'on-button', fields: {} },
    { id: 'ask', type: 'if-day', fields: {} },
    { id: 'yes', type: 'nudge', fields: { title: 'weekday' } },
    { id: 'no', type: 'add-task', fields: { title: 'weekend' } },
    { id: 'lonely', type: 'nudge', fields: { title: 'never' } },
  ],
  wires: [
    { from: 'go', pin: 'then', to: 'ask' },
    { from: 'ask', pin: 'yes', to: 'yes' },
    { from: 'ask', pin: 'no', to: 'no' },
  ],
});
function effects(answer: boolean, log: string[]): Effects {
  return {
    check: async (node) => {
      log.push(`check ${node.id}`);
      return { yes: answer, said: String(answer) };
    },
    act: async (node) => {
      log.push(`do ${node.id}`);
      if (node.id === 'boom') throw new Error('it broke');
      return `did ${node.id}`;
    },
  };
}
const yesLog: string[] = [];
const yesSteps = await walk(graph, 'go', effects(true, yesLog));
check('yes goes the yes way', yesLog.join() === 'check ask,do yes', yesLog.join());
check('and the steps say so', yesSteps.map((s) => s.result).join() === 'started,yes,done');
const noLog: string[] = [];
await walk(graph, 'go', effects(false, noLog));
check('no goes the no way', noLog.join() === 'check ask,do no', noLog.join());
check('a box no event reaches is marked', [...unreachable(graph)].join() === 'lonely');

const loop = cleanGraph({
  nodes: [
    { id: 'go', type: 'on-button', fields: {} },
    { id: 'x', type: 'nudge', fields: { title: 'a' } },
    { id: 'y', type: 'nudge', fields: { title: 'b' } },
  ],
  wires: [
    { from: 'go', pin: 'then', to: 'x' },
    { from: 'x', pin: 'then', to: 'y' },
    { from: 'y', pin: 'then', to: 'x' },
  ],
});
const loopSteps = await walk(loop, 'go', effects(true, []));
check('a loop with no wait stops at the limit and says why', loopSteps.length <= LIMITS.steps + 2 && loopSteps.at(-1)!.result === 'failed' && /loop/.test(loopSteps.at(-1)!.said));

const broken = cleanGraph({
  nodes: [
    { id: 'go', type: 'on-button', fields: {} },
    { id: 'boom', type: 'nudge', fields: { title: 'a' } },
    { id: 'after', type: 'nudge', fields: { title: 'b' } },
  ],
  wires: [
    { from: 'go', pin: 'then', to: 'boom' },
    { from: 'boom', pin: 'then', to: 'after' },
  ],
});
const brokenLog: string[] = [];
const brokenSteps = await walk(broken, 'go', effects(true, brokenLog));
check('a box that fails ends the run there', brokenLog.join() === 'do boom' && brokenSteps.at(-1)!.said === 'it broke');
const live: import('../../web/engine.js').Step[] = [];
await walk(graph, 'go', effects(true, []), live);
check('the steps are written where the caller can watch them', live.length === 3);

console.log('\nAt a time of day');
// October 2026; the 28th is a Wednesday.
const D = (day: number, h: number, m: number) => new Date(2026, 9, day, h, m).getTime();
const daily = (at: string, days = 'every') => ({ at, days });
check('later today is today', nextDue('on-time', daily('11:30'), D(28, 10, 0), 0) === D(28, 11, 30));
check('earlier today is tomorrow', nextDue('on-time', daily('09:00'), D(28, 10, 0), 0) === D(29, 9, 0));
check('weekends only, from a Wednesday, is Saturday', nextDue('on-time', daily('09:00', 'weekends'), D(28, 10, 0), 0) === D(31, 9, 0));
check('the exact minute now is not due again', nextDue('on-time', daily('10:00'), D(28, 10, 0), 0) === D(29, 10, 0));

console.log('\nEvery so often');
const every = (n: number, extra: Record<string, string | number> = {}) => ({
  every: n,
  unit: 'minutes',
  from: 'clock',
  days: 'every',
  at: '09:00',
  until: '17:00',
  first: 'wait',
  ...extra,
});
check(
  'the interval is at least a minute and at most a day',
  intervalMinutes(every(0)) === 1 && intervalMinutes(every(30, { unit: 'hours' })) === 1440 && intervalMinutes(every(2, { unit: 'hours' })) === 120
);
check('every 15, on the clock, from 10:07 is 10:15', nextDue('on-every', every(15), D(28, 10, 7), 0) === D(28, 10, 15));
check('and the last one was 10:00', lastDue('on-every', every(15), D(28, 10, 7), 0) === D(28, 10, 0));
check('every 15 lines up with the hour, and says so', /:00, :15, :30, :45/.test(everyNote(every(15))));
check('every 60 is on the hour', /On the hour/.test(everyNote(every(60))));
check('every 45 is not on the hour: 00:50 → 01:30', nextDue('on-every', every(45), D(28, 0, 50), 0) === D(28, 1, 30));
check('and says it is the same times every day', /doesn't divide 60.*same times every day/.test(everyNote(every(45))));
check('every 7 starts again at midnight: after 23:56 is 00:00', nextDue('on-every', every(7), D(28, 23, 56), 0) === D(29, 0, 0));
check('and says the last gap is 5 minutes', /last gap before midnight is 5 minutes/.test(everyNote(every(7))), everyNote(every(7)));
check('every 2 hours is from midnight: 10:07 → 12:00', nextDue('on-every', every(2, { unit: 'hours' }), D(28, 10, 7), 0) === D(28, 12, 0));
const fiveHours = everyNote(every(5, { unit: 'hours' }));
check('every 5 hours does not divide 24, and the last gap is 4 hours', /24.*4 hours/.test(fiveHours), fiveHours);
const window = every(15, { from: 'time', at: '09:10', until: '17:00' });
check('starting at 9:10: from 8:00 the next is 9:10', nextDue('on-every', window, D(28, 8, 0), 0) === D(28, 9, 10));
check(
  'until 17:00: the last is 16:55, then 9:10 tomorrow',
  lastDue('on-every', window, D(28, 16, 58), 0) === D(28, 16, 55) && nextDue('on-every', window, D(28, 16, 58), 0) === D(29, 9, 10)
);
check('the end is included when it lands on one', nextDue('on-every', every(60, { from: 'time', at: '09:00', until: '17:00' }), D(28, 16, 30), 0) === D(28, 17, 0));
check('the minutes of a window that lines up are named', /:10, :25, :40, :55/.test(everyNote(window)), everyNote(window));
const night = every(60, { from: 'time', at: '22:00', until: '02:00' });
check('a window past midnight: after 23:30 is 00:00', nextDue('on-every', night, D(28, 23, 30), 0) === D(29, 0, 0));
check('and after 02:30 is 22:00', nextDue('on-every', night, D(29, 2, 30), 0) === D(29, 22, 0));
const fromStart = every(15, { from: 'start' });
const base = D(28, 10, 0) + 20_000; // the app started at 10:00:20
check('from the start: 15 minutes after it', nextDue('on-every', fromStart, base, base) === base + 15 * 60_000);
check('and nothing has come round in the first 15 minutes', lastDue('on-every', fromStart, base + 14 * 60_000, base) === null);
check('at 10:31 the last was 15 minutes ago', lastDue('on-every', fromStart, base + 31 * 60_000, base) === base + 30 * 60_000);
check('weekends only, from a Wednesday, is Saturday at midnight', nextDue('on-every', every(60, { days: 'weekends' }), D(28, 10, 0), 0) === D(31, 0, 0));
check(
  'the note says when a count from the start begins',
  /counted from when the app starts/.test(everyNote(fromStart)) && /straight away/.test(everyNote({ ...fromStart, first: 'now' }))
);
check('more than a day is held to once a day, and says so', /at most once a day/.test(everyNote(every(30, { unit: 'hours' }))));
const hidden = specOf('on-every')!.fields.filter((f) => f.showWhen).map((f) => `${f.key}:${f.showWhen!.is.join()}`);
check('the start time and end show only for a window, the first run only from the start', hidden.join() === 'at:time,until:time,first:start', hidden.join());

console.log('\nKeys');
check('the key names are the ones the agent has codes for', KEY_NAMES.join() === HOTKEY_KEYS.join() && KEY_NAMES.every((k) => VK[k] !== undefined));
check('a combination has one spelling', normalKeys('Alt + Control + M') === 'ctrl+alt+m' && normalKeys('WIN+shift+f5') === 'shift+win+f5');
check('a bare key can be pressed', normalKeys('e') === 'e' && normalKeys('space') === 'space');
check('but a hotkey needs a modifier', normalKeys('e', true) === '' && normalKeys('f8', true) === '' && normalKeys('ctrl+e', true) === 'ctrl+e');
check('a key that is not one is refused', parseKeys('ctrl+banana') === null && parseKeys('ctrl+ctrl+m') === null && parseKeys('') === null);
const fieldOf = (type: string, key: string) => specOf(type)!.fields.find((f) => f.key === key)!;
const hotkeyField = fieldOf('on-hotkey', 'keys');
check('a hotkey box keeps only a hotkey', fieldValue(hotkeyField, 'e') === '' && fieldValue(hotkeyField, 'Ctrl+Alt+M') === 'ctrl+alt+m');
check('a press box keeps a bare key', fieldValue(fieldOf('press-keys', 'keys'), 'E') === 'e');

// Watched: a bare key or a mouse button, which a registered hotkey cannot be.
const watchField = fieldOf('on-hotkey', 'watch');
check('a watched key may be bare', fieldValue(watchField, 'F1') === 'f1');
check('  ...or a mouse button, numbered as games number them', fieldValue(watchField, 'Mouse4') === 'mouse4' && fieldValue(watchField, 'mouse1') === 'mouse1');
check('  ...and the old Windows names read as the numbers, so saved blueprints keep working', fieldValue(watchField, 'XButton1') === 'mouse4' && fieldValue(watchField, 'lbutton') === 'mouse1' && fieldValue(watchField, 'rbutton') === 'mouse2' && fieldValue(watchField, 'mbutton') === 'mouse3' && fieldValue(watchField, 'xbutton2') === 'mouse5');
check('  ...but a mouse button is never a key to register or press', fieldValue(hotkeyField, 'ctrl+mouse4') === '' && fieldValue(fieldOf('press-keys', 'keys'), 'mouse1') === '' && fieldValue(fieldOf('press-keys', 'keys'), 'lbutton') === '');
check('a box from before "How" listens as it did', fieldValue(fieldOf('on-hotkey', 'listen'), undefined) === 'take');

// Timelines, as the Warframe melee slide is laid out: W held unless it already
// is, Ctrl held over a tap of E.
const slide = parseTimeline(
  JSON.stringify([
    { keys: 'W', at: 0, until: 85, ifUp: true },
    { keys: 'Control', at: 20, until: 80 },
    { keys: 'e', at: 40, until: 50 },
  ])
);
check(
  'a timeline keeps each key, its times, and "only if not held"',
  JSON.stringify(slide) ===
    JSON.stringify([
      { keys: 'w', at: 0, until: 85, ifUp: true },
      { keys: 'ctrl', at: 20, until: 80 },
      { keys: 'e', at: 40, until: 50 },
    ]) && timelineLength(slide) === 85,
  JSON.stringify(slide)
);
const cleaned = parseTimeline([{ keys: 'banana', at: -5, until: -9 }, { keys: 'e', at: 30.6, until: 99999 }, 'junk']);
check(
  '  ...and cleans what it is given: times in range and whole, a key it does not know left empty',
  JSON.stringify(cleaned) === JSON.stringify([{ keys: '', at: 0, until: 1 }, { keys: 'e', at: 31, until: 10000 }]),
  JSON.stringify(cleaned)
);
check('  ...a row with no key is not played', playable(cleaned).length === 1);
check('  ...and what is not a timeline is an empty one', parseTimeline('{').length === 0 && parseTimeline('').length === 0);
check('  ...with at most 24 rows', parseTimeline(Array.from({ length: 40 }, () => ({ keys: 'e', at: 0, until: 5 }))).length === 24);
// Played through a fake keyboard: what goes down and up, and when.
const played = async (bars: unknown, holding: string[]) => {
  const log: string[] = [];
  let now = 0;
  await runTimeline(bars, {
    held: (keys) => holding.includes(keys),
    press: (keys, down) => log.push(`${now} ${keys} ${down ? 'down' : 'up'}`),
    at: async (ms) => {
      now = ms;
    },
  });
  return log.join(', ');
};
check(
  'the slide presses W, then Ctrl 20ms later, as the script did',
  (await played(slide, [])) === '0 w down, 20 ctrl down, 40 e down, 50 e up, 80 ctrl up, 85 w up',
  await played(slide, [])
);
check(
  '  ...and holding W yourself leaves W alone and skips the wait it began',
  (await played(slide, ['w'])) === '0 ctrl down, 20 e down, 30 e up, 60 ctrl up',
  await played(slide, ['w'])
);
const kept = slide.map((b) => (b.keys === 'w' ? { ...b, keepGap: true } : b));
check(
  '  ...unless the row keeps to the clock',
  (await played(kept, ['w'])) === '20 ctrl down, 40 e down, 50 e up, 80 ctrl up',
  await played(kept, ['w'])
);
check('  ...and the editor says by how much', soonerIfSkipped(slide, 0) === 20 && soonerIfSkipped(kept, 0) === 0 && soonerIfSkipped(slide, 1) === 0);
check(
  'a key ending where its next press begins is let go and pressed again',
  (await played([{ keys: 'e', at: 0, until: 10 }, { keys: 'e', at: 10, until: 20 }], [])) === '0 e down, 10 e up, 10 e down, 20 e up'
);
// Searching for a box, by what you would call it.
const first = (q: string) => searchBoxes(q)[0]?.spec.type;
check('"while playing" finds Am I…', first('while playing') === 'if-doing', String(first('while playing')));
check('  ...and so do "if playing" and "Am I"', first('if playing') === 'if-doing' && first('Am I') === 'if-doing');
check('  ...and says it was by another word', searchBoxes('while playing')[0]?.because === 'while playing');
check('a name beats another word: "nudge" finds Nudge me first', first('nudge') === 'nudge');
check('"reload" finds the Counter', first('reload') === 'counter', String(first('reload')));
check('"random" finds the Random number', first('random') === 'random-number', String(first('random')));
check('"remind" finds Nudge me', first('remind') === 'nudge', String(first('remind')));
check('"afk" finds leaving the PC', first('afk') === 'on-away', String(first('afk')));
check('a word found inside a box counts: "mouse" finds the hotkey', first('mouse') === 'on-hotkey', String(first('mouse')));
check('one letter is not a match on every other word', searchBoxes('a').length < searchBoxes('').length);
check('nothing matches nonsense', searchBoxes('zzqq').length === 0);
check('an empty search lists every box', searchBoxes('').length === NODES.length);
check('a press box keeps its timeline as text', fieldValue(fieldOf('press-keys', 'timeline'), [{ keys: 'E', at: 0, until: 5 }]) === '[{"keys":"e","at":0,"until":5}]');
const gap = specOf('repeat')!.fields[0]!;
check('a repeat takes thousandths', fieldValue(gap, 0.25) === 0.25 && fieldValue(gap, 1.5) === 1.5 && fieldValue(gap, 0.0254) === 0.025 && fieldValue(gap, 0) === 0.001);

console.log('\nLogic gates');
check(
  'AND, OR, NAND, NOR, XOR',
  gate('and', [true, true]) && !gate('and', [true, false]) && gate('or', [false, true]) && !gate('or', [false, false]) &&
    gate('nand', [true, false]) && !gate('nand', [true, true]) && gate('nor', [false, false]) && !gate('nor', [true, false]) &&
    gate('xor', [true, false, false]) && !gate('xor', [true, true, false])
);
check('NOR of one is NOT', gate('nor', [false]) && !gate('nor', [true]));
const answers = (yes: Record<string, boolean>, log: string[] = []): Effects => ({
  check: async (node) => {
    log.push(node.id);
    return { yes: yes[node.id] ?? false, said: String(yes[node.id]) };
  },
  act: async (node) => {
    log.push(`do ${node.id}`);
    return `did ${node.id}`;
  },
});
const gated = (op: string, inputs = 2) =>
  cleanGraph({
    nodes: [
      { id: 'go', type: 'on-button', fields: {} },
      { id: 'g', type: 'logic-gate', fields: { op, inputs } },
      { id: 'a', type: 'if-day', fields: {} },
      { id: 'b', type: 'if-time', fields: {} },
      { id: 'yes', type: 'nudge', fields: { title: 'y' } },
      { id: 'no', type: 'nudge', fields: { title: 'n' } },
    ],
    wires: [
      { from: 'go', pin: 'then', to: 'g' },
      { from: 'a', pin: 'value', to: 'g', port: 'c0' },
      { from: 'b', pin: 'value', to: 'g', port: 'c1' },
      { from: 'g', pin: 'yes', to: 'yes' },
      { from: 'g', pin: 'no', to: 'no' },
    ],
  });
const andGraph = gated('and');
check('an answer wire into a gate input is kept', andGraph.wires.filter((w) => w.port).length === 2);
const andLog: string[] = [];
await walk(andGraph, 'go', answers({ a: true, b: true }, andLog));
check('AND of yes and yes goes yes, asking both', andLog.join() === 'a,b,do yes', andLog.join());
const orLog: string[] = [];
const orSteps = await walk(gated('or'), 'go', answers({ a: false, b: true }, orLog));
const orSaid = orSteps.find((s) => s.node === 'g')!.said;
check('OR of no and yes goes yes', orLog.at(-1) === 'do yes', orLog.join());
check('and the gate says which said what', /A no, B yes: yes/.test(orSaid), orSaid);
const norLog: string[] = [];
await walk(gated('nor'), 'go', answers({ a: false, b: true }, norLog));
check('NOR with one yes goes no', norLog.at(-1) === 'do no', norLog.join());
check('a check wired only into a gate is reached', unreachable(andGraph).size === 0);
const extra = cleanGraph({
  ...andGraph,
  wires: [
    ...andGraph.wires,
    { from: 'yes', pin: 'then', to: 'a', port: 'c0' },
    { from: 'a', pin: 'value', to: 'yes', port: 'c0' },
    { from: 'b', pin: 'value', to: 'g', port: 'c0' },
  ],
});
check('an answer only goes into a gate, one per input', extra.wires.filter((w) => w.port).length === 2 && extra.wires.every((w) => !(w.from === 'a' && w.to === 'yes')));

console.log('\nNumbers: a Random number into a Counter');
const numbered = cleanGraph({
  nodes: [
    { id: 'go', type: 'on-button', fields: {} },
    { id: 'c', type: 'counter', fields: { times: 3 } },
    { id: 'r', type: 'random-number', fields: { min: 8, max: 16 } },
    { id: 'd', type: 'if-day', fields: {} },
    { id: 'g', type: 'logic-gate', fields: { op: 'and', inputs: 1 } },
    { id: 'yes', type: 'nudge', fields: { title: 'y' } },
  ],
  wires: [
    { from: 'go', pin: 'then', to: 'c' },
    { from: 'r', pin: 'value', to: 'c', port: 'x' },
    { from: 'c', pin: 'yes', to: 'yes' },
    // Crossed: a number into a gate's letter, an answer into X, and a run led into the random number.
    { from: 'r', pin: 'value', to: 'g', port: 'c0' },
    { from: 'd', pin: 'value', to: 'c', port: 'x' },
    { from: 'yes', pin: 'then', to: 'r' },
  ],
});
check('a number wire into X is kept', numbered.wires.some((w) => w.from === 'r' && w.port === 'x'));
check('  ...and a number never goes into a gate, nor an answer into X', !numbered.wires.some((w) => (w.from === 'r' && w.to === 'g') || (w.from === 'd' && w.to === 'c')));
check('  ...and no run leads into a Random number', !numbered.wires.some((w) => w.to === 'r' && !w.port));
check('a Random number wired into a Counter is reached', !unreachable(numbered).has('r'));
const askedFor: Array<number | null> = [];
const countSteps = await walk(numbered, 'go', {
  check: async (node, _spec, inputs) => {
    askedFor.push(await inputs.number('x'));
    return { yes: true, said: 'numbered' };
  },
  number: async () => 11,
  act: async () => 'done',
});
check('a Counter asks its X of the Random number wired in', askedFor.join() === '11', askedFor.join());
check('  ...which says what it picked', countSteps.some((st) => st.node === 'r' && /Picked 11, between 8 and 16/.test(st.said)), JSON.stringify(countSteps));
const unwired: Array<number | null> = [];
await walk(cleanGraph({ ...numbered, wires: numbered.wires.filter((w) => w.from !== 'r') }), 'go', {
  check: async (_node, _spec, inputs) => {
    unwired.push(await inputs.number('x'));
    return { yes: false, said: '' };
  },
  act: async () => 'done',
});
check('  ...and gets nothing with nothing wired in', unwired.join() === '' && unwired.length === 1 && unwired[0] === null);
let picked = 0;
for (let k = 0; k < 200; k += 1) {
  const st = await walk(numbered, 'go', { check: async (_n, _s, inputs) => ({ yes: (await inputs.number('x'))! >= 8, said: '' }), act: async () => '' });
  if (st.some((x) => x.result === 'yes')) picked += 1;
}
check('with no number of its own given, a Random number picks between its ends', picked === 200);

// The box that was both, until now, is read as the two.
const oldEvery = cleanGraph({
  nodes: [
    { id: 'go', type: 'on-button', x: 0, y: 0, fields: {} },
    { id: 'every', type: 'if-every', x: 600, y: 200, fields: { min: 8, max: 16 } },
    { id: 'exact', type: 'if-every', x: 600, y: 500, fields: { min: 5, max: 5 } },
    { id: 'two', type: 'press-keys', x: 900, y: 200, fields: { mode: 'one', keys: '2' } },
  ],
  wires: [
    { from: 'go', pin: 'then', to: 'every' },
    { from: 'every', pin: 'yes', to: 'two' },
    { from: 'every', pin: 'no', to: 'exact' },
  ],
});
const oldCounter = oldEvery.nodes.find((n) => n.id === 'every');
const oldRandom = oldEvery.nodes.find((n) => n.type === 'random-number');
check('an old "Every so many times" becomes a Counter, keeping its id and wires', oldCounter?.type === 'counter' && oldEvery.wires.some((w) => w.from === 'every' && w.pin === 'yes' && w.to === 'two'));
check('  ...with a Random number from 8 to 16 wired into X', oldRandom?.fields.min === 8 && oldRandom.fields.max === 16 && oldEvery.wires.some((w) => w.from === oldRandom.id && w.to === 'every' && w.port === 'x'));
check('  ...and one that was exactly 5 is a Counter of 5 alone', oldEvery.nodes.find((n) => n.id === 'exact')?.fields.times === 5 && oldEvery.nodes.filter((n) => n.type === 'random-number').length === 1);
check('  ...and reading it again changes nothing', JSON.stringify(cleanGraph(oldEvery)) === JSON.stringify(oldEvery));
const oneInput = cleanGraph({ ...andGraph, nodes: andGraph.nodes.map((n) => (n.id === 'g' ? { ...n, fields: { ...n.fields, inputs: 1 } } : n)) });
check('a gate cut to one input loses the wire into B', oneInput.wires.filter((w) => w.port).length === 1);
const empty = cleanGraph({
  nodes: [{ id: 'go', type: 'on-button', fields: {} }, { id: 'g', type: 'logic-gate', fields: {} }],
  wires: [{ from: 'go', pin: 'then', to: 'g' }],
});
const emptySteps = await walk(empty, 'go', answers({}));
check('a gate with nothing wired in fails and says so', emptySteps.at(-1)!.result === 'failed' && /Nothing is wired/.test(emptySteps.at(-1)!.said));
const circle = cleanGraph({
  nodes: [
    { id: 'go', type: 'on-button', fields: {} },
    { id: 'g', type: 'logic-gate', fields: { inputs: 1 } },
    { id: 'h', type: 'logic-gate', fields: { inputs: 1 } },
  ],
  wires: [
    { from: 'go', pin: 'then', to: 'g' },
    { from: 'h', pin: 'value', to: 'g', port: 'c0' },
    { from: 'g', pin: 'value', to: 'h', port: 'c0' },
  ],
});
const circleSteps = await walk(circle, 'go', answers({}));
check('gates feeding each other fail rather than hang', circleSteps.at(-1)!.result === 'failed' && /circle/.test(circleSteps.at(-1)!.said));

console.log('\nSequence and repeat');
const seq = cleanGraph({
  nodes: [
    { id: 'go', type: 'on-button', fields: {} },
    { id: 's', type: 'sequence', fields: { outputs: 3 } },
    { id: 'one', type: 'nudge', fields: { title: '1' } },
    { id: 'one-b', type: 'nudge', fields: { title: '1b' } },
    { id: 'two', type: 'nudge', fields: { title: '2' } },
    { id: 'three', type: 'nudge', fields: { title: '3' } },
  ],
  wires: [
    { from: 'go', pin: 'then', to: 's' },
    { from: 's', pin: 'then0', to: 'one' },
    { from: 'one', pin: 'then', to: 'one-b' },
    { from: 's', pin: 'then1', to: 'two' },
    { from: 's', pin: 'then2', to: 'three' },
  ],
});
const seqLog: string[] = [];
await walk(seq, 'go', answers({}, seqLog));
check('a sequence runs each way out to its end, in order', seqLog.join() === 'do one,do one-b,do two,do three', seqLog.join());
const twoOuts = cleanGraph({ ...seq, nodes: seq.nodes.map((n) => (n.id === 's' ? { ...n, fields: { outputs: 2 } } : n)) });
check('a sequence cut to two outputs loses Then 3', twoOuts.wires.length === 4);
const repeating = (fields: Record<string, string | number>) =>
  cleanGraph({
    nodes: [
      { id: 'go', type: 'on-button', fields: {} },
      { id: 'r', type: 'repeat', fields },
      { id: 'press', type: 'note-line', fields: { line: 'go {count}' } },
      { id: 'after', type: 'nudge', fields: { title: 'done' } },
    ],
    wires: [
      { from: 'go', pin: 'then', to: 'r' },
      { from: 'r', pin: 'each', to: 'press' },
      { from: 'r', pin: 'done', to: 'after' },
    ],
  });
const gaps: number[] = [];
const counts: string[] = [];
const repeatVars: Record<string, string> = {};
const repeatLog: string[] = [];
const repeatSteps = await walk(
  repeating({ every: 2, unit: 'seconds', until: 'count', times: 5, first: 'now' }),
  'go',
  {
    ...answers({}),
    act: async (node) => {
      repeatLog.push(node.id);
      if (node.id === 'press') counts.push(repeatVars.count!);
      return node.id;
    },
    pause: async (ms) => {
      gaps.push(ms);
    },
  },
  [],
  repeatVars
);
const repeatSaid = repeatSteps.find((s) => s.node === 'r')!.said;
check('a repeat goes the number of times, then carries on', repeatLog.join() === 'press,press,press,press,press,after', repeatLog.join());
check('with a gap between goes and none before the first', gaps.length === 4 && gaps.every((g) => g === 2000), gaps.join());
check('{count} counts the goes', counts.join() === '1,2,3,4,5', counts.join());
check('only the first few goes are written down step by step', repeatSteps.filter((s) => s.node === 'press').length === 3);
check('and the repeat says how many it went', /Went 5 times of 5, every 2 seconds/.test(repeatSaid), repeatSaid);
const waitFirst: number[] = [];
await walk(repeating({ every: 1, unit: 'minutes', until: 'count', times: 2, first: 'wait' }), 'go', {
  ...answers({}),
  pause: async (ms) => void waitFirst.push(ms),
});
check('"after one wait" waits before the first go too, in minutes', waitFirst.join() === '60000,60000', waitFirst.join());
let goes = 0;
const stopSteps = await walk(repeating({ every: 0.1, unit: 'seconds', until: 'stopped', first: 'now' }), 'go', {
  ...answers({}),
  act: async () => {
    goes += 1;
    return 'pressed';
  },
  pause: async () => {
    if (goes >= 7) throw new RunStopped('Stopped: ctrl+alt+m was pressed again.');
  },
});
check('until stopped goes until it is stopped', goes === 7, String(goes));
check('and being stopped ends the run as stopped, not failed', stopSteps.at(-1)!.result === 'stopped' && /pressed again/.test(stopSteps.at(-1)!.said));
const tried: string[] = [];
const rehearsed = await walk(repeating({ every: 1, unit: 'seconds', until: 'stopped' }), 'go', {
  ...answers({}, tried),
  rehearsal: true,
  pause: async () => {
    throw new Error('a test must not pause');
  },
});
check(
  'a test of a repeat tries three goes, without the gaps',
  tried.filter((t) => t === 'do press').length === 3 && /tried the first 3/.test(rehearsed.find((s) => s.node === 'r')!.said)
);
let asked = 0;
const halted = await walk(seq, 'go', {
  ...answers({}),
  alive: () => {
    if (++asked > 2) throw new RunStopped('Stopped from the Blueprints screen.');
  },
});
check('a run stopped between boxes ends there', halted.at(-1)!.result === 'stopped' && halted.filter((s) => s.result === 'done').length === 2, halted.map((s) => s.result).join());

console.log('\nVoice commands');
check(
  'phrases are one a line, blank lines and repeats dropped',
  phrasesOf({ phrases: 'drink water\n\n  I had some   water \nDrink Water' }).join('|') === 'drink water|I had some water'
);
check('an "I say" box gives what was said after it, and how many', specOf('on-voice')!.gives!.map((g) => g.key).join() === 'said,amount');
const howMany = specOf('tick-habit')!.fields.find((f) => f.key === 'howMany')!;
check('"Tick a habit" ticks a fixed number unless told to count what was said', howMany.default === 'fixed');
const gameField = specOf('launch-game')!.fields[0]!;
check('a game is a name off the list, never a path', fieldValue(gameField, 'FSD.exe') === 'fsd.exe' && fieldValue(gameField, 'C:\\Windows\\cmd.exe') === '' && fieldValue(gameField, '../x.exe') === '');
const old = (kind: string, target: string | null, extra: Partial<OldCommand> = {}): OldCommand => ({
  id: kind,
  kind,
  phrases: ['say this'],
  target,
  label: null,
  enabled: true,
  allowFollowUp: true,
  ...extra,
});
const into = (command: OldCommand) => {
  const g = graphFor(command);
  return g ? g.nodes.map((n) => `${n.type}${n.type === 'on-voice' ? '' : `(${Object.values(n.fields).join(',')})`}`).join(' > ') : 'none';
};
check('a habit command becomes "I say" then a tick, counting what was said', into(old('habit', 'h1')) === 'on-voice > tick-habit(h1,said,1)', into(old('habit', 'h1')));
check('a website command opens it', into(old('url', 'https://example.com/a')) === 'on-voice > open-url(https://example.com/a)');
check('a hotkey command presses it', into(old('hotkey', 'alt+m')) === 'on-voice > press-keys(one,alt+m,30,[])', into(old('hotkey', 'alt+m')));
check('a media command presses the media key', into(old('media', 'next')) === 'on-voice > media(next)');
check('a launch command starts the game by its name', into(old('launch', 'Warframe.x64.exe')) === 'on-voice > launch-game(warframe.x64.exe)');
check('"queue" music plays shuffled, as it has for a while', into(old('music', 'queue')) === 'on-voice > play-music(shuffle)');
check('a note command makes a new note of what was said', into(old('note', null)) === 'on-voice > new-note({said})');
check('stop listening and never mind stay with voice', into(old('pause', null)) === 'none' && into(old('cancel', null)) === 'none');
check('no phrases, no blueprint', into(old('url', 'https://example.com', { phrases: [] })) === 'none');
const noFollow = graphFor(old('hotkey', 'alt+n', { allowFollowUp: false }))!;
check('"no continuations" becomes stop listening afterwards', noFollow.nodes[0]!.fields.keep === 'no');
check('the converted graph is joined up', unreachable(noFollow).size === 0 && noFollow.wires.length === 1);
check('a converted command keeps its own name', nameFor(old('media', 'next', { label: 'Skip' })) === 'Skip');
check('an address for a name becomes the site', nameFor(old('url', 'https://www.youtube.com/playlist?list=x', { label: 'open https://www.youtube.com/playlist?list=x' })) === 'Open youtube.com');
check('a game is named from the games list', nameFor(old('launch', 'warframe.x64.exe', { label: 'start Warframe' }), undefined, 'Warframe') === 'Start Warframe');
check('a habit is named after the habit', nameFor(old('habit', 'h1'), 'Drink water') === 'Drink water');

console.log('\nMaths, the Desmos way');
const sum = (src: string, letters: Record<string, number> = {}, words: Record<string, number | string> = {}) =>
  evaluate(src, { letter: (l) => letters[l], word: (w) => words[w] });
const throws = (f: () => unknown) => {
  try {
    f();
    return '';
  } catch (error) {
    return (error as Error).message;
  }
};
check('the order of operations', sum('1 + 2 * 3') === 7 && sum('(1 + 2) * 3') === 9 && sum('2^3^2') === 512 && sum('-2^2') === -4);
check('side by side multiplies', sum('2a', { a: 5 }) === 10 && sum('3(a + 1)', { a: 1 }) === 6 && sum('ab', { a: 2, b: 3 }) === 6 && sum('2pi') === 2 * Math.PI);
check('functions', sum('sqrt(16) + abs(-2) + round(2.5) + max(1, 9, 4)') === 4 + 2 + 3 + 9 && sum('round(3.14159, 2)') === 3.14);
check("mod has the divisor's sign, as Desmos's", sum('mod(-1, 3)') === 2);
check('% is a percentage, as Desmos reads it', sum('50%') === 0.5 && sum('{hp} * 10%', {}, { hp: 80 }) === 8 && sum('a%', { a: 25 }) === 0.25);
check('  ..."of" after one is times', sum('10% of 50') === 5 && sum('25% of {hp}', {}, { hp: 80 }) === 20);
check('  ...and side by side multiplies, as ever', sum('50% 4') === 2 && sum('200%^2') === 4);
check('"of" anywhere else is refused, saying where it goes', throws(() => sum('3 of 4')).includes('after a percentage'));
check('degrees by deg', Math.abs(sum('sin(30deg)') - 0.5) < 1e-12);
check('comparisons are 1 or 0', sum('3 > 2') === 1 && sum('3 <= 2') === 0 && sum('0.1 + 0.2 = 0.3') === 1 && sum('2 ≠ 2') === 0);
check('and, or, not', sum('1 > 0 and 2 > 1') === 1 && sum('0 or 0') === 0 && sum('not 0') === 1 && sum('!(1 = 1)') === 0);
check('{words} are variables and run words', sum('{score} * 2', {}, { score: 21 }) === 42 && sum('{count} + 1', {}, { count: '4' }) === 5);
check('a word that is words is refused, saying so', throws(() => sum('{game} + 1', {}, { game: 'Warframe' })).includes('not a number'));
check('a word with no value is refused, saying so', throws(() => sum('{nope}')).includes('has no value'));
check('a letter with nothing wired is refused, saying so', throws(() => sum('a + 1')).includes('Nothing is wired into a'));
check('dividing by zero says so rather than giving Infinity', throws(() => sum('1 / 0')).includes('infinite'));
check('e is Euler, not a letter', lettersOf('e + a') .join() === 'a' && Math.abs(sum('e') - Math.E) < 1e-12);
check('the letters a sum uses, in order', lettersOf('b + 2a + sqrt(c) + b').join() === 'a,b,c');
check('a sum half typed keeps its letters, so their wires stay', lettersOf('a + b *').join() === 'a,b' && lettersOf('sqrt(a) + {b').join() === 'a');
const bad = parseMath('2 + (3');
check('an unclosed bracket is read as wrong, and where', !bad.ok && bad.error.includes('never closed'));
check('nothing outside it can be reached', !parseMath('process.exit()').ok && !parseMath('constructor').ok && !parseMath('a; b').ok);
check('a function name needs brackets', !parseMath('sin 30').ok);
check('more than eight letters is refused', !parseMath('a+b+c+d+f+g+h+i+j').ok);
check('numbers are written plainly', formatNumber(0.1 + 0.2) === '0.3' && formatNumber(-0) === '0' && formatNumber(12) === '12');

console.log('\nNumbers wired into boxes');
const waitBox = { type: 'wait', fields: { minutes: 1, unit: 'seconds' } };
check('a number a box is filled in with has a way in', inputsOf(waitBox).some((p) => p.id === fieldPort('minutes') && p.number));
check("but not a gate's count of inputs, or a Counter's (X does that)", !inputsOf({ type: 'logic-gate', fields: { op: 'and', inputs: 2 } }).some((p) => p.id.startsWith('f-')) && !inputsOf({ type: 'counter', fields: { times: 3 } }).some((p) => p.id === fieldPort('times')));
check('nor a When box, which starts before any run has a number', inputsOf({ type: 'on-every', fields: { every: 5 } }).length === 0);
check('a hidden field has none', !inputsOf({ type: 'tick-habit', fields: { habit: 'h', howMany: 'said', amount: 1 } }).some((p) => p.id === fieldPort('amount')));
check("a Math box grows a way in per letter", inputsOf({ type: 'math', fields: { expr: 'a * b' } }).map((p) => p.id).join() === `${letterPort('a')},${letterPort('b')}`);
const mathGraph = cleanGraph({
  nodes: [
    { id: 'go', type: 'on-button', x: 0, y: 0, fields: {} },
    { id: 'n', type: 'random-number', x: 0, y: 200, fields: { min: 4, max: 4 } },
    { id: 'm', type: 'math', x: 0, y: 400, fields: { expr: 'a * 3 + {bonus}' } },
    { id: 'w', type: 'wait', x: 300, y: 0, fields: { minutes: 30, unit: 'seconds' } },
    { id: 't', type: 'if-true', x: 600, y: 0, fields: { expr: 'a > 10' } },
    { id: 'done', type: 'nudge', x: 900, y: 0, fields: { title: 'big' } },
  ],
  wires: [
    { id: 'w1', from: 'go', pin: 'then', to: 'w' },
    { id: 'w2', from: 'n', pin: 'value', to: 'm', port: letterPort('a') },
    { id: 'w3', from: 'm', pin: 'value', to: 'w', port: fieldPort('minutes') },
    { id: 'w4', from: 'w', pin: 'then', to: 't' },
    { id: 'w5', from: 'm', pin: 'value', to: 't', port: letterPort('a') },
    { id: 'w6', from: 't', pin: 'yes', to: 'done' },
    // A number cannot go into a gate's letter, nor into the head.
    { id: 'w7', from: 'n', pin: 'value', to: 'done' },
  ],
});
check('number wires are kept where they fit, and only there', mathGraph.wires.length === 6, `${mathGraph.wires.length} wires`);
const acted: string[] = [];
const mathSteps = await walk(mathGraph, 'go', {
  async check() {
    return { yes: true, said: '' };
  },
  async act(node) {
    acted.push(`${node.type}:${node.fields.minutes ?? node.fields.title}`);
    return 'done';
  },
  variable: (name) => (name === 'bonus' ? 2 : undefined),
});
check('a wired number is used in place of the typed one', acted[0] === 'wait:14', acted.join());
check('and the comparison after it reads the same sum', acted[1] === 'nudge:big', acted.join());
check('the sum says what went into it', mathSteps.some((s) => s.node === 'm' && s.said === 'a * 3 + {bonus} = 14 (a is 4, {bonus} is 2)'), mathSteps.map((s) => s.said).join(' | '));
const clampGraph = cleanGraph({
  nodes: [
    { id: 'go', type: 'on-button', x: 0, y: 0, fields: {} },
    { id: 'm', type: 'math', x: 0, y: 200, fields: { expr: '999999' } },
    { id: 'w', type: 'wait', x: 300, y: 0, fields: { minutes: 30, unit: 'minutes' } },
  ],
  wires: [
    { id: 'w1', from: 'go', pin: 'then', to: 'w' },
    { id: 'w2', from: 'm', pin: 'value', to: 'w', port: fieldPort('minutes') },
  ],
});
const clamped: number[] = [];
await walk(clampGraph, 'go', { check: async () => ({ yes: true, said: '' }), act: async (n) => (clamped.push(Number(n.fields.minutes)), 'ok') });
check('a wired number is kept to what the field allows', clamped[0] === 100000, String(clamped[0]));
const brokenSum = cleanGraph({
  nodes: [
    { id: 'go', type: 'on-button', x: 0, y: 0, fields: {} },
    { id: 't', type: 'if-true', x: 300, y: 0, fields: { expr: 'b > 1' } },
  ],
  wires: [{ id: 'w1', from: 'go', pin: 'then', to: 't' }],
});
const brokenSumSteps = await walk(brokenSum, 'go', { check: async () => ({ yes: true, said: '' }), act: async () => 'ok' });
check('a letter left unwired fails the run, saying which', brokenSumSteps.at(-1)?.result === 'failed' && brokenSumSteps.at(-1)!.said.includes('Nothing is wired into b'));
const askGraph = cleanGraph({
  nodes: [
    { id: 'go', type: 'on-button', x: 0, y: 0, fields: {} },
    { id: 'q', type: 'ask', x: 300, y: 0, fields: { title: 'Score?' } },
    { id: 'yes', type: 'nudge', x: 600, y: 0, fields: { title: 'answered' } },
    { id: 'no', type: 'nudge', x: 600, y: 200, fields: { title: 'silent' } },
  ],
  wires: [
    { id: 'w1', from: 'go', pin: 'then', to: 'q' },
    { id: 'w2', from: 'q', pin: 'answered', to: 'yes' },
    { id: 'w3', from: 'q', pin: 'none', to: 'no' },
  ],
});
const askRoute: string[] = [];
await walk(askGraph, 'go', {
  check: async () => ({ yes: true, said: '' }),
  act: async (n) => (n.type === 'ask' ? { said: 'No answer', pin: 'none' } : (askRoute.push(String(n.fields.title)), 'ok')),
});
check('"Ask me" leaves by the way it says', askRoute.join() === 'silent', askRoute.join());
check('a box keeps a colour of its own, and only a colour', cleanGraph({ nodes: [{ id: 'a', type: 'wait', x: 0, y: 0, fields: {}, color: '#FF0000' }, { id: 'b', type: 'wait', x: 0, y: 0, fields: {}, color: 'red;x' }], wires: [] }).nodes.map((n) => n.color ?? '-').join() === '#ff0000,-');
check('a colour field takes #rrggbb or nothing', fieldValue(specOf('show-popup')!.fields.find((f) => f.key === 'color')!, '#AbCdEf') === '#abcdef' && fieldValue(specOf('show-popup')!.fields.find((f) => f.key === 'color')!, 'javascript:') === '');
check('every box can be found by search', NODES.every((n) => searchBoxes(n.label)[0]?.spec.type === n.type || searchBoxes(n.label).some((f) => f.spec.type === n.type)));
check('"calculate" finds Math, "variable" finds both variable boxes, "input" finds Ask me', first('calculate') === 'math' && ['variable', 'set-variable'].every((t) => searchBoxes('variable').slice(0, 2).some((f) => f.spec.type === t)) && searchBoxes('text box').some((f) => f.spec.type === 'ask'));
check('a Repeat goes in milliseconds, kept to at least one', everyMs({ every: 25, unit: 'ms' }) === 25 && everyMs({ every: 0.0001, unit: 'ms' }) === 1 && everyMs({ every: 0.05, unit: 'seconds' }) === 50 && everyLabel({ every: 25, unit: 'ms' }) === '25 milliseconds');
const varGraph = cleanGraph({
  nodes: [
    { id: 'go', type: 'on-button', x: 0, y: 0, fields: {} },
    { id: 'v', type: 'variable', x: 0, y: 200, fields: { name: 'HP Left' } },
    { id: 'w', type: 'wait', x: 300, y: 0, fields: { minutes: 1, unit: 'ms' } },
  ],
  wires: [
    { id: 'w1', from: 'go', pin: 'then', to: 'w' },
    { id: 'w2', from: 'v', pin: 'value', to: 'w', port: fieldPort('minutes') },
  ],
});
check('a Variable box is never marked as not joined: it is read by its name', !unreachable(varGraph).has('v') && !unreachable(cleanGraph({ nodes: [{ id: 'v', type: 'variable', x: 0, y: 0, fields: { name: 'x' } }], wires: [] })).has('v'));
check('the Variable box has no way in and gives a number', inputsOf(varGraph.nodes[1]!).length === 0 && varGraph.wires.length === 2);
const varActed: number[] = [];
const varSteps = await walk(varGraph, 'go', {
  check: async () => ({ yes: true, said: '' }),
  act: async (n) => (varActed.push(Number(n.fields.minutes)), 'ok'),
  variable: (name) => (name === 'hp_left' ? '42' : undefined),
});
check('  ...what the variable holds, by its tidied name', varActed[0] === 42 && varSteps.some((s) => s.said === '{hp_left} is 42'), JSON.stringify(varSteps));
const unset = await walk(varGraph, 'go', { check: async () => ({ yes: true, said: '' }), act: async () => 'ok', variable: () => undefined });
check('  ...and a variable not set yet fails the run, saying so', unset.at(-1)?.result === 'failed' && /not set yet/.test(unset.at(-1)!.said));

console.log('\nSeveral wires from one way out');
const fan = cleanGraph({
  nodes: [
    { id: 'go', type: 'on-button', x: 0, y: 0, fields: {} },
    { id: 'low', type: 'nudge', x: 300, y: 400, fields: { title: 'second' } },
    { id: 'high', type: 'nudge', x: 300, y: 0, fields: { title: 'first' } },
    { id: 'after', type: 'nudge', x: 600, y: 0, fields: { title: 'then this' } },
  ],
  wires: [
    { id: 'w1', from: 'go', pin: 'then', to: 'low' },
    { id: 'w2', from: 'go', pin: 'then', to: 'high' },
    { id: 'w3', from: 'high', pin: 'then', to: 'after' },
  ],
});
check('a way out keeps every wire it has', fan.wires.filter((w) => w.from === 'go').length === 2);
check('they are listed top to bottom, by where the boxes sit', nextAll(fan, 'go', 'then').join() === 'high,low');
const fanned: string[] = [];
await walk(fan, 'go', {
  check: async () => ({ yes: true, said: '' }),
  // The top one is slow: the bottom one must not wait for it.
  act: async (n) => {
    if (n.fields.title === 'first') await new Promise((r) => setTimeout(r, 40));
    fanned.push(String(n.fields.title));
    return 'ok';
  },
});
check('they all start at once: one that takes its time holds up none of the others', fanned.join() === 'second,first,then this', fanned.join());
const afterFail: string[] = [];
const failFan = cleanGraph({
  nodes: [
    { id: 'go', type: 'on-button', x: 0, y: 0, fields: {} },
    { id: 'slow', type: 'wait', x: 300, y: 0, fields: { minutes: 1 } },
    { id: 'more', type: 'nudge', x: 600, y: 0, fields: { title: 'after the wait' } },
    { id: 'bad', type: 'nudge', x: 300, y: 300, fields: { title: 'fails' } },
  ],
  wires: [
    { id: 'a', from: 'go', pin: 'then', to: 'slow' },
    { id: 'b', from: 'slow', pin: 'then', to: 'more' },
    { id: 'c', from: 'go', pin: 'then', to: 'bad' },
  ],
});
let wake: () => void = () => {};
const failSteps = await walk(failFan, 'go', {
  check: async () => ({ yes: true, said: '' }),
  act: async (n) => {
    if (n.type === 'wait') {
      await new Promise<void>((r) => (wake = r));
      return 'waited';
    }
    if (n.fields.title === 'fails') throw new Error('it went wrong');
    afterFail.push(String(n.fields.title));
    return 'ok';
  },
  halt: () => wake(),
});
check('one failing ends the others, waking one that waits, and nothing after it runs', failSteps.at(-1)?.result === 'failed' && failSteps.filter((s) => s.result === 'failed').length === 1 && afterFail.length === 0, JSON.stringify(failSteps));

console.log('\nLoops that go round for ever');
const box = (id: string, type: string, y = 0, fields: Record<string, string | number> = {}) => ({ id, type, x: 0, y, fields });
const spin = cleanGraph({
  nodes: [box('go', 'on-button'), box('a', 'nudge', 0, { title: 'a' }), box('b', 'note-line', 100)],
  wires: [{ id: '1', from: 'go', pin: 'then', to: 'a' }, { id: '2', from: 'a', pin: 'then', to: 'b' }, { id: '3', from: 'b', pin: 'then', to: 'a' }],
});
check('a loop with nothing waiting in it is a danger', loopWarnings(spin).some((w) => w.level === 'danger' && w.nodes.includes('a') && w.nodes.includes('b')));
const forever = cleanGraph({
  nodes: [box('go', 'on-button'), box('a', 'nudge', 0, { title: 'a' }), box('w', 'wait', 100)],
  wires: [{ id: '1', from: 'go', pin: 'then', to: 'a' }, { id: '2', from: 'a', pin: 'then', to: 'w' }, { id: '3', from: 'w', pin: 'then', to: 'a' }],
});
check('one that waits with no way out goes until stopped', loopWarnings(forever).map((w) => w.level).join() === 'warn');
const held = cleanGraph({
  nodes: [box('go', 'on-hotkey'), box('p', 'press-keys', 0, { keys: 'e' }), box('w', 'wait', 100), box('h', 'if-held', 200, { keys: 'e' })],
  wires: [
    { id: '1', from: 'go', pin: 'then', to: 'p' },
    { id: '2', from: 'p', pin: 'then', to: 'w' },
    { id: '3', from: 'w', pin: 'then', to: 'h' },
    { id: '4', from: 'h', pin: 'yes', to: 'p' },
  ],
});
check('"again while I hold it", which waits and can leave, is not warned about', loopWarnings(held).length === 0, JSON.stringify(loopWarnings(held)));
const repeatLoop = cleanGraph({
  nodes: [box('go', 'on-button'), box('r', 'repeat'), box('w', 'wait', 100)],
  wires: [{ id: '1', from: 'go', pin: 'then', to: 'r' }, { id: '2', from: 'r', pin: 'each', to: 'w' }, { id: '3', from: 'w', pin: 'then', to: 'r' }],
});
check('a Repeat wired back into itself is a danger, waits or not', loopWarnings(repeatLoop).some((w) => w.level === 'danger'));
const blocked = cleanGraph({
  nodes: [box('go', 'on-button'), box('a', 'nudge', 0, { title: 'a' }), box('w', 'wait', 100), box('later', 'nudge', 300, { title: 'never' })],
  wires: [
    { id: '1', from: 'go', pin: 'then', to: 'a' },
    { id: '2', from: 'go', pin: 'then', to: 'later' },
    { id: '3', from: 'a', pin: 'then', to: 'w' },
    { id: '4', from: 'w', pin: 'then', to: 'a' },
  ],
});
check('a wire beside one into a loop that never ends is not warned about: it starts as well', !loopWarnings(blocked).some((w) => w.level === 'info'));
const ranBeside: string[] = [];
let besideGoes = 0;
const besideSteps = await walk(blocked, 'go', {
  check: async () => ({ yes: true, said: '' }),
  act: async (n) => (ranBeside.push(String(n.fields.title ?? n.type)), 'ok'),
  alive: () => {
    if (++besideGoes > 30) throw new RunStopped('Stopped by hand.');
  },
});
check('  ...and it does run, while the loop goes round until stopped', ranBeside.includes('never') && besideSteps.at(-1)?.result === 'stopped', ranBeside.slice(0, 6).join());
check('nothing is said about a graph with no loops', loopWarnings(fan).length === 0);
const tick = (id: string, name: string, habit: string, also: Graph['nodes'] = []) => ({
  id,
  name,
  enabled: true,
  graph: cleanGraph({ nodes: [box('go', 'on-task-added'), box('t', 'tick-habit', 0, { habit }), ...also], wires: [{ id: '1', from: 'go', pin: 'then', to: 't' }] }),
});
const hearsHabit = {
  id: 'b',
  name: 'B',
  enabled: true,
  graph: cleanGraph({ nodes: [box('go', 'on-habit', 0, { habit: 'water' }), box('t', 'add-task', 0, { title: 'Refill' })], wires: [{ id: '1', from: 'go', pin: 'then', to: 't' }] }),
};
const a = tick('a', 'A', 'water');
check('two blueprints that set each other off are found', chainsBack(a, [hearsHabit]).some((c) => c.names.join('>') === 'A>B>A'), JSON.stringify(chainsBack(a, [hearsHabit])));
check('  ...but not when the other is switched off', chainsBack(a, [{ ...hearsHabit, enabled: false }]).length === 0);
check('  ...nor when it hears another habit', chainsBack(tick('a', 'A', 'stretch'), [hearsHabit]).length === 0);
check('a blueprint setting off only itself is left out: a run never starts its own again', chainsBack(a, []).length === 0);

console.log('\nWhat a number on a wire comes to');
{
  const scope = { variables: { warcry: 123.5 } as Record<string, number | string>, placeholders: ['count'] };
  const melee: Graph = {
    nodes: [
      { id: 'anim', type: 'variable', x: 0, y: 0, fields: { name: 'anim', start: 0.8 } },
      { id: 'buff', type: 'variable', x: 0, y: 0, fields: { name: 'Warcry', start: 50 } },
      { id: 'sum', type: 'math', x: 0, y: 0, fields: { expr: '1.5*a*(1+b%)' } },
      { id: 'wait', type: 'wait', x: 0, y: 0, fields: { minutes: 1, unit: 'seconds' } },
    ],
    wires: [
      { id: 'w1', from: 'anim', pin: 'value', to: 'sum', port: letterPort('a') },
      { id: 'w2', from: 'buff', pin: 'value', to: 'sum', port: letterPort('b') },
      { id: 'w3', from: 'sum', pin: 'value', to: 'wait', port: fieldPort('minutes') },
    ],
  };
  const sum = previewSum(melee, melee.nodes[2], '1.5*a*(1+b%)', { ...scope, variables: { ...scope.variables, anim: 0.8 } });
  check('two variables into a sum give the one answer, with what they hold now', sum.kind === 'values' && sum.values.length === 1 && Math.abs(sum.values[0] - 2.682) < 1e-9, JSON.stringify(sum));
  const wait = previewField(melee, melee.nodes[3], 'minutes', { ...scope, variables: { ...scope.variables, anim: 0.8 } });
  check('  ...and the Wait it is wired into shows it, kept to its step', wait?.kind === 'values' && wait.values[0] === 2.682, JSON.stringify(wait));
  const asPct: Graph = {
    nodes: [
      { id: 'v', type: 'variable', x: 0, y: 0, fields: { name: 'buff', as: 'percent', start: 123.5 } },
      { id: 'm', type: 'math', x: 0, y: 0, fields: { expr: '1 + a' } },
    ],
    wires: [{ id: 'w', from: 'v', pin: 'value', to: 'm', port: letterPort('a') }],
  };
  const pct = previewSum(asPct, asPct.nodes[1], '1 + a', { variables: { buff: 123.5 }, placeholders: [] });
  check('a Variable box holding a percentage gives 123.5 as 1.235', pct.kind === 'values' && Math.abs(pct.values[0] - 2.235) < 1e-9, JSON.stringify(pct));
  const rolled: Graph = {
    nodes: [
      { id: 'r', type: 'random-number', x: 0, y: 0, fields: { min: 8, max: 16 } },
      { id: 'm', type: 'math', x: 0, y: 0, fields: { expr: 'a + 4' } },
      { id: 'sq', type: 'math', x: 0, y: 0, fields: { expr: '(a - 12)^2' } },
    ],
    wires: [
      { id: 'w1', from: 'r', pin: 'value', to: 'm', port: letterPort('a') },
      { id: 'w2', from: 'r', pin: 'value', to: 'sq', port: letterPort('a') },
    ],
  };
  const r = previewNumber(rolled, 'r', scope);
  check('a Random number of 8 to 16 is the nine numbers it can pick', r.kind === 'values' && r.exact && r.values.join() === '8,9,10,11,12,13,14,15,16');
  const m = previewSum(rolled, rolled.nodes[1], 'a + 4', scope);
  check('  ...so a sum it feeds is a range of answers', m.kind === 'values' && describePreview(m) === '12 to 20, one of 9', m.kind === 'values' ? describePreview(m) : JSON.stringify(m));
  const sq = previewSum(rolled, rolled.nodes[2], '(a - 12)^2', scope);
  check('  ...lowest in the middle as well as at the ends: every value is tried', sq.kind === 'values' && sq.values[0] === 0 && sq.values[sq.values.length - 1] === 16);
  check('a letter with no wire waits for one', previewSum(rolled, rolled.nodes[1], 'a + z', scope).kind === 'later');
  check('a word the run gives is known only when it runs', previewSum(rolled, rolled.nodes[1], '{count} * 2', scope).kind === 'later');
  check('  ...and a variable is read as it is now', (() => { const p = previewSum(rolled, rolled.nodes[1], '{warcry} * 2', scope); return p.kind === 'values' && p.values[0] === 247; })());
  const zero = previewSum(rolled, rolled.nodes[1], '1 / (a - 10)', scope);
  check('a sum that cannot be worked out for one of the values says which', zero.kind === 'wrong' && zero.why.includes('a is 10'), JSON.stringify(zero));
  const wide: Graph = { nodes: [{ id: 'r', type: 'random-number', x: 0, y: 0, fields: { min: 0, max: 100000 } }], wires: [] };
  const w = previewNumber(wide, 'r', scope);
  check('a range too wide to list is thinned and says "about"', w.kind === 'values' && !w.exact && w.values[0] === 0 && w.values[w.values.length - 1] === 100000 && describePreview(w) === 'about 0 to 100000');
}

console.log('\nSharing as a picture');
{
  // A real PNG, one grey pixel, made by hand: what a canvas hands back, only smaller.
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    out.set(Buffer.from(type, 'latin1'), 4);
    out.set(data, 8);
    v.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 1);
  new DataView(ihdr.buffer).setUint32(4, 1);
  ihdr.set([8, 0, 0, 0, 0], 8);
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, 128]))), chunk('IEND', new Uint8Array())]);
  const graph = { nodes: [{ id: 'go', type: 'on-button', x: 0, y: 0, fields: {} }, { id: 'n', type: 'nudge', x: 300, y: 0, fields: { title: 'Héllo — ✓' } }], wires: [{ id: 'w', from: 'go', pin: 'then', to: 'n' }] };
  const shared = withBlueprint(new Uint8Array(png), { name: 'Melee slide ⚔', graph });
  const back = blueprintIn(shared);
  check('a blueprint written into a PNG comes back out of it whole', back.name === 'Melee slide ⚔' && JSON.stringify(back.graph) === JSON.stringify(graph));
  check('  ...and the PNG is still a PNG that ends where it should', Buffer.from(shared.subarray(shared.length - 8, shared.length - 4)).toString('latin1') === 'IEND' && shared.length > png.length);
  const refused = (bytes: Uint8Array) => {
    try {
      blueprintIn(bytes);
      return '';
    } catch (error) {
      return (error as Error).message;
    }
  };
  check('a picture with no blueprint in it says so', /no blueprint in it/.test(refused(new Uint8Array(png))));
  check('a file that is not a PNG says so', /not a PNG/.test(refused(new TextEncoder().encode('{"nodes":[]}'))));
  const damaged = new Uint8Array(shared);
  damaged[png.length - 12 + 40] ^= 0xff;
  check('a blueprint damaged on the way is refused, not half read', /damaged/.test(refused(damaged)), refused(damaged));

  const code = await toCode({ name: 'Melee slide ⚔', graph });
  check('as text, it starts with its name and carries a code', code.startsWith('Blue Everything blueprint "Melee slide ⚔": BEBP1.') && /^[\x20-\x7e⚔]+$/.test(code), code.slice(0, 60));
  const fromText = await fromCode(`look at this\n${code}\nthanks!`);
  check('  ...and comes back whole from anywhere in a pasted message', fromText.name === 'Melee slide ⚔' && JSON.stringify(fromText.graph) === JSON.stringify(graph));
  const big = { name: 'Big', graph: { nodes: Array.from({ length: 200 }, (_, i) => ({ id: `n${i}`, type: 'nudge', x: i * 10, y: 0, fields: { title: 'same words again' } })), wires: [] } };
  const bigCode = await toCode(big);
  check('  ...deflated, so a big blueprint is a short code', bigCode.length < JSON.stringify(big).length / 4, `${bigCode.length} of ${JSON.stringify(big).length}`);
  const codeRefused = async (text: string) => fromCode(text).then(() => '', (error: Error) => error.message);
  check('text with no code in it says so', /not a shared blueprint/.test(await codeRefused('hello there')));
  check('a code cut short says it is damaged', /damaged/.test(await codeRefused(code.slice(0, code.length - 20))), await codeRefused(code.slice(0, code.length - 20)));
}

console.log('\nPlay a sound');
{
  const toneIds = specOf('play-sound')!.fields.find((f) => f.key === 'tone')!.options!.map((o) => o.id);
  check("its tones are the app's tones, all but silence", [...toneIds].sort().join() === TONE_NAMES.filter((t) => t !== 'none').sort().join(), toneIds.join());
  check('"beep" and "sound" find it, and "click" has it near the top', first('beep') === 'play-sound' && first('sound') === 'play-sound' && searchBoxes('click').slice(0, 3).some((f) => f.spec.type === 'play-sound'), searchBoxes('click').slice(0, 3).map((f) => f.spec.type).join());
  check('a tone or a file is not drawn here', designOf({ sound: 'tone' }) === null && designOf({ sound: 'file' }) === null && designOf({}) === null);
  const beep = designOf({ sound: 'beep', hz: 440, ms: 100, times: 3, gap: 50, volume: 50 })!;
  check('a beep three times with gaps lasts what it says', designLength(beep) === 400 && designSamples(beep).length === Math.round(SOUND_RATE * 0.1) * 3 + Math.round(SOUND_RATE * 0.05) * 2);
  check('  ...and is no louder than its volume', designSamples(beep).every((v) => Math.abs(v) <= 0.5 + 1e-9) && designSamples(beep).some((v) => Math.abs(v) > 0.45));
  check('  ...and is silent in the gaps', (() => { const s = designSamples(beep); const at = Math.round(SOUND_RATE * 0.12); return s.slice(at, at + 100).every((v) => v === 0); })());
  check('a beep starts and ends at silence, so it does not click', (() => { const s = designSamples(designOf({ sound: 'beep', hz: 1000, ms: 50, fade: 0 })!); return Math.abs(s[0]!) < 0.01 && Math.abs(s[s.length - 1]!) < 0.05; })());
  for (const kind of ['tick', 'tap', 'snap', 'pop', 'wood']) {
    const a = designWav({ sound: 'click', click: kind })!;
    const b = designWav({ sound: 'click', click: kind })!;
    check(`a ${kind} click is the same bytes every time, so the PC plays what the board played`, a.length > 44 && a.every((x, i) => x === b[i]));
  }
  const wav = designWav({ sound: 'sweep', hz: 200, toHz: 2000, ms: 300 })!;
  check('a sweep is a proper WAV', String.fromCharCode(...wav.slice(0, 4)) === 'RIFF' && new DataView(wav.buffer).getUint32(24, true) === SOUND_RATE);
  {
    const shape = (lines: unknown) => soundShapeText(parseSoundShape(lines));
    const chord = designOf({ sound: 'custom', volume: 100, shape: shape([{ points: [[0, 440], [100, 440]] }, { points: [[0, 660], [100, 660]] }, { points: [[0, 880], [100, 880]] }]) })!;
    check('a drawn sound mixes its lines, and a chord is turned down rather than clipped', chord.lines.length === 3 && designSamples(chord).every((v) => Math.abs(v) <= 1 + 1e-9) && designSamples(chord).some((v) => Math.abs(v) > 0.9));
    const late = designOf({ sound: 'custom', shape: shape([{ points: [[50, 440], [100, 440]] }]) })!;
    check('  ...a line drawn later starts later, with silence before it', designLength(late) === 100 && designSamples(late).slice(0, Math.round(SOUND_RATE * 0.049)).every((v) => v === 0));
    const one = designSamples(designOf({ sound: 'custom', volume: 50, shape: shape([{ points: [[0, 440], [100, 440]] }]) })!);
    const same = designSamples(designOf({ sound: 'beep', hz: 440, ms: 100, volume: 50 })!);
    check('  ...one flat line plays exactly as the old beep did', one.length === same.length && one.every((v, i) => v === same[i]));
    const bent = parseSoundShape(shape([{ wave: 'saw', gain: 0.5, points: [[120, 300], [0, 200], [60, 5000], [60, 100]] }]))[0]!;
    check('  ...points are put in time order, and two at one moment are a jump', bent.points.map((q) => q.t).join() === '0,60,60,120' && bent.wave === 'saw' && bent.gain === 0.5);
    const parsed = parseSoundShape(JSON.stringify({ lines: Array.from({ length: 70 }, () => ({ points: Array.from({ length: 140 }, (_, i) => [i * 10, 99_999]) })) }));
    check(
      `  ...at most ${SHAPE_LIMITS.lines} lines of ${SHAPE_LIMITS.points} points, pitches held to 12 kHz`,
      parsed.length === SHAPE_LIMITS.lines && parsed.every((l) => l.points.length === SHAPE_LIMITS.points && l.points.every((q) => q.hz === 12_000))
    );
    const swell = designSamples(designOf({ sound: 'custom', volume: 100, fade: 0, shape: shape([{ points: [[0, 440, 0], [200, 440]] }]) })!);
    const peakIn = (a: number, b: number) => swell.slice(Math.round(SOUND_RATE * a), Math.round(SOUND_RATE * b)).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    check('  ...a point can be quiet, and the line swells from it to the next', peakIn(0, 0.02) < 0.15 && peakIn(0.18, 0.2) > 0.85, `${peakIn(0, 0.02).toFixed(2)} → ${peakIn(0.18, 0.2).toFixed(2)}`);
    check('  ...and its loudness is kept as written, full being left out', shape([{ points: [[0, 440, 0.25], [100, 440, 1]] }]).includes('[0,440,0.25],[100,440]'));
    const voiced = helloVoiced();
    const whistled = helloFormants();
    check(
      'the "hello" examples fit: three formant lines, and the voiced one inside the limits',
      whistled.length === 3 && voiced.length >= 10 && voiced.length <= SHAPE_LIMITS.lines && voiced.every((l) => l.points.length <= SHAPE_LIMITS.points),
      `${voiced.length} lines of ${voiced[0]?.points.length} points`
    );
    check('  ...and read back as they were made', shape(voiced) === soundShapeText(voiced));
    const started = Date.now();
    designWav({ sound: 'custom', shape: soundShapeText(voiced) });
    check('  ...and the voiced one is made in well under a second', Date.now() - started < 1000, `${Date.now() - started} ms`);
    const harm = harmonicsOf({ wave: 'sine', gain: 1, points: [{ t: 0, hz: 1000 }, { t: 100, hz: 1500 }] }, 16);
    check('harmonics go up in whole multiples, each quieter by its number, and stop before 12 kHz', harm.length === 7 && harm[0]!.points[1]!.hz === 3000 && harm[6]!.gain === 0.13, harm.map((l) => l.gain).join());
    check('  ...a line under 5 ms or of one point is dropped; no lines is silence', parseSoundShape(shape([{ points: [[0, 440], [3, 440]] }, { points: [[0, 440]] }])).length === 0 && designLength(designOf({ sound: 'custom', shape: '{"lines":[]}' })!) === 0);
    check('  ...and text that is not a sound reads as a beep, not as silence', parseSoundShape('nonsense').length === 1 && parseSoundShape('').length === 1);
    const old = cleanGraph({ nodes: [{ id: 's', type: 'play-sound', fields: { sound: 'sweep', hz: 200, toHz: 2000, ms: 300, wave: 'square' } }], wires: [] }).nodes[0]!;
    const upgraded = parseSoundShape(old.fields.shape);
    check('a sweep saved before the drawn sound is read as one, the same', old.fields.sound === 'custom' && upgraded.length === 1 && upgraded[0]!.wave === 'square' && upgraded[0]!.points.map((q) => `${q.t}:${q.hz}`).join() === '0:200,300:2000', JSON.stringify(old.fields));
    const kept = cleanGraph({ nodes: [{ id: 's', type: 'play-sound', fields: { sound: 'custom', shape: shape([{ points: [[0, 300], [40, 900], [80, 300]] }]) } }], wires: [] }).nodes[0]!;
    check('  ...and a drawn one is kept as drawn', parseSoundShape(kept.fields.shape)[0]!.points.length === 3);
  }
  {
    const said = (text: string) => textToSounds(text).map((x) => x.p + (x.stress ? '1' : '')).join(' ');
    check('words become sounds: "hello" from the dictionary', said('hello') === 'HH AX L OW1', said('hello'));
    check('  ...a word it does not know, by the spelling rules', said('make') === 'M EY1 K' && said('brown') === 'B R AW1 N' && said('fish') === 'F IH1 SH', `${said('make')} / ${said('brown')} / ${said('fish')}`);
    check('  ...numbers are said, and a comma pauses', said('5, go') === 'F AY1 V _ G OW1', said('5, go'));
    check('  ...and square brackets give the sounds exactly', said('[hh eh l ow1]') === 'HH EH L OW1');
    const input = (say: string, extra: Partial<SpeechInput> = {}): SpeechInput => ({ say, voice: 'man', speed: 100, edit: parseVoiceEdit(''), ...extra });
    const statement = planSpeech(input('hello there'));
    const question = planSpeech(input('hello there?'));
    check('a statement falls at the end and a question rises', statement.pitch.at(-1)![1] < statement.pitch[0]![1] && question.pitch.at(-1)![1] > question.pitch[0]![1]);
    check('twice the speed takes half the time', Math.abs(speechLength(input('hello there', { speed: 200 })) * 2 - speechLength(input('hello there'))) < 2);
    const a = designWav({ sound: 'speech', say: 'welcome back', voice: 'woman' })!;
    const b = designWav({ sound: 'speech', say: 'welcome back', voice: 'woman' })!;
    check('speech is the same bytes every time, so the PC says what the board said', a.length > 44 + SOUND_RATE * 0.2 && a.every((x, i) => x === b[i]));
    check('  ...and is no louder than its volume', designSamples(designOf({ sound: 'speech', say: 'hello', volume: 40 })!).every((v) => Math.abs(v) <= 0.4 + 1e-6));
    const edit = { for: normalText('Hello'), sounds: [{ p: 'HH', ms: 60 }, { p: 'EH', ms: 120 }, { p: 'L', ms: 70 }, { p: 'OW', ms: 300, stress: true }], pitch: [[0, 0], [500, 7]] as Array<[number, number]> };
    const text = voiceEditText(edit);
    const edited = planSpeech(input('Hello', { edit: parseVoiceEdit(text) }));
    check('a voice edit is used for the words it was made for: its sounds and its pitch', edited.sounds.map((x) => x.p).join() === 'HH,EH,L,OW' && Math.round(edited.pitch.at(-1)![1]) === Math.round(115 * 2 ** (7 / 12)));
    check('  ...and not for other words', planSpeech(input('Goodbye', { edit: parseVoiceEdit(text) })).sounds[0]!.p === 'G');
    check('  ...and is kept as written', voiceEditText(parseVoiceEdit(text)) === text);
    const box = cleanGraph({ nodes: [{ id: 's', type: 'play-sound', fields: { sound: 'speech', say: 'Hi {game}', voiceEdit: text } }], wires: [] }).nodes[0]!;
    check('a text to speech box keeps its words, its {words} and its edit', box.fields.say === 'Hi {game}' && box.fields.voiceEdit === text && box.fields.voice === 'man');
  }
  check('nothing plays past ten seconds, however many times', designLength(designOf({ sound: 'beep', ms: 3000, times: 20, gap: 2000 })!) === MAX_SOUND_MS && designSamples(designOf({ sound: 'beep', ms: 3000, times: 20, gap: 2000 })!).length === SOUND_RATE * 10);
  check('a .wav on one of the PC\'s drives may be played', localSoundPath('C:\\Sounds\\ding.wav') === 'C:\\Sounds\\ding.wav' && localSoundPath('"D:/a b/x.WAV"') === 'D:/a b/x.WAV');
  check('  ...but never one on another machine, which Windows would sign in to', localSoundPath('\\\\pc\\share\\x.wav') === null && localSoundPath('//pc/share/x.wav') === null && localSoundPath('\\\\?\\C:\\x.wav') === null);
  check('  ...nor anything but a .wav or an .mp3, nor a path that is not whole', localSoundPath('C:\\x.exe') === null && localSoundPath('x.wav') === null && localSoundPath('') === null);
  check('an .mp3 may be played too', localSoundPath('C:\\Music\\four 1.mp3') === 'C:\\Music\\four 1.mp3' && localSoundPath('E:/a.MP3') === 'E:/a.MP3');
  check('  ...but not a path with a quote in it, which would end its quoting early', localSoundPath('C:\\a"b.mp3') === null);
}

console.log('\nRandom numbers, whole and decimal');
{
  const whole = randomRange({ gives: 'whole', min: 8.5, max: 12 });
  check('whole numbers are the ones between the ends', whole?.low === 9 && whole.high === 12 && whole.places === null);
  check('  ...and none between 3.2 and 3.8 says so', randomRange({ gives: 'whole', min: 3.2, max: 3.8 }) === null);
  check('  ...a box saved before the choice is whole', randomRange({ min: 8, max: 16 })?.places === null);
  const dec = randomRange({ gives: 'decimal', min: 1.5, max: 4, places: 2 })!;
  const picks = Array.from({ length: 4000 }, () => pickRandom(dec));
  check('decimals land between the ends, to the places asked', picks.every((v) => v >= 1.5 && v <= 4 && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6));
  check('  ...both ends included', pickRandom(dec, () => 0) === 1.5 && pickRandom(dec, () => 0.999999999) === 4);
  check('  ...and they are not all whole', picks.some((v) => !Number.isInteger(v)));
  check('  ...the ends can be the wrong way round', (() => { const r = randomRange({ gives: 'decimal', min: 4, max: 1.5, places: 1 })!; return r.low === 1.5 && r.high === 4; })());
  const decGraph: Graph = { nodes: [{ id: 'r', type: 'random-number', x: 0, y: 0, fields: { gives: 'decimal', min: 0.5, max: 0.6, places: 2 } }], wires: [] };
  const dp = previewNumber(decGraph, 'r', { variables: {}, placeholders: [] });
  check('a decimal Random number shows every value it can give', dp.kind === 'values' && dp.exact && dp.values.length === 11 && describePreview(dp) === '0.5 to 0.6, one of 11', dp.kind === 'values' ? describePreview(dp) : JSON.stringify(dp));
  check('a Random number keeps decimal ends it is given', fieldValue(fieldOf('random-number', 'min'), 1.25) === 1.25 && fieldValue(fieldOf('random-number', 'min'), -3) === -3);
}

console.log('\nFractions in a Math field');
{
  const blank: Doc = { root: [], caret: { path: [], at: 0 } };
  const typed = (keys: string) => toText(typeIn(blank, keys).root);
  const value = (src: string, a = 0.8, b = 1.235) => evaluate(src, { letter: (l) => ({ a, b })[l] ?? 5, word: () => 7 });
  check('typing a / 1.5 * (1 + b) puts all of the rest under a, as Desmos does', Math.abs(value(typed('a/1.5*(1+b)')) - 0.8 / (1.5 * 2.235)) < 1e-12, typed('a/1.5*(1+b)'));
  check('  ...and is saved as a sum the parser reads that way', typed('a/1.5*(1+b)') === 'a/(1.5*(1+b))', typed('a/1.5*(1+b)'));
  const out = right(typeIn(blank, 'a/2'));
  check('→ at the end of the bottom leaves the fraction', toText(typeIn(out, '+1').root) === '(a/2)+1', toText(typeIn(out, '+1').root));
  check('/ takes a bracket and the function before it as the top', Math.abs(value(typed('3+sqrt(a)/2'), 16) - 5) < 1e-12 && fromText(typed('3+sqrt(a)/2')).filter((i) => i.t === 'frac').length === 1, typed('3+sqrt(a)/2'));
  check('/ with nothing before it starts with an empty top', (() => { const d = typeIn(blank, '/'); return d.caret.path[0]?.part === 'num' && toText(typeIn(d, '1').root) === '1/()'; })());
  const twice = typed('a/b/c');
  check('a / b / c typed puts b / c under a, as Desmos does', twice === 'a/(b/c)', twice);
  const up = typeIn(vertical(typeIn(blank, 'a/b'), 'up'), 'x');
  check('↑ from the bottom goes to the top', toText(up.root) === 'ax/b', toText(up.root));
  const ab = typeIn(blank, 'a/b');
  const back = backspace({ ...ab, caret: { path: [{ i: 0, part: 'num' }], at: 0 } });
  check('Backspace at the start of the top takes the line away and keeps what was in it', toText(back.root) === 'ab', toText(back.root));
  const sq = typeIn(blank, 'x^2');
  check('^ raises the cursor into an exponent', sq.caret.path[0]?.part === 'exp' && toText(sq.root) === 'x^2');
  check('  ...→ comes back down, and what follows is not in the power', toText(typeIn(right(sq), '+1').root) === 'x^2+1');
  check('  ...everything typed stays up in it until → (2^3a is 2 to the 3a), and is bracketed', typed('2^3a') === '2^(3a)' && Math.abs(value(typed('2^3a'), 1) - 8) < 1e-9);
  check('  ...and goes with its base onto the top of a fraction', toText(typeIn(right(typeIn(blank, 'x^2')), '/4').root) === '(x^2)/4');
  const drop = backspace(typeIn(blank, 'x^'));
  check('Backspace in an empty power takes it away', toText(drop.root) === 'x' && drop.caret.path.length === 0);
  const den = typeIn(blank, 'a/{AS_B}');
  check('a {word} typed under a line stays under it', toText(den.root) === 'a/{AS_B}' && den.caret.path[0]?.part === 'den');
  const picked = left(left(typeIn(blank, 'a+bc'), true), true);
  check('Shift+← selects', selection(picked)?.from === 2 && selection(picked)?.to === 4 && selectedText(picked) === 'bc');
  check('  ...typing replaces what is selected', toText(typeIn(picked, 'z').root) === 'a+z');
  check('  .../ puts what is selected on top', toText(typeIn(picked, '/2').root) === 'a+(bc/2)');
  check('  ...and Backspace deletes it', toText(backspace(picked).root) === 'a+');
  const across = left(left(left(typeIn(blank, 'q+a/b'), true), true), true);
  check('a selection from the bottom of a fraction to its top takes the whole fraction', selectedText(across) === 'a/b' && selection(across)?.from === 2 && selection(across)?.to === 3, JSON.stringify(selection(across)));
  const out2 = left(left(across, true), true);
  check('  ...and on out of it, the fraction and what is before it', selectedText(out2) === '+(a/b)', selectedText(out2));
  const overPower = left(left(right(typeIn(blank, 'x^2')), true), true);
  check('Shift+← goes over a power whole, then on to its base', selectedText(overPower) === 'x^2', selectedText(overPower));
  check('Ctrl+A selects everything', selectedText(selectAll(typeIn(right(typeIn(blank, 'a/b')), '+1'))) === '(a/b)+1');
  check('← with a selection lands at its start rather than moving', (() => { const d = left(picked); return !selection(d) && d.caret.at === 2; })());
  for (const src of ['a/1.5/(1+b)', '1.5*a*(1+b%)', '2a/b', 'a*b/c+d', 'a/b*c', '(0+a)/1.5*(1+b)', 'max(a/b, 2)', '-a/2', 'a<=b/2', '{hp}/2 and a', '10% of {hp}/2', '2^-1/b', 'a^2+b^2', 'x^ab', '2^3^2', 'e^(a+1)', '2^pi', 'sqrt(a)^2', '(a/b)^2', 'a^2/b', '2^3%']) {
    const shown = toText(fromText(src));
    const same = Math.abs(value(shown, 3, 2) - value(src, 3, 2)) < 1e-12 || (Number.isNaN(value(shown, 3, 2)) && Number.isNaN(value(src, 3, 2)));
    check(`${src} opens as fractions that work out the same (${shown})`, same && toText(fromText(shown)) === shown);
  }
}

console.log('\nNotification');
check('stays 12 seconds by default', staysFor({}) === 12 && staysFor({ stays: 12, staysUnit: 'seconds' }) === 12);
check('minutes are minutes', staysFor({ stays: 3, staysUnit: 'minutes' }) === 180);
check('until I close it is 0 to the popup', staysFor({ stays: 5, staysUnit: 'close' }) === 0);
check('held between a second and a day', staysFor({ stays: 0.2 }) === 1 && staysFor({ stays: 9999, staysUnit: 'minutes' }) === 86400);

console.log('\nTemplates');
for (const t of TEMPLATES) {
  const g = t.graph();
  const events = g.nodes.filter((n) => specOf(n.type)!.kind === 'event').length;
  check(`${t.name}: every box joined up`, t.id === 'empty' || (events === 1 && g.wires.length === g.nodes.length - 1 && unreachable(g).size === 0));
}

console.log(failures === 0 ? '\nAll good.\n' : `\n${failures} failed.\n`);
process.exit(failures === 0 ? 0 : 1);
