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

  const online = view.data.friends.filter((f) => f.state !== 'offline');
  const offline = view.data.friends.filter((f) => f.state === 'offline');

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="meta">
          {online.length === 0
            ? 'Nobody online'
            : `${online.length} online${offline.length ? ` · ${offline.length} offline` : ''}`}
        </div>
        <button className="btn subtle" onClick={forceRefresh} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {online.map((friend) => (
        <FriendCard key={friend.id} friend={friend} />
      ))}

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
              <FriendCard key={friend.id} friend={friend} />
            ))}
          </div>
        </>
      )}

      <Sources sources={view.data.sources} anyFriends={view.data.friends.length > 0} />
    </>
  );
}

function FriendCard({ friend }: { friend: FriendRow }) {
  return (
    <div className="card row" style={{ alignItems: 'center', gap: '.75rem' }}>
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
          {friend.state === 'offline' && friend.lastOnlineAt
            ? ` · last on ${relativeTime(friend.lastOnlineAt)}`
            : ''}
        </div>
      </div>

      <span className={`chip presence-${friend.state}`}>{friend.provider}</span>
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
