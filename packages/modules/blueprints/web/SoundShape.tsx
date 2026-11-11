/**
 * Make your own sound: lines of pitch over time, as many points on a line as
 * you like and as many lines as you like, overlapping or not, each in its own
 * wave and at its own loudness. Replaced a beep and a sweep with two fixed ends
 * (2026-11-07), which could not make a two-note chirp or a chord. On the box, a
 * picture of it and a button; the button opens the graph over the screen (240px
 * is no room for one), as the timeline of Press keys does.
 *
 * It is worked with tools, as a drawing program is (`TOOLS`): grab (scroll,
 * move a line whole, move a point), select, box select, new line, new point and
 * erase, with undo and redo. What is selected is a set of points, so a line, a
 * segment (its two ends) or any run of points is a selection, and cut, copy,
 * paste, duplicate and delete act on it, from the right click menu or the keys.
 *
 * - **Pitch**, the top lane, on a scale of octaves, so a slide that sounds even
 *   is a straight line. Each point is caught by a ring well wider than it is
 *   drawn.
 * - **The sound itself**, the lower lane: the real waveform, the same samples
 *   the PC plays, every line mixed.
 * - **The whole of it**, a strip underneath: what is in view is a window on it,
 *   dragged to scroll and by its ends to zoom. The wheel scrolls; Ctrl and the
 *   wheel (or a pinch) zoom where the pointer is.
 *
 * Letting go of anything plays it. Numbers are there too, for exact values.
 */
import { useEffect, useId, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { harmonicsOf, helloFormants, helloVoiced } from './sound-examples';
import { designOf, designSamples, parseSoundShape, SHAPE_LIMITS, shapeLength, soundShapeText, waveAt, type SoundLine, type SoundPoint, type Wave } from './sound-design';

type Fields = Record<string, string | number>;

const LO_HZ = 30;
const HI_HZ = 12_000;
const W = 720;
const LEFT = 56;
const RIGHT = 18;
const PITCH_TOP = 14;
const PITCH_H = 220;
const AMP_TOP = PITCH_TOP + PITCH_H + 26;
const AMP_H = 80;
const TICKS_Y = AMP_TOP + AMP_H + 18;
const OV_TOP = AMP_TOP + AMP_H + 30;
const OV_H = 34;
const H = OV_TOP + OV_H + 4;
const PLOT_W = W - LEFT - RIGHT;
/** Lines are told apart by colour: eight, as many as a sound may have. */
const COLOURS = 8;
/** The shortest stretch the graph zooms in to, in ms. */
const MIN_VIEW = 20;
/** How near a press must be to a point, in screen pixels, for the new point tool to take that point rather than add one. */
const GRAB_PX = 18;
/** How far a press may wander, in screen pixels, and still be a click rather than a drag. */
const CLICK_PX = 3;
/** The rate the editor draws the waveform at: plenty to see by, and quick to redraw while dragging. */
const DRAW_RATE = 16_000;
/** How many steps back undo keeps. */
const HISTORY = 100;

const WAVES: Array<{ id: Wave; label: string }> = [
  { id: 'sine', label: 'Smooth' },
  { id: 'triangle', label: 'Soft-edged' },
  { id: 'square', label: 'Buzzy' },
  { id: 'saw', label: 'Bright' },
];

type Tool = 'grab' | 'select' | 'box' | 'line' | 'point' | 'erase';

/** The icons, drawn in the text's colour so they follow the theme. */
const ICON: Record<Tool | 'undo' | 'redo' | 'more', ReactNode> = {
  grab: (
    <path d="M7 11V5.6a1.2 1.2 0 0 1 2.4 0V10M9.4 10V4.4a1.2 1.2 0 0 1 2.4 0V10M11.8 10V5.4a1.2 1.2 0 0 1 2.4 0V10.5M14.2 10.5V7.6a1.2 1.2 0 0 1 2.4 0V12.5c0 3.2-2.1 5.5-5.2 5.5h-1c-1.8 0-3-.8-4-2.3L3.7 11.9a1.3 1.3 0 0 1 2.1-1.5L7 12" />
  ),
  select: <path className="fill" d="M5 2.5v14.2l3.6-3.4 2.4 5.2 2.4-1.1-2.4-5.1 5-.3z" />,
  box: (
    <>
      <rect x="2.5" y="3.5" width="13" height="11" strokeDasharray="2.4 2" />
      <path className="fill" d="M11.5 10.5v7.8l1.9-1.8 1.2 2.7 1.3-.6-1.2-2.6 2.6-.2z" />
    </>
  ),
  line: (
    <>
      <path d="M3 16.5L11 8.5" />
      <circle className="fill" cx="3" cy="16.5" r="1.7" />
      <circle className="fill" cx="11" cy="8.5" r="1.7" />
      <path d="M15.5 2.5v6M12.5 5.5h6" />
    </>
  ),
  point: (
    <>
      <circle className="fill" cx="8" cy="12.5" r="4.2" />
      <path d="M15.5 2.5v6M12.5 5.5h6" />
    </>
  ),
  erase: (
    <>
      <path d="M3.5 12.5l7.2-7.2a1.4 1.4 0 0 1 2 0l3 3a1.4 1.4 0 0 1 0 2l-6.6 6.6H6.5z" />
      <path d="M7.5 8.6l4.9 4.9M9.1 16.9h8.4" />
    </>
  ),
  undo: <path d="M7.5 4.5L3.5 8.5l4 4M3.5 8.5h8.5a4.5 4.5 0 0 1 0 9H8.5" />,
  redo: <path d="M12.5 4.5l4 4-4 4M16.5 8.5H8a4.5 4.5 0 0 0 0 9h3.5" />,
  more: (
    <>
      <circle className="fill" cx="4.5" cy="10" r="1.6" />
      <circle className="fill" cx="10" cy="10" r="1.6" />
      <circle className="fill" cx="15.5" cy="10" r="1.6" />
    </>
  ),
};

const TOOLS: Array<{ id: Tool; label: string; key: string; hint: string }> = [
  {
    id: 'grab',
    label: 'Grab',
    key: 'H',
    hint: 'Drag the background to scroll, a line to move it whole, or a point to move just that point.',
  },
  {
    id: 'select',
    label: 'Select',
    key: 'V',
    hint: 'Click a line or a point to select it; Alt and a click for one segment. Ctrl adds or takes away; Shift adds everything between. Drag what is selected to move it.',
  },
  {
    id: 'box',
    label: 'Box select',
    key: 'M',
    hint: 'Drag a box round points to select them. Ctrl adds to the selection; Shift adds everything between too. A click selects as Select does.',
  },
  {
    id: 'line',
    label: 'New line',
    key: 'L',
    hint: 'Drag from where the line starts to where it ends. A click makes a short flat line.',
  },
  {
    id: 'point',
    label: 'New point',
    key: 'P',
    hint: 'Click a line to select it, then click it again, or beside it, to add a point there. Drag to place it.',
  },
  {
    id: 'erase',
    label: 'Erase',
    key: 'E',
    hint: 'Click a point or a line to erase it, or drag a box over points to erase them.',
  },
];

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const SEMITONE = 2 ** (1 / 12);
const NOTE_NAMES = ['A', 'A#', 'B', 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#'];

/** The note nearest a pitch, as a musician names it: 440 Hz is A4. */
function noteName(hz: number): string {
  const n = Math.round(12 * Math.log2(hz / 440));
  return `${NOTE_NAMES[((n % 12) + 12) % 12]}${4 + Math.floor((n + 9) / 12)}`;
}

/** A pitch, moved to the nearest note when asked. */
const toNote = (hz: number, notes: boolean) => (notes ? 440 * 2 ** (Math.round(12 * Math.log2(hz / 440)) / 12) : hz);

const yOfHz = (hz: number) => PITCH_TOP + (1 - Math.log(hz / LO_HZ) / Math.log(HI_HZ / LO_HZ)) * PITCH_H;
const hzOfY = (y: number) => LO_HZ * (HI_HZ / LO_HZ) ** (1 - clamp((y - PITCH_TOP) / PITCH_H, 0, 1));

const copyLines = (lines: SoundLine[]): SoundLine[] => lines.map((l) => ({ ...l, points: l.points.map((p) => ({ ...p })) }));

/** A point's name in a selection. */
const key = (line: number, point: number) => `${line}:${point}`;
const unkey = (k: string) => k.split(':').map(Number) as [number, number];

/** A round span to draw, with room after the sound to draw more into. */
function spanFor(total: number): number {
  const want = Math.max(200, total * 1.3);
  const steps = [200, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 4000, 5000, 6500, 8000, 10_000, 13_000];
  return steps.find((s) => s >= want) ?? 13_000;
}

/** A stretch of time shown on the graph: from `start`, `len` ms long. */
type View = { start: number; len: number };

/** A view kept inside the sound and no narrower than `MIN_VIEW`; null when it shows all of it. */
function clampView(v: View, extent: number): View | null {
  const len = clamp(v.len, MIN_VIEW, extent);
  if (len >= extent - 0.5) return null;
  return { start: clamp(v.start, 0, extent - len), len };
}

/** "120 ms" or "1.5 s". */
const msLabel = (ms: number) => (ms >= 1000 ? `${Math.round(ms / 100) / 10} s` : `${Math.round(ms)} ms`);

function describe(lines: SoundLine[]): string {
  if (lines.length === 0) return 'No lines yet: silent';
  const hz = lines.flatMap((l) => l.points.map((p) => p.hz));
  const lo = Math.min(...hz);
  const hi = Math.max(...hz);
  const range = lo === hi ? `${lo} Hz` : `${lo}–${hi} Hz`;
  return `${lines.length === 1 ? '1 line' : `${lines.length} lines`} · ${shapeLength(lines)} ms · ${range}`;
}

/** The loudest and quietest sample in each column, so a long sound draws as its outline and a short low one as its waves. */
function columns(samples: Float32Array, width: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const per = samples.length / width;
  for (let x = 0; x < width; x++) {
    let lo = 0;
    let hi = 0;
    const a = Math.floor(x * per);
    const b = Math.max(a + 1, Math.floor((x + 1) * per));
    for (let i = a; i < b && i < samples.length; i++) {
      const v = samples[i]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    out.push([lo, hi]);
  }
  return out;
}

/** Where a point may go: between its neighbours, and never so far that its line is under 5 ms. */
function pointRoom(line: SoundLine, i: number): { lo: number; hi: number } {
  const pts = line.points;
  let lo = i > 0 ? pts[i - 1]!.t : 0;
  let hi = i < pts.length - 1 ? pts[i + 1]!.t : SHAPE_LIMITS.ms;
  if (i === 0) hi = Math.min(hi, pts[pts.length - 1]!.t - 5);
  if (i === pts.length - 1) lo = Math.max(lo, pts[0]!.t + 5);
  return { lo, hi: Math.max(lo, hi) };
}

/** Where a point at this moment goes in a line, so the line stays in time order. */
function insertAt(line: SoundLine, p: SoundPoint): number {
  const i = line.points.findIndex((q) => q.t > p.t);
  const at = i === -1 ? line.points.length : i;
  line.points.splice(at, 0, p);
  return at;
}

/** The pitch a line has at a moment: what a point put on it there should have, so adding one does not bend it. */
function hzAt(line: SoundLine, t: number): number {
  const p = line.points;
  if (t <= p[0]!.t) return p[0]!.hz;
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i]!;
    const b = p[i + 1]!;
    if (t <= b.t) return Math.round(b.t > a.t ? a.hz * (b.hz / a.hz) ** ((t - a.t) / (b.t - a.t)) : b.hz);
  }
  return p[p.length - 1]!.hz;
}

/** How loud a line is at a moment, as a point put there should be: nothing when it is full there. */
function loudnessAt(line: SoundLine, t: number): { v?: number } {
  const p = line.points;
  let v = p[p.length - 1]!.v ?? 1;
  if (t <= p[0]!.t) v = p[0]!.v ?? 1;
  else
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i]!;
      const b = p[i + 1]!;
      if (t <= b.t) {
        v = b.t > a.t ? (a.v ?? 1) + ((b.v ?? 1) - (a.v ?? 1)) * ((t - a.t) / (b.t - a.t)) : (b.v ?? 1);
        break;
      }
    }
  return v < 1 ? { v: Math.round(v * 100) / 100 } : {};
}

