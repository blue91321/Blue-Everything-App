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
type Sort = 'inPlaylists' | 'name' | 'followers';

/**
 * How the list is ordered, and why the default is what it is.
 *
 * Four hundred names in alphabetical order is a phone book: correct, and no
 * help at all in answering the question you opened the tab with. Ordering by
 * how much of them is actually in your playlists puts the artists you listen to
 * at the top and the ones you followed once in 2019 at the bottom, which is the
 * shape of the answer.
 *
 * `followers` is Spotify-only — YouTube's subscriber counts are not in the
 * subscriptions response — so it sorts channels to the end rather than
 * pretending they are the least popular things you follow.
 */
const SORTS: Array<{ id: Sort; label: string }> = [
  { id: 'inPlaylists', label: 'In my playlists' },
  { id: 'name', label: 'Name' },
  { id: 'followers', label: 'Popularity' },
];

const KIND_LABEL: Record<FollowRow['kind'], string> = {
  channel: 'channel',
  artist: 'artist',
};

export function Following() {
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('inPlaylists');
  const [search, setSearch] = useState('');

  const view = useAsync(() => api.integrations.follows(), [], ['integrations']);

  const shown = useMemo(() => {
    const rows = view.data?.follows ?? [];
    const needle = search.trim().toLowerCase();

    const filtered = rows.filter(
      (row) => (filter === 'all' || row.kind === filter) && (needle === '' || row.name.toLowerCase().includes(needle))
    );

    // Sorted on a copy: `view.data` is the fetched result and reordering it in
    // place would mutate what the next render reads from.
    return [...filtered].sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (sort === 'followers') return (b.followerCount ?? -1) - (a.followerCount ?? -1);
      // Ties on the count are common — most of a long follow list is zero — so
      // they fall back to name rather than to whatever order the rows arrived
      // in, which would reshuffle on every refresh.
      return b.inPlaylists - a.inPlaylists || a.name.localeCompare(b.name);
    });
  }, [view.data, filter, sort, search]);

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
      {/*
        First, and on its own row.

        It used to sit at the end of the row below, which on any real width put
        it on a wrapped third line under two groups of buttons — present, and
        the last thing you would find. A list of four hundred channels is one
        you search rather than scroll, so it leads. Same position as the box on
        the Friends tab, since they do the same job.
      */}
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search channels and artists"
        aria-label="Search followed accounts"
        type="search"
        style={{ marginBottom: '.75rem' }}
      />

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

        <div className="row" role="group" aria-label="Sort by">
          {SORTS.map((option) => (
            <button
              key={option.id}
              className={`btn${sort === option.id ? ' primary' : ' subtle'}`}
              aria-pressed={sort === option.id}
              onClick={() => setSort(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>

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
          {/*
            The playlist count leads, because it is what the list is sorted by
            and a sort you cannot see the key for looks arbitrary. Zero is
            printed rather than hidden — "none of theirs is in my playlists" is
            the useful half of this list, not an absence of data.
          */}
          {row.inPlaylists === 0
            ? 'none in my playlists'
            : `${row.inPlaylists} ${row.kind === 'artist' ? (row.inPlaylists === 1 ? 'track' : 'tracks') : row.inPlaylists === 1 ? 'video' : 'videos'} in my playlists`}
          {' · '}
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
