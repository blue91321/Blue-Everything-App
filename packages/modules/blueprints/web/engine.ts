/**
 * What a blueprint is, and how a run goes through it.
 *
 * Imports only the catalogue, which imports only `keys.ts`, so this is plain
 * logic the server runs and `blueprints-check` tests: a run is handed an
 * `Effects` that does the real asking and doing, and a test hands it one that
 * writes down what it was asked.
 *
 * ### Two kinds of wire
 *
 * Most wires say **where a run goes next**: from a box's output to the next
 * box's way in. One kind carries **an answer**: from a check's (or a gate's)
 * *Answer* to one of a gate's lettered inputs, with `port` naming which. A
 * gate asks for its inputs' answers when a run reaches it, the way Unreal
 * evaluates a pure node only when something needs its value, so a check wired
 * only into a gate is asked then and not before.
 *
 * A third carries **a number** (2026-11-03): from a Random number into a
 * Counter's X. A number only goes into a way in that takes one, and an answer
 * only into one that takes an answer, so the two cannot be crossed.
 *
 * Since 2026-11-04 a number goes into **any number a box is filled in with**,
 * and into the letters of a sum. A box is handed to the server with them
 * filled in (`resolve`): a number wired in, kept to what the field allows, in
 * place of the one typed, and each sum worked out to its number. So the server
 * reads a Wait's minutes the same way whether they were typed or wired.
 */
import { fieldPort, fieldShown, fieldValue, gate, GATES, inputsOf, letterPort, outputsOf, specOf, type NodeSpec } from './catalogue.js';
import { asNumber, evaluate, formatNumber, lettersOf, MathError, parseMath, variableName } from './maths.js';
import { shapeFromBeep, soundShapeText } from './sound-design.js';

export interface GraphNode {
  id: string;
  type: string;
  x: number;
  y: number;
  fields: Record<string, string | number>;
  /** A colour of your own for its head, `#rrggbb`, only to find it by on the board. */
  color?: string;
}

/**
 * From one box's output (`pin`) to another box. Without `port` it leads a run
 * on; with one (`c0`, `c1`…) it carries a yes-or-no answer into a gate.
 */
export interface Wire {
  id: string;
  from: string;
  pin: string;
  to: string;
  port?: string;
}

export interface Graph {
  nodes: GraphNode[];
  wires: Wire[];
}

export interface Blueprint {
  id: string;
  name: string;
  enabled: boolean;
  graph: Graph;
  /** Set when it switched itself off, saying why. Cleared by switching it on. */
  stopped: string | null;
  /** The folder it is in on the list, by id; null at the top. Only where it is listed. */
  folder?: string | null;
  createdAt: number;
  updatedAt: number;
}

/** `stopped` is a run ended on purpose: a hotkey pressed again, Stop pressed. Not a failure. */
export type StepResult = 'started' | 'yes' | 'no' | 'done' | 'failed' | 'stopped';

export interface Step {
  node: string;
  result: StepResult;
  /** What it did or found, in words: "Nudged: Drink some water". */
  said: string;
  /** The output it left by, when it left by one, for lighting the wire it took. */
  pin?: string;
}

/** Thrown by `pause` or `alive` when the run has been stopped on purpose. */
export class RunStopped extends Error {}

/** What a box can ask of the values wired into it. */
export interface Inputs {
  /** The number wired into this way in, or null with nothing wired there. Asked only when wanted. */
  number(port: string): Promise<number | null>;
}

