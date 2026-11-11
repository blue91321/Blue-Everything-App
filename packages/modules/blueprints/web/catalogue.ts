/**
 * Every kind of box a blueprint can hold: what it is called, what you fill in,
 * and which wires leave it.
 *
 * **Imports only `keys.ts` and `maths.ts`, which import nothing**, so the server and the
 * screen read the same list: the server to check what it is given and run it,
 * the screen to draw it. Two lists would be two answers to "what does this box
 * do", and the first to drift would be one that saves fine and then does
 * nothing. The property `chapter-nav.ts` and `presence.ts` have, for the same
 * reason.
 *
 * Four kinds, as in Unreal's blueprints:
 *
 *   - **When** (an event): where a run starts. Red, no wire in.
 *   - **Check** (a branch): asks a question, leaves by *yes* or *no*.
 *   - **Logic**: decides where a run goes from more than one thing: a gate
 *     (AND, OR, NOR…) over several checks, a repeat, a sequence.
 *   - **Do** (an action): does one thing, then carries on.
 *
 * **One kind of value has a wire of its own: yes or no.** Every check has an
 * *Answer* pin (a diamond), and a logic gate's inputs take those, so "am I in
 * a game AND is it after ten" is two checks wired into one gate, as Unreal
 * does it. Anything else travels as a word in braces: an event *gives*
 * `{game}`, and any text box after it can say "Good game of {game}".
 *
 * **Numbers have wires too** (2026-11-04): every number a box is filled in
 * with has a way in beside it, so a Math box or a Random number can set a
 * Wait's length or a Repeat's count. A maths box grows a way in for each
 * letter its sum uses. A number wired in wins over the one typed.
 */
import { normalKeys, parseTimeline } from './keys.js';
import { lettersOf } from './maths.js';
import { parseSoundShape, soundShapeText } from './sound-design.js';
import { parseVoiceEdit, VOICES, voiceEditText } from './speech.js';

export type NodeKind = 'event' | 'branch' | 'logic' | 'action';

export type FieldKind = 'text' | 'longtext' | 'number' | 'choice' | 'time' | 'habit' | 'keys' | 'game' | 'timeline' | 'math' | 'color' | 'sound' | 'voice';

export interface FieldSpec {
  key: string;
  label: string;
  kind: FieldKind;
  /** For `choice`. The first is the default unless `default` says otherwise. */
  options?: Array<{ id: string; label: string }>;
  default: string | number;
  min?: number;
  max?: number;
  /** For `number`: what it is rounded to. Whole numbers unless this says 0.1. */
  step?: number;
  /** For `keys`: a hotkey to register needs a modifier; keys to press do not. */
  needModifier?: boolean;
  /** For `keys`: a mouse button may be one, which only a watched hotkey can be. */
  mouse?: boolean;
  /** Shown under the box, small. */
  hint?: string;
  placeholder?: string;
  /** Shown only while another field of the box has one of these values. */
  showWhen?: { key: string; is: string[] };
  /**
   * For `game`: what leaving it empty means ("any game"). A box that only asks
   * about a game offers every game on the list, not just the ones it can start.
   */
  anyGame?: string;
  /**
   * For `number`: false when it must stay typed, because it is how many pins
   * the box has (a gate's inputs) or a wire already does its job (a Counter's X).
   */
  wire?: false;
  /** What its way in is called, for a field with no label of its own. */
  wireLabel?: string;
  /** For a `choice` that is part of a sound: picking one plays the sound with it. */
  tone?: true;
  /** For a `number`: a slider beside the box, for something set by ear or by eye (a volume). */
  slider?: true;
  /** Kept with the box but set through another field, so not drawn. */
  hidden?: true;
}

export interface NodeSpec {
  type: string;
  kind: NodeKind;
  label: string;
  glyph: string;
  /** One line for the Add menu, saying what it does. */
  blurb: string;
  fields: FieldSpec[];
  /** The wires that can leave it. An event and an action have `then`; a check has two. */
  outputs: Output[];
  /** For a box whose outputs are counted by one of its fields (a sequence). */
  outputsFor?: (fields: Fields) => Output[];
  /** Ways in for a value: a gate's yes-or-no `c0`, `c1`…, or a counter's number. */
  inputsFor?: (fields: Fields) => Port[];
  /**
   * Only ever asked for its value, never run: no wire leads into it and none
   * leads on from it. A random number is one.
   */
  pure?: boolean;
  /** For an event: the `{words}` it fills in, with what each is. */
  gives?: Array<{ key: string; label: string }>;
}

export type Fields = Record<string, string | number>;

export interface Output {
  id: string;
  label: string;
  /** A value rather than a way on: a yes-or-no answer into a gate, or a number. */
  value?: boolean;
  /** The value is a number, which goes only into a way in that takes one. */
  number?: boolean;
}

/** A way in for a value. A yes-or-no one takes an answer; a `number` one takes a number. */
export interface Port {
  id: string;
  label: string;
  number?: boolean;
}

const THEN: Output[] = [{ id: 'then', label: '' }];
/** A check: two ways on, and its answer for a gate. */
const YES_NO: Output[] = [
  { id: 'yes', label: 'Yes' },
  { id: 'no', label: 'No' },
  { id: 'value', label: 'Answer', value: true },
];

/** How many of something a box has, from its field, kept to what the field allows. */
const counted = (fields: Fields, key: string, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(Number(fields[key]) || min)));

export const GATES = [
  { id: 'and', label: 'AND: all of them' },
  { id: 'or', label: 'OR: any of them' },
  { id: 'nand', label: 'NAND: not all of them' },
  { id: 'nor', label: 'NOR: none of them' },
  { id: 'xor', label: 'XOR: exactly one of them' },
];

/** A gate's answer from its inputs' answers. */
export function gate(op: string, answers: boolean[]): boolean {
  const yes = answers.filter(Boolean).length;
  switch (op) {
    case 'and':
      return yes === answers.length;
    case 'or':
      return yes > 0;
    case 'nand':
      return yes < answers.length;
    case 'nor':
      return yes === 0;
    case 'xor':
      return yes === 1;
  }
  return false;
}

