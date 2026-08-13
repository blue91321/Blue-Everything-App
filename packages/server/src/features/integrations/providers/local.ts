/**
 * The providers only this PC can see.
 *
 * Riot, Epic and Battle.net publish nothing a server can call for a friends
 * list. What exists is on the machine the games are installed on: the League
 * client opens a loopback HTTPS port for its own interface, and the launchers
 * are processes with names. The agent reads those and posts the result here.
 *
 * **The division is the same one the voice feature draws.** Anything about
 * *data* happens on the server, which owns the database. Anything about *this
 * machine* happens in the agent, because the server is meant to be movable and
 * has no business assuming the League client is on the same box. Putting a
 * lockfile read in the server would end that, quietly, the first time it worked.
 *
 * What the server keeps is the last snapshot and when it arrived. `clientRunning`
 * is stored separately from an empty friends list because they are completely
 * different facts that render identically: "League is closed" and "everyone is
 * offline" both draw zero rows, and only one of them is worth doing something
 * about.
 */
import {
  LOCAL_PRESENCE_STALE_MS,
  type LocalPresence,
  type ProviderId,
  type ReportedFriend,
} from '@everything/shared/integrations';
import { changes } from '../../../events.js';
import { replaceFriends } from '../store.js';

interface LocalStatus {
  clientRunning: boolean;
  error?: string;
  at: number;
  /** What the last report actually said, so an identical one can be ignored. */
  fingerprint: string;
}

/**
 * A cheap stand-in for "is this the same list as last time".
 *
 * The agent reports on a timer and the overwhelmingly common answer is "exactly
 * what I said last time", so comparing is what keeps this from waking every
 * open browser every few seconds. Only the fields that are *shown* go into it —
 * a friend's avatar URL changing behind the scenes is not a reason to reload
 * the page.
 */
function fingerprintOf(clientRunning: boolean, friends: ReportedFriend[]): string {
  return [
    clientRunning ? '1' : '0',
    ...friends
      .map((f) => `${f.providerUserId}:${f.state}:${f.game ?? ''}:${f.detail ?? ''}`)
      .sort(),
  ].join('|');
}

/**
 * In memory, like `currentWindowsDnd` and the voice status.
 *
 * "Is the League client open right now" cannot be answered from a log, and
 * writing a row every time the agent reports would be exactly the polling this
 * app avoids everywhere else. The friends themselves do go to the database —
 * they are worth having when the client closes — but the liveness of the client
 * is state, and state that survives a restart would be a lie.
 */
const status = new Map<ProviderId, LocalStatus>();

export async function recordLocalPresence(report: LocalPresence): Promise<void> {
  const previous = status.get(report.provider);
  const fingerprint = fingerprintOf(report.clientRunning, report.friends);
  const changed = previous?.fingerprint !== fingerprint;

  status.set(report.provider, {
    clientRunning: report.clientRunning,
    error: report.error,
    at: Date.now(),
    fingerprint,
  });

  /*
   * A closed client must not empty the list.
   *
   * The agent reports `clientRunning: false` with no friends, which is the
   * truth about what it can see and *not* the truth about who your friends are.
   * Writing that through would delete the whole list every time you quit
   * League, so the last real snapshot is kept and marked stale instead — the
   * screen says "last seen twenty minutes ago" rather than showing nobody.
   *
   * **`error` has to be checked too, and leaving it out cost real data.** The
   * agent's other empty-list path is "the client is up but would not answer" —
   * starting, patching, mid-restart — and that reports `clientRunning: true`
   * with an error and no friends. `replaceFriends` prunes anything absent from
   * the snapshot, so every Riot friend was deleted and re-inserted with fresh
   * ids on the next good poll, **taking every link to a Discord account with
   * them**. Five pairs were found unpicked this way, each leaving a stranded
   * group of one, and nothing about it was visible: the names came straight
   * back, just no longer joined to anybody.
   *
   * The two cases were always the same claim — "I cannot see the list right
   * now" — and only one of them said so.
   */
  if (report.clientRunning && !report.error) await replaceFriends(report.provider, report.friends);

  // Announced here rather than by the generic hook, which is excluded for this
  // route: the report arrives on a timer and nearly always says the same thing,
  // so waking every browser for it would be the polling this stream replaced.
  if (changed) changes.emitChange('integrations');
}

export interface LocalProviderStatus {
  clientRunning: boolean;
  /** When the agent last said anything at all about this provider. */
  reportedAt: number | null;
  /** True when the agent has gone quiet — stopped, crashed, or never ran. */
  stale: boolean;
  error?: string;
}

export function localStatusOf(provider: ProviderId): LocalProviderStatus {
  const entry = status.get(provider);
  if (!entry) return { clientRunning: false, reportedAt: null, stale: true };

  return {
    clientRunning: entry.clientRunning,
    reportedAt: entry.at,
    // An agent that has stopped reporting is a different problem from a client
    // that is closed, and the screen has different advice for each: start the
    // game, versus start the agent.
    stale: Date.now() - entry.at > LOCAL_PRESENCE_STALE_MS,
    error: entry.error,
  };
}
