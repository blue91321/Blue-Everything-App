/**
 * A blueprint drawn as a picture, for Share: the boxes where they sit on the
 * board, each with its kind's colour, its name and what its fields are set to,
 * and the wires between them. Drawn on a canvas by hand, with the board's own
 * geometry (`outAt`, `inAt`), so the wires land on the same pins they do on
 * screen. Always on a dark background, so a shared picture looks the same
 * whoever made it.
 */
import { fieldShown, inputsOf, KIND_LABEL, outputsOf, specOf, type FieldSpec, type NodeKind } from './catalogue';
import { HEAD, inAt, NODE_W, outAt, rowsOf, ROW } from './Canvas';
import type { Graph, GraphNode } from './engine';

const PAD = 48;
const TITLE = 76;
const FOOT = 40;
const LINE = 17;
/** No side of the picture past this, in pixels, however big the blueprint. */
const MAX_SIDE = 4096;

const COLOUR = {
  back: '#111318',
  dot: '#20242c',
  box: '#1b1e25',
  edge: '#2c313b',
  text: '#e8eaef',
  muted: '#8b90a0',
  run: '#8b90a0',
  answer: '#3a9e6e',
  number: '#2f8fb8',
};
const KIND: Record<NodeKind, string> = { event: '#c2413b', branch: '#5b6170', logic: '#7c5cc4', action: '' };

/** What a field is set to, in a few words, or null for nothing worth showing. */
function fieldText(f: FieldSpec, raw: unknown, habits: Map<string, string>): string | null {
  if (f.hidden || f.kind === 'color') return null;
  const value = raw ?? f.default;
  if (value === '' || value === null || value === undefined) return null;
  let shown: string;
  if (f.kind === 'choice') shown = f.options?.find((o) => o.id === value)?.label ?? String(value);
  else if (f.kind === 'habit') shown = habits.get(String(value)) ?? 'a habit';
  else if (f.kind === 'timeline') {
    try {
      const bars = JSON.parse(String(value)) as Array<{ keys?: string }>;
      shown = bars.map((b) => b.keys).filter(Boolean).join(', ') || 'nothing';
    } catch {
      shown = 'a timeline';
    }
  } else shown = String(value).split(/\r?\n/)[0]!;
  return f.label ? `${f.label}: ${shown}` : shown;
}

function linesOf(node: GraphNode, habits: Map<string, string>): string[] {
  const spec = specOf(node.type);
  if (!spec) return [];
  return spec.fields
    .filter((f) => fieldShown(f, node.fields))
    .map((f) => fieldText(f, node.fields[f.key], habits))
    .filter((t): t is string => !!t)
    .slice(0, 7);
}

const heightIn = (node: GraphNode, lines: number) => HEAD + rowsOf(node) * ROW + Math.max(1, lines) * LINE + 12;

function fit(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > width) s = s.slice(0, -1);
  return `${s}…`;
}

function wireKind(graph: Graph, from: string, pin: string, port?: string): string {
  if (!port) return COLOUR.run;
  const node = graph.nodes.find((n) => n.id === from);
  const out = node ? outputsOf(node).find((o) => o.id === pin) : undefined;
  return out?.number ? COLOUR.number : COLOUR.answer;
}

