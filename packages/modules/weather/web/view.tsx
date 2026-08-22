/**
 * The Weather tab: where it is, when it looks, and the next few days.
 *
 * The panel is the thing you actually use; this is where the two settings live
 * and where you find out *why* the panel says what it says — which is the same
 * division the Voice tab draws between the switch and the screen that explains
 * what the switch is doing.
 */
import { useState } from 'react';
import { useAsync } from '@app/useAsync';
import { ageOf, dayName, weather, type Place, type RefreshMode, type Units } from './weather-api';

const MODES: Array<{ id: RefreshMode; label: string; hint: string }> = [
  { id: 'daily', label: 'Once a day', hint: 'checks when you open the app and a day has passed' },
  { id: 'manual', label: 'Only when I ask', hint: 'never goes and looks on its own' },
];

export default function Weather() {
  /*
   * No scope: this package's data is not one core announces about, so there is
   * nothing to subscribe to. Refreshing is explicit here — the button, or a read
   * that finds the reading a day old.
   */
  const state = useAsync(() => weather.get(), [], []);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  const data = state.data;

  async function run(what: () => Promise<unknown>) {
    setProblem('');
    setBusy(true);
    try {
      await what();
      state.reload();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (state.loading) return <div className="empty">loading…</div>;
  if (!data) return <div className="banner">Could not read the weather settings.</div>;

  return (
    <section>
      <h2>Weather</h2>

      {problem && <div className="banner">{problem}</div>}

      {/*
        The reading first, because it is what you came for. Even in manual mode
        with a reading three days old — labelled as three days old, which is the
        part that makes showing it honest rather than misleading.
      */}
      {data.place && data.reading && (
        <div className="card">
          <div className="row between" style={{ alignItems: 'flex-start', gap: '.8rem' }}>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="title">
                {data.place.name}
                {data.place.detail && <span className="meta"> · {data.place.detail}</span>}
              </div>
              <div style={{ fontSize: '2.4rem', lineHeight: 1.2, marginTop: 6 }}>
                {data.reading.glyph} {data.reading.temperature}°{data.units.toUpperCase()}
              </div>
              <div className="meta" style={{ marginTop: 2 }}>
                {data.reading.label} · feels like {data.reading.feelsLike}°
              </div>
              <div className="meta" style={{ marginTop: 2 }}>
                {data.reading.humidity}% humidity · wind {data.reading.windSpeed}{' '}
                {data.units === 'f' ? 'mph' : 'km/h'}
              </div>
            </div>

            <RefreshButton busy={busy} onPress={() => void run(weather.refreshNow)} />
          </div>

          <div className="meta" style={{ marginTop: 10 }}>
            Checked {ageOf(data.fetchedAt)}
            {/*
              Said out loud rather than left to be inferred from the mode. In
              `daily` the next read does the work, and in `manual` nothing will
              — which is exactly the thing somebody would otherwise sit waiting
              for.
            */}
            {data.mode === 'manual'
              ? ' — it will not check again on its own.'
              : data.due
                ? ' — due, so opening this again will check.'
                : ' — it will check again a day after that.'}
          </div>

          {/*
            An error *and* a reading: the fetch failed but what you saw last is
            still here. Either alone would be worse — a blank screen loses the
            information, and a stale number with nothing admitting it is stale
            is the failure this whole app is against.
          */}
          {data.error && (
            <div className="meta urgent" style={{ marginTop: 6 }}>
              Last check failed: {data.error}
            </div>
          )}

          {data.reading.days.length > 0 && (
            <div className="row" style={{ gap: '.6rem', marginTop: 14, flexWrap: 'wrap' }}>
              {data.reading.days.map((day) => (
                <div key={day.date} style={{ minWidth: 76, textAlign: 'center' }}>
                  <div className="meta">{dayName(day.date)}</div>
                  <div style={{ fontSize: '1.4rem' }} title={day.label}>
                    {day.glyph}
                  </div>
                  <div className="meta">
                    {day.high}° / {day.low}°
                  </div>
                  {/* Only when there is a real chance — a row of "0%" under every
                      day is noise pretending to be information. */}
                  {day.rain !== null && day.rain > 0 && <div className="meta">💧 {day.rain}%</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* No reading yet, but a place is set: manual mode before the first press,
          or a first fetch that failed. Both want the button, not an apology. */}
      {data.place && !data.reading && (
        <div className="card">
          <div className="row between" style={{ alignItems: 'center' }}>
            <div className="grow">
              <div className="title">{data.place.name}</div>
              <div className="meta" style={{ marginTop: 4 }}>
                {data.error ?? 'Nothing fetched yet.'}
              </div>
            </div>
            <RefreshButton busy={busy} onPress={() => void run(weather.refreshNow)} />
          </div>
        </div>
      )}

      <PlacePicker
        current={data.place}
        busy={busy}
        onChoose={(place) => void run(() => weather.setPlace(place))}
      />

      <h3 style={{ marginTop: 22, marginBottom: 6 }}>When to check</h3>
      <div className="card">
        <div className="row wrap" style={{ gap: '.35rem' }}>
          {MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              className={data.mode === mode.id ? 'btn primary' : 'btn subtle'}
              disabled={busy}
              onClick={() => void run(() => weather.update({ mode: mode.id }))}
            >
              {mode.label}
            </button>
          ))}
        </div>
        <div className="meta" style={{ marginTop: 8 }}>
          {MODES.find((mode) => mode.id === data.mode)?.hint}
        </div>
        {/*
          Two buttons rather than a slider, the same call the live panel's scope
          made: named alternatives, where a slider would have two positions, no
          labels at the stops, and no way to show which one is live.

          And the honest bit about what "once a day" means here — it is a
          staleness window, not something running on a clock. Somebody watching
          for a fetch at midnight should know it will not come.
        */}
        <div className="meta" style={{ marginTop: 6 }}>
          Nothing runs on a timer either way. "Once a day" means the next time you
          open the app after a day has passed — so a PC left alone costs no requests at all.
          The button above always works.
        </div>
      </div>

      <h3 style={{ marginTop: 22, marginBottom: 6 }}>Units</h3>
      <div className="card">
        <div className="row wrap" style={{ gap: '.35rem' }}>
          {(['f', 'c'] as Units[]).map((unit) => (
            <button
              key={unit}
              type="button"
              className={data.units === unit ? 'btn primary' : 'btn subtle'}
              disabled={busy}
              onClick={() => void run(() => weather.update({ units: unit }))}
            >
              {unit === 'f' ? '°F and mph' : '°C and km/h'}
            </button>
          ))}
        </div>
      </div>

      <div className="meta" style={{ marginTop: 16 }}>
        Forecasts come from Open-Meteo, which needs no account and no key. Your coordinates are sent to
        them each time it checks; nothing else is.
      </div>
    </section>
  );
}

/**
 * The button, in one place because it appears in three.
 *
 * Always rendered, never hidden by the mode — see the note in the routes. It is
 * the only way to fetch in `manual`, and the way to get a reading *now* in
 * `daily`.
 */
function RefreshButton({ busy, onPress }: { busy: boolean; onPress: () => void }) {
  return (
    <button className="btn primary" style={{ flex: 'none' }} disabled={busy} onClick={onPress}>
      {busy ? 'Checking…' : 'Check now'}
    </button>
  );
}

/**
 * Type a place, pick from what comes back.
 *
 * A search rather than two number boxes, because nobody knows their own
 * latitude — the setup step would have been "go and look it up somewhere else",
 * which is the friction this app removes wherever it can. The list is shown
 * rather than the first hit taken, since there are a great many places called
 * Springfield.
 */
function PlacePicker({
  current,
  busy,
  onChoose,
}: {
  current: Place | null;
  busy: boolean;
  onChoose: (place: Place) => void;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Place[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [problem, setProblem] = useState('');

  async function search() {
    if (query.trim().length < 2) return;
    setProblem('');
    setSearching(true);
    try {
      const found = await weather.search(query);
      setHits(found.places);
    } catch (error) {
      setProblem((error as Error).message);
      setHits(null);
    } finally {
      setSearching(false);
    }
  }

  return (
    <>
      <h3 style={{ marginTop: 22, marginBottom: 6 }}>{current ? 'Somewhere else' : 'Where are you?'}</h3>
      <div className="card">
        <form
          className="row"
          style={{ gap: '.4rem' }}
          onSubmit={(event) => {
            // A real form, so Enter submits — typing a town and pressing Enter
            // is the whole interaction, and making it need the mouse would be
            // a small daily annoyance.
            event.preventDefault();
            void search();
          }}
        >
          <input
            className="grow"
            value={query}
            placeholder="Town or city"
            aria-label="Search for a place"
            onChange={(event) => setQuery(event.target.value)}
          />
          <button className="btn" type="submit" disabled={searching || query.trim().length < 2}>
            {searching ? 'Looking…' : 'Search'}
          </button>
        </form>

        {problem && <div className="banner">{problem}</div>}

        {hits !== null && hits.length === 0 && (
          <div className="empty" style={{ marginTop: 8 }}>
            Nothing matched "{query}".
          </div>
        )}

        {hits?.map((place) => (
          <div
            className="row between"
            key={`${place.latitude},${place.longitude}`}
            style={{ alignItems: 'center', marginTop: 8 }}
          >
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="title truncate">{place.name}</div>
              <div className="meta truncate">{place.detail}</div>
            </div>
            <button
              className="btn subtle"
              disabled={busy}
              onClick={() => {
                onChoose(place);
                setHits(null);
                setQuery('');
              }}
            >
              Use this
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
