/**
 * The Trips tab: a list of trips, and each trip as a map, its flights, its
 * places and its checklist.
 *
 * The flights are the part that does the most, and two things about them are
 * worth knowing before reading the code:
 *
 *   - **Times are at the airport.** Every time on a flight is shown in that
 *     airport's zone, the way a boarding pass shows it, with the day beside it
 *     when landing is on another day.
 *   - **The screen says where each fact came from.** Typed, or from the flight
 *     service and how long ago, and when it will look again. A gate number with
 *     no age is the stale-number-as-fact this app is built against.
 *
 * What a trip puts on your to-do list is listed under each flight and each
 * checklist item, so a task appearing on the Dashboard has a visible reason.
 */
import { useEffect, useState } from 'react';
import { useNow } from '@app/clock';
import { useAsync } from '@app/useAsync';
import { popStep, pushStep } from '@app/view-history';
import type { FeatureViewProps } from '@app/features/index';
import { TripMap } from './TripMap';
import './trips.css';
import {
  dayAt,
  dayOf,
  fromNow,
  KIND_GLYPH,
  KIND_LABEL,
  spaced,
  statusIsBad,
  statusText,
  timeAt,
  trips,
  type Flight,
  type FoundPlace,
  type LinkState,
  type PlaceKind,
  type Trip,
  type TripsState,
} from './trips-api';

/** One way of reporting a failed write, everywhere on this screen. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  async function run<T>(what: () => Promise<T>): Promise<T | undefined> {
    setProblem('');
    setBusy(true);
    try {
      return await what();
    } catch (error) {
      setProblem((error as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, problem, setProblem, run };
}

export default function Trips({ local, focus, onFocused }: FeatureViewProps) {
  useNow();
  const state = useAsync(() => trips.get());
  const [openId, setOpenId] = useState<string | null>(null);
  const [step, setStep] = useState<number | null>(null);

  function open(id: string) {
    setStep(pushStep(() => {
      setOpenId(null);
      setStep(null);
    }));
    setOpenId(id);
    window.scrollTo(0, 0);
  }
  function close() {
    if (step !== null) popStep(step);
    else setOpenId(null);
  }

  // The Dashboard card asks for a trip by id.
  useEffect(() => {
    if (!focus || !state.data) return;
    if (state.data.trips.some((t) => t.id === focus)) setOpenId(focus);
    onFocused?.();
  }, [focus, state.data, onFocused]);

  if (state.loading) return <div className="empty">loading…</div>;
  if (state.error) return <div className="banner">Could not load trips: {state.error.message}</div>;
  const data = state.data;
  if (!data) return null;

  const trip = data.trips.find((t) => t.id === openId);
  if (trip) return <TripPage trip={trip} data={data} onBack={close} onChanged={state.reload} />;

  return <TripList data={data} local={local} onOpen={open} onChanged={state.reload} />;
}

/* ---------------------------------------------------------------- */
/* The list                                                           */
/* ---------------------------------------------------------------- */

