/**
 * Who is online.
 *
 * The whole point of this screen is that **an empty list explains itself**. Six
 * services can contribute here and only one of them — Steam — works without a
 * caveat, so a bare "nobody is online" would be indistinguishable from "you
 * have not connected anything", "your Steam profile is private", "League is
 * closed", and "Discord has not approved this app". Those have five different
 * fixes, so the sources panel sits under the list and names the one that
 * applies.
 */
import { useState } from 'react';
import { api, type FriendRow, type FriendSource } from '../../api';
import { useAsync } from '../../useAsync';
import { relativeTime } from './Integrations';

const STATE_LABEL: Record<FriendRow['state'], string> = {
  'in-game': 'playing',
  online: 'online',
  away: 'away',
  offline: 'offline',
  // Not "offline". Discord returns its friends list with no presence on it at
  // all, and reporting a hundred people as away from their computers on that
  // basis was a claim the data never supported.
  unknown: 'status unknown',
};

export function Friends() {
  const [refreshing, setRefreshing] = useState(false);

  /*
   * The read refreshes stale providers server-side — see `refreshPresence` for
   * why there is no background poller. Watching the `integrations` scope means
   * the agent pushing a new Riot snapshot updates this list without the phone
   * having asked for anything.
   */
  const view = useAsync(() => api.integrations.friends(), [], ['integrations']);

  const forceRefresh = async () => {
    setRefreshing(true);
    try {
      await api.integrations.friends(true);
      view.reload();
    } finally {
      setRefreshing(false);
    }
  };

  if (view.loading) return <div className="empty">loading…</div>;
  if (view.error) return <div className="empty">Could not load: {view.error.message}</div>;
  if (!view.data) return null;

  const around = view.data.friends.filter((f) => f.state !== 'offline' && f.state !== 'unknown');
  const unknown = view.data.friends.filter((f) => f.state === 'unknown');
  const offline = view.data.friends.filter((f) => f.state === 'offline');

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="meta">
          {around.length === 0 ? 'Nobody online' : `${around.length} online`}
          {offline.length ? ` · ${offline.length} offline` : ''}
          {/* Counted separately and named, so a hundred rows nobody can vouch
              for never read as a hundred people who are definitely out. */}
          {unknown.length ? ` · ${unknown.length} unknown` : ''}
        </div>
        <button className="btn subtle" onClick={forceRefresh} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <Suggestions onLinked={view.reload} />

      {around.map((friend) => (
        <FriendCard key={friend.id} friend={friend} onChanged={view.reload} />
      ))}

      {/*
        Between "around" and "offline", which is where they belong: more
        interesting than a confirmed no, less than a confirmed yes.
      */}
      {unknown.length > 0 && (
        <>
          <div className="meta" style={{ margin: '1rem 0 .5rem' }}>
            Status unknown — Discord does not publish presence, so link these to a Steam account to see
            whether they are about
          </div>
          {unknown.map((friend) => (
            <FriendCard key={friend.id} friend={friend} onChanged={view.reload} />
          ))}
        </>
      )}

      {/*
        Offline friends stay on screen below a divider rather than being hidden
        behind a toggle — the same choice finished tasks get on the Dashboard.
        Knowing somebody exists and is not around is useful; making you click to
        find that out is not.
      */}
      {offline.length > 0 && (
        <>
          <div className="meta" style={{ margin: '1rem 0 .5rem' }}>Offline</div>
          <div className="done-area">
            {offline.map((friend) => (
              <FriendCard key={friend.id} friend={friend} onChanged={view.reload} />
            ))}
          </div>
        </>
      )}

      <Sources sources={view.data.sources} anyFriends={view.data.friends.length > 0} />
    </>
  );
}

function FriendCard({ friend, onChanged }: { friend: FriendRow; onChanged: () => void }) {
  const [linking, setLinking] = useState(false);

  return (
    <div className="card">
      <div className="row" style={{ alignItems: 'center', gap: '.75rem' }}>
        {friend.avatarUrl ? (
          <img src={friend.avatarUrl} alt="" width={32} height={32} style={{ borderRadius: 6 }} />
        ) : (
          <span className="glyph" aria-hidden="true">
            👤
          </span>
        )}

        <div className="grow">
          <div className="title">{friend.name}</div>
          <div className="meta">
            {/* What they are playing outranks the status word: "playing Deep Rock
                Galactic" is the answer, and "online" is the less useful half of it. */}
            {friend.game ?? friend.detail ?? STATE_LABEL[friend.state]}
            {/* Where a borrowed status came from. Without it, a Discord row
                showing a game looks like Discord told us, and the next person to
                wonder why the others are blank has nothing to go on. */}
            {friend.statusFrom ? ` · via ${friend.statusFrom}` : ''}
            {friend.state === 'offline' && friend.lastOnlineAt
              ? ` · last on ${relativeTime(friend.lastOnlineAt)}`
              : ''}
            {friend.alsoOn.length > 0
              ? ` · also ${friend.alsoOn.map((other) => `${other.provider}: ${other.name}`).join(', ')}`
              : ''}
          </div>
        </div>

        <span className={`chip presence-${friend.state}`}>{friend.provider}</span>

        {friend.personId ? (
          <button
            className="btn subtle"
            title="Stop treating these as the same person"
            onClick={() => void api.integrations.unlinkFriend(friend.id).then(onChanged)}
          >
            Unlink
          </button>
        ) : (
          <button className="btn subtle" onClick={() => setLinking((open) => !open)}>
            {linking ? 'Cancel' : 'Link'}
          </button>
        )}
      </div>

      {linking && <LinkPicker friend={friend} onDone={() => { setLinking(false); onChanged(); }} />}
    </div>
  );
}

