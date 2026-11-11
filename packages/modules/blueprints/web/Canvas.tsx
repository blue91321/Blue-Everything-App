/**
 * The board a blueprint is drawn on: boxes you drag about, wires you pull from
 * one box's output to the next box, panned and zoomed like Unreal's.
 *
 * ### One set of pointer handlers, so a finger works too
 *
 * The reorder drag's lesson (`reorder.ts`): pointer events are mouse and touch
 * alike, so there is one way of doing each thing rather than two. The board is
 * `touch-action: none`, which is what lets a finger drag a box rather than
 * scroll the page; the page scrolls by the space around the board. Two fingers
 * on the board pinch to zoom.
 *
 * A wire can also be made without dragging: **tap an output, then tap the box
 * it leads to.** A drag over a phone screen with the board moving under it is
 * the fiddliest thing on this screen, and two taps are not.
 *
 * ### Where the pins are is arithmetic, not measuring
 *
 * Every box is the same width and its pins sit at fixed rows under its head
 * (a gate's lettered inputs down the left, the ways out down the right), so a
 * wire's ends are worked out from the box's position. Measuring the pins after
 * each render would be the `ResizeObserver` and layout-effect dance the weather
 * graph needed, for something the layout already knows.
 *
 * ### Two kinds of wire, drawn differently
 *
 * A grey wire leads a run on. A green one, thinner, from a diamond, carries a
 * check's yes-or-no answer into a gate's input. A diamond can only be wired
 * into a gate, and a gate's input only takes a diamond, so the two cannot be
 * crossed by mistake. A blue one, from a rounded square, carries a number into
 * a Counter's X, and the same rule keeps it out of everything else.
 *
 * Since 2026-11-04 every number a box is filled in with has a blue way in on
 * the left, named after it, and a Math box's letters do too: a number wired in
 * is used instead of the one typed, and the box says so where the number was.
 *
 * ### Several boxes at once (2026-11-05)
 *
 * Shift or Ctrl and a click adds a box to what is selected or takes it out;
 * dragging any selected box moves them all. A right-click offers Duplicate,
 * Copy, Cut, Paste and Delete, which are also Ctrl+D, C, X, V and Delete, and
 * Ctrl+A selects everything. What is copied is kept per device
 * (`localStorage`), so it pastes into another blueprint, with the wires
 * between the copied boxes and none to boxes left behind.
 *
 * A way out can have several wires. They run one after another, top to bottom
 * (`nextAll` in the engine), and each wire carries its number so the order is
 * on the board. `loops.ts` says when wires go round for ever.
 *
 * ### A variable's name is a line too (2026-11-05)
 *
 * A "Set a variable" and a Variable box with the same name are one variable,
 * and a dashed line joins the Set box's name to the Variable box's, drawn from
 * the names alone: nothing is stored for it, so renaming either moves it.
 * Dragging from the Set box's name to a Variable box (or tapping one and then
 * the other) gives them the same name. The ends sit beside the name boxes,
 * which are measured after drawing, since a field's height is the layout's.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { api } from '@app/api';
import { useContextMenu, type MenuItem } from '@app/ContextMenu';
import { useAsync } from '@app/useAsync';
import {
  fieldPort,
  fieldShown,
  inputsOf,
  KIND_LABEL,
  outputsOf,
  specOf,
  toStep,
  type FieldSpec,
  type NodeKind,
  type NodeSpec,
} from './catalogue';
import { formatNumber, parseMath, variableName } from './maths';
import { keepWires, unreachable, type Graph, type GraphNode, type StepResult, type Wire } from './engine';
import { loopWarnings, type LoopWarning } from './loops';
import { describePreview, previewField, previewSum, type Preview } from './preview';
import { keysFromEvent, normalKeys, parseKeys, parseTimeline, playable } from './keys';
import { TimelineField } from './Timeline';
import { MathInput } from './MathInput';
import { designWav } from './sound-design';
import { SoundShapeField } from './SoundShape';
import { VoiceField } from './VoiceEditor';
import { searchBoxes, type Found } from './search';
import { everyNote } from './schedule';

export const NODE_W = 240;
export const HEAD = 36;
export const ROW = 26;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 1.6;

interface View {
  x: number;
  y: number;
  z: number;
}

export interface HabitChoice {
  id: string;
  name: string;
}

/** Whether the agent is there to hear hotkeys and press keys, and what it could not register. */
export interface AgentState {
  around: boolean;
  problems: string[];
}

/** A box whose only way out is `then` has it on its head; anything else has rows. */
export function onHead(node: GraphNode): boolean {
  const outs = outputsOf(node);
  return outs.length === 1 && outs[0]!.id === 'then' && inputsOf(node).length === 0;
}

export function rowsOf(node: GraphNode): number {
  return onHead(node) ? 0 : Math.max(outputsOf(node).length, inputsOf(node).length);
}

/** Where an output pin is, in board coordinates. */
export function outAt(node: GraphNode, pin: string): { x: number; y: number } {
  if (onHead(node)) return { x: node.x + NODE_W, y: node.y + HEAD / 2 };
  const i = Math.max(0, outputsOf(node).findIndex((o) => o.id === pin));
  return { x: node.x + NODE_W, y: node.y + HEAD + ROW / 2 + i * ROW };
}

/**
 * A "Play a sound" box's sound, played in this browser. A tone comes from the
 * server's own copy, `/sounds/<tone>.wav` (outside `/api/`, since an audio
 * element sends no token); a click or a drawn sound is made here by the same
 * `sound-design.ts` the PC draws it with. One at a time, so pressing ▶ twice
 * does not play two over each other.
 */
let hearing: HTMLAudioElement | null = null;
function hear(fields: Record<string, string | number>): void {
  try {
    hearing?.pause();
    if (hearing?.src.startsWith('blob:')) URL.revokeObjectURL(hearing.src);
    const bytes = designWav(fields);
    const url = bytes
      ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'audio/wav' }))
      : fields.sound === 'tone' || !fields.sound
        ? // Turned down by the server, in the bytes: an iPhone ignores an audio element's volume.
          `/sounds/${encodeURIComponent(String(fields.tone || 'chime'))}.wav?v=${Math.round(Number(fields.volume ?? 50))}`
        : null;
    if (!url) return;
    hearing = new Audio(url);
    void hearing.play().catch(() => undefined);
  } catch {
    // No audio here: the PC will still play it when the box runs.
  }
}

/**
 * What a box with a sound in it plays, as a "Play a sound" box's fields: its
 * own for that box, and a Notification's tone at its volume. Null for silence.
 */
function soundOf(node: GraphNode): Record<string, string | number> | null {
  if (node.type === 'play-sound') return node.fields;
  if (node.type === 'nudge') {
    const tone = String(node.fields.sound ?? 'none');
    return tone === 'none' ? null : { sound: 'tone', tone, volume: node.fields.volume ?? 50 };
  }
  return null;
}

/** ▶ under a "Play a sound" box: what it will play, here. A file is the PC's, and only plays there. */
function HearIt({ fields }: { fields: Record<string, string | number> }) {
  if (fields.sound === 'file') return <p className="bp-note">A file plays on the PC when the box runs.</p>;
  return (
    <button type="button" className="bp-hear" onClick={() => hear(fields)}>
      ▶ Hear it
    </button>
  );
}

/**
 * Stop what letting go of a mouse button would do (a click, the menu, going
 * back or forward a page) for the next moment. Recording a button ends on its
 * press, and the listeners that stopped all that while recording go with it,
 * so without this the let-go of mouse4 took the window back a page.
 */
function swallowRelease(button: number): void {
  const types = ['pointerup', 'mouseup', 'auxclick', 'click', 'contextmenu'] as const;
  const stop = (event: Event) => {
    if ((event as MouseEvent).button !== button) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.type === 'auxclick' || event.type === 'click') done();
  };
  const done = () => {
    for (const t of types) window.removeEventListener(t, stop, true);
  };
  for (const t of types) window.addEventListener(t, stop, true);
  setTimeout(done, 1500);
}

/** Where a wire comes in: the head's way in, or one of a gate's lettered inputs. */
export function inAt(node: GraphNode, port?: string): { x: number; y: number } {
  if (!port) return { x: node.x, y: node.y + HEAD / 2 };
  const i = Math.max(0, inputsOf(node).findIndex((p) => p.id === port));
  return { x: node.x, y: node.y + HEAD + ROW / 2 + i * ROW };
}

function curve(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const bend = Math.max(50, Math.abs(b.x - a.x) / 2);
  return `M ${a.x} ${a.y} C ${a.x + bend} ${a.y}, ${b.x - bend} ${b.y}, ${b.x} ${b.y}`;
}

/** What is selected: any number of boxes, or one wire. */
interface Selection {
  nodes: string[];
  wire: string | null;
}
const NOTHING: Selection = { nodes: [], wire: null };