/** The lines without these points; a line left with fewer than two, or under 5 ms, goes. */
function withoutPoints(lines: SoundLine[], keys: Set<string>): SoundLine[] {
  return lines
    .map((l, j) => ({
      ...l,
      points: l.points.filter((_, i) => !keys.has(key(j, i))).map((p) => ({ ...p })),
    }))
    .filter((l) => l.points.length >= 2 && l.points[l.points.length - 1]!.t - l.points[0]!.t >= 5);
}

/**
 * The selected points moved by `dt` ms and pitched by `ratio`, as far as they
 * can go: a point never passes a neighbour that is staying put, a line is never
 * squeezed under 5 ms, nothing leaves the sound's limits. Each line's selected
 * points move together, so their order is kept.
 */
function shifted(base: SoundLine[], keys: Set<string>, dtWanted: number, ratioWanted: number, notes: boolean): SoundLine[] {
  let lo = -Infinity;
  let hi = Infinity;
  let hzLo = Infinity;
  let hzHi = 0;
  const byLine = new Map<number, Set<number>>();
  for (const k of keys) {
    const [l, i] = unkey(k);
    if (!base[l]?.points[i]) continue;
    if (!byLine.has(l)) byLine.set(l, new Set());
    byLine.get(l)!.add(i);
  }
  for (const [l, s] of byLine) {
    const pts = base[l]!.points;
    const last = pts.length - 1;
    const whole = s.size === pts.length;
    for (const i of s) {
      const q = pts[i]!;
      lo = Math.max(lo, -q.t);
      hi = Math.min(hi, SHAPE_LIMITS.ms - q.t);
      hzLo = Math.min(hzLo, q.hz);
      hzHi = Math.max(hzHi, q.hz);
      if (whole) continue;
      if (i > 0 && !s.has(i - 1)) lo = Math.max(lo, pts[i - 1]!.t - q.t);
      if (i < last && !s.has(i + 1)) hi = Math.min(hi, pts[i + 1]!.t - q.t);
      if (i === 0 && !s.has(last)) hi = Math.min(hi, pts[last]!.t - 5 - q.t);
      if (i === last && !s.has(0)) lo = Math.max(lo, pts[0]!.t + 5 - q.t);
    }
  }
  const dt = lo > hi ? 0 : clamp(dtWanted, lo, hi);
  // Moved up and down by a ratio, so a slide stays the same interval wherever it is put.
  const ratio = hzHi ? clamp(ratioWanted, Math.min(1, LO_HZ / hzLo), 12_000 / hzHi) : 1;
  const next = copyLines(base);
  for (const [l, s] of byLine) {
    for (const i of s) {
      const q = next[l]!.points[i]!;
      const hz = ratio === 1 && !notes ? q.hz : toNote(q.hz * ratio, notes);
      next[l]!.points[i] = {
        ...q,
        t: q.t + dt,
        hz: Math.round(clamp(hz, 20, 12_000)),
      };
    }
  }
  return next;
}

/*
 * What has been copied, kept for this browser so it pastes into the sound of
 * another box too. A copy is a list of lines, each the selected points of one.
 */
const CLIP_KEY = 'blueprints.sound-clipboard';
let clip: SoundLine[] | null = null;
function readClip(): SoundLine[] | null {
  if (clip) return clip;
  try {
    const raw = localStorage.getItem(CLIP_KEY);
    if (raw) clip = parseSoundShape(raw);
  } catch {
    // No storage here: only this page's copy.
  }
  return clip?.length ? clip : null;
}
function writeClip(lines: SoundLine[]): void {
  clip = copyLines(lines);
  try {
    localStorage.setItem(CLIP_KEY, soundShapeText(lines));
  } catch {
    // As above.
  }
}

