/**
 * Discord: who you are, and — if Discord has approved your application — who is
 * online.
 *
 * The friends list is behind `sdk.social_layer_presence`, a Social SDK scope
 * granted per-application on request in the developer portal. There is no
 * ordinary OAuth scope that returns relationships, and the other way people
 * reach this data — a user account token lifted out of the desktop client — is
 * against Discord's terms and is not implemented here.
 *
 * So this file is written to work correctly in *both* states, because the
 * unapproved one is where most installs will live:
 *
 *   - connected with `identify` only: the connection is real, the account name
 *     is shown, and the friends capability reports why it is empty;
 *   - connected with presence granted: the list works.
 *
 * `grantedScopes` is what tells them apart, and checking it is the whole point.
 * An app that asked for a scope it was not given gets a token anyway, so
 * assuming the request succeeded produces an empty friends list and a 403 in a
 * log nobody reads.
 */
import type { Friend, PresenceState } from '@everything/shared/integrations';
import { apiGet, grantedScopes } from '../oauth.js';
import { getAccount, replaceFriends } from '../store.js';

const API = 'https://discord.com/api/v10';

/** The scope that carries relationships. Everything else here is decoration. */
export const PRESENCE_SCOPE = 'sdk.social_layer_presence';

const STATUS_MAP: Record<string, PresenceState> = {
  online: 'online',
  idle: 'away',
  dnd: 'away',
  offline: 'offline',
  invisible: 'offline',
};

interface Relationship {
  /** 1 = friend. OAuth only ever returns those, but the field is checked anyway. */
  type: number;
  user: { id: string; username: string; global_name?: string | null; avatar?: string | null };
  presence?: {
    status?: string;
    activities?: Array<{ name?: string; type?: number; state?: string; details?: string }>;
  };
}

export async function whoAmI(): Promise<{ id: string; name: string }> {
  const me = await apiGet<{ id: string; username: string; global_name?: string | null }>(
    'discord',
    `${API}/users/@me`
  );
  return { id: me.id, name: me.global_name ?? me.username };
}

/** Whether this connection can actually read a friends list. */
export async function hasPresenceScope(): Promise<boolean> {
  return grantedScopes(await getAccount('discord')).includes(PRESENCE_SCOPE);
}

function avatarUrl(user: Relationship['user']): string | undefined {
  return user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64` : undefined;
}

/**
 * Turn an activity list into "what are they doing".
 *
 * Type 0 is playing a game, which is the one worth surfacing; type 4 is a
 * custom status, which is a mood rather than an activity and belongs in the
 * detail line instead. Listening to Spotify (type 2) is genuinely interesting
 * here given the rest of this module, so it is kept as detail.
 */
function activityOf(presence: Relationship['presence']): { game?: string; detail?: string } {
  const activities = presence?.activities ?? [];
  const playing = activities.find((a) => a.type === 0)?.name;
  const custom = activities.find((a) => a.type === 4)?.state;
  const listening = activities.find((a) => a.type === 2);

  return {
    game: playing,
    detail: custom ?? (listening ? `${listening.details ?? 'Listening'} — ${listening.state ?? ''}`.trim() : undefined),
  };
}

export async function syncFriends(): Promise<{ count: number; online: number }> {
  if (!(await hasPresenceScope())) {
    throw new Error(
      `Discord did not grant ${PRESENCE_SCOPE}. Request Social SDK access for this application in the ` +
        'developer portal, then connect again. Until then Discord can confirm who you are and nothing more.'
    );
  }

  const relationships = await apiGet<Relationship[]>('discord', `${API}/users/@me/relationships`);

  const friends: Friend[] = relationships
    .filter((r) => r.type === 1)
    .map((r) => {
      /*
       * **No presence at all is `unknown`, not `offline`.**
       *
       * `GET /users/@me/relationships` returns the list with no `presence` key
       * on any entry — presence reaches Discord's own client over the gateway,
       * not over REST. Defaulting the absent case to `offline` reported a
       * hundred people as away from their computers on no evidence, which is
       * worse than admitting we cannot see.
       *
       * The mapping is kept for the day the payload does carry one, so an entry
       * that *does* have presence is still read properly.
       */
      const status: PresenceState = r.presence?.status
        ? STATUS_MAP[r.presence.status] ?? 'unknown'
        : 'unknown';
      const { game, detail } = activityOf(r.presence);
      return {
        provider: 'discord' as const,
        providerUserId: r.user.id,
        name: r.user.global_name ?? r.user.username,
        avatarUrl: avatarUrl(r.user),
        // Playing something is more useful than "online", exactly as on Steam.
        state: game && status !== 'offline' && status !== 'unknown' ? 'in-game' : status,
        game,
        detail,
      };
    });

  await replaceFriends('discord', friends);
  // `online` counts only what we can actually vouch for, so a list of a hundred
  // unknowns does not report itself as a hundred people online.
  return {
    count: friends.length,
    online: friends.filter((f) => f.state !== 'offline' && f.state !== 'unknown').length,
  };
}