/** A gate's inputs are lettered, A to H. */
export const INPUT_LETTERS = 'ABCDEFGH';
export const MAX_INPUTS = 8;
export const MAX_OUTPUTS = 8;

/** The names `mediaActions` in `shared` uses, so the agent has a key for each. */
const MEDIA = [
  { id: 'playpause', label: 'Play / pause' },
  { id: 'next', label: 'Next track' },
  { id: 'previous', label: 'Previous track' },
  { id: 'stop', label: 'Stop' },
  { id: 'volumeup', label: 'Volume up' },
  { id: 'volumedown', label: 'Volume down' },
  { id: 'mute', label: 'Mute / unmute' },
];

const DAYS = [
  { id: 'every', label: 'Every day' },
  { id: 'weekdays', label: 'Weekdays' },
  { id: 'weekends', label: 'Weekends' },
];

export const NODES: NodeSpec[] = [
  /* ---- When ----------------------------------------------------------- */
  {
    type: 'on-stop',
    kind: 'event',
    label: 'A match or break ends',
    glyph: '🏁',
    blurb: 'The moment the app already waits for: a game ending, a call ending, coming back.',
    fields: [
      {
        key: 'quality',
        label: 'Which',
        kind: 'choice',
        options: [
          { id: 'prime', label: 'Only the best moments (a match ending)' },
          { id: 'any', label: 'Any stopping point' },
        ],
        default: 'prime',
      },
    ],
    outputs: THEN,
    gives: [{ key: 'game', label: 'the game, if it was one' }],
  },
  {
    type: 'on-game-start',
    kind: 'event',
    label: 'I start playing',
    glyph: '🎮',
    blurb: 'A game comes to the front: any game, or one you pick.',
    fields: [{ key: 'game', label: 'Which', kind: 'game', default: '', anyGame: 'any game' }],
    outputs: THEN,
    gives: [{ key: 'game', label: 'the game' }],
  },
  {
    type: 'on-away',
    kind: 'event',
    label: 'I leave the PC',
    glyph: '🚶',
    blurb: 'Fifteen minutes with no keyboard, mouse or sound.',
    fields: [],
    outputs: THEN,
  },
  {
    type: 'on-back',
    kind: 'event',
    label: 'I come back to the PC',
    glyph: '👋',
    blurb: 'The first touch of the keyboard or mouse after being away.',
    fields: [],
    outputs: THEN,
  },
  {
    type: 'on-habit',
    kind: 'event',
    label: 'A habit is ticked',
    glyph: '✅',
    blurb: 'Any habit, or one you pick, from any device or by voice.',
    fields: [{ key: 'habit', label: 'Habit', kind: 'habit', default: '', hint: 'Leave on "Any" for every habit.' }],
    outputs: THEN,
    gives: [{ key: 'habit', label: 'the habit' }],
  },
  {
    type: 'on-task-done',
    kind: 'event',
    label: 'A task is finished',
    glyph: '☑️',
    blurb: 'Ticked off anywhere. Optionally only tasks whose name has some words in it.',
    fields: [{ key: 'contains', label: 'Name contains', kind: 'text', default: '', placeholder: 'anything' }],
    outputs: THEN,
    gives: [{ key: 'task', label: 'the task' }],
  },
  {
    type: 'on-task-added',
    kind: 'event',
    label: 'A task is added',
    glyph: '📝',
    blurb: 'Typed in, said aloud, or brought in by Canvas.',
    fields: [{ key: 'contains', label: 'Name contains', kind: 'text', default: '', placeholder: 'anything' }],
    outputs: THEN,
    gives: [{ key: 'task', label: 'the task' }],
  },
  {
    type: 'on-time',
    kind: 'event',
    label: 'At a time of day',
    glyph: '⏰',
    blurb: 'Every day, on weekdays or at weekends. Skipped if the PC was asleep through it.',
    fields: [
      { key: 'at', label: 'At', kind: 'time', default: '09:00' },
      { key: 'days', label: 'On', kind: 'choice', options: DAYS, default: 'every' },
    ],
    outputs: THEN,
    gives: [{ key: 'time', label: 'the time' }],
  },
  {
    type: 'on-every',
    kind: 'event',
    label: 'Every so often',
    glyph: '🔁',
    blurb: 'Every few minutes or hours: lined up with the clock, between two times, or counted from when the app starts.',
    fields: [
      { key: 'every', label: 'Every', kind: 'number', default: 15, min: 1, max: 1440 },
      {
        key: 'unit',
        label: '',
        kind: 'choice',
        options: [
          { id: 'minutes', label: 'minutes' },
          { id: 'hours', label: 'hours' },
        ],
        default: 'minutes',
      },
      {
        key: 'from',
        label: 'Counted',
        kind: 'choice',
        options: [
          { id: 'clock', label: 'Lined up with the clock (from midnight)' },
          { id: 'time', label: 'Starting at a time each day' },
          { id: 'start', label: 'From when the app starts or it is switched on' },
        ],
        default: 'clock',
      },
      { key: 'at', label: 'Starting at', kind: 'time', default: '09:00', showWhen: { key: 'from', is: ['time'] } },
      { key: 'until', label: 'Until', kind: 'time', default: '17:00', showWhen: { key: 'from', is: ['time'] } },
      {
        key: 'first',
        label: 'First run',
        kind: 'choice',
        options: [
          { id: 'wait', label: 'After the first wait' },
          { id: 'now', label: 'Straight away' },
        ],
        default: 'wait',
        showWhen: { key: 'from', is: ['start'] },
      },
      { key: 'days', label: 'On', kind: 'choice', options: DAYS, default: 'every' },
    ],
    outputs: THEN,
    gives: [{ key: 'time', label: 'the time' }],
  },
  {
    type: 'on-hotkey',
    kind: 'event',
    label: 'I press a hotkey',
    glyph: '⌨️',
    blurb: 'A key combination or a mouse button, even mid-game. Heard by the agent, so the PC has to be running it.',
    fields: [
      {
        key: 'listen',
        label: 'How',
        kind: 'choice',
        options: [
          { id: 'take', label: 'Takes the keys: other programs do not get them' },
          { id: 'watch', label: 'Watches while I play a game, and lets them through' },
        ],
        default: 'take',
      },
      {
        key: 'keys',
        label: 'Keys',
        kind: 'keys',
        default: '',
        placeholder: 'ctrl+alt+m',
        needModifier: true,
        hint: 'Needs Ctrl, Alt, Shift or Win with it, or it would take that key from every other program.',
        showWhen: { key: 'listen', is: ['take'] },
      },
      {
        key: 'watch',
        label: 'Key or mouse button',
        kind: 'keys',
        default: '',
        placeholder: 'mouse4, f1, mouse1',
        mouse: true,
        showWhen: { key: 'listen', is: ['watch'] },
      },
      {
        key: 'game',
        label: 'Only while playing',
        kind: 'game',
        default: '',
        anyGame: 'any time',
      },
      {
        key: 'again',
        label: 'Pressed again while it is still going',
        kind: 'choice',
        options: [
          { id: 'stop', label: 'Stops it' },
          { id: 'restart', label: 'Starts it again from the top' },
          { id: 'another', label: 'Starts another one alongside' },
          { id: 'ignore', label: 'Does nothing' },
        ],
        default: 'stop',
      },
      {
        key: 'release',
        label: 'Letting go',
        kind: 'choice',
        options: [
          { id: 'keep', label: 'Does nothing' },
          { id: 'stop', label: 'Stops it (for "while I hold it")' },
        ],
        default: 'keep',
        showWhen: { key: 'listen', is: ['watch'] },
      },
    ],
    outputs: THEN,
  },
  {
    type: 'on-voice',
    kind: 'event',
    label: 'I say',
    glyph: '🎙️',
    blurb: 'A phrase after the wake word. Matched on the words that matter, so "drink water" also hears "I drank some water".',
    fields: [
      {
        key: 'phrases',
        label: 'Phrases, one a line',
        kind: 'longtext',
        default: '',
        placeholder: 'drink water\nI had some water',
        hint: 'Write numbers as words: "two", not "2".',
      },
      {
        key: 'keep',
        label: 'Afterwards',
        kind: 'choice',
        options: [
          { id: 'yes', label: 'Keep listening for another' },
          { id: 'no', label: 'Stop listening' },
        ],
        default: 'yes',
      },
    ],
    outputs: THEN,
    gives: [
      { key: 'said', label: 'what you said after the phrase' },
      { key: 'amount', label: 'how many you said ("two"), 1 if you said none' },
    ],
  },
  {
    type: 'on-button',
    kind: 'event',
    label: 'When I press Run',
    glyph: '▶️',
    blurb: 'Starts only from the Run button above the blueprint.',
    fields: [],
    outputs: THEN,
  },

  /* ---- Check ---------------------------------------------------------- */
  {
    type: 'if-doing',
    kind: 'branch',
    label: 'Am I…',
    glyph: '🔍',
    blurb: 'What the PC thinks you are doing right now.',
    fields: [
      {
        key: 'state',
        label: '',
        kind: 'choice',
        options: [
          { id: 'in-game', label: 'in a game' },
          { id: 'free', label: 'free' },
          { id: 'focused', label: 'busy (a call, a video)' },
          { id: 'away', label: 'away from the PC' },
        ],
        default: 'free',
      },
      {
        key: 'game',
        label: 'Which',
        kind: 'game',
        default: '',
        anyGame: 'any game',
        showWhen: { key: 'state', is: ['in-game'] },
      },
    ],
    outputs: YES_NO,
  },
  {
    type: 'if-time',
    kind: 'branch',
    label: 'Is it between',
    glyph: '🕐',
    blurb: 'Two times of day. Ten at night to six in the morning works too.',
    fields: [
      { key: 'from', label: 'From', kind: 'time', default: '09:00' },
      { key: 'to', label: 'To', kind: 'time', default: '22:00' },
    ],
    outputs: YES_NO,
  },
  {
    type: 'if-day',
    kind: 'branch',
    label: 'Is it a',
    glyph: '📅',
    blurb: 'A weekday or the weekend.',
    fields: [
      {
        key: 'days',
        label: '',
        kind: 'choice',
        options: [
          { id: 'weekdays', label: 'weekday' },
          { id: 'weekends', label: 'weekend' },
        ],
        default: 'weekdays',
      },
    ],
    outputs: YES_NO,
  },
  {
    type: 'if-habit',
    kind: 'branch',
    label: 'Is this habit done?',
    glyph: '🎯',
    blurb: 'Finished for now, or still wanted. A gauge counts as done while it is above its reminder line.',
    fields: [{ key: 'habit', label: 'Habit', kind: 'habit', default: '' }],
    outputs: YES_NO,
  },
  {
    type: 'if-held',
    kind: 'branch',
    label: 'Am I holding a key?',
    glyph: '🖐️',
    blurb: 'Whether a key or mouse button is down right now, asked of the PC at that moment. After a Wait, it is "still holding it?", and a wire back makes it go again.',
    fields: [
      {
        key: 'keys',
        label: 'Key or mouse button',
        kind: 'keys',
        default: '',
        placeholder: 'w, mouse4, mouse1',
        mouse: true,
      },
    ],
    outputs: YES_NO,
  },
  {
    type: 'if-switch',
    kind: 'branch',
    label: 'Is a switch on?',
    glyph: '🔘',
    blurb: 'A switch you flip with "Flip a switch", from this blueprint or another: one hotkey turning another on and off.',
    fields: [{ key: 'name', label: 'Switch', kind: 'text', default: '', placeholder: 'reload' }],
    outputs: YES_NO,
  },
  {
    type: 'if-true',
    kind: 'branch',
    label: 'Is it true that…',
    glyph: '⚖️',
    blurb: 'A comparison, worked out like a Math box: {score} >= 10, a > b and {lives} > 0. Yes when it holds.',
    fields: [
      {
        key: 'expr',
        label: '',
        kind: 'math',
        default: '{score} >= 10',
        placeholder: 'a > 5 and {hp} < 30',
        hint: '= != < <= > >= and, or, not. Letters are wired in; {words} are variables.',
      },
    ],
    outputs: YES_NO,
  },

  /* ---- Logic ---------------------------------------------------------- */
  {
    type: 'random-number',
    kind: 'logic',
    label: 'Random number',
    glyph: '🎲',
    blurb: 'A number picked at random between two, afresh each time something asks for it: a whole number, or one with decimals. Wire it into a Counter, a Wait or a sum.',
    fields: [
      {
        key: 'gives',
        label: 'Gives',
        kind: 'choice',
        default: 'whole',
        options: [
          { id: 'whole', label: 'Whole numbers' },
          { id: 'decimal', label: 'Decimals' },
        ],
      },
      { key: 'min', label: 'From', kind: 'number', default: 8, min: -100_000, max: 100_000, step: 0.001 },
      { key: 'max', label: 'To', kind: 'number', default: 16, min: -100_000, max: 100_000, step: 0.001, hint: 'Both ends can come up.' },
      { key: 'places', label: 'Decimal places', kind: 'number', default: 2, min: 0, max: 6, wire: false, showWhen: { key: 'gives', is: ['decimal'] } },
    ],
    outputs: [{ id: 'value', label: 'Number', value: true, number: true }],
    pure: true,
  },
  {
    type: 'variable',
    kind: 'logic',
    label: 'Variable',
    glyph: '📦',
    blurb: 'A variable, named and started: where it starts, what goes in it, and what it holds now, on a wire for any box that takes a number. "Set a variable" boxes with the same name change it.',
    fields: [
      { key: 'name', label: 'Variable', kind: 'text', default: '', placeholder: 'fire_rate' },
      { key: 'about', label: 'What goes in it', kind: 'text', default: '', placeholder: 'Shots a second, with mods' },
      {
        key: 'as',
        label: 'It holds',
        kind: 'choice',
        default: 'number',
        options: [
          { id: 'number', label: 'A number' },
          { id: 'percent', label: 'A percentage' },
        ],
        // Set by typing % after its start, so it has no control of its own.
        hidden: true,
      },
      // A declaration, not something worked out, so no wire into it.
      {
        key: 'start',
        label: 'Starts at',
        kind: 'number',
        default: 0,
        min: -1_000_000_000,
        max: 1_000_000_000,
        step: 0.001,
        wire: false,
      },
    ],
    outputs: [{ id: 'value', label: 'Number', value: true, number: true }],
    pure: true,
  },
  {
    type: 'counter',
    kind: 'logic',
    label: 'Counter',
    glyph: '🔢',
    blurb: 'Counts the runs that reach it, and says yes on the Xth, then starts counting again; no the rest. Counts across runs, from zero when the app starts.',
    fields: [
      {
        key: 'times',
        label: 'Yes on time number',
        kind: 'number',
        default: 8,
        min: 1,
        max: 10_000,
        hint: 'Or wire a number into X, such as a Random number: it is read each time the count starts again.',
        wire: false,
      },
    ],
    outputs: YES_NO,
    inputsFor: () => [{ id: 'x', label: 'X', number: true }],
  },
  {
    type: 'math',
    kind: 'logic',
    label: 'Math',
    glyph: '🧮',
    blurb: 'Works out a sum, the way Desmos reads one: 2a + b, sqrt(a), round({score} / 3). Each letter used is a way in for a number. Wire its Number into anything that takes one.',
    fields: [
      {
        key: 'expr',
        label: '',
        kind: 'math',
        default: 'a + b',
        placeholder: 'a * 2 + {score}',
        hint: 'Letters are wired in; {words} are variables and the run\'s words. sin cos sqrt abs round floor min max mod random(1, 6) and more.',
      },
    ],
    outputs: [{ id: 'value', label: 'Number', value: true, number: true }],
    pure: true,
  },
  {
    type: 'logic-gate',
    kind: 'logic',
    label: 'Logic gate',
    glyph: '🔀',
    blurb: 'AND, OR, NAND, NOR or XOR over the answers of checks wired into it. Leaves by yes or no.',
    fields: [
      { key: 'op', label: 'Yes when', kind: 'choice', options: GATES, default: 'and' },
      {
        key: 'inputs',
        label: 'Inputs',
        kind: 'number',
        default: 2,
        min: 1,
        max: MAX_INPUTS,
        hint: "Wire a check's Answer into each. One with nothing wired in is left out.",
        wire: false,
      },
    ],
    outputs: YES_NO,
    inputsFor: (fields) =>
      Array.from({ length: counted(fields, 'inputs', 1, MAX_INPUTS) }, (_, i) => ({ id: `c${i}`, label: INPUT_LETTERS[i]! })),
  },
  {
    type: 'repeat',
    kind: 'logic',
    label: 'Repeat',
    glyph: '🔂',
    blurb: 'Runs what follows "Each time" again and again, every few milliseconds, seconds or minutes, a number of times or until stopped.',
    fields: [
      // Three decimals, as Wait; the gap is kept between 1 ms and a day when it runs.
      { key: 'every', label: 'Every', kind: 'number', default: 1, min: 0.001, max: 100_000, step: 0.001 },
      {
        key: 'unit',
        label: '',
        kind: 'choice',
        options: [
          { id: 'ms', label: 'milliseconds' },
          { id: 'seconds', label: 'seconds' },
          { id: 'minutes', label: 'minutes' },
        ],
        default: 'seconds',
      },
      {
        key: 'until',
        label: 'Stops',
        kind: 'choice',
        options: [
          { id: 'count', label: 'After a number of times' },
          { id: 'stopped', label: 'When I stop it' },
        ],
        default: 'count',
      },
      { key: 'times', label: 'Times', kind: 'number', default: 10, min: 1, max: 10_000, showWhen: { key: 'until', is: ['count'] } },
      {
        key: 'first',
        label: 'First time',
        kind: 'choice',
        options: [
          { id: 'now', label: 'Straight away' },
          { id: 'wait', label: 'After one wait' },
        ],
        default: 'now',
      },
    ],
    outputs: [
      { id: 'each', label: 'Each time' },
      { id: 'done', label: 'After the last' },
    ],
    gives: [{ key: 'count', label: 'which time this is, from 1' }],
  },
  {
    type: 'sequence',
    kind: 'logic',
    label: 'Sequence',
    glyph: '🪜',
    blurb: 'Several ways out, run one after another: everything after Then 1, then everything after Then 2…',
    fields: [{ key: 'outputs', label: 'Outputs', kind: 'number', default: 2, min: 2, max: MAX_OUTPUTS, wire: false }],
    outputs: [],
    outputsFor: (fields) =>
      Array.from({ length: counted(fields, 'outputs', 2, MAX_OUTPUTS) }, (_, i) => ({ id: `then${i}`, label: `Then ${i + 1}` })),
  },

  /* ---- Do ------------------------------------------------------------- */
  {
    type: 'nudge',
    kind: 'action',
    label: 'Notification',
    glyph: '🔔',
    blurb: "The app's popup on the PC, as a notification of its own: right now, as soon as you are free, or at the next good break. Not a nudge, so it is not held back by reminders being off or by quiet hours. Silent unless you give it a sound.",
    fields: [
      { key: 'title', label: 'Say', kind: 'text', default: '', placeholder: 'Drink some water' },
      { key: 'body', label: 'More', kind: 'longtext', default: '', placeholder: 'optional' },
      {
        key: 'when',
        label: 'When',
        kind: 'choice',
        options: [
          { id: 'good', label: 'At the next good break' },
          { id: 'soon', label: 'Whenever it can' },
          { id: 'now', label: 'Right now, even mid-game' },
        ],
        default: 'good',
      },
      { key: 'color', label: 'Colour on the PC', kind: 'color', default: '' },
      // How long the popup stays up once shown (2026-11-11; it was "Give up
      // after (minutes)" for one still waiting, with the popup always 12s).
      { key: 'stays', label: 'Stays on screen for', kind: 'number', default: 12, min: 1, max: 1440, showWhen: { key: 'staysUnit', is: ['seconds', 'minutes'] } },
      {
        key: 'staysUnit',
        label: '',
        kind: 'choice',
        options: [
          { id: 'seconds', label: 'seconds' },
          { id: 'minutes', label: 'minutes' },
          { id: 'close', label: 'until I close it' },
        ],
        default: 'seconds',
      },
      {
        key: 'sound',
        label: 'Sound',
        kind: 'choice',
        default: 'none',
        // None by default: a blueprint often plays its own sound beside it.
        options: [
          { id: 'none', label: 'None' },
          { id: 'chime', label: 'Chime' },
          { id: 'blip', label: 'Blip' },
          { id: 'rise', label: 'Rise' },
          { id: 'fall', label: 'Fall' },
          { id: 'arrive', label: 'Arrive' },
          { id: 'knock', label: 'Knock' },
          { id: 'sink', label: 'Sink' },
          { id: 'soft', label: 'Soft' },
        ],
        tone: true,
      },
      {
        key: 'volume',
        label: 'Volume (%)',
        kind: 'number',
        default: 50,
        min: 0,
        max: 100,
        slider: true,
        showWhen: { key: 'sound', is: ['chime', 'blip', 'rise', 'fall', 'arrive', 'knock', 'sink', 'soft'] },
      },
    ],
    outputs: THEN,
  },
  {
    type: 'add-task',
    kind: 'action',
    label: 'Add a task',
    glyph: '➕',
    blurb: 'An ordinary task on your list, due when you say.',
    fields: [
      { key: 'title', label: 'Task', kind: 'text', default: '', placeholder: 'Stretch' },
      { key: 'dueIn', label: 'Due in (minutes, 0 for no time)', kind: 'number', default: 0, min: 0, max: 10080 },
    ],
    outputs: THEN,
  },
  {
    type: 'tick-habit',
    kind: 'action',
    label: 'Tick a habit',
    glyph: '✔️',
    blurb: 'Records it as done, the same as pressing it on the Dashboard.',
    fields: [
      { key: 'habit', label: 'Habit', kind: 'habit', default: '' },
      {
        key: 'howMany',
        label: 'How many',
        kind: 'choice',
        options: [
          { id: 'fixed', label: 'This many' },
          { id: 'said', label: 'As many as I said ("two", "to max"), or one' },
        ],
        default: 'fixed',
      },
      { key: 'amount', label: '', kind: 'number', default: 1, min: 1, max: 20, showWhen: { key: 'howMany', is: ['fixed'] }, wireLabel: 'How many' },
    ],
    outputs: THEN,
  },
  {
    type: 'note-line',
    kind: 'action',
    label: 'Write in a note',
    glyph: '🗒️',
    blurb: 'Adds a line to the note with that title, making it the first time.',
    fields: [
      { key: 'note', label: 'Note', kind: 'text', default: 'Blueprint log' },
      { key: 'line', label: 'Line', kind: 'text', default: '', placeholder: 'Played {game} at {time}' },
    ],
    outputs: THEN,
  },
  {
    type: 'set-switch',
    kind: 'action',
    label: 'Flip a switch',
    glyph: '🔘',
    blurb: 'Turns a named switch on, off, or the other way, for "Is a switch on?" to ask. Switches start off when the app does. Gives {switch}: on or off.',
    fields: [
      { key: 'name', label: 'Switch', kind: 'text', default: '', placeholder: 'reload' },
      {
        key: 'to',
        label: 'To',
        kind: 'choice',
        options: [
          { id: 'flip', label: 'the other way' },
          { id: 'on', label: 'on' },
          { id: 'off', label: 'off' },
        ],
        default: 'flip',
      },
    ],
    outputs: THEN,
    gives: [{ key: 'switch', label: 'on or off, as it is now' }],
  },
  {
    type: 'set-variable',
    kind: 'action',
    label: 'Set a variable',
    glyph: '📦',
    blurb: 'Keeps a number or some words under a name, for any blueprint to read as {name}. Kept when the app restarts.',
    fields: [
      {
        key: 'name',
        label: 'Variable',
        kind: 'text',
        default: '',
        placeholder: 'score',
        hint: 'A Variable box with this name says where it starts; a line joins them.',
      },
      {
        key: 'how',
        label: '',
        kind: 'choice',
        options: [
          { id: 'set', label: 'Set it to' },
          { id: 'add', label: 'Add' },
          { id: 'sub', label: 'Take away' },
          { id: 'mul', label: 'Multiply it by' },
          { id: 'div', label: 'Divide it by' },
          { id: 'pctup', label: 'Increase it by a percentage' },
          { id: 'pctdown', label: 'Decrease it by a percentage' },
          { id: 'text', label: 'Set it to some words' },
          { id: 'forget', label: 'Put it back to its start' },
        ],
        default: 'set',
      },
      {
        key: 'value',
        label: '',
        kind: 'math',
        default: '1',
        placeholder: '{score} * 2',
        showWhen: { key: 'how', is: ['set', 'add', 'sub', 'mul', 'div'] },
        hint: 'A number or a sum: 50% is 0.5, and 10% of {hp} works. A variable that is not set yet counts as 0 when adding to it.',
      },
      {
        key: 'percent',
        label: 'By (%)',
        kind: 'math',
        default: '10',
        placeholder: '10',
        showWhen: { key: 'how', is: ['pctup', 'pctdown'] },
        hint: '10 makes 50 into 55 going up, or 45 going down.',
      },
      { key: 'words', label: '', kind: 'text', default: '', placeholder: 'Played {game}', showWhen: { key: 'how', is: ['text'] } },
    ],
    outputs: THEN,
  },
  {
    type: 'show-popup',
    kind: 'action',
    label: 'Show a popup',
    glyph: '💬',
    blurb: "The app's own popup on the PC, now, in the colour you pick: above a game, without taking the keyboard from it. Not queued and not sent to the phone.",
    fields: [
      { key: 'title', label: 'Say', kind: 'text', default: '', placeholder: 'Welcome back' },
      { key: 'body', label: 'More', kind: 'longtext', default: '', placeholder: 'optional' },
      { key: 'color', label: 'Colour', kind: 'color', default: '' },
      { key: 'seconds', label: 'Stays up for (seconds)', kind: 'number', default: 8, min: 1, max: 600 },
      {
        key: 'quiet',
        label: 'While reminders are held',
        kind: 'choice',
        options: [
          { id: 'show', label: 'Shows anyway' },
          { id: 'skip', label: 'Does not show' },
        ],
        default: 'show',
      },
    ],
    outputs: THEN,
  },
  {
    type: 'play-sound',
    kind: 'action',
    label: 'Play a sound',
    glyph: '🔊',
    blurb: "A sound on the PC, now: one of the app's tones, words spoken (text to speech), a click, a sound you make yourself from lines of pitch, or a .wav or .mp3 of your own. To hear that a blueprint got this far, or as part of a macro. Played whether or not the app's own sounds are switched on.",
    fields: [
      {
        key: 'sound',
        label: 'Sound',
        kind: 'choice',
        default: 'tone',
        options: [
          { id: 'tone', label: "One of the app's tones" },
          { id: 'speech', label: 'Text to speech' },
          { id: 'custom', label: 'Make your own sound' },
          { id: 'click', label: 'A click' },
          { id: 'file', label: 'A .wav or .mp3 file on the PC' },
        ],
        tone: true,
      },
      {
        key: 'tone',
        label: 'Tone',
        kind: 'choice',
        default: 'chime',
        showWhen: { key: 'sound', is: ['tone'] },
        // The app's tones, by name; `blueprints-check` holds this list to shared's.
        options: [
          { id: 'chime', label: 'Chime' },
          { id: 'blip', label: 'Blip' },
          { id: 'rise', label: 'Rise' },
          { id: 'fall', label: 'Fall' },
          { id: 'arrive', label: 'Arrive' },
          { id: 'knock', label: 'Knock' },
          { id: 'sink', label: 'Sink' },
          { id: 'soft', label: 'Soft' },
        ],
        tone: true,
      },
      {
        key: 'click',
        label: 'Click',
        kind: 'choice',
        default: 'tick',
        options: [
          { id: 'tick', label: 'Tick: high and tiny' },
          { id: 'tap', label: 'Tap: a soft press' },
          { id: 'snap', label: 'Snap: sharp and dry' },
          { id: 'pop', label: 'Pop: low and round' },
          { id: 'wood', label: 'Wood: a hollow knock' },
        ],
        showWhen: { key: 'sound', is: ['click'] },
        tone: true,
      },
      // Text to speech: the words, a voice and a speed on the box; changes to the sounds and the pitch made in the voice editor are kept in `voiceEdit`.
      { key: 'say', label: 'Say', kind: 'text', default: 'Hello', placeholder: 'Hello there, {game}', showWhen: { key: 'sound', is: ['speech'] } },
      {
        key: 'voice',
        label: 'Voice',
        kind: 'choice',
        default: 'man',
        options: Object.entries(VOICES).map(([id, v]) => ({ id, label: v.label })),
        showWhen: { key: 'sound', is: ['speech'] },
        tone: true,
      },
      { key: 'speed', label: 'Speed (%)', kind: 'number', default: 100, min: 50, max: 200, slider: true, showWhen: { key: 'sound', is: ['speech'] } },
      { key: 'voiceEdit', label: 'Voice edits', kind: 'voice', default: '', showWhen: { key: 'sound', is: ['speech'] }, hidden: true },
      // A drawn sound's lines and fade are set on its graph (`SoundShape`), so they are kept but not drawn as boxes.
      { key: 'shape', label: 'Lines', kind: 'sound', default: '', showWhen: { key: 'sound', is: ['custom'] }, hidden: true },
      { key: 'fade', label: 'Fade in and out (ms)', kind: 'number', default: 5, min: 0, max: 500, showWhen: { key: 'sound', is: ['custom'] }, hidden: true },
      { key: 'volume', label: 'Volume (%)', kind: 'number', default: 50, min: 0, max: 100, slider: true },
      { key: 'times', label: 'Times', kind: 'number', default: 1, min: 1, max: 20, showWhen: { key: 'sound', is: ['click'] } },
      { key: 'gap', label: 'Gap between (ms)', kind: 'number', default: 80, min: 0, max: 2000, showWhen: { key: 'sound', is: ['click'] } },
      { key: 'path', label: 'File', kind: 'text', default: '', placeholder: 'C:\\Sounds\\ding.wav', showWhen: { key: 'sound', is: ['file'] } },
      {
        key: 'then',
        label: 'Then',
        kind: 'choice',
        default: 'now',
        options: [
          { id: 'now', label: 'Goes on at once' },
          { id: 'after', label: 'Goes on once it has played' },
        ],
      },
      {
        key: 'quiet',
        label: 'While reminders are held',
        kind: 'choice',
        options: [
          { id: 'play', label: 'Plays anyway' },
          { id: 'skip', label: 'Does not play' },
        ],
        default: 'play',
      },
    ],
    outputs: THEN,
  },
  {
    type: 'ask',
    kind: 'action',
    label: 'Ask me',
    glyph: '💭',
    blurb: 'A popup with a box to type in. It never takes the keyboard by itself: click it to type, Enter sends and hands the keyboard back. Gives {answer}.',
    fields: [
      { key: 'title', label: 'Ask', kind: 'text', default: '', placeholder: 'How did that match go?' },
      { key: 'body', label: 'More', kind: 'longtext', default: '', placeholder: 'optional' },
      { key: 'placeholder', label: 'In the box before you type', kind: 'text', default: '', placeholder: 'Click to type' },
      { key: 'color', label: 'Colour', kind: 'color', default: '' },
      { key: 'seconds', label: 'Waits for (seconds)', kind: 'number', default: 120, min: 10, max: 3600 },
      { key: 'saveAs', label: 'Keep the answer as a variable', kind: 'text', default: '', placeholder: 'optional: note' },
      {
        key: 'quiet',
        label: 'While reminders are held',
        kind: 'choice',
        options: [
          { id: 'show', label: 'Asks anyway' },
          { id: 'skip', label: 'Does not ask' },
        ],
        default: 'show',
      },
    ],
    outputs: [
      { id: 'answered', label: 'Answered' },
      { id: 'none', label: 'No answer' },
    ],
    gives: [{ key: 'answer', label: 'what you typed' }],
  },
  {
    type: 'wait',
    kind: 'action',
    label: 'Wait',
    glyph: '⏳',
    blurb: 'Then carries on, after some minutes, seconds or milliseconds. A wait is forgotten if the app restarts during it.',
    fields: [
      // Still called `minutes` whatever the unit, so a wait saved before seconds were offered is read the same.
      // Three decimals (0.025 seconds); the total is kept between 1 ms and a day when it runs.
      { key: 'minutes', label: 'For', kind: 'number', default: 30, min: 0.001, max: 100_000, step: 0.001 },
      {
        key: 'unit',
        label: '',
        kind: 'choice',
        options: [
          { id: 'minutes', label: 'minutes' },
          { id: 'seconds', label: 'seconds' },
          { id: 'ms', label: 'milliseconds' },
        ],
        default: 'minutes',
      },
    ],
    outputs: THEN,
  },
  {
    type: 'press-keys',
    kind: 'action',
    label: 'Press keys',
    glyph: '⌨️',
    blurb: 'Presses a key, a combination, or a sequence with waits, into whatever window is in front, as if you had. Done by the agent on the PC.',
    fields: [
      {
        key: 'mode',
        label: 'Press',
        kind: 'choice',
        options: [
          { id: 'one', label: 'One key or combination' },
          { id: 'timeline', label: 'Several, on a timeline' },
        ],
        default: 'one',
      },
      { key: 'keys', label: 'Keys', kind: 'keys', default: '', placeholder: 'e, or ctrl+c', showWhen: { key: 'mode', is: ['one'] } },
      {
        key: 'hold',
        label: 'Hold down for (ms)',
        kind: 'number',
        default: 30,
        min: 0,
        max: 5000,
        hint: 'Some games miss a press shorter than a frame or two.',
        showWhen: { key: 'mode', is: ['one'] },
      },
      {
        key: 'timeline',
        label: 'Timeline',
        kind: 'timeline',
        default: '[]',
        showWhen: { key: 'mode', is: ['timeline'] },
      },
    ],
    outputs: THEN,
  },
  {
    type: 'open-url',
    kind: 'action',
    label: 'Open a website',
    glyph: '🌐',
    blurb: 'In the default browser on the PC. Only http and https addresses.',
    fields: [{ key: 'url', label: 'Address', kind: 'text', default: '', placeholder: 'https://…' }],
    outputs: THEN,
  },
  {
    type: 'media',
    kind: 'action',
    label: 'Media control',
    glyph: '⏯️',
    blurb: "The PC's media keys, so it reaches whatever is playing without it being in front. Skipped when nothing is playing.",
    fields: [{ key: 'action', label: '', kind: 'choice', options: MEDIA, default: 'playpause' }],
    outputs: THEN,
  },
  {
    type: 'launch-game',
    kind: 'action',
    label: 'Start a game',
    glyph: '🚀',
    blurb: 'Anything on the games list that has run on this PC, the way its own shortcut starts it.',
    fields: [{ key: 'game', label: 'Game', kind: 'game', default: '' }],
    outputs: THEN,
  },
  {
    type: 'play-music',
    kind: 'action',
    label: 'Play music',
    glyph: '🎵',
    blurb: "The Music tab's own shuffle, with its lists and settings. Needs Spotify connected.",
    fields: [
      {
        key: 'what',
        label: '',
        kind: 'choice',
        options: [
          { id: 'shuffle', label: 'Shuffle' },
          { id: 'random', label: 'Random' },
          { id: 'stop', label: 'Stop adding songs' },
        ],
        default: 'shuffle',
      },
    ],
    outputs: THEN,
  },
  {
    type: 'new-note',
    kind: 'action',
    label: 'Make a new note',
    glyph: '📒',
    blurb: 'A note of its own, titled by its first line. After "I say", {said} is whatever you said after the phrase.',
    fields: [{ key: 'text', label: 'Note', kind: 'longtext', default: '{said}' }],
    outputs: THEN,
  },
];

