/**
 * The notebook as dots and lines.
 *
 * Hand-drawn SVG like `Gauge.tsx` and the weather graph, for the same reason: a
 * graph library is the largest dependency this repo would have, to draw circles
 * and straight lines in a bundle that is otherwise almost entirely React.
 *
 * ### The layout is deterministic
 *
 * A force simulation seeded from `Math.random` rearranges itself every time the
 * tab is opened, so the picture you learned yesterday is a different picture
 * today — which is most of what a graph view is *for*. Starting positions come
 * from the note's own id, so the same notebook always draws the same shape.
 */
import { useMemo } from 'react';
import { api } from '../api';
import { useAsync } from '../useAsync';

const WIDTH = 900;
const HEIGHT = 560;

interface Placed {
  id: string;
  title: string;
  folder: string;
  degree: number;
  x: number;
  y: number;
}

export function NoteGraphView({ onOpen }: { onOpen: (id: string) => void }) {
  const graph = useAsync(() => api.notes.graph(), [], ['notes']);

  const placed = useMemo(() => layout(graph.data?.nodes ?? [], graph.data?.edges ?? []), [graph.data]);
  const byId = useMemo(() => new Map(placed.map((node) => [node.id, node])), [placed]);

  if (graph.loading) return <div className="empty">loading…</div>;
  if (!graph.data || graph.data.nodes.length === 0) {
    return <div className="empty">Nothing to draw yet — write a note or two and link them with [[brackets]].</div>;
  }

  const linked = placed.filter((node) => node.degree > 0).length;

  return (
    <div className="card">
      <div className="meta" style={{ marginBottom: 8 }}>
        {placed.length} {placed.length === 1 ? 'note' : 'notes'}, {graph.data.edges.length}{' '}
        {graph.data.edges.length === 1 ? 'link' : 'links'}
        {linked < placed.length ? ` · ${placed.length - linked} not linked to anything` : ''}
      </div>

      <div className="notes-graph">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          /*
           * `viewBox` plus a percentage width scales the *text* too, which the
           * weather graph deliberately avoids. Here it is right: a graph is a
           * shape you look at rather than a chart you read values off, and the
           * labels are identification rather than data.
           */
          width="100%"
          role="img"
          aria-label={`${placed.length} notes and ${graph.data.edges.length} links between them`}
        >
          {graph.data.edges.map((edge, i) => {
            const from = byId.get(edge.from);
            const to = byId.get(edge.to);
            if (!from || !to) return null;
            return (
              <line
                key={i}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                className="notes-graph-edge"
              />
            );
          })}

          {placed.map((node) => {
            // Between 5 and 16 — enough that a hub stands out, bounded so one
            // very connected note does not become a disc covering its
            // neighbours.
            const r = Math.min(16, 5 + node.degree * 1.6);
            return (
              <g key={node.id} className="notes-graph-node" onClick={() => onOpen(node.id)}>
                <title>
                  {node.title}
                  {node.folder ? ` — ${node.folder}` : ''}
                  {` · ${node.degree} ${node.degree === 1 ? 'link' : 'links'}`}
                </title>
                <circle cx={node.x} cy={node.y} r={r} className={node.degree === 0 ? 'lonely' : undefined} />
                {/* Only the connected ones are labelled. A notebook of two
                    hundred notes labelled everywhere is a grey rectangle. */}
                {node.degree > 0 && (
                  <text x={node.x} y={node.y + r + 11} textAnchor="middle">
                    {node.title.length > 22 ? `${node.title.slice(0, 22)}…` : node.title}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

/**
 * A few dozen rounds of push-and-pull, which is enough for a readable picture.
 *
 * Linked notes attract, every note repels every other, and everything is pulled
 * gently towards the middle so an unconnected note does not drift off the
 * canvas. Run to completion once rather than animated: this is a picture, and a
 * simulation running behind a tab is the sort of timer this project measures
 * before adding.
 */
function layout(
  nodes: { id: string; title: string; folder: string; degree: number }[],
  edges: { from: string; to: string }[]
): Placed[] {
  if (nodes.length === 0) return [];

  const placed: Placed[] = nodes.map((node) => {
    // Seeded from the id, so the same notebook always draws the same shape.
    const seed = [...node.id].reduce((total, char) => (total * 31 + char.charCodeAt(0)) >>> 0, 7);
    const angle = (seed % 3600) / 3600 * Math.PI * 2;
    const radius = 60 + ((seed >> 12) % 100) / 100 * (Math.min(WIDTH, HEIGHT) / 2 - 90);
    return {
      ...node,
      x: WIDTH / 2 + Math.cos(angle) * radius,
      y: HEIGHT / 2 + Math.sin(angle) * radius,
    };
  });

  const index = new Map(placed.map((node, i) => [node.id, i]));
  const links = edges
    .map((edge) => [index.get(edge.from), index.get(edge.to)])
    .filter((pair): pair is [number, number] => pair[0] !== undefined && pair[1] !== undefined);

  // 120 rounds over a few hundred notes is a handful of milliseconds, and the
  // shape has settled well before it.
  const rounds = nodes.length > 400 ? 40 : 120;

  for (let round = 0; round < rounds; round++) {
    // Cooling, so late rounds refine rather than keep throwing things about.
    const heat = 1 - round / rounds;

    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const dx = placed[j].x - placed[i].x;
        const dy = placed[j].y - placed[i].y;
        // A floor on the distance, or two notes that land on the same point
        // divide by zero and fly to infinity.
        const distance = Math.max(12, Math.hypot(dx, dy));
        const push = (900 / (distance * distance)) * heat * 12;
        const ux = (dx / distance) * push;
        const uy = (dy / distance) * push;
        placed[i].x -= ux;
        placed[i].y -= uy;
        placed[j].x += ux;
        placed[j].y += uy;
      }
    }

    for (const [a, b] of links) {
      const dx = placed[b].x - placed[a].x;
      const dy = placed[b].y - placed[a].y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const pull = (distance - 90) * 0.015 * heat;
      const ux = (dx / distance) * pull;
      const uy = (dy / distance) * pull;
      placed[a].x += ux;
      placed[a].y += uy;
      placed[b].x -= ux;
      placed[b].y -= uy;
    }

    for (const node of placed) {
      node.x += (WIDTH / 2 - node.x) * 0.004 * heat;
      node.y += (HEIGHT / 2 - node.y) * 0.004 * heat;
      // Clamped inside the canvas, since a note pushed off the edge is a note
      // you cannot click.
      node.x = Math.min(WIDTH - 24, Math.max(24, node.x));
      node.y = Math.min(HEIGHT - 24, Math.max(24, node.y));
    }
  }

  return placed;
}