/** What Copy keeps, per device, so it can be pasted into another blueprint too. */
const CLIPBOARD_KEY = 'blueprints.clipboard';
interface Clip {
  nodes: GraphNode[];
  wires: Wire[];
}
function readClip(): Clip | null {
  try {
    const raw = JSON.parse(localStorage.getItem(CLIPBOARD_KEY) ?? 'null') as Clip | null;
    return raw && Array.isArray(raw.nodes) && raw.nodes.length > 0 && Array.isArray(raw.wires) ? raw : null;
  } catch {
    return null;
  }
}
function writeClip(clip: Clip): void {
  try {
    localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(clip));
  } catch {
    // Storage refused: Copy simply has nothing to paste, which Paste says.
  }
}

/** Roughly how tall a box draws, for fitting the view. Only for that. */
function heightOf(node: GraphNode, spec: NodeSpec): number {
  return HEAD + rowsOf(node) * ROW + spec.fields.reduce((sum, f) => sum + (f.kind === 'longtext' || f.kind === 'math' ? 74 : 52), 12);
}

/** Whether an output carries a value rather than leading a run on. */
const isValue = (node: GraphNode, pin: string) => outputsOf(node).some((o) => o.id === pin && o.value);
/** Whether that value is a number rather than a yes or no. */
const isNumber = (node: GraphNode, pin: string) => outputsOf(node).some((o) => o.id === pin && o.number);

let counter = 0;
const newId = () => `n${Date.now().toString(36)}${(counter++).toString(36)}`;

type Drag =
  | { kind: 'pan'; startX: number; startY: number; view: View; moved: boolean }
  | { kind: 'node'; start: { x: number; y: number }; from: Map<string, { x: number; y: number }>; moved: boolean }
  | { kind: 'wire'; from: string; pin: string; x: number; y: number; startX: number; startY: number; moved: boolean }
  | { kind: 'link'; from: string; x: number; y: number; startX: number; startY: number; moved: boolean }
  | { kind: 'pinch'; distance: number; view: View; mid: { x: number; y: number } };

