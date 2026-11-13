/**
 * Finding a box to add by what you would call it (2026-11-03).
 *
 * The Add menu was the whole catalogue in four lists, and the box you wanted
 * was found by reading all of them. So it searches now, and not only the
 * names: each box has the other things somebody might type for it, so
 * "while playing" or "if playing" finds **Am I…**, "reload" finds the
 * **Counter**, and "afk" finds leaving and coming back. A box found through
 * one of those says which, so it is clear why it is there.
 *
 * Imports only the catalogue, so `blueprints-check` tests it directly.
 */
import { KIND_LABEL, NODES, type NodeSpec } from './catalogue.js';

/** Other words for each box, beyond its name and its line of description. */
export const KEYWORDS: Record<string, string[]> = {
  'on-stop': ['match ends', 'game over', 'after a game', 'end of a match', 'between rounds', 'break', 'stopping point', 'died'],
  'on-game-start': ['start playing', 'game starts', 'game opens', 'open a game', 'launch a game', 'begin playing', 'when playing'],
  'on-away': ['leave', 'afk', 'away', 'step away', 'gone', 'idle'],
  'on-back': ['come back', 'return', 'welcome', 'back at the desk', 'sit down', 'afk over'],
  'on-habit': ['habit done', 'habit ticked', 'complete a habit', 'drink water'],
  'on-task-done': ['task finished', 'task complete', 'check off', 'done'],
  'on-switch': ['while a switch is on', 'while on', 'switch turns on', 'switch turns off', 'toggled', 'loop while', 'mode on', 'every few seconds'],
  'on-task-added': ['new task', 'task created', 'todo added'],
  'on-time': ['schedule', 'alarm', 'clock', 'daily', 'every day at', 'morning', 'night', 'at a time'],
  'on-every': ['interval', 'timer', 'every minute', 'every hour', 'periodic', 'recurring', 'every so often'],
  'on-hotkey': ['key', 'keyboard', 'shortcut', 'keybind', 'bind', 'hotkey', 'mouse', 'mouse button', 'side button', 'click', 'macro', 'press'],
  'on-voice': ['voice', 'speak', 'say', 'phrase', 'spoken', 'talk', 'voice command'],
  'on-button': ['by hand', 'manual', 'run button', 'run it myself'],
  'if-doing': [
    'while playing',
    'if playing',
    'when playing',
    'in a game',
    'in game',
    'playing',
    'gaming',
    'game open',
    'game running',
    'am i',
    'what am i doing',
    'busy',
    'free',
    'away',
    'afk',
  ],
  'if-time': ['between', 'time range', 'hours', 'after', 'before', 'at night', 'in the morning'],
  'if-day': ['weekday', 'weekend', 'day of the week', 'monday', 'saturday', 'sunday'],
  'if-habit': ['habit done', 'did i', 'have i', 'finished habit', 'gauge'],
  'if-held': ['holding', 'held', 'still holding', 'key down', 'pressed', 'button down', 'while held', 'hold'],
  'if-switch': ['toggle', 'flag', 'is on', 'is off', 'mode', 'state', 'enabled'],
  'if-true': ['compare', 'comparison', 'greater than', 'less than', 'equals', 'if variable', 'condition', 'expression', 'formula', 'is more than', 'check a number', 'if'],
  'random-number': ['random', 'rng', 'random number generator', 'dice', 'roll', 'chance', 'sometimes', 'pick a number', 'between'],
  math: ['maths', 'calculate', 'calculator', 'formula', 'equation', 'expression', 'desmos', 'add', 'plus', 'minus', 'multiply', 'divide', 'sum', 'number', 'arithmetic', 'sqrt', 'round'],
  counter: ['count', 'every nth', 'every n times', 'every few', 'every so many times', 'after x times', 'nth time', 'reload', 'ammo', 'tally'],
  'logic-gate': ['and', 'or', 'not', 'nand', 'nor', 'xor', 'both', 'either', 'combine', 'condition'],
  repeat: ['loop', 'again', 'while held', 'while i hold', 'hold', 'spam', 'rapid fire', 'auto', 'every second', 'until stopped'],
  sequence: ['then', 'in order', 'one after another', 'several', 'multiple', 'branch'],
  nudge: ['notify', 'notification', 'nudge', 'remind', 'reminder', 'popup', 'alert', 'message', 'tell me', 'show', 'toast'],
  'add-task': ['todo', 'to do', 'task', 'create a task', 'remind me later'],
  'tick-habit': ['habit', 'log a habit', 'mark a habit', 'record', 'drink'],
  'note-line': ['log', 'append', 'journal', 'write', 'record'],
  'set-switch': ['toggle', 'flag', 'turn on', 'turn off', 'enable', 'disable', 'mode', 'state'],
  variable: ['get a variable', 'read a variable', 'value of', 'use a variable', 'variable as a number', 'number from'],
  'set-variable': ['variable', 'var', 'store', 'save a number', 'remember', 'keep', 'score', 'total', 'increment', 'add one', 'count up', 'decrement', 'set'],
  'play-sound': ['sound', 'tone', 'speak', 'say', 'speech', 'text to speech', 'tts', 'talk', 'beep', 'click', 'tick', 'sweep', 'ding', 'noise', 'chime', 'audio', 'hear', 'ping', 'alert', 'wav', 'debug', 'is it working', 'metronome'],
  'show-popup': ['popup', 'pop up', 'show', 'message', 'overlay', 'on screen', 'alert', 'toast', 'say', 'colour', 'color'],
  ask: ['ask', 'question', 'input', 'type', 'text box', 'prompt', 'answer', 'reply', 'fill in', 'popup', 'notification'],
  wait: ['delay', 'pause', 'sleep', 'later', 'after a while'],
  'press-keys': ['key', 'keys', 'keyboard', 'type', 'send keys', 'macro', 'combo', 'sequence', 'timeline', 'hold a key', 'tap', 'input'],
  'open-url': ['website', 'link', 'browser', 'url', 'web page', 'youtube'],
  media: ['music', 'play', 'pause', 'skip', 'next track', 'volume', 'mute', 'song'],
  'launch-game': ['open a game', 'run a game', 'start a game', 'launch', 'steam'],
  'play-music': ['spotify', 'music', 'shuffle', 'playlist', 'songs'],
  'new-note': ['note', 'write down', 'jot', 'memo', 'dictate'],
};

