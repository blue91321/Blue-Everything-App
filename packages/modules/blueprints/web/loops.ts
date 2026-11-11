/**
 * Warnings about a blueprint that could go round for ever, found by looking at
 * the board rather than by running it.
 *
 * Two kinds:
 *
 * - **A loop of wires.** A wire back is allowed ("nudge, wait, check again" is
 *   a real thing to want), so not every loop is a warning. One with nothing
 *   waiting in it is: a run stops itself after fifty boxes in a row with no
 *   pause, and says so, but better to know before. One that waits but has no
 *   way out goes until it is stopped. One that waits and has a check that can
 *   leave it is what "again while I hold it" looks like, and is left alone.
 *   Several wires from one way out run one after another, so a wire into a
 *   loop that never ends means the wires after it never run, which is said
 *   too.
 * - **Blueprints that set each other off.** Ticking a habit sets off "When a
 *   habit is ticked", adding a task sets off "When a task is added". A run never
 *   starts its own blueprint again and nothing goes past three deep, so these
 *   cannot run away, but two blueprints feeding each other is rarely meant.
 *
 * Pure, so `blueprints-check` asserts it and the board and the server could
 * both ask it.
 */
import { outputsOf, specOf } from './catalogue.js';
import { nextAll, type Graph, type GraphNode } from './engine.js';

export interface LoopWarning {
  /** `danger`: a run will be stopped. `warn`: it goes until stopped. `info`: something will not run. */
  level: 'danger' | 'warn' | 'info';
  /** The boxes it is about, to mark on the board. */
  nodes: string[];
  text: string;
}

/** Boxes that wait, which is what makes a loop through them something other than a spin. */
const PAUSES = new Set(['wait', 'ask']);
/** Boxes that go every way out in turn, so no single way out is a way of leaving. */
const ALL_WAYS = new Set(['sequence', 'repeat']);

/** Run wires as a map of where each box leads, by every way out. */
function leadsTo(graph: Graph): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const w of graph.wires) {
    if (w.port) continue;
    const list = out.get(w.from) ?? [];
    list.push(w.to);
    out.set(w.from, list);
  }
  return out;
}

/** The loops: groups of boxes each of which leads round to every other (Tarjan's). */
function loopsOf(graph: Graph): string[][] {
  const edges = leadsTo(graph);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const groups: string[][] = [];
  let counter = 0;
  const visit = (id: string) => {
    index.set(id, counter);
    low.set(id, counter);
    counter += 1;
    stack.push(id);
    onStack.add(id);
    for (const to of edges.get(id) ?? []) {
      if (!index.has(to)) {
        visit(to);
        low.set(id, Math.min(low.get(id)!, low.get(to)!));
      } else if (onStack.has(to)) {
        low.set(id, Math.min(low.get(id)!, index.get(to)!));
      }
    }
    if (low.get(id) === index.get(id)) {
      const group: string[] = [];
      let top: string;
      do {
        top = stack.pop()!;
        onStack.delete(top);
        group.push(top);
      } while (top !== id);
      // A box cannot be wired to itself, so a loop is always two or more.
      if (group.length > 1) groups.push(group);
    }
  };
  for (const n of graph.nodes) if (!index.has(n.id)) visit(n.id);
  return groups;
}

/** Whether a loop has a way out: a box that goes one way or another, with a way that leaves. */
function hasWayOut(graph: Graph, group: Set<string>, byId: Map<string, GraphNode>): boolean {
  for (const id of group) {
    const node = byId.get(id)!;
    if (ALL_WAYS.has(node.type)) continue;
    const pins = outputsOf(node).filter((o) => !o.value);
    if (pins.length < 2) continue;
    for (const pin of pins) {
      const targets = nextAll(graph, id, pin.id);
      if (targets.every((t) => !group.has(t))) return true;
    }
  }
  return false;
}

const nameOf = (node: GraphNode) => specOf(node.type)?.label ?? node.type;

