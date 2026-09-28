/**
 * Leaving adult titles out of Browse's Popular and Latest lists.
 *
 * Neither thing that looks like it should answer this does. Suwayomi's
 * `isNsfw` is set on nearly every source installed here — MangaFire, MangaDex,
 * Mangahere — because each *can* carry adult titles, so filtering on it would
 * empty Browse. And a listing rarely carries genres: 3 of 50 on MangaFire's
 * popular page, 3 of 25 on TopManhua's.
 *
 * So each title's genres are looked up. Suwayomi's stored copy answers the ones
 * it has seen, for free; the rest are fetched from the site, a few at a time
 * and within a time budget, and Suwayomi keeps what it fetched — so a page is
 * slow the first time it is opened and immediate after that.
 *
 * ### Two levels, because "Mature" means two things
 *
 * Sources use **Mature** for violence and seinen as well as for sex: on
 * MangaFire's popular page it was on Kingdom, Jujutsu Kaisen, Nano Machine,
 * Berserk and Tokyo Ghoul, beside Secret Class. So `adult` hides the sexual
 * genres only, and `mature` hides those and anything tagged Mature too.
 *
 * **A title still unknown when the budget runs out is shown**, and the response
 * says how many there were. Hiding every unknown would empty a first visit to a
 * slow source, which reads as the source being broken; showing them unchecked
 * and saying so is the honest version, and the next load has them checked.
 */
import type { SourceMatch } from './sources.js';
import type { SuwayomiAdapter } from './suwayomi.js';

/** Genre words sources use for sexual content, matched whole-word and case-insensitively. */
const SEXUAL = /(^|[^a-z])(adult|ecchi|smut|hentai|erotic|erotica|porn|pornographic|nsfw|sexual violence|18\+|r-?18)([^a-z]|$)/i;
const MATURE = /(^|[^a-z])mature([^a-z]|$)/i;

export type HideLevel = 'adult' | 'mature';

export function isMature(genres: readonly string[], level: HideLevel = 'mature'): boolean {
  return genres.some((g) => SEXUAL.test(g) || (level === 'mature' && MATURE.test(g)));
}

const CONCURRENCY = 6;
const BUDGET_MS = 8_000;

export async function withoutMature(
  adapter: SuwayomiAdapter,
  matches: SourceMatch[],
  level: HideLevel
): Promise<{ matches: SourceMatch[]; hidden: number; unchecked: number }> {
  const genres = new Map<string, string[]>();
  try {
    for (const [id, list] of await adapter.storedGenres(matches.map((m) => m.id))) {
      if (list.length > 0) genres.set(id, list);
    }
  } catch {
    // Suwayomi's own copy would not answer: everything goes to the site instead.
  }

  const todo = matches.filter((m) => !genres.has(m.id));
  const deadline = Date.now() + BUDGET_MS;
  let next = 0;
  const worker = async () => {
    while (next < todo.length && Date.now() < deadline) {
      const m = todo[next++];
      try {
        const details = await adapter.details(m.id);
        // A stale empty answer is "not known", not "has no genres".
        if (details.genres.length > 0 || !details.stale) genres.set(m.id, details.genres);
      } catch {
        // Left unknown.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));

  const kept = matches.filter((m) => !isMature(genres.get(m.id) ?? [], level));
  return {
    matches: kept,
    hidden: matches.length - kept.length,
    unchecked: matches.filter((m) => !genres.has(m.id)).length,
  };
}