export interface Effects {
  /** A check's answer, with a few words saying why. A counter reads its X through `inputs`. */
  check(node: GraphNode, spec: NodeSpec, inputs: Inputs): Promise<{ yes: boolean; said: string }>;
  /**
   * A number box's value. Without it a random number is picked here, which is
   * all a Random number does; a test hands in its own so the run is the same each time.
   */
  number?(node: GraphNode, spec: NodeSpec): Promise<number>;
  /**
   * Do it, and say what was done. Throws to fail the step. A box with more
   * than one way on (Ask me: answered, or not) says which it left by.
   */
  act(node: GraphNode, spec: NodeSpec): Promise<string | { said: string; pin: string }>;
  /** A variable's value, for a `{word}` the run itself does not give. */
  variable?(name: string): number | string | undefined;
  /** The gap between a repeat's goes. Throws `RunStopped` if the run is stopped meanwhile. */
  pause?(ms: number): Promise<void>;
  /** Asked between one box and the next; throws `RunStopped` once the run has been stopped. */
  alive?(): void;
  /**
   * The run is over (a path failed or was stopped) while other paths may still
   * be going: wake any of them that is waiting, so it ends now rather than when
   * its wait would have.
   */
  halt?(): void;
  /** Told after each go of a repeat, so a long one can be shown as far as it has got. */
  progress?(): void;
  /**
   * A test: a repeat goes only its first few times, with no gaps, since a test
   * of "every second until stopped" would otherwise never come back.
   */
  rehearsal?: boolean;
}

export const LIMITS = {
  nodes: 200,
  wires: 400,
  /** Boxes in a row with no pause between them: past this it is a loop with no wait. */
  steps: 50,
  /** Steps written down for one run. A repeat's later goes are not, beyond its first few. */
  kept: 200,
  /** A repeat "until it is stopped" still ends somewhere. */
  forever: 100_000,
} as const;

/** How many of a repeat's goes are written down step by step; after that, only a count. */
const SHOWN_GOES = 3;

/**
 * A graph as the screen sent it, made safe to keep: unknown boxes and fields
 * dropped, numbers clamped, wires that point nowhere removed, and no wire
 * twice. A way out may lead to several boxes (2026-11-05); they run one after
 * another, top to bottom, as a Sequence's ways out do.
 */
export function cleanGraph(raw: unknown): Graph {
  const input = (raw && typeof raw === 'object' ? raw : {}) as { nodes?: unknown; wires?: unknown };
  const nodes: GraphNode[] = [];
  const ids = new Set<string>();
  const { nodes: given, wires: givenWires } = splitEveryBoxes(
    Array.isArray(input.nodes) ? input.nodes : [],
    Array.isArray(input.wires) ? input.wires : []
  );
  for (const n of given.slice(0, LIMITS.nodes)) {
    if (!n || typeof n !== 'object') continue;
    const node = n as Partial<GraphNode>;
    const spec = typeof node.type === 'string' ? specOf(node.type) : undefined;
    if (!spec || typeof node.id !== 'string' || !/^[\w-]{1,40}$/.test(node.id) || ids.has(node.id)) continue;
    const fields: Record<string, string | number> = {};
    const given = upgradeFields(spec.type, node.fields);
    for (const f of spec.fields) fields[f.key] = fieldValue(f, given?.[f.key]);
    const color = typeof node.color === 'string' && /^#[0-9a-f]{6}$/i.test(node.color) ? node.color.toLowerCase() : undefined;
    nodes.push({ id: node.id, type: spec.type, x: finite(node.x), y: finite(node.y), fields, ...(color ? { color } : {}) });
    ids.add(node.id);
  }
  return { nodes, wires: keepWires(nodes, givenWires) };
}

/**
 * A box's fields as an older screen saved them, brought up to date before they
 * are cleaned: a "Play a sound" beep or sweep (until 2026-11-07) is a drawn
 * sound of one line now, with the same pitch, length and wave.
 */
function upgradeFields(type: string, raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const fields = raw as Record<string, unknown>;
  if (type === 'play-sound' && (fields.sound === 'beep' || fields.sound === 'sweep')) {
    return { ...fields, sound: 'custom', shape: soundShapeText(shapeFromBeep(fields)) };
  }
  return fields;
}

