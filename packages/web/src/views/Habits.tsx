import { useState } from 'react';
import { api, type Habit } from '../api';
import { useAsync } from '../useAsync';

const formatInterval = (minutes: number): string =>
  minutes < 60 ? `${minutes}m` : minutes % 60 === 0 ? `${minutes / 60}h` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;

/**
 * The Habits tab is for *managing* habits — reorder, edit, delete, and correct
 * a mis-tap. Ticking one off day to day belongs on the Dashboard.
 */
export function Habits() {
  const list = useAsync(() => api.habits.list());
  const [name, setName] = useState('');
  const [cadence, setCadence] = useState<'daily' | 'weekly'>('daily');
  const [editingId, setEditingId] = useState<string | null>(null);

  const habits = (list.data ?? []).filter((h) => h.active);
  const archived = (list.data ?? []).filter((h) => !h.active);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    await api.habits.create({ name: trimmed, cadence });
    setName('');
    list.reload();
  }

  /** Swap with the neighbour and persist the whole order in one call. */
  async function move(index: number, delta: number) {
    const next = [...habits];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    await api.habits.reorder(next.map((h) => h.id));
    list.reload();
  }

  return (
    <>
      <section>
        <form onSubmit={add}>
          <div className="row">
            <div className="grow">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New habit" aria-label="New habit" />
            </div>
            <select
              value={cadence}
              onChange={(e) => setCadence(e.target.value as 'daily' | 'weekly')}
              aria-label="Cadence"
              style={{ width: 'auto' }}
            >
              <option value="daily">daily</option>
              <option value="weekly">weekly</option>
            </select>
            <button className="btn primary" type="submit" disabled={!name.trim()}>
              Add
            </button>
          </div>
        </form>
      </section>

      <section>
        <h2>Your habits</h2>
        {list.loading && <div className="empty">loading…</div>}
        {habits.length === 0 && !list.loading && <div className="empty">No habits yet.</div>}

        {habits.map((habit, index) =>
          editingId === habit.id ? (
            <HabitEditor
              key={habit.id}
              habit={habit}
              onClose={() => setEditingId(null)}
              onSaved={list.reload}
            />
          ) : (
            <ManagedHabit
              key={habit.id}
              habit={habit}
              first={index === 0}
              last={index === habits.length - 1}
              onEdit={() => setEditingId(habit.id)}
              onMove={(delta) => move(index, delta)}
              onChanged={list.reload}
            />
          )
        )}
      </section>

      {archived.length > 0 && (
        <section className="done-area">
          <h2>Paused</h2>
          {archived.map((habit) => (
            <div className="card" key={habit.id}>
              <div className="row between">
                <div className="grow">
                  <div className="title">{habit.name}</div>
                  <div className="meta">paused · {habit.cadence}</div>
                </div>
                <button className="btn subtle" onClick={() => api.habits.update(habit.id, { active: true }).then(list.reload)}>
                  resume
                </button>
              </div>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function ManagedHabit({
  habit,
  first,
  last,
  onEdit,
  onMove,
  onChanged,
}: {
  habit: Habit;
  first: boolean;
  last: boolean;
  onEdit: () => void;
  onMove: (delta: number) => void;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="card">
      <div className="row between">
        <div className="grow">
          <div className="title">{habit.name}</div>
          <div className="meta">
            {habit.doneThisPeriod} of {habit.targetPerPeriod} this {habit.cadence === 'daily' ? 'day' : 'week'}
            {habit.met && ' · done'}
            {habit.reminderEveryMinutes && ` · reminds every ${formatInterval(habit.reminderEveryMinutes)}`}
          </div>
        </div>

        <div className="stepper">
          <button
            className="btn subtle"
            aria-label={`Remove one from ${habit.name}`}
            disabled={habit.doneThisPeriod === 0}
            onClick={() => api.habits.uncheck(habit.id).then(onChanged)}
          >
            −
          </button>
          <span className="count">{habit.doneThisPeriod}</span>
          <button className="btn subtle" aria-label={`Add one to ${habit.name}`} onClick={() => api.habits.check(habit.id).then(onChanged)}>
            +
          </button>
        </div>
      </div>

      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn subtle" aria-label="Move up" disabled={first} onClick={() => onMove(-1)}>
          ↑
        </button>
        <button className="btn subtle" aria-label="Move down" disabled={last} onClick={() => onMove(1)}>
          ↓
        </button>
        <button className="btn subtle" onClick={onEdit}>
          edit
        </button>
        <button className="btn subtle" onClick={() => api.habits.update(habit.id, { active: false }).then(onChanged)}>
          pause
        </button>
        <div className="grow" />
        {confirming ? (
          <>
            <span className="meta">delete for good?</span>
            <button className="btn subtle danger" onClick={() => api.habits.remove(habit.id).then(onChanged)}>
              yes
            </button>
            <button className="btn subtle" onClick={() => setConfirming(false)}>
              no
            </button>
          </>
        ) : (
          // Deleting takes the whole streak history with it, so it asks first.
          <button className="btn subtle danger" onClick={() => setConfirming(true)}>
            delete
          </button>
        )}
      </div>
    </div>
  );
}

/** Sensible nagging intervals; anything finer would just be irritating. */
const REMINDER_CHOICES = [
  { value: 0, label: "Don't remind me" },
  { value: 30, label: 'Every 30 minutes' },
  { value: 60, label: 'Every hour' },
  { value: 90, label: 'Every 90 minutes' },
  { value: 120, label: 'Every 2 hours' },
  { value: 180, label: 'Every 3 hours' },
  { value: 240, label: 'Every 4 hours' },
];

function HabitEditor({ habit, onClose, onSaved }: { habit: Habit; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(habit.name);
  const [cadence, setCadence] = useState(habit.cadence);
  const [target, setTarget] = useState(habit.targetPerPeriod);
  const [reminder, setReminder] = useState(habit.reminderEveryMinutes ?? 0);

  async function save() {
    await api.habits.update(habit.id, {
      name: name.trim() || habit.name,
      cadence,
      targetPerPeriod: Math.max(1, target),
      reminderEveryMinutes: reminder > 0 ? reminder : null,
    });
    onSaved();
    onClose();
  }

  return (
    <div className="card">
      <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Habit name" />
      <div className="row" style={{ marginTop: 8 }}>
        <select value={cadence} onChange={(e) => setCadence(e.target.value as 'daily' | 'weekly')} aria-label="Cadence">
          <option value="daily">every day</option>
          <option value="weekly">every week</option>
        </select>
        <input
          type="number"
          min={1}
          value={target}
          onChange={(e) => setTarget(Number(e.target.value))}
          aria-label="Times per period"
        />
      </div>
      <div className="meta" style={{ marginTop: 8 }}>
        How many times it counts as done in one {cadence === 'daily' ? 'day' : 'week'}.
      </div>

      <div style={{ marginTop: 12 }}>
        <select value={reminder} onChange={(e) => setReminder(Number(e.target.value))} aria-label="Reminder interval">
          {REMINDER_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
        <div className="meta" style={{ marginTop: 6 }}>
          Nags you until you've hit the target, then stops for the rest of the {cadence === 'daily' ? 'day' : 'week'}.
          Silent during quiet hours and while you're in a game — and a reminder you miss is dropped rather than
          stacking up.
        </div>
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn primary" onClick={save}>
          Save
        </button>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
