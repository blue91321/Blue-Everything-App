/**
 * The reading log's rows, as CSV — see `reading-log.ts`.
 *
 * In a file of its own with **no imports**, so `manga-check` can round-trip
 * it: a title with a comma or a quote in it is exactly the row a hand-rolled
 * CSV gets wrong, and this log is the record of what you have read.
 */

export const HEADER = 'at,series,chapter,state,sent,title';

export type LogRow = {
  at: number;
  seriesId: string;
  chapter: number;
  read: boolean;
  sent: boolean;
  title: string;
};

/** A field as CSV writes it: quoted only when it has to be. */
function field(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toLine(r: LogRow): string {
  return [
    new Date(r.at).toISOString(),
    r.seriesId,
    String(r.chapter),
    r.read ? 'read' : 'unread',
    r.sent ? 'yes' : 'no',
    field(r.title.replace(/[\r\n]+/g, ' ')),
  ].join(',');
}

/** One line back into a row, or null for anything that is not one. */
export function fromLine(line: string): LogRow | null {
  const cells: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let value = '';
      i += 1;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          value += '"';
          i += 2;
        } else if (line[i] === '"') {
          i += 1;
          break;
        } else {
          value += line[i];
          i += 1;
        }
      }
      cells.push(value);
      i += 1; // the comma after a quoted field
    } else {
      const end = line.indexOf(',', i);
      const stop = end === -1 ? line.length : end;
      cells.push(line.slice(i, stop));
      i = stop + 1;
    }
  }
  const [at, seriesId, chapter, state, sent, title = ''] = cells;
  const when = Date.parse(at ?? '');
  const number = Number(chapter);
  if (!Number.isFinite(when) || !seriesId || !Number.isFinite(number) || (state !== 'read' && state !== 'unread')) {
    return null;
  }
  return { at: when, seriesId, chapter: number, read: state === 'read', sent: sent === 'yes', title };
}