/** The PC's media keys, by the names the agent sends them under. */
export const MEDIA_OPTIONS = MEDIA;

/**
 * Why a "Nudge me" will not show, by core's `quietReason`. One wording for the
 * run log (the server) and the banner over the board (the screen). Going quiet
 * outranks everything in the nudge engine, "Right now, even mid-game" too, so
 * a nudge written meanwhile waits and then gives up unseen.
 */
export const HELD_BECAUSE: Record<string, string> = {
  'reminders-off': 'reminders are switched off',
  paused: 'reminders are paused',
  'quiet-hours': 'it is inside your quiet hours',
  'windows-dnd': 'Windows Do Not Disturb is on',
};

/** A "When I say" box's phrases: one a line, blank lines dropped, each once. */
export function phrasesOf(fields: Fields): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of String(fields.phrases ?? '').split(/\r?\n/)) {
    const phrase = line.trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!phrase || seen.has(phrase.toLowerCase())) continue;
    seen.add(phrase.toLowerCase());
    out.push(phrase);
  }
  return out.slice(0, 20);
}

const BY_TYPE = new Map(NODES.map((n) => [n.type, n]));

export function specOf(type: string): NodeSpec | undefined {
  return BY_TYPE.get(type);
}

export const KIND_LABEL: Record<NodeKind, string> = { event: 'When', branch: 'Check', logic: 'Logic', action: 'Do' };

