/**
 * What is coming up, on the Dashboard: today's events, then the next six
 * days', at most eight. A row opens the calendar on its day.
 */
import type { ChangeScope } from '@app/live';
import { useNow } from '@app/clock';
import { goTo } from '@app/nav';
import { useAsync } from '@app/useAsync';
import { calendar, dayKey, dayTitle, daysOf, whenOn, type Occurrence } from './calendar-api';
import './calendar.css';

const WATCH = ['calendar'] as unknown as ChangeScope[];

export default function UpcomingPanel() {
  const now = useNow();
  const state = useAsync(() => calendar.upcoming(7), [], WATCH);
  const head = (
    <div className="row between" style={{ alignItems: 'baseline' }}>
      <h2 style={{ margin: 0 }}>Coming up</h2>
      <button className="btn subtle" onClick={() => goTo('calendar')}>
        Calendar
      </button>
    </div>
  );
  if (state.loading)
    return (
      <>
        {head}
        <div className="empty">loading…</div>
      </>
    );
  if (state.error)
    return (
      <>
        {head}
        <div className="empty">Could not load: {state.error.message}</div>
      </>
    );
  const today = dayKey(new Date(now));
  // Each occurrence on the first of its days still to come; one under way counts as today.
  const rows: { day: string; o: Occurrence }[] = [];
  for (const o of state.data?.occurrences ?? []) {
    if (o.endMs <= now && !(o.allDay && o.end > today)) continue;
    const day = daysOf(o).find((d) => d >= today) ?? today;
    rows.push({ day, o });
  }
  rows.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : Number(b.o.allDay) - Number(a.o.allDay) || a.o.startMs - b.o.startMs));
  if (!rows.length)
    return (
      <>
        {head}
        <div className="empty">Nothing in the next week.</div>
      </>
    );
  const shown = rows.slice(0, 8);
  let lastDay = '';
  return (
    <div className="cal-panel">
      {head}
      {shown.map(({ day, o }) => {
        const head = day !== lastDay ? dayTitle(day, today).split(' · ')[0] : null;
        lastDay = day;
        return (
          <div key={o.key}>
            {head && <div className="meta cal-panel-day">{head}</div>}
            <button className="card panel-row cal-panel-row" onClick={() => goTo('calendar', { focus: `day:${day}` })} style={{ textAlign: 'left', width: '100%' }}>
              <span className="cal-dot" style={{ background: o.color }} aria-hidden />
              <span className="grow">
                <span className="title">{o.title}</span>
                <span className="meta">
                  {' '}
                  · {whenOn(o, day)}
                  {o.location ? ` · ${o.location}` : ''}
                </span>
              </span>
            </button>
          </div>
        );
      })}
      {rows.length > shown.length && (
        <button className="btn subtle" onClick={() => goTo('calendar')}>
          and {rows.length - shown.length} more
        </button>
      )}
    </div>
  );
}