/** On the box: a picture of the sound and the button that opens the graph. */
export function SoundShapeField({ fields, onFields, onHear }: { fields: Fields; onFields: (patch: Fields) => void; onHear: (fields: Fields) => void }) {
  const [open, setOpen] = useState(false);
  const lines = useMemo(() => parseSoundShape(fields.shape), [fields.shape]);
  const total = Math.max(1, shapeLength(lines));
  const mini = useMemo(() => {
    const d = designOf({ ...fields, sound: 'custom', times: 1 });
    return d ? columns(designSamples(d, 8000), 100) : [];
  }, [fields.shape, fields.fade, fields.volume]);
  const miniY = (hz: number) => 4 + (1 - Math.log(hz / LO_HZ) / Math.log(HI_HZ / LO_HZ)) * 32;
  return (
    <div className="bp-field bp-shape-field">
      <span className="bp-field-label">The sound</span>
      <svg className="bp-shape-mini" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
        <path className="bp-shape-wave" d={mini.map(([lo, hi], x) => `M${x + 0.5} ${20 - hi * 18}V${20 - lo * 18}`).join('')} />
        {lines.map((l, k) => (
          <polyline key={k} className={`bp-shape-line c${k % COLOURS}`} points={l.points.map((p) => `${(p.t / total) * 100},${miniY(p.hz)}`).join(' ')} />
        ))}
      </svg>
      <span className="bp-hint">{describe(lines)}</span>
      <button type="button" onClick={() => setOpen(true)}>
        Edit the sound
      </button>
      {open && <SoundEditor fields={fields} onFields={onFields} onHear={onHear} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** What a press landed on: empty space, a line (at a segment, with the end of it nearer), or a point. */
type Target = { kind: 'bg' } | { kind: 'line'; line: number; seg: number; near: number } | { kind: 'point'; line: number; point: number };
type Mods = { ctrl: boolean; shift: boolean; alt: boolean };
const modsOf = (e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): Mods => ({
  ctrl: e.ctrlKey || e.metaKey,
  shift: e.shiftKey,
  alt: e.altKey,
});
type At = { clientX: number; clientY: number; altKey: boolean };

type Press = { id: number; sx: number; sy: number; moved: boolean };
type MoveGrab = Press & {
  kind: 'move';
  before: SoundLine[];
  keys: Set<string>;
  from: { ms: number; y: number };
  /** One point taken to wherever the pointer is; otherwise everything in `keys` moved by how far it has gone. */
  single: { line: number; point: number } | null;
  /** What a click (no drag) leaves selected. */
  clickTo: Set<string> | null;
  /** Written even with no drag: a point just added. */
  keep: boolean;
};
type NewGrab = Press & {
  kind: 'new';
  before: SoundLine[];
  line: number;
  start: SoundPoint;
};
type Grab =
  | (Press & { kind: 'pan'; fromX: number; orig: View })
  | (Press & {
      kind: 'view';
      mode: 'pan' | 'left' | 'right';
      fromX: number;
      orig: View;
    })
  | MoveGrab
  | NewGrab
  | (Press & {
      kind: 'box';
      erase: boolean;
      from: { x: number; y: number };
      target: Target;
      mods: Mods;
    });

type Snapshot = { lines: SoundLine[]; fields: Fields };
type MenuAt = {
  x: number;
  y: number;
  ms: number;
  onBg: boolean;
  line: number | null;
};

function SoundEditor({ fields, onFields, onHear, onClose }: { fields: Fields; onFields: (patch: Fields) => void; onHear: (fields: Fields) => void; onClose: () => void }) {
  // Drafts while dragging, written to the box when let go: a write per pixel would redraw the whole board per pixel.
  const [draft, setDraft] = useState<Fields>(fields);
  const [lines, setLines] = useState<SoundLine[]>(() => parseSoundShape(fields.shape));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tool, setTool] = useState<Tool>('grab');
  const [notes, setNotes] = useState(false);
  const [said, setSaid] = useState('');
  const [box, setBox] = useState<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    erase: boolean;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [hasClip, setHasClip] = useState(() => readClip() !== null);
  const past = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  const [, setHistory] = useState(0);
  const grabbing = useRef<Grab | null>(null);
  /** The lines as they were when a slider started moving, so undo goes back past the whole slide. */
  const slideFrom = useRef<SoundLine[] | null>(null);
  /** The point a Shift-click counts from. */
  const anchor = useRef<{ line: number; point: number } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const clipId = `bp-shape-clip${useId().replace(/[^\w-]/g, '')}`;
  useEffect(() => {
    if (grabbing.current) return;
    setDraft(fields);
    setLines(parseSoundShape(fields.shape));
  }, [fields]);
  useEffect(() => dialog.current?.focus(), []);

  const text = soundShapeText(lines);
  const total = shapeLength(lines);
  const times = Math.max(1, Math.round(Number(draft.times) || 1));
  const gap = Math.max(0, Number(draft.gap) || 0);
  // The whole of it, repeats included, with room after to draw more into.
  const extent = spanFor(Math.min(10_000, total * times + gap * (times - 1)));
  // Zoomed is what you chose; held is the view frozen for a drag, so the graph does not rescale under the pointer.
  const [zoom, setZoom] = useState<View | null>(null);
  const [held, setHeld] = useState<View | null>(null);
  const view: View = held ?? (zoom && clampView(zoom, extent)) ?? { start: 0, len: extent };
  const xOf = (ms: number) => LEFT + ((ms - view.start) / view.len) * PLOT_W;
  const live = useRef({ view, extent });
  live.current = { view, extent };
  const zoomBy = (factor: number, around = view.start + view.len / 2) => {
    const frac = (around - view.start) / view.len;
    const len = view.len * factor;
    setZoom(clampView({ start: around - frac * len, len }, extent));
  };
  const volume = clamp(Number(draft.volume ?? 50), 0, 100) / 100;

  // The lines anything is selected on, and the one point when only one is.
  const pickedLines = [...new Set([...selected].map((k) => unkey(k)[0]))].filter((l) => lines[l]).sort((a, b) => a - b);
  const targetLines = pickedLines.length ? pickedLines : lines.length === 1 ? [0] : [];
  const onlyPoint = selected.size === 1 ? unkey([...selected][0]!) : null;
  const point = onlyPoint ? lines[onlyPoint[0]]?.points[onlyPoint[1]] : undefined;

  // The wheel scrolls the graph sideways; Ctrl and the wheel (a trackpad pinch arrives as that) zoom at the pointer.
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const { view: v, extent: ext } = live.current;
      const r = el.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * W;
      const frac = clamp((x - LEFT) / PLOT_W, 0, 1);
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const len = v.len * Math.exp(e.deltaY * 0.0025);
        const around = v.start + frac * v.len;
        setZoom(clampView({ start: around - frac * len, len }, ext));
        return;
      }
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!d || v.len >= ext) return;
      e.preventDefault();
      setZoom(clampView({ start: v.start + (d / PLOT_W) * v.len, len: v.len }, ext));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /** The fields undo puts back besides the lines. */
  const pickFields = (f: Fields): Fields => ({
    fade: f.fade ?? 5,
    volume: f.volume ?? 50,
    times: f.times ?? 1,
    gap: f.gap ?? 80,
  });

  /** Writes the lines (and any other fields) to the box, remembers what was there for undo, and plays the result. */
  const commit = (next: SoundLine[], patch: Fields = {}, hear = true, before: SoundLine[] = lines) => {
    past.current.push({ lines: copyLines(before), fields: pickFields(draft) });
    if (past.current.length > HISTORY) past.current.shift();
    future.current = [];
    setHistory((n) => n + 1);
    const shape = soundShapeText(next);
    const all = { ...draft, ...patch, shape };
    setLines(next);
    setDraft(all);
    onFields({ ...patch, shape });
    if (hear) onHear(all);
  };
  const commitFields = (patch: Fields, hear = true) => commit(lines, patch, hear);

  const restore = (s: Snapshot) => {
    const shape = soundShapeText(s.lines);
    const all = { ...draft, ...s.fields, shape };
    setLines(s.lines);
    setDraft(all);
    setSelected(new Set());
    onFields({ ...s.fields, shape });
    setHistory((n) => n + 1);
  };
  const undo = () => {
    const s = past.current.pop();
    if (!s) return;
    future.current.push({ lines: copyLines(lines), fields: pickFields(draft) });
    restore(s);
  };
  const redo = () => {
    const s = future.current.pop();
    if (!s) return;
    past.current.push({ lines: copyLines(lines), fields: pickFields(draft) });
    restore(s);
  };

  const samples = useMemo(() => {
    const d = designOf({ ...draft, sound: 'custom', shape: text });
    return d ? designSamples(d, DRAW_RATE) : new Float32Array(0);
  }, [text, draft.fade, draft.volume, draft.times, draft.gap]);
  const ampY = (v: number) => AMP_TOP + AMP_H / 2 - v * (AMP_H / 2 - 4);
  /*
   * The waveform in view: the loudest and quietest sample per pixel while there
   * are several to a pixel, and the samples themselves joined up once zoomed in
   * far enough that there are not, so a close look shows the wave's shape.
   */
  const wavePath = useMemo(() => {
    const per = ((view.len / 1000) * DRAW_RATE) / PLOT_W;
    const first = (view.start / 1000) * DRAW_RATE;
    let d = '';
    if (per < 2) {
      const a = Math.max(0, Math.floor(first));
      const b = Math.min(samples.length - 1, Math.ceil(first + per * PLOT_W));
      for (let i = a; i <= b; i++) d += `${i === a ? 'M' : 'L'}${(LEFT + (i - first) / per).toFixed(1)} ${ampY(samples[i]!).toFixed(1)}`;
      return d;
    }
    for (let px = 0; px < PLOT_W; px++) {
      const a = Math.floor(first + px * per);
      if (a >= samples.length) break;
      const b = Math.min(samples.length, Math.floor(first + (px + 1) * per));
      let lo = samples[a]!;
      let hi = lo;
      for (let i = a + 1; i < b; i++) {
        const v = samples[i]!;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      d += `M${LEFT + px + 0.5} ${ampY(hi).toFixed(1)}V${(ampY(lo) + 0.01).toFixed(1)}`;
    }
    return d;
  }, [samples, view.start, view.len]);

  /** Where the pointer is on the graph, in its own units, snapped to 5 ms (to 1 with Alt, or zoomed in) and, if asked, to a note. */
  const at = (e: At) => {
    const r = svg.current!.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const y = ((e.clientY - r.top) / r.height) * H;
    const step = e.altKey || view.len <= 100 ? 1 : 5;
    const raw = view.start + ((x - LEFT) / PLOT_W) * view.len;
    const ms = clamp(Math.round(raw / step) * step, 0, SHAPE_LIMITS.ms);
    return {
      ms,
      raw,
      step,
      hz: Math.round(clamp(toNote(hzOfY(y), notes), 20, 12_000)),
      x,
      y,
    };
  };

  /** Which segment of a line is nearest a place on the graph, and which of its two ends is nearer. */
  const segmentAt = (l: number, x: number, y: number): { seg: number; near: number } => {
    const pts = lines[l]!.points;
    let best = { seg: 0, near: 0, d: Infinity };
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = xOf(pts[i]!.t);
      const ay = yOfHz(pts[i]!.hz);
      const bx = xOf(pts[i + 1]!.t);
      const by = yOfHz(pts[i + 1]!.hz);
      const len2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1;
      const u = clamp(((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len2, 0, 1);
      const d = Math.hypot(ax + u * (bx - ax) - x, ay + u * (by - ay) - y);
      if (d < best.d) best = { seg: i, near: u < 0.5 ? i : i + 1, d };
    }
    return { seg: best.seg, near: best.near };
  };
  const lineTarget = (l: number, e: At): Target => {
    const p = at(e);
    return { kind: 'line', line: l, ...segmentAt(l, p.x, p.y) };
  };

  /** The point nearest a press, if one is near enough on screen to have been meant: the selected lines' first. */
  const nearPoint = (e: { clientX: number; clientY: number }): { line: number; point: number } | null => {
    const r = svg.current!.getBoundingClientRect();
    const scale = r.width / W;
    const x = ((e.clientX - r.left) / r.width) * W;
    const y = ((e.clientY - r.top) / r.height) * H;
    let best: { line: number; point: number } | null = null;
    let bestD = Infinity;
    lines.forEach((l, j) =>
      l.points.forEach((p, i) => {
        const px = xOf(p.t);
        if (px < LEFT || px > W - RIGHT) return;
        const d = Math.hypot(px - x, yOfHz(p.hz) - y) * scale - (pickedLines.includes(j) ? 4 : 0);
        if (d <= GRAB_PX && d < bestD) {
          best = { line: j, point: i };
          bestD = d;
        }
      })
    );
    return best;
  };

  /** The points a press on a target stands for: a point, a segment's two ends (with Alt), or a whole line. */
  const itemsOf = (t: Target, alt: boolean): string[] => {
    if (t.kind === 'point') return [key(t.line, t.point)];
    if (t.kind === 'line') return alt ? [key(t.line, t.seg), key(t.line, t.seg + 1)] : lines[t.line]!.points.map((_, i) => key(t.line, i));
    return [];
  };

  /** A click that selects: replace, Ctrl to add or take away, Shift to add with every point between it and the last one clicked. */
  const selectClick = (t: Target, mods: Mods) => {
    if (t.kind === 'bg') {
      if (!mods.ctrl && !mods.shift) setSelected(new Set());
      return;
    }
    const items = itemsOf(t, mods.alt);
    let next: Set<string>;
    if (mods.ctrl) {
      next = new Set(selected);
      const all = items.every((k) => next.has(k));
      for (const k of items) {
        if (all) next.delete(k);
        else next.add(k);
      }
    } else if (mods.shift) {
      next = new Set(selected);
      items.forEach((k) => next.add(k));
      const a = anchor.current;
      if (a && a.line === t.line && lines[a.line]?.points[a.point]) {
        const idx = items.map((k) => unkey(k)[1]);
        const from = Math.min(a.point, ...idx);
        const to = Math.max(a.point, ...idx);
        for (let i = from; i <= to; i++) next.add(key(t.line, i));
      }
    } else next = new Set(items);
    setSelected(next);
    anchor.current = {
      line: t.line,
      point: t.kind === 'point' ? t.point : t.near,
    };
  };

  /** The points inside a box drawn on the graph. */
  const pointsIn = (b: { x0: number; y0: number; x1: number; y1: number }): Set<string> => {
    const xa = Math.max(Math.min(b.x0, b.x1), LEFT);
    const xb = Math.min(Math.max(b.x0, b.x1), W - RIGHT);
    const ya = Math.min(b.y0, b.y1);
    const yb = Math.max(b.y0, b.y1);
    const inside = new Set<string>();
    lines.forEach((l, j) =>
      l.points.forEach((p, i) => {
        const x = xOf(p.t);
        const y = yOfHz(p.hz);
        if (x >= xa && x <= xb && y >= ya && y <= yb) inside.add(key(j, i));
      })
    );
    return inside;
  };

  const capture = (e: ReactPointerEvent, freeze: boolean) => {
    e.stopPropagation();
    e.preventDefault();
    svg.current?.setPointerCapture(e.pointerId);
    if (freeze) setHeld(view);
    setDragging(true);
    setSaid('');
  };
  const pressOf = (e: ReactPointerEvent): Press => ({
    id: e.pointerId,
    sx: e.clientX,
    sy: e.clientY,
    moved: false,
  });

  /** Start moving points: the selection when what was pressed is in it, or else what was pressed. */
  const startMove = (e: ReactPointerEvent, t: Target, clickTo: Set<string> | null = null) => {
    const p = at(e);
    const items = itemsOf(t, false);
    const inSel = items.some((k) => selected.has(k));
    let keys: Set<string>;
    let single: { line: number; point: number } | null = null;
    if (inSel && selected.size > 1) keys = new Set(selected);
    else {
      keys = new Set(items);
      if (t.kind === 'point') single = { line: t.line, point: t.point };
      setSelected(keys);
    }
    // What was pressed is what a Shift-click counts from next, whether it was selected already or not.
    if (t.kind !== 'bg') anchor.current = { line: t.line, point: t.kind === 'point' ? t.point : t.near };
    capture(e, true);
    grabbing.current = {
      ...pressOf(e),
      kind: 'move',
      before: copyLines(lines),
      keys,
      from: { ms: p.raw, y: p.y },
      single,
      clickTo,
      keep: false,
    };
  };

  /** A press on the graph, sent on by what it landed on and the tool in hand. */
  const press = (e: ReactPointerEvent, t: Target) => {
    if (e.button !== 0) return;
    // A press never moves the keyboard onto a point, or a ring is left on one that may not even be selected.
    e.preventDefault();
    setMenu(null);
    const mods = modsOf(e);
    const p = at(e);
    if (tool === 'grab') {
      if (t.kind === 'bg') {
        capture(e, false);
        grabbing.current = {
          ...pressOf(e),
          kind: 'pan',
          fromX: p.x,
          orig: view,
        };
      } else startMove(e, t);
      return;
    }
    if (tool === 'select') {
      if (t.kind === 'bg') {
        // Empty space draws a box, as in most programs; a click there clears the selection.
        capture(e, false);
        grabbing.current = {
          ...pressOf(e),
          kind: 'box',
          erase: false,
          from: { x: p.x, y: p.y },
          target: t,
          mods,
        };
        return;
      }
      if (mods.ctrl || mods.shift || mods.alt) {
        e.stopPropagation();
        selectClick(t, mods);
        return;
      }
      // A click on what is already selected narrows the selection to it; a drag moves the lot.
      const items = itemsOf(t, false);
      startMove(e, t, items.every((k) => selected.has(k)) ? new Set(items) : null);
      return;
    }
    if (tool === 'box' || tool === 'erase') {
      capture(e, false);
      grabbing.current = {
        ...pressOf(e),
        kind: 'box',
        erase: tool === 'erase',
        from: { x: p.x, y: p.y },
        target: t,
        mods,
      };
      return;
    }
    if (tool === 'line') {
      if (lines.length >= SHAPE_LIMITS.lines) {
        e.stopPropagation();
        setSaid(`A sound can have ${SHAPE_LIMITS.lines} lines at most.`);
        return;
      }
      const start = { t: p.ms, hz: p.hz };
      const wave = (targetLines[0] !== undefined ? lines[targetLines[0]]?.wave : undefined) ?? 'sine';
      const next = [...copyLines(lines), { wave, gain: 1, points: [start, { ...start }] }];
      capture(e, true);
      grabbing.current = {
        ...pressOf(e),
        kind: 'new',
        before: copyLines(lines),
        line: next.length - 1,
        start,
      };
      setLines(next);
      setSelected(new Set([key(next.length - 1, 0), key(next.length - 1, 1)]));
      return;
    }
    // New point: a point pressed is moved; a line not selected is selected; the selected line, or space beside it, gets a point.
    let target = t;
    if (target.kind === 'bg') {
      const near = nearPoint(e);
      if (near) target = { kind: 'point', ...near };
    }
    if (target.kind === 'point') {
      startMove(e, target);
      return;
    }
    if (target.kind === 'line' && !pickedLines.includes(target.line)) {
      e.stopPropagation();
      selectClick(target, { ctrl: false, shift: false, alt: false });
      return;
    }
    const l =
      target.kind === 'line'
        ? target.line
        : targetLines.length === 1
          ? targetLines[0]!
          : anchor.current && lines[anchor.current.line] && pickedLines.includes(anchor.current.line)
            ? anchor.current.line
            : null;
    if (l === null) {
      e.stopPropagation();
      setSaid(lines.length ? 'Select a line first, by clicking it, then click again to add points to it.' : 'Draw a line first, with New line.');
      return;
    }
    if (lines[l]!.points.length >= SHAPE_LIMITS.points) {
      e.stopPropagation();
      setSaid(`A line can have ${SHAPE_LIMITS.points} points at most.`);
      return;
    }
    const before = copyLines(lines);
    const next = copyLines(lines);
    // On the line, it goes exactly on it, so adding a point does not bend it; beside it, where the pointer is.
    const i = insertAt(next[l]!, {
      t: p.ms,
      hz: target.kind === 'line' ? hzAt(lines[l]!, p.ms) : p.hz,
      ...loudnessAt(lines[l]!, p.ms),
    });
    capture(e, true);
    grabbing.current = {
      ...pressOf(e),
      kind: 'move',
      before,
      keys: new Set([key(l, i)]),
      from: { ms: p.raw, y: p.y },
      single: { line: l, point: i },
      clickTo: null,
      keep: true,
    };
    setLines(next);
    setSelected(new Set([key(l, i)]));
    anchor.current = { line: l, point: i };
  };

  /** The window on the strip at the foot: dragged to scroll, by an end to zoom; a press elsewhere on the strip moves it there. */
  const downOnView = (mode: 'pan' | 'left' | 'right' | 'jump') => (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    setMenu(null);
    e.stopPropagation();
    e.preventDefault();
    svg.current?.setPointerCapture(e.pointerId);
    const p = at(e);
    let orig = view;
    if (mode === 'jump') {
      const ms = ((p.x - LEFT) / PLOT_W) * extent;
      orig = clampView({ start: ms - view.len / 2, len: view.len }, extent) ?? { start: 0, len: extent };
      setZoom(orig.len >= extent ? null : orig);
    }
    grabbing.current = {
      ...pressOf(e),
      kind: 'view',
      mode: mode === 'jump' ? 'pan' : mode,
      fromX: p.x,
      orig,
    };
  };

  /** The lines as they are with points being moved to here. */
  const movedLines = (g: MoveGrab, e: At): SoundLine[] => {
    const p = at(e);
    if (g.single) {
      const next = copyLines(g.before);
      const target = next[g.single.line]!;
      const room = pointRoom(target, g.single.point);
      target.points[g.single.point] = {
        ...target.points[g.single.point]!,
        t: clamp(p.ms, room.lo, room.hi),
        hz: p.hz,
      };
      return next;
    }
    const dt = Math.round((p.raw - g.from.ms) / p.step) * p.step;
    return shifted(g.before, g.keys, dt, hzOfY(p.y) / hzOfY(g.from.y), notes);
  };

  const newLines = (g: NewGrab, e: At): SoundLine[] => {
    const p = at(e);
    const next = copyLines(lines);
    const end = { t: p.ms, hz: p.hz };
    next[g.line]!.points = end.t >= g.start.t ? [{ ...g.start }, end] : [end, { ...g.start }];
    return next;
  };

  const move = (e: ReactPointerEvent) => {
    const g = grabbing.current;
    if (!g || g.id !== e.pointerId) return;
    if (!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < CLICK_PX) return;
    g.moved = true;
    if (g.kind === 'pan') {
      const d = ((at(e).x - g.fromX) / PLOT_W) * g.orig.len;
      setZoom(clampView({ start: g.orig.start - d, len: g.orig.len }, extent));
    } else if (g.kind === 'view') {
      const d = ((at(e).x - g.fromX) / PLOT_W) * extent;
      const o = g.orig;
      const next =
        g.mode === 'pan'
          ? { start: o.start + d, len: o.len }
          : g.mode === 'left'
            ? {
                start: Math.min(o.start + d, o.start + o.len - MIN_VIEW),
                len: Math.max(MIN_VIEW, o.len - d),
              }
            : { start: o.start, len: o.len + d };
      setZoom(clampView(next, extent));
    } else if (g.kind === 'move') setLines(movedLines(g, e));
    else if (g.kind === 'new') setLines(newLines(g, e));
    else {
      const p = at(e);
      setBox({ x0: g.from.x, y0: g.from.y, x1: p.x, y1: p.y, erase: g.erase });
    }
  };

  const up = (e: ReactPointerEvent) => {
    const g = grabbing.current;
    if (!g || g.id !== e.pointerId) return;
    grabbing.current = null;
    setHeld(null);
    setBox(null);
    setDragging(false);
    if (g.kind === 'pan') {
      if (!g.moved) setSelected(new Set());
      return;
    }
    if (g.kind === 'view') return;
    if (g.kind === 'move') {
      if (!g.moved) {
        if (g.keep) commit(lines, {}, true, g.before);
        else if (g.clickTo) setSelected(g.clickTo);
        return;
      }
      commit(movedLines(g, e), {}, true, g.before);
      return;
    }
    if (g.kind === 'new') {
      let next = g.moved ? newLines(g, e) : copyLines(lines);
      const pts = next[g.line]!.points;
      if (pts[1]!.t - pts[0]!.t < 5) {
        // A click with no drag makes a short flat line, sized to what is in view.
        const len = Math.round(clamp(view.len / 5, 5, 80));
        const t = Math.min(pts[0]!.t, SHAPE_LIMITS.ms - len);
        next[g.line]!.points = [
          { t, hz: pts[0]!.hz },
          { t: t + len, hz: pts[0]!.hz },
        ];
      }
      next = next.filter((l) => l.points.length >= 2);
      commit(next, {}, true, g.before);
      const n = next.length - 1;
      setSelected(new Set(next[n]!.points.map((_, i) => key(n, i))));
      anchor.current = { line: n, point: 1 };
      return;
    }
    // A box: selecting or erasing what is in it, or, as a click, what was clicked.
    if (!g.moved) {
      if (!g.erase) {
        selectClick(g.target, g.mods);
        return;
      }
      if (g.target.kind === 'bg') return;
      commit(withoutPoints(lines, new Set(itemsOf(g.target, g.mods.alt))), {}, false);
      setSelected(new Set());
      return;
    }
    const p = at(e);
    const inside = pointsIn({ x0: g.from.x, y0: g.from.y, x1: p.x, y1: p.y });
    if (g.erase) {
      if (inside.size) commit(withoutPoints(lines, inside), {}, false);
      setSelected(new Set());
      return;
    }
    if (!g.mods.ctrl && !g.mods.shift) {
      setSelected(inside);
      return;
    }
    const next = new Set([...selected, ...inside]);
    if (g.mods.shift) {
      // Every point between, on each line the box touched.
      const touched = new Set([...inside].map((k) => unkey(k)[0]));
      for (const l of touched) {
        const idx = [...next]
          .map(unkey)
          .filter(([j]) => j === l)
          .map(([, i]) => i);
        for (let i = Math.min(...idx); i <= Math.max(...idx); i++) next.add(key(l, i));
      }
    }
    setSelected(next);
  };

  // What the menu and the keys do.
  const fragments = (): SoundLine[] =>
    lines.flatMap((l, j) => {
      const pts = l.points.filter((_, i) => selected.has(key(j, i)));
      return pts.length >= 2 ? [{ wave: l.wave, gain: l.gain, points: pts.map((q) => ({ ...q })) }] : [];
    });
  const canCopy = fragments().length > 0;

  /** Lines added as new ones, selected: at a moment when one is given, or else a little after where they were, in view. */
  const place = (frags: SoundLine[], atMs?: number) => {
    if (!frags.length) return;
    const room = SHAPE_LIMITS.lines - lines.length;
    if (room <= 0) {
      setSaid(`A sound can have ${SHAPE_LIMITS.lines} lines at most.`);
      return;
    }
    const minT = Math.min(...frags.map((f) => f.points[0]!.t));
    const maxT = Math.max(...frags.map((f) => f.points[f.points.length - 1]!.t));
    let dt =
      atMs !== undefined
        ? atMs - minT
        : minT >= view.start && maxT <= view.start + view.len
          ? Math.max(5, Math.round(view.len / 20))
          : Math.round(view.start + view.len * 0.1 - minT);
    dt = clamp(dt, -minT, SHAPE_LIMITS.ms - maxT);
    const added = frags.slice(0, room).map((f) => ({
      ...f,
      points: f.points.map((q) => ({ ...q, t: q.t + dt })),
    }));
    commit([...copyLines(lines), ...added]);
    setSelected(new Set(added.flatMap((l, k) => l.points.map((_, i) => key(lines.length + k, i)))));
    setSaid(frags.length > room ? `Only ${room} of the ${frags.length} lines fitted: a sound can have ${SHAPE_LIMITS.lines}.` : '');
  };
  const copy = (): boolean => {
    const f = fragments();
    if (!f.length) {
      setSaid('Select a line, or at least two points of one, to copy.');
      return false;
    }
    writeClip(f);
    setHasClip(true);
    return true;
  };
  const remove = () => {
    if (!selected.size) return;
    commit(withoutPoints(lines, selected), {}, false);
    setSelected(new Set());
  };
  const cut = () => {
    if (copy()) remove();
  };
  const paste = (atMs?: number) => {
    const c = readClip();
    if (c) place(copyLines(c), atMs);
  };
  const duplicate = () => {
    const f = fragments();
    if (f.length) place(f);
    else setSaid('Select a line, or at least two points of one, to duplicate.');
  };
  const selectAll = () => setSelected(new Set(lines.flatMap((l, j) => l.points.map((_, i) => key(j, i)))));

  /** The arrow keys move what is selected: a semitone up or down (an octave with Shift), 5 ms sideways (50 with Shift). */
  const nudge = (dt: number, steps: number) => {
    if (selected.size) commit(shifted(lines, selected, dt, SEMITONE ** steps, false));
  };

  /*
   * The keys, heard by the window while the editor is open rather than only by
   * the dialog: a click on the graph or a menu item leaves the keyboard on the
   * page, and Ctrl+V there would otherwise be the screen's own paste, which
   * imports a blueprint. Heard first (capture) and stopped only when used, so a
   * number box still gets its typing.
   */
  const keyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (menu) setMenu(null);
      else onClose();
      return;
    }
    const target = e.target as HTMLElement | null;
    if (target?.closest?.('input, textarea, select')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const take = (fn: () => void) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    if (ctrl && k === 'z') take(e.shiftKey ? redo : undo);
    else if (ctrl && k === 'y') take(redo);
    else if (ctrl && k === 'c') take(() => void copy());
    else if (ctrl && k === 'x') take(cut);
    else if (ctrl && k === 'v') take(() => paste());
    else if (ctrl && k === 'd') take(duplicate);
    else if (ctrl && k === 'a') take(selectAll);
    else if (e.key === 'Delete' || e.key === 'Backspace') take(remove);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') take(() => nudge(0, (e.shiftKey ? 12 : 1) * (e.key === 'ArrowUp' ? 1 : -1)));
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') take(() => nudge((e.shiftKey ? 50 : 5) * (e.key === 'ArrowRight' ? 1 : -1), 0));
    else if (!ctrl && !e.altKey) {
      const t = TOOLS.find((x) => x.key.toLowerCase() === k);
      if (t) take(() => setTool(t.id));
    }
  };

  const keys = useRef(keyDown);
  keys.current = keyDown;
  useEffect(() => {
    const heard = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', heard, true);
    return () => window.removeEventListener('keydown', heard, true);
  }, []);

  /** The right click menu: on a line or a point not selected, that is selected first, as in a file manager. */
  const openMenu = (e: ReactMouseEvent, t: Target) => {
    e.preventDefault();
    e.stopPropagation();
    if (grabbing.current) return;
    if (t.kind !== 'bg') {
      const items = itemsOf(t, e.altKey);
      if (!items.some((k) => selected.has(k))) {
        setSelected(new Set(items));
        anchor.current = {
          line: t.line,
          point: t.kind === 'point' ? t.point : t.near,
        };
      }
    }
    setMenu({
      x: e.clientX,
      y: e.clientY,
      ms: at(e).ms,
      onBg: t.kind === 'bg',
      line: t.kind === 'bg' ? null : t.line,
    });
  };

  const setLinesTo = (patch: Partial<SoundLine>, hear = true) => {
    if (!targetLines.length) return;
    const next = copyLines(lines);
    for (const l of targetLines) next[l] = { ...next[l]!, ...patch };
    commit(next, {}, hear, slideFrom.current ?? lines);
    slideFrom.current = null;
  };

  const setPoint = (patch: Partial<SoundPoint>) => {
    if (!onlyPoint) return;
    const [l, i] = onlyPoint;
    const next = copyLines(lines);
    const target = next[l]!;
    const room = pointRoom(target, i);
    const cur = target.points[i]!;
    target.points[i] = {
      ...cur,
      t: Math.round(clamp(patch.t ?? cur.t, room.lo, room.hi)),
      hz: Math.round(clamp(patch.hz ?? cur.hz, 20, 12_000)),
    };
    commit(next);
  };

  /** How loud the selected points are, 0 to 1: the line is that loud there, and in between it moves straight from point to point. */
  const setPointLoudness = (v: number, write: boolean) => {
    if (!slideFrom.current) slideFrom.current = copyLines(lines);
    const next = copyLines(lines);
    for (const k of selected) {
      const [l, i] = unkey(k);
      const q = next[l]?.points[i];
      if (!q) continue;
      if (v >= 1) delete q.v;
      else q.v = Math.round(v * 100) / 100;
    }
    if (write) {
      commit(next, {}, true, slideFrom.current);
      slideFrom.current = null;
    } else setLines(next);
  };

  /** Harmonics under every selected line, ×2 up to ×n, as new lines. */
  const [harmonics, setHarmonics] = useState(8);
  const addHarmonics = () => {
    const added = targetLines.flatMap((l) => harmonicsOf(lines[l]!, harmonics));
    const room = SHAPE_LIMITS.lines - lines.length;
    if (!added.length) {
      setSaid('No harmonics fit: they would go past 12 kHz.');
      return;
    }
    commit([...copyLines(lines), ...added.slice(0, room)]);
    setSaid(added.length > room ? `Only ${room} of ${added.length} harmonics fitted: a sound can have ${SHAPE_LIMITS.lines} lines.` : '');
  };

  /** An example in place of what is there; Ctrl+Z puts yours back. */
  const loadExample = (example: SoundLine[], name: string) => {
    commit(example, { fade: 10 });
    setSelected(new Set());
    setZoom(null);
    setSaid(`${name} is loaded. Ctrl+Z puts back what you had.`);
  };

  // The grid: octaves people know, and round times.
  const hzLines = [50, 100, 200, 500, 1000, 2000, 5000, 10_000];
  const tickStep = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000].find((s) => view.len / s <= 8) ?? 2500;
  const firstTick = Math.ceil(view.start / tickStep) * tickStep;
  const ticks = Array.from({ length: Math.floor((view.start + view.len - firstTick) / tickStep) + 1 }, (_, i) => firstTick + i * tickStep);
  const copies = Array.from({ length: times }, (_, k) => k * (total + gap)).filter((t) => t < view.start + view.len);
  const pointsOf = (pts: SoundPoint[], offset = 0) => pts.map((p) => `${xOf(p.t + offset)},${yOfHz(p.hz)}`).join(' ');
  // The strip at the foot: the whole sound, small.
  const ovX = (ms: number) => LEFT + (ms / extent) * PLOT_W;
  const ovY = (hz: number) => OV_TOP + 3 + (1 - Math.log(hz / LO_HZ) / Math.log(HI_HZ / LO_HZ)) * (OV_H - 6);
  const winX = ovX(view.start);
  const winW = Math.max(8, (view.len / extent) * PLOT_W);
  const toolSpec = TOOLS.find((t) => t.id === tool)!;

  const number = (k: string, label: string, value: number, min: number, max: number, unit: string, set: (n: number) => void) => (
    <label className="bp-shape-num" key={k}>
      <span className="meta">{label}</span>
      <NumInput value={value} onCommit={(n) => set(Math.round(clamp(n, min, max)))} />
      <span className="meta">{unit}</span>
    </label>
  );

  type MenuItem = { label: string; keys?: string; on: () => void; off?: boolean } | 'rule';
  const menuItems: MenuItem[] = menu
    ? [
        { label: 'Cut', keys: 'Ctrl+X', on: cut, off: !canCopy },
        { label: 'Copy', keys: 'Ctrl+C', on: () => void copy(), off: !canCopy },
        {
          label: menu.onBg ? 'Paste here' : 'Paste',
          keys: 'Ctrl+V',
          on: () => paste(menu.onBg ? menu.ms : undefined),
          off: !hasClip,
        },
        { label: 'Duplicate', keys: 'Ctrl+D', on: duplicate, off: !canCopy },
        { label: 'Delete', keys: 'Del', on: remove, off: !selected.size },
        'rule',
        ...(menu.line !== null && lines[menu.line]
          ? [
              {
                label: 'Select the whole line',
                on: () => setSelected(new Set(lines[menu.line!]!.points.map((_, i) => key(menu.line!, i)))),
              },
            ]
          : []),
        {
          label: 'Select all',
          keys: 'Ctrl+A',
          on: selectAll,
          off: !lines.length,
        },
        { label: 'Undo', keys: 'Ctrl+Z', on: undo, off: !past.current.length },
        {
          label: 'Redo',
          keys: 'Ctrl+Y',
          on: redo,
          off: !future.current.length,
        },
        'rule',
        { label: 'Example: "hello", whistled (3 formant lines)', on: () => loadExample(helloFormants(), 'The whistled "hello"') },
        { label: 'Example: "hello", voiced (a line per harmonic)', on: () => loadExample(helloVoiced(), 'The voiced "hello"') },
      ]
    : [];

  const iconButton = (id: Tool | 'undo' | 'redo' | 'more', label: string, on: (e: ReactMouseEvent<HTMLButtonElement>) => void, opts: { pressed?: boolean; off?: boolean } = {}) => (
    <button
      key={id}
      type="button"
      className={`bp-shape-tool${opts.pressed ? ' on' : ''}`}
      title={label}
      aria-label={label}
      aria-pressed={opts.pressed}
      disabled={opts.off}
      onClick={on}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        {ICON[id]}
      </svg>
    </button>
  );

  return createPortal(
    <div
      className="bp-tl-overlay"
      onPointerDownCapture={(e) => {
        if (menu && !(e.target as Element).closest('.bp-shape-menu')) setMenu(null);
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="bp-tl bp-shape card" role="dialog" aria-modal="true" aria-labelledby="bp-shape-title" tabIndex={-1} ref={dialog}>
        <div className="bp-tl-top">
          <h3 id="bp-shape-title">Make your own sound</h3>
          <button type="button" onClick={() => onHear({ ...draft, shape: text })}>
            ▶ Hear it
          </button>
          <button type="button" className="primary" onClick={onClose}>
            Done
          </button>
        </div>

        <div className="bp-shape-tools" role="toolbar" aria-label="Tools">
          {TOOLS.map((t) =>
            iconButton(t.id, `${t.label} (${t.key})`, () => setTool(t.id), {
              pressed: tool === t.id,
            })
          )}
          <span className="bp-shape-sep" aria-hidden="true" />
          {iconButton('undo', 'Undo (Ctrl+Z)', undo, {
            off: past.current.length === 0,
          })}
          {iconButton('redo', 'Redo (Ctrl+Y)', redo, {
            off: future.current.length === 0,
          })}
          {iconButton('more', 'Cut, copy, paste and more (or right click)', (e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({
              x: r.left,
              y: r.bottom + 4,
              ms: view.start + view.len / 2,
              onBg: false,
              line: null,
            });
          })}
          <label className="bp-shape-check">
            <input type="checkbox" checked={notes} onChange={(e) => setNotes(e.target.checked)} /> Snap to notes
          </label>
          <span className="bp-shape-zoom" role="group" aria-label="Zoom">
            <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => zoomBy(2)} disabled={view.len >= extent}>
              −
            </button>
            <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => zoomBy(0.5, point ? point.t : undefined)} disabled={view.len <= MIN_VIEW}>
              ＋
            </button>
            <button type="button" onClick={() => setZoom(null)} disabled={view.len >= extent}>
              All of it
            </button>
            <span className="meta">{view.len >= extent ? msLabel(extent) : `${msLabel(view.start)} – ${msLabel(view.start + view.len)}`}</span>
          </span>
        </div>
        <p className="bp-shape-status" aria-live="polite">
          <span className="bp-shape-status-tool">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              {ICON[tool]}
            </svg>
            {toolSpec.label}
          </span>
          <span className="meta">
            {toolSpec.hint}
            {selected.size > 0 && ` · ${selected.size === 1 ? '1 point' : `${selected.size} points`} selected`}
          </span>
        </p>

        <svg
          ref={svg}
          className={`bp-shape-graph tool-${tool}${dragging ? ' dragging' : ''}`}
          viewBox={`0 0 ${W} ${H}`}
          role="group"
          aria-label="The sound, as a graph"
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onContextMenu={(e) => e.preventDefault()}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={LEFT - 8} y={0} width={PLOT_W + 16} height={OV_TOP - 4} />
            </clipPath>
          </defs>
          {/* Pitch lane */}
          <rect
            className="bp-shape-lane hit"
            x={LEFT}
            y={PITCH_TOP}
            width={PLOT_W}
            height={PITCH_H}
            onPointerDown={(e) => press(e, { kind: 'bg' })}
            onContextMenu={(e) => openMenu(e, { kind: 'bg' })}
          />
          {hzLines.map((hz) => (
            <g key={hz} pointerEvents="none">
              <line className="bp-shape-grid" x1={LEFT} x2={W - RIGHT} y1={yOfHz(hz)} y2={yOfHz(hz)} />
              <text className="bp-shape-axis" x={LEFT - 6} y={yOfHz(hz)} textAnchor="end" dominantBaseline="middle">
                {hz >= 1000 ? `${hz / 1000}k` : hz}
              </text>
            </g>
          ))}
          <text className="bp-shape-axis" x={8} y={PITCH_TOP + PITCH_H / 2} dominantBaseline="middle" transform={`rotate(-90 8 ${PITCH_TOP + PITCH_H / 2})`} textAnchor="middle">
            pitch (Hz)
          </text>
          {lines.length === 0 && (
            <text className="bp-shape-axis" x={LEFT + PLOT_W / 2} y={PITCH_TOP + PITCH_H / 2} textAnchor="middle" pointerEvents="none">
              Pick New line and drag to draw one
            </text>
          )}
          <g clipPath={`url(#${clipId})`}>
            {/* Repeats, faintly, after the sound */}
            {copies
              .slice(1)
              .map((offset, k) =>
                lines.map((l, j) => <polyline key={`${k}-${j}`} className={`bp-shape-line c${j % COLOURS} ghost`} points={pointsOf(l.points, offset)} pointerEvents="none" />)
              )}
            {/* Lines with something selected last, so they are drawn on top and caught first */}
            {lines
              .map((l, j) => ({ l, j }))
              .sort((a, b) => Number(pickedLines.includes(a.j)) - Number(pickedLines.includes(b.j)))
              .map(({ l, j }) => (
                <g key={j} className={`bp-shape-linegroup${pickedLines.includes(j) ? ' picked' : ''}`}>
                  <polyline
                    className="bp-shape-hit"
                    points={pointsOf(l.points)}
                    onPointerDown={(e) => press(e, lineTarget(j, e))}
                    onContextMenu={(e) => openMenu(e, lineTarget(j, e))}
                  >
                    <title>Line {j + 1}</title>
                  </polyline>
                  <polyline className={`bp-shape-line c${j % COLOURS}`} points={pointsOf(l.points)} pointerEvents="none" />
                  {/* Selected segments: both ends selected */}
                  {l.points
                    .slice(0, -1)
                    .map((p, i) =>
                      selected.has(key(j, i)) && selected.has(key(j, i + 1)) ? (
                        <polyline key={`s${i}`} className={`bp-shape-line c${j % COLOURS} sel`} points={pointsOf([p, l.points[i + 1]!])} pointerEvents="none" />
                      ) : null
                    )}
                  {l.points.map((p, i) => (
                    <g key={i}>
                      <circle
                        className={`bp-shape-point c${j % COLOURS}${selected.has(key(j, i)) ? ' picked' : ''}`}
                        cx={xOf(p.t)}
                        cy={yOfHz(p.hz)}
                        r={selected.has(key(j, i)) ? 7 : 5.5}
                        // A quiet point is drawn faint, so where a line swells and fades shows.
                        fillOpacity={0.25 + 0.75 * (p.v ?? 1)}
                        pointerEvents="none"
                      />
                      {/* What a point is caught by: a ring well wider than the dot. */}
                      <circle
                        className="bp-shape-grip"
                        cx={xOf(p.t)}
                        cy={yOfHz(p.hz)}
                        r={13}
                        tabIndex={0}
                        role="button"
                        aria-label={`Line ${j + 1}, point ${i + 1}: ${p.t} ms, ${p.hz} Hz`}
                        onPointerDown={(e) => press(e, { kind: 'point', line: j, point: i })}
                        onContextMenu={(e) => openMenu(e, { kind: 'point', line: j, point: i })}
                        onFocus={() => {
                          if (!selected.has(key(j, i)) && !grabbing.current) setSelected(new Set([key(j, i)]));
                        }}
                      >
                        <title>
                          {p.t} ms, {p.hz} Hz ({noteName(p.hz)})
                        </title>
                      </circle>
                    </g>
                  ))}
                </g>
              ))}
          </g>
          {box && (
            <rect
              className={`bp-shape-box${box.erase ? ' erase' : ''}`}
              x={Math.min(box.x0, box.x1)}
              y={Math.min(box.y0, box.y1)}
              width={Math.abs(box.x1 - box.x0)}
              height={Math.abs(box.y1 - box.y0)}
              pointerEvents="none"
            />
          )}

          {/* The sound lane: every line mixed, as the PC plays it */}
          <rect className="bp-shape-lane" x={LEFT} y={AMP_TOP} width={PLOT_W} height={AMP_H} onPointerDown={() => setSelected(new Set())} />
          <line className="bp-shape-grid" x1={LEFT} x2={W - RIGHT} y1={AMP_TOP + AMP_H / 2} y2={AMP_TOP + AMP_H / 2} pointerEvents="none" />
          <text className="bp-shape-axis" x={8} y={AMP_TOP + AMP_H / 2} dominantBaseline="middle" transform={`rotate(-90 8 ${AMP_TOP + AMP_H / 2})`} textAnchor="middle">
            sound
          </text>
          <path className="bp-shape-wave" pointerEvents="none" d={wavePath} />

          {ticks.map((t) => (
            <text key={t} className="bp-shape-axis" x={xOf(t)} y={TICKS_Y} textAnchor="middle" pointerEvents="none">
              {t >= 1000 ? `${t / 1000}s` : `${t}ms`}
            </text>
          ))}

          {/* The whole sound, small, with the window on it that the graph shows */}
          <rect className="bp-shape-lane bp-shape-overview" x={LEFT} y={OV_TOP} width={PLOT_W} height={OV_H} onPointerDown={downOnView('jump')} />
          {copies.map((offset, k) =>
            lines.map((l, j) => (
              <polyline
                key={`${k}-${j}`}
                className={`bp-shape-line c${j % COLOURS}${k > 0 ? ' ghost' : ''}`}
                points={l.points.map((p) => `${ovX(p.t + offset)},${ovY(p.hz)}`).join(' ')}
                pointerEvents="none"
              />
            ))
          )}
          {view.len < extent && (
            <g>
              <rect className="bp-shape-window" x={winX} y={OV_TOP} width={winW} height={OV_H} onPointerDown={downOnView('pan')}>
                <title>Drag to scroll; drag an end to zoom</title>
              </rect>
              <rect className="bp-shape-window-end" x={winX - 4} y={OV_TOP} width={8} height={OV_H} onPointerDown={downOnView('left')} />
              <rect className="bp-shape-window-end" x={winX + winW - 4} y={OV_TOP} width={8} height={OV_H} onPointerDown={downOnView('right')} />
            </g>
          )}
        </svg>

        {menu && (
          <div
            className="bp-shape-menu"
            role="menu"
            style={{
              left: clamp(menu.x, 8, window.innerWidth - 228),
              top: clamp(menu.y, 8, window.innerHeight - 340),
            }}
          >
            {menuItems.map((m, i) =>
              m === 'rule' ? (
                <hr key={i} />
              ) : (
                <button
                  key={m.label}
                  type="button"
                  role="menuitem"
                  disabled={m.off}
                  onClick={() => {
                    setMenu(null);
                    m.on();
                  }}
                >
                  <span>{m.label}</span>
                  {m.keys && <span className="meta">{m.keys}</span>}
                </button>
              )
            )}
          </div>
        )}

        {said && <p className="bp-note warn">{said}</p>}

        <div className="bp-shape-waves" role="group" aria-label="Wave">
          <span className={`bp-shape-swatch c${(targetLines[0] ?? 0) % COLOURS}`} aria-hidden="true" />
          <span className="meta">
            {targetLines.length === 0 ? 'Select a line to change its wave' : targetLines.length === 1 ? `Line ${targetLines[0]! + 1}:` : `${targetLines.length} lines:`}
          </span>
          {WAVES.map((w) => {
            const on = targetLines.length > 0 && targetLines.every((l) => lines[l]!.wave === w.id);
            return (
              <button key={w.id} type="button" disabled={!targetLines.length} className={on ? 'primary' : ''} aria-pressed={on} onClick={() => setLinesTo({ wave: w.id })}>
                <svg viewBox="0 0 48 20" aria-hidden="true">
                  <path d={Array.from({ length: 97 }, (_, i) => `${i ? 'L' : 'M'}${i / 2} ${10 - waveAt(w.id, (i / 96) * 2 * Math.PI * 2) * 8}`).join('')} />
                </svg>
                {w.label}
              </button>
            );
          })}
          {targetLines.length > 0 && (
            <LoudnessSlider
              value={Math.round(lines[targetLines[0]!]!.gain * 100)}
              onSlide={(v) => {
                if (!slideFrom.current) slideFrom.current = copyLines(lines);
                setLines((cur) => cur.map((l, j) => (targetLines.includes(j) ? { ...l, gain: v / 100 } : l)));
              }}
              onLetGo={(v) => setLinesTo({ gain: v / 100 })}
            />
          )}
          {targetLines.length > 0 && (
            <span className="bp-shape-harmonics">
              <span className="meta">Harmonics up to ×</span>
              <NumInput value={harmonics} onCommit={(n) => setHarmonics(Math.round(clamp(n, 2, 32)))} />
              <button type="button" onClick={addHarmonics} title="Adds copies of the selected lines at 2, 3, 4… times their pitch, each quieter by its number">
                Add
              </button>
            </span>
          )}
        </div>
        {selected.size > 0 && (
          <div className="bp-shape-waves">
            <LoudnessSlider
              label="Loudness at the selected points"
              value={Math.round((lines[unkey([...selected][0]!)[0]]?.points[unkey([...selected][0]!)[1]]?.v ?? 1) * 100)}
              onSlide={(v) => setPointLoudness(v / 100, false)}
              onLetGo={(v) => setPointLoudness(v / 100, true)}
            />
          </div>
        )}

        <div className="bp-shape-nums">
          {point && number('t', 'Point at', point.t, 0, SHAPE_LIMITS.ms, 'ms', (n) => setPoint({ t: n }))}
          {point && number('hz', 'Pitch', point.hz, 20, 12_000, `Hz (${noteName(point.hz)})`, (n) => setPoint({ hz: n }))}
          {number('fade', 'Fade', Math.round(Number(draft.fade ?? 5)), 0, 500, 'ms', (n) => commitFields({ fade: n }))}
          {number('volume', 'Volume', Math.round(volume * 100), 0, 100, '%', (n) => commitFields({ volume: n }))}
          {number('times', 'Times', times, 1, 20, '', (n) => commitFields({ times: n }))}
          {times > 1 && number('gap', 'Gap', Math.round(gap), 0, 2000, 'ms', (n) => commitFields({ gap: n }))}
        </div>
        <p className="meta">
          Right click a line or a selection for cut, copy, paste, duplicate and delete, or use Ctrl+X, C, V and D and Delete; Ctrl+Z undoes and Ctrl+Y redoes. The arrow keys move
          what is selected, a semitone or 5 ms (Shift for an octave or 50 ms). The wheel scrolls; Ctrl and the wheel zooms. Alt moves to the millisecond. Letting go plays it.
        </p>
      </div>
    </div>,
    document.body
  );
}