/** The wires that can leave a box, counted from its fields where it has a count. */
export function outputsOf(node: { type: string; fields: Fields }): Output[] {
  const spec = specOf(node.type);
  if (!spec) return [];
  return spec.outputsFor ? spec.outputsFor(node.fields) : spec.outputs;
}

/** Whether a field is showing: one that means something in only one mode is hidden in the others. */
export function fieldShown(field: FieldSpec, fields: Fields): boolean {
  if (!field.showWhen) return true;
  return field.showWhen.is.includes(String(fields[field.showWhen.key]));
}

/** The way in for a number field, by its key. */
export const fieldPort = (key: string) => `f-${key}`;
/** The way in for a letter of a maths box's sum. */
export const letterPort = (letter: string) => `l-${letter}`;

/**
 * A box's ways in for a value: a gate's lettered answers and a counter's X,
 * then one per letter its sums use, then one per number it is filled in with.
 * Not on a When box, whose numbers say when it starts, before any run has a
 * value to give it. A field that is hidden in the box's mode has none.
 */
export function inputsOf(node: { type: string; fields: Fields }): Port[] {
  const spec = specOf(node.type);
  if (!spec) return [];
  const own = spec.inputsFor?.(node.fields) ?? [];
  if (spec.kind === 'event') return own;
  const shownFields = spec.fields.filter((f) => fieldShown(f, node.fields));
  const letters = [...new Set(shownFields.filter((f) => f.kind === 'math').flatMap((f) => lettersOf(String(node.fields[f.key] ?? ''))))];
  const numbers = shownFields.filter((f) => f.kind === 'number' && f.wire !== false);
  return [
    ...own,
    ...letters.map((l) => ({ id: letterPort(l), label: l, number: true })),
    ...numbers.map((f) => ({ id: fieldPort(f.key), label: f.label || f.wireLabel || spec.label, number: true })),
  ];
}

