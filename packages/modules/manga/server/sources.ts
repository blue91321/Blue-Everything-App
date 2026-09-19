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

/** A source's own idea of a series, before it is joined to anything of ours. */
export type SourceMatch = {
  /** Opaque to us. Suwayomi's is a numeric manga id; another adapter's may not be. */
  id: string;
  title: string;
  /** The source that holds it, for when several are installed. */
  sourceName: string;
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
  /** Why not, when `reachable` is false. Shown rather than logged. */
  problem: string | null;
};

export interface SourceAdapter {
  /** Stable id, stored against a series. Never shown to a person. */
  readonly id: string;
  /** What to call it on screen. */
  readonly label: string;

  describe(): Promise<SourceHealth>;
  search(query: string, limit?: number): Promise<SourceMatch[]>;
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
        a.title.localeCompare(b.title) ||
        a.sourceName.localeCompare(b.sourceName) ||
        a.index - b.index
    )
    .map(({ index: _index, ...rest }) => rest as T & { score: number });
}
