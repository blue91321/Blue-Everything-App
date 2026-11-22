/**
 * The week on the Dashboard (2026-11-20): today and the six days after it,
 * events and tasks with a due date together (Canvas assignments are tasks), in
 * one of three looks chosen on the card and kept per device, since a phone and
 * a monitor want different ones:
 *
 * - **Week**: seven columns, everything on a day stacked in its column. Below
 *   560px of card it becomes a row per day, since seven columns of a phone are
 *   45px each.
 * - **Grid**: a week view by the hour, all-day events and tasks due in rows
 *   above it. Blocks are as tall and as wide as their text needs
 *   (`grid-layout.ts`), and a narrow card shows three or four days at a time
 *   with arrows rather than seven unreadable ones.
 * - **Today**: today in full, then a line for each day after.
 *
 * A task's box ticks it off (the task itself, so the Dashboard's list and
 * Canvas's "handed in" agree); its name opens it where it came from, or on
 * the Tasks screen. An event opens the calendar on its day.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { ChangeScope } from '@app/live';
import { useNow } from '@app/clock';
import { goTo } from '@app/nav';
import { useAsync } from '@app/useAsync';
import { addDaysKey, calendar, dayKey, daysOf, dueDay, fromKey, sourceName, TASK_COLOR, timeText, whenOn, type DueTask, type Occurrence } from './calendar-api';
import { hourRange, placeDay } from './grid-layout';
import { TaskName, Tick } from './task-bits';
import './calendar.css';

const WATCH = ['calendar', 'tasks'] as unknown as ChangeScope[];
const LAYOUT_KEY = 'calendar.card-layout';
const WEEKS_KEY = 'calendar.card-weeks';
const START_KEY = 'calendar.card-start';
const DAY_MS = 86_400_000;

/** How many weeks Week and Grid show, 1 to 4, per device. */
const WEEK_CHOICES = [1, 2, 3, 4] as const;

/** Which day is at the far left of Week and Grid: today, yesterday, or the last Saturday, Sunday or Monday. Sunday unless chosen. */
type WeekStart = 'today' | 'yesterday' | 'sat' | 'sun' | 'mon';
const WEEK_STARTS: { id: WeekStart; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'sat', label: 'Saturday' },
  { id: 'sun', label: 'Sunday' },
  { id: 'mon', label: 'Monday' },
];

type Layout = 'week' | 'grid' | 'today';
const LAYOUTS: { id: Layout; label: string; hint: string }[] = [
  { id: 'today', label: 'Today', hint: 'Today in full, a line for each day after' },
  { id: 'week', label: 'Week', hint: 'Seven columns, one per day' },
  { id: 'grid', label: 'Grid', hint: 'By the hour, like a week view' },
];

type Item =
  | { kind: 'event'; key: string; allDay: boolean; at: number; o: Occurrence }
  | { kind: 'task'; key: string; allDay: boolean; at: number; t: DueTask };

interface Day {
  key: string;
  items: Item[];
}

function readLayout(): Layout {
  try {
    const v = localStorage.getItem(LAYOUT_KEY);
    return v === 'grid' || v === 'today' ? v : 'week';
  } catch {
    return 'week';
  }
}

function readWeeks(): number {
  try {
    const n = Number(localStorage.getItem(WEEKS_KEY));
    return (WEEK_CHOICES as readonly number[]).includes(n) ? n : 1;
  } catch {
    return 1;
  }
}

function readStart(): WeekStart {
  try {
    const v = localStorage.getItem(START_KEY);
    return WEEK_STARTS.some((w) => w.id === v) ? (v as WeekStart) : 'sun';
  } catch {
    return 'sun';
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Per device, and only a nicety.
  }
}

/** The first day Week and Grid show, by the chosen start. */
function firstDayOf(today: string, start: WeekStart): string {
  const dow = fromKey(today).getDay();
  const back = { today: 0, yesterday: 1, sun: dow, mon: (dow + 6) % 7, sat: (dow + 1) % 7 }[start];
  return addDaysKey(today, -back);
}

