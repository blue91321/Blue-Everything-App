import { useState } from 'react';
import { api, type Habit, type HabitMode } from '../api';
import { HabitGauge } from '../Gauge';
import { spanLabel } from '../format';
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
  const list = useAsync(() => api.habits.list(), [], ['habits']);
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
            {/*
              Says what the habit *is* before what it has done. A gauge described
              as "1 of 1 this day" is not merely unhelpful — it is a wrong
              statement about the kind of thing it is.
            */}
            {habit.mode === 'gauge'
              ? `gauge · ${habit.gaugeNow ?? 100}% full · drains ${habit.gaugeDrainPerDay ?? 100}% a day · asks at ${habit.gaugeRemindAt ? `${habit.gaugeRemindAt}%` : 'empty'}`
              : habit.mode === 'interval'
                ? `every ${habit.intervalMinutes ? formatInterval(habit.intervalMinutes) : '—'} after doing it`
                : `${habit.doneThisPeriod} of ${habit.targetPerPeriod} this ${habit.cadence === 'daily' ? 'day' : 'week'}`}
            {habit.met && habit.mode !== 'gauge' && ' · done'}
            {habit.reminderEveryMinutes && ` · reminds every ${formatInterval(habit.reminderEveryMinutes)}`}
            {habit.reminderEveryMinutes !== null &&
              habit.reminderStartMinute !== null &&
              ` from ${minuteToTime(habit.reminderStartMinute)}`}
            {habit.voicePhrases.length > 0 && ` · says "${habit.voicePhrases[0]}"`}
          </div>
        </div>

        {/*
          The stepper corrects the tally, and for a gauge the tally is the level.
          Disabling on `doneThisPeriod` would be wrong twice over there: a gauge
          filled yesterday has no entry today, so − would be dead exactly when
          you wanted it, and the count shown would be the number of top-ups
          today rather than how full the thing is.
        */}
        <div className="stepper">
          <button
            className="btn subtle"
            aria-label={`Remove one from ${habit.name}`}
            disabled={habit.mode === 'gauge' ? (habit.gaugeNow ?? 0) === 0 : habit.doneThisPeriod === 0}
            onClick={() => api.habits.uncheck(habit.id).then(onChanged)}
          >
            −
          </button>
          <span className="count">
            {habit.mode === 'gauge' ? `${habit.gaugeNow ?? 100}%` : habit.doneThisPeriod}
          </span>
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

const MODE_CHOICES: { id: HabitMode; label: string; hint: string }[] = [
  { id: 'target', label: 'A number of times', hint: 'N per day or week — "drink 8 glasses"' },
  { id: 'interval', label: 'A set gap after doing it', hint: 'no target; due again N later — "water the plants every 4 days"' },
  { id: 'gauge', label: 'A shape that empties', hint: 'drains over time, doing it tops it back up' },
];

/**
 * Gaps worth offering. Longer than the reminder intervals above, because this
 * is "when is it due again" rather than "how often should it nag" — a habit due
 * every fortnight is ordinary, a reminder every fortnight is not.
 */
const INTERVAL_CHOICES = [
  { value: 60, label: 'every hour' },
  { value: 4 * 60, label: 'every 4 hours' },
  { value: 12 * 60, label: 'every 12 hours' },
  { value: 24 * 60, label: 'every day' },
  { value: 2 * 24 * 60, label: 'every 2 days' },
  { value: 3 * 24 * 60, label: 'every 3 days' },
  { value: 4 * 24 * 60, label: 'every 4 days' },
  { value: 7 * 24 * 60, label: 'every week' },
  { value: 14 * 24 * 60, label: 'every 2 weeks' },
  { value: 30 * 24 * 60, label: 'every month' },
];

const DAY_MS = 86_400_000;

/**
 * What the drain and the fill add up to, as a habit rather than as arithmetic.
 *
 * "Empties by 200% a day" and "each tick adds 40%" are two abstractions, and
 * neither is the thing you want to know — which is that this means five glasses
 * of water a day, or watering the plant every four days. That number is the one
 * you can hold against your actual life and decide the settings are wrong.
 */
function rhythm(drainPerDay: number, fillPercent: number): string {
  const perDay = drainPerDay / fillPercent;
  if (perDay >= 1) {
    const rounded = Math.round(perDay * 10) / 10;
    return `about ${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} a day to keep up`;
  }
  // Fewer than one a day: the useful framing flips to how long one tick lasts.
  return `one every ${spanLabel((fillPercent / drainPerDay) * DAY_MS)} to keep up`;
}

const SHAPE_NAMES = ['circle', 'square', 'triangle', 'bar'];
/**
 * The four drawn shapes and a few emoji to show the box takes one.
 *
 * A handful rather than a picker: any emoji works, and the field is a text box,
 * so these are a hint about what is possible rather than the list of options. A
 * full emoji gallery would be a component to build and maintain for a choice
 * made once per habit.
 */
