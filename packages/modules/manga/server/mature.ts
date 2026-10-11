/**
 * Leaving titles with tags you don't want out of Browse's Popular and Latest
 * lists: adult content by default, and any other tag you name — BL, Romance,
 * Horror.
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
 * ### A hidden tag is a family of spellings, for the ones sources disagree on
 *
 * The three that come first are **Ecchi**, **Mature** and **Adult**, each its
 * own switch. They were two levels, "adult" and "adult plus mature", because
 * sources use Mature for violence and seinen as well as for sex — on
 * MangaFire's popular page it was on Kingdom, Jujutsu Kaisen, Berserk and Tokyo
 * Ghoul, beside Secret Class. Three switches say the same thing more plainly.
 *
 * **Adult** covers every word sources use for explicit content: smut, hentai,
 * 18+, R-18 and the rest. **BL** and **GL** cover their several names (Boys'
 * Love, Yaoi, Shounen Ai; Girls' Love, Yuri, Shoujo Ai). Any other tag is
 * matched as written, ignoring case, spaces and hyphens, so "slice of life"
 * hides "Slice-of-Life".
 *
 * **A title still unknown when the budget runs out is shown**, and the response
 * says how many there were. Hiding every unknown would empty a first visit to a
 * slow source, which reads as the source being broken; showing them unchecked
 * and saying so is the honest version, and the next load has them checked.
 */
import type { SourceMatch } from './sources.js';
import type { SuwayomiAdapter } from './suwayomi.js';

/** The tags hidden unless you change it, in the order they are offered. */
export const DEFAULT_HIDDEN_TAGS = ['Ecchi', 'Mature', 'Adult'] as const;

const word = (alternatives: string) => new RegExp(`(^|[^a-z])(${alternatives})([^a-z]|$)`, 'i');

/** Tags whose spellings vary between sources, by the name they are hidden under. */
const FAMILIES: Record<string, RegExp> = {
  ecchi: word('ecchi'),
  mature: word('mature'),
  adult: word("adult|smut|hentai|erotic|erotica|porn|pornographic|nsfw|sexual violence|18\\+|r-?18"),
  bl: word("bl|boys'? ?love|boy's love|yaoi|shou?nen[- ]ai"),
  gl: word("gl|girls'? ?love|girl's love|yuri|shou?jo[- ]ai"),
};

const plain = (tag: string) => tag.toLowerCase().replace(/[\s_-]+/g, ' ').trim();

/** Whether one of a title's genres is the hidden tag `hide`. */
export function hasTag(genres: readonly string[], hide: string): boolean {
  const key = plain(hide);
  const family = FAMILIES[key];
  return genres.some((g) => (family ? family.test(g) : plain(g) === key));
}

/** The first hidden tag a title carries, or null to show it. */
export function hiddenBy(genres: readonly string[], hide: readonly string[]): string | null {
  return hide.find((h) => hasTag(genres, h)) ?? null;
}

/**
 * What an older screen's `safe` asked for, as tags: `adult` was ecchi and the
 * explicit words, `mature` was those and Mature too.
 */
export function tagsForLevel(level: string | undefined): string[] {
  if (level === 'adult') return ['Ecchi', 'Adult'];
  if (level === 'mature' || level === '1') return [...DEFAULT_HIDDEN_TAGS];
  return [];
}

const CONCURRENCY = 6;
const BUDGET_MS = 8_000;

export async function withoutTags(
  adapter: SuwayomiAdapter,
  matches: SourceMatch[],
  hide: readonly string[]
): Promise<{ matches: SourceMatch[]; hidden: number; hiddenBy: Record<string, number>; unchecked: number }> {
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

  const counts: Record<string, number> = {};
  const kept = matches.filter((m) => {
    const by = hiddenBy(genres.get(m.id) ?? [], hide);
    if (by) counts[by] = (counts[by] ?? 0) + 1;
    return by === null;
  });
  return {
    matches: kept,
    hidden: matches.length - kept.length,
    hiddenBy: counts,
    unchecked: matches.filter((m) => !genres.has(m.id)).length,
  };
}
