/**
 * Everything this feature reads and writes, in one place.
 *
 * The providers below are deliberately dumb about storage: each one turns a
 * third-party JSON shape into the app's own vocabulary and hands it here. That
 * boundary is what makes adding a provider a single file, and what stops seven
 * slightly different opinions about how to upsert a track from accumulating.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  categoriseGenres,
  type CollectionKind,
  type Friend,
  type MediaKind,
  type PlaySource,
  type ProviderId,
} from '@everything/shared/integrations';
import { db } from '../../db/client.js';
import {
  friends,
  integrationAccounts,
  mediaCollectionItems,
  mediaCollections,
  mediaItems,
  mediaPlays,
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
    .returning({ id: mediaCollections.id, snapshotId: mediaCollections.snapshotId });

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

export async function markCollectionSynced(collectionId: string, snapshotId: string | null): Promise<void> {
  await db
    .update(mediaCollections)
    .set({ snapshotId, syncedAt: Date.now() })
    .where(eq(mediaCollections.id, collectionId));
}

/**
 * Record plays, ignoring ones already known.
 *
 * `onConflictDoNothing` against the (item, time, source) unique index is what
 * makes the two mechanisms that feed this safe to run repeatedly: Spotify hands
 * back its last fifty every time it is asked, and a Takeout file is the whole
 * history every time it is imported. Both are supposed to overlap heavily.
 *
 * Returns how many were genuinely new, which is the only number worth showing
 * after a sync — "50 plays fetched" is meaningless when 48 were already there.
 */
export async function recordPlays(
  plays: Array<{ itemId: string; playedAt: number; source: PlaySource }>
): Promise<number> {
  if (plays.length === 0) return 0;

  let added = 0;
  for (let i = 0; i < plays.length; i += 100) {
    const chunk = plays.slice(i, i + 100);
    const written = await db
      .insert(mediaPlays)
      .values(chunk)
      .onConflictDoNothing()
      .returning({ id: mediaPlays.id });
    added += written.length;
  }
  return added;
}

/* ------------------------------------------------------------------ */
/* Reading the library back                                            */
/* ------------------------------------------------------------------ */

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
  const query = db
    .select({
      category: mediaItems.category,
      count: sql<number>`count(*)`.as('count'),
    })
    .from(mediaItems)
    .groupBy(mediaItems.category)
    .orderBy(desc(sql`count(*)`));

  return provider ? query.where(eq(mediaItems.provider, provider)) : query;
}

export async function recentPlays(limit = 100) {
  return db
    .select({
      playedAt: mediaPlays.playedAt,
      source: mediaPlays.source,
      title: mediaItems.title,
      creator: mediaItems.creator,
      category: mediaItems.category,
      url: mediaItems.url,
      artUrl: mediaItems.artUrl,
      provider: mediaItems.provider,
    })
    .from(mediaPlays)
    .innerJoin(mediaItems, eq(mediaItems.id, mediaPlays.itemId))
    .orderBy(desc(mediaPlays.playedAt))
    .limit(limit);
}

/**
 * What you have played most, by family, over a window.
 *
 * This is the closest thing here to a recommendation, and it is deliberately
 * only a count. A real recommender wants a similarity measure between tracks,
 * and the endpoint that supplied one was withdrawn — so what is offered is the
 * honest thing the data can support: "you have played nine hours of metal this
 * month and not opened the jazz playlist since March".
 */
export async function tasteProfile(sinceMs: number) {
  return db
    .select({
      category: mediaItems.category,
      plays: sql<number>`count(*)`.as('plays'),
      distinctItems: sql<number>`count(distinct ${mediaItems.id})`.as('distinctItems'),
      listenedMs: sql<number>`coalesce(sum(${mediaItems.durationMs}), 0)`.as('listenedMs'),
    })
    .from(mediaPlays)
    .innerJoin(mediaItems, eq(mediaItems.id, mediaPlays.itemId))
    .where(sql`${mediaPlays.playedAt} >= ${sinceMs}`)
    .groupBy(mediaItems.category)
    .orderBy(desc(sql`count(*)`));
}

/** Find local ids for items already known, so a play can be recorded without a refetch. */
export async function findItemIds(
  provider: ProviderId,
  providerItemIds: string[]
): Promise<Map<string, string>> {
  if (providerItemIds.length === 0) return new Map();

  const found = new Map<string, string>();
  for (let i = 0; i < providerItemIds.length; i += 200) {
    const rows = await db
      .select({ id: mediaItems.id, providerItemId: mediaItems.providerItemId })
      .from(mediaItems)
      .where(
        and(eq(mediaItems.provider, provider), inArray(mediaItems.providerItemId, providerItemIds.slice(i, i + 200)))
      );
    for (const row of rows) found.set(row.providerItemId, row.id);
  }
  return found;
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
