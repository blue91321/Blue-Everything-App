/**
 * Suwayomi, as one implementation of `SourceAdapter`.
 *
 * Suwayomi-Server is headless Tachiyomi: it loads the same extensions and
 * exposes them over GraphQL at `/api/graphql`. It is **not** shipped, started or
 * installed by this app, and nothing here downloads it. It is a thing you chose
 * to run, and this talks to it the way the Riot reader talks to the League
 * client's loopback API — a service on this machine, reached over HTTP, whose
 * presence is entirely your business.
 *
 * ### Everything here is written against the real schema
 *
 * Not guessed. The operation names, input shapes and enum values were taken from
 * Suwayomi-WebUI's own generated types, which are what its browser half calls:
 *
 * ```
 * FetchSourceMangaInput  { source: LongString!, type: FetchSourceMangaType, page: Int!, query: String }
 * FetchSourceMangaType   LATEST | POPULAR | SEARCH
 * FetchMangaAndChaptersInput { id: Int!, fetchManga: Boolean!, fetchChapters: Boolean! }
 * FetchChapterPagesInput { chapterId: Int!, format: String }
 * ChapterType            { id: Int!, chapterNumber: Float!, name: String!, uploadDate: LongString!, scanlator: String }
 * SourceType             { id: LongString!, displayName: String!, iconUrl: String! }
 * ```
 *
 * The REST API at `/api/v1` also exists and is **deprecated upstream**, so it is
 * deliberately not used — building on it would buy a simpler client now and a
 * rewrite later.
 *
 * ### Searching is a mutation, which is not a mistake
 *
 * `fetchSourceManga` is a *mutation* because asking a source to search makes the
 * server go and fetch, then write what it found into its own database. That
 * reads oddly against the usual rule that a query does not change anything, and
 * it is theirs rather than ours. It is written down here so nobody "corrects" it
 * to a query and finds the field does not exist.
 */
import {
  SourceError,
  type ExtensionCatalogue,
  type SourceAdapter,
  type SourceChapter,
  type SourceExtension,
  type SourceHealth,
  type SourceMatch,
  type SearchOutcome,
  rankMatches,
  sourcesToSearch,
} from './sources.js';
import { fromSuwayomiFilter, type SourceFilter } from './browse.js';

/** A series as its source describes it — see `SuwayomiAdapter.details`. */
export type SeriesDetails = {
  id: string;
  title: string;
  author: string | null;
  artist: string | null;
  description: string | null;
  genres: string[];
  status: 'ongoing' | 'completed' | 'hiatus' | 'cancelled' | 'licensed' | 'unknown';
  thumbnailUrl: string | null;
  url: string | null;
  sourceId: string | null;
  sourceName: string;
  lang: string | null;
  /** True when the site would not answer and this is Suwayomi's stored copy. */
  stale: boolean;
};

/**
 * Suwayomi's statuses, folded to the library's words plus one.
 *
 * `LICENSED` keeps its own value rather than reading as cancelled: it is a
 * series taken down from a scanlation site because an official release exists.
 * The run has not ended — it has stopped *on this source* — and the page says
 * that, since it is exactly what you want to know before following from here.
 */
const STATUS: Record<string, SeriesDetails['status']> = {
  ONGOING: 'ongoing',
  COMPLETED: 'completed',
  PUBLISHING_FINISHED: 'completed',
  ON_HIATUS: 'hiatus',
  CANCELLED: 'cancelled',
  LICENSED: 'licensed',
};

/** One installed source, as the Browse tab offers it. */
export type BrowseSource = { id: string; name: string; lang: string; supportsLatest: boolean };

type SourceNode = { id: string; displayName: string; lang: string };

/**
 * Every member of the filter union, with `default` aliased per member.
 *
 * GraphQL refuses one field name with a different type on different members of
 * a union — `default` is a Boolean on a checkbox and an Int on a select — so the
 * obvious query fails outright. The aliases are what `fromSuwayomiFilter` reads.
 */
const FILTER_FIELDS = `__typename
  ... on CheckBoxFilter { name checkDefault: default }
  ... on SelectFilter { name selectDefault: default values }
  ... on TriStateFilter { name triDefault: default }
  ... on TextFilter { name textDefault: default }
  ... on SortFilter { name values sortDefault: default { index ascending } }
  ... on HeaderFilter { name }
  ... on SeparatorFilter { name }`;

/** Suwayomi's own default. Overridable, because nothing says it has to be here. */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:4567';

