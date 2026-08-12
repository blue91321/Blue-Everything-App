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
  type Friend,
  type MediaKind,
  type ProviderId,
} from '@everything/shared/integrations';
import { db } from '../../db/client.js';
import {
  follows,
  friends,
  integrationAccounts,
  mediaCollectionItems,
  mediaCollections,
  mediaItems,
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
export async function replaceFriends(provider: ProviderId, incoming: Friend[]): Promise<void> {
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
  if (a.provider === b.provider) {
    throw Object.assign(new Error('those are both the same service — linking joins two different ones'), {
      statusCode: 400,
    });
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
