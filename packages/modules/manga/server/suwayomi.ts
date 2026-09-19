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
import { SourceError, type SourceAdapter, type SourceChapter, type SourceHealth, type SourceMatch } from './sources.js';

/** Suwayomi's own default. Overridable, because nothing says it has to be here. */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:4567';

type Json = Record<string, any>;

export class SuwayomiAdapter implements SourceAdapter {
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
   * One request per source, which is why `limit` bounds the *sources* asked as
   * well as the rows returned — an install with thirty extensions would
   * otherwise make thirty upstream requests for one keystroke's worth of query.
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
    for (const source of sources.slice(0, 8)) {
      if (out.length >= limit) break;
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
         * constantly — a site changes its markup and that one extension throws —
         * and a search that returns nothing because the fourth of eight sources
         * is broken is indistinguishable from a series not existing.
         */
      }
    }

    return out.slice(0, limit);
  }

  async chapters(mangaId: string): Promise<SourceChapter[]> {
    const id = Number.parseInt(mangaId, 10);
    if (!Number.isSafeInteger(id)) throw new SourceError('not a Suwayomi manga id');

    /*
     * `fetchChapters: true` makes the server go and ask the source rather than
     * answering from its own database. That is the whole point here — a cached
     * answer is exactly the stale number this layer exists to replace — and it is
     * why this is a mutation and why it is slower than a plain read.
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
 * Suwayomi sends timestamps as `LongString` — epoch milliseconds as *text*,
 * because GraphQL's `Int` is 32-bit and a millisecond timestamp does not fit.
 * Parsing it as a number is therefore required rather than defensive.
 */
export function uploadedAtMs(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const n = Number.parseInt(raw.trim(), 10);
  // Zero is Suwayomi's "no date", not 1970.
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
