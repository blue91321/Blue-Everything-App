/**
 * Where chapters actually come from.
 *
 * ### Why this is an interface and not just a Suwayomi client
 *
 * Tachiyomi was nine years old when a publisher's letter closed it in eleven
 * days. Suwayomi runs the same extensions and carries the same exposure. That is
 * not a reason to avoid it — it is a reason for the reader to depend on a shape
 * rather than on a schema, so the day it goes dark is a new file in this folder
 * instead of a rewrite.
 *
 * The interface is **five methods**, arrived at by asking what the library
 * actually needs rather than what a source could offer:
 *
 *   - `describe()` — is it there, and what is it;
 *   - `search()` — find this series in the source's own catalogue;
 *   - `latestChapter()` — the newest chapter a person can actually open;
 *   - `chapters()` — the list;
 *   - `pages()` — where the images of one chapter are.
 *
 * It was four until the reader was built, and `pages` is the honest fifth: you
 * cannot read without it, and an adapter that could not answer it would not be a
 * source. Still nothing about downloads, categories, extensions or library
 * management — those are Suwayomi concepts, and putting them here would make the
 * interface a description of Suwayomi rather than of a source, which is the
 * failure it exists to avoid.
 *
 * ### This is the only part that answers the question the app is really asked
 *
 * MangaUpdates answers "what has been released and logged", and that understates
 * badly for anything read unofficially: *Archmage Curriculum* logged chapter 23
 * while 41 existed and the site being read was on 45. A source is the only thing
 * that can say what is *there*, because it is the thing serving it.
 *
 * So when a series is linked to a source, the source wins for the chapter
 * number. MangaUpdates stays as the fallback for anything unlinked, which is
 * every series until you point it at something.
 */

import { isIndexSource } from './browse.js';

/** A source's own idea of a series, before it is joined to anything of ours. */
export type SourceMatch = {
  /** Opaque to us. Suwayomi's is a numeric manga id; another adapter's may not be. */
  id: string;
  title: string;
  /** The source that holds it, for when several are installed. */
  sourceName: string;
  /** That source's own id, when the adapter has one. What Browse prefers by. */
  sourceId?: string;
  /**
   * The source's language, as its extension declares it (`en`, `es-419`).
   *
   * Carried because comparing sources across languages is comparing a
   * translation with the thing it is translated from. See `judgeSources`.
   */
  lang: string | null;
  /** Where a person would read it, if the adapter knows. */
  url: string | null;
  thumbnailUrl: string | null;
};

export type SourceChapter = {
  id: string;
  /** As the source numbers it. Float, because `220.5` is a real chapter. */
  number: number;
  name: string;
  /** Milliseconds, or null when the source does not say. */
  uploadedAt: number | null;
  scanlator: string | null;
};

/** What a source says about itself, for the screen that asks whether it is working. */
export type SourceHealth = {
  reachable: boolean;
  /** Names of the sources it can search, when it has any installed. */
  sources: string[];
  /**
   * Which languages those sources cover, and how many of each.
   *
   * Optional because an adapter may not know. It is what the "languages I
   * read" chips are built from, so they only ever offer languages you can
   * actually search.
   */
  languages?: Array<{ code: string; count: number }>;
  /** Why not, when `reachable` is false. Shown rather than logged. */
  problem: string | null;
};

export interface SourceAdapter {
  /** Stable id, stored against a series. Never shown to a person. */
  readonly id: string;
  /** What to call it on screen. */
  readonly label: string;

  describe(): Promise<SourceHealth>;
  /**
   * Titles matching `query`, best first.
   *
   * `languages` narrows which of the adapter's sources are asked — null for all.
   * The answer says how many were asked and how many skipped, because a search
   * that quietly left most of your sources out would read as those sources not
   * having the series.
   */
  search(query: string, options?: { limit?: number; languages?: readonly string[] | null }): Promise<SearchOutcome>;
  /**
   * The newest chapter number available, or null when the source has none.
   *
   * Null is "this source has nothing for that id" and must not be read as zero —
   * the caller falls back to MangaUpdates rather than reporting a series as
   * having no chapters at all.
   */
  latestChapter(mangaId: string): Promise<number | null>;
  /**
   * The chapter list.
   *
   * `refresh` decides whether the source is asked again or its own cache is
   * read. Opening a list should not scrape a website — that is seconds of
   * latency and a request to somebody else's server for a screen you are only
   * glancing at — so listing reads the cache and the release check refreshes.
   */
  chapters(mangaId: string, refresh?: boolean): Promise<SourceChapter[]>;
  /**
   * Where one chapter's images are, in reading order.
   *
   * **Opaque strings, handed back exactly as the source gave them.** Suwayomi
   * returns paths like `/api/v1/manga/2/chapter/107/page/0`, and the number in
   * the middle is its own indexing rather than anything we hold — so building
   * these ourselves would be guessing at a scheme that is theirs to change. The
   * caller proxies them; it never parses them.
   */
  pages(chapterId: string): Promise<string[]>;
}

