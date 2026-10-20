/**
 * The next flight on the Dashboard: when it leaves, from where, and whether
 * that has changed.
 *
 * "Next" is the first flight that has not landed yet, so a flight in the air
 * stays here until it is down. Nothing at all when no flight is ahead: an empty
 * card on the Dashboard every day between trips is a card you learn to ignore.
 */
import { useNow } from '@app/clock';
import { useAsync } from '@app/useAsync';
import { goTo } from '@app/nav';
import { dayAt, fromNow, spaced, statusIsBad, statusText, timeAt, trips } from './trips-api';

export default function NextFlightPanel() {
  useNow();
  const state = useAsync(() => trips.get());
  const data = state.data;
  if (state.loading) return <div className="empty">loading…</div>;
  if (state.error) return <div className="empty">Could not load: {state.error.message}</div>;
  if (!data) return null;

  const now = Date.now();
  const ahead = data.trips
    .flatMap((t) => t.flights.map((f) => ({ f, trip: t })))
    .filter(({ f }) => (f.live?.arrives ?? f.arrives) > now)
    .sort((a, b) => a.f.departs - b.f.departs);
  const next = ahead[0];
  if (!next) return <div className="empty">No flights coming up.</div>;
  const { f, trip } = next;
  const departs = f.live?.departs ?? f.departs;
  const moved = f.live !== null && Math.abs(f.live.departs - f.departs) >= 60_000;
  const status = statusText(f.live?.status);

  return (
    <button className="card panel-row" onClick={() => goTo('trips', { focus: trip.id })} style={{ textAlign: 'left', width: '100%' }}>
      <div className="title">
        {spaced(f.number)} · {f.from.iata} → {f.to.iata}
      </div>
      <div className="meta">
        {dayAt(departs, f.from.tz)} · {timeAt(departs, f.from.tz)}
        {moved && <span className="urgent"> (was {timeAt(f.departs, f.from.tz)})</span>} · {fromNow(departs, now)}
      </div>
      {(status || f.live?.gate || f.live?.terminal) && (
        <div className={`meta${statusIsBad(f) ? ' urgent' : ''}`}>
          {[status, f.live?.terminal && `terminal ${f.live.terminal}`, f.live?.gate && `gate ${f.live.gate}`]
            .filter(Boolean)
            .join(' · ')}
        </div>
      )}
      <div className="meta">{trip.name}</div>
    </button>
  );
}