function TripList({
  data,
  local,
  onOpen,
  onChanged,
}: {
  data: TripsState;
  local: boolean;
  onOpen: (id: string) => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const act = useAction();
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = data.trips.filter((t) => !t.end || t.end >= today);
  const past = data.trips.filter((t) => t.end && t.end < today).reverse();

  return (
    <section className="trips">
      <h2>Trips</h2>
      {act.problem && <div className="banner">{act.problem}</div>}

      <form
        className="card row wrap"
        style={{ gap: '.4rem' }}
        onSubmit={async (e) => {
          e.preventDefault();
          const made = await act.run(() => trips.create({ name, start: start || null, end: end || null }));
          if (made) {
            setName('');
            setStart('');
            setEnd('');
            onChanged();
            onOpen(made.id);
          }
        }}
      >
        <input className="grow" value={name} placeholder="New trip, e.g. Tokyo in March" aria-label="Trip name" onChange={(e) => setName(e.target.value)} />
        <input type="date" value={start} aria-label="First day (optional)" onChange={(e) => setStart(e.target.value)} />
        <input type="date" value={end} aria-label="Last day (optional)" onChange={(e) => setEnd(e.target.value)} />
        <button className="btn primary" type="submit" disabled={act.busy || !name.trim()}>
          Add trip
        </button>
      </form>
      <div className="meta" style={{ marginTop: 4 }}>
        Dates are optional: a trip with flights takes its days from them.
      </div>

      {upcoming.length === 0 && past.length === 0 && <div className="empty">No trips yet.</div>}
      {upcoming.map((t) => (
        <TripRow key={t.id} trip={t} onOpen={() => onOpen(t.id)} />
      ))}
      {past.length > 0 && (
        <details style={{ marginTop: 16 }}>
          <summary className="meta">Past trips ({past.length})</summary>
          {past.map((t) => (
            <TripRow key={t.id} trip={t} onOpen={() => onOpen(t.id)} />
          ))}
        </details>
      )}

      <SettingsCard data={data} local={local} onChanged={onChanged} />
    </section>
  );
}

function TripRow({ trip, onOpen }: { trip: Trip; onOpen: () => void }) {
  const now = Date.now();
  const next = trip.flights.find((f) => (f.live?.arrives ?? f.arrives) > now);
  return (
    <button className="card trips-row" onClick={onOpen}>
      <div className="title">{trip.name}</div>
      <div className="meta">
        {trip.start ? `${dayOf(trip.start)}${trip.end && trip.end !== trip.start ? ` – ${dayOf(trip.end)}` : ''}` : 'no dates yet'}
        {' · '}
        {trip.flights.length} flight{trip.flights.length === 1 ? '' : 's'} · {trip.places.length} place
        {trip.places.length === 1 ? '' : 's'}
      </div>
      {next && (
        <div className={`meta${statusIsBad(next) ? ' urgent' : ''}`}>
          Next: {spaced(next.number)} {next.from.iata} → {next.to.iata}, {fromNow(next.live?.departs ?? next.departs, now)}
          {next.live?.status ? ` · ${statusText(next.live.status)}` : ''}
        </div>
      )}
    </button>
  );
}

/* ---------------------------------------------------------------- */
/* One trip                                                           */
/* ---------------------------------------------------------------- */

function TripPage({ trip, data, onBack, onChanged }: { trip: Trip; data: TripsState; onBack: () => void; onChanged: () => void }) {
  const act = useAction();
  const [focus, setFocus] = useState<{ lat: number; lon: number; at: number } | null>(null);
  const [name, setName] = useState(trip.name);
  useEffect(() => setName(trip.name), [trip.name]);

  const save = (body: Parameters<typeof trips.update>[1]) => act.run(() => trips.update(trip.id, body)).then(onChanged);

  return (
    <section className="trips">
      <button className="btn subtle" onClick={onBack}>
        ‹ Trips
      </button>
      {act.problem && <div className="banner">{act.problem}</div>}

      <div className="card">
        <input
          className="trips-name"
          value={name}
          aria-label="Trip name"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== trip.name && void save({ name })}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <div className="row wrap" style={{ gap: '.4rem', marginTop: 6, alignItems: 'center' }}>
          <span className="meta">From</span>
          <input type="date" value={trip.typedStart ?? ''} aria-label="First day" onChange={(e) => void save({ start: e.target.value || null })} />
          <span className="meta">to</span>
          <input type="date" value={trip.typedEnd ?? ''} aria-label="Last day" onChange={(e) => void save({ end: e.target.value || null })} />
        </div>
        {!trip.typedStart && trip.start && (
          <div className="meta" style={{ marginTop: 4 }}>
            From its flights: {dayOf(trip.start)}
            {trip.end && trip.end !== trip.start ? ` – ${dayOf(trip.end)}` : ''}
          </div>
        )}
      </div>

      <TripMap flights={trip.flights} places={trip.places} focus={focus} />

      <h3>Flights</h3>
      {trip.flights.map((f) => (
        <FlightCard key={f.id} trip={trip} flight={f} hasKey={data.hasKey} onChanged={onChanged} />
      ))}
      <AddFlight trip={trip} hasKey={data.hasKey} onChanged={onChanged} />

      <h3>Places</h3>
      <Places trip={trip} onChanged={onChanged} onShow={(p) => setFocus({ lat: p.lat, lon: p.lon, at: Date.now() })} />

      <h3>Checklist</h3>
      <Checklist trip={trip} onChanged={onChanged} />

      <div style={{ marginTop: 24 }}>
        <button
          className="btn subtle danger"
          disabled={act.busy}
          onClick={async () => {
            if (!confirm(`Delete "${trip.name}"? Its tasks that are not done yet are deleted too; finished ones stay.`)) return;
            const ok = await act.run(() => trips.remove(trip.id));
            if (ok) {
              onBack();
              onChanged();
            }
          }}
        >
          Delete trip
        </button>
      </div>
    </section>
  );
}