type Json = Record<string, any>;

export class SuwayomiAdapter implements SourceAdapter, ExtensionCatalogue {
  readonly id = 'suwayomi';
  readonly label = 'Suwayomi';

  constructor(private readonly baseUrl: string = DEFAULT_BASE_URL) {}

  /**
   * One GraphQL round trip.
   *
   * `errors` is checked even on a 200, because GraphQL reports failures in the
   * body with an HTTP 200 — treating the status as the answer is the standard
   * way to make a broken query look like an empty result.
   */
  private async gql<T = Json>(query: string, variables: Json = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new SourceError(
        error instanceof Error && error.name === 'TimeoutError'
          ? 'Suwayomi did not answer in time'
          : `could not reach Suwayomi at ${this.baseUrl}`
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new SourceError('Suwayomi refused the request — it may have authentication switched on');
    }
    if (!response.ok) throw new SourceError(`Suwayomi answered ${response.status}`);

    const body = (await response.json()) as { data?: T; errors?: Array<{ message?: string }> };
    if (body.errors?.length) {
      throw new SourceError(body.errors[0]?.message ?? 'Suwayomi rejected the query');
    }
    if (!body.data) throw new SourceError('Suwayomi returned no data');
    return body.data;
  }

  /* ---- extensions ---- */

  async repos(): Promise<string[]> {
    const data = await this.gql<{ settings: { extensionRepos: string[] | null } }>(
      `query { settings { extensionRepos } }`
    );
    return data.settings?.extensionRepos ?? [];
  }

  async setRepos(urls: string[]): Promise<string[]> {
    const data = await this.gql<{ setSettings: { settings: { extensionRepos: string[] | null } } }>(
      `mutation SetRepos($input: SetSettingsInput!) {
         setSettings(input: $input) { settings { extensionRepos } }
       }`,
      { input: { settings: { extensionRepos: urls } } }
    );
    return data.setSettings?.settings?.extensionRepos ?? [];
  }

  /**
   * Everything the repositories offer.
   *
   * `refresh` re-reads the repos, which is a network fetch of a large index —
   * so the screen reads the stored list and refreshing is a button.
   *
   * **The first refresh after adding a repo returns nothing**, reliably. Seen on
   * a clean install: `fetchExtensions` answered with an empty list, and calling
   * it again immediately answered with 1,396. It appears to kick off the load
   * and report what it had rather than what it fetched. So a refresh that comes
   * back empty is tried once more before being believed — an empty list is
   * otherwise indistinguishable from a repository URL that is wrong.
   */
  async extensions(refresh = false): Promise<SourceExtension[]> {
    const FIELDS = 'pkgName name lang versionName isInstalled hasUpdate isNsfw iconUrl';

    if (refresh) {
      const first = await this.gql<{ fetchExtensions: { extensions: any[] } }>(
        `mutation { fetchExtensions(input: {}) { extensions { ${FIELDS} } } }`
      );
      const got = first.fetchExtensions?.extensions ?? [];
      if (got.length > 0) return got.map(toExtension);

      const again = await this.gql<{ fetchExtensions: { extensions: any[] } }>(
        `mutation { fetchExtensions(input: {}) { extensions { ${FIELDS} } } }`
      );
      return (again.fetchExtensions?.extensions ?? []).map(toExtension);
    }

    const data = await this.gql<{ extensions: { nodes: any[] } }>(
      `query { extensions { nodes { ${FIELDS} } } }`
    );
    return (data.extensions?.nodes ?? []).map(toExtension);
  }

  async installExtension(pkg: string): Promise<void> {
    await this.setInstalled(pkg, true);
  }

  async uninstallExtension(pkg: string): Promise<void> {
    await this.setInstalled(pkg, false);
  }

  private async setInstalled(pkg: string, install: boolean): Promise<void> {
    await this.gql(
      `mutation Set($input: UpdateExtensionInput!) {
         updateExtension(input: $input) { extension { pkgName isInstalled } }
       }`,
      { input: { id: pkg, patch: install ? { install: true } : { uninstall: true } } }
    );
  }

  /* ---- reading ---- */

