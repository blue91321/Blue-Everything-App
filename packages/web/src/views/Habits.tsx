import { useState } from 'react';
import { api, type Habit } from '../api';
import { useAsync } from '../useAsync';
import { featureEnabled } from '../features';
import { PushChoice } from '../controls';

const minuteToTime = (minute: number): string =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

const timeToMinute = (value: string): number => {
  const [h, m] = value.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

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
            {habit.reminderEveryMinutes !== null &&
              habit.reminderStartMinute !== null &&
              ` from ${minuteToTime(habit.reminderStartMinute)}`}
            {habit.voicePhrases.length > 0 && ` · says "${habit.voicePhrases[0]}"`}
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
  const [startTime, setStartTime] = useState(
    habit.reminderStartMinute === null ? '' : minuteToTime(habit.reminderStartMinute)
  );
  const [phrases, setPhrases] = useState<string[]>(habit.voicePhrases);
  const [push, setPush] = useState<boolean | null>(habit.pushToPhone === null ? null : Boolean(habit.pushToPhone));

  // Same reasoning as the task editor: loaded by the thing that needs it, only
  // while a row is open.
  const settings = useAsync(() => api.settings.get());
  const pushDefault = settings.data?.pushDefault !== 0;
  const canChoosePush = featureEnabled('push') && settings.data?.pushDefault !== undefined;

  async function save() {
    await api.habits.update(habit.id, {
      name: name.trim() || habit.name,
      cadence,
      targetPerPeriod: Math.max(1, target),
      reminderEveryMinutes: reminder > 0 ? reminder : null,
      reminderStartMinute: startTime ? timeToMinute(startTime) : null,
      ...(canChoosePush ? { pushToPhone: push } : {}),
      voicePhrases: phrases.map((p) => p.trim()).filter(Boolean),
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
        {reminder > 0 && (
          <div className="row" style={{ marginTop: 8 }}>
            <span className="meta">Not before</span>
            <input
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              aria-label="Start reminding at"
              style={{ width: 'auto' }}
            />
            {startTime && (
              <button className="btn subtle" type="button" onClick={() => setStartTime('')}>
                any time
              </button>
            )}
          </div>
        )}

        <div className="meta" style={{ marginTop: 6 }}>
          {reminder > 0 && startTime
            ? `Starts asking at ${startTime} and keeps going until it's done.`
            : "Nags you until you've hit the target, then stops for the rest of the " +
              (cadence === 'daily' ? 'day' : 'week') + '.'}{' '}
          Ticking it off restarts the clock. Silent during quiet hours and while you're in a game — and a
          reminder you miss is dropped rather than stacking up.
        </div>
      </div>

      {/* Gated on there being a reminder at all. A habit that never interrupts
          raises no nudge, so a push switch on it would be a control over
          something that cannot happen — and would read as being broken. */}
      {canChoosePush && reminder > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="title">Send this to my phone</div>
          <div className="meta" style={{ marginTop: 4, marginBottom: 8 }}>
            Only when you are away from the PC. A repeating habit is the most likely thing to buzz your
            pocket for no reason, so this is worth an answer.
          </div>
          <PushChoice value={push} fallback={pushDefault} onChange={setPush} />
        </div>
      )}

      {/* Phrases only mean something if there is a listener. With voice off
          this is an editor for a field nothing reads — and worse, it says
          "saying one of these ticks it off", which would be untrue. */}
      {featureEnabled('voice') && <VoicePhrases habitName={name} phrases={phrases} onChange={setPhrases} />}

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

/**
 * What you can say to tick this habit off.
 *
 * Phrases are matched on meaningful words rather than exactly, and past tenses
 * are folded — so "drink water" already covers "I drank some water". The list
 * is for genuinely different wordings ("had a glass"), not for spelling out
 * every grammatical variation, and the copy says so because otherwise the
 * natural instinct is to type twenty of them.
 */
function VoicePhrases({
  habitName,
  phrases,
  onChange,
}: {
  habitName: string;
  phrases: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState('');

  function add() {
    const trimmed = draft.trim().toLowerCase();
    if (!trimmed || phrases.includes(trimmed)) return;
    onChange([...phrases, trimmed]);
    setDraft('');
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div className="title">Say it out loud</div>
      <div className="meta" style={{ marginTop: 4 }}>
        With voice switched on, saying your wake word and then one of these ticks off {habitName || 'this habit'}.
        Tense and filler words don't matter — "drink water" already catches "I just drank some water". Add
        another only for a genuinely different wording.
      </div>

      {phrases.length > 0 && (
        <div className="row wrap" style={{ marginTop: 8 }}>
          {phrases.map((phrase) => (
            <button
              key={phrase}
              className="btn subtle"
              aria-label={`Remove phrase ${phrase}`}
              onClick={() => onChange(phrases.filter((p) => p !== phrase))}
            >
              {phrase} ✕
            </button>
          ))}
        </div>
      )}

      <div className="row" style={{ marginTop: 8 }}>
        <div className="grow">
          <input
            value={draft}
            placeholder="drink water"
            aria-label="New voice phrase"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
          />
        </div>
        <button className="btn" disabled={!draft.trim()} onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
}
