import { useState } from 'react';
import { api, type Task } from '../api';
import { useAsync } from '../useAsync';
import { toLocalInputValue } from '../format';
import { Capture } from './Capture';
import { TaskRow } from '../rows';
import { useSettling } from '../useSettling';

export function Tasks() {
  const list = useAsync(() => api.tasks.list('todo,doing,done'));
  const [editing, setEditing] = useState<Task | null>(null);
  const settling = useSettling();

  const all = list.data ?? [];
  const open = all.filter((t) => t.status !== 'done' || settling.has(t.id));
  const done = all.filter((t) => t.status === 'done' && !settling.has(t.id));

  const row = (task: Task) =>
    editing?.id === task.id ? (
      <TaskEditor key={task.id} task={task} onClose={() => setEditing(null)} onSaved={list.reload} />
    ) : (
      <div key={task.id} onDoubleClick={() => setEditing(task)}>
        <TaskRow task={task} onChange={list.reload} settling={settling} />
        <div className="row-actions">
          <button className="btn subtle" onClick={() => setEditing(task)}>
            edit
          </button>
        </div>
      </div>
    );

  return (
    <>
      <section>
        <Capture onAdded={list.reload} />
      </section>

      <section>
        <h2>Open</h2>
        {list.loading && <div className="empty">loading…</div>}
        {list.error && <div className="banner">{list.error.message}</div>}
        {open.length === 0 && !list.loading && <div className="empty">Nothing open.</div>}
        {open.map(row)}
      </section>

      {done.length > 0 && (
        <section className="done-area">
          <h2>Done</h2>
          {done.map(row)}
        </section>
      )}
    </>
  );
}

function TaskEditor({ task, onClose, onSaved }: { task: Task; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes ?? '');
  const [priority, setPriority] = useState(task.priority);
  const [due, setDue] = useState(task.dueAt ? toLocalInputValue(task.dueAt) : '');

  async function save() {
    await api.tasks.update(task.id, {
      title: title.trim() || task.title,
      notes: notes.trim() || null,
      priority,
      // datetime-local gives local wall time; Date parses it as local, which is
      // what's wanted — "due 3pm" means 3pm here.
      dueAt: due ? new Date(due).getTime() : null,
    });
    onSaved();
    onClose();
  }

  async function remove() {
    await api.tasks.remove(task.id);
    onSaved();
    onClose();
  }

  return (
    <div className="card">
      <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
      <div style={{ height: 8 }} />
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes" aria-label="Notes" />
      <div style={{ height: 8 }} />
      <div className="row">
        <select value={priority} onChange={(e) => setPriority(Number(e.target.value))} aria-label="Priority">
          <option value={0}>No priority</option>
          <option value={1}>Low</option>
          <option value={2}>High</option>
          <option value={3}>Urgent</option>
        </select>
        <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due" />
      </div>
      <div className="meta" style={{ marginTop: 8 }}>
        High and urgent tasks interrupt at any break; the rest wait for a proper stopping point.
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn primary" onClick={save}>
          Save
        </button>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <div className="grow" />
        <button className="btn subtle danger" onClick={remove}>
          delete
        </button>
      </div>
    </div>
  );
}
