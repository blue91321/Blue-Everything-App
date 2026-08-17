/**
 * The last few notes, beside the Dashboard.
 *
 * Read-only on purpose. The Notes screen is where you write and edit; a panel
 * that also offered a text box would be a second place to create the same thing,
 * and the Dashboard already has one capture box at the top of it. What this
 * answers is "what did I write down earlier", which is a glancing question.
 *
 * Its own file rather than a mode of `Notes.tsx`, so choosing a different panel
 * means this code is never downloaded — the whole reason panels are lazy.
 */
import { api } from '../api';
import { useAsync } from '../useAsync';
import { relative } from '../format';

/** Enough to recognise a note by, and not enough to reflow the column. */
const HOW_MANY = 6;
const PREVIEW_CHARS = 120;

export default function NotesPanel() {
  const notes = useAsync(() => api.notes.list(), [], ['notes']);

  if (notes.loading) return <div className="empty">loading…</div>;
  if (notes.error) return <div className="empty">Could not load: {notes.error.message}</div>;

  const all = notes.data ?? [];
  /*
   * Pinned first, then most recently touched. The list endpoint already orders
   * them, but the panel takes a slice of it — so the ordering has to be
   * something this file is sure of rather than something it inherits, or a
   * change to the Notes screen's sort would silently decide which six of your
   * notes the Dashboard shows.
   */
  const shown = [...all]
    .sort((a, b) => b.pinned - a.pinned || b.updatedAt - a.updatedAt)
    .slice(0, HOW_MANY);

  return (
    <>
      <div className="row between" style={{ alignItems: 'baseline' }}>
        <h2 style={{ margin: 0 }}>Notes</h2>
        {all.length > shown.length && <span className="meta">{shown.length} of {all.length}</span>}
      </div>

      {shown.length === 0 && <div className="empty">Nothing written down yet.</div>}

      {shown.map((note) => {
        const body = note.body.trim();
        const clipped = body.length > PREVIEW_CHARS ? `${body.slice(0, PREVIEW_CHARS).trimEnd()}…` : body;

        return (
          <div className="card" key={note.id}>
            {note.title && <div className="title truncate">{note.title}</div>}
            {/* `pre-wrap` so a note written as three lines still reads as three
                lines. Without it a jotted list collapses into one run-on
                sentence, which is precisely the note you would fail to
                recognise. */}
            <div className="meta" style={{ whiteSpace: 'pre-wrap' }}>
              {clipped}
            </div>
            <div className="meta" style={{ opacity: 0.7, marginTop: 4 }}>
              {note.pinned ? '📌 ' : ''}
              {relative(note.updatedAt)}
            </div>
          </div>
        );
      })}
    </>
  );
}
