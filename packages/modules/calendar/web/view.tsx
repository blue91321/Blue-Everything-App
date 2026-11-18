/**
 * The Calendar tab: a month, or a list of what is coming, the chosen day's
 * events under the month, an editor for your own events, and Calendars, where
 * links are added, files imported, and reminders set.
 *
 * Times are this device's: a meeting typed at 3pm here is at 3pm here, and
 * an event from a calendar in another zone is shown at its time here. An
 * all-day event is a date, and is that date everywhere.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ChangeScope } from '@app/live';
import { useNow } from '@app/clock';
import { Toggle } from '@app/controls';
import { useAction, useAsync } from '@app/useAsync';
import { useBackStep } from '@app/view-history';
import type { FeatureViewProps } from '@app/features/index';
import { ReminderQuestion } from './ask';
import './calendar.css';
import {
  addDaysKey,
  ALL_DAY_CHOICES,
  calendar,
  dayKey,
  daysOf,
  dayTitle,
  deviceZone,
  fromKey,
  localWall,
  offsetText,
  ordinal,
  pad,
  repeatText,
  TIMED_CHOICES,
  timeText,
  weekOfMonth,
  whenOn,
  WEEKDAY_NAMES,
  type CalendarInfo,
  type CalendarState,
  type CalEvent,
  type EventDraft,
  type ImportPreview,
  type Occurrence,
  type Reminders,
  type Repeat,
  type Scope,
} from './calendar-api';

const WATCH = ['calendar'] as unknown as ChangeScope[];
const COLORS = ['#4f8cff', '#e5534b', '#57ab5a', '#c69026', '#a371f7', '#39c5cf', '#e0823d', '#d16ba5'];
const MODE_KEY = 'calendar.mode';

/** The day a week starts on here: Sunday (0) or Monday (1), from the browser's locale. */
function weekStart(): number {
  try {
    const locale = new Intl.Locale(navigator.language) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const info = locale.getWeekInfo?.() ?? locale.weekInfo;
    if (info?.firstDay) return info.firstDay % 7;
  } catch {
    // An older browser: guess from the region below.
  }
  return /^en(-US|-CA)?$|-(US|CA|JP|BR|MX|PH|IL|KR|TW|HK|IN|ZA)$/i.test(navigator.language) ? 0 : 1;
}

/** The six weeks a month is drawn over, as day keys. */
function gridDays(month: string, firstDay: number): string[] {
  const first = `${month}-01`;
  const lead = (fromKey(first).getDay() - firstDay + 7) % 7;
  const start = addDaysKey(first, -lead);
  return Array.from({ length: 42 }, (_, i) => addDaysKey(start, i));
}

