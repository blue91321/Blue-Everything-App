/**
 * What the library is made of, and what has actually been played.
 *
 * **This screen deliberately does not recommend anything yet**, and says so.
 * Spotify withdrew the endpoints that measured a track — energy, tempo, key,
 * and the recommendations built on them — in November 2024, so the only signal
 * available is the genre strings attached to artists plus your own play counts.
 * That supports "you have played nine hours of metal this month and not touched
 * the jazz playlist since March", which is genuinely useful. It does not support
 * "here is a song you will like", and presenting a genre count as if it were
 * taste modelling would be the dishonest version of the same screen.
 *
 * The categories are stored on each row rather than computed here, so this is a
 * `group by` on the server rather than several thousand rows over the wire.
 */
import { useState } from 'react';
import { api } from '../../api';
import { useAsync } from '../../useAsync';

const CATEGORY_LABELS: Record<string, string> = {
  rock: 'Rock',
  metal: 'Metal',
  punk: 'Punk',
  pop: 'Pop',
  hiphop: 'Hip-hop',
  rnb: 'R&B / Soul',
  electronic: 'Electronic',
  dance: 'Dance / House',
  jazz: 'Jazz / Blues',
  classical: 'Classical',
  folk: 'Folk / Acoustic',
  country: 'Country',
  latin: 'Latin',
  world: 'World',
  soundtrack: 'Soundtrack / Game',
  ambient: 'Ambient / Chill',
  spoken: 'Spoken word',
  unknown: 'Uncategorised',
};

const label = (category: string) => CATEGORY_LABELS[category] ?? category;

const hours = (ms: number) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)}h` : `${Math.round(ms / 60_000)}m`);

export function Music({ local }: { local: boolean }) {
  const [days, setDays] = useState(30);

  const music = useAsync(() => api.integrations.music(days), [days], ['integrations']);
  const collections = useAsync(() => api.integrations.collections(), [], ['integrations']);

  if (music.loading) return <div className="empty">loading…</div>;
  if (music.error) return <div className="empty">Could not load: {music.error.message}</div>;
  if (!music.data) return null;

  const total = music.data.breakdown.reduce((sum, row) => sum + row.count, 0);
  const played = music.data.taste.reduce((sum, row) => sum + row.plays, 0);

  if (total === 0) {
    return (
      <div className="empty">
        Nothing in the library yet. Connect Spotify or YouTube on the Services tab and sync.
        {!local && ' Connecting has to be done on the PC.'}
      </div>
    );
  }

  return (
    <>
      {/* ---- the library, by family ---- */}
      <div className="card">
        <div className="title">{total.toLocaleString()} tracks and videos</div>
        <div className="meta" style={{ marginTop: 2 }}>
          Grouped by the genres the services assign each artist. Nothing here measures how a track
          sounds — the endpoints that did were withdrawn in November 2024.
        </div>

        <div style={{ marginTop: '.75rem' }}>
          {music.data.breakdown.map((row) => (
            <Bar key={row.category} label={label(row.category)} value={row.count} max={total} />
          ))}
        </div>
      </div>

      {/* ---- what has actually been played ---- */}
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="title">What you actually played</div>
          <div className="row" role="group" aria-label="Window">
            {[7, 30, 90, 365].map((option) => (
              <button
                key={option}
                className={`btn${option === days ? ' primary' : ' subtle'}`}
                onClick={() => setDays(option)}
              >
                {option === 365 ? '1y' : `${option}d`}
              </button>
            ))}
          </div>
        </div>

        {played === 0 ? (
          <div className="meta" style={{ marginTop: '.5rem' }}>
            No plays recorded in this window. Spotify history only starts from when you connected it —
            it will only ever hand back the last 50 plays, so it is built up by syncing. YouTube
            history comes from a Takeout import.
          </div>
        ) : (
          <div style={{ marginTop: '.75rem' }}>
            {music.data.taste.map((row) => (
              <div key={row.category} className="row" style={{ alignItems: 'center', gap: '.5rem' }}>
                <div className="grow">
                  <Bar label={label(row.category)} value={row.plays} max={played} />
                </div>
                <span className="meta" style={{ minWidth: '4.5rem', textAlign: 'right' }}>
                  {hours(row.listenedMs)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---- recent plays ---- */}
      {music.data.recent.length > 0 && (
        <details className="card">
          <summary>Recently played ({music.data.recent.length})</summary>
          {music.data.recent.map((play) => (
            <div key={`${play.title}-${play.playedAt}`} className="row" style={{ alignItems: 'center', gap: '.5rem', marginTop: '.4rem' }}>
              <div className="grow">
                <div className="title">{play.title}</div>
                <div className="meta">
                  {play.creator ?? 'unknown'} · {label(play.category)} ·{' '}
                  {new Date(play.playedAt).toLocaleString()}
                </div>
              </div>
              <span className="chip">{play.provider}</span>
            </div>
          ))}
        </details>
      )}

      {/* ---- playlists ---- */}
      {collections.data && collections.data.length > 0 && (
        <details className="card">
          <summary>Playlists ({collections.data.length})</summary>
          {collections.data.map((collection) => (
            <div key={collection.id} className="row" style={{ alignItems: 'center', gap: '.5rem', marginTop: '.4rem' }}>
              <div className="grow">
                <div className="title">{collection.name}</div>
                <div className="meta">
                  {collection.provider} · {collection.itemCount.toLocaleString()} items
                  {collection.kind !== 'playlist' ? ` · ${collection.kind}` : ''}
                </div>
              </div>
            </div>
          ))}
        </details>
      )}
    </>
  );
}

/**
 * A labelled proportion bar.
 *
 * Reusing `.level` / `.level-fill`, which the Voice tab already uses for its
 * input meter — one definition of what a filled bar looks like rather than a
 * second that drifts.
 */
function Bar({ label: text, value, max }: { label: string; value: number; max: number }) {
  const percent = max === 0 ? 0 : Math.round((value / max) * 100);

  return (
    <div style={{ marginBottom: '.4rem' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span>{text}</span>
        <span className="meta">
          {value.toLocaleString()} · {percent}%
        </span>
      </div>
      <div className="level">
        <div className="level-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
