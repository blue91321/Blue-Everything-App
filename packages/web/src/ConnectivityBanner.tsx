/**
 * Offline, syncing, or a change that did not land — said on every screen.
 *
 * The app works without the server now by showing what this device last saw,
 * and that is only honest with this line above it: a task list from this
 * morning presented as the current one is exactly the stale-data-as-fact this
 * app is built against. So it says when the data is from, and how many changes
 * are waiting to reach the PC.
 *
 * A change the PC refused on replay (a task since deleted there, say) is listed
 * rather than dropped quietly — it did not happen, and you should know that.
 */
import { onServersMachine } from './device';
import { dismissProblems, useConnectivity } from './offline-sync';

function clock(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === today.toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

/**
 * On the PC that runs the server, offline means the server is stopped — and
 * this used to be the screen with a button to start it. The saved data now
 * shows instead, so the button comes with it. Same `everything://` link the
 * offline screen uses, and the same reason it is an anchor rather than a
 * script: Chromium hands a URL to another program only for a real click.
 */

export function ConnectivityBanner() {
  const c = useConnectivity();
  const waiting = c.pending > 0 ? ` · ${c.pending} change${c.pending === 1 ? '' : 's'} waiting to sync` : '';

  return (
    <>
      {c.offline && (
        <p className="offline-banner" role="status">
          <strong>Offline</strong> — showing what this device saved
          {c.shownFrom ? ` (as of ${clock(c.shownFrom)})` : ''}
          {waiting}. Changes you make are kept and{' '}
          {onServersMachine() ? 'saved once the app is running again' : 'sent when the PC is reachable'}.
          {onServersMachine() && (
            <>
              {' '}
              <a className="btn subtle" href="everything://start">
                Start it
              </a>{' '}
              or double-click <code>Blue Everything.cmd</code>.
            </>
          )}
        </p>
      )}
      {!c.offline && c.pending > 0 && (
        <p className="offline-banner syncing" role="status">
          {c.syncing ? 'Syncing' : 'Waiting to sync'} {c.pending} change{c.pending === 1 ? '' : 's'} made offline…
        </p>
      )}
      {c.problems.length > 0 && (
        <div className="banner" role="alert">
          <p>
            {c.problems.length === 1 ? 'A change made offline' : `${c.problems.length} changes made offline`} could not be
            applied on the PC:
          </p>
          <ul>
            {c.problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
          <button className="btn subtle" onClick={dismissProblems}>
            OK
          </button>
        </div>
      )}
    </>
  );
}