export function Canvas({
  graph,
  onChange,
  habits,
  ran,
  placeholders,
  agent,
  enabled,
  variables,
  chains = [],
  onForget,
}: {
  graph: Graph;
  onChange: (graph: Graph) => void;
  habits: HabitChoice[];
  /** The last run shown: each box's result, and the wires it went along. */
  ran: { results: Map<string, StepResult>; wires: Set<string> } | null;
  /** The `{words}` the boxes here give, for the hint under text boxes. */
  placeholders: string[];
  agent: AgentState | null;
  /** Switched on: a hotkey is only listened for while it is. */
  enabled: boolean;
  /** Every variable and what it holds now, for working a sum out as it is typed. */
  variables: Record<string, number | string>;
  /** Other blueprints that set this one off and are set off by it, said above the board. */
  chains?: string[];
  /** Put a variable back to where its Variable box says it starts. */
  onForget?: (name: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 24, y: 24, z: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const [selected, setSelectedState] = useState<Selection>(NOTHING);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  // The ref is set at once as well, so a Shift-click straight after a click reads the click's choice.
  const setSelected = (next: Selection) => {
    selectedRef.current = next;
    setSelectedState(next);
  };
  const selectNodes = (nodes: string[]) => setSelected({ nodes, wire: null });
  const [pending, setPending] = useState<{ from: string; pin: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const fitted = useRef(false);

  const graphRef = useRef(graph);
  graphRef.current = graph;
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const lonely = useMemo(() => unreachable(graph), [graph]);
  /*
   * What each variable holds as far as this board can tell: where its
   * Variable box starts it, then what it holds now. For previews of a sum and
   * the names offered in a Set box.
   */
  const known = useMemo(() => {
    const out: Record<string, number | string> = {};
    for (const n of graph.nodes) {
      const name = n.type === 'variable' ? variableName(n.fields.name) : '';
      if (name && out[name] === undefined) out[name] = Number(n.fields.start) || 0;
    }
    return { ...out, ...variables };
  }, [graph, variables]);
  /*
   * What each sum and each wired number comes to, worked out from the boxes
   * feeding it. Keyed on the graph without positions, so dragging a box does
   * not try every value of every sum again on each move.
   */
  const shape = useMemo(
    () => JSON.stringify({ n: graph.nodes.map(({ x: _x, y: _y, color: _c, ...rest }) => rest), w: graph.wires, p: placeholders }),
    [graph, placeholders]
  );
  const previews = useMemo(() => {
    const scope = { variables: known, placeholders };
    const out = new Map<string, Record<string, Preview>>();
    for (const node of graph.nodes) {
      const spec = specOf(node.type);
      if (!spec) continue;
      const mine: Record<string, Preview> = {};
      for (const f of spec.fields) {
        if (!fieldShown(f, node.fields)) continue;
        if (f.kind === 'math') mine[f.key] = previewSum(graph, node, String(node.fields[f.key] ?? ''), scope);
        else if (f.kind === 'number') {
          const p = previewField(graph, node, f.key, scope);
          if (p) mine[f.key] = p;
        }
      }
      if (Object.keys(mine).length) out.set(node.id, mine);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, known]);
  /** A "Set a variable" and the Variable box of the same name, joined by a line. */
  const links = useMemo(() => {
    const declared = new Map<string, string[]>();
    for (const n of graph.nodes) {
      const name = n.type === 'variable' ? variableName(n.fields.name) : '';
      if (name) declared.set(name, [...(declared.get(name) ?? []), n.id]);
    }
    return graph.nodes.flatMap((n) => {
      const name = n.type === 'set-variable' ? variableName(n.fields.name) : '';
      return name ? (declared.get(name) ?? []).map((to) => ({ from: n.id, to })) : [];
    });
  }, [graph]);
  /*
   * Where the name box sits down each box with one, measured after drawing:
   * a box's fields are the layout's to place. In board units, so zoom does not
   * move them. Set again only when something moved, so it settles in a render.
   */
  const [nameAt, setNameAt] = useState<Record<string, number>>({});
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const next: Record<string, number> = {};
    for (const n of graph.nodes) {
      if (n.type !== 'variable' && n.type !== 'set-variable') continue;
      const nodeEl = el.querySelector<HTMLElement>(`[data-node="${n.id}"]`);
      const input = nodeEl?.querySelector<HTMLElement>(`[data-field="${n.type}-name"] input`);
      if (!nodeEl || !input) continue;
      const a = nodeEl.getBoundingClientRect();
      const b = input.getBoundingClientRect();
      next[n.id] = Math.round((b.top + b.height / 2 - a.top) / viewRef.current.z);
    }
    const same = Object.keys(next).length === Object.keys(nameAt).length && Object.entries(next).every(([k, v]) => nameAt[k] === v);
    if (!same) setNameAt(next);
  });
  const nameY = (id: string) => nameAt[id] ?? HEAD + 40;
  const warnings = useMemo(() => loopWarnings(graph), [graph]);
  /** Each box in a loop worth a warning, and how bad: drawn as an outline. */
  const looped = useMemo(() => {
    const map = new Map<string, LoopWarning['level']>();
    for (const w of warnings) if (w.level !== 'info') for (const id of w.nodes) if (map.get(id) !== 'danger') map.set(id, w.level);
    return map;
  }, [warnings]);

  const setDragBoth = (next: Drag | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  const toBoard = (clientX: number, clientY: number) => {
    const rect = box.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (clientX - rect.left - v.x) / v.z, y: (clientY - rect.top - v.y) / v.z };
  };

  /* ---- Changing the graph ---- */

  /** Boxes moved together: each from where it was when the drag began, by the same amount. */
  const moveNodes = (from: Map<string, { x: number; y: number }>, dx: number, dy: number) =>
    onChange({
      ...graphRef.current,
      nodes: graphRef.current.nodes.map((n) => {
        const was = from.get(n.id);
        return was ? { ...n, x: Math.round(was.x + dx), y: Math.round(was.y + dy) } : n;
      }),
    });

  const setField = (id: string, key: string, value: string | number) => setFields(id, { [key]: value });
  /** Several of a box's fields in one change, so the second does not undo the first. */
  const setFields = (id: string, patch: Record<string, string | number>) => {
    const g = graphRef.current;
    const nodes = g.nodes.map((n) => (n.id === id ? { ...n, fields: { ...n.fields, ...patch } } : n));
    // A gate cut to fewer inputs, or a sequence to fewer outputs, loses the
    // wires on the pins that went, rather than drawing them into nothing.
    onChange({ nodes, wires: keepWires(nodes, g.wires) });
  };

  /** A box's own colour, only to find it by. Empty takes it off. */
  const colorNode = (id: string, color: string) =>
    onChange({
      ...graphRef.current,
      nodes: graphRef.current.nodes.map((n) => {
        if (n.id !== id) return n;
        const { color: _old, ...rest } = n;
        return color ? { ...rest, color } : rest;
      }),
    });

  const removeNodes = (ids: string[]) => {
    const gone = new Set(ids);
    const g = graphRef.current;
    onChange({ nodes: g.nodes.filter((n) => !gone.has(n.id)), wires: g.wires.filter((w) => !gone.has(w.from) && !gone.has(w.to)) });
    setSelected(NOTHING);
  };

  const removeWire = (id: string) => {
    const g = graphRef.current;
    onChange({ ...g, wires: g.wires.filter((w) => w.id !== id) });
    setSelected(NOTHING);
  };

  /* ---- Copy, paste, duplicate ---- */

  /** The selected boxes and the wires between them, and none to boxes left out. */
  const clipOf = (ids: string[]): Clip | null => {
    const g = graphRef.current;
    const keep = new Set(ids);
    const nodes = g.nodes.filter((n) => keep.has(n.id));
    if (nodes.length === 0) return null;
    return { nodes, wires: g.wires.filter((w) => keep.has(w.from) && keep.has(w.to)) };
  };

  /**
   * Put a copy on the board: new ids, the wires between the copies, placed so
   * its top-left box lands at `at`, or a step down and right of the original.
   * What is pasted is selected, so it can be dragged straight away.
   */
  const place = (clip: Clip, at?: { x: number; y: number }) => {
    const g = graphRef.current;
    const left = Math.min(...clip.nodes.map((n) => n.x));
    const top = Math.min(...clip.nodes.map((n) => n.y));
    const dx = at ? at.x - left : 40;
    const dy = at ? at.y - top : 40;
    const ids = new Map(clip.nodes.map((n) => [n.id, newId()]));
    const nodes = clip.nodes.map((n) => ({ ...n, id: ids.get(n.id)!, x: Math.round(n.x + dx), y: Math.round(n.y + dy) }));
    const wires = clip.wires.map((w) => ({ ...w, id: newId(), from: ids.get(w.from)!, to: ids.get(w.to)! }));
    const all = [...g.nodes, ...nodes];
    onChange({ nodes: all, wires: keepWires(all, [...g.wires, ...wires]) });
    selectNodes(nodes.map((n) => n.id));
  };

  const copy = (ids: string[]) => {
    const clip = clipOf(ids);
    if (clip) writeClip(clip);
  };
  const cut = (ids: string[]) => {
    copy(ids);
    removeNodes(ids);
  };
  const duplicate = (ids: string[]) => {
    const clip = clipOf(ids);
    if (clip) place(clip);
  };
  const paste = (at?: { x: number; y: number }) => {
    const clip = readClip();
    if (!clip) return;
    // Pasted where it was cut from would sit exactly on top: a step aside, as Duplicate does.
    place(clip, at);
  };

  /**
   * A way out can lead to several boxes, which run in turn, top to bottom; the
   * same wire twice is not added. An answer goes into a gate's input instead:
   * the one aimed at, or else the first with nothing in it, and one answer per
   * input.
   */
  const connect = (from: string, pin: string, to: string, port?: string) => {
    const g = graphRef.current;
    const source = g.nodes.find((n) => n.id === from);
    const target = g.nodes.find((n) => n.id === to);
    if (!source || !target || from === to || specOf(target.type)?.kind === 'event') return;
    if (isValue(source, pin)) {
      // Only the ways in that take this kind of value: a number into X, an answer into a letter.
      const number = isNumber(source, pin);
      const inputs = inputsOf(target).filter((p) => Boolean(p.number) === number);
      if (inputs.length === 0) return;
      const into =
        inputs.find((p) => p.id === port)?.id ??
        inputs.find((p) => !g.wires.some((w) => w.to === to && w.port === p.id))?.id ??
        inputs[inputs.length - 1]!.id;
      onChange({
        ...g,
        wires: [...g.wires.filter((w) => !(w.to === to && w.port === into)), { id: newId(), from, pin, to, port: into }],
      });
      return;
    }
    if (specOf(target.type)?.pure) return;
    if (g.wires.some((w) => w.from === from && w.pin === pin && w.to === to && !w.port)) return;
    onChange({ ...g, wires: [...g.wires, { id: newId(), from, pin, to }] });
  };

  /** Where "Add a box here" from the right-click menu puts the box; else the middle of the view. */
  const addAt = useRef<{ x: number; y: number } | null>(null);

  /**
   * A Set box joined to a Variable box by hand: both take one name. The Set
   * box's if it has one, else the Variable box's, else a new one.
   */
  const joinNames = (setId: string, varId: string) => {
    const g = graphRef.current;
    const s = g.nodes.find((n) => n.id === setId);
    const v = g.nodes.find((n) => n.id === varId);
    if (!s || !v || s.type !== 'set-variable' || v.type !== 'variable') return;
    let name = String(s.fields.name ?? '').trim() || String(v.fields.name ?? '').trim();
    if (!name) {
      const taken = new Set(g.nodes.map((n) => variableName(n.fields.name)).filter(Boolean));
      let k = 1;
      while (taken.has(`variable_${k}`)) k += 1;
      name = `variable_${k}`;
    }
    onChange({ ...g, nodes: g.nodes.map((n) => (n.id === setId || n.id === varId ? { ...n, fields: { ...n.fields, name } } : n)) });
  };

  const add = (spec: NodeSpec) => {
    const rect = box.current!.getBoundingClientRect();
    const centre = addAt.current ? { x: addAt.current.x + NODE_W / 2, y: addAt.current.y } : toBoard(rect.left + rect.width / 2, rect.top + rect.height / 3);
    addAt.current = null;
    // Nudged along while something is already there, so two adds do not stack.
    let x = centre.x - NODE_W / 2;
    let y = centre.y;
    while (graph.nodes.some((n) => Math.abs(n.x - x) < 30 && Math.abs(n.y - y) < 30)) {
      x += 36;
      y += 36;
    }
    const fields: Record<string, string | number> = {};
    for (const f of spec.fields) fields[f.key] = f.default;
    const node: GraphNode = { id: newId(), type: spec.type, x: Math.round(x), y: Math.round(y), fields };
    onChange({ nodes: [...graph.nodes, node], wires: graph.wires });
    // A box added while an output is waiting for a target becomes the target.
    if (pending && spec.kind !== 'event') {
      graphRef.current = { nodes: [...graph.nodes, node], wires: graph.wires };
      connect(pending.from, pending.pin, node.id);
    }
    setPending(null);
    setAdding(false);
    selectNodes([node.id]);
  };

  /* ---- The view ---- */

  const zoomAt = (factor: number, clientX?: number, clientY?: number) => {
    const rect = box.current!.getBoundingClientRect();
    const px = (clientX ?? rect.left + rect.width / 2) - rect.left;
    const py = (clientY ?? rect.top + rect.height / 2) - rect.top;
    setView((v) => {
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.z * factor));
      // Keep the point under the cursor where it is.
      return { z, x: px - ((px - v.x) / v.z) * z, y: py - ((py - v.y) / v.z) * z };
    });
  };

  const fit = () => {
    const el = box.current;
    if (!el || graph.nodes.length === 0) {
      setView({ x: 24, y: 24, z: 1 });
      return;
    }
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const n of graph.nodes) {
      const spec = specOf(n.type)!;
      left = Math.min(left, n.x);
      top = Math.min(top, n.y);
      right = Math.max(right, n.x + NODE_W);
      bottom = Math.max(bottom, n.y + heightOf(n, spec));
    }
    const pad = 32;
    // The top clears the toolbar that floats over the board.
    const head = 56;
    const z = Math.min(1, Math.max(MIN_ZOOM, Math.min((el.clientWidth - pad * 2) / (right - left), (el.clientHeight - head - pad) / (bottom - top))));
    setView({ z, x: (el.clientWidth - (right - left) * z) / 2 - left * z, y: head - top * z });
  };

  // Fitted once when a blueprint first shows, so a template opens in view.
  useEffect(() => {
    if (fitted.current || !box.current) return;
    fitted.current = true;
    fit();
  });

  // The wheel zooms, and has to be a listener of its own: React's is passive,
  // so it cannot stop the page scrolling as well.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /*
   * Delete or Backspace removes what is selected; Ctrl (or Cmd) with C, X, V,
   * D and A copy, cut, paste, duplicate and select everything. Only while the
   * board has the keyboard and nothing is being typed, so Ctrl+C in a text box
   * still copies the text.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPending(null);
        setAdding(false);
        setSelected(NOTHING);
        return;
      }
      const target = event.target as HTMLElement | null;
      if (!target || target.closest('input, textarea, select, [contenteditable]') || !box.current?.contains(target)) return;
      const sel = selectedRef.current;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        if (sel.wire) removeWire(sel.wire);
        else if (sel.nodes.length) removeNodes(sel.nodes);
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'a') selectNodes(graphRef.current.nodes.map((n) => n.id));
      else if (key === 'c' && sel.nodes.length) copy(sel.nodes);
      else if (key === 'x' && sel.nodes.length) cut(sel.nodes);
      else if (key === 'd' && sel.nodes.length) duplicate(sel.nodes);
      else if (key === 'v') paste();
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /* ---- Pointers ---- */

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, button, .bp-menu')) return;
    // The board takes the keyboard, so Delete and the Ctrl keys reach it.
    box.current?.focus({ preventScroll: true });
    if (event.button === 2) {
      // A right-click selects the box under it, unless it is already among the selected, and opens the menu.
      const id = target.closest<HTMLElement>('[data-node]')?.dataset.node;
      if (id && !selectedRef.current.nodes.includes(id)) selectNodes([id]);
      return;
    }
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const rect = box.current!.getBoundingClientRect();
      setDragBoth({
        kind: 'pinch',
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        view: viewRef.current,
        mid: { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top },
      });
      return;
    }

    const linkOut = target.closest<HTMLElement>('[data-link-out]');
    if (linkOut) {
      const at = toBoard(event.clientX, event.clientY);
      box.current!.setPointerCapture(event.pointerId);
      setDragBoth({ kind: 'link', from: linkOut.dataset.linkOut!, x: at.x, y: at.y, startX: event.clientX, startY: event.clientY, moved: false });
      return;
    }

    const out = target.closest<HTMLElement>('[data-out]');
    if (out) {
      const [from, pin] = out.dataset.out!.split(':') as [string, string];
      const at = toBoard(event.clientX, event.clientY);
      box.current!.setPointerCapture(event.pointerId);
      setDragBoth({ kind: 'wire', from, pin, x: at.x, y: at.y, startX: event.clientX, startY: event.clientY, moved: false });
      return;
    }

    const nodeEl = target.closest<HTMLElement>('[data-node]');
    if (nodeEl) {
      const id = nodeEl.dataset.node!;
      // With an output waiting, tapping a box finishes the wire.
      if (pending) {
        if (pending.pin === NAME_LINK) joinNames(pending.from, id);
        else connect(pending.from, pending.pin, id, target.closest<HTMLElement>('[data-port]')?.dataset.port?.split(':')[1]);
        setPending(null);
        return;
      }
      const sel = selectedRef.current;
      // Shift or Ctrl adds a box to the selection, or takes it back out.
      if (event.shiftKey || event.ctrlKey || event.metaKey) {
        setSelected({ nodes: sel.nodes.includes(id) ? sel.nodes.filter((n) => n !== id) : [...sel.nodes, id], wire: null });
        return;
      }
      // Pressing one of several selected keeps them all, so they move together.
      const group = sel.nodes.includes(id) ? sel.nodes : [id];
      if (!sel.nodes.includes(id)) selectNodes([id]);
      if (!target.closest('.bp-head')) return;
      const at = toBoard(event.clientX, event.clientY);
      const from = new Map(graph.nodes.filter((n) => group.includes(n.id)).map((n) => [n.id, { x: n.x, y: n.y }]));
      box.current!.setPointerCapture(event.pointerId);
      setDragBoth({ kind: 'node', start: at, from, moved: false });
      return;
    }

    if (target.closest('[data-wire]')) return;
    box.current!.setPointerCapture(event.pointerId);
    setDragBoth({ kind: 'pan', startX: event.clientX, startY: event.clientY, view: viewRef.current, moved: false });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointers.current.has(event.pointerId)) pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === 'pinch') {
      if (pointers.current.size < 2) return;
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, d.view.z * (Math.hypot(a.x - b.x, a.y - b.y) / d.distance)));
      setView({ z, x: d.mid.x - ((d.mid.x - d.view.x) / d.view.z) * z, y: d.mid.y - ((d.mid.y - d.view.y) / d.view.z) * z });
      return;
    }
    if (d.kind === 'pan') {
      const dx = event.clientX - d.startX;
      const dy = event.clientY - d.startY;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      d.moved = true;
      setView({ ...d.view, x: d.view.x + dx, y: d.view.y + dy });
      return;
    }
    const at = toBoard(event.clientX, event.clientY);
    if (d.kind === 'node') {
      d.moved = true;
      moveNodes(d.from, at.x - d.start.x, at.y - d.start.y);
      return;
    }
    if (!d.moved && Math.hypot(event.clientX - d.startX, event.clientY - d.startY) < 6) return;
    setDragBoth({ ...d, x: at.x, y: at.y, moved: true });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    const d = dragRef.current;
    setDragBoth(null);
    if (!d) return;
    if (d.kind === 'pinch') return;
    if (d.kind === 'pan' && !d.moved) {
      // A tap on empty board lets go of everything.
      setSelected(NOTHING);
      setPending(null);
      setAdding(false);
      return;
    }
    if (d.kind === 'link') {
      if (!d.moved) {
        setPending({ from: d.from, pin: NAME_LINK });
        return;
      }
      const under = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-node]');
      if (under) joinNames(d.from, under.dataset.node!);
      return;
    }
    if (d.kind !== 'wire') return;
    if (!d.moved) {
      // A tap on an output: the next box tapped is where it leads.
      setPending({ from: d.from, pin: d.pin });
      return;
    }
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    const under = hit?.closest<HTMLElement>('[data-node]');
    if (under) connect(d.from, d.pin, under.dataset.node!, hit?.closest<HTMLElement>('[data-port]')?.dataset.port?.split(':')[1]);
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    setDragBoth(null);
  };

  /* ---- Drawing ---- */

  const wires = graph.wires.flatMap((w) => {
    const a = byId.get(w.from);
    const b = byId.get(w.to);
    if (!a || !b) return [];
    return [{ wire: w, d: curve(outAt(a, w.pin), inAt(b, w.port)) }];
  });
  const loose =
    drag?.kind === 'wire' && drag.moved ? curve(outAt(byId.get(drag.from)!, drag.pin), { x: drag.x, y: drag.y }) : null;
  const looseLink =
    drag?.kind === 'link' && drag.moved && byId.get(drag.from)
      ? curve({ x: byId.get(drag.from)!.x + NODE_W, y: byId.get(drag.from)!.y + nameY(drag.from) }, { x: drag.x, y: drag.y })
      : null;
  const linkPaths = links.flatMap(({ from, to }) => {
    const a = byId.get(from);
    const b = byId.get(to);
    if (!a || !b) return [];
    return [{ key: `${from}>${to}`, d: curve({ x: a.x + NODE_W, y: a.y + nameY(from) }, { x: b.x, y: b.y + nameY(to) }) }];
  });
  const pendingValue = pending ? isValue(byId.get(pending.from)!, pending.pin) : false;
  const pendingNumber = pending ? isNumber(byId.get(pending.from)!, pending.pin) : false;
  const wireClass = (from: GraphNode | undefined, pin: string, port?: string) =>
    port || (from && isValue(from, pin)) ? (from && isNumber(from, pin) ? ' value number' : ' value') : '';
  const chosenWire = selected.wire ? wires.find((w) => w.wire.id === selected.wire) : undefined;
  const chosen = new Set(selected.nodes);

  /*
   * The right-click menu: on a box, for it or for everything selected with it;
   * on the empty board, Paste and Add a box there. Worked out when it opens,
   * from where it was opened, which `menuAt` holds.
   */
  const menuAt = useRef<{ node: string | null; wire: string | null; at: { x: number; y: number } } | null>(null);
  const menu = useContextMenu((): MenuItem[] => {
    const m = menuAt.current;
    if (!m) return [];
    const clip = readClip();
    const pasteItem: MenuItem = {
      label: clip ? `Paste ${clip.nodes.length === 1 ? 'the box' : `${clip.nodes.length} boxes`} here    Ctrl+V` : 'Paste (copy something first)',
      onSelect: () => paste(m.at),
      disabled: !clip,
    };
    if (m.wire) return [{ label: 'Remove this wire    Del', onSelect: () => removeWire(m.wire!), danger: true }];
    if (!m.node) {
      return [
        pasteItem,
        {
          label: 'Add a box here',
          onSelect: () => {
            addAt.current = m.at;
            setAdding(true);
          },
        },
        { label: 'Select everything    Ctrl+A', onSelect: () => selectNodes(graphRef.current.nodes.map((n) => n.id)), disabled: graph.nodes.length === 0 },
      ];
    }
    const ids = selectedRef.current.nodes.includes(m.node) ? selectedRef.current.nodes : [m.node];
    const what = ids.length === 1 ? '' : ` ${ids.length} boxes`;
    return [
      { label: `Duplicate${what}    Ctrl+D`, onSelect: () => duplicate(ids) },
      { label: `Copy${what}    Ctrl+C`, onSelect: () => copy(ids) },
      { label: `Cut${what}    Ctrl+X`, onSelect: () => cut(ids) },
      pasteItem,
      { label: 'Select everything    Ctrl+A', onSelect: () => selectNodes(graphRef.current.nodes.map((n) => n.id)) },
      { label: `Delete${what}    Del`, onSelect: () => removeNodes(ids), danger: true },
    ];
  });
  const onContextMenu = (event: React.MouseEvent) => {
    const target = event.target as HTMLElement;
    // A text box keeps the browser's own menu, for its cut, copy and paste.
    if (target.closest('input, textarea, select, .bp-menu')) return;
    menuAt.current = {
      node: target.closest<HTMLElement>('[data-node]')?.dataset.node ?? null,
      wire: target.closest<SVGElement>('[data-wire]')?.dataset.wire ?? null,
      at: toBoard(event.clientX, event.clientY),
    };
    menu.onContextMenu(event);
  };

  return (
    <>
      {(warnings.length > 0 || chains.length > 0) && (
        <ul className="bp-warnings" aria-label="Loops">
          {warnings.map((w, i) => (
            <li key={`w${i}`} className={`bp-warning ${w.level}`}>
              <span>{w.text}</span>
              <button type="button" onClick={() => selectNodes(w.nodes)}>
                Show
              </button>
            </li>
          ))}
          {chains.map((text, i) => (
            <li key={`c${i}`} className="bp-warning info">
              <span>{text}</span>
            </li>
          ))}
        </ul>
      )}
    <div className="bp-board-wrap">
      <div className="bp-tools">
        <button type="button" className={adding ? 'primary' : ''} onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
          ＋ Add a box
        </button>
        <span className="bp-tools-gap" />
        <button type="button" onClick={() => zoomAt(1 / 1.2)} aria-label="Zoom out">−</button>
        <button type="button" onClick={() => zoomAt(1.2)} aria-label="Zoom in">＋</button>
        <button type="button" onClick={fit}>Fit</button>
      </div>
      {adding && (
        <AddMenu
          onPick={add}
          onClose={() => {
            addAt.current = null;
            setAdding(false);
          }}
        />
      )}
      {pending && (
        <div className="bp-pending">
          <span>
            {pending.pin === NAME_LINK
              ? 'Now tap a Variable box to give it this name.'
              : pendingNumber
              ? 'Now tap a blue way in on a box: a number it is filled in with, a letter of a sum, or a Counter\'s X.'
              : pendingValue
                ? "Now tap a logic gate's input to give it this answer."
                : 'Now tap the box it leads to, or add one.'}
          </span>
          <button type="button" onClick={() => setPending(null)}>Cancel</button>
        </div>
      )}
      <div
        ref={box}
        className={`bp-board${drag?.kind === 'pan' && drag.moved ? ' panning' : ''}${pending ? ' connecting' : ''}`}
        tabIndex={0}
        onContextMenu={onContextMenu}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${24 * view.z}px ${24 * view.z}px` }}
      >
        <div className="bp-layer" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
          <svg className="bp-wires" width="1" height="1" aria-hidden="true">
            {linkPaths.map((l) => (
              <path key={l.key} className="bp-link" d={l.d} />
            ))}
            {looseLink && <path className="bp-link loose" d={looseLink} />}
            {wires.map(({ wire, d }) => (
              <g key={wire.id} data-wire={wire.id} onClick={() => setSelected({ nodes: [], wire: wire.id })}>
                <path className="bp-wire-hit" d={d} />
                <path
                  className={`bp-wire${wireClass(byId.get(wire.from), wire.pin, wire.port)}${ran?.wires.has(wire.id) ? ' ran' : ''}${selected.wire === wire.id ? ' chosen' : ''}`}
                  d={d}
                />
              </g>
            ))}
            {loose && <path className={`bp-wire loose${drag?.kind === 'wire' ? wireClass(byId.get(drag.from), drag.pin) : ''}`} d={loose} />}
          </svg>
          {chosenWire && (
            <button
              type="button"
              className="bp-wire-remove"
              style={{ left: midpoint(chosenWire.wire, byId).x, top: midpoint(chosenWire.wire, byId).y }}
              onClick={() => removeWire(chosenWire.wire.id)}
              aria-label="Remove this wire"
            >
              ✕
            </button>
          )}
          {graph.nodes.map((node) => (
            <Box
              key={node.id}
              node={node}
              spec={specOf(node.type)!}
              selected={chosen.has(node.id)}
              alone={chosen.has(node.id) && chosen.size === 1}
              looped={looped.get(node.id) ?? null}
              pending={pending?.from === node.id ? pending.pin : null}
              lonely={lonely.has(node.id)}
              result={ran?.results.get(node.id) ?? null}
              habits={habits}
              placeholders={placeholders}
              agent={agent}
              enabled={enabled}
              wired={new Set(graph.wires.filter((w) => w.to === node.id && w.port).map((w) => w.port!))}
              variables={known}
              stored={variables}
              previews={previews.get(node.id) ?? NO_PREVIEWS}
              nameY={nameAt[node.id] ?? null}
              linked={links.some((l) => l.from === node.id || l.to === node.id)}
              onForget={onForget}
              onField={(key, value) => setField(node.id, key, value)}
              onFields={(patch) => setFields(node.id, patch)}
              onColor={(color) => colorNode(node.id, color)}
              onRemove={() => removeNodes(chosen.has(node.id) ? selected.nodes : [node.id])}
            />
          ))}
        </div>
        {graph.nodes.length === 0 && (
          <p className="bp-empty">
            Press <strong>＋ Add a box</strong> and start with a <strong>When</strong> box: it is where a blueprint starts.
          </p>
        )}
      </div>
      {menu.menu}
    </div>
    </>
  );
}

function midpoint(wire: { from: string; pin: string; to: string; port?: string }, byId: Map<string, GraphNode>) {
  const a = byId.get(wire.from)!;
  const b = byId.get(wire.to)!;
  const p = outAt(a, wire.pin);
  const q = inAt(b, wire.port);
  return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
}

const RESULT_LABEL: Record<StepResult, string> = {
  started: 'started here',
  yes: 'answered yes',
  no: 'answered no',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
};

function Box({
  node,
  spec,
  selected,
  alone,
  looped,
  pending,
  lonely,
  result,
  habits,
  placeholders,
  agent,
  enabled,
  wired,
  variables,
  stored,
  previews,
  nameY,
  linked,
  onForget,
  onField,
  onFields,
  onColor,
  onRemove,
}: {
  node: GraphNode;
  spec: NodeSpec;
  selected: boolean;
  /** The only box selected: it shows its colour picker. */
  alone: boolean;
  /** In a loop worth a warning, and how bad. */
  looped: LoopWarning['level'] | null;
  pending: string | null;
  lonely: boolean;
  result: StepResult | null;
  habits: HabitChoice[];
  placeholders: string[];
  agent: AgentState | null;
  enabled: boolean;
  /** Which of its ways in have something wired in. */
  wired: Set<string>;
  /** Every variable as far as the board can tell: its start, or what it holds now. */
  variables: Record<string, number | string>;
  /** Only what the variables hold now, for a Variable box to tell "changed" from "at its start". */
  stored: Record<string, number | string>;
  /** What each of its sums and wired numbers comes to, by field. */
  previews: Record<string, Preview>;
  /** Where its name box sits, for the end of a variable's line; null until measured. */
  nameY: number | null;
  /** Joined to a box of the same name: the pin is drawn filled. */
  linked: boolean;
  onForget?: (name: string) => void;
  onField: (key: string, value: string | number) => void;
  onFields: (patch: Record<string, string | number>) => void;
  onColor: (color: string) => void;
  onRemove: () => void;
}) {
  const classes = ['bp-node', `kind-${spec.kind}`];
  if (node.color) classes.push('tinted');
  if (selected) classes.push('selected');
  if (looped) classes.push(`loop-${looped}`);
  if (lonely) classes.push('lonely');
  if (result) classes.push(`ran-${result}`);
  const outs = outputsOf(node);
  const ins = inputsOf(node);
  const head = onHead(node);
  const rows = Math.max(outs.length, ins.length);
  const note = noteFor(node, agent, enabled);
  return (
    <div
      className={classes.join(' ')}
      data-node={node.id}
      style={{ left: node.x, top: node.y, width: NODE_W, ...(node.color ? ({ '--bp-tint': node.color } as Record<string, string>) : {}) }}
      title={lonely ? 'No "When" box leads here, so this never runs.' : undefined}
    >
      <div className="bp-head">
        {spec.kind !== 'event' && !spec.pure && <span className="bp-in" data-in={node.id} aria-hidden="true" />}
        <span className="bp-glyph" aria-hidden="true">{spec.glyph}</span>
        <span className="bp-label">
          <span className="bp-kind">{KIND_LABEL[spec.kind]}</span>
          {spec.label}
        </span>
        <button type="button" className="bp-remove" onClick={onRemove} aria-label={`Remove ${spec.label}`}>
          ✕
        </button>
        {head && <Pin node={node.id} pin="then" pending={pending === 'then'} label="Then" value={false} number={false} />}
      </div>
      {!head && (
        <div className="bp-outs">
          {Array.from({ length: rows }, (_, i) => {
            const input = ins[i];
            const out = outs[i];
            return (
              <div key={i} className="bp-out-row">
                {input && (
                  <span
                    className={`bp-port${input.number ? ' number' : ''}${wired.has(input.id) ? ' wired' : ''}`}
                    data-port={`${node.id}:${input.id}`}
                    title={input.number ? `${input.label}: wire a number in here` : `${input.label}: wire a check's Answer in here`}
                  >
                    <span className="bp-port-pin" aria-hidden="true" />
                    <span className="bp-port-label">{input.label}</span>
                  </span>
                )}
                {out && (
                  <>
                    <span className="bp-out-label">{out.label}</span>
                    <Pin node={node.id} pin={out.id} pending={pending === out.id} label={out.label} value={Boolean(out.value)} number={Boolean(out.number)} />
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      {result && <div className="bp-result">{RESULT_LABEL[result]}</div>}
      {spec.type === 'set-variable' && nameY !== null && (
        <span
          className={`bp-link-pin out${linked ? ' linked' : ''}${pending === NAME_LINK ? ' pending' : ''}`}
          data-link-out={node.id}
          style={{ top: nameY }}
          title="Drag to a Variable box to give it this name"
          aria-hidden="true"
        />
      )}
      {spec.type === 'variable' && nameY !== null && (
        <span className={`bp-link-pin in${linked ? ' linked' : ''}`} style={{ top: nameY }} aria-hidden="true" />
      )}
      {alone && (
        <div className="bp-tint">
          <span className="bp-field-label">Box colour</span>
          <ColorField value={node.color ?? ''} onChange={onColor} none="Its kind's own colour" />
        </div>
      )}
      {spec.fields.length > 0 && (
        <div className="bp-fields">
          {spec.fields.filter((f) => !f.hidden && fieldShown(f, node.fields)).map((f) => (
            <Field
              key={f.key}
              spec={f}
              nodeSpec={spec}
              value={node.fields[f.key] ?? f.default}
              habits={habits}
              placeholders={placeholders}
              wiredIn={f.kind === 'number' && wired.has(fieldPort(f.key))}
              wiredLetters={wired}
              variables={variables}
              preview={previews[f.key] ?? null}
              onHear={(patch) => {
                const sound = soundOf({ ...node, fields: { ...node.fields, ...patch } });
                if (sound) hear(sound);
              }}
              percent={
                spec.type === 'variable' && f.key === 'start'
                  ? { on: node.fields.as === 'percent', set: (on, value) => onFields({ as: on ? 'percent' : 'number', start: value }) }
                  : null
              }
              onChange={(value) => onField(f.key, value)}
            />
          ))}
          {spec.type === 'on-every' && <p className="bp-note">{everyNote(node.fields)}</p>}
          {spec.type === 'counter' && wired.has('x') && <p className="bp-note">X is wired in, so this number is not used.</p>}
          {spec.type === 'variable' && <VariableNow node={node} stored={stored} onForget={onForget} />}
          {spec.type === 'play-sound' && node.fields.sound === 'speech' && <VoiceField fields={node.fields} onFields={onFields} onHear={hear} />}
          {spec.type === 'play-sound' && node.fields.sound === 'custom' && (
            <SoundShapeField fields={node.fields} onFields={onFields} onHear={hear} />
          )}
          {spec.type === 'play-sound' && <HearIt fields={node.fields} />}
          {note && <p className={`bp-note${note.warn ? ' warn' : ''}`}>{note.text}</p>}
        </div>
      )}
    </div>
  );
}

