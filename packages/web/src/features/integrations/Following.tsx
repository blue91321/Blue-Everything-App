/**
 * Accounts you follow — YouTube channels and Spotify artists.
 *
 * Its own tab rather than a section of Friends, which is where this started and
 * where it did not belong. A friend is a mutual relationship with somebody who
 * is either around or not; a subscription is a one-way interest in an account
 * that has no presence at all and never will. Folding them together put
 * "Spotify — friends: not possible" on a screen about who is online, which
 * answers a question nobody asked and pushes down the one they did.
 *
 * Not refreshed on read, unlike Friends. A subscription list changes when *you*
 * change it, so refreshing on every open would spend YouTube quota confirming
 * what it said yesterday. It syncs on demand, like a playlist.
 */
import { useMemo, useState } from 'react';
import { api, type FollowRow } from '../../api';
import { useAsync } from '../../useAsync';
import { CATEGORY_LABELS, relativeTime } from './Integrations';

type Filter = 'all' | 'channel' | 'artist';

const KIND_LABEL: Record<FollowRow['kind'], string> = {
  channel: 'channel',
  artist: 'artist',
};

export function Following() {
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  const view = useAsync(() => api.integrations.follows(), [], ['integrations']);

  const shown = useMemo(() => {
    const rows = view.data?.follows ?? [];
    const needle = search.trim().toLowerCase();
    return rows.filter(
      (row) => (filter === 'all' || row.kind === filter) && (needle === '' || row.name.toLowerCase().includes(needle))
    );
  }, [view.data, filter, search]);

  if (view.loading) return <div className="empty">loading…</div>;
  if (view.error) return <div className="empty">Could not load: {view.error.message}</div>;
  if (!view.data) return null;

  const all = view.data.follows;
  const channels = all.filter((f) => f.kind === 'channel').length;
  const artists = all.filter((f) => f.kind === 'artist').length;

  if (all.length === 0) {
    return (
      <>
        <div className="empty">
          Nothing here yet. Connect YouTube or Spotify on the Services tab and press Sync — subscriptions
          and followed artists come across together with everything else.
        </div>
        <Sources sources={view.data.sources} />
      </>
    );
  }

  return (
    <>
      <div className="row wrap" style={{ justifyContent: 'space-between', alignItems: 'center', gap: '.5rem' }}>
        <div className="row" role="group" aria-label="Show">
          {(
            [
              ['all', `All ${all.length}`],
              ['channel', `Channels ${channels}`],
              ['artist', `Artists ${artists}`],
            ] as Array<[Filter, string]>
          ).map(([value, label]) => (
            <button
              key={value}
              className={`btn${filter === value ? ' primary' : ' subtle'}`}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>

        {/* A list of three hundred channels is a list you search rather than
            scroll. Client-side because it is already all here. */}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search"
          aria-label="Search followed accounts"
          type="search"
        />
      </div>

      {shown.length === 0 ? (
        <div className="empty">Nothing matches "{search}".</div>
      ) : (
        shown.map((row) => <FollowCard key={row.id} row={row} />)
      )}

      <Sources sources={view.data.sources} />
    </>
  );
}

function FollowCard({ row }: { row: FollowRow }) {
  return (
    <div className="card row" style={{ alignItems: 'center', gap: '.75rem' }}>
      {row.avatarUrl ? (
        <img src={row.avatarUrl} alt="" width={32} height={32} style={{ borderRadius: '50%' }} loading="lazy" />
      ) : (
        <span className="glyph" aria-hidden="true">
          {row.kind === 'artist' ? '🎤' : '📺'}
        </span>
      )}

      <div className="grow">
        <div className="title">
          {/* The name links out, because the reason to look at this list is
              usually to go and open one of them. */}
          {row.url ? (
            <a href={row.url} target="_blank" rel="noreferrer noopener">
              {row.name}
            </a>
          ) : (
            row.name
          )}
        </div>
        <div className="meta">
          {KIND_LABEL[row.kind]}
          {/* Only artists carry a category, and only when Spotify gave genres.
              `unknown` is left unsaid rather than printed — it is the honest
              value in the database and noise on a row. */}
          {row.category !== 'unknown' ? ` · ${CATEGORY_LABELS[row.category] ?? row.category}` : ''}
          {row.followerCount ? ` · ${row.followerCount.toLocaleString()} followers` : ''}
        </div>
      </div>

      <span className="chip">{row.provider}</span>
    </div>
  );
}

function Sources({ sources }: { sources: Array<{ provider: string; label: string; why: string; syncedAt: number | null }> }) {
  if (sources.length === 0) return null;

  return (
    <details className="card" style={{ marginTop: '1.5rem' }}>
      <summary>Where this list comes from</summary>
      {sources.map((source) => (
        <div key={source.provider} style={{ marginTop: '.75rem' }}>
          <div className="row" style={{ alignItems: 'center', gap: '.5rem' }}>
            <strong>{source.label}</strong>
            <span className="meta">
              {source.syncedAt ? `synced ${relativeTime(source.syncedAt)}` : 'never synced'}
            </span>
          </div>
          <div className="meta" style={{ marginTop: 2 }}>{source.why}</div>
        </div>
      ))}
    </details>
  );
}