export type SearchOutcome = {
  matches: SourceMatch[];
  searched: number;
  skipped: number;
  /**
   * Every language the installed sources cover, most sources first — so the
   * screen can offer exactly the languages there are, where the search is.
   */
  available: Array<{ code: string; count: number }>;
};

/** Raised by an adapter for anything a person can act on. Anything else is a bug. */
export class SourceError extends Error {}

/**
 * Which chapter number to believe.
 *
 * Both numbers are real and they answer different questions, so this is not a
 * "pick the bigger one" — it is a statement about authority. A source is serving
 * the chapter, so it knows; MangaUpdates is a database of what groups have
 * reported, so it lags. When a series is linked, the source wins even if it is
 * *lower*, because a source that has fallen behind is still telling the truth
 * about what you could open right now.
 */
export function readableChapter(
  fromSource: number | null,
  fromMangaUpdates: string | null
): { chapter: string | null; via: 'source' | 'mangaupdates' | null } {
  if (fromSource !== null && Number.isFinite(fromSource)) {
    // Trailing zeroes off a float: 220 rather than "220", 220.5 kept.
    return { chapter: String(fromSource), via: 'source' };
  }
  if (fromMangaUpdates) return { chapter: fromMangaUpdates, via: 'mangaupdates' };
  return { chapter: null, via: null };
}

/**
 * Which address to actually talk to.
 *
 * When the app starts Suwayomi itself it already knows where it put it, so
 * making somebody fill the address box in as well is a second setting that can
 * only ever disagree with the first. It shipped that way for one run and the
 * card reported a running Suwayomi as unconfigured — the URL was null because
 * nobody had typed one, while a JVM the app had started sat answering on the
 * default port.
 *
 * So an explicit URL always wins — that is how you point at an instance on
 * another machine — and managing one falls back to its default port.
 */
export function effectiveUrl(
  store: { suwayomiUrl: string | null; manageSuwayomi: boolean },
  defaultUrl: string
): string | null {
  if (store.suwayomiUrl) return store.suwayomiUrl;
  return store.manageSuwayomi ? defaultUrl : null;
}

/**
 * Extensions are **not** part of `SourceAdapter`, and that is the whole point.
 *
 * The interface above is five methods because those are the five things the
 * library needs of *any* source. Extensions are a Suwayomi concept — a
 * different adapter might talk to one site and have no notion of installing
 * anything — so putting them there would turn a description of "a source" into
 * a description of Suwayomi, which is the failure that interface exists to
 * avoid.
 *
 * So it is a separate capability an adapter may also implement, and the screen
 * asks whether it does rather than assuming. An adapter without it simply offers
 * no extensions tab.
 */
export type SourceExtension = {
  /** The package name, which is its id. Opaque. */
  pkg: string;
  name: string;
  lang: string;
  version: string;
  installed: boolean;
  /** Has an update waiting. */
  hasUpdate: boolean;
  /** Said out loud rather than filtered, so nothing is hidden by a judgement we made. */
  nsfw: boolean;
  iconUrl: string | null;
};

export interface ExtensionCatalogue {
  /** Where extensions are listed from. Several are allowed. */
  repos(): Promise<string[]>;
  setRepos(urls: string[]): Promise<string[]>;
  /** Everything the repos offer. `refresh` re-reads them. */
  extensions(refresh?: boolean): Promise<SourceExtension[]>;
  installExtension(pkg: string): Promise<void>;
  uninstallExtension(pkg: string): Promise<void>;
}

/** Does this adapter manage its own extensions? Asked, never assumed. */
export function supportsExtensions(adapter: SourceAdapter): adapter is SourceAdapter & ExtensionCatalogue {
  return typeof (adapter as Partial<ExtensionCatalogue>).extensions === 'function';
}

/**
 * How eagerly the app runs a source it manages.
 *
 * `on-demand` starts it when something needs it and stops it after a while
 * unused, which keeps a 166MB JVM off the machine for the hours you are not
 * reading. `always` starts it shortly after the app does and never idle-stops,
 * so opening a chapter is instant instead of costing a JVM boot.
 *
 * Two real preferences rather than a performance knob: one trades seconds for
 * memory, the other memory for seconds, and which is right depends on whether
 * you read every day or twice a month.
 */
export type SuwayomiMode = 'on-demand' | 'always';

