/**
 * How the library is ordered, with nothing attached to it.
 *
 * These lived in `Library.tsx` and the Dashboard card needs them — and
 * importing any part of that file pulls the *whole* Library screen into the
 * card's chunk. Rollup cannot tree-shake that: importing one export pulls the
 * module in. It is exactly the mistake the friends panel made once, where a
 * six-word label dragged in 9.5KB of Connections screen.
 *
 * So, like `presence.ts` and `chapter-nav.ts`: **no imports at all**.
 * Everything here is a pure function of a series row, described below by the
 * fields it reads, which `ShelfRow` has. It imported that type once, and
 * the type alone pulled `manga-api.ts` and the app's aliases into the server's
 * typecheck the moment `manga-check` asserted the sort.
 */
export interface ShelfRow {
  title: string;
  addedAt: number;
  error: string | null;
  favourite?: boolean;
  source: object | null;
  latestNumber?: number | null;
  readUpTo?: number | null;
  lastReleaseAt?: number | null;
  lastReadAt?: number | null;
  position?: { chapter: number } | null;
  /** Your rating, 1 to 10, or null. */
  rating?: number | null;
}

export type SortKey = 'read' | 'catchup' | 'updated' | 'title' | 'added' | 'rating';
/** Every order but Rating: what Rating falls back on, after the rated ones. */
export type ThenKey = Exclude<SortKey, 'rating'>;

export const SORT_LABEL: Record<SortKey, string> = {
  read: 'Last read',
  catchup: 'Most to catch up on',
  updated: 'Last updated',
  title: 'Title',
  added: 'Recently added',
  rating: 'Rating',
};

/*
 * The order Rating falls back on: the one you had before choosing it. Kept
 * per device beside the sort itself.
 */
export const THEN_KEY = 'manga.library-sort-then';

export function storedThen(): ThenKey {
  try {
    const v = localStorage.getItem(THEN_KEY);
    return v && v in SORT_LABEL && v !== 'rating' ? (v as ThenKey) : 'read';
  } catch {
    return 'read';
  }
}

/*
 * Remembered per device, like the folded note folders: it is a view of one
 * screen, and sorting the phone's shelf should not reorder the PC's.
 */
export const SORT_KEY = 'manga.library-sort';

/** Somewhere past where you are. */
export function hasNew(s: ShelfRow): boolean {
  const latest = s.latestNumber;
  if (latest === null || latest === undefined) return false;
  const reached = Math.max(s.readUpTo ?? -Infinity, s.position?.chapter ?? -Infinity);
  return reached > -Infinity && latest > reached;
}

/** Whole chapters between where you are and the newest. Zero when either is unknown. */
export function toCatchUp(s: ShelfRow): number {
  if (!hasNew(s)) return 0;
  const reached = Math.max(s.readUpTo ?? -Infinity, s.position?.chapter ?? -Infinity);
  return Math.max(1, Math.floor(s.latestNumber!) - Math.floor(reached));
}

/**
 * The source answered, and said it has nothing for this id.
 *
 * **Not the same as not answering**, and conflating them was costing a real
 * distinction: a timeout means try again, while this means the link is wrong —
 * the series was never on that source, or has been taken off it — and the fix
 * is to find another one. Measured on a library of 698 linked series: eight
 * broken rows, of which three were this.
 *
 * Matched on the message, which is Suwayomi's own words passed through. That
 * reads as fragile and is the same call the source-comparison route already
 * makes, with the same reasoning: the alternative is a second field carried
 * through every layer to say what the message already says, and a message that
 * changes shows up as a row in the wrong filter rather than as a crash.
 */
export const sourceHasNothing = (s: ShelfRow) => s.source !== null && goneFromSource(s.error);

/**
 * Whether a check's error means the series is gone from that source, rather
 * than the source failing to answer: "No chapters found", or the site's 404 for
 * the series' page. A 404 was filed under "not answering" until 2026-11-07,
 * which read as "try again later" for 21 series MangaFox and Mangahere had
 * taken down, and spent two retry slots of every sweep on them. Both mean the
 * same thing and want the same fix, another source, so both are this. The
 * sweep asks it too (`dueForCheck`), so it gives them no retry slots.
 */
/** How long a series' source may fail before it is switched to another: two days, so a site down for an evening is waited out. */
export const SWITCH_AFTER_MS = 2 * 24 * 60 * 60_000;