/**
 * What the keyboard boxes need said under them: the agent is what hears and
 * presses keys, so a box that cannot work without it says when it is missing,
 * and a hotkey another program has taken says so.
 */
function noteFor(node: GraphNode, agent: AgentState | null, enabled: boolean): { text: string; warn: boolean } | null {
  if (node.type !== 'on-hotkey' && node.type !== 'press-keys') return null;
  const timeline = node.type === 'press-keys' && node.fields.mode === 'timeline';
  const watching = node.type === 'on-hotkey' && node.fields.listen === 'watch';
  if (timeline && playable(parseTimeline(node.fields.timeline)).length === 0) return null;
  const keys = String((watching ? node.fields.watch : node.fields.keys) ?? '');
  if (!keys && !timeline) return null;
  if (agent && !agent.around) {
    return { text: "The agent isn't running on the PC, and it is what hears and presses keys. Start the app there.", warn: true };
  }
  if (node.type === 'press-keys') return null;
  const game = String(node.fields.game ?? '');
  if (watching && !game) return { text: 'Pick the game it watches in: a watched key is only looked at while that game is being played.', warn: true };
  const problem = agent?.problems.find((p) => p.startsWith(`${keys} `));
  if (problem) return { text: problem, warn: true };
  const where = game ? `while ${gameShort(game)} is being played` : 'anywhere on the PC';
  if (!enabled) return { text: `Switch the blueprint on and the PC starts ${watching ? 'watching' : 'listening'} for ${keys} ${where}.`, warn: false };
  return watching
    ? { text: `Watching ${keys} ${where}, about 100 times a second, and only then. The game still gets it.`, warn: false }
    : { text: `Listening for ${keys} ${where}.`, warn: false };
}