const SHAPE_SUGGESTIONS = [...SHAPE_NAMES, '💧', '🪴', '🔋', '🍎', '😴', '🏃'];

function HabitEditor({ habit, onClose, onSaved }: { habit: Habit; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(habit.name);
  const [mode, setMode] = useState<HabitMode>(habit.mode ?? 'target');
  const [cadence, setCadence] = useState(habit.cadence);
  const [target, setTarget] = useState(habit.targetPerPeriod);
  const [intervalMinutes, setIntervalMinutes] = useState(habit.intervalMinutes ?? 24 * 60);
  const [drain, setDrain] = useState(habit.gaugeDrainPerDay ?? 100);
  const [fill, setFill] = useState(habit.gaugeFillPercent ?? 100);
  const [remindAt, setRemindAt] = useState(habit.gaugeRemindAt ?? 0);
  const [shape, setShape] = useState(habit.gaugeShape ?? 'circle');
  const [uploading, setUploading] = useState('');
  const [reminder, setReminder] = useState(habit.reminderEveryMinutes ?? 0);
  const [startTime, setStartTime] = useState(
    habit.reminderStartMinute === null ? '' : minuteToTime(habit.reminderStartMinute)
  );
  const [phrases, setPhrases] = useState<string[]>(habit.voicePhrases);
  const [push, setPush] = useState<boolean | null>(habit.pushToPhone === null ? null : Boolean(habit.pushToPhone));

  // Same reasoning as the task editor: loaded by the thing that needs it, only
  // while a row is open.
  const settings = useAsync(() => api.settings.get(), [], ['settings']);
  const pushDefault = settings.data?.pushDefault !== 0;
  const canChoosePush = featureEnabled('push') && settings.data?.pushDefault !== undefined;

  async function save() {
    await api.habits.update(habit.id, {
      name: name.trim() || habit.name,
      mode,
      cadence,
      targetPerPeriod: Math.max(1, target),
      intervalMinutes: mode === 'interval' ? Math.max(5, intervalMinutes) : null,
      gaugeDrainPerDay: Math.max(1, drain),
      gaugeFillPercent: Math.min(100, Math.max(1, fill)),
      gaugeRemindAt: Math.min(90, Math.max(0, remindAt)),
      gaugeShape: shape.trim() || 'circle',
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
      {/*
        The mode, first, because it decides which of the fields below mean
        anything. Three radio buttons rather than a dropdown: each needs a line
        saying what it is for, and choosing between kinds of thing is not the
        same interaction as choosing a value.
      */}
      <div style={{ marginTop: 12 }}>
        {MODE_CHOICES.map((choice) => (
          <label key={choice.id} className="row" style={{ alignItems: 'flex-start', gap: '.5rem', marginTop: 6 }}>
            <input
              type="radio"
              name={`habit-mode-${habit.id}`}
              checked={mode === choice.id}
              onChange={() => setMode(choice.id)}
              style={{ marginTop: 3 }}
            />
            <span className="grow">
              {choice.label}
              <span className="meta"> — {choice.hint}</span>
            </span>
          </label>
        ))}
      </div>

      {mode === 'target' && (
        <>
          <div className="row" style={{ marginTop: 8 }}>
            <select
              value={cadence}
              onChange={(e) => setCadence(e.target.value as 'daily' | 'weekly')}
              aria-label="Cadence"
            >
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
        </>
      )}

      {mode === 'interval' && (
        <div style={{ marginTop: 8 }}>
          <select
            value={intervalMinutes}
            onChange={(e) => setIntervalMinutes(Number(e.target.value))}
            aria-label="Due again after"
          >
            {INTERVAL_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
          <div className="meta" style={{ marginTop: 8 }}>
            Due again this long after the last time you did it — the clock starts when you tick it off,
            not at midnight. There is no target and nothing to fall behind on.
            {reminder === 0 && ' With no reminder interval set below, it will nag on this schedule too.'}
          </div>
        </div>
      )}

      {mode === 'gauge' && (
        <div style={{ marginTop: 8 }}>
          <div className="row" style={{ alignItems: 'center', gap: '.75rem' }}>
            {/* The real component, at the real size, showing the real level —
                so what you are choosing is what you will see, the same reason
                the accent swatches carry their own `data-accent`. */}
            <HabitGauge habit={habit} shape={shape} size={40} />
            <div className="grow">
              <input
                value={shape}
                onChange={(e) => setShape(e.target.value)}
                aria-label="Gauge shape or emoji"
                placeholder="circle, or an emoji"
              />
            </div>
          </div>
          <div className="row wrap" style={{ marginTop: 8, gap: '.35rem' }}>
            {SHAPE_SUGGESTIONS.map((option) => (
              <button
                key={option}
                type="button"
                className={shape === option ? 'btn primary' : 'btn subtle'}
                onClick={() => setShape(option)}
              >
                {SHAPE_NAMES.includes(option) ? option : <span style={{ fontSize: 18 }}>{option}</span>}
              </button>
            ))}
          </div>

          {/*
            A picture of your own.
            
            The upload happens immediately rather than waiting for Save, because
            it is a *file* — the server has to hold it before the shape can point
            at it, and the route refuses `image` with nothing uploaded for
            exactly that reason. Same order the app logo does it in.
          */}
          <div className="row wrap" style={{ marginTop: 8, gap: '.35rem', alignItems: 'center' }}>
            <label className="btn subtle" style={{ cursor: 'pointer' }}>
              {uploading === 'up' ? 'Uploading…' : habit.hasImage ? 'Replace picture…' : 'Use my own picture…'}
              <input
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                hidden
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  // Cleared straight away so picking the *same* file again after
                  // a failure still fires a change event.
                  e.target.value = '';
                  if (!file) return;
                  setUploading('up');
                  try {
                    await api.habits.uploadImage(habit.id, file);
                    setShape('image');
                    onSaved();
                  } catch (error) {
                    setUploading('');
                    alert((error as Error).message);
                    return;
                  }
                  setUploading('');
                }}
              />
            </label>

            {habit.hasImage && (
              <>
                <button
                  type="button"
                  className={shape === 'image' ? 'btn primary' : 'btn subtle'}
                  onClick={() => setShape('image')}
                >
                  my picture
                </button>
                <button
                  type="button"
                  className="btn subtle"
                  onClick={async () => {
                    await api.habits.removeImage(habit.id);
                    // The server resets the shape only if it was pointing at the
                    // file, so this mirrors it rather than assuming.
                    if (shape === 'image') setShape('circle');
                    onSaved();
                  }}
                >
                  remove
                </button>
              </>
            )}
          </div>
          <div className="meta" style={{ marginTop: 6 }}>
            A PNG, JPEG, GIF or WebP up to 3MB. It is drawn small and greyed out as it empties, so
            something with a clear silhouette reads best.
          </div>

          <label className="row between" style={{ alignItems: 'center', marginTop: 12 }}>
            <span className="grow">
              Empties by <strong>{drain}%</strong> a day
              {/* In whatever unit fits. "empty after 0.3 days" is a number you
                  have to multiply by 24 in your head, and "20.0 days" is three
                  weeks said badly. */}
              <span className="meta"> — full lasts {spanLabel((100 / drain) * DAY_MS)}</span>
            </span>
            <input
              type="range"
              min={5}
              max={400}
              step={5}
              value={drain}
              onChange={(e) => setDrain(Number(e.target.value))}
              aria-label="Drains per day"
              style={{ width: 160 }}
            />
          </label>

          <label className="row between" style={{ alignItems: 'center', marginTop: 8 }}>
            <span className="grow">
              Each tick adds <strong>{fill}%</strong>
              {/*
                Two percentages are two abstractions, and the thing you actually
                want to know is the rhythm they imply: "6 a day" or "one every 3
                days". That is the number you can check against your life, and it
                falls straight out of the drain and the fill.
              */}
              <span className="meta">
                {' — '}
                {Math.ceil(100 / fill)} to refill from empty · {rhythm(drain, fill)}
              </span>
            </span>
            <input
              type="range"
              min={5}
              max={100}
              step={5}
              value={fill}
              onChange={(e) => setFill(Number(e.target.value))}
              aria-label="Each tick fills"
              style={{ width: 160 }}
            />
          </label>

          <label className="row between" style={{ alignItems: 'center', marginTop: 8 }}>
            <span className="grow">
              Starts asking at <strong>{remindAt === 0 ? 'empty' : `${remindAt}%`}</strong>
              <span className="meta">
                {' — '}
                {remindAt === 0
                  ? 'no warning; it asks once there is nothing left'
                  : `${spanLabel(((100 - remindAt) / drain) * DAY_MS)} after a full top-up`}
              </span>
            </span>
            <input
              type="range"
              min={0}
              max={90}
              step={5}
              value={remindAt}
              onChange={(e) => setRemindAt(Number(e.target.value))}
              aria-label="Starts asking at"
              style={{ width: 160 }}
            />
          </label>

          <div className="meta" style={{ marginTop: 8 }}>
            {/* Why the threshold is worth setting at all, in the place where you
                are deciding. Empty-only is the wrong moment for anything that
                takes a while to act on. */}
            Reminding only at empty is fine for a glass of water and wrong for anything you need warning
            about — a plant would ask once it was already dead. The Dashboard counts down to both.
          </div>

          <div className="meta" style={{ marginTop: 8 }}>
            The level is stored rather than worked out from the last tick, so topping it up twice in a
            morning really does leave it fuller. Nothing runs on a timer — it is worked out from the last
            time it changed.
          </div>
        </div>
      )}

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
            : mode === 'gauge'
              ? 'Nags you once the gauge is empty, and stops as soon as you top it up. Leave it off and the gauge is purely something to look at.'
              : mode === 'interval'
                ? 'Nags you once it is due, and stops as soon as you do it.'
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
