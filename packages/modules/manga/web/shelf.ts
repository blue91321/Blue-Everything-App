/**
 * How the library is ordered, with nothing attached to it.
 *
 * These lived in `Library.tsx` and the Dashboard card needs them — and
 * importing any part of that file pulls the *whole* Library screen into the
 * card's chunk. Rollup cannot tree-shake that: importing one export pulls the
 * module in. It is exactly the mistake the friends panel made once, where a
 * six-word label dragged in 9.5KB of Connections screen.
 *
 * So, like `presence.ts` and `chapter-nav.ts`: **no imports but a type**, which
 * is erased. Everything here is a pure function of a series row.
 */
import type { SeriesSummary } from './manga-api';

export type SortKey = 'read' | 'catchup' | 'updated' | 'title' | 'added';

export const SORT_LABEL: Record<SortKey, string> = {
  read: 'Last read',
  catchup: 'Most to catch up on',
  updated: 'Last updated',
  title: 'Title',
  added: 'Recently added',
};

/*
 * Remembered per device, like the folded note folders: it is a view of one
 * screen, and sorting the phone's shelf should not reorder the PC's.
 */
export const SORT_KEY = 'manga.library-sort';

/** Somewhere past where you are. */
export function hasNew(s: SeriesSummary): boolean {
  const latest = s.latestNumber;
  if (latest === null || latest === undefined) return false;
  const reached = Math.max(s.readUpTo ?? -Infinity, s.position?.chapter ?? -Infinity);
  return reached > -Infinity && latest > reached;
}

/** Whole chapters between where you are and the newest. Zero when either is unknown. */
export function toCatchUp(s: SeriesSummary): number {
  if (!hasNew(s)) return 0;
  const reached = Math.max(s.readUpTo ?? -Infinity, s.position?.chapter ?? -Infinity);
  return Math.max(1, Math.floor(s.latestNumber!) - Math.floor(reached));
}

/** Its source failed when last asked — by the sweep, or by opening its chapters. */
export const notAnswering = (s: SeriesSummary) => s.source !== null && s.error !== null;

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

export function sorted(list: SeriesSummary[], key: SortKey, newFirst: boolean): SeriesSummary[] {
  const byTitle = (a: SeriesSummary, b: SeriesSummary) => a.title.localeCompare(b.title);
  const desc = (f: (s: SeriesSummary) => number | null | undefined) => (a: SeriesSummary, b: SeriesSummary) =>
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
  // Stable, so within each half the order chosen above holds.
  return newFirst ? copy.sort((a, b) => Number(hasNew(b)) - Number(hasNew(a))) : copy;
}