/** Whole days from one key to another, whatever a clock change does to the hours between. */
const daysBetween = (a: string, b: string) => Math.round((fromKey(b).getTime() - fromKey(a).getTime()) / DAY_MS);

/** "Nov 15 – 21", or across a month "Nov 29 – Dec 5": a week's label when more than one is shown. */
function weekLabel(first: string, last: string): string {
  const f = fromKey(first);
  const l = fromKey(last);
  const month = (d: Date) => d.toLocaleDateString(undefined, { month: 'short' });
  return f.getMonth() === l.getMonth() ? `${month(f)} ${f.getDate()} – ${l.getDate()}` : `${month(f)} ${f.getDate()} – ${month(l)} ${l.getDate()}`;
}

/** Days in sevens. */
const weeksOf = (days: Day[]): Day[][] => Array.from({ length: Math.ceil(days.length / 7) }, (_, i) => days.slice(i * 7, i * 7 + 7));

/** Everything on each day from `first`, `count` of them: all-day things first, then by time. A task due on a day sits with them. */
function buildDays(occurrences: Occurrence[], due: DueTask[], first: string, count: number): Day[] {
  const keys = Array.from({ length: count }, (_, i) => addDaysKey(first, i));
  const map = new Map<string, Item[]>(keys.map((k) => [k, []]));
  for (const o of occurrences) {
    for (const d of daysOf(o)) map.get(d)?.push({ kind: 'event', key: `${o.key}@${d}`, allDay: o.allDay || whenOn(o, d) === 'All day', at: o.startMs, o });
  }
  for (const t of due) map.get(dueDay(t))?.push({ kind: 'task', key: `task:${t.id}`, allDay: t.allDay, at: t.dueAt, t });
  for (const list of map.values()) list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.at - b.at || Number(a.kind === 'task') - Number(b.kind === 'task'));
  return keys.map((key) => ({ key, items: map.get(key)! }));
}

const short = (at: number) => timeText(at).replace(/:00(?=\s|$)/, '');
const weekdayOf = (key: string) => fromKey(key).toLocaleDateString(undefined, { weekday: 'short' });
const dayHead = (key: string, today: string) => (key === today ? 'Today' : key === addDaysKey(today, 1) ? 'Tomorrow' : fromKey(key).toLocaleDateString(undefined, { weekday: 'long' }));
const colour = (item: Item) => (item.kind === 'event' ? item.o.color : TASK_COLOR);
const titleOf = (item: Item) => (item.kind === 'event' ? item.o.title : item.t.title);

/** When, in a few words: "10 AM", "All day", "due 11:59 PM", "due". */
function whenText(item: Item, day: string): string {
  if (item.kind === 'task') return item.t.allDay ? 'due' : `due ${timeText(item.t.dueAt)}`;
  const w = whenOn(item.o, day);
  return w === 'All day' ? 'All day' : w.startsWith('from') || w.startsWith('until') ? w : short(item.o.startMs);
}

/* ---------------------------------------------------------------- shared parts */

function openDay(day: string) {
  goTo('calendar', { focus: `day:${day}` });
}

/** One thing as a coloured chip: the week columns and the grid's all-day row. */
/** `time` false for none, or a string in place of the usual words. */
function Chip({ item, day, time = true }: { item: Item; day: string; time?: boolean | string }) {
  const style = { ['--c' as string]: colour(item) } as CSSProperties;
  const label = (
    <>
      {time !== false && <span className="cal-wchip-time">{typeof time === 'string' ? time : whenText(item, day)}</span>}
      <span className="cal-wchip-title">{titleOf(item)}</span>
    </>
  );
  if (item.kind === 'task')
    return (
      <div className={`cal-wchip task${item.t.done ? ' done' : ''}`} style={style} title={item.t.title}>
        <Tick t={item.t} />
        <TaskName t={item.t} className="cal-wchip-body">
          {label}
        </TaskName>
      </div>
    );
  return (
    <button className={`cal-wchip${item.allDay ? ' allday' : ''}`} style={style} onClick={() => openDay(day)} title={item.o.location ? `${item.o.title} · ${item.o.location}` : item.o.title}>
      <span className="cal-wchip-body">{label}</span>
    </button>
  );
}