/**
 * Pick the account on another service that is the same person.
 *
 * Searchable, because the list it picks from is everybody on every *other*
 * service — a hundred names is not something to scroll through in a dropdown.
 * Restricted to other providers because linking two Discord accounts to each
 * other says nothing, and the server refuses it anyway.
 */
function LinkPicker({ friend, onDone }: { friend: FriendRow; onDone: () => void }) {
  const [search, setSearch] = useState('');
  const [problem, setProblem] = useState('');
  const all = useAsync(() => api.integrations.friends(), [], ['integrations']);

  const options = (all.data?.friends ?? [])
    .filter((other) => other.provider !== friend.provider && !other.personId)
    .filter((other) => other.name.toLowerCase().includes(search.trim().toLowerCase()))
    .slice(0, 8);

  const link = async (otherId: string) => {
    try {
      await api.integrations.linkFriends(friend.id, otherId);
      onDone();
    } catch (error) {
      setProblem((error as Error).message);
    }
  };

  return (
    <div style={{ marginTop: '.6rem', display: 'grid', gap: '.4rem' }}>
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={`Search other services for ${friend.name}`}
        aria-label="Search for the matching account"
        type="search"
        autoFocus
      />
      {options.length === 0 ? (
        <span className="meta">Nothing unlinked matches on another service.</span>
      ) : (
        options.map((other) => (
          <button key={other.id} className="btn subtle" style={{ justifyContent: 'flex-start' }} onClick={() => void link(other.id)}>
            {other.provider}: {other.name}
          </button>
        ))
      )}
      {problem && <div className="banner">{problem}</div>}
    </div>
  );
}

/**
 * Accounts whose names look like the same person.
 *
 * Proposals, never applied automatically. Discord will not tell us a friend's
 * Steam profile — that endpoint is client-only and answers 401 to an OAuth app
 * — so there is nothing authoritative to import and a name match is a guess. A
 * wrong link silently attributes one person's status to another, which is worth
 * one click to avoid.
 */
function Suggestions({ onLinked }: { onLinked: () => void }) {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const view = useAsync(() => api.integrations.linkSuggestions(), [], ['integrations']);

  const shown = (view.data?.suggestions ?? []).filter((s) => !dismissed.includes(s.a.id));
  if (shown.length === 0) return null;

  return (
    <div className="card">
      <div className="title">These might be the same people</div>
      <div className="meta" style={{ marginTop: 2 }}>
        Matched on name only — Discord does not publish its friends' other accounts, so this is a guess
        worth checking. Linking one lets a Discord friend show their Steam status.
      </div>

      {shown.map((suggestion) => (
        <div key={suggestion.a.id} className="row" style={{ alignItems: 'center', gap: '.5rem', marginTop: '.5rem' }}>
          <div className="grow">
            <div className="title">
              {suggestion.a.name} <span className="meta">({suggestion.a.provider})</span> ={' '}
              {suggestion.b.name} <span className="meta">({suggestion.b.provider})</span>
            </div>
            <div className="meta">{suggestion.because}</div>
          </div>
          <button
            className="btn primary"
            onClick={() => void api.integrations.linkFriends(suggestion.a.id, suggestion.b.id).then(onLinked)}
          >
            Same person
          </button>
          <button className="btn subtle" onClick={() => setDismissed((d) => [...d, suggestion.a.id])}>
            No
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Why the list above looks the way it does.
 *
 * Always rendered, even when everything is working — a panel that only appears
 * on failure is one you have to learn the existence of, and this is the first
 * place to look when somebody you know is definitely online is not shown.
 */
function Sources({ sources, anyFriends }: { sources: FriendSource[]; anyFriends: boolean }) {
  return (
    <details className="card" style={{ marginTop: '1.5rem' }} open={!anyFriends}>
      <summary>Where this list comes from</summary>

      {sources.map((source) => (
        <div key={source.provider} style={{ marginTop: '.75rem' }}>
          <div className="row" style={{ alignItems: 'center', gap: '.5rem' }}>
            <strong>{source.label}</strong>
            {/*
              Only for providers there is something to connect. Riot and Epic
              have no account to link — the agent finds the client or it does
              not — and "not connected" beside them read as a step you had
              forgotten to do rather than as a category that does not apply.
              Their own line, below, says the useful thing instead.
            */}
            {source.status !== 'unavailable' && !source.local && (
              <span className="meta">{source.connected ? 'connected' : 'not connected'}</span>
            )}
          </div>

          <div className="meta" style={{ marginTop: 2 }}>{source.why}</div>

          {/* The three states a local provider can be in, which need three
              different things done about them. */}
          {source.local && (
            <div className="meta" style={{ marginTop: 2 }}>
              {source.local.stale
                ? 'The Windows agent is not reporting — is it running?'
                : source.local.clientRunning
                  ? `Client running, last checked ${relativeTime(source.local.reportedAt)}`
                  : `Client is closed — showing what it last saw, ${relativeTime(source.local.reportedAt)}`}
            </div>
          )}

          {/*
            Suppressed when the capability is impossible anyway. Spotify's
            client id is genuinely needed — for playlists — but on a panel about
            *friends*, telling you to go and set it implies that doing so would
            produce a friends list, which is the one thing it cannot do.
          */}
          {source.status !== 'unavailable' && source.missingConfig.length > 0 && (
            <div className="meta" style={{ marginTop: 2 }}>
              Needs{' '}
              {source.missingConfig.map((name, i) => (
                <span key={name}>
                  {i > 0 && ', '}
                  <code>{name}</code>
                </span>
              ))}{' '}
              in the environment.
            </div>
          )}

          {source.lastError && (
            <div className="meta" style={{ marginTop: 2 }}>
              Last error: {source.lastError}
            </div>
          )}
        </div>
      ))}
    </details>
  );
}
