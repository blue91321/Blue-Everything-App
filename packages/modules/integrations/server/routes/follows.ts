/**
 * Following: the channels and artists you follow, which of them are live,
 * starring one, and linking accounts that are one creator.
 */
import type { FastifyInstance } from 'fastify';
import {
  PROVIDERS,
  FOLLOW_PROVIDERS,
  LIVE_PROVIDERS,
  isHiddenByProviders,
  type ProviderId,
} from '@everything/shared/integrations';
import { z } from 'zod';
import { changes } from '@everything/server/module-api';
import { getSettings } from '@everything/server/module-api';
import { parseHiddenProviders } from '@everything/server/module-api';
import { missingCredentials } from '../oauth.js';
import {
  allFollows,
  allLive,
  getAccount,
  linkFollows,
  setFollowFavourite,
  setPrimaryFollow,
  unlinkFollow,
  followPlaylistCounts,
  followsFreshness,
} from '../store.js';
import { refreshLive } from '../sync.js';

export async function followRoutes(app: FastifyInstance): Promise<void> {
  /* ---- the same, for accounts you follow -------------------------- */

  /**
   * Say that two followed accounts are the same creator.
   *
   * Deliberately **not** `linkFriendsSchema`, which would be the obvious reuse:
   * that one exists next to a rule that the two must be different services, and
   * here they very often are not — a main channel and a clips channel is the
   * commonest case. Sharing the schema would have invited sharing the rule.
   */
  app.post('/api/integrations/follows/link', async (request) => {
    const { a, b } = z.object({ a: z.string().min(1), b: z.string().min(1) }).parse(request.body);
    const groupId = await linkFollows(a, b);
    changes.emitChange('integrations');
    return { groupId };
  });

  /** Which of a group's accounts the merged row wears. */
  app.post('/api/integrations/follows/primary', async (request) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.body);
    await setPrimaryFollow(id);
    changes.emitChange('integrations');
    return { ok: true };
  });

  /**
   * Take one account out of its group.
   *
   * By account rather than by group, unlike the friends version. A creator's
   * group can hold several channels, and dissolving all of them to correct one
   * wrong link would be a poor trade — whereas a friends row is nearly always a
   * pair, where the two are the same action.
   */
  app.post('/api/integrations/follows/unlink', async (request) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.body);
    await unlinkFollow(id);
    changes.emitChange('integrations');
    return { ok: true };
  });

  /**
   * Accounts you follow — YouTube channels, Spotify artists.
   *
   * A plain read with no refresh-on-read, unlike friends. A subscription list
   * changes when *you* change it, perhaps monthly; presence changes minute to
   * minute. Refreshing this on every open would spend YouTube quota to confirm
   * what it said yesterday, so it is synced on demand like a playlist.
   */
  /* ---- who is on air --------------------------------------------- */

  /**
   * The live list, refreshed if it has gone stale.
   *
   * Same shape as `/friends` — refresh inside the read, no background poller —
   * with a shorter staleness window, because a stream that ended three minutes
   * ago is a link to a channel that is not on.
   *
   * **`sources` explains an empty list**, which matters more here than anywhere
   * else on this screen: "nobody is live" and "Twitch is not connected" and
   * "YouTube cannot answer this at all" are three different situations that all
   * render as nothing, and only one of them is about your friends' habits.
   */
  app.get('/api/integrations/live', async (request) => {
    const { force } = request.query as { force?: string };
    const refreshed = await refreshLive(force === '1');

    const hidden = parseHiddenProviders((await getSettings()).hiddenProviders);
    const all = await allLive();
    const streams = all.filter((row) => !hidden.includes(row.provider));

    const sources = await Promise.all(
      LIVE_PROVIDERS.map(async (provider) => {
        const account = await getAccount(provider);
        const spec = PROVIDERS[provider];
        return {
          provider,
          label: spec.label,
          why: spec.capabilities.live?.why ?? '',
          connected: Boolean(account?.accessToken),
          missingConfig: await missingCredentials(provider),
          lastError: account?.lastError ?? null,
        };
      })
    );

    return {
      streams,
      sources,
      hiddenCount: all.length - streams.length,
      /*
       * Sent so the panel can narrow itself without a second request for
       * settings. The *panel* applies it rather than this route: the Live tab
       * always shows everything, and filtering here would mean two endpoints or
       * a query parameter to tell them apart.
       */
      scope: (await getSettings()).livePanelScope,
      refreshed,
    };
  });

  /**
   * Star a channel, or take the star off.
   *
   * Keyed by `(provider, providerAccountId)` rather than a `follows` row id,
   * because the caller is a row on the Live tab: it has the channel in hand and
   * no business knowing this app's own primary keys.
   *
   * **Not local-only.** A star is your data, like a habit — editable from the
   * phone, unlike anything that changes a connection.
   */
  app.post('/api/integrations/follows/favourite', async (request, reply) => {
    const body = z
      .object({
        provider: z.string().min(1).max(40),
        providerAccountId: z.string().min(1).max(200),
        favourite: z.boolean(),
      })
      .parse(request.body);

    const written = await setFollowFavourite(
      body.provider as ProviderId,
      body.providerAccountId,
      body.favourite
    );

    /*
     * A live channel with no followed-channels row yet cannot be starred, and
     * saying so is better than a silent 200 that changes nothing — the star
     * would spring back on the next reload with no explanation.
     */
    if (!written) {
      return reply.code(409).send({
        error:
          'that channel is not in the followed list yet — press Sync on the Twitch card and try again',
      });
    }

    changes.emitChange('integrations');
    return { favourite: body.favourite };
  });

  app.get('/api/integrations/follows', async () => {
    const freshness = await followsFreshness();
    const counts = await followPlaylistCounts();
    const rows = await allFollows();

    /*
     * The same setting as the friends list, applied the only way that makes
     * sense here.
     *
     * A follow belongs to exactly one service — a YouTube channel is not also a
     * Spotify artist — so there is no equivalent of "they are on two of these
     * and one is hidden". Hiding YouTube leaves out its channels and hiding
     * Spotify leaves out its artists, which is the plain reading of the switch,
     * and `isHiddenByProviders` gives it for free: with one account the
     * every-account test *is* the single-provider test.
     */
    const hidden = parseHiddenProviders((await getSettings()).hiddenProviders);
    const visible = rows.filter((row) => !isHiddenByProviders([{ provider: row.provider }], hidden));

    /*
     * One row per creator, not per account — the same merge the friends list
     * does, for the same reason: a main channel and its clips channel linked
     * together should stop being two entries.
     *
     * Two things differ from friends. The identity is the member you *chose*
     * rather than one a preference order picked, because no rule can say which
     * of two YouTube channels is the main one. And `inPlaylists` is **summed**
     * across the group rather than taken from the identity: the number is what
     * the list sorts by, and showing only the main channel's share would rank a
     * creator below people you listen to far less.
     */
    const groups = new Map<string, typeof visible>();
    for (const row of visible) {
      const key = row.groupId ?? `solo:${row.id}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }

    const merged = [...groups.entries()].map(([key, group]) => {
      // `ensurePrimary` guarantees one, but a row read mid-write should still
      // render rather than throw — so fall back rather than assume.
      const identity = group.find((row) => row.isPrimary === 1) ?? group[0];

      return {
        ...identity,
        id: key,
        /** Null when this stands alone, so the UI can tell a group from a row. */
        groupId: identity.groupId,
        inPlaylists: group.reduce(
          (total, row) => total + (counts.get(`${row.provider}:${row.providerAccountId}`) ?? 0),
          0
        ),
        /** Every account behind this row, for the chips and for unlinking. */
        accounts: group.map((row) => ({
          id: row.id,
          provider: row.provider,
          name: row.name,
          kind: row.kind,
          isPrimary: row.isPrimary === 1,
        })),
      };
    });

    return {
      /*
       * Each one carries how many of its tracks or videos are in your
       * collections, because that is what the tab sorts by out of the box —
       * "who am I following that I actually listen to" is a more useful first
       * screen than an alphabetical list of four hundred names.
       */
      follows: merged,
      /** What is being left out, so a short list can explain itself. */
      hiddenProviders: hidden,
      hiddenCount: rows.length - visible.length,
      sources: FOLLOW_PROVIDERS.map((id) => ({
        provider: id,
        label: PROVIDERS[id].label,
        status: PROVIDERS[id].capabilities.follows!.status,
        why: PROVIDERS[id].capabilities.follows!.why,
        syncedAt: freshness.get(id) ?? null,
      })),
    };
  });
}