/** A line's loudness: a slider, drawn live and written when let go. */
function LoudnessSlider({ value, onSlide, onLetGo, label }: { value: number; onSlide: (v: number) => void; onLetGo: (v: number) => void; label?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label className="bp-slider bp-shape-gain">
      <span className="meta">{label ?? 'Loudness'}</span>
      <input
        type="range"
        min={0}
        max={100}
        value={draft}
        aria-label={label ?? 'Loudness of the selected lines'}
        onChange={(e) => {
          setDraft(Number(e.target.value));
          onSlide(Number(e.target.value));
        }}
        onPointerUp={() => onLetGo(draft)}
        onKeyUp={() => onLetGo(draft)}
      />
      <span className="meta">{draft}%</span>
    </label>
  );
}

/** A number typed as text and taken when you leave the box or press Enter, so typing 150 does not stop at 1. */
function NumInput({ value, onCommit }: { value: number; onCommit: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  const typing = useRef(false);
  useEffect(() => {
    if (!typing.current) setText(String(value));
  }, [value]);
  const take = () => {
    typing.current = false;
    const n = Number(text);
    if (text.trim() !== '' && Number.isFinite(n)) onCommit(n);
    else setText(String(value));
  };
  return (
    <input
      inputMode="decimal"
      value={text}
      onFocus={() => (typing.current = true)}
      onChange={(e) => setText(e.target.value.replace(/[^\d.]/g, ''))}
      onBlur={take}
      onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
    />
  );
}
