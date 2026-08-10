/**
 * Steam: who is online, and what they are playing.
 *
 * The one presence integration in this module that simply works. No OAuth, no
 * approval process, no client that has to be running — a Web API key, your
 * 64-bit id, and two requests.
 *
 * The catch is at the other end and worth saying plainly on the screen: the API
 * honours your Steam privacy settings, so a friends list set to anything other
 * than Public returns an empty array with a 200. Success and "you have no
 * friends visible" are the same response, which is why `syncFriends` reports the
 * count rather than just writing it.
 */
import type { Friend, PresenceState } from '@everything/shared/integrations';
import { config } from '../../../config.js';
import { getAccount, replaceFriends } from '../store.js';

const API = 'https://api.steampowered.com';

/**
 * Steam's `personastate`, which has six values that mean four things to us.
 *
 * `snooze` and `looking to trade/play` all collapse to away or online: the
 * question a friends list answers is "could I say hello", and none of the finer
 * states change it. Playing something outranks all of them, which is why the
 * game is checked first — a friend in-game shows as `online` in this field.
 */
const PERSONA_STATES: Record<number, PresenceState> = {
  0: 'offline',
  1: 'online',
  2: 'away', // busy
  3: 'away',
  4: 'away', // snooze
  5: 'online', // looking to trade
  6: 'online', // looking to play
};

interface PlayerSummary {
  steamid: string;
  personaname: string;
  avatarmedium?: string;
  personastate?: number;
  gameextrainfo?: string;
  lastlogoff?: number;
  /** 1 = private, 3 = public. Anything else and the fields above are absent. */
  communityvisibilitystate?: number;
}

function key(): string {
  if (!config.STEAM_API_KEY) throw new Error('STEAM_API_KEY is not set');
  return config.STEAM_API_KEY;
}

async function steamGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const query = new URLSearchParams({ key: key(), ...params });
  const response = await fetch(`${API}${path}?${query}`);

  if (!response.ok) {
    // 401 and 403 here almost always mean the key is wrong or the profile is
    // private, and Steam says neither — so the status is passed through rather
    // than translated into a guess.
    throw new Error(`Steam returned ${response.status} for ${path}`);
  }

  return (await response.json()) as T;
}

/**
 * Steam's friends list, with everyone's current status.
 *
 * Two requests regardless of how many friends you have: the second takes up to
 * a hundred ids at a time, and a list longer than that is rare enough that the
 * loop is cheap insurance rather than the normal path.
 */
export async function syncFriends(): Promise<{ count: number; online: number }> {
  const account = await getAccount('steam');
  const steamId = account?.externalId;
  if (!steamId) throw new Error('Steam is not connected — no Steam ID stored');

  const list = await steamGet<{ friendslist?: { friends: Array<{ steamid: string }> } }>(
    '/ISteamUser/GetFriendList/v1/',
    { steamid: steamId, relationship: 'friend' }
  );

  const ids = list.friendslist?.friends.map((f) => f.steamid) ?? [];
  if (ids.length === 0) {
    await replaceFriends('steam', []);
    // Not an error, but not nothing either. An empty list from Steam is far
    // more often a privacy setting than a genuinely empty friends list, and the
    // caller turns this count into a line on the screen that says so.
    return { count: 0, online: 0 };
  }

  const friends: Friend[] = [];

  for (let i = 0; i < ids.length; i += 100) {
    const summaries = await steamGet<{ response: { players: PlayerSummary[] } }>(
      '/ISteamUser/GetPlayerSummaries/v2/',
      { steamids: ids.slice(i, i + 100).join(',') }
    );

    for (const player of summaries.response.players) {
      // In a game beats every persona state. Someone playing Deep Rock
      // Galactic reports `personastate: 1`, and "online" is the less useful
      // half of what Steam just told us.
      const state: PresenceState = player.gameextrainfo
        ? 'in-game'
        : PERSONA_STATES[player.personastate ?? 0] ?? 'offline';

      friends.push({
        provider: 'steam',
        providerUserId: player.steamid,
        name: player.personaname,
        avatarUrl: player.avatarmedium,
        state,
        game: player.gameextrainfo,
        lastOnlineAt: player.lastlogoff ? player.lastlogoff * 1000 : undefined,
      });
    }
  }

  await replaceFriends('steam', friends);
  return { count: friends.length, online: friends.filter((f) => f.state !== 'offline').length };
}

/** Confirm a pasted key and id actually work, before storing them. */
export async function verify(steamId: string): Promise<{ id: string; name: string }> {
  const summaries = await steamGet<{ response: { players: PlayerSummary[] } }>(
    '/ISteamUser/GetPlayerSummaries/v2/',
    { steamids: steamId }
  );

  const me = summaries.response.players[0];
  // A well-formed id that belongs to nobody comes back as an empty array with a
  // 200, so this is the only place the mistake can be caught.
  if (!me) throw new Error('Steam does not know that ID — check it is the 17-digit one');

  return { id: me.steamid, name: me.personaname };
}