/** Lower case, letters and digits only, one space between words: "Am I…" is "am i". */
export const fold = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export interface Found {
  spec: NodeSpec;
  /** The other word it was found by, when it was not its own name. */
  because: string | null;
}

/**
 * The boxes matching what was typed, best first. The whole phrase in a name
 * beats it in one of the other words, which beats every word of it found
 * somewhere in the box (a word counts when one of the box's words starts with
 * it, so "remi" finds reminders). Ties keep the catalogue's own order.
 */
export function searchBoxes(query: string, specs: readonly NodeSpec[] = NODES): Found[] {
  const q = fold(query);
  if (!q) return specs.map((spec) => ({ spec, because: null }));
  const words = q.split(' ');
  const scored: Array<{ found: Found; score: number; at: number }> = [];
  specs.forEach((spec, at) => {
    const name = fold(spec.label);
    const others = (KEYWORDS[spec.type] ?? []).map(fold);
    const named = [name, ...others, fold(KIND_LABEL[spec.kind])].join(' ').split(' ');
    const described = [...named, ...fold(spec.blurb).split(' ')];
    // A one-letter word is looked for in names only: nearly every description has a word starting with "a".
    const inBox = (w: string) => (w.length < 2 ? named : described).some((e) => e.startsWith(w));
    let score = 0;
    let because: string | null = null;
    if (name === q) score = 120;
    else if (name.includes(q)) score = 100;
    else {
      const exact = others.find((k) => k === q);
      // Three letters at least, or "a" would find every box with an "a" in another word.
      const partial = q.length >= 3 ? others.find((k) => k.includes(q) || (k.length > 3 && q.includes(k))) : undefined;
      if (exact) {
        score = 90;
        because = exact;
      } else if (partial) {
        score = 70;
        because = partial;
      } else if (words.every(inBox)) {
        score = words.every((w) => name.split(' ').some((e) => e.startsWith(w))) ? 60 : 40;
        const hit = others.find((k) => words.some((w) => k.split(' ').some((e) => e.startsWith(w))));
        because = score === 60 ? null : (hit ?? null);
      }
    }
    if (score > 0) scored.push({ found: { spec, because }, score, at });
  });
  return scored.sort((a, b) => b.score - a.score || a.at - b.at).map((s) => s.found);
}