/** "warframe.x64.exe" as "Warframe", for a note: the list's own name is not to hand here. */
const gameShort = (exe: string) =>
  exe.replace(/\.exe$/i, '').replace(/[._-]?(x64|x86|win64|win32|dx11|dx12|shipping)$/i, '').replace(/[._]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Colours to pick from in one tap; the last swatch opens the browser's own picker for any other. */
const SWATCHES = ['#5b9cff', '#4fd1c5', '#5fd18c', '#ffd166', '#ffb454', '#ff6b6b', '#ff7ab8', '#b48cff', '#e8e9ed'];

/**
 * A colour: one of a row of swatches, any other from the browser's own picker,
 * or none, which means whatever it would be without one.
 */
function ColorField({ value, onChange, none }: { value: string; onChange: (value: string) => void; none: string }) {
  const custom = value !== '' && !SWATCHES.includes(value);
  return (
    <span className="bp-swatches" role="group" aria-label="Colour">
      <button type="button" className={`bp-swatch none${value === '' ? ' on' : ''}`} onClick={() => onChange('')} title={none} aria-label={none} aria-pressed={value === ''}>
        ⊘
      </button>
      {SWATCHES.map((c) => (
        <button
          key={c}
          type="button"
          className={`bp-swatch${value === c ? ' on' : ''}`}
          style={{ background: c }}
          onClick={() => onChange(c)}
          aria-label={c}
          aria-pressed={value === c}
        />
      ))}
      <label className={`bp-swatch custom${custom ? ' on' : ''}`} style={custom ? { background: value } : undefined} title="Any colour">
        <input type="color" value={value || '#5b9cff'} onChange={(e) => onChange(e.target.value.toLowerCase())} aria-label="Any colour" />
        {!custom && '🎨'}
      </label>
    </span>
  );
}

/**
 * A sum, typed as text and worked out as it is typed: what is wrong and where,
 * which letters still want a wire, and the answer now from the variables'
 * current values when nothing else is needed to know it, the way Desmos shows
 * the value beside a line.
 */
function MathField({
  spec,
  nodeSpec,
  value,
  preview,
  onChange,
}: {
  spec: FieldSpec;
  nodeSpec: NodeSpec;
  value: string;
  preview: Preview | null;
  onChange: (value: string) => void;
}) {
  const parsed = parseMath(value);
  let status: { text: string; warn: boolean } | null = null;
  if (!parsed.ok) {
    status = { text: parsed.error, warn: true };
  } else if (preview?.kind === 'values') {
    status = { text: answerText(preview, nodeSpec.kind === 'branch'), warn: false };
  } else if (preview) {
    status = { text: preview.why, warn: preview.kind === 'wrong' };
  }
  return (
    <>
      <MathInput value={value} wrong={!parsed.ok} label={spec.label || nodeSpec.label} placeholder={spec.placeholder} onChange={onChange} />
      {status && <span className={`bp-hint bp-math-says${status.warn ? ' warn' : ''}`}>{status.text}</span>}
    </>
  );
}

/**
 * What a sum comes to, as the box shows it under the sum: "= 1.6 right now",
 * "= 12 to 20, one of 9" when a Random number feeds it, and for a check, yes,
 * no, or which it can be.
 */
function answerText(p: Extract<Preview, { kind: 'values' }>, branch: boolean): string {
  const fixed = p.values.length === 1;
  if (branch) {
    const yes = p.values.some((v) => v !== 0);
    const no = p.values.some((v) => v === 0);
    if (yes && no) return 'Yes or no, depending on the random number.';
    return yes ? (fixed ? 'Yes, right now.' : 'Yes, whatever the random number.') : fixed ? 'No, right now.' : 'No, whatever the random number.';
  }
  return fixed ? `= ${describePreview(p)} right now` : `= ${describePreview(p)}`;
}

const NO_PREVIEWS: Record<string, Preview> = {};

function Pin({
  node,
  pin,
  pending,
  label,
  value,
  number,
}: {
  node: string;
  pin: string;
  pending: boolean;
  label: string;
  value: boolean;
  number: boolean;
}) {
  return (
    <span
      className={`bp-out${value ? ' value' : ''}${number ? ' number' : ''}${pending ? ' pending' : ''}`}
      data-out={`${node}:${pin}`}
      role="button"
      aria-label={
        number
          ? `${label}: drag to a blue way in on a box`
          : value
            ? `${label}: drag to a logic gate's input`
            : `${label}: drag to a box, or tap it then tap a box`
      }
    />
  );
}

/**
 * A number typed as text and kept as text until it is one, so "0." on the
 * way to "0.5" is not turned into 0 under your fingers.
 */
/** The pin a Set box's name is dragged from; not a way out, so a run never follows it. */
const NAME_LINK = '__name';

/**
 * Under a Variable box: what it holds now, against where it starts, and a way
 * back. Its start is what was typed and stays; this line is what runs made it.
 */
function VariableNow({ node, stored, onForget }: { node: GraphNode; stored: Record<string, number | string>; onForget?: (name: string) => void }) {
  const name = variableName(node.fields.name);
  if (!name) return <p className="bp-note">Name it, and "Set a variable" boxes with the same name change it.</p>;
  const now = stored[name];
  const start = Number(node.fields.start) || 0;
  const pct = node.fields.as === 'percent' ? '%' : '';
  const shown = (v: number | string) => (typeof v === 'number' ? formatNumber(v) + pct : `"${v}"`);
  if (now === undefined) return <p className="bp-note">Now: {shown(start)}, its start. Nothing has changed it yet.</p>;
  return (
    <div className="bp-variable-now">
      <p className="bp-note">
        Now: <strong>{shown(now)}</strong>
        {typeof now === 'number' && now !== start ? `, changed from ${shown(start)}` : ''}
      </p>
      {onForget && (
        <button type="button" onClick={() => onForget(name)} title={`Put {${name}} back to ${shown(start)}`}>
          Back to its start
        </button>
      )}
    </div>
  );
}

/**
 * A number set by ear or by eye, a volume: a slider, with the number beside it
 * to type into. Letting go of the slider plays the sound at the new setting.
 */
function SliderField({
  spec,
  value,
  onChange,
  onLetGo,
}: {
  spec: FieldSpec;
  value: number;
  onChange: (value: number) => void;
  onLetGo: (value: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const min = spec.min ?? 0;
  const max = spec.max ?? 100;
  const letGo = () => {
    if (draft !== value) onChange(draft);
    onLetGo(draft);
  };
  return (
    <span className="bp-slider">
      <input
        type="range"
        min={min}
        max={max}
        step={spec.step ?? 1}
        value={draft}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={letGo}
        onKeyUp={letGo}
        aria-label={spec.label}
      />
      <NumberField spec={spec} value={draft} onChange={(v) => onChange(Number(v))} />
    </span>
  );
}

/** Whether a number is a percentage, and how to say it is or is not, with its value. */
interface Percent {
  on: boolean;
  set: (on: boolean, value: number) => void;
}

function NumberField({
  spec,
  value,
  percent = null,
  onChange,
}: {
  spec: FieldSpec;
  value: string | number;
  /** When given, a % typed after the number makes it a percentage, and taking it away makes it a number. */
  percent?: Percent | null;
  onChange: (value: string | number) => void;
}) {
  const sign = percent?.on ? '%' : '';
  const [text, setText] = useState(String(value) + sign);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(String(value) + sign);
  }, [value, sign]);
  const decimals = (spec.step ?? 1) < 1;
  const clamp = (n: number) => {
    const rounded = toStep(n, spec.step ?? 1);
    return Math.min(spec.max ?? rounded, Math.max(spec.min ?? rounded, rounded));
  };
  const input = (
    <input
      inputMode={decimals ? 'decimal' : 'numeric'}
      value={text}
      onFocus={() => (focused.current = true)}
      onChange={(e) => {
        // A minus only at the front, and only where the field goes below zero.
        const minus = (spec.min ?? 0) < 0 && e.target.value.trim().startsWith('-') ? '-' : '';
        const next = minus + e.target.value.replace(decimals ? /[^\d.]/g : /[^\d]/g, '').replace(/(\..*)\./g, '$1');
        // A % anywhere in it makes it a percentage, kept at the end; deleting it makes it a number again.
        const pct = percent !== null && e.target.value.includes('%');
        setText(next + (pct ? '%' : ''));
        const n = Number(next);
        const ok = next !== '' && !next.endsWith('.') && Number.isFinite(n) && n >= (spec.min ?? -Infinity) && n <= (spec.max ?? Infinity);
        if (percent && pct !== percent.on) percent.set(pct, ok ? clamp(n) : Number(value));
        else if (ok) onChange(clamp(n));
      }}
      onBlur={() => {
        focused.current = false;
        const bare = text.replace('%', '');
        const n = Number(bare);
        const clamped = Number.isFinite(n) && bare !== '' ? clamp(n) : Number(spec.default);
        setText(String(clamped) + sign);
        if (clamped !== value) onChange(clamped);
      }}
      aria-label={percent?.on ? `${spec.label}, a percentage` : spec.label}
    />
  );
  return input;
}

/**
 * A game off the games list: only what has run on this PC, by the name the
 * list gives it. An empty list says why rather than being an empty dropdown,
 * which looks like a broken screen.
 *
 * A box that only asks about a game (`anyGame`) lists every game, since one
 * can be in front without the app knowing how to start it, and its empty
 * choice is "any game" rather than a prompt to pick.
 */
function GameField({ spec, value, onChange }: { spec: FieldSpec; value: string; onChange: (value: string) => void }) {
  const list = useAsync(() => api.games.list(), []);
  // Only rows that count as games: the list also keeps apps switched off as
  // games (Discord, a browser), which no "while playing" means.
  const games = (list.data ?? []).filter((g) => (spec.anyGame ? g.isGame : g.launchPath || g.launchUrl) || g.exe === value);
  if (list.data && games.length === 0 && !spec.anyGame) {
    return <span className="bp-hint warn">Nothing on the games list can be started yet: play a game once with the app running and it will be.</span>;
  }
  const missing = value && !games.some((g) => g.exe === value);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={spec.label}>
      <option value="">{spec.anyGame ?? 'Pick a game…'}</option>
      {games.map((g) => (
        <option key={g.exe} value={g.exe}>
          {g.label}
        </option>
      ))}
      {missing && <option value={value}>{value} (not on the list now)</option>}
    </select>
  );
}

