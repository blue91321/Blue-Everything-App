/**
 * Everything this feature reads and writes, in one place.
 *
 * The providers below are deliberately dumb about storage: each one turns a
 * third-party JSON shape into the app's own vocabulary and hands it here. That
 * boundary is what makes adding a provider a single file, and what stops seven
 * slightly different opinions about how to upsert a track from accumulating.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  categoriseGenres,
  type FollowedAccount,
  type CollectionKind,
  type MediaKind,
  type LiveStream,
  type ProviderId,
  type ReportedFriend,
} from '@everything/shared/integrations';
import { db } from '../../db/client.js';
import {
  follows,
  friends,
  integrationAccounts,
  integrationTaskLinks,
  liveStreams,
  mediaCollectionItems,
  mediaCollections,
  mediaItems,
  tasks,
} from '../../db/schema.js';

export type Account = typeof integrationAccounts.$inferSelect;

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

export async function getAccount(provider: ProviderId): Promise<Account | null> {
  const [row] = await db.select().from(integrationAccounts).where(eq(integrationAccounts.id, provider));
  return row ?? null;
}

export async function listAccounts(): Promise<Account[]> {
  return db.select().from(integrationAccounts);
}

/**
 * Insert or update the one row for a provider.
 *
 * `onConflictDoUpdate` rather than a read-then-write, because the OAuth callback
 * and a background refresh can genuinely land at the same moment — you press
 * Connect on a connection that is halfway through renewing itself — and the
 * read-then-write version of that quietly discards one of the two tokens.
 */
export async function saveAccount(provider: ProviderId, values: Partial<Account>): Promise<void> {
  await db
    .insert(integrationAccounts)
    .values({ id: provider, ...values })
    .onConflictDoUpdate({
      target: integrationAccounts.id,
      set: { ...values, updatedAt: Date.now() },
    });
}

export async function forgetAccount(provider: ProviderId): Promise<void> {
  await db.delete(integrationAccounts).where(eq(integrationAccounts.id, provider));
}

/** Per-capability sync clock, stored as JSON because it is only read whole. */
export function syncedAtOf(account: Account | null): Record<string, number> {
  if (!account) return {};
  try {
    return JSON.parse(account.syncedAt) as Record<string, number>;
  } catch {
    return {};
  }
}

export async function markSynced(provider: ProviderId, capability: string): Promise<void> {
  const account = await getAccount(provider);
  const clock = { ...syncedAtOf(account), [capability]: Date.now() };
  await saveAccount(provider, { syncedAt: JSON.stringify(clock), lastError: null });
}

export async function markFailed(provider: ProviderId, message: string): Promise<void> {
  // Truncated, because some providers return an entire HTML error page and a
  // settings screen is not the place to render one.
  await saveAccount(provider, { lastError: message.slice(0, 500) });
}

/* ------------------------------------------------------------------ */
/* Media                                                               */
/* ------------------------------------------------------------------ */

export interface IncomingItem {
  providerItemId: string;
  kind: MediaKind;
  title: string;
  creator?: string | null;
  /** The provider's ids for those artists, or the one channel. */
  creatorIds?: string[];
  album?: string | null;
  durationMs?: number | null;
  url?: string | null;
  artUrl?: string | null;
  /** The provider's own strings, kept verbatim alongside the folded category. */
  genres?: string[];
  /** Already-decided category, for providers that categorise differently. */
  category?: string;
  categoryBecause?: string | null;
  releasedAt?: number | null;
}

/**
 * Upsert a batch of tracks or videos and hand back their local ids, in the same
 * order they came in.
 *
 * Batched rather than one round trip per item because a Spotify library is
 * routinely several thousand tracks, and at one statement each a first sync
 * takes minutes of pure SQLite overhead for work that is a single insert.
 */
