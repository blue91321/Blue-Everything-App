/**
 * The rules of the chapter catalogue (`server/catalogue.ts`), with no imports so
 * `manga-check` asserts them directly.
 *
 * The catalogue knows, for each copy of a series on each source, how many
 * chapters that copy has and its newest number, and when it last looked. These
 * say what to make of that: whether another source is ahead, whether that is
 * worth a nudge, when a whole source's list counts as mapped, and when a
 * mapped source is due a look at what is new.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
/** A count older than this is not compared: two months on, a "lead" may long since have closed. */
export const FRESH_FOR_MS = 14 * DAY_MS;
/** A count older than this is asked again when the library check passes it. */
export const RECOUNT_AFTER_MS = 7 * DAY_MS;
/** A series is searched for on a source again after this, by the library check. */
export const RESEARCH_AFTER_MS = 30 * DAY_MS;
/** A mapped source is looked at for what is new this often. */
export const LATEST_EVERY_MS = DAY_MS;
/** A mapped source with no "latest" list is mapped again from the start this often. */
export const REMAP_EVERY_MS = 30 * DAY_MS;

export interface CopyCount {
  /** The source's name, for the nudge to say. */
  source: string;
  mangaId: string;
  /** Newest chapter number on that copy, or null when it has none. */
  latest: number | null;
  /** Distinct chapter numbers on it. */
  distinct: number;
  /** When it was counted. */
  at: number;
  /** Counted by a linked server, by its name, rather than by this one. */
  via?: string;
}

/**
 * The copies ahead of yours, best first: counted within `FRESH_FOR_MS`, and at
 * least one whole chapter further. Whole, because point chapters are split
 * differently on every source (2.1 and 2.2 here, one chapter 2 there), so 120.5
 * against 120 is not a lead worth telling anybody about.
 */
export function aheadOf(own: number | null, copies: readonly CopyCount[], now: number): CopyCount[] {
  const mine = own === null ? -Infinity : Math.floor(own);
  return copies
    .filter((c) => c.latest !== null && now - c.at <= FRESH_FOR_MS && Math.floor(c.latest) > mine)
    .sort((a, b) => b.latest! - a.latest! || b.distinct - a.distinct || b.at - a.at);
}

/**
 * Whether the best copy ahead is news: further than anything already told about
 * this series. So a lead is said once, and said again only when it grows, not on
 * every sweep that finds it still there.
 */
export function worthTelling(best: CopyCount | undefined, told: number | undefined): boolean {
  if (!best || best.latest === null) return false;
  return told === undefined || Math.floor(best.latest) > Math.floor(told);
}

/**
 * Whether a source's whole list, read to its last page, can be trusted as every
 * series on the site.
 *
 * A site's "popular" list is usually the whole catalogue by views, and on some
 * sites it stops at fifty pages. So the series a search found there are the
 * test: nearly all of them (`MAPPED_SHARE`) must have turned up in the list as
 * well. With too few found by search to say (`MIN_TEST`), a list that ran to
 * many pages is taken (`MIN_PAGES`) and a short one is not.
 */
export const MAPPED_SHARE = 0.9;
export const MIN_TEST = 5;
export const MIN_PAGES = 20;

export type MapVerdict = { mapped: true } | { mapped: false; why: string };

export function mapVerdict(foundBySearch: readonly string[], seenInList: ReadonlySet<string>, pages: number): MapVerdict {
  if (seenInList.size === 0) return { mapped: false, why: 'its list was empty' };
  if (foundBySearch.length >= MIN_TEST) {
    const inList = foundBySearch.filter((id) => seenInList.has(id)).length;
    if (inList / foundBySearch.length >= MAPPED_SHARE) return { mapped: true };
    return {
      mapped: false,
      why: `its full list left out ${foundBySearch.length - inList} of ${foundBySearch.length} series a search found there, so it does not list everything`,
    };
  }
  if (pages >= MIN_PAGES) return { mapped: true };
  return { mapped: false, why: `its list ended after ${pages} page${pages === 1 ? '' : 's'}, too few to be sure it is everything` };
}

/** Whether a mapped source is due its look at what is new. */
export const latestDue = (lastAt: number | null, now: number): boolean => lastAt === null || now - lastAt >= LATEST_EVERY_MS;

/** Whether a series is due a search on a source that is not mapped. */
export const searchDue = (searchedAt: number | undefined, now: number): boolean => searchedAt === undefined || now - searchedAt >= RESEARCH_AFTER_MS;

/** Whether a copy's count is due asking again. */
export const recountDue = (at: number | undefined, now: number): boolean => at === undefined || now - at >= RECOUNT_AFTER_MS;

/**
 * A copy that is the novel, not the comic: "Sovereign of the Infinite Clones
 * [Novel]" on Thunder Scans, at chapter 450 against the comic's 104. The name
 * matching sets bracketed asides aside, which is right for "(2022)" and an
 * author, and made the novel the comic. So a title marked as a novel, light
 * novel or web novel is left out, unless the series itself is one.
 */
const NOVEL = /\b(?:light|web)?\s*novels?\b|[[(](?:ln|wn)[\])]/i;
export const isNovel = (title: string): boolean => NOVEL.test(title);

/**
 * Between two requests to one source, after its answer. With the answer's own
 * time on top that is at most about fifteen a minute to any one site, which is
 * a person clicking through it, not a crawler.
 */
export const PAUSE_MS = 3_000;

/**
 * A site saying stop, as opposed to answering: too many requests, forbidden, a
 * server error, a Cloudflare check, or no answer in time. "No chapters found",
 * a 404 and "no such series" are answers about one series and are not this.
 * Suwayomi itself not running is not the site's doing either.
 */
const REFUSAL = /\bHTTP error (?:403|429|5\d\d)\b|too many requests|rate.?limit|cloudflare|captcha|did not answer in time|\btime(?:d)?[ -]?out\b/i;
export const isRefusal = (message: string): boolean => REFUSAL.test(message);

/** How long a source that refused is left alone, by how many times in a row it has refused: 10, 20, then 40 minutes. */
export const HOLD_FOR_MS = [10, 20, 40].map((minutes) => minutes * 60_000);

/**
 * What to do after a source's `inARow`th refusal in a row: leave it alone for a
 * while and then ask again, or, once the pauses have not helped, leave it out of
 * the rest of the run. An answer in between starts the count again.
 */
export function afterRefusal(inARow: number): { holdMs: number } | { drop: true } {
  if (inARow > HOLD_FOR_MS.length) return { drop: true };
  return { holdMs: HOLD_FOR_MS[Math.max(0, inARow - 1)]! };
}

/** A source left out of a run for refusing is left alone by later runs for this long. */
export const REST_AFTER_DROP_MS = DAY_MS;
/** A search or a count that failed for some other reason is tried again after this, not on every run. */
export const TRY_AGAIN_MS = DAY_MS;
export const triedRecently = (at: number | undefined, now: number): boolean => at !== undefined && now - at < TRY_AGAIN_MS;

/** "Up to ch. 120" on MangaHub against your 115, for the nudge's body. */
export function aheadText(best: CopyCount, own: number | null, ownSource: string | null): string {
  const n = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
  const yours = own === null ? (ownSource ? `${ownSource} has none` : 'yours has none') : `${ownSource ?? 'yours'} is at ${n(own)}`;
  return `${best.source} has up to chapter ${n(best.latest!)}${best.via ? ` (counted by ${best.via}'s server)` : ''}; ${yours}.`;
}
