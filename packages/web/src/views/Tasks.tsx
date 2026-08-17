import { useEffect, useState } from 'react';
import { api, type Task } from '../api';
import { useAsync } from '../useAsync';
import { toDateInputValue, toTimeInputValue } from '../format';
import { Capture } from './Capture';
import { TaskRow } from '../rows';
import { useSettling } from '../useSettling';
import { PushChoice } from '../controls';
import { featureEnabled } from '../features';

export function Tasks({ focus, onFocused }: { focus?: string | null; onFocused?: () => void } = {}) {
  const list = useAsync(() => api.tasks.list('todo,doing,done'), [], ['tasks']);
  const [editing, setEditing] = useState<Task | null>(null);
  const settling = useSettling();

  const all = list.data ?? [];

  /*
   * Arrived here from a right-click elsewhere. The list may not have loaded yet
   * — that is the ordinary case, since the screen mounts and fetches at the same
   * moment — so this waits for the row to exist rather than firing once on
   * mount and finding nothing.
   *
   * `onFocused` clears the request the instant it is honoured, or closing the
   * editor would reopen it on the next render.
   */
  useEffect(() => {
    if (!focus) return;
    const wanted = all.find((task) => task.id === focus);
    if (!wanted) return;
    setEditing(wanted);
    onFocused?.();
  }, [focus, all, onFocused]);
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
  // Date and time are separate fields so a time is genuinely optional. Most
  // things are due *on a day*, and being forced to invent an hour made every
  // task look more precise than it was.
  const [dueDate, setDueDate] = useState(task.dueAt ? toDateInputValue(task.dueAt) : '');
  const [dueTime, setDueTime] = useState(
    task.dueAt && !task.dueIsAllDay ? toTimeInputValue(task.dueAt) : ''
  );
  const [push, setPush] = useState<boolean | null>(task.pushToPhone === null ? null : Boolean(task.pushToPhone));

  // Fetched here rather than by the screen above, because the editor is what
  // needs it and it only exists while one row is open. The cost is a request per
  // edit, on a screen where opening an editor is already a deliberate act.
  const settings = useAsync(() => api.settings.get(), [], ['settings']);
  const pushDefault = settings.data?.pushDefault !== 0;
  // A server that predates the column sends nothing, and a control claiming to
  // set something the server will drop is worse than no control.
  const canChoosePush = featureEnabled('push') && settings.data?.pushDefault !== undefined;

  async function save() {
    const allDay = Boolean(dueDate) && !dueTime;
    // `new Date('2026-08-06T14:30')` is parsed as local wall time, which is what
    // "due at half two" means. A bare date is sent as local midnight and the
    // server moves it to end of day.
    const dueAt = dueDate ? new Date(`${dueDate}T${dueTime || '00:00'}`).getTime() : null;

    await api.tasks.update(task.id, {
      title: title.trim() || task.title,
      notes: notes.trim() || null,
      priority,
      dueAt,
      dueIsAllDay: allDay,
      ...(canChoosePush ? { pushToPhone: push } : {}),
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
        <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} aria-label="Due date" />
        <input
          type="time"
          value={dueTime}
          onChange={(e) => setDueTime(e.target.value)}
          aria-label="Due time (optional)"
          disabled={!dueDate}
          title={dueDate ? 'Optional' : 'Pick a date first'}
        />
        {dueDate && (
          <button
            className="btn subtle"
            type="button"
            onClick={() => {
              setDueDate('');
              setDueTime('');
            }}
          >
            clear
          </button>
        )}
      </div>
      <div className="meta" style={{ marginTop: 8 }}>
        {dueDate && !dueTime
          ? 'Due that day — it can nudge you any time from the morning.'
          : dueDate
            ? 'Due at that exact time.'
            : 'A time is optional; a date on its own is fine.'}
      </div>
      <div className="meta" style={{ marginTop: 4 }}>
        High and urgent tasks interrupt at any break; the rest wait for a proper stopping point.
      </div>

      {canChoosePush && (
        <div style={{ marginTop: 12 }}>
          <div className="title">Send this to my phone</div>
          <div className="meta" style={{ marginTop: 4, marginBottom: 8 }}>
            Only ever when you are away from the PC — never while you are sat in front of it. Saying no
            doesn't lose the reminder; it waits and shows up on screen when you come back.
          </div>
          <PushChoice value={push} fallback={pushDefault} onChange={setPush} />
        </div>
      )}
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