/**
 * How well a result's title answers what was typed.
 *
 * ### Why this exists at all
 *
 * The sources rank their own results perfectly well — MangaFire returns
 * *Eleceed* first for "eleceed" — and the merge threw that away. Results were
 * sorted by source name then alphabetically by title, so the thing you searched
 * for sat eleventh between "Douka Watashi Yori" and "Junji Ito Masterpiece",
 * once per installed language. Sorting made the list *stable*, which was the
 * point, and *useless*, which was not.
 *
 * So: score against the query first, and use the source's own ordering only to
 * break ties. Stable and useful.
 */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function titleScore(query: string, title: string): number {
  const q = normalise(query);
  const t = normalise(title);
  if (!q || !t) return 0;

  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  if (t.includes(q)) return 60;

  /*
   * Otherwise, how much of the query the title actually accounts for. A source
   * searching "eleceed" and returning "Selected Pandemonium Artbook" shares no
   * word with it and scores zero — which is how the noise ends up at the bottom
   * rather than interleaved with the answer.
   */
  const wanted = new Set(q.split(' '));
  const have = new Set(t.split(' '));
  let hits = 0;
  for (const word of wanted) if (have.has(word)) hits += 1;
  return Math.round((hits / wanted.size) * 50);
}

/**
 * Best answers first, with each source's own ordering kept as the tie-break.
 *
 * Language variants of one site therefore sit together under the title they
 * share, rather than the whole result set repeating once per language — which
 * is what made the list unreadable when MangaFire registered seven of them.
 */