/** When it will be switched, if it is failing and switching is on; past times mean "at the next check that can". */
export function switchDueAt(s: { source: unknown; error: string | null; failingSince?: number | null; switchTriedAt?: number | null }, on: boolean): number | null {
  if (!on || s.source === null || !s.error || typeof s.failingSince !== 'number') return null;
  const due = s.failingSince + SWITCH_AFTER_MS;
  // Tried and found nothing: tried again a day after that.
  return typeof s.switchTriedAt === 'number' && s.switchTriedAt >= due ? s.switchTriedAt + 24 * 60 * 60_000 : due;
}

export const goneFromSource = (error: string | null | undefined): boolean => !!error && /no chapters|\b404\b/i.test(error);

/**
 * Its source failed when last asked — by the sweep, or by opening its chapters.
 *
 * "Had nothing for it" is excluded: that is an *answer*, and a useful one.
 */
export const notAnswering = (s: ShelfRow) => s.source !== null && s.error !== null && !goneFromSource(s.error);

/** "Asura Scans (EN)" → "Asura Scans": the language is the same on every tile. */
export function sourceLabel(name: string): string {
  return name.replace(/\s*\((?:[A-Za-z]{2,3}(?:-[A-Za-z]+)?|ALL|all)\)\s*$/, '');
}

/**
 * What the Library tab is sorted by on *this* device.
 *
 * Read defensively and read live rather than captured, so the Dashboard card
 * set to "follow the Library" picks up a change made on the Manga tab without
 * anything having to tell it.
 */
export function storedSort(): SortKey {
  try {
    const v = localStorage.getItem(SORT_KEY);
    // "New chapters first" was its own order; it is last read with the box ticked now.
    if (v === 'unread') return 'read';
    return v && v in SORT_LABEL ? (v as SortKey) : 'read';
  } catch {
    // Private mode, or storage blocked: the default is a fine answer.
    return 'read';
  }
}

/** The Library's "New chapters on top" box, per device like its sort. */
export const NEW_FIRST_KEY = 'manga.library-new-first';

/**
 * Is "New chapters on top" ticked on this device?
 *
 * Defaults to ticked, matching the Library — and stored as '0' for off rather
 * than removed, which is why this tests for the string rather than for absence.
 */
export function storedNewFirst(): boolean {
  try {
    return localStorage.getItem(NEW_FIRST_KEY) !== '0';
  } catch {
    return true;
  }
}

/**
 * The Library's "Favourites on top" box, per device like its sort.
 *
 * Off by default, and stored as '1' for on: the library came from an import
 * where nothing was starred, and a box nobody ticked should not move anything.
 */
export const FAV_FIRST_KEY = 'manga.library-fav-first';

export function storedFavFirst(): boolean {
  try {
    return localStorage.getItem(FAV_FIRST_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The order, then the boxes on top of it.
 *
 * With both ticked the groups are: starred with a new chapter, new chapter,
 * starred, the rest. A new chapter outranks the star because it is the box
 * about what has moved, and a starred series with nothing new is waiting for
 * nothing; the star then orders each half.
 *
 * **Rating** puts every rated series first, highest first, and equal ratings
 * in `then`'s order: the sort you had before choosing Rating. The unrated ones
 * follow in that same order, and only they take the boxes, as asked: a 10 you
 * rated stays above a series with a new chapter you have not rated.
 */
export function sorted<T extends ShelfRow>(
  list: T[],
  key: SortKey,
  newFirst: boolean,
  favFirst = false,
  then: ThenKey = 'read'
): T[] {
  if (key === 'rating') {
    const isRated = (s: ShelfRow) => typeof s.rating === 'number';
    // Stable, so equal ratings keep `then`'s order.
    const rated = sorted(list.filter(isRated), then, false).sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    return [...rated, ...sorted(list.filter((s) => !isRated(s)), then, newFirst, favFirst)];
  }
  const byTitle = (a: ShelfRow, b: ShelfRow) => a.title.localeCompare(b.title);
  const desc = (f: (s: ShelfRow) => number | null | undefined) => (a: ShelfRow, b: ShelfRow) =>
    (f(b) ?? 0) - (f(a) ?? 0) || byTitle(a, b);
  const copy = [...list];
  switch (key) {
    case 'title':
      copy.sort(byTitle);
      break;
    case 'added':
      copy.sort(desc((s) => s.addedAt));
      break;
    case 'read':
      copy.sort(desc((s) => s.lastReadAt));
      break;
    case 'catchup':
      copy.sort(desc(toCatchUp));
      break;
    case 'updated':
      copy.sort(desc((s) => s.lastReleaseAt));
      break;
  }
  if (!newFirst && !favFirst) return copy;
  const rank = (s: ShelfRow) => (newFirst && hasNew(s) ? 2 : 0) + (favFirst && s.favourite ? 1 : 0);
  // Stable, so within each group the order chosen above holds.
  return copy.sort((a, b) => rank(b) - rank(a));
}