/** The blueprint as a PNG, plain: the blueprint itself is written in after (`withBlueprint`). */
export async function drawBlueprint(name: string, graph: Graph, opts: { accent: string; habits?: Map<string, string> }): Promise<Uint8Array> {
  const habits = opts.habits ?? new Map<string, string>();
  const lines = new Map(graph.nodes.map((n) => [n.id, linesOf(n, habits)]));
  const xs = graph.nodes.flatMap((n) => [n.x, n.x + NODE_W]);
  const ys = graph.nodes.flatMap((n) => [n.y, n.y + heightIn(n, lines.get(n.id)!.length)]);
  const left = (xs.length ? Math.min(...xs) : 0) - PAD;
  const top = (ys.length ? Math.min(...ys) : 0) - PAD;
  const width = Math.max(560, (xs.length ? Math.max(...xs) : 400) - left + PAD);
  const height = (ys.length ? Math.max(...ys) : 200) - top + PAD;
  const scale = Math.min(2, MAX_SIDE / width, MAX_SIDE / (height + TITLE + FOOT));

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round((height + TITLE + FOOT) * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot draw the picture.');
  ctx.scale(scale, scale);
  const font = (size: number, weight = 400) => `${weight} ${size}px system-ui, "Segoe UI", sans-serif`;

  ctx.fillStyle = COLOUR.back;
  ctx.fillRect(0, 0, width, height + TITLE + FOOT);
  ctx.fillStyle = opts.accent;
  ctx.fillRect(0, 0, width, 4);
  ctx.fillStyle = COLOUR.text;
  ctx.font = font(24, 700);
  ctx.textBaseline = 'middle';
  ctx.fillText(fit(ctx, name || 'A blueprint', width - PAD * 2), PAD / 2, TITLE / 2 - 4);
  ctx.fillStyle = COLOUR.muted;
  ctx.font = font(13);
  ctx.fillText(`${graph.nodes.length} box${graph.nodes.length === 1 ? '' : 'es'} · a Blue Everything blueprint`, PAD / 2, TITLE / 2 + 20);

  // The board, below the title, in its own coordinates.
  ctx.save();
  ctx.translate(-left, TITLE - top);
  ctx.fillStyle = COLOUR.dot;
  for (let x = Math.ceil(left / 24) * 24; x < left + width; x += 24) {
    for (let y = Math.ceil(top / 24) * 24; y < top + height; y += 24) ctx.fillRect(x, y, 1.5, 1.5);
  }

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  ctx.lineWidth = 2;
  for (const w of graph.wires) {
    const a = byId.get(w.from);
    const b = byId.get(w.to);
    if (!a || !b) continue;
    const p = outAt(a, w.pin);
    const q = inAt(b, w.port);
    const bend = Math.max(50, Math.abs(q.x - p.x) / 2);
    ctx.strokeStyle = wireKind(graph, w.from, w.pin, w.port);
    ctx.lineWidth = w.port ? 1.5 : 2.5;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.bezierCurveTo(p.x + bend, p.y, q.x - bend, q.y, q.x, q.y);
    ctx.stroke();
  }

  for (const node of graph.nodes) {
    const spec = specOf(node.type);
    if (!spec) continue;
    const mine = lines.get(node.id)!;
    const h = heightIn(node, mine.length);
    const kind = node.color || KIND[spec.kind] || opts.accent;
    ctx.fillStyle = COLOUR.box;
    ctx.strokeStyle = COLOUR.edge;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(node.x, node.y, NODE_W, h, 8);
    ctx.fill();
    ctx.stroke();
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(node.x, node.y, NODE_W, HEAD, [8, 8, 0, 0]);
    ctx.clip();
    ctx.fillStyle = kind;
    ctx.globalAlpha = 0.55;
    ctx.fillRect(node.x, node.y, NODE_W, HEAD);
    ctx.restore();
    ctx.fillStyle = COLOUR.text;
    ctx.font = font(10, 600);
    ctx.fillText(KIND_LABEL[spec.kind].toUpperCase(), node.x + 10, node.y + HEAD / 2);
    ctx.font = font(14, 600);
    const kindWidth = ctx.measureText(KIND_LABEL[spec.kind].toUpperCase()).width;
    ctx.fillText(fit(ctx, `${spec.glyph} ${spec.label}`, NODE_W - kindWidth - 30), node.x + 18 + kindWidth, node.y + HEAD / 2);

    // Its ways in on the left and out on the right, on the rows the board draws them on.
    const ins = inputsOf(node);
    const outs = outputsOf(node);
    const rows = rowsOf(node);
    ctx.font = font(12);
    for (let i = 0; i < rows; i++) {
      const y = node.y + HEAD + ROW / 2 + i * ROW;
      if (ins[i]) {
        ctx.fillStyle = COLOUR.muted;
        ctx.textAlign = 'left';
        ctx.fillText(fit(ctx, ins[i]!.label, NODE_W / 2 - 16), node.x + 12, y);
      }
      if (outs[i]) {
        ctx.fillStyle = COLOUR.text;
        ctx.textAlign = 'right';
        ctx.fillText(fit(ctx, outs[i]!.label || 'Then', NODE_W / 2 - 16), node.x + NODE_W - 12, y);
      }
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = COLOUR.muted;
    ctx.font = font(12);
    mine.forEach((text, i) => ctx.fillText(fit(ctx, text, NODE_W - 22), node.x + 11, node.y + HEAD + rows * ROW + 12 + i * LINE));

    // The pins themselves, so the wires visibly end on something.
    for (const o of rows === 0 ? [{ id: 'then', number: false, value: false }] : outs) {
      const p = outAt(node, o.id);
      ctx.fillStyle = o.number ? COLOUR.number : o.value ? COLOUR.answer : COLOUR.text;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    if (spec.kind !== 'event' && !spec.pure) {
      const p = inAt(node);
      ctx.fillStyle = COLOUR.text;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();

  ctx.fillStyle = COLOUR.muted;
  ctx.font = font(12);
  ctx.fillText('Open it in Blue Everything: Blueprints, Import, and pick this picture.', PAD / 2, TITLE + height + FOOT / 2);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('This browser cannot make the picture.');
  return new Uint8Array(await blob.arrayBuffer());
}