export function rankMatches<T extends { title: string; sourceName: string }>(
  query: string,
  matches: readonly T[]
): Array<T & { score: number }> {
  return matches
    .map((match, index) => ({ ...match, score: titleScore(query, match.title), index }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        // An equal match on a reading site beats one on a catalogue — see `isIndexSource`.
        Number(isIndexSource(a.sourceName)) - Number(isIndexSource(b.sourceName)) ||
        a.title.localeCompare(b.title) ||
        a.sourceName.localeCompare(b.sourceName) ||
        a.index - b.index
    )
    .map(({ index: _index, ...rest }) => rest as T & { score: number });
}

/**
 * What a source's chapter list says about the source, beyond its newest number.
 *
 * ### Why the newest number is not enough
 *
 * The old reader this replaces had a "related" view — the same title across
 * every source — and it was used to find three different things: a source that
 * is further ahead, one whose pages are broken, and one that **lists chapters it
 * does not have**. The newest number answers the first and actively misleads on
 * the third, because a source padding its list *looks* furthest ahead.
 *
 * So the list is read for shape as well:
 *
 *   - `distinct` against `entries` — MangaFire's English Eleceed lists 862 rows
 *     for 418 chapters, which is duplicates across scanlation groups rather than
 *     anything wrong, and is why neither raw number is shown as "how far";
 *   - `missing` — whole chapters between the first and the newest that no row
 *     covers, which is what a source that skipped ahead looks like;
 *   - `newestUpload` — a source "ahead" that last uploaded a year ago is not
 *     ahead, it is abandoned with a stale number on top.
 *
 * Computed from the list the count already fetched, so none of it costs a
 * request.
 */
export type ChapterProfile = {
  /** Rows the source lists. More than `distinct` when groups overlap. */
  entries: number;
  /** Different chapter numbers. */
  distinct: number;
  first: number | null;
  latest: number | null;
  /** The source's own id for the newest chapter, so its pages can be checked. */
  latestChapterId: string | null;
  /** Whole-number chapters between `first` and `latest` that nothing covers. */
  missing: number;
  /** A few of them, so the row can name some rather than only count them. */
  missingSample: number[];
  newestUpload: number | null;
};

/**
 * The widest range walked for gaps.
 *
 * A source listing "chapter 99999" is exactly the kind this is for, and walking
 * a hundred thousand integers to say so would be the one slow thing here. Past
 * this the gap count is left at zero — the consensus check will already have
 * flagged a number that absurd.
 */
const GAP_WALK_LIMIT = 5000;

export function profileChapters(chapters: readonly SourceChapter[]): ChapterProfile {
  const valid = chapters.filter((c) => Number.isFinite(c.number) && c.number >= 0);

  const profile: ChapterProfile = {
    entries: chapters.length,
    distinct: 0,
    first: null,
    latest: null,
    latestChapterId: null,
    missing: 0,
    missingSample: [],
    newestUpload: null,
  };
  if (valid.length === 0) return profile;

  const distinct = new Set<number>();
  const floors = new Set<number>();
  let newest = valid[0];
  let lowest = Infinity;
  for (const c of valid) {
    distinct.add(c.number);
    const floor = Math.floor(c.number);
    floors.add(floor);
    if (floor < lowest) lowest = floor;
    if (c.number > newest.number) newest = c;
    if (c.uploadedAt !== null && (profile.newestUpload === null || c.uploadedAt > profile.newestUpload)) {
      profile.newestUpload = c.uploadedAt;
    }
  }

  profile.distinct = distinct.size;
  profile.first = lowest;
  profile.latest = newest.number;
  profile.latestChapterId = newest.id;

  /*
   * Gaps are counted from where the source *starts*, not from chapter 1.
   *
   * Plenty of sources only carry recent chapters — a site that picked a series
   * up at 300 has nothing before it and is not broken for that. Counting from 1
   * would call it three hundred chapters short, which is a fact about its
   * catalogue rather than a hole in it.
   */
  const top = Math.floor(newest.number);
  if (top - lowest <= GAP_WALK_LIMIT) {
    for (let k = lowest; k <= top; k += 1) {
      if (floors.has(k)) continue;
      profile.missing += 1;
      if (profile.missingSample.length < 5) profile.missingSample.push(k);
    }
  }

  return profile;
}

/** One page fetched to see whether it is really a page. */
export type PageSample = { ok: boolean; bytes: number; contentType: string | null };

export type PageVerdict = {
  pages: number;
  state: 'fine' | 'suspicious' | 'broken';
  problem: string | null;
};

/**
 * Below this a "page" is almost certainly not one.
 *
 * A real manga page is tens to hundreds of kilobytes; the ones checked here ran
 * 44–215KB. A few kilobytes is a spacer, a 1×1 tracking pixel, or an error
 * image a CDN serves in place of the thing it could not find.
 */
const TINY_PAGE_BYTES = 3_000;

/**
 * Whether a chapter's pages are real, from a sample of them.
 *
 * Only ever a sample — the first, the middle and the last — because checking a
 * whole chapter is the same cost as reading it. The ends are where it goes wrong
 * in practice: a chapter listed before it exists is typically one "coming soon"
 * image, and a corrupted one fails part-way or serves an error page where the
 * image should be.
 *
 * `broken` and `suspicious` are kept apart because only one of them is certain.
 * Pages that fail to load, or come back as HTML, are broken whatever the reason.
 * A single page, or a very small one, is *often* a placeholder — and sometimes a
 * genuinely short chapter — so it is reported as worth a look, not as a fault.
 */
export function judgePages(pages: number, samples: readonly PageSample[]): PageVerdict {
  if (pages === 0) return { pages, state: 'broken', problem: 'the chapter has no pages' };

  const failed = samples.filter((s) => !s.ok).length;
  if (failed > 0) {
    return { pages, state: 'broken', problem: `${failed} of ${samples.length} sampled pages would not load` };
  }

  const notImage = samples.find((s) => s.contentType !== null && !s.contentType.toLowerCase().startsWith('image/'));
  if (notImage) {
    return { pages, state: 'broken', problem: `a page came back as ${notImage.contentType}, not an image` };
  }

  if (pages === 1) {
    return {
      pages,
      state: 'suspicious',
      problem: 'only one page — sometimes a placeholder for a chapter that is not out yet',
    };
  }

  const tiny = samples.find((s) => s.bytes < TINY_PAGE_BYTES);
  if (tiny) {
    return {
      pages,
      state: 'suspicious',
      problem: `a page is only ${Math.max(1, Math.round(tiny.bytes / 1000))}KB — often a placeholder rather than art`,
    };
  }

  return { pages, state: 'fine', problem: null };
}

/**
 * Codes that are not a language, and so are never filtered out.
 *
 * `all` is a source serving every language from one listing; `localsourcelang`
 * is Suwayomi's Local source — your own files on disk. Leaving either out
 * because it is not "English" would be reading a label as a language.
 */
export const ALWAYS_SEARCHED = new Set(['all', 'localsourcelang']);

/** The default, until you say otherwise on the source card. */
export const DEFAULT_LANGUAGES = ['en'];

/**
 * Which installed sources a search should ask.
 *
 * ### Why this exists
 *
 * Installing MangaDex registers **one source per language — about sixty**. With
 * it installed there were 82 sources across 63 languages and 7 in English, and a
 * comparison of Eleceed came back as twenty MangaDex languages in alphabetical
 * order — Afrikaans, Azerbaijani, Belarusian, every one empty — while MangaFire's
 * English source, the one that actually reaches 418, fell off the end of the
 * list entirely.
 *
 * Tachiyomi and Mihon answer this with "languages I read", and so does this.
 * `null` means every language, which the comparison screen offers as a one-off.
 */
export function sourcesToSearch<T extends { lang: string }>(
  sources: readonly T[],
  languages: readonly string[] | null
): { searched: T[]; skipped: number } {
  if (languages === null || languages.length === 0) return { searched: [...sources], skipped: 0 };
  const wanted = new Set(languages.map((l) => l.toLowerCase()));
  const searched = sources.filter((s) => ALWAYS_SEARCHED.has(s.lang) || wanted.has(s.lang.toLowerCase()));
  return { searched, skipped: sources.length - searched.length };
}