export function loopWarnings(graph: Graph): LoopWarning[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const warnings: LoopWarning[] = [];
  const endless = new Set<string>();
  for (const list of loopsOf(graph)) {
    const group = new Set(list);
    const names = [...new Set(list.map((id) => nameOf(byId.get(id)!)))].slice(0, 4).join(', ');
    const repeat = list.find((id) => byId.get(id)!.type === 'repeat');
    const waits = list.some((id) => PAUSES.has(byId.get(id)!.type));
    const out = hasWayOut(graph, group, byId);
    if (repeat) {
      warnings.push({
        level: 'danger',
        nodes: list,
        text: `A Repeat leads back round to itself (${names}), so every go starts another Repeat inside the last. Wire the loop's end to nothing instead: the Repeat already goes again.`,
      });
      if (!out) for (const id of list) endless.add(id);
    } else if (!waits) {
      warnings.push({
        level: 'danger',
        nodes: list,
        text: `These boxes go round in a loop with nothing waiting in it (${names}). A run stops itself after 50 boxes and says so. Put a Wait in the loop.`,
      });
    } else if (!out) {
      warnings.push({
        level: 'warn',
        nodes: list,
        text: `These boxes go round for ever, waiting each time (${names}), with no check that can leave the loop. It runs until you press ■ Stop or switch the blueprint off.`,
      });
      for (const id of list) endless.add(id);
    }
  }

  // Several wires from one way out all start at once, so a loop on one holds up none of the others.
  return warnings;
}

/** What a blueprint's Do boxes set off, in terms of the When boxes that hear it. */
export interface SetsOff {
  event: 'on-habit' | 'on-task-added';
  /** The habit ticked, or the task's title. */
  what: string;
}

export function setsOff(graph: Graph): SetsOff[] {
  const out: SetsOff[] = [];
  for (const n of graph.nodes) {
    if (n.type === 'tick-habit') out.push({ event: 'on-habit', what: String(n.fields.habit ?? '') });
    if (n.type === 'add-task') out.push({ event: 'on-task-added', what: String(n.fields.title ?? '') });
  }
  return out;
}

/** Whether one of a blueprint's When boxes hears this. */
export function hears(graph: Graph, s: SetsOff): GraphNode | undefined {
  return graph.nodes.find((n) => {
    if (n.type !== s.event) return false;
    if (n.type === 'on-habit') return !n.fields.habit || n.fields.habit === s.what || !s.what;
    // A title with {words} in it is filled in at run time, so a filter can only be guessed against: say yes.
    const contains = String(n.fields.contains ?? '').trim().toLowerCase();
    return !contains || s.what.includes('{') || s.what.toLowerCase().includes(contains);
  });
}

export interface Chain {
  /** The blueprints round the circle, starting and ending with this one. */
  names: string[];
}

/**
 * Blueprints that set each other off round to this one: A ticks a habit, B
 * hears it and adds a task, A hears that. Only switched-on blueprints count,
 * and this one as it is drawn now. Its own When boxes hearing its own Do boxes
 * are left out: a run never starts its own blueprint again.
 */
export function chainsBack(self: { id: string; name: string; graph: Graph }, others: Array<{ id: string; name: string; enabled: boolean; graph: Graph }>): Chain[] {
  type Entry = { id: string; name: string; graph: Graph };
  const all: Entry[] = [self, ...others.filter((o) => o.enabled && o.id !== self.id)];
  const found: Chain[] = [];
  const seen = new Set<string>();
  // `path` runs from this blueprint to `at`, which is its last entry.
  const walk = (at: Entry, path: Entry[]) => {
    if (path.length > 4 || found.length >= 3) return;
    for (const s of setsOff(at.graph)) {
      for (const next of all) {
        if (next.id === at.id || !hears(next.graph, s)) continue;
        if (next.id === self.id) {
          const names = [...path.map((p) => p.name), self.name];
          const key = names.join('\u0000');
          if (!seen.has(key)) {
            seen.add(key);
            found.push({ names });
          }
          continue;
        }
        if (path.some((p) => p.id === next.id)) continue;
        walk(next, [...path, next]);
      }
    }
  };
  walk(self, [self]);
  return found;
}