export async function upsertItems(provider: ProviderId, incoming: IncomingItem[]): Promise<string[]> {
  if (incoming.length === 0) return [];

  const rows = incoming.map((item) => {
    // Categorising here rather than in each provider means one definition of
    // what a genre string turns into, and a keyword-table improvement reaches
    // every provider on the next sync rather than the one it was tested against.
    const decided =
      item.category !== undefined
        ? { category: item.category, because: item.categoryBecause ?? null }
        : (() => {
            const c = categoriseGenres(item.genres ?? []);
            return { category: c.category, because: c.because };
          })();

    return {
      provider,
      providerItemId: item.providerItemId,
      kind: item.kind,
      title: item.title,
      creator: item.creator ?? null,
      creatorIds: JSON.stringify(item.creatorIds ?? []),
      album: item.album ?? null,
      durationMs: item.durationMs ?? null,
      url: item.url ?? null,
      artUrl: item.artUrl ?? null,
      genres: JSON.stringify(item.genres ?? []),
      category: decided.category,
      categoryBecause: decided.because,
      releasedAt: item.releasedAt ?? null,
    };
  });

  // Chunked well under SQLite's 999-variable statement limit: fourteen columns
  // per row means about seventy rows is the real ceiling, and 50 leaves room.
  const ids: string[] = [];
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50);
    const written = await db
      .insert(mediaItems)
      .values(chunk)
      .onConflictDoUpdate({
        target: [mediaItems.provider, mediaItems.providerItemId],
        set: {
          title: sql`excluded.title`,
          creator: sql`excluded.creator`,
          creatorIds: sql`excluded.creator_ids`,
          album: sql`excluded.album`,
          durationMs: sql`excluded.duration_ms`,
          url: sql`excluded.url`,
          artUrl: sql`excluded.art_url`,
          genres: sql`excluded.genres`,
          category: sql`excluded.category`,
          categoryBecause: sql`excluded.category_because`,
          releasedAt: sql`excluded.released_at`,
          updatedAt: Date.now(),
        },
      })
      .returning({ id: mediaItems.id, providerItemId: mediaItems.providerItemId });

    // RETURNING does not promise the input order, so the ids are matched back by
    // the key they were inserted under rather than by position.
    const byKey = new Map(written.map((w) => [w.providerItemId, w.id]));
    for (const row of chunk) {
      const id = byKey.get(row.providerItemId);
      if (id) ids.push(id);
    }
  }

  return ids;
}

export interface IncomingCollection {
  providerCollectionId: string;
  kind: CollectionKind;
  name: string;
  description?: string | null;
  artUrl?: string | null;
  itemCount?: number;
  snapshotId?: string | null;
  /**
   * Ignore this one unless told otherwise — applied on insert and never on
   * update, so unticking the box is not undone by the next sync.
   */
  ignoredByDefault?: boolean;
}

export async function upsertCollection(
  provider: ProviderId,
  incoming: IncomingCollection
): Promise<{ id: string; snapshotId: string | null }> {
  const [row] = await db
    .insert(mediaCollections)
    .values({
      provider,
      providerCollectionId: incoming.providerCollectionId,
      kind: incoming.kind,
      name: incoming.name,
      description: incoming.description ?? null,
      artUrl: incoming.artUrl ?? null,
      itemCount: incoming.itemCount ?? 0,
      snapshotId: incoming.snapshotId ?? null,
      ignored: incoming.ignoredByDefault ? 1 : 0,
    })
    .onConflictDoUpdate({
      target: [mediaCollections.provider, mediaCollections.providerCollectionId],
      set: {
        name: incoming.name,
        description: incoming.description ?? null,
        artUrl: incoming.artUrl ?? null,
        itemCount: incoming.itemCount ?? 0,
        updatedAt: Date.now(),
      },
    })
    .returning({
      id: mediaCollections.id,
      snapshotId: mediaCollections.snapshotId,
      ignored: mediaCollections.ignored,
    });

  return row;
}

/**
 * Replace a collection's contents wholesale.
 *
 * Delete-then-insert rather than a diff, and that is the right call for a
 * playlist: reordering one track changes every position after it, so a diff
 * ends up rewriting most of the rows anyway while being much easier to get
 * subtly wrong. Removals are also the case a naive diff misses entirely.
 */
export async function replaceCollectionItems(
  collectionId: string,
  itemIds: string[],
  addedAt: Array<number | null> = []
): Promise<void> {
  await db.delete(mediaCollectionItems).where(eq(mediaCollectionItems.collectionId, collectionId));
  if (itemIds.length === 0) return;

  const rows = itemIds.map((itemId, position) => ({
    collectionId,
    itemId,
    position,
    addedAt: addedAt[position] ?? null,
  }));

  for (let i = 0; i < rows.length; i += 100) {
    await db.insert(mediaCollectionItems).values(rows.slice(i, i + 100));
  }
}

/** Tick or untick one playlist. */
export async function setCollectionIgnored(id: string, ignored: boolean): Promise<void> {
  await db
    .update(mediaCollections)
    .set({ ignored: ignored ? 1 : 0, updatedAt: Date.now() })
    .where(eq(mediaCollections.id, id));
}

/**
 * The provider's collection ids that are ticked to be left alone.
 *
 * Keyed by the *provider's* id rather than ours, because that is what a sync
 * has in hand while walking the provider's list — it decides whether to fetch a
 * playlist before it has looked ours up.
 */
export async function ignoredCollectionKeys(provider: ProviderId): Promise<Set<string>> {
  const rows = await db
    .select({ key: mediaCollections.providerCollectionId })
    .from(mediaCollections)
    .where(and(eq(mediaCollections.provider, provider), eq(mediaCollections.ignored, 1)));
  return new Set(rows.map((r) => r.key));
}

export async function markCollectionSynced(collectionId: string, snapshotId: string | null): Promise<void> {
  await db
    .update(mediaCollections)
    .set({ snapshotId, syncedAt: Date.now() })
    .where(eq(mediaCollections.id, collectionId));
}