/**
 * Keys, typed or recorded. Recording listens on the window and swallows what
 * it hears, so pressing Delete to record it does not delete the box.
 *
 * Kept as typed while it is not a combination yet, and saved only once it is,
 * so "ctrl+" on the way to "ctrl+m" is not cleared by the save coming back.
 */
function KeysField({ spec, value, onChange }: { spec: FieldSpec; value: string | number; onChange: (value: string) => void }) {
  const [text, setText] = useState(String(value));
  const [recording, setRecording] = useState(false);
  const [refused, setRefused] = useState('');
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(String(value));
  }, [value]);

  useEffect(() => {
    if (!recording) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.code === 'Escape' && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
        setRecording(false);
        return;
      }
      const keys = keysFromEvent(event);
      if (!keys) return;
      if (spec.needModifier && !parseKeys(keys, true)) {
        setRefused(`${keys} on its own would take that key from every program: hold Ctrl, Alt, Shift or Win with it.`);
        return;
      }
      setRefused('');
      setText(keys);
      onChange(keys);
      setRecording(false);
    };
    /*
     * A watched hotkey can be a mouse button, any of the five, recorded by
     * pressing it once Record is on. A press on the Record button itself is
     * left to cancel. What a button would otherwise do (a click, the menu, a
     * side button going back a page) is stopped while recording.
     */
    const BUTTONS: Record<number, string> = { 0: 'mouse1', 1: 'mouse3', 2: 'mouse2', 3: 'mouse4', 4: 'mouse5' };
    const onMouse = (event: MouseEvent) => {
      const name = BUTTONS[event.button];
      if (!name) return;
      if ((event.target as HTMLElement | null)?.closest?.('[data-record]')) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.type !== 'mousedown') return;
      const keys = [event.ctrlKey && 'ctrl', event.altKey && 'alt', event.shiftKey && 'shift', event.metaKey && 'win', name].filter(Boolean).join('+');
      setRefused('');
      setText(keys);
      onChange(keys);
      // Recording ends on the press, before its let-go, which is when a side button goes back a page.
      swallowRelease(event.button);
      setRecording(false);
    };
    window.addEventListener('keydown', onKey, true);
    // And should the window go back a page anyway, it comes straight forward again.
    const stay = () => history.forward();
    window.addEventListener('popstate', stay);
    if (spec.mouse) {
      window.addEventListener('mousedown', onMouse, true);
      window.addEventListener('mouseup', onMouse, true);
      window.addEventListener('auxclick', onMouse, true);
      window.addEventListener('click', onMouse, true);
      window.addEventListener('contextmenu', onMouse, true);
    }
    return () => {
      window.removeEventListener('keydown', onKey, true);
      // A moment longer than recording, for the let-go of the press that ended it.
      setTimeout(() => window.removeEventListener('popstate', stay), 1500);
      window.removeEventListener('mousedown', onMouse, true);
      window.removeEventListener('mouseup', onMouse, true);
      window.removeEventListener('auxclick', onMouse, true);
      window.removeEventListener('click', onMouse, true);
      window.removeEventListener('contextmenu', onMouse, true);
    };
  }, [recording]);

  const valid = text === '' || parseKeys(text, spec.needModifier, spec.mouse) !== null;
  return (
    <>
      <span className="bp-keys">
        <input
          value={recording ? '' : text}
          placeholder={recording ? 'press the keys…' : spec.placeholder}
          disabled={recording}
          onFocus={() => (focused.current = true)}
          onChange={(e) => {
            setText(e.target.value);
            const keys = normalKeys(e.target.value, spec.needModifier, spec.mouse);
            if (keys || e.target.value.trim() === '') onChange(keys);
          }}
          onBlur={() => {
            focused.current = false;
            setText(normalKeys(text, spec.needModifier, spec.mouse) || String(value));
          }}
          aria-label={spec.label}
        />
        <button type="button" data-record className={recording ? 'primary' : ''} onClick={() => setRecording((r) => !r)}>
          {recording ? 'Cancel' : 'Record'}
        </button>
      </span>
      {recording && (
        <span className="bp-hint">
          {refused ||
            (spec.mouse
              ? 'Press a key or a mouse button. Esc cancels.'
              : 'Press them now. Esc cancels. Keys Windows keeps for itself (Ctrl+Alt+Delete, Win+L) cannot be recorded: type them instead.')}
        </span>
      )}
      {!recording && !valid && (
        <span className="bp-hint warn">
          {spec.needModifier && parseKeys(text) ? 'Needs Ctrl, Alt, Shift or Win with it.' : 'Not a key this knows. Try Record.'}
        </span>
      )}
    </>
  );
}