  async describe(): Promise<SourceHealth> {
    try {
      const data = await this.gql<{ sources: { nodes: Array<{ displayName: string; lang: string }> } }>(
        `query { sources { nodes { id displayName lang } } }`
      );
      const nodes = data.sources?.nodes ?? [];
      const counts = new Map<string, number>();
      for (const n of nodes) if (n.lang) counts.set(n.lang, (counts.get(n.lang) ?? 0) + 1);
      return {
        reachable: true,
        sources: nodes.map((s) => s.displayName).filter(Boolean),
        languages: [...counts].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
        problem: null,
      };
    } catch (error) {
      // Reported rather than thrown: "is it running" is a question the screen
      // asks on every visit, and an exception there would be an error banner for
      // the ordinary state of not having installed it.
      return {
        reachable: false,
        sources: [],
        problem: error instanceof SourceError ? error.message : 'Suwayomi could not be reached',
      };
    }
  }

  /* ---- browsing ---- */

  async listSources(): Promise<BrowseSource[]> {
    const data = await this.gql<{
      sources: { nodes: Array<SourceNode & { supportsLatest: boolean }> };
    }>(`query { sources { nodes { id displayName lang supportsLatest } } }`);
    return (data.sources?.nodes ?? []).map((s) => ({
      id: String(s.id),
      name: s.displayName,
      lang: s.lang,
      supportsLatest: s.supportsLatest === true,
    }));
  }

  /**
   * One page of one source: its popular list, its newest releases, or a search.
   *
   * `filters` is already Suwayomi's `FilterChangeInput` — see
   * `toSuwayomiChanges`, which is what checks them.
   */
  async browse(
    source: SourceNode,
    type: 'POPULAR' | 'LATEST' | 'SEARCH',
    page: number,
    query?: string,
    filters?: Json[]
  ): Promise<{ matches: SourceMatch[]; hasNextPage: boolean }> {
    const found = await this.gql<{
      fetchSourceManga: {
        hasNextPage: boolean;
        mangas: Array<{ id: number; title: string; realUrl?: string | null; thumbnailUrl?: string | null }>;
      };
    }>(
      `mutation Browse($input: FetchSourceMangaInput!) {
         fetchSourceManga(input: $input) {
           hasNextPage
           mangas { id title realUrl thumbnailUrl }
         }
       }`,
      {
        input: {
          source: source.id,
          type,
          page,
          ...(query ? { query } : {}),
          ...(filters && filters.length > 0 ? { filters } : {}),
        },
      }
    );
    return {
      hasNextPage: found.fetchSourceManga?.hasNextPage === true,
      matches: (found.fetchSourceManga?.mangas ?? []).map((m) => ({
        id: String(m.id),
        title: m.title,
        sourceId: String(source.id),
        sourceName: source.displayName,
        lang: source.lang || null,
        url: m.realUrl ?? null,
        thumbnailUrl: m.thumbnailUrl ?? null,
      })),
    };
  }

  /** A source's own filters, as it declares them. */
  async filters(sourceId: string): Promise<SourceFilter[]> {
    const data = await this.gql<{ source: { filters: Json[] } }>(
      `query Filters($id: LongString!) {
         source(id: $id) { filters { ${FILTER_FIELDS} ... on GroupFilter { name filters { ${FILTER_FIELDS} } } } }
       }`,
      { id: sourceId }
    );
    return (data.source?.filters ?? []).map(fromSuwayomiFilter);
  }