/**
 * "Every so many times" was one box until 2026-11-03: a count and a random
 * target in one. It is a Random number wired into a Counter now, so a blueprint
 * saved with the old box is rebuilt that way as it is read. The counter keeps
 * the old box's id, so its wires and its place in a run log stay; the random
 * number is added beside it only when the two ends differ, since "exactly 5"
 * is just a counter.
 */
function splitEveryBoxes(nodes: unknown[], wires: unknown[]): { nodes: unknown[]; wires: unknown[] } {
  if (!nodes.some((n) => (n as { type?: unknown } | null)?.type === 'if-every')) return { nodes, wires };
  const taken = new Set(nodes.map((n) => String((n as { id?: unknown } | null)?.id)));
  const outNodes: unknown[] = [];
  const outWires = [...wires];
  for (const n of nodes) {
    const node = n as Partial<GraphNode> | null;
    if (node?.type !== 'if-every') {
      outNodes.push(n);
      continue;
    }
    const a = Math.round(Number(node.fields?.min) || 1);
    const b = Math.round(Number(node.fields?.max) || a);
    const min = Math.max(1, Math.min(a, b));
    const max = Math.max(1, a, b);
    outNodes.push({ ...node, type: 'counter', fields: { times: min } });
    if (max === min || typeof node.id !== 'string') continue;
    let id = `${node.id.slice(0, 36)}-rnd`;
    for (let k = 2; taken.has(id); k += 1) id = `${node.id.slice(0, 33)}-rnd${k}`;
    taken.add(id);
    // Under the counter, where a box of its own is least likely to be already.
    outNodes.push({ id, type: 'random-number', x: finite(node.x), y: finite(node.y) + 340, fields: { min, max } });
    outWires.push({ id: `${id}-w`, from: id, pin: 'value', to: node.id, port: 'x' });
  }
  return { nodes: outNodes, wires: outWires };
}

/**
 * The wires that still make sense between these boxes. Also what the board
 * runs after a box's count changes, so a gate cut from three inputs to two
 * loses the wire into C rather than drawing it into nothing.
 */
export function keepWires(nodes: GraphNode[], raw: unknown[]): Wire[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const wires: Wire[] = [];
  const taken = new Set<string>();
  for (const w of raw.slice(0, LIMITS.wires)) {
    if (!w || typeof w !== 'object') continue;
    const wire = w as Partial<Wire>;
    const from = typeof wire.from === 'string' ? byId.get(wire.from) : undefined;
    const to = typeof wire.to === 'string' ? byId.get(wire.to) : undefined;
    if (!from || !to || from === to) continue;
    const out = outputsOf(from).find((o) => o.id === wire.pin);
    if (!out) continue;
    let key: string;
    let port: string | undefined;
    if (out.value) {
      // A value goes into one way in that takes its kind, and one value per way in.
      if (typeof wire.port !== 'string' || !inputsOf(to).some((p) => p.id === wire.port && Boolean(p.number) === Boolean(out.number))) continue;
      port = wire.port;
      key = `into:${to.id}:${port}`;
    } else {
      // Nothing leads into an event, where a run starts, or into a box that is only asked.
      const toSpec = specOf(to.type)!;
      if (toSpec.kind === 'event' || toSpec.pure) continue;
      // Several boxes from one way out, but each only once.
      key = `${from.id}:${wire.pin}:${to.id}`;
    }
    if (taken.has(key)) continue;
    taken.add(key);
    const id = typeof wire.id === 'string' ? wire.id.slice(0, 40) : key;
    wires.push(port ? { id, from: from.id, pin: wire.pin!, to: to.id, port } : { id, from: from.id, pin: wire.pin!, to: to.id });
  }
  return wires;
}

function finite(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(-50_000, Math.min(50_000, Math.round(n))) : 0;
}

/**
 * Every box a way out leads to, top to bottom on the board and then left to
 * right. They all start at once; the order is only so a run's steps and a
 * Sequence read the way the board does. Answers and numbers are not followed:
 * they are asked for.
 */
