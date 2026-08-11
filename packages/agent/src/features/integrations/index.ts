/**
 * The presence only this PC can see.
 *
 * Three of the seven services in this module publish nothing a server can call
 * for a friends list, so what is available is local: the League client's own
 * loopback API.
 *
 * Epic and Battle.net were here too, reporting whether their launchers were
 * running — the honest whole of what those two can offer, since neither
 * publishes a friends API at any access level. They have been removed along
 * with the providers: "the launcher is open" is true, and is not worth a row on
 * a screen about who is around.
 *
 * Cost, against the budget in CLAUDE.md:
 *
 *   - Riot: one loopback HTTPS request every 30s, and **only while the League
 *     client is running** — no lockfile means no request, and the lockfile check
 *     is a `stat`.
 *   - one POST to the server per change, plus a heartbeat every 2 minutes so
 *     the server can tell "nothing has changed" from "the agent has stopped".
 */
import { readFriends, readLock, type RiotFriend } from './riot.js';

/**
 * What this needs from the agent, named structurally.
 *
 * The same boundary `index.ts` draws around voice, and for the same reason:
 * core must not import a feature, so the feature declares what it wants rather
 * than the agent handing it a type from here.
 */
export interface PresenceHost {
  postPresence(report: {
    provider: string;
    clientRunning: boolean;
    friends: RiotFriend[] | [];
    error?: string;
  }): Promise<unknown>;
}

/** How often Riot is asked, while it is running. */
const RIOT_POLL_MS = 30_000;

/**
 * How often a provider reports even when nothing has changed.
 *
 * The server marks a local provider stale after five minutes of silence, and
 * distinguishes that from "the client is closed" — those have different fixes
 * (start the agent, versus start the game), so the heartbeat has to be
 * comfortably inside the window or a perfectly healthy agent would be reported
 * as missing.
 */
const HEARTBEAT_MS = 2 * 60_000;

interface Sent {
  fingerprint: string;
  at: number;
}

export function startIntegrations(host: PresenceHost, log: (message: string) => void): { stop(): void } {
  const lastSent = new Map<string, Sent>();

  /** Only post when something changed, or when the heartbeat is due. */
  const send = async (provider: string, clientRunning: boolean, friends: RiotFriend[], error?: string) => {
    const fingerprint = [
      clientRunning ? '1' : '0',
      error ?? '',
      ...friends.map((f) => `${f.providerUserId}:${f.state}:${f.game ?? ''}`).sort(),
    ].join('|');

    const previous = lastSent.get(provider);
    if (previous && previous.fingerprint === fingerprint && Date.now() - previous.at < HEARTBEAT_MS) return;

    try {
      await host.postPresence({ provider, clientRunning, friends, error });
      lastSent.set(provider, { fingerprint, at: Date.now() });
    } catch (cause) {
      // A server that is down must not be reported as a failure of the League
      // client — the agent already has its own backoff for an unreachable
      // server, and this is not the place to duplicate it.
      log(`presence for ${provider} could not be sent: ${(cause as Error).message}`);
    }
  };

  /* ---- Riot: the lockfile, then the client's own API -------------- */

  let riotTimer: NodeJS.Timeout | undefined;
  let riotBusy = false;

  const pollRiot = async () => {
    // Serialised, because a client that is starting up can hold a request open
    // for the whole timeout and the next tick must not stack on top of it.
    if (riotBusy) return;
    riotBusy = true;

    try {
      const lock = readLock();
      if (!lock) {
        // No lockfile is the definition of "not running". The server keeps the
        // last real snapshot rather than emptying the list, so closing League
        // leaves the names on screen marked as last seen.
        await send('riot', false, []);
        return;
      }

      try {
        await send('riot', true, await readFriends(lock));
      } catch (cause) {
        // The client is up but would not answer — starting, patching, or the
        // endpoint has moved. Reported as an error against a *running* client,
        // which is a different thing to show than "closed".
        await send('riot', true, [], (cause as Error).message);
      }
    } finally {
      riotBusy = false;
    }
  };

  void pollRiot();
  riotTimer = setInterval(() => void pollRiot(), RIOT_POLL_MS);
  // Not a reason to keep the process alive on its own.
  riotTimer.unref();

  return {
    stop() {
      if (riotTimer) clearInterval(riotTimer);
    },
  };
}