export async function collectionsFor(provider?: ProviderId) {
  const query = db.select().from(mediaCollections).orderBy(mediaCollections.provider, mediaCollections.name);
  return provider ? query.where(eq(mediaCollections.provider, provider)) : query;
}

export async function itemsInCollection(collectionId: string) {
  return db
    .select({
      id: mediaItems.id,
      title: mediaItems.title,
      creator: mediaItems.creator,
      album: mediaItems.album,
      durationMs: mediaItems.durationMs,
      url: mediaItems.url,
      artUrl: mediaItems.artUrl,
      category: mediaItems.category,
      categoryBecause: mediaItems.categoryBecause,
      genres: mediaItems.genres,
      position: mediaCollectionItems.position,
    })
    .from(mediaCollectionItems)
    .innerJoin(mediaItems, eq(mediaItems.id, mediaCollectionItems.itemId))
    .where(eq(mediaCollectionItems.collectionId, collectionId))
    .orderBy(mediaCollectionItems.position)
    .limit(2000);
}

/** How the library breaks down by family — the summary the Music tab opens on. */
export async function categoryBreakdown(provider?: ProviderId) {
  /*
   * Only what is in a playlist you have not ticked off.
   *
   * The same condition `followPlaylistCounts` uses, for the same reason: a
   * ticked playlist is one you have said should not count, and counting it
   * anywhere else makes the tick a half-measure. On this install the difference
   * is 1,879 items against 86 — the Music tab was describing a library that was
   * ninety-five per cent the one playlist you had excluded.
   *
   * Items in *no* collection are excluded too. There are none today, but a
   * playlist deleted at the provider would leave some, and "my library" means
   * what is in my playlists rather than everything ever seen.
   */
  const inAKeptPlaylist = sql`exists (
    select 1
    from media_collection_items ci
    join media_collections mc on mc.id = ci.collection_id
    where ci.item_id = ${mediaItems.id} and mc.ignored = 0
  )`;

  return db
    .select({
      category: mediaItems.category,
      count: sql<number>`count(*)`.as('count'),
    })
    .from(mediaItems)
    .where(provider ? and(eq(mediaItems.provider, provider), inAKeptPlaylist) : inAKeptPlaylist)
    .groupBy(mediaItems.category)
    .orderBy(desc(sql`count(*)`));
}

/* ------------------------------------------------------------------ */
/* Friends                                                             */
/* ------------------------------------------------------------------ */

/**
 * Replace what we know about one provider's friends.
 *
 * A whole snapshot, because a friends list is a set and "Ash is no longer in
 * it" is a change that a stream of individual updates cannot express. Everyone
 * the provider did not mention is deleted, which is right: an unfriended person
 * lingering in the list forever, permanently offline, is the sort of small wrong
 * thing that quietly erodes trust in a screen.
 *
 * Upsert-then-prune rather than delete-then-insert, even though the second is
 * two lines shorter. This runs every time the friends screen refreshes, and
 * deleting the rows would hand every friend a new primary key each minute —
 * which is both pointless write churn against a project that counts its rows
 * per day, and a guarantee that nothing downstream can ever hold a reference to
 * a person.
 */
export async function replaceFriends(provider: ProviderId, incoming: ReportedFriend[]): Promise<void> {
  const now = Date.now();

  const rows = incoming.map((f) => ({
    provider,
    providerUserId: f.providerUserId,
    name: f.name,
    avatarUrl: f.avatarUrl ?? null,
    state: f.state,
    game: f.game ?? null,
    detail: f.detail ?? null,
    lastOnlineAt: f.lastOnlineAt ?? null,
    seenAt: now,
  }));

  for (let i = 0; i < rows.length; i += 100) {
    await db
      .insert(friends)
      .values(rows.slice(i, i + 100))
      .onConflictDoUpdate({
        target: [friends.provider, friends.providerUserId],
        set: {
          name: sql`excluded.name`,
          avatarUrl: sql`excluded.avatar_url`,
          state: sql`excluded.state`,
          game: sql`excluded.game`,
          detail: sql`excluded.detail`,
          lastOnlineAt: sql`excluded.last_online_at`,
          seenAt: now,
          updatedAt: now,
        },
      });
  }

  // Anyone this provider no longer mentions. `seenAt` is the marker rather than
  // a list of ids, so this stays one statement however many friends there are.
  await db.delete(friends).where(and(eq(friends.provider, provider), sql`${friends.seenAt} < ${now}`));
}

export async function allFriends() {
  return db.select().from(friends);
}

/** When each provider's list was last written, for the staleness check. */
export async function friendsFreshness(): Promise<Map<string, number>> {
  const rows = await db
    .select({ provider: friends.provider, seenAt: sql<number>`max(${friends.seenAt})`.as('seenAt') })
    .from(friends)
    .groupBy(friends.provider);
  return new Map(rows.map((r) => [r.provider, r.seenAt]));
}