export function nextAll(graph: Graph, from: string, pin: string): string[] {
  const at = new Map(graph.nodes.map((n) => [n.id, n]));
  return graph.wires
    .filter((w) => w.from === from && w.pin === pin && !w.port)
    .map((w) => w.to)
    .sort((a, b) => (at.get(a)?.y ?? 0) - (at.get(b)?.y ?? 0) || (at.get(a)?.x ?? 0) - (at.get(b)?.x ?? 0));
}

/** Where a box's output leads first, if anywhere. */
export function next(graph: Graph, from: string, pin: string): string | null {
  return nextAll(graph, from, pin)[0] ?? null;
}

/** For a way out with several wires, each wire's place top to bottom (1, 2, …). */
export function wireOrder(graph: Graph): Map<string, number> {
  const order = new Map<string, number>();
  const done = new Set<string>();
  for (const w of graph.wires) {
    if (w.port || done.has(`${w.from}:${w.pin}`)) continue;
    done.add(`${w.from}:${w.pin}`);
    const targets = nextAll(graph, w.from, w.pin);
    if (targets.length < 2) continue;
    for (const other of graph.wires) {
      if (other.port || other.from !== w.from || other.pin !== w.pin) continue;
      order.set(other.id, targets.indexOf(other.to) + 1);
    }
  }
  return order;
}

