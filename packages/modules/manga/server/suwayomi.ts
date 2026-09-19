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
} from './sources.js';

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
      const data = await this.gql<{ sources: { nodes: Array<{ displayName: string }> } }>(
        `query { sources { nodes { id displayName } } }`
      );
      return {
        reachable: true,
        sources: (data.sources?.nodes ?? []).map((s) => s.displayName).filter(Boolean),
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
  async search(query: string, limit = 20): Promise<SourceMatch[]> {
    const data = await this.gql<{ sources: { nodes: Array<{ id: string; displayName: string }> } }>(
      `query { sources { nodes { id displayName } } }`
    );
    const sources = data.sources?.nodes ?? [];
    if (sources.length === 0) {
      throw new SourceError('Suwayomi is running but has no sources installed — add an extension repository first');
    }

    const out: SourceMatch[] = [];
    let next = 0;

    const worker = async () => {
      while (next < sources.length) {
        const source = sources[next++];
        try {
          const found = await this.gql<{
            fetchSourceManga: { mangas: Array<{ id: number; title: string; realUrl?: string | null; thumbnailUrl?: string | null }> };
          }>(
            `mutation Search($input: FetchSourceMangaInput!) {
               fetchSourceManga(input: $input) {
                 hasNextPage
                 mangas { id title realUrl thumbnailUrl }
               }
             }`,
            { input: { source: source.id, type: 'SEARCH', page: 1, query } }
          );

          for (const m of found.fetchSourceManga?.mangas ?? []) {
            out.push({
              id: String(m.id),
              title: m.title,
              sourceName: source.displayName,
              url: m.realUrl ?? null,
              thumbnailUrl: m.thumbnailUrl ?? null,
            });
          }
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
     * Sorted by source, because searching concurrently made the order whatever
     * finished first — so the same query listed its results differently each
     * time, and picking "the first Archmage Curriculum" landed on MangaFire's
     * *Spanish* source, which has no chapters for it.
     *
     * A person choosing from this list reads the source name, so nothing was
     * hidden — but a list that reshuffles between identical searches is one you
     * cannot point at, and the concurrency that caused it was not a reason to
     * accept it.
     */
    out.sort((a, b) => a.sourceName.localeCompare(b.sourceName) || a.title.localeCompare(b.title));
    return out.slice(0, limit);
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
