/**
 * What "sync this" and "refresh the friends list" actually do.
 *
 * One dispatcher rather than seven route handlers, so the failure handling —
 * which is most of the work — is written once. Every provider here can fail for
 * reasons that are entirely normal (a revoked token, a private profile, a closed
 * game client), and the rule throughout is that a failure must end up *on the
 * screen*, attached to the provider it belongs to, rather than in a log.
 */
import {
  LIVE_PROVIDERS,
  LIVE_STALE_MS,
  PRESENCE_PROVIDERS,
  PRESENCE_STALE_MS,
  PROVIDERS,
  type Capability,
  type ProviderId,
} from '@everything/shared/integrations';
import { changes } from '../../events.js';
import { missingCredentials } from './oauth.js';
import { friendsFreshness, getAccount, liveFreshness, markFailed, markSynced } from './store.js';
import * as canvas from './providers/canvas.js';
import * as discord from './providers/discord.js';
import * as spotify from './providers/spotify.js';
import * as steam from './providers/steam.js';
import * as twitch from './providers/twitch.js';
import * as youtube from './providers/youtube.js';

export interface SyncOutcome {
  provider: ProviderId;
  capability: Capability;
  ok: boolean;
  /** Something to show: what happened, or why it didn't. */
  note: string;
}

/**
 * Which capabilities each provider can actually be asked to do *here*.
 *
 * Distinct from the manifest's capability list, which describes what the service
 * offers. This is the subset with code behind it, which is not always the whole
 * of what a provider declares.
 */
type Runner = () => Promise<{ notes: string[] }>;

const RUNNERS: Partial<Record<ProviderId, Partial<Record<Capability, Runner>>>> = {
  spotify: {
    playlists: spotify.syncPlaylists,
    follows: spotify.syncFollows,
  },
  youtube: {
    playlists: youtube.syncPlaylists,
    follows: youtube.syncFollows,
  },
  steam: {
    friends: async () => {
      const { count, online } = await steam.syncFriends();
      return {
        notes: [
          count === 0
            ? 'Steam returned no friends. That is usually the privacy setting rather than an empty list — ' +
              'both your profile and your friends list have to be Public.'
            : `${count} friends, ${online} online`,
        ],
      };
    },
  },
  discord: {
    friends: async () => {
      const { count, online } = await discord.syncFriends();
      return { notes: [`${count} friends, ${online} online`] };
    },
  },
  twitch: {
    live: async () => {
      const { count } = await twitch.syncLive();
      return {
        notes: [
          count === 0
            ? 'Nobody you follow is live right now.'
            : `${count} ${count === 1 ? 'channel is' : 'channels are'} live`,
        ],
      };
    },
    follows: async () => {
      const { count } = await twitch.syncFollows();
      return { notes: [`${count} channels followed`] };
    },
  },
  canvas: {
    assignments: async () => {
      const { seen, created, rescheduled, completed, untouched } = await canvas.syncAssignments();

      if (seen === 0) {
        return {
          notes: [
            'Canvas answered, with nothing due. That is either a quiet fortnight or a term that has ' +
              'not started — the planner only carries courses you are currently enrolled on.',
          ],
        };
      }

      // Spelled out rather than reduced to "n tasks", because three of these four
      // numbers are the app having changed something you did not ask it to, and
      // "4 rescheduled" is the line worth reading.
      const parts = [`${seen} with a deadline`];
      if (created > 0) parts.push(`${created} new ${created === 1 ? 'task' : 'tasks'}`);
      if (rescheduled > 0) parts.push(`${rescheduled} rescheduled`);
      if (completed > 0) parts.push(`${completed} ticked off as handed in`);
      if (created + rescheduled + completed === 0) parts.push(`${untouched} already up to date`);
      return { notes: [parts.join(', ')] };
    },
  },
};

export function runnableCapabilities(provider: ProviderId): Capability[] {
  return Object.keys(RUNNERS[provider] ?? {}) as Capability[];
}

/**
 * Run one or more of a provider's capabilities.
 *
 * Each capability is caught separately, so a Spotify history fetch failing does
 * not throw away a playlist sync that took four minutes and succeeded. The
 * outcomes come back as a list rather than one boolean for the same reason —
 * "playlists worked, history didn't" is the answer, and collapsing it loses the
 * half worth knowing.
 */