/** A repeat's gap in words: "2 seconds", "1.5 minutes", "25 milliseconds". */
export function everyLabel(fields: Record<string, string | number>): string {
  const n = Number(fields.every);
  const unit = fields.unit === 'minutes' ? 'minute' : fields.unit === 'ms' ? 'millisecond' : 'second';
  return `${formatNumber(n)} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * A repeat's gap in milliseconds: at least one, so a repeat always gives way,
 * and at most a day. It was a tenth of a second at least until milliseconds
 * were offered (2026-11-05); the wait is the server's, on time to the
 * millisecond (`fine-timer.ts`).
 */
export function everyMs(fields: Record<string, string | number>): number {
  const per = fields.unit === 'minutes' ? 60_000 : fields.unit === 'ms' ? 1 : 1000;
  return Math.min(86_400_000, Math.max(1, Number(fields.every) * per));
}

class Ended extends Error {}

/**
 * A box answered by asking `effects.check`: every check, and the Counter,
 * which is filed under Logic (it decides from a count, not from the world) but
 * answers yes or no the same way.
 */
function asked(spec: NodeSpec): boolean {
  return (spec.kind === 'branch' && spec.type !== 'if-true') || spec.type === 'counter';
}

/**
 * Run from one event, one box at a time, until a box leads nowhere.
 *
 * A wire can loop back, which is allowed, since "nudge, wait, check again" is
 * a real thing to want; what is not allowed is a loop with nothing pausing in
 * it. Fifty boxes in a row without a Wait or a repeat's gap ends the run as a
 * failure that says so.
 *
 * `steps` is filled as it goes, so a run waiting halfway can be shown as far
 * as it has got. `vars` are the `{words}`; a repeat sets `{count}` in it.
 *
 * A **sequence** runs everything after Then 1 to its end, then Then 2, and so
 * on. A **repeat** runs everything after Each time, pauses, and goes again,
 * then carries on from After the last. A failure anywhere ends the whole run,
 * and so does being stopped.
 */
export async function walk(
  graph: Graph,
  start: string,
  effects: Effects,
  steps: Step[] = [],
  vars: Record<string, string> = {}
): Promise<Step[]> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const first = byId.get(start);
  if (!first) {
    steps.push({ node: start, result: 'failed', said: 'That box is not in the blueprint any more.' });
    return steps;
  }
  const pause = effects.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  /**
   * Each path a run takes keeps its own count of boxes since its last pause:
   * several wires from one way out start together, and a Wait on one must not
   * excuse a loop with no pause in it on another.
   */
  type Path = { since: number };
  /** Set when one path failed or was stopped, which ends the rest at their next box. */
  let over = false;
  let quiet = 0;
  let unwritten = 0;

  const note = (step: Step) => {
    if (quiet > 0 && step.result !== 'failed' && step.result !== 'stopped') return;
    if (steps.length >= LIMITS.kept && step.result !== 'failed' && step.result !== 'stopped') {
      unwritten += 1;
      return;
    }
    steps.push(step);
  };

  /** Run something that may fail or be stopped; either ends the run, written down. */
  async function guarded<T>(node: string, what: () => Promise<T> | T): Promise<T> {
    try {
      return await what();
    } catch (error) {
      if (error instanceof Ended) throw error;
      // Another path already ended the run: this one goes quietly, having been ended by it.
      if (over) throw new Ended();
      const stopped = error instanceof RunStopped;
      steps.push({ node, result: stopped ? 'stopped' : 'failed', said: (error as Error).message });
      end();
      throw new Ended();
    }
  }

  const fail = (node: string, said: string): never => {
    if (!over) steps.push({ node, result: 'failed', said });
    end();
    throw new Ended();
  };

  /** The run is over: every other path stops at its next box, and one waiting is woken to. */
  function end(): void {
    if (over) return;
    over = true;
    effects.halt?.();
  }

  /** What a box can ask of the values wired into it. */
  const inputsFor = (node: GraphNode, seen: Set<string>): Inputs => ({
    number: async (port) => {
      const wire = graph.wires.find((w) => w.to === node.id && w.port === port);
      return wire ? numberOf(wire.from, new Set(seen).add(node.id)) : null;
    },
  });

  /** A `{word}` in a sum: the run's own words first, then the variables. */
  const word = (name: string) => vars[name] ?? effects.variable?.(name);

  /**
   * A sum worked out, with what went into it said: "a + b = 7 (a is 3, b is
   * 4)". A letter's number is what is wired into it, asked for only now.
   */
  async function sum(node: GraphNode, src: string, seen: Set<string>): Promise<{ value: number; said: string }> {
    const values: Record<string, number> = {};
    for (const letter of lettersOf(src)) {
      const wire = graph.wires.find((w) => w.to === node.id && w.port === letterPort(letter));
      if (wire) values[letter] = await numberOf(wire.from, new Set(seen).add(node.id));
    }
    let value = 0;
    try {
      value = evaluate(src, { letter: (l) => values[l], word });
    } catch (error) {
      if (error instanceof MathError) fail(node.id, `${src.trim() || 'The sum'}: ${error.message}`);
      throw error;
    }
    const parsed = parseMath(src);
    const parts = [
      ...Object.entries(values).map(([l, v]) => `${l} is ${formatNumber(v)}`),
      ...(parsed.ok ? parsed.words : []).map((w) => `{${w}} is ${String(word(w))}`),
    ];
    return { value, said: parts.length ? ` (${parts.join(', ')})` : '' };
  }

  /**
   * A box with what is wired into it filled in: a number wired into a field
   * in place of the one typed, kept to what the field allows, and each sum
   * worked out. A When box is left as it is.
   */
  async function resolve(node: GraphNode, seen: Set<string>): Promise<GraphNode> {
    const spec = specOf(node.type)!;
    if (spec.kind === 'event') return node;
    let fields = node.fields;
    for (const f of spec.fields) {
      if (!fieldShown(f, node.fields)) continue;
      if (f.kind === 'number' && f.wire !== false) {
        const wire = graph.wires.find((w) => w.to === node.id && w.port === fieldPort(f.key));
        if (wire) fields = { ...fields, [f.key]: fieldValue(f, await numberOf(wire.from, new Set(seen).add(node.id))) };
      } else if (f.kind === 'math') {
        fields = { ...fields, [f.key]: (await sum(node, String(node.fields[f.key] ?? ''), seen)).value };
      }
    }
    return fields === node.fields ? node : { ...node, fields };
  }

  /** "Is it true that…": its sum, yes when it is not zero. */
  async function truth(node: GraphNode, seen: Set<string>): Promise<{ yes: boolean; said: string }> {
    const src = String(node.fields.expr ?? '');
    const { value, said } = await sum(node, src, seen);
    const yes = value !== 0;
    return { yes, said: `${src.trim()}${said}: ${yes ? 'yes' : 'no'}` };
  }

  /** A number box's value, for a box that wants it. */
  async function numberOf(id: string, seen: Set<string>): Promise<number> {
    if (seen.has(id)) fail(id, 'These boxes feed each other in a circle, so none of them has a value.');
    const raw = byId.get(id)!;
    const spec = specOf(raw.type)!;
    if (raw.type === 'math') {
      const src = String(raw.fields.expr ?? '');
      const { value, said } = await sum(raw, src, seen);
      note({ node: id, result: 'done', said: `${src.trim()} = ${formatNumber(value)}${said}` });
      return value;
    }
    if (raw.type === 'variable') {
      const name = variableName(raw.fields.name);
      if (!name) return fail(id, 'Name the variable this box gives: letters, numbers and _, like score.');
      const held = effects.variable?.(name);
      if (held === undefined) return fail(id, `{${name}} is not set yet: set it with "Set a variable" first.`);
      let value = 0;
      try {
        value = asNumber(held, name);
      } catch (error) {
        if (error instanceof MathError) return fail(id, error.message);
        throw error;
      }
      if (raw.fields.as === 'percent') {
        note({ node: id, result: 'done', said: `{${name}} is ${formatNumber(value)}%, so ${formatNumber(value / 100)}` });
        return value / 100;
      }
      note({ node: id, result: 'done', said: `{${name}} is ${formatNumber(value)}` });
      return value;
    }
    if (raw.type !== 'random-number') return fail(id, 'Only a Random number, a Variable or a Math box has a number to give.');
    const node = await resolve(raw, seen);
    const range = randomRange(node.fields);
    if (!range) return fail(id, `There is no whole number between ${formatNumber(Number(node.fields.min))} and ${formatNumber(Number(node.fields.max))}.`);
    const value = await guarded(id, () => (effects.number ? effects.number(node, spec) : pickRandom(range)));
    const { low, high } = range;
    note({ node: id, result: 'done', said: low === high ? formatNumber(value) : `Picked ${formatNumber(value)}, between ${formatNumber(low)} and ${formatNumber(high)}` });
    return value;
  }

  /** A check's or a gate's answer, for a gate that wants it. */
  async function answer(id: string, seen: Set<string>): Promise<boolean> {
    const node = byId.get(id)!;
    const spec = specOf(node.type)!;
    if (asked(spec)) {
      const filled = await resolve(node, seen);
      const { yes, said } = await guarded(id, () => effects.check(filled, spec, inputsFor(node, seen)));
      note({ node: id, result: yes ? 'yes' : 'no', said });
      return yes;
    }
    if (node.type === 'if-true') {
      const { yes, said } = await truth(node, seen);
      note({ node: id, result: yes ? 'yes' : 'no', said });
      return yes;
    }
    if (node.type === 'logic-gate') {
      const { yes, said } = await gateAnswer(node, seen);
      note({ node: id, result: yes ? 'yes' : 'no', said });
      return yes;
    }
    return fail(id, 'Only a check or a gate has an answer to give.');
  }

  async function gateAnswer(node: GraphNode, seen: Set<string>): Promise<{ yes: boolean; said: string }> {
    if (seen.has(node.id)) fail(node.id, 'These gates feed each other in a circle, so none of them has an answer.');
    const inner = new Set(seen).add(node.id);
    const parts: string[] = [];
    const answers: boolean[] = [];
    for (const port of inputsOf(node)) {
      const wire = graph.wires.find((w) => w.to === node.id && w.port === port.id);
      if (!wire) continue;
      const yes = await answer(wire.from, inner);
      answers.push(yes);
      parts.push(`${port.label} ${yes ? 'yes' : 'no'}`);
    }
    if (answers.length === 0) fail(node.id, "Nothing is wired into this gate: wire a check's Answer into A.");
    const op = String(node.fields.op);
    const yes = gate(op, answers);
    const name = GATES.find((g) => g.id === op)?.label.split(':')[0] ?? op;
    return { yes, said: `${name} of ${parts.join(', ')}: ${yes ? 'yes' : 'no'}` };
  }

  async function repeat(node: GraphNode, path: Path): Promise<void> {
    const forever = node.fields.until === 'stopped';
    const times = forever ? LIMITS.forever : Number(node.fields.times);
    const gap = everyMs(node.fields);
    const every = everyLabel(node.fields);
    const step: Step = { node: node.id, result: 'done', said: `Starting, every ${every}` };
    note(step);
    if (effects.rehearsal) {
      const tried = Math.min(times, SHOWN_GOES);
      for (let k = 1; k <= tried; k += 1) {
        // Each go stands for one after a gap, so the no-pause count starts again.
        path.since = 0;
        vars.count = String(k);
        await followAll(node.id, 'each', path);
      }
      step.said = `Would go ${forever ? 'until stopped' : `${times} time${times === 1 ? '' : 's'}`}, every ${every}; tried the first ${tried} without the gaps`;
      return;
    }
    let went = 0;
    for (let k = 1; k <= times; k += 1) {
      if (k > 1 || node.fields.first === 'wait') {
        await guarded(node.id, () => pause(gap));
        path.since = 0;
      }
      vars.count = String(k);
      if (k > SHOWN_GOES) quiet += 1;
      try {
        await followAll(node.id, 'each', path);
      } finally {
        if (k > SHOWN_GOES) quiet -= 1;
        went = k;
        step.said = `Went ${went} time${went === 1 ? '' : 's'}${forever ? '' : ` of ${times}`}, every ${every}`;
        effects.progress?.();
      }
    }
    if (forever) step.said = `Went ${went} times, the most a repeat goes, every ${every}`;
  }

  /**
   * Every box a way out leads to, all at once, each its own path carrying on
   * from the count of the path it split from; done when every one is. A
   * failure on one ends them all, which `end` sees to.
   */
  async function followAll(from: string, pin: string, path: Path): Promise<void> {
    const targets = nextAll(graph, from, pin);
    if (targets.length === 1) return follow(targets[0]!, path);
    const settled = await Promise.allSettled(targets.map((to) => follow(to, { since: path.since })));
    const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
    if (failed) throw failed.reason;
  }

  /**
   * Where a run goes on to from here: the one box this way out leads to, or,
   * with several, all of them at once and then nowhere. Kept a loop rather
   * than recursion for the one-wire case, which is nearly every box.
   */
  async function onward(from: string, pin: string, path: Path): Promise<string | null> {
    const targets = nextAll(graph, from, pin);
    if (targets.length <= 1) return targets[0] ?? null;
    await followAll(from, pin, path);
    return null;
  }

  async function follow(from: string | null, path: Path): Promise<void> {
    let at = from;
    while (at) {
      const id = at;
      if (over) throw new Ended();
      await guarded(id, () => effects.alive?.());
      if (++path.since > LIMITS.steps) {
        fail(id, `Stopped after ${LIMITS.steps} boxes with no pause: the wires go round in a loop with no wait in it.`);
      }
      const node = byId.get(id)!;
      const spec = specOf(node.type)!;
      if (asked(spec)) {
        const filled = await resolve(node, new Set());
        const { yes, said } = await guarded(id, () => effects.check(filled, spec, inputsFor(node, new Set())));
        const pin = yes ? 'yes' : 'no';
        if (over) throw new Ended();
        note({ node: id, result: pin, said, pin });
        at = await onward(id, pin, path);
      } else if (node.type === 'if-true') {
        const { yes, said } = await truth(node, new Set());
        const pin = yes ? 'yes' : 'no';
        note({ node: id, result: pin, said, pin });
        at = await onward(id, pin, path);
      } else if (node.type === 'logic-gate') {
        const { yes, said } = await gateAnswer(node, new Set());
        const pin = yes ? 'yes' : 'no';
        note({ node: id, result: pin, said, pin });
        at = await onward(id, pin, path);
      } else if (node.type === 'sequence') {
        // The one box that does keep an order: each way out runs to its end before the next.
        const outs = outputsOf(node);
        note({ node: id, result: 'done', said: `${outs.length} ways out, one after another` });
        for (const out of outs) await followAll(id, out.id, path);
        at = null;
      } else if (node.type === 'repeat') {
        await repeat(await resolve(node, new Set()), path);
        at = await onward(id, 'done', path);
      } else {
        const filled = await resolve(node, new Set());
        const done = await guarded(id, () => effects.act(filled, spec));
        // Ended by another path while this one's box was doing its thing: say nothing more.
        if (over) throw new Ended();
        const { said, pin } = typeof done === 'string' ? { said: done, pin: 'then' } : done;
        // Waiting on a person counts as a pause, as a Wait does.
        if (node.type === 'wait' || node.type === 'ask') path.since = 0;
        note({ node: id, result: 'done', said, pin });
        at = await onward(id, pin, path);
      }
    }
  }

  steps.push({ node: first.id, result: 'started', said: specOf(first.type)?.label ?? first.type, pin: 'then' });
  try {
    await followAll(first.id, 'then', { since: 0 });
  } catch (error) {
    if (!(error instanceof Ended)) throw error;
  }
  if (unwritten > 0) {
    steps.push({ node: steps.at(-1)!.node, result: 'done', said: `…and ${unwritten} more step${unwritten === 1 ? '' : 's'}, not written down` });
  }
  return steps;
}

/**
 * Boxes no event can reach, which will never run. The screen marks them. A
 * check wired only into a gate is reached when the gate is, since that is
 * when it is asked.
 */
export function unreachable(graph: Graph): Set<string> {
  const reached = new Set<string>();
  const queue = graph.nodes.filter((n) => specOf(n.type)?.kind === 'event').map((n) => n.id);
  while (queue.length) {
    const id = queue.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    for (const w of graph.wires) {
      if (w.from === id && !w.port) queue.push(w.to);
      if (w.to === id && w.port) queue.push(w.from);
    }
  }
  // A Variable box names a variable and says where it starts: it is read by name, so it needs no wire to count.
  return new Set(graph.nodes.filter((n) => !reached.has(n.id) && n.type !== 'variable').map((n) => n.id));
}

/**
 * What a Random number picks from: both ends, in order, and how. Whole numbers
 * are those between the ends (8.5 to 12 is 9 to 12); null when there are none.
 */
export interface RandomRange {
  low: number;
  high: number;
  /** Decimal places, or null for whole numbers. */
  places: number | null;
}
export function randomRange(fields: Record<string, string | number>): RandomRange | null {
  const a = Number(fields.min);
  const b = Number(fields.max);
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  if (fields.gives === 'decimal') {
    const places = Math.max(0, Math.min(6, Math.round(Number(fields.places ?? 2)) || 0));
    return { low: lo, high: hi, places };
  }
  const low = Math.ceil(lo - 1e-9);
  const high = Math.floor(hi + 1e-9);
  return low <= high ? { low, high, places: null } : null;
}

/** One pick: every whole number equally, or anywhere between the ends to so many places, both ends included. */
export function pickRandom(r: RandomRange, random: () => number = Math.random): number {
  if (r.places === null) return r.low + Math.floor(random() * (r.high - r.low + 1));
  const step = 10 ** -r.places;
  // Counted in steps, so the far end comes up as often as any other value.
  const steps = Math.round((r.high - r.low) / step);
  const value = r.low + Math.floor(random() * (steps + 1)) * step;
  return Number(Math.min(r.high, value).toFixed(r.places));
}