function Field({
  spec,
  nodeSpec,
  value,
  habits,
  placeholders,
  wiredIn,
  wiredLetters,
  variables,
  preview,
  percent = null,
  onHear,
  onChange,
}: {
  spec: FieldSpec;
  nodeSpec: NodeSpec;
  value: string | number;
  habits: HabitChoice[];
  placeholders: string[];
  /** A number wired into it, which is used instead of the one typed. */
  wiredIn: boolean;
  wiredLetters: Set<string>;
  variables: Record<string, number | string>;
  /** What a sum, or the number on its wire, comes to. */
  preview: Preview | null;
  /** A number that can be a percentage, by typing % after it. */
  percent?: Percent | null;
  /** Play the box's sound with this field changed, for a field that is part of a sound. */
  onHear?: (patch: Record<string, string | number>) => void;
  onChange: (value: string | number) => void;
}): ReactNode {
  const id = `${nodeSpec.type}-${spec.key}`;
  let control: ReactNode;
  switch (spec.kind) {
    case 'choice': {
      const select = (
        <select
          value={String(value)}
          onChange={(e) => {
            onChange(e.target.value);
            // Picking a sound plays it, so the names need not be learned.
            if (spec.tone) onHear?.({ [spec.key]: e.target.value });
          }}
          aria-label={spec.label || nodeSpec.label}
        >
          {spec.options!.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      );
      control = select;
      break;
    }
    case 'habit': {
      // "Any" only means something for the event; a check or a tick needs one.
      const anyAllowed = nodeSpec.kind === 'event';
      const missing = value && !habits.some((h) => h.id === value);
      control = (
        <select value={String(value)} onChange={(e) => onChange(e.target.value)} aria-label={spec.label}>
          <option value="">{anyAllowed ? 'Any habit' : 'Pick a habit…'}</option>
          {habits.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
          {missing && <option value={String(value)}>(a habit that has gone)</option>}
        </select>
      );
      break;
    }
    case 'time':
      control = <input type="time" value={String(value)} onChange={(e) => e.target.value && onChange(e.target.value)} aria-label={spec.label} />;
      break;
    case 'number':
      control = wiredIn ? (
        <span
          className={`bp-wired-in${preview?.kind === 'wrong' ? ' warn' : ''}`}
          title="Take the wire off its way in on the left to type a number again"
        >
          {preview?.kind === 'values'
            ? `From the wire: ${describePreview(preview)}`
            : preview?.kind === 'wrong'
              ? `From the wire, which cannot be worked out: ${preview.why}`
              : 'From the wire on its way in'}
        </span>
      ) : (
        spec.slider ? (
          <SliderField spec={spec} value={Number(value)} onChange={onChange} onLetGo={(v) => onHear?.({ [spec.key]: v })} />
        ) : (
          <NumberField spec={spec} value={value} percent={percent} onChange={onChange} />
        )
      );
      break;
    case 'math':
      // A div, not a label: a label would hand every click to the hidden text box, wherever it landed.
      return (
        <div className="bp-field" data-field={id}>
          {spec.label && <span className="bp-field-label">{spec.label}</span>}
          <MathField
            spec={spec}
            nodeSpec={nodeSpec}
            value={String(value)}
            preview={preview}
            onChange={onChange}
          />
          {spec.hint && <span className="bp-hint">{spec.hint}</span>}
        </div>
      );
    case 'color':
      // A label wrapping buttons would press the first on any click in the field.
      return (
        <div className="bp-field" data-field={id}>
          {spec.label && <span className="bp-field-label">{spec.label}</span>}
          <ColorField value={String(value)} onChange={onChange} none="The app's own accent" />
        </div>
      );
    case 'game':
      control = <GameField spec={spec} value={String(value)} onChange={onChange} />;
      break;
    case 'timeline':
      // Its own block: a picture and a button, and the editor it opens.
      return <TimelineField value={String(value)} onChange={onChange} />;
    case 'keys':
      // A label wrapping a button would press it on any click in the field.
      return (
        <div className="bp-field" data-field={id}>
          {spec.label && <span className="bp-field-label">{spec.label}</span>}
          <KeysField spec={spec} value={value} onChange={onChange} />
          {spec.hint && <span className="bp-hint">{spec.hint}</span>}
        </div>
      );
    case 'longtext':
      control = <textarea rows={2} value={String(value)} placeholder={spec.placeholder} onChange={(e) => onChange(e.target.value)} aria-label={spec.label} />;
      break;
    default: {
      // A Set box's name offers the variables there are, so it can be picked rather than spelled.
      const names = nodeSpec.type === 'set-variable' && spec.key === 'name' ? Object.keys(variables) : [];
      control = (
        <>
          <input
            value={String(value)}
            placeholder={spec.placeholder}
            onChange={(e) => onChange(e.target.value)}
            aria-label={spec.label}
            list={names.length ? `${id}-names` : undefined}
          />
          {names.length > 0 && (
            <datalist id={`${id}-names`}>
              {names.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          )}
        </>
      );
    }
  }
  // The run's words, and every variable, since a text box fills in both.
  const words = [...new Set([...placeholders, ...Object.keys(variables)])];
  const saysWords = (spec.kind === 'text' || spec.kind === 'longtext') && nodeSpec.kind === 'action' && words.length > 0;
  return (
    <label className="bp-field" data-field={id}>
      {spec.label && <span className="bp-field-label">{spec.label}</span>}
      {control}
      {spec.hint && <span className="bp-hint">{spec.hint}</span>}
      {saysWords && spec.key !== 'note' && spec.key !== 'name' && spec.key !== 'saveAs' && (
        <span className="bp-hint">Can use {words.map((p) => `{${p}}`).join(' ')}</span>
      )}
    </label>
  );
}

const GROUPS: NodeKind[] = ['event', 'branch', 'logic', 'action'];

/**
 * Add a box: a search over every box, by its name, what it does and the other
 * things it might be called (`search.ts`), with the four kinds as chips to
 * narrow it. Empty, it lists them all under their kind, as before. The arrow
 * keys move through what is listed and Enter adds the one marked; Escape
 * closes.
 */
function AddMenu({ onPick, onClose }: { onPick: (spec: NodeSpec) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<NodeKind | null>(null);
  const [marked, setMarked] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const found = searchBoxes(query).filter((f) => !kind || f.spec.kind === kind);
  const searching = query.trim() !== '';

  useEffect(() => setMarked(0), [query, kind]);
  useEffect(() => {
    list.current?.querySelector('[data-marked="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [marked]);

  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setMarked((m) => Math.min(m + 1, found.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setMarked((m) => Math.max(m - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = found[marked];
      if (pick) onPick(pick.spec);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  const item = (f: Found, i: number) => (
    <button
      key={f.spec.type}
      type="button"
      className={`bp-menu-item${i === marked ? ' marked' : ''}`}
      data-marked={i === marked}
      onClick={() => onPick(f.spec)}
      onMouseMove={() => setMarked(i)}
    >
      <span className="bp-menu-glyph" aria-hidden="true">{f.spec.glyph}</span>
      <span>
        <span className="bp-menu-name">
          <strong>{f.spec.label}</strong>
          {searching && <span className={`bp-menu-chip kind-${f.spec.kind}`}>{KIND_LABEL[f.spec.kind]}</span>}
        </span>
        <span className="meta">{f.spec.blurb}</span>
        {f.because && <span className="bp-menu-because">matches “{f.because}”</span>}
      </span>
    </button>
  );

  // Numbered across sections, so the marked one is the same however it is drawn.
  let n = 0;
  return (
    <div className="bp-menu" role="dialog" aria-label="Add a box">
      <div className="bp-menu-head">
        <strong>Add a box</strong>
        <button type="button" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <input
        className="bp-menu-search"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKey}
        placeholder="Search: while playing, remind me, key…"
        aria-label="Search for a box"
        autoFocus
      />
      <div className="bp-menu-kinds" role="group" aria-label="Kind of box">
        <button type="button" className={kind === null ? 'on' : ''} onClick={() => setKind(null)} aria-pressed={kind === null}>
          All
        </button>
        {GROUPS.map((k) => (
          <button key={k} type="button" className={`kind-${k}${kind === k ? ' on' : ''}`} onClick={() => setKind(kind === k ? null : k)} aria-pressed={kind === k}>
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>
      <div className="bp-menu-list" ref={list}>
        {found.length === 0 && <p className="meta bp-menu-none">Nothing matches “{query.trim()}”. Try another word for it.</p>}
        {searching
          ? found.map((f, i) => item(f, i))
          : GROUPS.filter((k) => !kind || k === kind).map((k) => (
              <section key={k}>
                <h3 className={`bp-menu-kind kind-${k}`}>{KIND_LABEL[k]}</h3>
                {found.filter((f) => f.spec.kind === k).map((f) => item(f, n++))}
              </section>
            ))}
      </div>
    </div>
  );
}