/* ------------------------------------------------------------------ */
/* Accounts you follow                                                 */
/* ------------------------------------------------------------------ */

/**
 * Replace what we know about one provider's followed accounts.
 *
 * Identical shape to `replaceFriends`, deliberately: upsert then prune by
 * `seenAt`, so ids survive a refresh and an unsubscribe actually leaves. The
 * duplication between the two is four lines of column names, and the
 * alternative — one generic snapshot writer over two tables with different
 * columns — would be harder to read than either.
 */
export async function replaceFollows(provider: ProviderId, incoming: FollowedAccount[]): Promise<void> {
  const now = Date.now();

  const rows = incoming.map((account) => {
    // Categorised here rather than in the provider, so one definition of what a
    // genre string means covers tracks and artists alike.
    const decided = categoriseGenres(account.genres ?? []);
    return {
      provider,
      providerAccountId: account.providerAccountId,
      kind: account.kind,
      name: account.name,
      url: account.url ?? null,
      avatarUrl: account.avatarUrl ?? null,
      genres: JSON.stringify(account.genres ?? []),
      category: decided.category,
      categoryBecause: decided.because,
      followerCount: account.followerCount ?? null,
      seenAt: now,
    };
  });

  for (let i = 0; i < rows.length; i += 100) {
    await db
      .insert(follows)
      .values(rows.slice(i, i + 100))
      .onConflictDoUpdate({
        target: [follows.provider, follows.providerAccountId],
        set: {
          kind: sql`excluded.kind`,
          name: sql`excluded.name`,
          url: sql`excluded.url`,
          avatarUrl: sql`excluded.avatar_url`,
          genres: sql`excluded.genres`,
          category: sql`excluded.category`,
          categoryBecause: sql`excluded.category_because`,
          followerCount: sql`excluded.follower_count`,
          seenAt: now,
          updatedAt: now,
        },
      });
  }

  // Anyone this provider no longer lists — an unsubscribe, or an artist you
  // stopped following. One statement however long the list is.
  await db.delete(follows).where(and(eq(follows.provider, provider), sql`${follows.seenAt} < ${now}`));
}

export async function allFollows() {
  return db.select().from(follows).orderBy(follows.provider, follows.name);
}

/* ---- grouping accounts that are the same creator ------------------ */

/**
 * Join two follows into one row on the screen.
 *
 * Mirrors `linkFriends`, with **one deliberate difference: both may be on the
 * same service.** A creator with a main channel and a clips channel is the
 * commonest reason to want this, and the friends rule — one person, one Discord
 * — simply is not true of channels.
 *
 * Groups absorb rather than nest, so linking a third account to a pair gives a
 * group of three rather than stranding anybody, and linking two existing groups
 * merges them whole.
 */
export async function linkFollows(idA: string, idB: string): Promise<string> {
  const rows = await db.select().from(follows).where(inArray(follows.id, [idA, idB]));

  if (rows.length !== 2) {
    const found = new Set(rows.map((r) => r.id));
    const missing = [idA, idB].filter((id) => !found.has(id));
    throw Object.assign(
      new Error(`no followed account has ${missing.length === 1 ? 'the id' : 'the ids'} ${missing.join(', ')}`),
      { statusCode: 404 }
    );
  }

  if (idA === idB) {
    throw Object.assign(new Error('that is the same account twice'), { statusCode: 400 });
  }

  const [a, b] = rows;
  const groupId = a.groupId ?? b.groupId ?? randomUUID();
  const absorbing = [a.groupId, b.groupId].filter((id): id is string => Boolean(id) && id !== groupId);

  await db.update(follows).set({ groupId }).where(inArray(follows.id, [idA, idB]));
  if (absorbing.length > 0) {
    await db.update(follows).set({ groupId }).where(inArray(follows.groupId, absorbing));
  }

  /*
   * A brand-new group has no main yet, and a group with none would render with
   * no name at all. The account that was already grouped keeps its main if it
   * had one; otherwise the one that was dragged onto the other wins, which for
   * a fresh pair is whichever you started from.
   */
  await ensurePrimary(groupId);
  return groupId;
}

/**
 * Exactly one member carries `isPrimary`.
 *
 * Called after every operation that can change a group's membership, because
 * "which of these is the main one" is the single piece of state a merged row
 * cannot render without — and both unlinking the main and merging two groups
 * that each had one can break it.
 */
async function ensurePrimary(groupId: string): Promise<void> {
  const members = await db.select().from(follows).where(eq(follows.groupId, groupId));
  if (members.length === 0) return;

  const primaries = members.filter((m) => m.isPrimary === 1);
  if (primaries.length === 1) return;

  // None, or several after a merge. The first by name is arbitrary but stable,
  // and it is immediately changeable — the point is never to render headless.
  const keep = primaries[0] ?? [...members].sort((x, y) => x.name.localeCompare(y.name))[0];
  await db.update(follows).set({ isPrimary: 0 }).where(eq(follows.groupId, groupId));
  await db.update(follows).set({ isPrimary: 1 }).where(eq(follows.id, keep.id));
}

