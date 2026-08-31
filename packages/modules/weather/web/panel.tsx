/**
 * The weather, beside the Dashboard.
 *
 * The tab is where you set things up; this is the answer in the corner of your
 * eye, so it holds one temperature, one line of words, and the button — and
 * nothing else. The four-day forecast is deliberately not here: that is
 * something you go and look at, which is the test a panel has to fail.
 *
 * The button is on the panel as well as the tab because "always there" has to
 * mean the screen you are actually on. In manual mode it is the only way to
 * fetch, and having to open a settings tab to press it would make the mode not
 * worth choosing.
 */
import { useState } from 'react';
import { useAsync } from '@app/useAsync';
import { goTo } from '@app/nav';
import { ageOf, weather } from './weather-api';

export default function WeatherPanel() {
  /*
   * Reading this *is* the refresh in `daily` mode: the endpoint fetches when the
   * reading is a day old. So having the panel open is the poll, and closing it
   * costs nothing — the same arrangement the friends and live panels have, with
   * a much longer window.
   */
  const state = useAsync(() => weather.get(), [], []);
  const [busy, setBusy] = useState(false);

  const data = state.data;
  if (state.loading) return <div className="empty">loading…</div>;
  /*
   * Stated rather than swallowed. A panel that silently shows nothing when the
   * request failed is indistinguishable from one with nothing to show, and the
   * two want completely different reactions.
   */
  if (state.error) return <div className="empty">Could not load: {state.error.message}</div>;
  if (!data) return null;

  async function check() {
    setBusy(true);
    try {
      await weather.refreshNow();
      state.reload();
    } catch {
      // The tab is where a failure is explained properly, with the message and
      // the settings that caused it. A panel this size cannot do that job, and
      // the next line already says how old the reading is.
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="row between" style={{ alignItems: 'baseline' }}>
        <h2 style={{ margin: 0 }}>Weather</h2>
        {data.place && <span className="meta truncate">{data.place.name}</span>}
      </div>

      {!data.place ? (
        /* Nowhere set yet. The button goes to the one screen that can fix it,
           rather than a sentence telling you to go and find it. */
        <button className="card panel-row" onClick={() => goTo('weather')}>
          <div className="meta">Pick a place on the Weather tab.</div>
        </button>
      ) : (
        <div className="card">
          <div className="row between" style={{ alignItems: 'center', gap: '.5rem' }}>
            <div className="grow" style={{ minWidth: 0 }}>
              {data.reading ? (
                <>
                  <div style={{ fontSize: '1.6rem', lineHeight: 1.2 }}>
                    {(data.now ?? data.reading).glyph} {(data.now ?? data.reading).temperature}°
                    {data.units.toUpperCase()}
                  </div>
                  <div className="meta truncate" style={{ marginTop: 2 }}>
                    {(data.now ?? data.reading).label}
                    {(data.now ? data.now.feelsLike : data.reading.feelsLike) !== null
                      ? ` · feels like ${data.now ? data.now.feelsLike : data.reading.feelsLike}°`
                      : ''}
                  </div>
                </>
              ) : (
                <div className="meta">{data.error ?? 'Nothing fetched yet.'}</div>
              )}
            </div>

            <button
              className="btn subtle"
              style={{ flex: 'none' }}
              disabled={busy}
              title="Check the weather now"
              onClick={() => void check()}
            >
              {busy ? '…' : '↻'}
            </button>
          </div>

          {/*
            The age, always. A temperature with no date on it is the one way this
            panel could actively mislead — most of all in manual mode, where the
            number on screen might be from Tuesday.
          */}
          <div className="meta" style={{ marginTop: 6 }}>
            {ageOf(data.fetchedAt)}
            {data.error && data.reading ? ' · last check failed' : ''}
          </div>
        </div>
      )}
    </>
  );
}
