/**
 * Who is around, beside the Dashboard.
 *
 * A separate component from `Friends.tsx` rather than that screen squeezed into
 * a narrower column, and the difference is not width. The Friends screen answers
 * "who do I know and how are these accounts joined up" — searching, filtering by
 * service and by status, linking two accounts as one person. None of that is a
 * question you ask out of the corner of your eye while doing something else,
 * which is the only kind of question a panel should try to answer.
 *
 * So this shows one thing: who could you actually talk to right now. Everything
 * else is a click away on the tab it belongs to.
 */
import { api, type FriendRow } from '../../api';
import { useAsync } from '../../useAsync';
import { STATE_LABEL } from './presence';
import { goTo } from '../../nav';
import type { PanelProps } from '../index';

/**
 * Around, in the order you would want to see them.
 *
 * `unknown` is excluded and that is the load-bearing choice here. Discord's REST
 * API carries no presence at all, so every Discord-only friend is `unknown` —
 * over a hundred of them on this install against a couple of dozen of everything
 * else. Including them would fill the panel with people nobody can vouch for and
 * bury the handful who are genuinely there, which is the exact failure the
 * Friends screen already had to fix by sorting them last.
 *
 * `offline` is excluded for the obvious reason, and `dnd` is kept: busy is
 * somebody who is *there* and has asked to be left alone, which is worth seeing
 * next to the person you were about to message.
 */
const AROUND: FriendRow['state'][] = ['in-game', 'online', 'away', 'dnd'];
const RANK = new Map(AROUND.map((state, i) => [state, i]));

export default function FriendsPanel(_props: PanelProps) {
  /*
   * The same request the Friends screen makes, which refreshes anything staler
   * than 60 seconds as a side effect of being read. That is why this needs no
   * poller of its own: having the panel open *is* the read, and the staleness
   * check inside the endpoint does the rest.
   */
  const state = useAsync(() => api.integrations.friends(), [], ['integrations']);

  if (state.loading) return <div className="empty">loading…</div>;
  /*
   * Stated rather than swallowed. A panel that silently shows nothing when the
   * request failed is indistinguishable from one where nobody is online, and
   * the two want completely different reactions.
   */
  if (state.error) return <div className="empty">Could not load: {state.error.message}</div>;

  const all = state.data?.friends ?? [];
  const around = all
    .filter((friend) => RANK.has(friend.state))
    .sort((a, b) => (RANK.get(a.state) ?? 9) - (RANK.get(b.state) ?? 9) || a.name.localeCompare(b.name));

  return (
    <>
      <div className="row between" style={{ alignItems: 'baseline' }}>
        <h2 style={{ margin: 0 }}>Around</h2>
        {around.length > 0 && <span className="meta">{around.length}</span>}
      </div>

      {around.length === 0 && (
        <div className="empty">
          {/*
            Two different sentences, because they are two different situations
            with two different fixes. "Nobody is online" from an install with
            nothing connected reads as a broken integration, and sends somebody
            looking at a problem that is a service they never set up.
          */}
          {all.length === 0
            ? 'No friends synced yet — connect a service on the Connections tab.'
            : 'Nobody is around.'}
        </div>
      )}

      {around.map((friend) => (
        /*
         * The whole row is the button, rather than a magnifying glass beside
         * the name. In a 320px column an icon per row is width taken from the
         * thing the column is for — and a row that is entirely the hit target is
         * easier to hit than a 20px square, which matters more than the icon
         * would have communicated. The cursor and the hover state say it is
         * live; the label says what it does.
         */
        <button
          className="card panel-row"
          key={friend.id}
          title={`Find ${friend.name} in Connections`}
          aria-label={`Find ${friend.name} in Connections`}
          onClick={() => goTo('integrations', { search: friend.name })}
        >
          <div className="row" style={{ alignItems: 'center', gap: '.6rem' }}>
            {/* The same wrapper and dot the Friends screen uses, from the core
                stylesheet — a second set of presence colours is the one thing
                here that must not be allowed to drift, since green meaning
                online is learned from every other chat client on this machine. */}
            <span className="avatar-wrap">
              {friend.avatarUrl ? (
                <img src={friend.avatarUrl} alt="" width={28} height={28} style={{ borderRadius: 6 }} />
              ) : (
                <span className="glyph" aria-hidden="true">
                  👤
                </span>
              )}
              <span
                className={`presence-dot presence-${friend.state}`}
                title={STATE_LABEL[friend.state]}
                aria-label={STATE_LABEL[friend.state]}
                role="img"
              />
            </span>

            <div className="grow" style={{ minWidth: 0 }}>
              <div className="title truncate">{friend.name}</div>
              {/* What they are playing outranks the status word — "playing
                  Deep Rock Galactic" is the answer and "online" is the less
                  useful half of it. */}
              <div className="meta truncate">{friend.game ?? friend.detail ?? STATE_LABEL[friend.state]}</div>
            </div>
          </div>
        </button>
      ))}
    </>
  );
}