/** Which of a group's accounts the merged row wears. */
export async function setPrimaryFollow(id: string): Promise<void> {
  const [row] = await db.select().from(follows).where(eq(follows.id, id));
  if (!row) throw Object.assign(new Error('no followed account has that id'), { statusCode: 404 });

  if (!row.groupId) {
    throw Object.assign(new Error('that account is not linked to anything, so it is already the only one'), {
      statusCode: 400,
    });
  }

  await db.update(follows).set({ isPrimary: 0 }).where(eq(follows.groupId, row.groupId));
  await db.update(follows).set({ isPrimary: 1 }).where(eq(follows.id, id));
}

/**
 * Take one account out of its group.
 *
 * Per account rather than per group, unlike friends' "Unlink". A group here can
 * hold several channels and dissolving all of them to separate one wrong link
 * would be a poor trade — whereas a friends row is nearly always a pair.
 *
 * A group of one is not a group, so the last remaining member is released too.
 * Otherwise a lone row would keep a `group_id` and quietly re-absorb whatever
 * was linked to that id next.
 */
export async function unlinkFollow(id: string): Promise<void> {
  const [row] = await db.select().from(follows).where(eq(follows.id, id));
  if (!row?.groupId) return;

  const groupId = row.groupId;
  await db.update(follows).set({ groupId: null, isPrimary: 0 }).where(eq(follows.id, id));

  const left = await db.select().from(follows).where(eq(follows.groupId, groupId));
  if (left.length <= 1) {
    await db.update(follows).set({ groupId: null, isPrimary: 0 }).where(eq(follows.groupId, groupId));
    return;
  }

  await ensurePrimary(groupId);
}

/** When each provider's follow list was last written, for the staleness note. */
export async function followsFreshness(): Promise<Map<string, number>> {
  const rows = await db
    .select({ provider: follows.provider, seenAt: sql<number>`max(${follows.seenAt})`.as('seenAt') })
    .from(follows)
    .groupBy(follows.provider);
  return new Map(rows.map((r) => [r.provider, r.seenAt]));
}

/**
 * How many tracks or videos of each followed account are in your collections.
 *
 * The default sort on the Following tab, and the reason `media_items` carries
 * `creator_ids` at all: matching a followed artist to their tracks by *name*
 * gets both halves wrong. A collaboration's `creator` is "A, B" and equals
 * neither artist's name, and a short name is a substring of longer ones — "Air"
 * would collect everything by Airbourne.
 *
 * Counted only where the item is actually in a collection. A track can be in
 * the library because it turned up somewhere and then be removed from every
 * playlist, and "in my playlists" has to mean what it says.
 *
 * One statement for the whole list rather than a query per follow: 408 follows
 * is 408 round trips otherwise, for a screen that opens in one.
 */
export async function followPlaylistCounts(): Promise<Map<string, number>> {
  const rows = await db.all<{ provider: string; account_id: string; n: number }>(sql`
    select f.provider as provider,
           f.provider_account_id as account_id,
           (
             select count(distinct mi.id)
             from media_items mi
             where mi.provider = f.provider
               and exists (
                 select 1
                 from media_collection_items ci
                 join media_collections mc on mc.id = ci.collection_id
                 -- An ignored playlist does not count. Leaving it in would keep
                 -- Liked Videos dominating the ordering it was ticked off to
                 -- stop dominating.
                 where ci.item_id = mi.id and mc.ignored = 0
               )
               and (
                 -- The exact join, once a sync has stored the ids.
                 instr(mi.creator_ids, '"' || f.provider_account_id || '"') > 0
                 -- Fallback for rows synced before the column existed. Exact on
                 -- the whole name, so it catches a solo track and declines to
                 -- guess at a collaboration rather than matching a substring.
                 or mi.creator = f.name
               )
           ) as n
    from follows f
  `);

  return new Map(rows.map((r) => [`${r.provider}:${r.account_id}`, Number(r.n)]));
}

/* ------------------------------------------------------------------ */
/* Linking one person's accounts together                              */
/* ------------------------------------------------------------------ */

/**
 * Mark two friend rows as the same human.
 *
 * Whichever group either one already belongs to wins, and the other joins it —
 * so linking a third account to an existing pair extends the group rather than
 * splitting it. Two already-grouped rows merge, taking the first one's id.
 *
 * `randomUUID` for a new group rather than reusing a row's id: a person is not
 * one of their accounts, and using the Discord row's id as the group key would
 * make deleting that row take the whole grouping with it.
 */
