/**
 * Where things go on the week card's time grid (2026-11-20). No imports, so
 * `calendar-check` asserts it.
 *
 * The rule that matters: **a block is never shorter than its text needs**. The
 * first sketch drew a block as tall as its event lasts, and a half-hour
 * lecture at 36px an hour was a sliver with its name cut off; a task due at
 * 11:59 pm, which lasts no time at all, was a line. So every block is at least
 * `minPx` tall, and that height, not the event's length, is what decides
 * whether two blocks overlap and have to share the day's width.
 *
 * And **a block is never narrower than its text needs**: at most `maxCols`
 * share a day's width, and a block that would be beyond them is marked
 * `hidden` for the screen to count as "+N" (six assignments due at 11:59 pm
 * side by side were six 20px slivers). Tasks are not drawn here at all on the
 * card; they have a row of their own above the hours.
 */

/** Minutes from the start of the day; `end` equal to `start` for a moment, such as a task falling due. */
export interface Span {
  id: string;
  start: number;
  end: number;
}

export interface Placed {
  id: string;
  /** From the top of the grid, in pixels. */
  top: number;
  height: number;
  /** Which of `cols` side-by-side columns it takes. */
  col: number;
  cols: number;
  /** Which run of overlapping blocks it is in, so the screen can say "+N" once per run. */
  cluster: number;
  /** Past `maxCols`: not drawn, counted. */
  hidden: boolean;
}

/**
 * The hours the grid shows: from the hour of the earliest start to the hour
 * after the latest end, at least `minHours` long (stretched later, then
 * earlier), 8 am to 8 pm with nothing on.
 */
export function hourRange(spans: Pick<Span, 'start' | 'end'>[], minHours = 10): { from: number; to: number } {
  if (!spans.length) return { from: 8, to: 20 };
  let from = Math.max(0, Math.floor(Math.min(...spans.map((s) => s.start)) / 60));
  let to = Math.min(24, Math.ceil(Math.max(...spans.map((s) => Math.max(s.end, s.start + 1))) / 60));
  while (to - from < minHours && to < 24) to++;
  while (to - from < minHours && from > 0) from--;
  return { from, to };
}

/** One day's spans as blocks: overlapping ones (by the height drawn) side by side, each as tall as its text needs. */
export function placeDay(spans: Span[], fromHour: number, pxPerHour: number, minPx: number, maxCols = Infinity): Placed[] {
  const px = pxPerHour / 60;
  const blocks = spans
    .map((s) => {
      const top = Math.max(0, (s.start - fromHour * 60) * px);
      return { id: s.id, top, bottom: Math.max(top + minPx, (s.end - fromHour * 60) * px) };
    })
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  const out: Placed[] = [];
  let cluster: { id: string; top: number; bottom: number; col: number }[] = [];
  let clusterBottom = -Infinity;
  let n = 0;
  const flush = () => {
    const cols = Math.min(Math.max(1, Math.floor(maxCols)), cluster.reduce((m, b) => Math.max(m, b.col + 1), 0));
    for (const b of cluster) out.push({ id: b.id, top: b.top, height: b.bottom - b.top, col: b.col, cols, cluster: n, hidden: b.col >= cols });
    cluster = [];
    n += 1;
  };
  for (const b of blocks) {
    if (cluster.length && b.top >= clusterBottom) flush();
    // The first column whose last block has ended by this one's top.
    const ends: number[] = [];
    for (const c of cluster) ends[c.col] = Math.max(ends[c.col] ?? -Infinity, c.bottom);
    let col = ends.findIndex((e) => e <= b.top);
    if (col === -1) col = ends.length;
    cluster.push({ ...b, col });
    clusterBottom = cluster.length === 1 ? b.bottom : Math.max(clusterBottom, b.bottom);
  }
  if (cluster.length) flush();
  return out;
}