const TASK_WORDS: Record<LinkState, string> = { made: 'on your list', deleted: 'deleted, so not made again', none: '' };

function FlightCard({ trip, flight: f, hasKey, onChanged }: { trip: Trip; flight: Flight; hasKey: boolean; onChanged: () => void }) {
  const act = useAction();
  const now = Date.now();
  const departs = f.live?.departs ?? f.departs;
  const arrives = f.live?.arrives ?? f.arrives;
  const moved = f.live !== null && Math.abs(f.live.departs - f.departs) >= 60_000;
  const otherDay = dayAt(arrives, f.to.tz) !== dayAt(departs, f.from.tz);
  const status = statusText(f.live?.status);

  const detail = (key: 'confirmation' | 'seat', placeholder: string) => (
    <input
      defaultValue={f[key] ?? ''}
      placeholder={placeholder}
      aria-label={placeholder}
      style={{ width: key === 'seat' ? '6rem' : '10rem' }}
      onBlur={(e) => {
        if (e.target.value.trim() === (f[key] ?? '')) return;
        void act.run(() => trips.editFlight(trip.id, f.id, { [key]: e.target.value })).then(onChanged);
      }}
    />
  );

  let source: string;
  if (f.checkError) source = `Last check failed: ${f.checkError}`;
  else if (f.checkedAt) {
    source = `From the flight service, ${fromNow(f.checkedAt, now)}`;
    if (f.nextCheckAt) source += ` · looks again ${fromNow(f.nextCheckAt, now)}`;
  } else if (f.filledBy === 'typed') {
    source = hasKey
      ? `Typed in · live status starts ${f.nextCheckAt ? fromNow(f.nextCheckAt, now) : 'a day before'}`
      : 'Typed in · live status needs a flight service key (below the trip list)';
  } else source = 'From the flight service';

  const tasks = [
    f.tasks.checkIn !== 'none' && `Check-in task ${TASK_WORDS[f.tasks.checkIn]}`,
    f.tasks.leave !== 'none' && `Leave-for-the-airport task ${TASK_WORDS[f.tasks.leave]}`,
  ].filter(Boolean);

  return (
    <div className="card trips-flight">
      <div className="row between" style={{ alignItems: 'flex-start', gap: '.6rem' }}>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="title">
            {spaced(f.number)} · {f.from.iata} → {f.to.iata}
            {f.airline && <span className="meta"> · {f.airline}</span>}
          </div>
          <div>
            {dayAt(departs, f.from.tz)} · {timeAt(departs, f.from.tz)} → {timeAt(arrives, f.to.tz)}
            {otherDay && <span className="meta"> ({dayAt(arrives, f.to.tz)})</span>}
          </div>
          {moved && (
            <div className="meta urgent">
              Was {timeAt(f.departs, f.from.tz)}: {f.live!.departs > f.departs ? 'delayed' : 'earlier'} by{' '}
              {Math.round(Math.abs(f.live!.departs - f.departs) / 60_000)} minutes
            </div>
          )}
          <div className="meta">
            {f.from.city || f.from.name} to {f.to.city || f.to.name} · leaves {fromNow(departs, now)}
          </div>
          {(status || f.live?.terminal || f.live?.gate) && (
            <div className={statusIsBad(f) ? 'urgent' : ''} style={{ marginTop: 4 }}>
              {[status, f.live?.terminal && `Terminal ${f.live.terminal}`, f.live?.gate && `Gate ${f.live.gate}`]
                .filter(Boolean)
                .join(' · ')}
            </div>
          )}
          {(f.live?.arrivalGate || f.live?.baggageBelt) && (
            <div className="meta">
              Arriving{f.live.arrivalTerminal ? ` terminal ${f.live.arrivalTerminal}` : ''}
              {f.live.arrivalGate ? `, gate ${f.live.arrivalGate}` : ''}
              {f.live.baggageBelt ? `, bags on belt ${f.live.baggageBelt}` : ''}
            </div>
          )}
        </div>
        <div className="row" style={{ gap: '.3rem' }}>
          {hasKey && (
            <button
              className="btn subtle"
              disabled={act.busy}
              title="Ask the flight service now (counts as a lookup)"
              onClick={() => void act.run(() => trips.refreshFlight(trip.id, f.id)).then(onChanged)}
            >
              {act.busy ? '…' : '↻'}
            </button>
          )}
          <button
            className="btn subtle"
            disabled={act.busy}
            aria-label={`Remove ${spaced(f.number)}`}
            onClick={async () => {
              if (!confirm(`Remove ${spaced(f.number)}? Its tasks that are not done yet go too.`)) return;
              await act.run(() => trips.removeFlight(trip.id, f.id));
              onChanged();
            }}
          >
            ✕
          </button>
        </div>
      </div>

      <div className="row wrap" style={{ gap: '.4rem', marginTop: 8 }}>
        {detail('confirmation', 'Confirmation code')}
        {detail('seat', 'Seat')}
      </div>
      <div className={`meta${f.checkError ? ' urgent' : ''}`} style={{ marginTop: 6 }}>
        {source}
      </div>
      {tasks.length > 0 && <div className="meta">{tasks.join(' · ')}</div>}
      {act.problem && <div className="banner">{act.problem}</div>}
    </div>
  );
}

