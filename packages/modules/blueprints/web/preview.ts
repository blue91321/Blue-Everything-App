/**
 * What a number on a wire comes to, worked out on the board without running
 * anything: a Variable box gives what it holds (or its start), a Random number
 * the range it picks from, and a Math box its sum over every value its inputs
 * can take, so a sum fed by a Random number shows the range of its answers.
 *
 * Inputs are held as the values they can take. A Random number of 8 to 16 is
 * nine values and every one is tried, so the answer is exact; past a few
 * thousand combinations each input is thinned to evenly spaced values with
 * both ends kept, and the answer is marked "about", since a sum need not be
 * largest at an end (sin, or (a - 3)^2). Imports only the catalogue and the
 * maths, so `blueprints-check` can assert it.
 */
import { fieldPort, fieldShown, fieldValue, letterPort, specOf } from './catalogue.js';
import { randomRange, type Graph, type GraphNode } from './engine.js';
import { asNumber, evaluator, formatNumber, lettersOf, MathError, parseMath, variableName } from './maths.js';

export type Preview =
  /** Every value it can take, sorted; `exact` false when some were sampled. */
  | { kind: 'values'; values: number[]; exact: boolean }
  /** Only known when it runs: a letter with no wire, or a word the run gives. */
  | { kind: 'later'; why: string }
  | { kind: 'wrong'; why: string };

export interface PreviewScope {
  /** What each variable holds as far as the board can tell, starts included. */
  variables: Record<string, number | string>;
  /** The run's own words ({game}, {count}): known only when it runs. */
  placeholders: string[];
}

/** Values kept for one input before it is thinned. */
const KEEP = 200;
/** Combinations tried for one sum before its inputs are thinned. */
const TRIES = 4000;
/** Tries of each combination when the sum itself has random() in it. */
const RANDOM_TRIES = 40;

/** Every whole number from a to b, or evenly spaced values past `KEEP`. */
function span(low: number, high: number): { values: number[]; exact: boolean } {
  if (high - low + 1 <= KEEP && Number.isInteger(low) && Number.isInteger(high)) {
    return { values: Array.from({ length: high - low + 1 }, (_, i) => low + i), exact: true };
  }
  return { values: thin([low, high], KEEP), exact: low === high };
}

/** At most `n` of a sorted list, evenly spaced, both ends kept. */
function thin(values: number[], n: number): number[] {
  if (values.length <= n) return values;
  if (values.length === 2) {
    // Two ends of a stretch: fill it in.
    const [low, high] = values;
    return Array.from({ length: n }, (_, i) => low + ((high - low) * i) / (n - 1));
  }
  return Array.from({ length: n }, (_, i) => values[Math.round((i * (values.length - 1)) / (n - 1))]);
}

function settle(raw: number[], exact: boolean): Preview {
  const values = [...new Set(raw.map((v) => Number(v.toPrecision(12))))].sort((a, b) => a - b);
  if (values.length <= KEEP) return { kind: 'values', values, exact };
  return { kind: 'values', values: thin(values, KEEP), exact: false };
}

/** What the number box `id` gives, for a box that has it wired in. */
export function previewNumber(graph: Graph, id: string, scope: PreviewScope, seen: Set<string> = new Set()): Preview {
  if (seen.has(id)) return { kind: 'wrong', why: 'These boxes feed each other in a circle.' };
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) return { kind: 'wrong', why: 'The box it comes from has gone.' };
  const inner = new Set(seen).add(id);
  if (node.type === 'variable') {
    const name = variableName(node.fields.name);
    if (!name) return { kind: 'wrong', why: 'The Variable box has no name yet.' };
    const held = scope.variables[name];
    if (held === undefined) return { kind: 'wrong', why: `{${name}} is not set yet.` };
    try {
      // A percentage is held as typed, 123.5, and given as 1.235.
      const value = asNumber(held, name);
      return { kind: 'values', values: [node.fields.as === 'percent' ? value / 100 : value], exact: true };
    } catch (error) {
      return { kind: 'wrong', why: error instanceof MathError ? error.message : String(error) };
    }
  }
  if (node.type === 'math') return previewSum(graph, node, String(node.fields.expr ?? ''), scope, inner);
  if (node.type === 'random-number') {
    const spec = specOf(node.type)!;
    const ends: number[][] = [];
    for (const key of ['min', 'max']) {
      const f = spec.fields.find((s) => s.key === key)!;
      const wire = graph.wires.find((w) => w.to === node.id && w.port === fieldPort(key));
      if (!wire) {
        ends.push([Number(fieldValue(f, node.fields[key] ?? f.default))]);
        continue;
      }
      const fed = previewNumber(graph, wire.from, scope, inner);
      if (fed.kind !== 'values') return fed;
      ends.push(fed.values.map((v) => Number(fieldValue(f, v))));
    }
    const all = [...ends[0], ...ends[1]];
    const range = randomRange({ ...node.fields, min: Math.min(...all), max: Math.max(...all) });
    if (!range) return { kind: 'wrong', why: 'There is no whole number between its two ends.' };
    if (range.places !== null) {
      // Every value it can give, if there are few enough; otherwise spaced across the range.
      const steps = Math.round((range.high - range.low) * 10 ** range.places);
      if (steps + 1 <= KEEP) {
        return { kind: 'values', values: Array.from({ length: steps + 1 }, (_, i) => Number((range.low + i / 10 ** range.places!).toFixed(range.places!))), exact: true };
      }
      return { kind: 'values', values: thin([range.low, range.high], KEEP), exact: false };
    }
    const { values, exact } = span(range.low, range.high);
    return { kind: 'values', values, exact };
  }
  return { kind: 'wrong', why: 'Only a Random number, a Variable or a Math box has a number to give.' };
}

