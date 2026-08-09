import { useState } from 'react';
import { api, type Note } from '../api';
import { useAsync } from '../useAsync';
import { relative } from '../format';

export function Notes() {
  const list = useAsync(() => api.notes.list(), [], ['notes']);
  const [body, setBody] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = body.trim();
    if (!trimmed) return;
    await api.notes.create({ body: trimmed });
    setBody('');
    list.reload();
  }

  return (
    <>
      <section>
        <form onSubmit={add}>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Jot something down"
            aria-label="New note"
          />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn primary" type="submit" disabled={!body.trim()}>
              Save note
            </button>
          </div>
        </form>
      </section>

      <section>
        <h2>Notes</h2>
        {list.loading && <div className="empty">loading…</div>}
        {list.data?.length === 0 && <div className="empty">Nothing saved yet.</div>}
        {list.data?.map((note) =>
          openId === note.id ? (
            <NoteEditor key={note.id} note={note} onClose={() => setOpenId(null)} onSaved={list.reload} />
          ) : (
            <button
              key={note.id}
              className="card"
              style={{ display: 'block', width: '100%', textAlign: 'left' }}
              onClick={() => setOpenId(note.id)}
            >
              <div className="title" style={{ whiteSpace: 'pre-wrap' }}>
                {firstLines(note.body)}
              </div>
              <div className="meta">{relative(note.updatedAt)}</div>
            </button>
          )
        )}
      </section>
    </>
  );
}

/** Notes are freeform, so the list shows a peek rather than a title. */
function firstLines(body: string, max = 140): string {
  const trimmed = body.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed || '(empty)';
}

function NoteEditor({ note, onClose, onSaved }: { note: Note; onClose: () => void; onSaved: () => void }) {
  const [body, setBody] = useState(note.body);

  return (
    <div className="card">
      <textarea value={body} onChange={(e) => setBody(e.target.value)} style={{ minHeight: 160 }} aria-label="Note" />
      <div className="row" style={{ marginTop: 8 }}>
        <button
          className="btn primary"
          onClick={async () => {
            await api.notes.update(note.id, { body });
            onSaved();
            onClose();
          }}
        >
          Save
        </button>
        <button className="btn" onClick={onClose}>
          Close
        </button>
        <div className="grow" />
        <button
          className="btn subtle danger"
          onClick={async () => {
            await api.notes.remove(note.id);
            onSaved();
            onClose();
          }}
        >
          delete
        </button>
      </div>
    </div>
  );
}