export async function linkFriends(idA: string, idB: string): Promise<string> {
  const rows = await db.select().from(friends).where(inArray(friends.id, [idA, idB]));

  if (rows.length !== 2) {
    /*
     * Say *which* one, and what was received.
     *
     * The message was "one of those is not in the list", which is true, useless,
     * and was reported by somebody who could see both names on their screen. The
     * caller had sent a row's person key rather than an account id — a mistake
     * this message should have made obvious in one reading rather than sending
     * anybody to the database.
     */
    const found = new Set(rows.map((r) => r.id));
    const missing = [idA, idB].filter((id) => !found.has(id));
    throw Object.assign(
      new Error(
        `no friend account has ${missing.length === 1 ? 'the id' : 'the ids'} ${missing.join(', ')} — ` +
          'linking takes account ids, and a row on the screen is a person, which may be several'
      ),
      { statusCode: 404 }
    );
  }

  const [a, b] = rows;

  /*
   * One person has one account per service, checked across the **whole merged
   * group** rather than just the two rows named.
   *
   * Comparing only `a` and `b` was right while a group was always a pair, and
   * became wrong the moment a third could be added: the screen passes the
   * group's first account, so adding a second Steam friend to a Discord+Steam
   * person compared Discord against Steam, passed, and produced a person with
   * two Steam accounts whose status came from whichever sorted first.
   */
  const members = await db
    .select()
    .from(friends)
    .where(
      inArray(
        friends.personId,
        [a.personId, b.personId].filter((id): id is string => Boolean(id))
      )
    );

  /*
   * Deduplicated by row id before counting services.
   *
   * `a` and `b` are already inside `members` whenever they carry a personId, so
   * concatenating the three lists counted the named accounts twice and refused
   * every legitimate third — adding a Riot friend to a Steam+Discord person
   * failed with "that would give one person two steam accounts", naming a
   * service that had exactly one.
   */
  const union = new Map([...members, a, b].map((row) => [row.id, row]));
  const providers = [...union.values()].map((row) => row.provider);
  const duplicate = providers.find((provider, i) => providers.indexOf(provider) !== i);
  if (duplicate) {
    throw Object.assign(
      new Error(
        `that would give one person two ${duplicate} accounts — a link joins different services, ` +
          'so unlink the one already there first'
      ),
      { statusCode: 400 }
    );
  }

  const personId = a.personId ?? b.personId ?? randomUUID();
  // Everything already grouped with either side comes along, or a merge would
  // silently strand the third account of a three-way link.
  const absorbing = [a.personId, b.personId].filter((id): id is string => Boolean(id) && id !== personId);

  await db.update(friends).set({ personId }).where(inArray(friends.id, [idA, idB]));
  if (absorbing.length > 0) {
    await db.update(friends).set({ personId }).where(inArray(friends.personId, absorbing));
  }

  return personId;
}

/** Dissolve a whole group, which is what "Unlink" on a merged row means. */
export async function unlinkPerson(personId: string): Promise<void> {
  await db.update(friends).set({ personId: null }).where(eq(friends.personId, personId));
}

/** Take one account back out of its group. The others stay linked to each other. */
export async function unlinkFriend(id: string): Promise<void> {
  const [row] = await db.select().from(friends).where(eq(friends.id, id));
  if (!row?.personId) return;

  await db.update(friends).set({ personId: null }).where(eq(friends.id, id));

  // A group of one is not a group. Left alone it would keep a person id that
  // nothing else shares, which renders identically to being unlinked and would
  // quietly accumulate.
  const remaining = await db.select().from(friends).where(eq(friends.personId, row.personId));
  if (remaining.length === 1) {
    await db.update(friends).set({ personId: null }).where(eq(friends.id, remaining[0].id));
  }
}

/**
 * Names reduced to what is worth comparing.
 *
 * Handles collect decoration — `xX_Ash_Xx`, `ash | streaming`, a clan tag in
 * brackets — and none of it identifies anybody. Lowercasing and dropping
 * everything that is not a letter or digit is crude and is the right amount of
 * effort for something that only ever *proposes* a link.
 */
function comparableName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface LinkSuggestion {
  a: { id: string; provider: string; name: string };
  b: { id: string; provider: string; name: string };
  /** Why it thinks so, shown on the row — a guess has to be inspectable. */
  because: string;
}

/**
 * Accounts on different services whose names look like the same person.
 *
 * **Suggestions, never links.** Discord cannot tell us a friend's Steam
 * profile — `/users/{id}/profile` is a client-only endpoint and answers 401 to
 * an OAuth app, and even our own connections need a scope that would only ever
 * describe us. So there is no authoritative mapping to import, and matching on
 * a name is a guess. It is offered for one click of confirmation rather than
 * applied, because a wrong link silently attributes somebody's status to
 * somebody else.
 *
 * Deliberately narrow: an exact match after normalising, or one name wholly
 * containing the other when it is long enough for that to mean something. Short
 * names match everything and would bury the real suggestions.
 */
