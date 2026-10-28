/**
 * What you read in Manga Reader, searchable: History's search looks here too,
 * so "did I ever read this?" has an answer for series never brought in.
 *
 * The import took the favourites (898) and left the rest of the old app's
 * history behind (1,295 more, opened and never starred). When the importer
 * was retired, that history was taken out of the backup once, by the old
 * reader recovered from git for the purpose, into
 * `data/manga-old-history.json`: per title, the sites it was read on, how
 * many chapters were read and the furthest, and when it was last opened. It
 * is a record, read-only, and nothing here writes it. A copy without the file
 * simply has no old history to search.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '@everything/server/module-api';
import type { Store } from './library.js';
import { titleKey } from './titles.js';

export interface OldHistoryEntry {
  title: string;
  sites: string[];
  chaptersRead: number;
  furthest: number | null;
  lastChapter: string | null;
  lastReadAt: number | null;
  /** Was a favourite there, so it came into this library on import. */
  favourite: boolean;
}

const FILE = join(dataDir, 'manga-old-history.json');
let cache: { at: number; entries: OldHistoryEntry[] } | null = null;

/** The old history, or null when this copy has none. Read once, again only if the file changes. */
export function oldHistory(): OldHistoryEntry[] | null {
  let at: number;
  try {
    at = statSync(FILE).mtimeMs;
  } catch {
    return null;
  }
  if (cache?.at !== at) {
    try {
      const raw = JSON.parse(readFileSync(FILE, 'utf8')) as { entries?: OldHistoryEntry[] };
      cache = { at, entries: Array.isArray(raw.entries) ? raw.entries : [] };
    } catch {
      return null;
    }
  }
  return cache.entries;
}

/**
 * Entries whose title contains what was typed, folded the way titles are
 * compared everywhere else (`titleKey`), newest first, with the series it is
 * in your library as now, when it is.
 */
export function searchOldHistory(
  query: string,
  store: Store,
  limit = 30
): { available: boolean; total: number; matches: Array<OldHistoryEntry & { following: string | null }> } {
  const entries = oldHistory();
  if (!entries) return { available: false, total: 0, matches: [] };
  const want = titleKey(query);
  if (!want) return { available: true, total: entries.length, matches: [] };

  // Every name a followed series goes by, to say which old entries you follow now.
  const following = new Map<string, string>();
  for (const s of store.series) {
    for (const name of [s.title, ...(s.altTitles ?? []), s.origin?.title ?? '']) {
      const key = titleKey(name);
      if (key && !following.has(key)) following.set(key, s.id);
    }
  }

  const matches = entries
    .filter((e) => titleKey(e.title).includes(want))
    .slice(0, limit)
    .map((e) => ({ ...e, following: following.get(titleKey(e.title)) ?? null }));
  return { available: true, total: entries.length, matches };
}