const monthName = (month: string) => fromKey(`${month}-01`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const shiftMonth = (month: string, n: number) => {
  const d = fromKey(`${month}-01`);
  d.setMonth(d.getMonth() + n);
  return dayKey(d).slice(0, 7);
};
const ago = (at: number, now: number) => {
  const m = Math.round((now - at) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} hour${h === 1 ? '' : 's'} ago` : `${Math.round(h / 24)} days ago`;
};

type Target = { kind: 'new'; day: string } | { kind: 'occurrence'; occ: Occurrence };

export default function CalendarView({ focus, onFocused }: FeatureViewProps) {
  const now = useNow();
  const today = dayKey(new Date(now));
  const [mode, setModeState] = useState<'month' | 'agenda'>(() => {
    try {
      return localStorage.getItem(MODE_KEY) === 'agenda' ? 'agenda' : 'month';
    } catch {
      return 'month';
    }
  });
  const setMode = (m: 'month' | 'agenda') => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // A per-device nicety only.
    }
  };
  const [month, setMonth] = useState(today.slice(0, 7));
  const [selected, setSelected] = useState(today);
  const [target, setTarget] = useState<Target | null>(null);
  const [settings, setSettings] = useState(false);
  const firstDay = useMemo(weekStart, []);
  const grid = useMemo(() => gridDays(month, firstDay), [month, firstDay]);

  // The window asked for: the month's six weeks, or the next two months.
  const from = mode === 'month' ? fromKey(grid[0]!).getTime() : fromKey(today).getTime();
  const to = mode === 'month' ? fromKey(addDaysKey(grid[41]!, 1)).getTime() : fromKey(addDaysKey(today, 61)).getTime();
  const state = useAsync(() => calendar.get(from, to), [from, to], WATCH);
  const data = state.data;

  const byDay = useMemo(() => {
    const map = new Map<string, Occurrence[]>();
    for (const o of data?.occurrences ?? []) {
      for (const d of daysOf(o)) {
        const list = map.get(d) ?? [];
        list.push(o);
        map.set(d, list);
      }
    }
    for (const list of map.values()) list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startMs - b.startMs);
    return map;
  }, [data]);

  // Sent here from the Dashboard ("day:YYYY-MM-DD") or to the settings ("calendars").
  useEffect(() => {
    if (!focus) return;
    if (focus === 'calendars') setSettings(true);
    else if (focus.startsWith('day:')) {
      const day = focus.slice(4);
      setMode('month');
      setMonth(day.slice(0, 7));
      setSelected(day);
    }
    onFocused?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  if (target && data) return <EventEditor target={target} state={data} onClose={() => setTarget(null)} />;
  if (settings && data) return <Calendars state={data} onClose={() => setSettings(false)} />;

  const go = (n: number) => setMonth((m) => shiftMonth(m, n));
  const toToday = () => {
    setMonth(today.slice(0, 7));
    setSelected(today);
  };
  const weekdays = Array.from({ length: 7 }, (_, i) => WEEKDAY_NAMES[(firstDay + i) % 7]!);
  const ownCount = data?.calendars.filter((c) => c.kind === 'own').length ?? 0;

  return (
    <div className="calendar">
      {data && !data.reminders.asked && (
        <div className="card cal-ask">
          <ReminderQuestion onDone={() => undefined} />
        </div>
      )}
      <div className="row wrap cal-bar">
        {mode === 'month' ? (
          <>
            <button className="btn subtle" aria-label="Previous month" onClick={() => go(-1)}>
              ‹
            </button>
            <strong className="cal-month">{monthName(month)}</strong>
            <button className="btn subtle" aria-label="Next month" onClick={() => go(1)}>
              ›
            </button>
            {(month !== today.slice(0, 7) || selected !== today) && (
              <button className="btn subtle" onClick={toToday}>
                Today
              </button>
            )}
          </>
        ) : (
          <strong className="cal-month">Coming up</strong>
        )}
        <span className="grow" />
        <div className="cal-switch" role="group" aria-label="View">
          <button className={`btn subtle${mode === 'month' ? ' on' : ''}`} aria-pressed={mode === 'month'} onClick={() => setMode('month')}>
            Month
          </button>
          <button className={`btn subtle${mode === 'agenda' ? ' on' : ''}`} aria-pressed={mode === 'agenda'} onClick={() => setMode('agenda')}>
            List
          </button>
        </div>
        <button className="btn primary" disabled={!data || ownCount === 0} onClick={() => setTarget({ kind: 'new', day: mode === 'month' ? selected : today })}>
          ＋ Event
        </button>
        <button className="btn subtle" onClick={() => setSettings(true)} aria-label="Calendars and reminders">
          ⚙ Calendars
        </button>
      </div>
      {state.error && <p className="banner">Could not load: {state.error.message}</p>}
      {data?.calendars.some((c) => c.error && !c.hidden) && (
        <p className="banner">
          {data.calendars
            .filter((c) => c.error && !c.hidden)
            .map((c) => `${c.name}: ${c.error}`)
            .join(' · ')}{' '}
          <button className="btn subtle" onClick={() => setSettings(true)}>
            Calendars
          </button>
        </p>
      )}

      {mode === 'month' ? (
        <>
          <div className="cal-grid" role="grid" aria-label={monthName(month)}>
            {weekdays.map((w) => (
              <div key={w} className="cal-wd" role="columnheader">
                {w.slice(0, 3)}
              </div>
            ))}
            {grid.map((key) => {
              const events = byDay.get(key) ?? [];
              const out = key.slice(0, 7) !== month;
              return (
                <button
                  key={key}
                  role="gridcell"
                  aria-selected={key === selected}
                  aria-label={`${dayTitle(key, today)}, ${events.length ? `${events.length} event${events.length === 1 ? '' : 's'}` : 'nothing on'}`}
                  className={`cal-cell${out ? ' out' : ''}${key === today ? ' today' : ''}${key === selected ? ' selected' : ''}`}
                  onClick={() => {
                    setSelected(key);
                    if (out) setMonth(key.slice(0, 7));
                  }}
                  onDoubleClick={() => ownCount && setTarget({ kind: 'new', day: key })}
                >
                  <span className="cal-num">{Number(key.slice(8))}</span>
                  <span className="cal-chips">
                    {events.slice(0, 3).map((o) => (
                      <span key={o.key} className={`cal-chip${o.allDay ? ' allday' : ''}`} style={{ ['--c' as string]: o.color }}>
                        <span className="cal-chip-text">
                          {!o.allDay && dayKey(new Date(o.startMs)) === key && <span className="cal-chip-time">{timeText(o.startMs).replace(/:00(?=\s|$)/, '')} </span>}
                          {o.title}
                        </span>
                      </span>
                    ))}
                    {events.length > 3 && <span className="cal-more">+{events.length - 3}</span>}
                  </span>
                </button>
              );
            })}
          </div>
          <DayList
            day={selected}
            today={today}
            events={byDay.get(selected) ?? []}
            canAdd={ownCount > 0}
            onOpen={(occ) => setTarget({ kind: 'occurrence', occ })}
            onAdd={() => setTarget({ kind: 'new', day: selected })}
          />
        </>
      ) : (
        <Agenda today={today} byDay={byDay} loading={state.loading} onOpen={(occ) => setTarget({ kind: 'occurrence', occ })} />
      )}
    </div>
  );
}

function EventRow({ o, day, onOpen }: { o: Occurrence; day: string; onOpen: (o: Occurrence) => void }) {
  return (
    <button className="card cal-row" onClick={() => onOpen(o)}>
      <span className="cal-bar-colour" style={{ background: o.color }} aria-hidden />
      <span className="grow">
        <span className="title">{o.title}</span>
        <span className="meta">
          {whenOn(o, day)}
          {o.location ? ` · ${o.location}` : ''}
          {o.repeating ? ' · repeats' : ''}
          {o.readOnly ? ' · from a link' : ''}
        </span>
      </span>
    </button>
  );
}

function DayList({
  day,
  today,
  events,
  canAdd,
  onOpen,
  onAdd,
}: {
  day: string;
  today: string;
  events: Occurrence[];
  canAdd: boolean;
  onOpen: (o: Occurrence) => void;
  onAdd: () => void;
}) {
  return (
    <section className="cal-day">
      <div className="row between">
        <h3>{dayTitle(day, today)}</h3>
        {canAdd && (
          <button className="btn subtle" onClick={onAdd}>
            ＋ Add on this day
          </button>
        )}
      </div>
      {events.length === 0 ? <p className="meta">Nothing on.</p> : events.map((o) => <EventRow key={o.key} o={o} day={day} onOpen={onOpen} />)}
    </section>
  );
}

function Agenda({ today, byDay, loading, onOpen }: { today: string; byDay: Map<string, Occurrence[]>; loading: boolean; onOpen: (o: Occurrence) => void }) {
  const days = [...byDay.keys()].filter((d) => d >= today).sort();
  if (loading) return <p className="meta">Loading…</p>;
  if (!days.length) return <p className="empty">Nothing in the next two months.</p>;
  return (
    <>
      {days.map((d) => (
        <section key={d} className="cal-day">
          <h3>{dayTitle(d, today)}</h3>
          {byDay.get(d)!.map((o) => (
            <EventRow key={o.key} o={o} day={d} onOpen={onOpen} />
          ))}
        </section>
      ))}
    </>
  );
}

/* ---------------------------------------------------------------- reminders */

/** Reminder offsets as chips, with a way to add one and to take one off. */
function OffsetChips({ value, allDay, onChange }: { value: number[]; allDay: boolean; onChange: (next: number[]) => void }) {
  const choices = (allDay ? ALL_DAY_CHOICES : TIMED_CHOICES).filter((c) => !value.includes(c));
  return (
    <div className="row wrap cal-offsets">
      {value.length === 0 && <span className="meta">No reminders</span>}
      {value.map((o) => (
        <span key={o} className="cal-offset">
          {offsetText(o, allDay)}
          <button className="btn subtle" aria-label={`Remove: ${offsetText(o, allDay)}`} onClick={() => onChange(value.filter((v) => v !== o))}>
            ✕
          </button>
        </span>
      ))}
      {value.length < 5 && choices.length > 0 && (
        <select
          value=""
          aria-label="Add a reminder"
          onChange={(e) => {
            if (e.target.value !== '') onChange([...value, Number(e.target.value)].sort((a, b) => a - b));
          }}
        >
          <option value="">＋ Add a reminder…</option>
          {choices.map((c) => (
            <option key={c} value={c}>
              {offsetText(c, allDay)}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/** An event's reminders: the usual ones (null), or its own. */
function RemindPicker({ value, allDay, prefs, onChange }: { value: number[] | null; allDay: boolean; prefs: Reminders; onChange: (next: number[] | null) => void }) {
  const usual = allDay ? prefs.allDay : prefs.timed;
  const usualText = usual.length ? usual.map((o) => offsetText(o, allDay).toLowerCase()).join(', ') : 'none';
  return (
    <div className="cal-field">
      <span className="cal-label">Remind me</span>
      {!prefs.enabled && <p className="meta">Reminders are switched off (⚙ Calendars). These are kept for when they are on.</p>}
      <label className="row cal-check">
        <input type="checkbox" checked={value === null} onChange={(e) => onChange(e.target.checked ? null : [...usual])} />
        <span>The usual ({usualText})</span>
      </label>
      {value !== null && <OffsetChips value={value} allDay={allDay} onChange={onChange} />}
    </div>
  );
}

/* ---------------------------------------------------------------- the editor */

type RepeatKind = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthlyDay' | 'monthlyNth' | 'yearly' | 'keep';

/** Which of the editor's choices a rule is, or `keep` for one from a file that none of them is. */
function kindOf(r: Repeat | null): RepeatKind {
  if (!r) return 'none';
  if (r.interval !== 1 || (r.byMonth?.length && r.freq !== 'yearly')) return 'keep';
  const days = r.byDay?.map((b) => b.day).sort() ?? [];
  switch (r.freq) {
    case 'daily':
      return r.byDay?.length || r.byMonthDay?.length ? 'keep' : 'daily';
    case 'weekly':
      if (days.join() === '1,2,3,4,5' && r.byDay!.every((b) => !b.n)) return 'weekdays';
      return days.length <= 1 && !r.byDay?.some((b) => b.n) ? 'weekly' : 'keep';
    case 'monthly':
      if (r.byDay?.length === 1 && r.byDay[0]!.n && !r.byMonthDay?.length) return 'monthlyNth';
      return !r.byDay?.length && (r.byMonthDay?.length ?? 0) <= 1 ? 'monthlyDay' : 'keep';
    case 'yearly':
      return r.byDay?.length || (r.byMonth?.length ?? 0) > 1 || r.byMonthDay?.length ? 'keep' : 'yearly';
  }
}

function nthOf(day: string): number {
  const w = weekOfMonth(day);
  return w.last && w.n >= 4 ? -1 : w.n;
}

function buildRepeat(kind: RepeatKind, day: string, kept: Repeat | null, ends: 'never' | 'until' | 'count', until: string, count: number): Repeat | null {
  const wd = fromKey(day).getDay();
  let r: Repeat | null;
  switch (kind) {
    case 'none':
      return null;
    case 'daily':
      r = { freq: 'daily', interval: 1 };
      break;
    case 'weekdays':
      r = { freq: 'weekly', interval: 1, byDay: [1, 2, 3, 4, 5].map((d) => ({ day: d })) };
      break;
    case 'weekly':
      r = { freq: 'weekly', interval: 1, byDay: [{ day: wd }] };
      break;
    case 'monthlyDay':
      r = { freq: 'monthly', interval: 1, byMonthDay: [Number(day.slice(8, 10))] };
      break;
    case 'monthlyNth':
      r = { freq: 'monthly', interval: 1, byDay: [{ day: wd, n: nthOf(day) }] };
      break;
    case 'yearly':
      r = { freq: 'yearly', interval: 1 };
      break;
    case 'keep':
      r = kept ? { ...kept } : null;
      break;
  }
  if (!r) return null;
  delete r.count;
  delete r.until;
  if (ends === 'until' && until) r.until = until;
  if (ends === 'count' && count > 0) r.count = Math.min(count, 10_000);
  return r;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="cal-field">
      <span className="cal-label">{label}</span>
      {children}
    </label>
  );
}

function EventEditor({ target, state, onClose }: { target: Target; state: CalendarState; onClose: () => void }) {
  const close = useBackStep(onClose);
  const occ = target.kind === 'occurrence' ? target.occ : null;
  const loaded = useAsync(() => (occ ? calendar.event(occ.eventId) : Promise.resolve(null)), [occ?.eventId]);
  const ev = loaded.data;
  if (occ && loaded.loading) return <p className="meta">Loading…</p>;
  if (occ && (loaded.error || !ev)) {
    return (
      <div className="calendar">
        <p className="banner">That event could not be opened: {loaded.error?.message ?? 'it is gone'}.</p>
        <button className="btn" onClick={close}>
          Back
        </button>
      </div>
    );
  }
  if (occ && ev && (ev.readOnly || occ.readOnly)) return <LinkedEvent occ={occ} ev={ev} state={state} close={close} />;
  return <EventForm target={target} ev={ev ?? null} state={state} close={close} />;
}

/** An event from a link: what it says, and only its reminders to set. */
function LinkedEvent({ occ, ev, state, close }: { occ: Occurrence; ev: CalEvent; state: CalendarState; close: () => void }) {
  const [remind, setRemind] = useState<number[] | null>(ev.remind);
  const { busy, problem, run } = useAction();
  const cal = state.calendars.find((c) => c.id === occ.calendarId);
  const today = dayKey(new Date());
  const day = daysOf(occ)[0]!;
  return (
    <div className="calendar cal-editor">
      <button className="btn subtle" onClick={close}>
        ‹ Back
      </button>
      <h2>
        <span className="cal-dot" style={{ background: occ.color }} aria-hidden /> {occ.title}
      </h2>
      <p>
        {dayTitle(day, today)} · {whenOn(occ, day)}
      </p>
      {occ.repeating && <p className="meta">{repeatText(ev.repeat, ev.start)}</p>}
      {occ.location && <p>📍 {occ.location}</p>}
      {occ.notes && <p className="cal-notes">{occ.notes}</p>}
      <p className="meta">From {cal?.name ?? 'a linked calendar'}, which is read-only here: change it where it comes from. Its reminders are yours to set.</p>
      <RemindPicker value={remind} allDay={occ.allDay} prefs={state.reminders} onChange={setRemind} />
      <div className="row wrap">
        <button className="btn primary" disabled={busy} onClick={() => void run(async () => (await calendar.saveEvent(ev.id, { remind }), close()))}>
          Save reminders
        </button>
      </div>
      {problem && <p className="banner">{problem}</p>}
    </div>
  );
}

function EventForm({ target, ev, state, close }: { target: Target; ev: CalEvent | null; state: CalendarState; close: () => void }) {
  const occ = target.kind === 'occurrence' ? target.occ : null;
  const own = state.calendars.filter((c) => c.kind === 'own');
  // Starting values: the occurrence as shown on this device, or a new hour on the chosen day.
  const initial = useMemo(() => {
    if (occ) {
      if (occ.allDay) return { allDay: true, startDate: occ.start, startTime: '09:00', endDate: addDaysKey(occ.end, -1), endTime: '10:00' };
      const s = localWall(occ.startMs);
      const e = localWall(occ.endMs);
      return { allDay: false, startDate: s.slice(0, 10), startTime: s.slice(11), endDate: e.slice(0, 10), endTime: e.slice(11) };
    }
    const day = (target as { day: string }).day;
    const nowWall = localWall(Date.now());
    const hour = day === nowWall.slice(0, 10) ? Math.min(23, Number(nowWall.slice(11, 13)) + 1) : 9;
    return { allDay: false, startDate: day, startTime: `${pad(hour)}:00`, endDate: day, endTime: `${pad(Math.min(23, hour + 1))}:${hour === 23 ? '59' : '00'}` };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [title, setTitle] = useState(ev?.title ?? '');
  const [location, setLocation] = useState(ev?.location ?? '');
  const [notes, setNotes] = useState(ev?.notes ?? '');
  const [allDay, setAllDay] = useState(initial.allDay);
  const [startDate, setStartDate] = useState(initial.startDate);
  const [startTime, setStartTime] = useState(initial.startTime);
  const [endDate, setEndDate] = useState(initial.endDate);
  const [endTime, setEndTime] = useState(initial.endTime);
  const [kind, setKind] = useState<RepeatKind>(kindOf(ev?.repeat ?? null));
  const [ends, setEnds] = useState<'never' | 'until' | 'count'>(ev?.repeat?.count ? 'count' : ev?.repeat?.until ? 'until' : 'never');
  const [until, setUntil] = useState(ev?.repeat?.until?.slice(0, 10) ?? '');
  const [count, setCount] = useState(ev?.repeat?.count ?? 10);
  const [remind, setRemind] = useState<number[] | null>(ev?.remind ?? null);
  const [calendarId, setCalendarId] = useState(ev?.calendarId ?? own[0]?.id ?? '');
  const [asking, setAsking] = useState<'save' | 'delete' | null>(null);
  const { busy, problem, setProblem, run } = useAction();
  const repeating = !!ev?.repeat;
  const wd = WEEKDAY_NAMES[fromKey(startDate).getDay()]!;
  const nth = nthOf(startDate);

  // Moving the start moves the end with it, keeping the length.
  const moveStart = (date: string, time: string) => {
    const before = new Date(`${startDate}T${allDay ? '00:00' : startTime}`).getTime();
    const after = new Date(`${date}T${allDay ? '00:00' : time}`).getTime();
    const end = new Date(`${endDate}T${allDay ? '00:00' : endTime}`).getTime() + (after - before);
    const w = localWall(end);
    setStartDate(date);
    setStartTime(time);
    setEndDate(w.slice(0, 10));
    if (!allDay) setEndTime(w.slice(11));
  };

  const draft = (): EventDraft | null => {
    if (!title.trim()) {
      setProblem('Give it a name.');
      return null;
    }
    const start = allDay ? startDate : `${startDate}T${startTime}`;
    const end = allDay ? addDaysKey(endDate, 1) : `${endDate}T${endTime}`;
    if (end < start || (allDay && endDate < startDate)) {
      setProblem('It ends before it starts.');
      return null;
    }
    return {
      calendarId,
      title: title.trim(),
      location: location.trim() || null,
      notes: notes.trim() || null,
      allDay,
      start,
      end,
      tz: deviceZone(),
      repeat: buildRepeat(kind, startDate, ev?.repeat ?? null, ends, until, count),
      remind,
    };
  };

  /** For "all of them": the series' own first day, moved as this occurrence was moved. */
  const forSeries = (d: EventDraft): Partial<EventDraft> => {
    const timesSame =
      allDay === initial.allDay && startDate === initial.startDate && endDate === initial.endDate && (allDay || (startTime === initial.startTime && endTime === initial.endTime));
    const { start: _s, end: _e, tz: _t, allDay: _a, ...rest } = d;
    if (timesSame || !ev)
      return { ...rest, repeat: kind === 'keep' ? buildRepeat('keep', ev?.start.slice(0, 10) ?? startDate, ev?.repeat ?? null, ends, until, count) : rest.repeat };
    const dayShift = Math.round((fromKey(startDate).getTime() - fromKey(initial.startDate).getTime()) / 86_400_000);
    const firstDay = addDaysKey(ev.start.slice(0, 10), dayShift);
    if (allDay) {
      const length = Math.round((fromKey(endDate).getTime() - fromKey(startDate).getTime()) / 86_400_000) + 1;
      return { ...d, start: firstDay, end: addDaysKey(firstDay, length), repeat: buildRepeat(kind, firstDay, ev.repeat, ends, until, count) };
    }
    const length = new Date(`${endDate}T${endTime}`).getTime() - new Date(`${startDate}T${startTime}`).getTime();
    const end = localWall(new Date(`${firstDay}T${startTime}`).getTime() + length);
    return { ...d, start: `${firstDay}T${startTime}`, end, repeat: buildRepeat(kind, firstDay, ev.repeat, ends, until, count) };
  };

  const save = async (scope?: Scope) => {
    const d = draft();
    if (!d) return;
    if (!ev) {
      await run(async () => (await calendar.addEvent(d), close()));
      return;
    }
    if (repeating && !scope) {
      setAsking('save');
      return;
    }
    const body = scope === 'all' || !repeating ? (repeating ? forSeries(d) : d) : d;
    await run(async () => (await calendar.saveEvent(ev.id, body, repeating ? scope : undefined, occ?.start), close()));
  };

  const remove = async (scope?: Scope) => {
    if (!ev) return close();
    if (repeating && !scope) {
      setAsking('delete');
      return;
    }
    if (!repeating && !confirm(`Delete "${ev.title}"?`)) return;
    await run(async () => (await calendar.deleteEvent(ev.id, repeating ? scope : undefined, occ?.start), close()));
  };

  return (
    <div className="calendar cal-editor">
      <button className="btn subtle" onClick={close}>
        ‹ Back
      </button>
      <h2>{ev ? 'Event' : 'New event'}</h2>
      <Field label="Name">
        <input value={title} autoFocus={!ev} placeholder="Dentist, Sam's birthday…" onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <label className="row cal-check">
        <Toggle on={allDay} label="All day" onChange={setAllDay} />
        <span>All day</span>
      </label>
      <div className="cal-when">
        <Field label={allDay ? 'From' : 'Starts'}>
          <span className="row wrap">
            <input type="date" value={startDate} onChange={(e) => e.target.value && moveStart(e.target.value, startTime)} />
            {!allDay && <input type="time" value={startTime} onChange={(e) => e.target.value && moveStart(startDate, e.target.value)} />}
          </span>
        </Field>
        <Field label={allDay ? 'To' : 'Ends'}>
          <span className="row wrap">
            <input type="date" value={endDate} onChange={(e) => e.target.value && setEndDate(e.target.value)} />
            {!allDay && <input type="time" value={endTime} onChange={(e) => e.target.value && setEndTime(e.target.value)} />}
          </span>
        </Field>
      </div>
      <Field label="Repeats">
        <select value={kind} onChange={(e) => setKind(e.target.value as RepeatKind)}>
          <option value="none">Does not repeat</option>
          <option value="daily">Every day</option>
          <option value="weekdays">Every weekday (Mon to Fri)</option>
          <option value="weekly">Every week on {wd}</option>
          <option value="monthlyDay">Every month on day {Number(startDate.slice(8))}</option>
          <option value="monthlyNth">
            Every month on the {ordinal(nth)} {wd}
          </option>
          <option value="yearly">Every year on {fromKey(startDate).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}</option>
          {ev?.repeat && kindOf(ev.repeat) === 'keep' && <option value="keep">As it is: {repeatText(ev.repeat, ev.start)}</option>}
        </select>
      </Field>
      {kind !== 'none' && (
        <Field label="Until">
          <span className="row wrap">
            <select value={ends} onChange={(e) => setEnds(e.target.value as typeof ends)}>
              <option value="never">No end</option>
              <option value="until">A date</option>
              <option value="count">A number of times</option>
            </select>
            {ends === 'until' && <input type="date" value={until} min={startDate} onChange={(e) => setUntil(e.target.value)} />}
            {ends === 'count' && (
              <input type="number" min={1} max={10000} value={count} style={{ width: '6rem' }} onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))} />
            )}
          </span>
        </Field>
      )}
      <RemindPicker value={remind} allDay={allDay} prefs={state.reminders} onChange={setRemind} />
      {own.length > 1 && (
        <Field label="Calendar">
          <select value={calendarId} onChange={(e) => setCalendarId(e.target.value)}>
            {own.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Where">
        <input value={location} placeholder="Optional" onChange={(e) => setLocation(e.target.value)} />
      </Field>
      <Field label="Notes">
        <textarea value={notes} rows={3} placeholder="Optional" onChange={(e) => setNotes(e.target.value)} />
      </Field>

      {asking ? (
        <div className="card cal-scope">
          <p>{asking === 'save' ? 'Change which?' : 'Delete which?'}</p>
          <div className="row wrap">
            <button className="btn" disabled={busy} onClick={() => void (asking === 'save' ? save('one') : remove('one'))}>
              Only this one
            </button>
            <button className="btn" disabled={busy} onClick={() => void (asking === 'save' ? save('following') : remove('following'))}>
              This and later ones
            </button>
            <button className={`btn${asking === 'delete' ? ' danger' : ''}`} disabled={busy} onClick={() => void (asking === 'save' ? save('all') : remove('all'))}>
              All of them
            </button>
            <button className="btn subtle" onClick={() => setAsking(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="row wrap cal-actions">
          <button className="btn primary" disabled={busy} onClick={() => void save()}>
            {ev ? 'Save' : 'Add'}
          </button>
          <button className="btn subtle" onClick={close}>
            Cancel
          </button>
          <span className="grow" />
          {ev && (
            <button className="btn subtle danger" disabled={busy} onClick={() => void remove()}>
              Delete
            </button>
          )}
        </div>
      )}
      {problem && <p className="banner">{problem}</p>}
    </div>
  );
}

/* ---------------------------------------------------------------- calendars */

function Calendars({ state, onClose }: { state: CalendarState; onClose: () => void }) {
  const close = useBackStep(onClose);
  const now = useNow();
  const { busy, problem, run } = useAction();
  const [newName, setNewName] = useState('');
  const prefs = state.reminders;
  const setPrefs = (patch: Partial<Reminders>) => void run(() => calendar.setReminders({ ...patch, asked: true }));

  return (
    <div className="calendar cal-settings">
      <button className="btn subtle" onClick={close}>
        ‹ Back
      </button>
      <h2>Calendars</h2>

      <section className="card">
        <div className="row between">
          <strong>Reminders</strong>
          <Toggle on={prefs.enabled} label="Reminders before events" onChange={(enabled) => setPrefs({ enabled })} />
        </div>
        <p className="meta">
          Each waits for a good moment like any reminder and holds back during a game, until a few minutes before the event starts. Any event can have its own.
        </p>
        {prefs.enabled && (
          <>
            <div className="cal-field">
              <span className="cal-label">Usually, for an event at a time</span>
              <OffsetChips value={prefs.timed} allDay={false} onChange={(timed) => setPrefs({ timed })} />
            </div>
            <div className="cal-field">
              <span className="cal-label">Usually, for an all-day event</span>
              <OffsetChips value={prefs.allDay} allDay onChange={(allDay) => setPrefs({ allDay })} />
            </div>
          </>
        )}
      </section>

      <h3>Your calendars</h3>
      {state.calendars.map((c) => (
        <CalendarRow key={c.id} c={c} now={now} onlyOwn={c.kind === 'own' && state.calendars.filter((x) => x.kind === 'own').length === 1} />
      ))}
      <div className="row wrap">
        <input className="grow" value={newName} placeholder="New calendar, e.g. Work" aria-label="New calendar's name" onChange={(e) => setNewName(e.target.value)} />
        <button className="btn" disabled={busy || !newName.trim()} onClick={() => void run(async () => (await calendar.addCalendar(newName.trim()), setNewName('')))}>
          Add
        </button>
      </div>

      <AddLink />
      <ImportFile own={state.calendars.filter((c) => c.kind === 'own')} />
      {problem && <p className="banner">{problem}</p>}
    </div>
  );
}

function CalendarRow({ c, now, onlyOwn }: { c: CalendarInfo; now: number; onlyOwn: boolean }) {
  const { busy, problem, run } = useAction();
  const [name, setName] = useState(c.name);
  useEffect(() => setName(c.name), [c.name]);
  const nextColour = COLORS[(COLORS.indexOf(c.color) + 1) % COLORS.length]!;
  return (
    <div className={`card cal-cal${c.hidden ? ' hidden' : ''}`}>
      <div className="row">
        <button
          className="cal-swatch"
          style={{ background: c.color }}
          aria-label="Change its colour"
          title="Change its colour"
          onClick={() => void run(() => calendar.saveCalendar(c.id, { color: nextColour }))}
        />
        <input
          className="grow"
          value={name}
          aria-label="Calendar's name"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name.trim() !== c.name && void run(() => calendar.saveCalendar(c.id, { name: name.trim() }))}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <Toggle on={!c.hidden} label={`Show ${c.name}`} onChange={(on) => void run(() => calendar.saveCalendar(c.id, { hidden: !on }))} />
      </div>
      <p className="meta">
        {c.events} event{c.events === 1 ? '' : 's'}
        {c.kind === 'link' && (
          <>
            {' '}
            · read from {c.link}
            {c.fetchedAt ? `, fetched ${ago(c.fetchedAt, now)}` : ''}
          </>
        )}
        {c.hidden && ' · hidden, and no reminders'}
      </p>
      {c.error && <p className="banner">Could not fetch it: {c.error}</p>}
      {!c.hidden && (
        <label className="row cal-check">
          <Toggle
            on={c.remind === null || c.remind.length > 0}
            label={`Reminders for ${c.name}`}
            onChange={(on) => void run(() => calendar.saveCalendar(c.id, { remind: on ? null : [] }))}
          />
          <span>Remind me about its events{c.remind && c.remind.length === 0 ? ' (off: only events given their own reminders)' : ''}</span>
        </label>
      )}
      <div className="row wrap">
        {c.kind === 'link' && (
          <button className="btn subtle" disabled={busy} onClick={() => void run(() => calendar.refresh(c.id))}>
            {busy ? 'Fetching…' : 'Fetch now'}
          </button>
        )}
        {!onlyOwn && (
          <button
            className="btn subtle danger"
            disabled={busy}
            onClick={() => {
              const what =
                c.kind === 'link'
                  ? `Remove "${c.name}"? Its events go from here; the calendar itself is not touched.`
                  : `Delete "${c.name}" and its ${c.events} event${c.events === 1 ? '' : 's'}? This cannot be undone.`;
              if (confirm(what)) void run(() => calendar.deleteCalendar(c.id));
            }}
          >
            {c.kind === 'link' ? 'Remove' : 'Delete'}
          </button>
        )}
      </div>
      {problem && <p className="banner">{problem}</p>}
    </div>
  );
}

function AddLink() {
  const { busy, problem, run } = useAction();
  const [url, setUrl] = useState('');
  const [done, setDone] = useState('');
  return (
    <section className="card">
      <strong>Add a calendar by its link</strong>
      <p className="meta">
        Google, Outlook and Apple each give a calendar a private address that calendar apps can read. Paste it here and its events show beside yours, kept up to date about every
        six hours and whenever you open this screen. It stays read-only here.
      </p>
      <details>
        <summary>Where to find the link</summary>
        <ul className="cal-help">
          <li>
            <strong>Google Calendar</strong> (on a computer):{' '}
            <a href="https://calendar.google.com/calendar/r/settings" target="_blank" rel="noreferrer">
              Settings
            </a>{' '}
            → your calendar under "Settings for my calendars" → Integrate calendar → <em>Secret address in iCal format</em>.
          </li>
          <li>
            <strong>Outlook</strong>:{' '}
            <a href="https://outlook.live.com/calendar/0/options/calendar/SharedCalendars" target="_blank" rel="noreferrer">
              Settings → Calendar → Shared calendars
            </a>{' '}
            → Publish a calendar → <em>ICS</em> link.
          </li>
          <li>
            <strong>Apple (iCloud)</strong>: in Calendar, share the calendar as a <em>Public Calendar</em> and copy its link (it starts with webcal://).
          </li>
        </ul>
        <p className="meta">The link is a key to that calendar: anybody with it can read it. It is kept on this PC and shown here only in part.</p>
      </details>
      <div className="row wrap">
        <input className="grow" value={url} placeholder="https://… or webcal://…" aria-label="Calendar link" onChange={(e) => setUrl(e.target.value)} />
        <button
          className="btn"
          disabled={busy || !url.trim()}
          onClick={() =>
            void run(async () => {
              const r = await calendar.addLink(url.trim());
              setUrl('');
              setDone(`Added ${r.calendar.name}, ${r.calendar.events} events.${r.problems.length ? ` ${r.problems.join('; ')}.` : ''}`);
            })
          }
        >
          {busy ? 'Fetching…' : 'Add'}
        </button>
      </div>
      {done && <p className="meta">{done}</p>}
      {problem && <p className="banner">{problem}</p>}
    </section>
  );
}

function ImportFile({ own }: { own: CalendarInfo[] }) {
  const { busy, problem, setProblem, run } = useAction();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [into, setInto] = useState('new');
  const [name, setName] = useState('');
  const [done, setDone] = useState('');

  const pick = async (f: File | undefined) => {
    setPreview(null);
    setDone('');
    setProblem('');
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) {
      setProblem('That file is over 10MB.');
      return;
    }
    const text = await f.text();
    setFile({ name: f.name, text });
    const p = await run(() => calendar.preview(text));
    if (p) {
      setPreview(p);
      setName(p.name ?? f.name.replace(/\.ics$/i, ''));
    }
  };

  return (
    <section className="card">
      <strong>Import a file (.ics)</strong>
      <p className="meta">Events from a calendar exported as a file: they become yours to edit. Importing the same file again updates what changed rather than adding it twice.</p>
      <input type="file" accept=".ics,text/calendar" aria-label="Calendar file" onChange={(e) => void pick(e.target.files?.[0])} />
      {preview && file && (
        <div className="cal-preview">
          <p>
            <strong>{preview.events}</strong> event{preview.events === 1 ? '' : 's'}
            {preview.repeating ? `, ${preview.repeating} repeating` : ''}
            {preview.first && preview.last ? `, from ${fromKey(preview.first).toLocaleDateString()} to ${fromKey(preview.last).toLocaleDateString()}` : ''}.
          </p>
          {preview.sample.length > 0 && (
            <ul className="meta">
              {preview.sample.map((s, i) => (
                <li key={i}>
                  {s.title} · {fromKey(s.start.slice(0, 10)).toLocaleDateString()}
                </li>
              ))}
            </ul>
          )}
          {preview.problems.map((p) => (
            <p key={p} className="meta">
              ⚠ {p}
            </p>
          ))}
          <div className="row wrap">
            <select value={into} aria-label="Into which calendar" onChange={(e) => setInto(e.target.value)}>
              <option value="new">Into a new calendar</option>
              {own.map((c) => (
                <option key={c.id} value={c.id}>
                  Into {c.name}
                </option>
              ))}
            </select>
            {into === 'new' && <input className="grow" value={name} aria-label="New calendar's name" onChange={(e) => setName(e.target.value)} />}
            <button
              className="btn primary"
              disabled={busy || preview.events === 0}
              onClick={() =>
                void run(async () => {
                  const r = await calendar.importFile(file.text, into, into === 'new' ? name.trim() || undefined : undefined);
                  setDone(`Imported into ${r.calendar.name}: ${r.added} added${r.updated ? `, ${r.updated} updated` : ''}.`);
                  setPreview(null);
                  setFile(null);
                })
              }
            >
              Import
            </button>
          </div>
        </div>
      )}
      {done && <p className="meta">{done}</p>}
      {problem && <p className="banner">{problem}</p>}
    </section>
  );
}