export async function suggestFriendLinks(): Promise<LinkSuggestion[]> {
  const rows = await db.select().from(friends);
  const unlinked = rows.filter((r) => !r.personId);

  const suggestions: LinkSuggestion[] = [];
  const spoken = new Set<string>();

  for (const a of unlinked) {
    for (const b of unlinked) {
      // Each pair once, and never two accounts on the same service.
      if (a.id >= b.id || a.provider === b.provider) continue;

      const left = comparableName(a.name);
      const right = comparableName(b.name);
      if (left.length < 3 || right.length < 3) continue;

      let because = '';
      if (left === right) because = 'the same name on both';
      else if (left.length >= 5 && right.includes(left)) because = `"${b.name}" contains "${a.name}"`;
      else if (right.length >= 5 && left.includes(right)) because = `"${a.name}" contains "${b.name}"`;
      else continue;

      // One suggestion per account, or a common name proposes a dozen rows and
      // the list becomes something to dismiss rather than read.
      if (spoken.has(a.id) || spoken.has(b.id)) continue;
      spoken.add(a.id);
      spoken.add(b.id);

      suggestions.push({
        a: { id: a.id, provider: a.provider, name: a.name },
        b: { id: b.id, provider: b.provider, name: b.name },
        because,
      });
    }
  }

  return suggestions;
}

/* ------------------------------------------------------------------ */
/* Coursework, as tasks                                                */
/* ------------------------------------------------------------------ */

/** One thing with a deadline, in this app's vocabulary rather than a service's. */
export interface IncomingTask {
  /** The service's own id, unique within that service. */
  externalId: string;
  title: string;
  /** Course, channel, whatever names where it came from. Goes in the notes. */
  context?: string | null;
  dueAt: number;
  /** The thing itself, at the service. Absolute. */
  url?: string | null;
  /** The service says this is handed in, marked complete, or excused. */
  done: boolean;
}

export interface TaskSyncResult {
  created: number;
  /** Deadline moved at the service and was carried across. */
  rescheduled: number;
  /** Ticked off because the service says it is handed in. */
  completed: number;
  /** Already dealt with, or deliberately deleted here. Not an error. */
  untouched: number;
}

/**
 * Turn a service's deadlines into tasks, once each, for good.
 *
 * Three rules, and each of them is here because the obvious version is wrong in
 * a way you would only find out weeks later:
 *
 * **A deleted task stays deleted.** `integration_task_links` remembers that an
 * item was turned into a task even after that task is gone, so throwing one away
 * is permanent. Deduplicating by looking for the task itself — the obvious
 * design, and the one a `(source, source_id)` unique index would give you —
 * recreates it on the next sync, within the minute, with nothing on screen to
 * say why.
 *
 * **Only the deadline is carried across afterwards.** Extensions happen weekly
 * and a stale `dueAt` makes the nudge engine wrong, which is the one thing this
 * feature exists to get right. A title that changed at the service is rare and a
 * stale one is merely untidy — whereas overwriting a title *you* renamed is an
 * edit nobody asked for, and there is no signal here that could tell the two
 * apart. `notes` is never touched for the same reason: it is yours.
 *
 * **Ticking off only ever goes one way.** The service saying "handed in" closes
 * the task; the service saying nothing never reopens one you closed. Submissions
 * get retracted and regraded, and a task that came back to life because a
 * teacher reopened a window would be the app arguing with you about something
 * you had finished.
 */
