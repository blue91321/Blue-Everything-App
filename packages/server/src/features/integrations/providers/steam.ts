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
import { steamProfileInput, type Friend, type PresenceState } from '@everything/shared/integrations';
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

/**
 * The key to use: the one stored with the account, or the env var.
 *
 * That order, because the stored one is what the screen can actually change.
 * An env var that silently won the tie would make re-pasting a key in the app
 * appear to work and change nothing — the same class of bug as the features
 * file being read from the wrong directory.
 */
async function keyFor(): Promise<string> {
  const account = await getAccount('steam');
  if (account?.apiKey) return account.apiKey;
  if (config.STEAM_API_KEY) return config.STEAM_API_KEY;
  throw new Error('Steam is not connected — no API key stored');
}

async function steamGet<T>(apiKey: string, path: string, params: Record<string, string>): Promise<T> {
  const query = new URLSearchParams({ key: apiKey, ...params });
  const response = await fetch(`${API}${path}?${query}`);

  if (!response.ok) {
    /*
     * 401 and 403 are what a bad key looks like, and Steam sends no body worth
     * quoting — so the one thing it *could* be is said outright. Passing the
     * bare status through was accurate and useless: "Steam returned 403" sends
     * you to the privacy settings, which is the wrong half of the problem.
     */
    if (response.status === 401 || response.status === 403) {
      // 400, not 500: a rejected key is something you typed, not something that
      // went wrong here. A 500 also means Fastify logs it at error level, which
      // fills the log with entries about a typo.
      throw Object.assign(
        new Error(
          `Steam rejected the API key (${response.status}). Check it at steamcommunity.com/dev/apikey — ` +
            'keys are revoked when you change your password.'
        ),
        { statusCode: 400 }
      );
    }
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

  const apiKey = await keyFor();

  const list = await steamGet<{ friendslist?: { friends: Array<{ steamid: string }> } }>(
    apiKey,
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
      apiKey,
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

/**
 * Turn whatever was typed into the profile box into a 64-bit Steam ID.
 *
 * `steamProfileInput` does the parsing without a network; only a custom name
 * has to be asked about. Doing this at all is the point — the first step of
 * connecting Steam used to be "go to steamid.io and look up a number", which is
 * a chore Steam's own API will do for you.
 */
async function resolveProfile(apiKey: string, profile: string): Promise<string> {
  const parsed = steamProfileInput(profile);
  if ('steamId' in parsed) return parsed.steamId;

  const resolved = await steamGet<{ response: { success: number; steamid?: string } }>(
    apiKey,
    '/ISteamUser/ResolveVanityURL/v1/',
    { vanityurl: parsed.vanity }
  );

  // success is 1 for a match and 42 for "no match", both with a 200.
  if (resolved.response.success !== 1 || !resolved.response.steamid) {
    throw Object.assign(
      new Error(
        `Steam has no profile called "${parsed.vanity}". Paste your profile URL, or the 17-digit ID ` +
          'from Steam → Profile → Edit Profile.'
      ),
      { statusCode: 400 }
    );
  }

  return resolved.response.steamid;
}

/**
 * Confirm a key and a profile actually work, before either is stored.
 *
 * Verifying first is what turns two silent failure modes into messages: a
 * revoked key and a mistyped profile both store perfectly happily and then fail
 * on every refresh afterwards, with an error about privacy settings that sends
 * you looking in entirely the wrong place.
 */
export async function verify(apiKey: string, profile: string): Promise<{ id: string; name: string }> {
  const steamId = await resolveProfile(apiKey, profile);

  const summaries = await steamGet<{ response: { players: PlayerSummary[] } }>(
    apiKey,
    '/ISteamUser/GetPlayerSummaries/v2/',
    { steamids: steamId }
  );

  const me = summaries.response.players[0];
  // A well-formed id that belongs to nobody comes back as an empty array with a
  // 200, so this is the only place the mistake can be caught.
  if (!me) {
    throw Object.assign(new Error(`Steam does not know the ID ${steamId} — check the profile you pasted.`), {
      statusCode: 400,
    });
  }

  return { id: me.steamid, name: me.personaname };
}