export async function syncProvider(provider: ProviderId, capabilities?: Capability[]): Promise<SyncOutcome[]> {
  const runners = RUNNERS[provider];
  if (!runners) return [];

  const missing = await missingCredentials(provider);
  if (missing.length > 0) {
    return [
      {
        // The provider's own first capability, not a hard-coded `playlists`.
        // That was right while every configurable provider had one and became a
        // small lie the moment one did not — "Canvas · playlists: not
        // configured" names something Canvas has never claimed to do.
        provider,
        capability: (Object.keys(runners)[0] ?? 'playlists') as Capability,
        ok: false,
        note: `not configured — fill in its fields on the Services tab, or set ${missing.join(' and ')}`,
      },
    ];
  }

  const wanted = (capabilities ?? (Object.keys(runners) as Capability[])).filter((c) => runners[c]);
  const outcomes: SyncOutcome[] = [];

  for (const capability of wanted) {
    try {
      const result = await runners[capability]!();
      await markSynced(provider, capability);
      outcomes.push({ provider, capability, ok: true, note: result.notes.join('; ') });
    } catch (error) {
      const message = (error as Error).message;
      await markFailed(provider, message);
      outcomes.push({ provider, capability, ok: false, note: message });
    }
  }

  // One announcement for the whole sync, not one per capability — the clients
  // reload on it, and a two-capability sync should not reload them twice.
  changes.emitChange('integrations');
  /*
   * `assignments` is the one capability whose output is not on this feature's
   * own screens, so the `integrations` scope does not reach the readers that
   * care. Without this a sync writes tasks into the database and the Dashboard
   * sitting open in front of you shows the old list until something else
   * happens to change — which reads as the sync not having worked.
   */
  if (wanted.includes('assignments')) changes.emitChange('tasks');
  return outcomes;
}

/**
 * Bring the friends list up to date, for the providers that can be.
 *
 * **Refresh-on-read, with a staleness check, rather than a background poller.**
 * That is a leanness decision with a number attached: a 60-second poll is 1,440
 * requests a day forever, in a project whose attention loop was tuned down to
 * ~1,500 database rows a day and which requires anything on a timer to justify
 * itself against those figures. Nobody is looking at a friends list at four in
 * the morning, and a list nobody is looking at does not need to be right.
 *
 * The cost of this choice is honest and small: the first render after opening
 * the screen may be up to a minute old, and then it is live for as long as you
 * are watching.
 */
export async function refreshPresence(force = false): Promise<SyncOutcome[]> {
  const freshness = await friendsFreshness();
  const outcomes: SyncOutcome[] = [];

  for (const provider of PRESENCE_PROVIDERS) {
    // Local providers are pushed by the agent, not pulled. Asking Riot for a
    // friends list from here is not a thing that can be done.
    if (PROVIDERS[provider].reach === 'local') continue;
    if (!RUNNERS[provider]?.friends) continue;

    const account = await getAccount(provider);
    if (!account) continue;

    const lastSeen = freshness.get(provider) ?? 0;
    if (!force && Date.now() - lastSeen < PRESENCE_STALE_MS) continue;

    try {
      const result = await RUNNERS[provider]!.friends!();
      outcomes.push({ provider, capability: 'friends', ok: true, note: result.notes.join('; ') });
    } catch (error) {
      const message = (error as Error).message;
      await markFailed(provider, message);
      outcomes.push({ provider, capability: 'friends', ok: false, note: message });
    }
  }

  return outcomes;
}

/**
 * Bring the live list up to date, for the providers that can answer.
 *
 * Refresh-on-read with a staleness check, like `refreshPresence` and for the
 * same reason — but with a shorter window, because the two lists go stale at
 * different speeds. Presence is checked against a minute; a stream that started
 * four minutes ago is still news, and one that ended four minutes ago is a link
 * to a channel that is no longer on. Thirty seconds is the compromise, and it
 * still costs nothing while nobody is looking at the tab.
 */
export async function refreshLive(force = false): Promise<SyncOutcome[]> {
  const freshness = await liveFreshness();
  const outcomes: SyncOutcome[] = [];

  for (const provider of LIVE_PROVIDERS) {
    if (!RUNNERS[provider]?.live) continue;

    const account = await getAccount(provider);
    if (!account?.accessToken) continue;

    const lastSeen = freshness.get(provider) ?? 0;
    if (!force && Date.now() - lastSeen < LIVE_STALE_MS) continue;

    try {
      const result = await RUNNERS[provider]!.live!();
      outcomes.push({ provider, capability: 'live', ok: true, note: result.notes.join('; ') });
    } catch (error) {
      const message = (error as Error).message;
      await markFailed(provider, message);
      outcomes.push({ provider, capability: 'live', ok: false, note: message });
    }
  }

  return outcomes;
}
