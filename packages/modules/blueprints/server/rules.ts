/**
 * The parts of the server half with nothing to do with the database: the
 * templates and a game's name from its file. When a timed box is due is
 * `web/schedule.ts`, since the screen shows it too.
 * Apart so `blueprints-check` can test them without opening anything real.
 */
import { randomUUID } from 'node:crypto';
import { cleanGraph, type Graph } from '../web/engine.js';

export function newId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

/* ---- Templates ------------------------------------------------------ */

export interface Template {
  id: string;
  name: string;
  blurb: string;
  graph: () => Graph;
}

/** A graph from a list of boxes left to right, each leading to the next by `pin`. */
function chain(boxes: Array<{ type: string; fields?: Record<string, string | number>; pin?: string; below?: boolean }>): Graph {
  const nodes = boxes.map((b, i) => ({ id: newId(), type: b.type, x: 40 + i * 280, y: b.below ? 200 : 60, fields: b.fields ?? {} }));
  const wires = nodes.slice(1).map((n, i) => ({ id: newId(), from: nodes[i]!.id, pin: boxes[i]!.pin ?? 'then', to: n.id }));
  return cleanGraph({ nodes, wires });
}

export const TEMPLATES: Template[] = [
  { id: 'empty', name: 'Empty', blurb: 'Start from nothing.', graph: () => ({ nodes: [], wires: [] }) },
  {
    id: 'water',
    name: 'Water after a match',
    blurb: 'When a match ends, if water is not done yet, remind me.',
    graph: () =>
      chain([
        { type: 'on-stop' },
        { type: 'if-habit', pin: 'no' },
        { type: 'nudge', fields: { title: 'Drink some water', when: 'soon' } },
      ]),
  },
  {
    id: 'log',
    name: 'Log what I play',
    blurb: 'Write a line in a note each time a game starts.',
    graph: () =>
      chain([
        { type: 'on-game-start' },
        { type: 'note-line', fields: { note: 'Games played', line: 'Started {game} at {time}' } },
      ]),
  },
  {
    id: 'break',
    name: 'Stretch after two hours',
    blurb: 'Two hours after a game starts, remind me to get up, if I am still playing.',
    graph: () =>
      chain([
        { type: 'on-game-start' },
        { type: 'wait', fields: { minutes: 120 } },
        { type: 'if-doing', fields: { state: 'in-game' }, pin: 'yes' },
        { type: 'nudge', fields: { title: 'Time to stretch', when: 'good' } },
      ]),
  },
  {
    id: 'voice',
    name: 'A voice command',
    blurb: 'When I say a phrase, do something. Add the Do boxes it leads to.',
    graph: () => chain([{ type: 'on-voice' }]),
  },
  {
    id: 'macro',
    name: 'Press a key over and over',
    blurb: 'A macro: Ctrl+Alt+M starts pressing E once a second, and pressing it again stops.',
    graph: () =>
      chain([
        { type: 'on-hotkey', fields: { keys: 'ctrl+alt+m', again: 'stop' } },
        { type: 'repeat', fields: { every: 1, unit: 'seconds', until: 'stopped', first: 'now' }, pin: 'each' },
        { type: 'press-keys', fields: { keys: 'e', hold: 30 } },
      ]),
  },
];

/** "Warframe.x64.exe" reads as "Warframe". */
export function gameName(exe: string): string {
  return exe.replace(/\.exe$/i, '').replace(/[._-]?(x64|x86|win64|win32|dx11|dx12|shipping)$/i, '').replace(/[._]+/g, ' ').trim() || exe;
}

/* ---- Voice commands from before blueprints ------------------------- */

/** A row of `voice_commands`, read; see `convert-voice.ts`. */
export interface OldCommand {
  id: string;
  kind: string;
  phrases: string[];
  target: string | null;
  label: string | null;
  enabled: boolean;
  allowFollowUp: boolean;
}

/** The Do box an old command becomes, or null for a kind that stays with voice. */
export function actionFor(command: OldCommand): { type: string; fields: Record<string, string | number> } | null {
  const target = command.target ?? '';
  switch (command.kind) {
    case 'habit':
      return { type: 'tick-habit', fields: { habit: target, howMany: 'said', amount: 1 } };
    case 'url':
      return { type: 'open-url', fields: { url: target } };
    case 'hotkey':
      return { type: 'press-keys', fields: { keys: target, hold: 30 } };
    case 'media':
      return { type: 'media', fields: { action: target } };
    case 'launch':
      return { type: 'launch-game', fields: { game: target.trim().toLowerCase() } };
    case 'music':
      // "queue" was its own choice once and has played since; it plays here too.
      return { type: 'play-music', fields: { what: target === 'random' ? 'random' : target === 'stop' ? 'stop' : 'shuffle' } };
    case 'note':
      return { type: 'new-note', fields: { text: '{said}' } };
  }
  return null;
}

/** "When I say" these phrases, then that box. */
export function graphFor(command: OldCommand): Graph | null {
  const action = actionFor(command);
  if (!action || command.phrases.length === 0) return null;
  const say = newId();
  const doIt = newId();
  return cleanGraph({
    nodes: [
      { id: say, type: 'on-voice', x: 40, y: 60, fields: { phrases: command.phrases.join('\n'), keep: command.allowFollowUp ? 'yes' : 'no' } },
      { id: doIt, type: action.type, x: 320, y: 60, fields: action.fields },
    ],
    wires: [{ id: newId(), from: say, pin: 'then', to: doIt }],
  });
}

/** A name for it: its own label, else what it does. */
export function nameFor(command: OldCommand, habitName?: string, gameName?: string): string {
  const label = command.label?.trim();
  // An old label that is only "open https://…" is the address, not a name.
  if (label && !/^(open|press|start) /.test(label)) return label.slice(0, 80);
  switch (command.kind) {
    case 'habit':
      return habitName ?? 'Tick a habit';
    case 'url':
      return `Open ${(() => {
        try {
          return new URL(command.target ?? '').hostname.replace(/^www\./, '');
        } catch {
          return 'a website';
        }
      })()}`;
    case 'hotkey':
      return `Press ${command.target}`;
    case 'launch':
      return `Start ${gameName ?? command.target}`;
    default:
      return label?.slice(0, 80) || `Say "${command.phrases[0]}"`;
  }
}

/** A Notification box's "Stays on screen for", in seconds: 0 is until it is closed. */
export function staysFor(fields: Record<string, unknown>): number {
  if (fields.staysUnit === 'close') return 0;
  const n = Number(fields.stays);
  const seconds = (Number.isFinite(n) && n > 0 ? n : 12) * (fields.staysUnit === 'minutes' ? 60 : 1);
  return Math.max(1, Math.min(24 * 60 * 60, seconds));
}