function AddFlight({ trip, hasKey, onChanged }: { trip: Trip; hasKey: boolean; onChanged: () => void }) {
  const act = useAction();
  const [number, setNumber] = useState('');
  const [date, setDate] = useState(trip.start ?? '');
  const [manual, setManual] = useState(!hasKey);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [departTime, setDepartTime] = useState('');
  const [arriveTime, setArriveTime] = useState('');
  const [arriveDate, setArriveDate] = useState('');
  const [legs, setLegs] = useState<Array<{ index: number; from: string; to: string; departs: number; tz: string }> | null>(null);

  useEffect(() => setManual(!hasKey), [hasKey]);

  async function submit(leg?: number) {
    const result = await trips.addFlight(trip.id, {
      number,
      date,
      leg,
      manual: manual || undefined,
      ...(manual ? { from, to, departTime, arriveTime, arriveDate: arriveDate || undefined } : {}),
    });
    if ('legs' in result) {
      setLegs(result.legs);
      return;
    }
    if ('needsTimes' in result) {
      setManual(true);
      act.setProblem(result.needsTimes);
      return;
    }
    setNumber('');
    setFrom('');
    setTo('');
    setDepartTime('');
    setArriveTime('');
    setArriveDate('');
    setLegs(null);
    setManual(!hasKey);
    onChanged();
  }

  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        void act.run(() => submit());
      }}
    >
      <div className="row wrap" style={{ gap: '.4rem' }}>
        <input value={number} placeholder="Flight, e.g. UA 123" aria-label="Flight number" onChange={(e) => setNumber(e.target.value)} style={{ width: '9rem' }} />
        <input type="date" value={date} aria-label="Date it leaves" onChange={(e) => setDate(e.target.value)} />
        <button className="btn primary" type="submit" disabled={act.busy || !number.trim() || !date}>
          {act.busy ? 'Adding…' : 'Add flight'}
        </button>
      </div>

      {manual && (
        <>
          <div className="row wrap" style={{ gap: '.4rem', marginTop: 8 }}>
            <input value={from} placeholder="From (DEN)" aria-label="Departure airport code" maxLength={3} onChange={(e) => setFrom(e.target.value.toUpperCase())} style={{ width: '6.5rem' }} />
            <input type="time" value={departTime} aria-label="Leaves at, local time there" onChange={(e) => setDepartTime(e.target.value)} />
            <span className="meta">→</span>
            <input value={to} placeholder="To (SFO)" aria-label="Arrival airport code" maxLength={3} onChange={(e) => setTo(e.target.value.toUpperCase())} style={{ width: '6.5rem' }} />
            <input type="time" value={arriveTime} aria-label="Lands at, local time there" onChange={(e) => setArriveTime(e.target.value)} />
            <input type="date" value={arriveDate} aria-label="Date it lands, if not the same day" onChange={(e) => setArriveDate(e.target.value)} />
          </div>
          <div className="meta" style={{ marginTop: 4 }}>
            Times as on the booking, at each airport. The landing date can be left empty: landing earlier in the day than it left reads as the next day.
          </div>
        </>
      )}
      {hasKey && (
        <button type="button" className="btn subtle" style={{ marginTop: 6 }} onClick={() => setManual(!manual)}>
          {manual ? 'Look it up instead' : 'Type the times instead'}
        </button>
      )}
      {!hasKey && (
        <div className="meta" style={{ marginTop: 4 }}>
          With a flight service key (below the trip list), the number and date are enough, and delays and gates are tracked.
        </div>
      )}

      {legs && (
        <div className="row wrap" style={{ gap: '.3rem', marginTop: 8 }}>
          {legs.map((l) => (
            <button key={l.index} type="button" className="btn" onClick={() => void act.run(() => submit(l.index))}>
              {l.from} → {l.to}, {timeAt(l.departs, l.tz)}
            </button>
          ))}
        </div>
      )}
      {act.problem && <div className="banner" style={{ marginTop: 8 }}>{act.problem}</div>}
    </form>
  );
}

