/**
 * What the library is made of.
 *
 * It also showed what you had actually *played*, by family, over a window —
 * built from a play history that has since been removed. What is left is the
 * library itself, which is the part that was ever a fact rather than an
 * inference from fifty remembered plays.
 *
 * **This screen deliberately does not recommend anything**, and it is worth
 * saying why it never will on this data. Spotify withdrew the endpoints that
 * measured a track — energy, tempo, key, and the recommendations built on them
 * — in November 2024, so the only signal available is the genre strings
 * attached to artists. That supports "my library is a third metal", which is
 * true and useful. It does not support "here is a song you will like", and
 * presenting a genre count as if it were taste modelling would be the
 * dishonest version of the same screen.
 *
 * The categories are stored on each row rather than computed here, so this is a
 * `group by` on the server rather than several thousand rows over the wire.
 */
import { useState } from 'react';
import { api } from '../../api';
import { useAsync } from '../../useAsync';
import { CATEGORY_LABELS } from './Integrations';

const label = (category: string) => CATEGORY_LABELS[category] ?? category;

export function Music({ local }: { local: boolean }) {
  // Which box is mid-flight, so a double click cannot race itself.
  const [busy, setBusy] = useState('');
  const music = useAsync(() => api.integrations.music(), [], ['integrations']);
  const collections = useAsync(() => api.integrations.collections(), [], ['integrations']);

  if (music.loading) return <div className="empty">loading…</div>;
  if (music.error) return <div className="empty">Could not load: {music.error.message}</div>;
  if (!music.data) return null;

  const total = music.data.breakdown.reduce((sum, row) => sum + row.count, 0);

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

      {collections.data && collections.data.length > 0 && (
        <details className="card">
          <summary>
            Playlists ({collections.data.length})
            {collections.data.filter((c) => c.ignored).length > 0
              ? ` · ${collections.data.filter((c) => c.ignored).length} ignored`
              : ''}
          </summary>

          {/*
            A box per playlist, which replaced a provider-wide "skip Liked
            Videos" switch on the Services tab. The reason to skip one is that it
            is enormous and drowns out everything else — a property of the
            playlist, not of the service — so the control belongs in the list of
            playlists rather than on the page about connections.
          */}
          <div className="meta" style={{ marginTop: '.4rem' }}>
            Ticked ones are left out of syncs, and out of the "in my playlists" counts on the Following
            tab. Nothing already synced is deleted — it simply stops being refreshed.
          </div>

          {collections.data.map((collection) => (
            <label
              key={collection.id}
              className="row"
              style={{ alignItems: 'center', gap: '.5rem', marginTop: '.5rem' }}
            >
              <input
                type="checkbox"
                checked={collection.ignored === 1}
                disabled={!local || busy === collection.id}
                onChange={(e) => {
                  setBusy(collection.id);
                  void api.integrations
                    .setCollectionIgnored(collection.id, e.target.checked)
                    .then(() => collections.reload())
                    .finally(() => setBusy(''));
                }}
              />
              <div className="grow">
                <div className="title" style={{ opacity: collection.ignored ? 0.6 : 1 }}>
                  {collection.name}
                </div>
                <div className="meta">
                  {collection.provider} · {collection.itemCount.toLocaleString()}{' '}
                  {collection.itemCount === 1 ? 'item' : 'items'}
                  {collection.kind !== 'playlist' ? ` · ${collection.kind}` : ''}
                  {collection.ignored ? ' · ignored' : ''}
                </div>
              </div>
            </label>
          ))}

          {!local && (
            <div className="meta" style={{ marginTop: '.5rem' }}>
              Ticking these is done on the PC running the server.
            </div>
          )}
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