/* ---------------------------------------------------------------- A: week */

function WeekStrip({ days, today }: { days: Day[]; today: string }) {
  const weeks = weeksOf(days);
  return (
    <>
      {weeks.map((week) => (
        <div key={week[0]!.key} className="cal-week-block">
          {weeks.length > 1 && <div className="cal-week-label">{weekLabel(week[0]!.key, week[week.length - 1]!.key)}</div>}
          <WeekRow days={week} today={today} />
        </div>
      ))}
    </>
  );
}

function WeekRow({ days, today }: { days: Day[]; today: string }) {
  return (
    <div className="cal-week">
      {days.map((d) => (
        <div key={d.key} className={`cal-week-day${d.key === today ? ' today' : d.key < today ? ' past' : ''}`}>
          <button className="cal-week-head" onClick={() => openDay(d.key)} aria-label={`${dayHead(d.key, today)}, open in the calendar`}>
            <span className="cal-week-wd">{d.key === today ? 'Today' : weekdayOf(d.key)}</span> <span className="cal-week-num">{Number(d.key.slice(8))}</span>
          </button>
          <div className="cal-week-items">
            {d.items.length ? d.items.map((it) => <Chip key={it.key} item={it} day={d.key} />) : <span className="cal-week-none">Nothing on</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- C: grid */

const HOUR_PX = 40;
/** Three lines: the time, and two of the name. Measured: 42px held the time and a line and a half, so a name was cut across its second line. */
const MIN_BLOCK = 56;

/** The card's own width, three ways, for the reason the weather graph gives: a pane not drawing delivers no ResizeObserver callbacks. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const measure = () => {
    const w = ref.current?.clientWidth ?? 0;
    setWidth((old) => (Math.abs(old - w) > 1 ? w : old));
  };
  useLayoutEffect(measure);
  useEffect(() => {
    window.addEventListener('resize', measure);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    if (ro && ref.current) ro.observe(ref.current);
    return () => {
      window.removeEventListener('resize', measure);
      ro?.disconnect();
    };
  }, []);
  return { ref, width };
}

const minutesOf = (at: number, day: string) => Math.round((at - fromKey(day).getTime()) / 60_000);

function TimeGrid({ days, today, now }: { days: Day[]; today: string; now: number }) {
  const { ref, width } = useWidth();
  // Seven columns want about 90px each to show a name; fewer, paged, when there is not room.
  const perPage = width === 0 || width >= 660 ? 7 : width >= 440 ? 4 : 3;
  // Paging starts on the page with today, not on a week start already gone.
  const [page, setPage] = useState<number | null>(null);
  const pages = Math.ceil(days.length / perPage);
  const todayAt = Math.max(0, days.findIndex((d) => d.key === today));
  const at = Math.min(page ?? Math.floor(todayAt / perPage), pages - 1);
  const pageDays = days.slice(at * perPage, at * perPage + perPage);
  // With room for seven, each week is its own grid, one under the next; without, the arrows page through every day.
  const stacked = perPage === 7;
  const chunks = stacked ? weeksOf(days) : [pageDays];
  // How many blocks may share a day's width: each at least 60px.
  const colWidth = width ? (width - 34) / (stacked ? 7 : pageDays.length) : 90;
  const maxCols = Math.max(1, Math.floor(colWidth / 60));

  // Tasks have a row of their own above the hours, as a calendar app puts them: a deadline is a moment, and
  // six of them at 11:59 pm drawn as blocks were six slivers at the foot of an otherwise empty evening.
  const events = (d: Day) => d.items.filter((i): i is Extract<Item, { kind: 'event' }> => i.kind === 'event' && !i.allDay);
  const spansOf = (d: Day) =>
    events(d).map((i) => {
      const start = Math.max(0, minutesOf(i.at, d.key));
      return { id: i.key, start, end: Math.min(24 * 60, minutesOf(i.o.endMs, d.key)) };
    });
  // One range for every day shown, so a page turn or the next week does not rescale the hours.
  const range = hourRange(days.flatMap(spansOf));
  const hours = Array.from({ length: range.to - range.from }, (_, i) => range.from + i);
  const allDayOf = (d: Day) => d.items.filter((i) => i.kind === 'event' && i.allDay);
  const dueOf = (d: Day) => d.items.filter((i) => i.kind === 'task');
  const chunk = (shown: Day[]) => {
  const placedByDay = new Map(shown.map((d) => [d.key, placeDay(spansOf(d), range.from, HOUR_PX, MIN_BLOCK, maxCols)]));
  // A block that starts late runs past midnight's line; the grid grows to hold it.
  const height = Math.max((range.to - range.from) * HOUR_PX, ...[...placedByDay.values()].flat().map((p) => p.top + p.height + 2));
  const anyTimed = shown.some((d) => events(d).length > 0);
  const anyAllDay = shown.some((d) => allDayOf(d).length > 0);
  const anyDue = shown.some((d) => dueOf(d).length > 0);
  // A narrow day column folds a long list of things due: names one word to a line, six deep, was a column you scroll past.
  const foldDue = colWidth < 120;
  const cols = { gridTemplateColumns: `34px repeat(${shown.length}, minmax(0, 1fr))` };

    return (
      <div key={shown[0]!.key} className="cal-tg-week">
        {stacked && chunks.length > 1 && <div className="cal-week-label">{weekLabel(shown[0]!.key, shown[shown.length - 1]!.key)}</div>}
      <div className="cal-tg-row" style={cols}>
        <span />
        {shown.map((d) => (
          <button key={d.key} className={`cal-tg-head${d.key === today ? ' today' : d.key < today ? ' past' : ''}`} onClick={() => openDay(d.key)}>
            {d.key === today ? 'Today' : weekdayOf(d.key)} <strong>{Number(d.key.slice(8))}</strong>
          </button>
        ))}
      </div>
      {anyAllDay && (
        <div className="cal-tg-row cal-tg-top" style={cols}>
          <span className="cal-tg-hour">all day</span>
          {shown.map((d) => (
            <div key={d.key} className="cal-tg-top-cell">
              {allDayOf(d).map((i) => (
                <Chip key={i.key} item={i} day={d.key} time={false} />
              ))}
            </div>
          ))}
        </div>
      )}
      {anyDue && (
        <div className="cal-tg-row cal-tg-top" style={cols}>
          <span className="cal-tg-hour">due</span>
          {shown.map((d) => (
            <div key={d.key} className="cal-tg-top-cell">
              {(foldDue && dueOf(d).length > 3 ? dueOf(d).slice(0, 2) : dueOf(d)).map((i) => (
                <Chip key={i.key} item={i} day={d.key} time={i.kind === 'task' && !i.t.allDay ? short(i.t.dueAt) : false} />
              ))}
              {foldDue && dueOf(d).length > 3 && (
                <button className="cal-tg-moredue" onClick={() => openDay(d.key)} title={dueOf(d).slice(2).map(titleOf).join('\n')}>
                  +{dueOf(d).length - 2} more due
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {!anyTimed ? (
        <p className="meta cal-tg-none">{!stacked ? 'Nothing at a set time on these days.' : chunks.length > 1 ? 'Nothing at a set time that week.' : 'Nothing at a set time this week.'}</p>
      ) : (
        <div className="cal-tg-row cal-tg-body" style={{ ...cols, height }}>
          <div className="cal-tg-hours">
            {hours.map((h) => (
              <span key={h} className="cal-tg-hour" style={{ top: (h - range.from) * HOUR_PX }}>
                {new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' })}
              </span>
            ))}
          </div>
          {shown.map((d) => {
            const placed = placedByDay.get(d.key)!;
            const byId = new Map(placed.map((p) => [p.id, p]));
            const nowMin = d.key === today ? minutesOf(now, d.key) : null;
            // A run of blocks too many to sit side by side gives its last column to a "+N" that opens the day,
            // so the count covers nothing; with room for one column only, the count sits at that block's foot.
            const overflow = new Map<number, { top: number; count: number; cols: number }>();
            for (const p of placed) {
              if (!p.hidden) continue;
              const run = placed.filter((q) => q.cluster === p.cluster);
              const o = overflow.get(p.cluster) ?? { top: Math.min(...run.map((q) => q.top)), count: 0, cols: p.cols };
              o.count += 1;
              overflow.set(p.cluster, o);
            }
            for (const [n, o] of overflow) {
              if (o.cols < 2) continue;
              for (const p of placed) if (p.cluster === n && !p.hidden && p.col === o.cols - 1) (p.hidden = true), (o.count += 1);
            }
            return (
              <div key={d.key} className={`cal-tg-col${d.key === today ? ' today' : d.key < today ? ' past' : ''}`}>
                {hours.map((h) => (
                  <span key={h} className="cal-tg-line" style={{ top: (h - range.from) * HOUR_PX }} />
                ))}
                {nowMin !== null && nowMin >= range.from * 60 && nowMin <= range.to * 60 && (
                  <span className="cal-tg-now" style={{ top: ((nowMin - range.from * 60) / 60) * HOUR_PX }} aria-hidden />
                )}
                {events(d).map((i) => {
                  const p = byId.get(i.key);
                  if (!p || p.hidden) return null;
                  const style = {
                    ['--c' as string]: i.o.color,
                    top: p.top,
                    height: p.height,
                    left: `calc(${(p.col / p.cols) * 100}% + 1px)`,
                    width: `calc(${100 / p.cols}% - 2px)`,
                  } as CSSProperties;
                  return (
                    <button key={i.key} className="cal-tg-block" style={style} onClick={() => openDay(d.key)} title={`${i.o.title} · ${whenOn(i.o, d.key)}`}>
                      <span className="cal-wchip-body">
                        <span className="cal-wchip-time">{whenText(i, d.key)}</span>
                        <span className="cal-wchip-title">{i.o.title}</span>
                      </span>
                    </button>
                  );
                })}
                {[...overflow.entries()].map(([n, o]) => (
                  <button
                    key={`more${n}`}
                    className={`cal-tg-more${o.cols < 2 ? ' corner' : ''}`}
                    style={
                      o.cols < 2
                        ? { top: o.top + MIN_BLOCK - 20 }
                        : { top: o.top, height: MIN_BLOCK, left: `calc(${((o.cols - 1) / o.cols) * 100}% + 1px)`, width: `calc(${100 / o.cols}% - 2px)` }
                    }
                    onClick={() => openDay(d.key)}
                    aria-label={`${o.count} more at this time, open the day`}
                  >
                    +{o.count} more
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}
      </div>
    );
  };

  return (
    <div ref={ref} className="cal-tg">
      {!stacked && pages > 1 && (
        <div className="row cal-tg-pager">
          <button className="btn subtle" aria-label="Earlier days" disabled={at === 0} onClick={() => setPage(at - 1)}>
            ‹
          </button>
          <span className="meta grow" style={{ textAlign: 'center' }}>
            {weekdayOf(pageDays[0]!.key)} {Number(pageDays[0]!.key.slice(8))} – {weekdayOf(pageDays[pageDays.length - 1]!.key)} {Number(pageDays[pageDays.length - 1]!.key.slice(8))}
          </span>
          <button className="btn subtle" aria-label="Later days" disabled={at >= pages - 1} onClick={() => setPage(at + 1)}>
            ›
          </button>
        </div>
      )}
      {chunks.map(chunk)}
    </div>
  );
}

/* ---------------------------------------------------------------- D: today */

/** "in 40m", "in 2h", "now": only for what starts within a few hours. */
function soon(item: Item, now: number): string | null {
  if (item.kind !== 'event' || item.allDay) return null;
  if (item.o.startMs <= now && item.o.endMs > now) return 'now';
  const mins = Math.round((item.o.startMs - now) / 60_000);
  if (mins < 0 || mins > 180) return null;
  return mins < 60 ? `in ${mins}m` : `in ${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ''}`;
}

/**
 * A later day as one line. More than two tasks due that day fold into one
 * "6 due by 11:59 PM" that opens the day, names on hover: a week of
 * assignments written out in full was a paragraph of amber.
 */
function LineItems({ d }: { d: Day }) {
  const events = d.items.filter((i): i is Extract<Item, { kind: 'event' }> => i.kind === 'event');
  const tasks = d.items.filter((i): i is Extract<Item, { kind: 'task' }> => i.kind === 'task');
  const fold = tasks.length > 2;
  const open = tasks.filter((i) => !i.t.done);
  const times = new Set(open.map((i) => (i.t.allDay ? 'day' : short(i.t.dueAt))));
  const by = times.size === 1 && !times.has('day') ? ` by ${[...times][0]}` : '';
  const parts: ReactNode[] = events.map((i) => (
    <button key={i.key} className="cal-link" onClick={() => openDay(d.key)}>
      {i.o.title}
      {!i.allDay && <span className="meta"> {short(i.o.startMs)}</span>}
    </button>
  ));
  if (fold)
    parts.push(
      <button key="due" className="cal-link task" onClick={() => openDay(d.key)} title={tasks.map((i) => `${i.t.done ? '✓ ' : ''}${i.t.title}`).join('\n')}>
        {open.length ? `${open.length} due${by}` : `${tasks.length} done`}
        {open.length && open.length < tasks.length ? <span className="meta"> ({tasks.length - open.length} done)</span> : null}
      </button>
    );
  else
    for (const i of tasks)
      parts.push(
        <span key={i.key} className={i.t.done ? 'done' : undefined}>
          <TaskName t={i.t} className="cal-link task">
            {i.t.title} {i.t.allDay ? 'due' : `due ${short(i.t.dueAt)}`}
          </TaskName>
        </span>
      );
  if (!parts.length) return <span className="meta">nothing</span>;
  return (
    <>
      {parts.map((p, n) => (
        <span key={n}>
          {n > 0 && <span className="meta"> · </span>}
          {p}
        </span>
      ))}
    </>
  );
}

function TodayFirst({ days, today, now }: { days: Day[]; today: string; now: number }) {
  const [first, ...rest] = days;
  // What has finished today goes quiet rather than away: it is still today's.
  const past = (i: Item) => (i.kind === 'event' ? !i.allDay && i.o.endMs <= now : i.t.done);
  return (
    <>
      <div className="cal-today">
        <button className="cal-today-head" onClick={() => openDay(today)}>
          Today · {fromKey(today).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
        </button>
        {first!.items.length === 0 && <p className="meta">Nothing on today.</p>}
        {first!.items.map((i) => {
          const s = soon(i, now);
          const meta =
            i.kind === 'event'
              ? i.o.location
              : [i.t.notes?.split('\n')[0], sourceName(i.t.source)].filter(Boolean).join(' · ') || null;
          return (
            <div key={i.key} className={`cal-today-row${past(i) ? ' past' : ''}`} style={{ ['--c' as string]: colour(i) } as CSSProperties}>
              <span className={`cal-today-time${i.kind === 'task' ? ' task' : ''}`}>{whenText(i, today)}</span>
              {i.kind === 'task' ? <Tick t={i.t} /> : <span className="cal-dot" style={{ background: i.o.color }} aria-hidden />}
              <span className="grow cal-today-what">
                {i.kind === 'task' ? (
                  <TaskName t={i.t} className="cal-link">
                    {i.t.title}
                  </TaskName>
                ) : (
                  <button className="cal-link" onClick={() => openDay(today)}>
                    {i.o.title}
                  </button>
                )}
                {meta && <span className="meta"> · {meta}</span>}
                {s && <span className="cal-soon"> · {s}</span>}
              </span>
            </div>
          );
        })}
      </div>
      {rest.map((d) => (
        <div key={d.key} className="cal-line">
          <button className="cal-line-day" onClick={() => openDay(d.key)}>
            {weekdayOf(d.key)} {Number(d.key.slice(8))}
          </button>
          <span className="cal-line-items">
            <LineItems d={d} />
          </span>
        </div>
      ))}
    </>
  );
}

/* ---------------------------------------------------------------- the card */

export default function WeekPanel() {
  const now = useNow();
  const today = dayKey(new Date(now));
  const [layout, setLayoutState] = useState<Layout>(readLayout);
  const [weeks, setWeeksState] = useState<number>(readWeeks);
  const [weekStart, setStartState] = useState<WeekStart>(readStart);
  const [options, setOptions] = useState(false);
  const setWeeks = (n: number) => (setWeeksState(n), remember(WEEKS_KEY, String(n)));
  const setWeekStart = (w: WeekStart) => (setStartState(w), remember(START_KEY, w));
  const setLayout = (l: Layout) => {
    setLayoutState(l);
    try {
      localStorage.setItem(LAYOUT_KEY, l);
    } catch {
      // Per device, and only a nicety.
    }
  };
  // Week and Grid run from the chosen first day for the chosen weeks; Today always from today for seven days.
  // One request covers both, so switching between them asks nothing.
  const first = firstDayOf(today, weekStart);
  const listStart = first < today ? first : today;
  const weekEnd = addDaysKey(first, 7 * weeks);
  const todayEnd = addDaysKey(today, 7);
  const count = daysBetween(listStart, weekEnd > todayEnd ? weekEnd : todayEnd);
  // Asked again when the day turns, so midnight moves the week on.
  const state = useAsync(() => calendar.upcoming(count, fromKey(listStart).getTime()), [listStart, count], WATCH);
  const all = useMemo(() => buildDays(state.data?.occurrences ?? [], state.data?.due ?? [], listStart, count), [state.data, listStart, count]);
  const weekDays = all.filter((d) => d.key >= first && d.key < weekEnd);
  const todayDays = all.filter((d) => d.key >= today && d.key < todayEnd);

  const head = (
    <div className="row wrap cal-card-head">
      <h2 style={{ margin: 0 }}>{layout === 'today' || weeks === 1 ? 'This week' : `${weeks} weeks`}</h2>
      <span className="grow" />
      <div className="cal-switch" role="group" aria-label="How the week is shown">
        {LAYOUTS.map((l) => (
          <button key={l.id} className={`btn subtle${layout === l.id ? ' on' : ''}`} aria-pressed={layout === l.id} title={l.hint} onClick={() => setLayout(l.id)}>
            {l.label}
          </button>
        ))}
      </div>
      <button className="btn subtle" onClick={() => goTo('calendar')}>
        Calendar
      </button>
      <button className={`btn subtle${options ? ' on' : ''}`} aria-expanded={options} aria-label="Week card settings" title="How many weeks, and which day they start on" onClick={() => setOptions(!options)}>
        ⚙
      </button>
    </div>
  );

  const settings = options && (
    <div className="cal-card-options">
      <div className="cal-card-opt">
        <span className="cal-card-opt-label">Weeks shown</span>
        <div className="cal-switch" role="group" aria-label="Weeks shown">
          {WEEK_CHOICES.map((n) => (
            <button key={n} className={`btn subtle${weeks === n ? ' on' : ''}`} aria-pressed={weeks === n} onClick={() => setWeeks(n)}>
              {n}
            </button>
          ))}
        </div>
      </div>
      <div className="cal-card-opt">
        <span className="cal-card-opt-label">Week starts on</span>
        <div className="cal-switch" role="group" aria-label="Week starts on">
          {WEEK_STARTS.map((w) => (
            <button key={w.id} className={`btn subtle${weekStart === w.id ? ' on' : ''}`} aria-pressed={weekStart === w.id} onClick={() => setWeekStart(w.id)}>
              {w.label}
            </button>
          ))}
        </div>
      </div>
      <p className="meta">For Week and Grid, on this device. Today always starts with today.</p>
    </div>
  );

  return (
    <div className="cal-panel cal-card">
      {head}
      {settings}
      {state.loading ? (
        <div className="empty">loading…</div>
      ) : state.error ? (
        <div className="empty">Could not load: {state.error.message}</div>
      ) : layout === 'grid' ? (
        <TimeGrid days={weekDays} today={today} now={now} />
      ) : layout === 'today' ? (
        <TodayFirst days={todayDays} today={today} now={now} />
      ) : (
        <WeekStrip days={weekDays} today={today} />
      )}
    </div>
  );
}