  /**
   * Search every installed source and merge the results.
   *
   * **Every one, not the first few.** This capped at eight sources to bound the
   * upstream requests, and installing MangaFire exposed the flaw immediately: it
   * registers one source per language, so eleven sources existed and three were
   * silently never searched. A series missing because of a cap nothing mentions
   * is indistinguishable from a series that is not there — and the cap was
   * solving a problem this screen does not have, since searching is a button
   * press rather than a keystroke.
   *
   * Bounded by concurrency instead, so eleven sources are four requests at a
   * time rather than eleven at once.
   */
  async search(
    query: string,
    {
      limit = 40,
      languages = null,
      only = null,
      exclude = null,
    }: {
      limit?: number;
      languages?: readonly string[] | null;
      /** Ask just these source ids — the Browse tab's "which sources" filter. */
      only?: readonly string[] | null;
      /** Leave this one out, because the caller is asking it separately with its own filters. */
      exclude?: string | null;
    } = {}
  ): Promise<SearchOutcome> {
    const data = await this.gql<{ sources: { nodes: Array<{ id: string; displayName: string; lang: string }> } }>(
      `query { sources { nodes { id displayName lang } } }`
    );
    const installed = data.sources?.nodes ?? [];
    if (installed.length === 0) {
      throw new SourceError('Suwayomi is running but has no sources installed — add an extension repository first');
    }

    const byLanguage = sourcesToSearch(installed, languages);
    const wanted = only ? new Set(only) : null;
    const sources = byLanguage.searched.filter(
      (s) => String(s.id) !== exclude && (wanted === null || wanted.has(String(s.id)))
    );
    const skipped = byLanguage.skipped;

    const out: SourceMatch[] = [];
    let next = 0;

    const worker = async () => {
      while (next < sources.length) {
        const source = sources[next++];
        try {
          out.push(...(await this.browse(source, 'SEARCH', 1, query)).matches);
        } catch {
          /*
           * One source failing must not fail the search. Extensions break
           * constantly — a site changes its markup and that one extension throws
           * — and a search returning nothing because the fourth of eleven
           * sources is broken is indistinguishable from a series not existing.
           */
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(4, sources.length) }, worker));

    /*
     * Ranked against the query, not sorted by source.
     *
     * Concurrency made the raw order whatever finished first, and the first fix
     * for that sorted by source then title — stable, and useless: the thing you
     * searched for landed eleventh, once per installed language. `rankMatches`
     * keeps it stable *and* puts the answer first. See its note.
     */
    /*
     * The limit was 20 and silently cut the answer off: with MangaDex's sixty
     * languages installed, twenty MangaDex rows filled it before MangaFire's
     * English source was reached. Filtering by language is the real fix; the
     * limit is raised so that it binds only in the unusual case, where it cuts
     * the *worst* matches because they are ranked first.
     */
    const counts = new Map<string, number>();
    for (const s of installed) if (s.lang) counts.set(s.lang, (counts.get(s.lang) ?? 0) + 1);

    return {
      matches: rankMatches(query, out).slice(0, limit),
      searched: sources.length,
      skipped,
      available: [...counts].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
    };
  }

  /**
   * One series as its source describes it: blurb, people, genres, status.
   *
   * A browse result carries a title and a cover and nothing else — Suwayomi
   * stores the rest only once somebody asks — so this asks. `fetchManga` goes
   * to the site; if the site will not answer, Suwayomi's stored copy is read
   * instead and the page says less rather than failing, because a detail page
   * that errors over a blurb loses the chapters and the Follow button with it.
   */
  async details(mangaId: string): Promise<SeriesDetails> {
    const id = Number.parseInt(mangaId, 10);
    if (!Number.isSafeInteger(id)) throw new SourceError('not a Suwayomi manga id');
    const FIELDS = 'id title author artist description genre status thumbnailUrl realUrl source { id displayName lang }';

    let manga: Json | null = null;
    let stale = false;
    try {
      const data = await this.gql<{ fetchManga: { manga: Json } }>(
        `mutation Details($id: Int!) { fetchManga(input: { id: $id }) { manga { ${FIELDS} } } }`,
        { id }
      );
      manga = data.fetchManga?.manga ?? null;
    } catch {
      const data = await this.gql<{ manga: Json }>(`query Stored($id: Int!) { manga(id: $id) { ${FIELDS} } }`, { id });
      manga = data.manga ?? null;
      stale = true;
    }
    if (!manga) throw new SourceError('the source has no such series');

    return {
      id: String(manga.id),
      title: String(manga.title ?? ''),
      author: manga.author || null,
      artist: manga.artist || null,
      description: typeof manga.description === 'string' && manga.description.trim() ? manga.description.trim() : null,
      genres: Array.isArray(manga.genre) ? manga.genre.filter((g: unknown) => typeof g === 'string' && g.trim()) : [],
      status: STATUS[manga.status as string] ?? 'unknown',
      thumbnailUrl: manga.thumbnailUrl ?? null,
      url: manga.realUrl ?? null,
      sourceId: manga.source ? String(manga.source.id) : null,
      sourceName: manga.source?.displayName ?? 'Suwayomi',
      lang: manga.source?.lang || null,
      stale,
    };
  }