/** A field's value, or its default when it is missing or the wrong shape. */
/** How many decimal places a step has: 0.001 has three. */
export const decimalsOf = (step: number) => (step >= 1 ? 0 : Math.min(6, (String(step).split('.')[1] ?? '').length));

/** Rounded to the step, then tidied: 0.1 × 3 is not 0.3 in floating point. */
export const toStep = (n: number, step: number) => Number((Math.round(n / step) * step).toFixed(decimalsOf(step)));

export function fieldValue(spec: FieldSpec, raw: unknown): string | number {
  if (spec.kind === 'number') {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n) || raw === '' || raw === null) return spec.default;
    const rounded = toStep(n, spec.step ?? 1);
    return Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, rounded));
  }
  // Kept as JSON text, since a box's fields are strings and numbers.
  if (spec.kind === 'timeline') return JSON.stringify(parseTimeline(raw ?? spec.default));
  if (spec.kind === 'sound') return soundShapeText(parseSoundShape(raw ?? spec.default));
  if (spec.kind === 'voice') return voiceEditText(parseVoiceEdit(raw ?? spec.default));
  if (typeof raw !== 'string') return spec.default;
  if (spec.kind === 'keys') return normalKeys(raw, spec.needModifier, spec.mouse);
  // An executable's name off the games list, never a path: what it can start is
  // bounded by what the PC has run by itself. The rule voice's `launch` kept.
  if (spec.kind === 'game') return /^[\w .()+-]{1,120}\.exe$/i.test(raw.trim()) ? raw.trim().toLowerCase() : '';
  if (spec.kind === 'choice') return spec.options?.some((o) => o.id === raw) ? raw : spec.default;
  if (spec.kind === 'time') return /^([01]\d|2[0-3]):[0-5]\d$/.test(raw) ? raw : spec.default;
  // `#rrggbb`, or empty for the app's own accent.
  if (spec.kind === 'color') return /^#[0-9a-f]{6}$/i.test(raw.trim()) ? raw.trim().toLowerCase() : '';
  return raw.slice(0, spec.kind === 'longtext' ? 2000 : spec.kind === 'math' ? 500 : 300);
}

/** "09:30" as minutes since midnight. */
export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Inclusive of the start, exclusive of the end, and wrapping past midnight. */
export function isBetween(minute: number, from: string, to: string): boolean {
  const a = minutesOf(from);
  const b = minutesOf(to);
  if (a === b) return true;
  return a < b ? minute >= a && minute < b : minute >= a || minute < b;
}

export function dayMatches(days: string, weekday: number): boolean {
  const weekend = weekday === 0 || weekday === 6;
  if (days === 'weekdays') return !weekend;
  if (days === 'weekends') return weekend;
  return true;
}

/** `{game}` and friends, filled in; a word nothing gave is left as written. */
export function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => vars[key] ?? whole);
}