const KINDS: PlaceKind[] = ['stay', 'visit', 'food', 'other'];

function Places({ trip, onChanged, onShow }: { trip: Trip; onChanged: () => void; onShow: (p: { lat: number; lon: number }) => void }) {
  const act = useAction();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<PlaceKind>('visit');
  const [hits, setHits] = useState<FoundPlace[] | null>(null);

  return (
    <>
      {trip.places.map((p) => (
        <div key={p.id} className="card row between" style={{ gap: '.6rem', alignItems: 'flex-start' }}>
          <button className="grow trips-place" onClick={() => onShow(p)} title="Show on the map">
            <div className="title">
              {KIND_GLYPH[p.kind]} {p.name}
            </div>
            {p.address && <div className="meta truncate">{p.address}</div>}
          </button>
          <select
            value={p.kind}
            aria-label="What kind of place"
            onChange={(e) => void act.run(() => trips.editPlace(trip.id, p.id, { kind: e.target.value as PlaceKind })).then(onChanged)}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <a
            className="btn subtle"
            href={`https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=17/${p.lat}/${p.lon}`}
            target="_blank"
            rel="noreferrer"
            title="Open in OpenStreetMap"
          >
            ↗
          </a>
          <button
            className="btn subtle"
            aria-label={`Remove ${p.name}`}
            onClick={() => void act.run(() => trips.removePlace(trip.id, p.id)).then(onChanged)}
          >
            ✕
          </button>
        </div>
      ))}

      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          const found = await act.run(() => trips.searchPlaces(query.trim()));
          setHits(found?.places ?? null);
        }}
      >
        <div className="row wrap" style={{ gap: '.4rem' }}>
          <input className="grow" value={query} placeholder="Hotel, address, museum…" aria-label="Find a place" onChange={(e) => setQuery(e.target.value)} />
          <select value={kind} aria-label="What kind of place" onChange={(e) => setKind(e.target.value as PlaceKind)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <button className="btn" type="submit" disabled={act.busy || query.trim().length < 2}>
            {act.busy ? 'Looking…' : 'Find'}
          </button>
        </div>
        {hits && hits.length === 0 && <div className="empty">Nothing matched "{query}".</div>}
        {hits?.map((h, i) => (
          <button
            key={i}
            type="button"
            className="trips-hit"
            onClick={async () => {
              const ok = await act.run(() => trips.addPlace(trip.id, { ...h, kind }));
              if (ok) {
                setHits(null);
                setQuery('');
                onChanged();
              }
            }}
          >
            <div className="title">{h.name}</div>
            <div className="meta truncate">{h.address}</div>
          </button>
        ))}
        {act.problem && <div className="banner">{act.problem}</div>}
        <div className="meta" style={{ marginTop: 4 }}>
          Searched on OpenStreetMap, from the PC.
        </div>
      </form>
    </>
  );
}

