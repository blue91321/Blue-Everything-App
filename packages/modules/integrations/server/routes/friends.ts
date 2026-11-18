/**
 * Friends: who is online across every connected service, linking accounts
 * that are one person, and the presence the agent reports for services only
 * this PC can ask (Riot).
 */
import type { FastifyInstance } from 'fastify';
import {
  PROVIDER_LIST,
  IDENTITY_PREFERENCE,
  trustedPresence,
  type PresenceState,
  isHiddenByProviders,
  linkFriendsSchema,
  localPresenceSchema,
  presenceRank,
  type ProviderId,
} from '@everything/shared/integrations';
import { z } from 'zod';
import { changes } from '@everything/server/module-api';
import { getSettings } from '@everything/server/module-api';
import { parseHiddenProviders } from '@everything/server/module-api';
import { missingCredentials } from '../oauth.js';
import { localStatusOf, recordLocalPresence } from '../providers/local.js';
import { allFriends, getAccount, linkFriends, suggestFriendLinks, unlinkFriend, unlinkPerson } from '../store.js';
import { refreshPresence } from '../sync.js';

export async function friendRoutes(app: FastifyInstance): Promise<void> {
  /* ---- friends --------------------------------------------------- */

  /**
   * The friends list, refreshed if it has gone stale.
   *
   * The refresh happens inside the read on purpose — see `refreshPresence` for
   * why there is no background poller. `?force=1` is the manual refresh button,
   * which exists because "I know they just came online" is a real thing to know.
   */
  app.get('/api/integrations/friends', async (request) => {
    const { force } = request.query as { force?: string };

    const outcomes = await refreshPresence(force === '1');
    /*
     * Read *after* the refresh, so `seenAt` reflects whatever just succeeded.
     * That ordering is what makes one rule cover every provider: a web service
     * that answered has a fresh row, one that failed does not, and a local
     * client that is shut never had the chance — three different causes, one
     * observable fact, which is "when did anybody last confirm this".
     */
    const now = Date.now();
    /*
     * Counted per provider as it decays, so the screen can name the cause. A
     * hundred and sixty hollow rings with nothing saying why is the failure this
     * screen is most against — it reads as the app having broken rather than as
     * a client that is shut.
     */
    const unconfirmed = new Map<string, number>();
    const rows = (await allFriends()).map((row) => {
      const state = trustedPresence(row.state as PresenceState, row.seenAt, now);
      if (state !== row.state) unconfirmed.set(row.provider, (unconfirmed.get(row.provider) ?? 0) + 1);
      return { ...row, state };
    });

    /*
     * One row per person, not per account.
     *
     * Linked accounts were each returned separately, so a person you had
     * matched up appeared twice — which is the opposite of what linking them
     * was for. They are merged here, and the merge answers two questions from
     * two different rows:
     *
     *   - *who is this* comes from `IDENTITY_PREFERENCE`, Discord first,
     *     because that is where somebody chose a name and a picture for
     *     themselves rather than whatever their Steam persona happens to be;
     *   - *what are they doing* comes from whichever account actually knows,
     *     which is never Discord — its API carries no presence at all.
     *
     * Done on read rather than stored: the underlying rows refresh on their own
     * schedules, and a merged copy in the database would be a third thing to
     * keep in step.
     */
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = row.personId ?? `solo:${row.id}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }

    const identityRank = (provider: string) => {
      const index = IDENTITY_PREFERENCE.indexOf(provider as ProviderId);
      return index === -1 ? IDENTITY_PREFERENCE.length : index;
    };

    const resolved = [...groups.entries()].map(([key, group]) => {
      const identity = [...group].sort((a, b) => identityRank(a.provider) - identityRank(b.provider))[0];

      // The best thing anybody can actually vouch for. `unknown` is excluded
      // rather than ranked, so a Discord row never outvotes a Steam one that
      // knows the answer.
      const knows = group
        .filter((r) => r.state !== 'unknown')
        .sort(
          (x, y) =>
            presenceRank[x.state as keyof typeof presenceRank] - presenceRank[y.state as keyof typeof presenceRank]
        )[0];

      const speaking = knows ?? identity;

      return {
        id: key,
        personId: identity.personId,
        name: identity.name,
        avatarUrl: identity.avatarUrl,
        provider: identity.provider,
        state: speaking.state,
        game: speaking.game,
        detail: speaking.detail,
        lastOnlineAt: speaking.lastOnlineAt,
        /*
         * From whichever account is actually speaking, not from the identity
         * one — the name may come from Discord while the status comes from
         * Steam, and it is the Steam row that knows when this started.
         *
         * Sent as a timestamp rather than a duration: the browser can subtract,
         * and a number computed here would be stale the moment it arrived.
         */
        stateSince: speaking.stateSince,
        seenAt: identity.seenAt,
        /** Named when the status came from a different account than the name. */
        statusFrom: knows && knows.provider !== identity.provider ? knows.provider : null,
        /** Every service this person is on, for the row and for unlinking. */
        accounts: group.map((r) => ({
          id: r.id,
          provider: r.provider,
          name: r.name,
          /*
           * The service's own id, which is what a deep link needs — the `id`
           * beside it is this app's row key and means nothing to Discord.
           * Carried for every provider rather than only the one that uses it
           * today, since it is already in hand and a second provider with a
           * "message them" link would otherwise be a second change here.
           */
          providerUserId: r.providerUserId,
        })),
      };
    });

    /*
     * Services you have chosen to leave out.
     *
     * **Only when *every* account a person has is on a hidden service.** That is
     * the whole distinction: hiding Riot should drop the hundred people you know
     * only from League, and must not drop the friend you play League *and* talk
     * to on Discord with — that person is still someone you wanted to see, and
     * quietly losing them is exactly what makes a filter untrustworthy.
     *
     * Filtered here rather than in the PWA because the rule has to live once,
     * and the PWA cannot import `shared` to share it. This way the phone gets
     * the same list without a second copy of the condition.
     */
    const hidden = parseHiddenProviders((await getSettings()).hiddenProviders);
    const visible = resolved.filter((entry) => !isHiddenByProviders(entry.accounts, hidden));

    return {
      friends: visible.sort(
        (a, b) =>
          presenceRank[a.state as keyof typeof presenceRank] - presenceRank[b.state as keyof typeof presenceRank] ||
          a.name.localeCompare(b.name)
      ),
      /**
       * What is being left out, and how many.
       *
       * Reported rather than merely applied: this screen's whole principle is
       * that a short list explains itself, and "nobody is online" reads as a
       * broken integration when the real answer is a filter you set weeks ago.
       */
      hiddenProviders: hidden,
      hiddenCount: resolved.length - visible.length,
      /** Per-provider health, so an empty list can explain itself. */
      sources: await Promise.all(
        PROVIDER_LIST.filter((p) => p.capabilities.friends).map(async (p) => {
          const account = await getAccount(p.id);
          return {
            provider: p.id,
            label: p.label,
            status: p.capabilities.friends!.status,
            why: p.capabilities.friends!.why,
            connected: account !== null,
            missingConfig: missingCredentials(p.id),
            lastError: account?.lastError ?? null,
            local: p.reach === 'local' ? localStatusOf(p.id) : null,
            /**
             * How many of this service's rows have gone too long unconfirmed to
             * still say what anybody is doing. Reported rather than merely
             * applied, for the same reason `hiddenCount` is.
             */
            unconfirmed: unconfirmed.get(p.id) ?? 0,
          };
        })
      ),
      refreshed: outcomes,
    };
  });

  /**
   * Say that two accounts are the same person.
   *
   * Not local-only, unlike connecting a service. It was, on the reasoning
   * that a pairing is a claim about people you know — but it touches nothing
   * outside this app, comes apart in one tap, and the suggestion card offering
   * it showed on the phone and did nothing when pressed. Linking, unlinking
   * and choosing a creator's main account are tidying a list, which is what
   * the phone is for; a bearer token still guards them like any other write.
   */
  app.post('/api/integrations/friends/link', async (request) => {
    const { a, b } = linkFriendsSchema.parse(request.body);
    const personId = await linkFriends(a, b);
    changes.emitChange('integrations');
    return { personId };
  });

  /**
   * Undo a link.
   *
   * By `personId` for a merged row, which is one thing on screen and should
   * come apart in one action; by `id` to take a single account out of a group
   * of three and leave the rest joined. The screen uses the first, and the
   * second exists because a group is not always a pair.
   */
  app.post('/api/integrations/friends/unlink', async (request) => {
    const body = z
      .object({ id: z.string().min(1).optional(), personId: z.string().min(1).optional() })
      .refine((v) => v.id || v.personId, { message: 'give an id or a personId' })
      .parse(request.body);

    if (body.personId) await unlinkPerson(body.personId);
    else if (body.id) await unlinkFriend(body.id);

    changes.emitChange('integrations');
    return { ok: true };
  });

  /**
   * Accounts whose names look like the same person.
   *
   * Suggestions only — Discord will not tell us a friend's Steam profile, so
   * there is nothing authoritative to import and a name is a guess. Confirmed
   * one at a time by the person who knows.
   */
  app.get('/api/integrations/friends/suggestions', async () => ({
    suggestions: await suggestFriendLinks(),
  }));

  /**
   * Where the agent posts what only this PC can see.
   *
   * Excluded from the change announcer in `events.ts` — it arrives on a timer
   * and `recordLocalPresence` announces only when the snapshot actually differs.
   */
  app.post('/api/integrations/presence', async (request) => {
    const report = localPresenceSchema.parse(request.body);
    await recordLocalPresence(report);
    return { ok: true };
  });
}
