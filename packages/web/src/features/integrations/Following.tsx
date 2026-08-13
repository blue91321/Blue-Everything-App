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
  const hiddenCount = view.data.hiddenCount ?? 0;

  if (all.length === 0) {
    return (
      <>
        <div className="empty">
          {/*
            An empty list has two causes now, and they need opposite things
            done. Saying "connect YouTube and sync" to somebody who has ticked
            both services on the Services tab would send them to set up what is
            already set up.
          */}
          {hiddenCount > 0
            ? `Everything here is left out — ${hiddenCount} accounts are hidden by the service filter at the top of the Services tab.`
            : 'Nothing here yet. Connect YouTube or Spotify on the Services tab and press Sync — subscriptions and followed artists come across together with everything else.'}
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

      {/* Same reasoning as the Friends list: a shorter list than you expected
          must say why, and the switch that shortened it is on another tab. */}
      {hiddenCount > 0 && (
        <div className="meta" style={{ marginBottom: '.5rem' }}>
          {hiddenCount} left out by the service filter on the Services tab.
        </div>
      )}

      {shown.length === 0 ? (
        <div className="empty">Nothing matches "{search}".</div>
      ) : (
        shown.map((row) => <FollowCard key={row.id} row={row} all={all} onChanged={view.reload} />)
      )}

      <Sources sources={view.data.sources} />
    </>
  );
}

function FollowCard({ row, all, onChanged }: { row: FollowRow; all: FollowRow[]; onChanged: () => void }) {
  const [linking, setLinking] = useState(false);

  /*
   * A merged row is several accounts and should look it, the way a merged
   * friend does. Rendered from `accounts` rather than from the row's own
   * provider, since the whole point is that they may differ — a YouTube channel
   * and the same act's Spotify artist page, or two channels from one creator.
   */
  const linked = row.accounts.length > 1;

  return (
    <div className="card">
    <div className="row" style={{ alignItems: 'center', gap: '.75rem' }}>
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
          {/* The other accounts this was merged from, so a name you do not
              recognise on one service can still be placed by the other. */}
          {linked
            ? ` · also ${row.accounts
                .filter((account) => !account.isPrimary)
                .map((account) => `${account.provider}: ${account.name}`)
                .join(', ')}`
            : ''}
        </div>
      </div>

      {/* Every service behind the row, not just the main one's. */}
      <span className="chip">{[...new Set(row.accounts.map((a) => a.provider))].join(' + ')}</span>

      {/* Same three labels as the Friends row. "Linked" described a state and
          did not say it was a button you could press to change it. */}
      <button className="btn subtle" onClick={() => setLinking((open) => !open)}>
        {linking ? 'Done' : linked ? 'Manage links' : 'Link'}
      </button>
    </div>

      {linking && <LinkPanel row={row} all={all} onChanged={onChanged} />}
    </div>
  );
}

/**
 * Join this account to another, choose which is the main one, and take them
 * apart again.
 *
 * All three live in one panel because they are one job — "these are the same
 * creator, and *this* is the name I want to see" — and splitting them across
 * the row would put three controls on four hundred rows for something you do a
 * handful of times.
 */
function LinkPanel({ row, all, onChanged }: { row: FollowRow; all: FollowRow[]; onChanged: () => void }) {
  const [search, setSearch] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setProblem('');
    try {
      await action();
      onChanged();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const needle = search.trim().toLowerCase();
  /*
   * Anything not already in this group, on any service.
   *
   * **Not filtered by provider**, unlike the friends picker, which allows only
   * a different service. Two YouTube channels from one creator is the case this
   * was asked for, and a YouTube channel joined to the same act's Spotify
   * artist page is the other — so both same-service and cross-service have to
   * be reachable here.
   *
   * Rows already in a group of their own are still offered: linking merges the
   * two groups whole rather than refusing.
   */
  const options = all
    .filter((other) => other.id !== row.id)
    .filter((other) => !other.groupId || other.groupId !== row.groupId)
    .filter((other) => needle !== '' && other.name.toLowerCase().includes(needle))
    .slice(0, 8);

  return (
    <div style={{ marginTop: '.6rem', display: 'grid', gap: '.4rem' }}>
      {/*
        Shown only when there is a group, because "which is the main one" is not
        a question a single account has an answer to.
      */}
      {row.accounts.length > 1 && (
        <>
          <div className="meta">Linked accounts — the main one supplies the name, picture and link.</div>
          {row.accounts.map((account) => (
            <div key={account.id} className="row" style={{ alignItems: 'center', gap: '.5rem' }}>
              <span className="grow">
                {account.name} <span className="meta">({account.provider})</span>
                {account.isPrimary ? <span className="meta"> — main</span> : null}
              </span>
              {!account.isPrimary && (
                <button
                  className="btn subtle"
                  disabled={busy}
                  onClick={() => void run(() => api.integrations.setPrimaryFollow(account.id))}
                >
                  Make main
                </button>
              )}
              <button
                className="btn subtle"
                disabled={busy}
                title="Take this one out, leaving the rest joined"
                onClick={() => void run(() => api.integrations.unlinkFollow(account.id))}
              >
                Unlink
              </button>
            </div>
          ))}
        </>
      )}

      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={`Search for another account that is also ${row.name}`}
        aria-label="Search for the matching account"
        type="search"
        autoFocus
      />

      {needle === '' ? (
        <span className="meta">Type a name to find the other channel or artist page.</span>
      ) : options.length === 0 ? (
        <span className="meta">Nothing else matches "{search.trim()}".</span>
      ) : (
        options.map((other) => (
          <button
            key={other.id}
            className="btn subtle"
            style={{ justifyContent: 'flex-start' }}
            disabled={busy}
            /*
             * Linking takes *account* ids, and a row is a group. `accounts[0]`
             * is read here in one place for the same reason the friends picker
             * does it: a row's `id` is a group key, the two are strings called
             * `id` a few lines apart, and passing the wrong one typechecks.
             */
            onClick={() => void run(() => api.integrations.linkFollows(row.accounts[0].id, other.accounts[0].id))}
          >
            {other.provider}: {other.name}
          </button>
        ))
      )}

      {problem && <div className="banner">{problem}</div>}
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