export async function syncTasksFromService(
  provider: ProviderId,
  incoming: IncomingTask[],
  now = Date.now()
): Promise<TaskSyncResult> {
  const result: TaskSyncResult = { created: 0, rescheduled: 0, completed: 0, untouched: 0 };

  for (const item of incoming) {
    const [link] = await db
      .select()
      .from(integrationTaskLinks)
      .where(
        and(eq(integrationTaskLinks.provider, provider), eq(integrationTaskLinks.externalId, item.externalId))
      );

    /* ---- never seen before ---- */
    if (!link) {
      // Already handed in when we first looked. The link is written anyway, with
      // no task attached: that is what stops a term's worth of finished work
      // arriving as a hundred tasks the first time you connect.
      if (item.done) {
        await db.insert(integrationTaskLinks).values({
          provider,
          externalId: item.externalId,
          taskId: null,
          lastDueAt: item.dueAt,
          completedAt: now,
        });
        result.untouched += 1;
        continue;
      }

      const [task] = await db
        .insert(tasks)
        .values({
          title: item.title,
          notes: item.context ?? null,
          dueAt: item.dueAt,
          // A Canvas deadline is a real time — 11:59pm, or 2pm for a quiz — so
          // it is not the all-day case, which exists for a date with no hour
          // worth saying out loud.
          dueIsAllDay: 0,
          source: provider,
          sourceUrl: item.url ?? null,
        })
        .returning();

      await db.insert(integrationTaskLinks).values({
        provider,
        externalId: item.externalId,
        taskId: task.id,
        lastDueAt: item.dueAt,
      });
      result.created += 1;
      continue;
    }

    /* ---- seen before ---- */

    // No task attached: either it was already done when we found it, or you
    // deleted it. Both are decisions, and neither is revisited.
    if (!link.taskId) {
      result.untouched += 1;
      continue;
    }

    const [task] = await db.select().from(tasks).where(eq(tasks.id, link.taskId));

    // The task is gone. Record that plainly rather than leaving a link pointing
    // at nothing, so the tombstone reads as a decision instead of a dangling id.
    if (!task) {
      await db
        .update(integrationTaskLinks)
        .set({ taskId: null })
        .where(eq(integrationTaskLinks.id, link.id));
      result.untouched += 1;
      continue;
    }

    const open = task.status !== 'done' && task.status !== 'dropped';

    if (item.done && open) {
      await db.update(tasks).set({ status: 'done', completedAt: now }).where(eq(tasks.id, task.id));
      await db
        .update(integrationTaskLinks)
        .set({ completedAt: now, lastDueAt: item.dueAt })
        .where(eq(integrationTaskLinks.id, link.id));
      result.completed += 1;
      continue;
    }

    // Compared against what the *service* last said rather than against the
    // task's own `dueAt`, so moving a deadline yourself is not undone on the
    // next sync by a service that has not changed its mind.
    if (open && link.lastDueAt !== item.dueAt) {
      await db.update(tasks).set({ dueAt: item.dueAt }).where(eq(tasks.id, task.id));
      await db
        .update(integrationTaskLinks)
        .set({ lastDueAt: item.dueAt })
        .where(eq(integrationTaskLinks.id, link.id));
      result.rescheduled += 1;
      continue;
    }

    result.untouched += 1;
  }

  return result;
}

/**
 * Forget that this service ever made any tasks.
 *
 * Called when a provider is disconnected. The tasks themselves stay — they are
 * yours now, they may have notes on them, and silently deleting a fortnight of
 * deadlines because a token was revoked would be the worst possible reading of
 * "disconnect". What goes is the memory, so reconnecting starts cleanly.
 */
export async function forgetTaskLinks(provider: ProviderId): Promise<number> {
  const gone = await db
    .delete(integrationTaskLinks)
    .where(eq(integrationTaskLinks.provider, provider))
    .returning({ id: integrationTaskLinks.id });
  return gone.length;
}

/* ------------------------------------------------------------------ */
/* Who is on air                                                       */
/* ------------------------------------------------------------------ */

/**
 * Replace everything we know about one provider's live channels.
 *
 * **Delete-then-insert, unlike `replaceFriends`, and the difference is what the
 * row means.** A friend is a lasting relationship, so their row is upserted and
 * kept — handing somebody a fresh primary key every minute would break the
 * `person_id` links that join their accounts together. A live stream is the
 * opposite: it exists for three hours and then does not, nothing links to it,
 * and a channel that has gone offline must *leave* rather than linger with a
 * stale viewer count.
 *
 * The same asymmetry says why this is safe here and was a bug there: pruning on
 * an errored snapshot destroyed friend links. Nothing points at a live row, so
 * the worst an empty write can cost is one refresh — and the caller still does
 * not write at all when the fetch failed.
 */
export async function replaceLive(provider: ProviderId, streams: LiveStream[]): Promise<number> {
  const now = Date.now();

  await db.delete(liveStreams).where(eq(liveStreams.provider, provider));
  if (streams.length === 0) return 0;

  await db.insert(liveStreams).values(
    streams.map((stream) => ({
      provider,
      providerAccountId: stream.providerAccountId,
      streamId: stream.streamId,
      channelName: stream.channelName,
      title: stream.title,
      category: stream.category ?? null,
      viewers: stream.viewers ?? null,
      startedAt: stream.startedAt ?? null,
      thumbnailUrl: stream.thumbnailUrl ?? null,
      url: stream.url,
      seenAt: now,
    }))
  );

  return streams.length;
}

export type LiveRow = typeof liveStreams.$inferSelect;

/** Everyone on air, busiest first — the order the services themselves use. */
export async function allLive(): Promise<LiveRow[]> {
  return db.select().from(liveStreams).orderBy(desc(liveStreams.viewers));
}

/** When each provider's live list was last written, for the staleness check. */
export async function liveFreshness(): Promise<Map<string, number>> {
  const rows = await db
    .select({ provider: liveStreams.provider, seenAt: liveStreams.seenAt })
    .from(liveStreams);

  const seen = new Map<string, number>();
  for (const row of rows) seen.set(row.provider, Math.max(seen.get(row.provider) ?? 0, row.seenAt));
  return seen;
}
