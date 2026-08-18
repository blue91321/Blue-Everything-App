/**
 * Twitch: who you follow, and which of them is on air.
 *
 * **The only service here that answers the live question in one request.**
 * `GET /helix/streams/followed` takes your user id and returns every followed
 * channel currently broadcasting, sorted by viewers. No per-channel fan-out and
 * no quota arithmetic — which is the whole reason the Live tab is possible.
 *
 * The contrast is worth keeping written down, because it looks like an omission
 * otherwise: YouTube has no equivalent endpoint. Asking "is this channel live"
 * costs a `search.list` at 100 quota units against a 10,000/day default, so at
 * 408 subscriptions a single sweep would cost 40,800 — four times the day's
 * allowance, for one refresh. That is why `LIVE_PROVIDERS` has one member.
 */
import { type LiveStream } from '@everything/shared/integrations';
import { apiGet, clientId } from '../oauth.js';
import { getAccount, replaceFollows, replaceLive, saveAccount } from '../store.js';

const API = 'https://api.twitch.tv/helix';

/** Every Helix call needs the application's id beside the user's token. */
async function helix<T>(path: string): Promise<T> {
  return apiGet<T>('twitch', `${API}${path}`, { 'Client-Id': await clientId('twitch') });
}

interface TwitchUser {
  id: string;
  login: string;
  display_name: string;
  profile_image_url?: string;
}

interface FollowedStream {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  game_name?: string;
  title: string;
  viewer_count?: number;
  started_at?: string;
  thumbnail_url?: string;
}

interface FollowedChannel {
  broadcaster_id: string;
  broadcaster_login: string;
  broadcaster_name: string;
  followed_at?: string;
}

/**
 * Who the token belongs to.
 *
 * Stored on connect rather than fetched per sync: both endpoints below want a
 * `user_id` query parameter, and it is the one thing about the account that
 * cannot change under us.
 */
export async function identify(): Promise<{ id: string; name: string }> {
  const me = await helix<{ data: TwitchUser[] }>('/users');
  const user = me.data?.[0];
  if (!user) throw new Error('Twitch returned no account for that token');

  await saveAccount('twitch', {
    accountId: user.id,
    externalId: user.id,
    accountName: user.display_name || user.login,
    lastError: null,
  });

  return { id: user.id, name: user.display_name || user.login };
}

/** The stored user id, identifying once if connecting predated it. */
async function userId(): Promise<string> {
  const account = await getAccount('twitch');
  if (account?.accountId) return account.accountId;
  return (await identify()).id;
}

/**
 * Everything followed that is live right now.
 *
 * Paginated because the endpoint caps at 100 per page, and somebody who follows
 * a few hundred channels can genuinely have more than that on air at a busy
 * hour. Bounded at ten pages for the same reason the Canvas planner is: a
 * misread cursor should stop rather than loop.
 */
export async function syncLive(): Promise<{ count: number }> {
  const id = await userId();

  const streams: LiveStream[] = [];
  let cursor = '';

  for (let page = 0; page < 10; page += 1) {
    const query = new URLSearchParams({ user_id: id, first: '100' });
    if (cursor) query.set('after', cursor);

    const body = await helix<{ data: FollowedStream[]; pagination?: { cursor?: string } }>(
      `/streams/followed?${query}`
    );

    for (const stream of body.data ?? []) {
      streams.push({
        provider: 'twitch',
        providerAccountId: stream.user_id,
        streamId: stream.id,
        channelName: stream.user_name || stream.user_login,
        title: stream.title?.trim() || '(no title)',
        // Empty rather than absent when they have not set one, the way Riot's
        // game fields arrive — so `||` and not `??`.
        category: stream.game_name || null,
        viewers: stream.viewer_count ?? null,
        startedAt: stream.started_at ? Date.parse(stream.started_at) : null,
        /*
         * Twitch hands back a template with `{width}` and `{height}` in it
         * rather than a URL. Left unfilled it 404s, which reads as a broken
         * image for every row.
         */
        thumbnailUrl: stream.thumbnail_url
          ? stream.thumbnail_url.replace('{width}', '440').replace('{height}', '248')
          : null,
        url: `https://twitch.tv/${stream.user_login}`,
      });
    }

    cursor = body.pagination?.cursor ?? '';
    if (!cursor) break;
  }

  await replaceLive('twitch', streams);
  return { count: streams.length };
}

/**
 * The channels you follow, for the Following tab.
 *
 * Separate from the live list on purpose — following is a standing fact about
 * you and being live is a fact about them, so one is upserted and kept while the
 * other is replaced wholesale.
 */
export async function syncFollows(): Promise<{ count: number }> {
  const id = await userId();

  const accounts = [];
  let cursor = '';

  for (let page = 0; page < 20; page += 1) {
    const query = new URLSearchParams({ user_id: id, first: '100' });
    if (cursor) query.set('after', cursor);

    const body = await helix<{ data: FollowedChannel[]; pagination?: { cursor?: string } }>(
      `/channels/followed?${query}`
    );

    for (const channel of body.data ?? []) {
      accounts.push({
        provider: 'twitch' as const,
        providerAccountId: channel.broadcaster_id,
        kind: 'channel' as const,
        name: channel.broadcaster_name || channel.broadcaster_login,
        url: `https://twitch.tv/${channel.broadcaster_login}`,
      });
    }

    cursor = body.pagination?.cursor ?? '';
    if (!cursor) break;
  }

  await replaceFollows('twitch', accounts);
  return { count: accounts.length };
}
