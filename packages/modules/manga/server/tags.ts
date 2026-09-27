/**
 * Genres for the library, from each series' own source.
 *
 * They exist so the library can be filtered by tag, which several hundred
 * series brought in from another app made worth having. Nothing else here
 * knows a series' genres: MangaDex has them for some, and an imported series
 * has no MangaDex id at all. The source it is linked to is the one place every
 * linked series has.
 *
 * ### Suwayomi's copy first, the site second
 *
 * Suwayomi keeps what it has seen, and a series found by searching often came
 * with its genres already — one local query answers those, however many there
 * are. The rest need `details`, which asks the site, so those go one at a time
 * with a pause, a bounded number per call.
 *
 * **Never starts Suwayomi**, like the sweep that calls it. Genres are worth
 * having and not worth waking a JVM for.
 *
 * `tags: []` means asked, and the source listed none; absent means not asked
 * yet. A stale answer (the site would not answer, so Suwayomi's stored copy
 * came back empty) is not recorded, so it is asked again next time rather than
 * written down as "none".
 */
import { changes } from '@everything/server/module-api';
import { read, write } from './library.js';
import { suwayomiProcess } from './process.js';
import { effectiveUrl } from './sources.js';
import { DEFAULT_BASE_URL, SuwayomiAdapter } from './suwayomi.js';

const PAUSE_MS = 500;

/** The spellings sources actually use for the same thing. */
const SAME: Record<string, string> = {
  manwha: 'Manhwa',
  'sci fi': 'Sci-Fi',
  'sci-fi': 'Sci-Fi',
  scifi: 'Sci-Fi',
  'slice of life': 'Slice of Life',
  'martial art': 'Martial Arts',
  'martial arts': 'Martial Arts',
};

/**
 * Tidied for filtering: trimmed, one spelling per tag, capitalised, no repeats.
 * Sources disagree about case ("action", "Action") and one writes "Manwha",
 * and a filter listing each twice would split the same series across two.
 */
export function normaliseTags(raw: readonly unknown[]): string[] {
  const out = new Map<string, string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const text = item.replace(/\s+/g, ' ').trim();
    if (!text || text.length > 40) continue;
    const key = text.toLowerCase().replace(/[_]/g, ' ');
    const name =
      SAME[key] ??
      (text === text.toLowerCase() || text === text.toUpperCase()
        ? text.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase())
        : text);
    const k = name.toLowerCase();
    if (!out.has(k)) out.set(k, name);
  }
  return [...out.values()].slice(0, 20);
}

let running = false;

/** Fill in genres for linked series that have none recorded. Returns how many were filled. */
export async function fillTags(siteLimit = Number.POSITIVE_INFINITY): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    const store = read();
    const url = effectiveUrl(store, DEFAULT_BASE_URL);
    if (!url) return 0;
    if (store.manageSuwayomi && suwayomiProcess.state.state !== 'running') return 0;

    const todo = store.series
      .filter((s) => s.tags === undefined && s.source?.adapter === 'suwayomi' && /^\d+$/.test(s.source.mangaId))
      // What you read most recently gets its tags first.
      .sort((a, b) => b.addedAt - a.addedAt);
    if (todo.length === 0) return 0;

    const adapter = new SuwayomiAdapter(url);
    const found = new Map<string, string[]>();
    const stored = await adapter.storedGenres(todo.map((s) => s.source!.mangaId));
    for (const s of todo) {
      const genres = stored.get(s.source!.mangaId);
      if (genres && genres.length > 0) found.set(s.id, normaliseTags(genres));
    }

    let asked = 0;
    for (const s of todo) {
      if (found.has(s.id)) continue;
      if (asked >= siteLimit) break;
      asked += 1;
      if (store.manageSuwayomi) suwayomiProcess.touch(store.suwayomiMode);
      try {
        const details = await adapter.details(s.source!.mangaId);
        if (!details.stale || details.genres.length > 0) found.set(s.id, normaliseTags(details.genres));
      } catch {
        // Left unasked, for next time.
      }
      await new Promise((done) => setTimeout(done, PAUSE_MS));
    }

    if (found.size > 0) {
      // Read fresh: a long run overlaps reading, linking and the sweep.
      const now = read();
      for (const row of now.series) {
        const tags = found.get(row.id);
        if (tags && row.tags === undefined) row.tags = tags;
      }
      write(now);
      changes.emitChange('all');
    }
    return found.size;
  } finally {
    running = false;
  }
}