  async chapters(mangaId: string, refresh = true): Promise<SourceChapter[]> {
    const id = Number.parseInt(mangaId, 10);
    if (!Number.isSafeInteger(id)) throw new SourceError('not a Suwayomi manga id');

    if (!refresh) {
      /*
       * Suwayomi's own copy, with no request to the site at all.
       *
       * This is a *query* rather than the mutation below, and the difference is
       * seconds: opening a chapter list should not scrape a website. The release
       * check refreshes; the screen reads.
       */
      const cached = await this.gql<{
        chapters: { nodes: Array<{ id: number; name: string; chapterNumber: number; uploadDate?: string | null; scanlator?: string | null }> };
      }>(
        `query Cached($id: Int!) {
           chapters(condition: { mangaId: $id }, order: [{ by: SOURCE_ORDER }]) {
             nodes { id name chapterNumber uploadDate scanlator }
           }
         }`,
        { id }
      );
      return (cached.chapters?.nodes ?? []).map((c) => ({
        id: String(c.id),
        number: c.chapterNumber,
        name: c.name,
        uploadedAt: uploadedAtMs(c.uploadDate),
        scanlator: c.scanlator ?? null,
      }));
    }

    /*
     * `fetchChapters: true` makes the server go and ask the source rather than
     * answering from its own database. That is the whole point for a release
     * check — a cached answer is exactly the stale number this layer exists to
     * replace — and it is why this is a mutation and why it is slower.
     */
    const data = await this.gql<{
      fetchMangaAndChapters: {
        chapters: Array<{
          id: number;
          name: string;
          chapterNumber: number;
          uploadDate?: string | null;
          scanlator?: string | null;
        }>;
      };
    }>(
      `mutation Refresh($id: Int!) {
         fetchMangaAndChapters(input: { id: $id, fetchManga: false, fetchChapters: true }) {
           chapters { id name chapterNumber uploadDate scanlator }
         }
       }`,
      { id }
    );

    return (data.fetchMangaAndChapters?.chapters ?? []).map((c) => ({
      id: String(c.id),
      number: c.chapterNumber,
      name: c.name,
      // `uploadDate` is a LongString — epoch milliseconds as text, because
      // GraphQL's Int is 32-bit and a millisecond timestamp overflows it.
      uploadedAt: uploadedAtMs(c.uploadDate),
      scanlator: c.scanlator ?? null,
    }));
  }

  async pages(chapterId: string): Promise<string[]> {
    const id = Number.parseInt(chapterId, 10);
    if (!Number.isSafeInteger(id)) throw new SourceError('not a Suwayomi chapter id');

    /*
     * A mutation, again, and for the same reason `fetchSourceManga` is one: it
     * makes the server go to the site, work out the page list and cache it. A
     * chapter that has never been opened has `pageCount: -1` until this runs.
     */
    const data = await this.gql<{ fetchChapterPages: { pages: string[] } }>(
      `mutation Pages($id: Int!) {
         fetchChapterPages(input: { chapterId: $id }) {
           chapter { id pageCount }
           pages
         }
       }`,
      { id }
    );

    return (data.fetchChapterPages?.pages ?? []).filter((p) => typeof p === 'string' && p.length > 0);
  }

  async latestChapter(mangaId: string): Promise<number | null> {
    /*
     * The maximum, not the first. `sourceOrder` is the source's own ordering and
     * is usually newest-first, but "usually" is not something to hang a chapter
     * number on — extensions differ, and some list oldest-first.
     */
    const numbers = (await this.chapters(mangaId)).map((c) => c.number).filter((n) => Number.isFinite(n));
    return numbers.length > 0 ? Math.max(...numbers) : null;
  }
}

/**
 * Where extensions are listed from.
 *
 * Suwayomi ships with none, which is why a fresh install has one source called
 * "Local source" and finds nothing — the commonest confusing first experience
 * here, and why the screen offers the community repository by name rather than
 * leaving you to find a URL.
 */
export const KEIYOUSHI_REPO = 'https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json';

/**
 * Suwayomi sends timestamps as `LongString` — epoch milliseconds as *text*,
 * because GraphQL's `Int` is 32-bit and a millisecond timestamp does not fit.
 * Parsing it as a number is therefore required rather than defensive.
 */
function toExtension(raw: any): SourceExtension {
  return {
    pkg: String(raw.pkgName ?? ''),
    name: String(raw.name ?? ''),
    lang: String(raw.lang ?? ''),
    version: String(raw.versionName ?? ''),
    installed: raw.isInstalled === true,
    hasUpdate: raw.hasUpdate === true,
    nsfw: raw.isNsfw === true,
    iconUrl: typeof raw.iconUrl === 'string' && raw.iconUrl ? raw.iconUrl : null,
  };
}

export function uploadedAtMs(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const n = Number.parseInt(raw.trim(), 10);
  // Zero is Suwayomi's "no date", not 1970.
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