/** The offsets offered for a checklist item, in the order a trip runs. */
const WHEN: Array<{ value: string; label: string }> = [
  { value: '', label: 'no date' },
  { value: '-7', label: 'a week before' },
  { value: '-3', label: '3 days before' },
  { value: '-2', label: '2 days before' },
  { value: '-1', label: 'the day before' },
  { value: '0', label: 'the first day' },
  { value: '1', label: 'the second day' },
];

function Checklist({ trip, onChanged }: { trip: Trip; onChanged: () => void }) {
  const act = useAction();
  const [text, setText] = useState('');
  const [when, setWhen] = useState('-1');

  return (
    <div className="card">
      {trip.checklist.length === 0 && <div className="empty">Nothing yet. Each item becomes a task, dated from the trip's first day.</div>}
      {trip.checklist.map((c) => (
        <div key={c.id} className="row between" style={{ gap: '.6rem', padding: '4px 0' }}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div>{c.text}</div>
            <div className="meta">
              {c.when}
              {c.task === 'made' ? ' · on your list' : c.task === 'deleted' ? ' · task deleted, not made again' : ''}
            </div>
          </div>
          <button className="btn subtle" aria-label={`Remove ${c.text}`} onClick={() => void act.run(() => trips.removeItem(trip.id, c.id)).then(onChanged)}>
            ✕
          </button>
        </div>
      ))}
      <form
        className="row wrap"
        style={{ gap: '.4rem', marginTop: 8 }}
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await act.run(() => trips.addItem(trip.id, { text, offsetDays: when === '' ? null : Number(when) }));
          if (ok) {
            setText('');
            onChanged();
          }
        }}
      >
        <input className="grow" value={text} placeholder="Pack the charger, book a taxi…" aria-label="Checklist item" onChange={(e) => setText(e.target.value)} />
        <select value={when} aria-label="When" onChange={(e) => setWhen(e.target.value)}>
          {WHEN.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
        </select>
        <button className="btn" type="submit" disabled={act.busy || !text.trim()}>
          Add
        </button>
      </form>
      {!trip.start && trip.checklist.length > 0 && (
        <div className="meta" style={{ marginTop: 6 }}>
          This trip has no first day yet, so its items are on your list with no date. Add a flight or a date and they get one.
        </div>
      )}
      {act.problem && <div className="banner">{act.problem}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Settings                                                           */
/* ---------------------------------------------------------------- */

function SettingsCard({ data, local, onChanged }: { data: TripsState; local: boolean; onChanged: () => void }) {
  const act = useAction();
  const [key, setKey] = useState('');
  const s = data.settings;
  const set = (patch: Parameters<typeof trips.settings>[0]) => void act.run(() => trips.settings(patch)).then(onChanged);
  const number = (value: number, label: string, apply: (n: number) => void, unit: string) => (
    <label className="row" style={{ gap: '.4rem', alignItems: 'center' }}>
      <input
        type="number"
        defaultValue={value}
        aria-label={label}
        style={{ width: '5.5rem' }}
        onBlur={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n) && n !== value) apply(n);
        }}
      />
      <span className="meta">{unit}</span>
    </label>
  );

  return (
    <>
      <h3 style={{ marginTop: 28 }}>Reminders</h3>
      <div className="card trips-settings">
        <label className="row" style={{ gap: '.5rem', alignItems: 'center' }}>
          <input type="checkbox" checked={s.checkInTask} onChange={(e) => set({ checkInTask: e.target.checked })} />
          <span className="grow">A task to check in, when check-in opens</span>
          {number(s.checkInHours, 'Hours before departure that check-in opens', (n) => set({ checkInHours: n }), 'hours before')}
        </label>
        <label className="row" style={{ gap: '.5rem', alignItems: 'center' }}>
          <input type="checkbox" checked={s.leaveTask} onChange={(e) => set({ leaveTask: e.target.checked })} />
          <span className="grow">A task to leave for the airport</span>
        </label>
        <div className="row wrap" style={{ gap: '1rem', paddingLeft: '1.6rem' }}>
          <span className="row" style={{ gap: '.4rem', alignItems: 'center' }}>
            <span className="meta">Domestic</span>
            {number(s.leaveDomesticMinutes, 'Minutes before a domestic flight', (n) => set({ leaveDomesticMinutes: n }), 'min before')}
          </span>
          <span className="row" style={{ gap: '.4rem', alignItems: 'center' }}>
            <span className="meta">International</span>
            {number(s.leaveInternationalMinutes, 'Minutes before an international flight', (n) => set({ leaveInternationalMinutes: n }), 'min before')}
          </span>
        </div>
        <label className="row" style={{ gap: '.5rem', alignItems: 'center' }}>
          <input type="checkbox" checked={s.alerts} onChange={(e) => set({ alerts: e.target.checked })} />
          <span className="grow">Tell me about delays, gate changes and cancellations</span>
        </label>
        <div className="meta">
          Switching a reminder off stops new ones; the tasks already made stay. Changing a time moves those tasks too, unless you changed their dates yourself.
          Alerts wait for a good moment like any reminder, except within three hours of leaving, when they come straight away.
          The airport lead time follows the timetable, not delays: bag drop closes on time however late the plane is.
        </div>
      </div>

      <h3 style={{ marginTop: 22 }}>Live flight status</h3>
      <div className="card trips-settings">
        <div>
          {data.hasKey ? 'A key is set.' : 'No key yet: flights are typed in and not tracked.'} {data.usage.used} of {data.usage.budget} lookups
          used this month.
        </div>
        <div className="meta">
          Uses AeroDataBox through RapidAPI. Sign up at{' '}
          <a href="https://rapidapi.com/aedbx-aedbx/api/aerodatabox" target="_blank" rel="noreferrer">
            rapidapi.com/aedbx-aedbx/api/aerodatabox
          </a>
          , subscribe to the free Basic plan, and paste the key from its page here. A flight is looked up once when added, then about
          twenty times on its day. Their free plan counts units rather than requests, so check what a flight-status lookup costs on
          their pricing page and set the limit below to stay inside it.
        </div>
        {local ? (
          <form
            className="row wrap"
            style={{ gap: '.4rem' }}
            onSubmit={(e) => {
              e.preventDefault();
              set({ apiKey: key });
              setKey('');
            }}
          >
            <input
              className="grow"
              type="password"
              autoComplete="off"
              value={key}
              placeholder={data.hasKey ? 'Set: paste a new one to replace it' : 'RapidAPI key'}
              aria-label="RapidAPI key"
              onChange={(e) => setKey(e.target.value)}
            />
            <button className="btn" type="submit" disabled={act.busy || !key.trim()}>
              Save key
            </button>
            {data.hasKey && (
              <button type="button" className="btn subtle" disabled={act.busy} onClick={() => set({ apiKey: '' })}>
                Remove key
              </button>
            )}
          </form>
        ) : (
          <div className="meta">The key can only be set from the PC running the server.</div>
        )}
        <label className="row" style={{ gap: '.5rem', alignItems: 'center' }}>
          <span className="grow">Most lookups a month</span>
          {number(s.monthlyBudget, 'Most lookups a month', (n) => set({ monthlyBudget: n }), 'lookups')}
        </label>
        {act.problem && <div className="banner">{act.problem}</div>}
      </div>

      <div className="meta" style={{ marginTop: 16 }}>
        Maps are OpenStreetMap's, and the tiles come from their servers as you look. Place searches go through the PC to
        OpenStreetMap's Nominatim. Flight numbers and dates go to AeroDataBox only when a key is set.
      </div>
    </>
  );
}
