/**
 * Which tags Browse leaves out of Popular and Latest, on this device.
 *
 * Per device, as the adult filter it replaced was: what is fine on the PC may
 * not be on a phone in public. **Ecchi, Mature and Adult** always come first
 * and are on until switched off; any other tag (BL, Romance) is added by name.
 * The server matches them, including the several names some go by — see
 * `server/mature.ts`.
 *
 * No imports, so it can be read before anything else on the screen loads.
 */

/** Always offered first, and hidden unless switched off. */
export const FIRST_TAGS = ['Ecchi', 'Mature', 'Adult'] as const;

/** Offered as quick picks beside your library's own tags. */
export const COMMON_TAGS = ['BL', 'GL', 'Romance', 'Harem', 'Horror', 'Gore', 'Tragedy', 'Psychological', 'Isekai', 'Reincarnation'];

const KEY = 'manga.browse-hide-tags';
/** The old three-way setting, carried over once. */
const OLD_KEY = 'manga.browse-hide';

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function isFirstTag(tag: string): boolean {
  return FIRST_TAGS.some((t) => same(t, tag));
}

/** The hidden tags, first three first, each once. */
export function tidy(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of [...FIRST_TAGS.filter((f) => tags.some((x) => same(x, f))), ...tags]) {
    const name = t.replace(/\s+/g, ' ').trim();
    if (name && name.length <= 40 && !out.some((o) => same(o, name))) out.push(name);
  }
  return out;
}

export function loadHiddenTags(): string[] {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored !== null) {
      const parsed: unknown = JSON.parse(stored);
      if (Array.isArray(parsed)) return tidy(parsed.filter((t): t is string => typeof t === 'string'));
    }
    // Before tags: "adult" hid ecchi and explicit content, "none" hid nothing,
    // and anything else, including never having chosen, hid all three.
    const old = localStorage.getItem(OLD_KEY);
    if (old === 'none') return [];
    if (old === 'adult') return ['Ecchi', 'Adult'];
  } catch {
    // Unreadable: the default.
  }
  return [...FIRST_TAGS];
}

/*
 * Tags a title must have to be shown (2026-11-16), and whether all of them or
 * any one. Per device, like the hidden ones; none by default.
 */
const ONLY_KEY = 'manga.browse-only-tags';
const ANY_KEY = 'manga.browse-only-any';

/** The wanted tags, each once (the first three are not put first: they are only hidden by default). */
function tidyWanted(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    const name = t.replace(/\s+/g, ' ').trim();
    if (name && name.length <= 40 && !out.some((o) => same(o, name))) out.push(name);
  }
  return out;
}

export function loadWantedTags(): { tags: string[]; any: boolean } {
  try {
    const stored = localStorage.getItem(ONLY_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : [];
    const tags = Array.isArray(parsed) ? tidyWanted(parsed.filter((t): t is string => typeof t === 'string')) : [];
    return { tags, any: localStorage.getItem(ANY_KEY) === '1' };
  } catch {
    return { tags: [], any: false };
  }
}

export function saveWantedTags(tags: readonly string[], any: boolean): void {
  try {
    localStorage.setItem(ONLY_KEY, JSON.stringify(tidyWanted(tags)));
    localStorage.setItem(ANY_KEY, any ? '1' : '0');
  } catch {
    // Kept for this visit only.
  }
}

export function saveHiddenTags(tags: readonly string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(tidy(tags)));
    localStorage.removeItem(OLD_KEY);
  } catch {
    // Kept for this visit only.
  }
}