/** What a sum on `node` comes to, with its letters' wires and the variables filled in. */
export function previewSum(graph: Graph, node: GraphNode, src: string, scope: PreviewScope, seen: Set<string> = new Set()): Preview {
  const parsed = parseMath(src);
  if (!parsed.ok) return { kind: 'wrong', why: parsed.error };
  const letters = lettersOf(src);
  const inputs: Array<{ letter: string; values: number[]; exact: boolean }> = [];
  for (const letter of letters) {
    const wire = graph.wires.find((w) => w.to === node.id && w.port === letterPort(letter));
    if (!wire) return { kind: 'later', why: `Wire a number into ${letter} on the left, or write a number instead.` };
    const fed = previewNumber(graph, wire.from, scope, new Set(seen).add(node.id));
    if (fed.kind !== 'values') return fed;
    inputs.push({ letter, values: fed.values, exact: fed.exact });
  }
  for (const word of parsed.words) {
    if (word in scope.variables) continue;
    if (scope.placeholders.includes(word)) return { kind: 'later', why: `{${word}} comes in when it runs.` };
    return { kind: 'later', why: `{${word}} is not set yet: a "Set a variable" box makes it.` };
  }

  // Thin the inputs until every combination can be tried.
  let exact = inputs.every((i) => i.exact);
  let total = inputs.reduce((n, i) => n * i.values.length, 1);
  if (total > TRIES) {
    const each = Math.max(2, Math.floor(TRIES ** (1 / inputs.length)));
    for (const input of inputs) {
      if (input.values.length > each) {
        input.values = thin(input.values, each);
        exact = false;
      }
    }
    total = inputs.reduce((n, i) => n * i.values.length, 1);
  }
  const random = /\brandom\s*\(/.test(src);
  if (random) exact = false;

  const out: number[] = [];
  const picked: Record<string, number> = {};
  const word = (w: string) => scope.variables[w];
  try {
    const run = evaluator(src);
    for (let k = 0; k < total; k++) {
      let rest = k;
      for (const input of inputs) {
        picked[input.letter] = input.values[rest % input.values.length];
        rest = Math.floor(rest / input.values.length);
      }
      for (let t = 0; t < (random ? RANDOM_TRIES : 1); t++) out.push(run({ letter: (l) => picked[l], word }));
    }
  } catch (error) {
    const said = error instanceof MathError ? error.message : String(error);
    const at = inputs.length ? ` (when ${inputs.map((i) => `${i.letter} is ${formatNumber(picked[i.letter])}`).join(', ')})` : '';
    return { kind: 'wrong', why: `${said}${at}` };
  }
  return settle(out, exact);
}

/** "149.4", "8 to 16, one of 9", or "about 1.2 to 3.4". */
export function describePreview(p: Extract<Preview, { kind: 'values' }>): string {
  const low = p.values[0];
  const high = p.values[p.values.length - 1];
  if (low === high) return formatNumber(low);
  const range = `${formatNumber(low)} to ${formatNumber(high)}`;
  if (!p.exact) return `about ${range}`;
  return p.values.length <= 50 ? `${range}, one of ${p.values.length}` : range;
}

/** Each wired number field of a box, as the box will get it: kept to what the field allows. */
export function previewField(graph: Graph, node: GraphNode, key: string, scope: PreviewScope): Preview | null {
  const spec = specOf(node.type);
  const f = spec?.fields.find((s) => s.key === key);
  if (!f || f.kind !== 'number' || !fieldShown(f, node.fields)) return null;
  const wire = graph.wires.find((w) => w.to === node.id && w.port === fieldPort(key));
  if (!wire) return null;
  const fed = previewNumber(graph, wire.from, scope);
  if (fed.kind !== 'values') return fed;
  return settle(fed.values.map((v) => Number(fieldValue(f, v))), fed.exact);
}
