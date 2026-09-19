/**
 * MangaDex, used as a catalogue rather than as a source.
 *
 * Nothing here fetches a chapter. This asks two questions — *what is this
 * series* and *what is it called everywhere else* — and both are answered by the
 * search endpoint in one request, because the manga record carries the other
 * services' ids in its `links` object. See `identity.ts` for why that matters.
 *
 * ### Their requirements are not optional, and they are enforced
 *
 * MangaDex tightened against scraping in March–April 2026. What that means here:
 *
 *   - **a real User-Agent**, which their docs say explicitly must not be
 *     spoofed. This one names the app and nothing else;
 *   - **no `Via` header**, so nothing may sit in front of this as a
 *     non-transparent proxy;
 *   - **~5 requests a second** per IP, globally. This package makes one request
 *     per search and none otherwise, so it is nowhere near — but a caller that
 *     looped over a library here would be, and there is deliberately no helper
 *     that would make that easy to write;
 *   - **covers must be proxied, not hotlinked.** The URL built here is handed to
 *     the server's own route, never to an `<img src>` in the browser.
 *
 * The 10-chapters-a-day cap that arrived with that enforcement applies to
 * reading chapters as a guest, which this package never does. If a later slice
 * reads chapters, it needs a personal API client and this comment stops being
 * the whole story.
 */
import { idsFromMangaDex, seriesStatus, type SeriesIds, type SeriesStatus } from './identity.js';

const BASE = 'https://api.mangadex.org';
const COVERS = 'https://uploads.mangadex.org/covers';

/** Named so a person reading MangaDex's logs can tell what we are. Never spoofed. */
const USER_AGENT = 'blue-everything/0.3 (personal self-hosted reading list)';

export class MangaDexError extends Error {}

export type Candidate = SeriesIds & {
  title: string;
  /** The romanised or original title, when it differs from the one shown. */
  subtitle: string | null;
  status: SeriesStatus;
  year: number | null;
  coverUrl: string | null;
  /**
   * Where the browser should fetch that cover from.
   *
   * Built here rather than assembled in the PWA, so the browser never takes a
   * URL apart to guess at a route — the same reason the server hands over a
   * redirect URI instead of letting the screen compose one.
   */
  coverPath: string | null;
  /**
   * Can this series be watched for new chapters at all?
   *
   * False when MangaDex knows no MangaUpdates id for it — which happens for
   * doujin, one-shots and anything obscure. Surfaced rather than swallowed: a
   * series silently never producing a nudge is indistinguishable from the
   * feature being broken, and the screen should say so when you add it.
   */
  trackable: boolean;
};

/** An empty string is MangaDex's way of saying it does not know. */
function text(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/**
 * Which of a dozen spellings to show.
 *
 * `title` is usually only `ja-ro` — the romanised Japanese — and the English
 * name is off in `altTitles`. Showing "Sousou no Frieren" when the person typed
 * "frieren" is technically the record's title and not what anybody wants, so
 * English wins if it exists anywhere, and the original is kept as a subtitle
 * rather than thrown away.
 */
function pickTitles(attributes: Record<string, any>): { title: string; subtitle: string | null } {
  const title = (attributes.title ?? {}) as Record<string, string>;
  const alts = (attributes.altTitles ?? []) as Record<string, string>[];

  const english = text(title.en) ?? text(alts.find((t) => t.en)?.en);
  const original = text(title['ja-ro']) ?? text(title.ja) ?? text(Object.values(title)[0]);

  if (english && original && english !== original) return { title: english, subtitle: original };
  return { title: english ?? original ?? 'Untitled', subtitle: null };
}

function coverUrl(mangaId: string, relationships: any[]): string | null {
  const art = relationships?.find((r) => r?.type === 'cover_art');
  const fileName = text(art?.attributes?.fileName);
  // 256px is the thumbnail size they publish; the full one is a print-resolution
  // scan and this is a list of small pictures.
  return fileName ? `${COVERS}/${mangaId}/${fileName}.256.jpg` : null;
}

/** The proxy route for a candidate's cover, which has no library id yet. */
function coverPath(mangaId: string, relationships: any[]): string | null {
  const art = relationships?.find((r) => r?.type === 'cover_art');
  const fileName = text(art?.attributes?.fileName);
  return fileName ? `/api/manga/cover/mangadex/${mangaId}/${encodeURIComponent(fileName)}.256.jpg` : null;
}

async function get(path: string): Promise<any> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new MangaDexError(
      error instanceof Error && error.name === 'TimeoutError' ? 'MangaDex did not answer in time' : 'could not reach MangaDex'
    );
  }

  if (response.status === 429) throw new MangaDexError('MangaDex is rate limiting us — try again in a minute');
  if (!response.ok) throw new MangaDexError(`MangaDex answered ${response.status}`);
  return response.json();
}

/** Series matching what was typed, best match first, as MangaDex orders them. */
export async function search(query: string, limit = 10): Promise<Candidate[]> {
  const params = new URLSearchParams({ title: query, limit: String(Math.min(limit, 25)) });
  params.append('includes[]', 'cover_art');
  // Without this MangaDex returns only safe-rated entries for some queries and
  // silently omits others, which reads as a series not existing.
  for (const rating of ['safe', 'suggestive', 'erotica']) params.append('contentRating[]', rating);

  const body = await get(`/manga?${params.toString()}`);
  const data = Array.isArray(body?.data) ? body.data : [];

  return data.map((m: any): Candidate => {
    const ids = idsFromMangaDex(m.id, m.attributes?.links);
    const { title, subtitle } = pickTitles(m.attributes ?? {});
    return {
      ...ids,
      title,
      subtitle,
      status: seriesStatus(m.attributes?.status),
      year: typeof m.attributes?.year === 'number' ? m.attributes.year : null,
      coverUrl: coverUrl(m.id, m.relationships ?? []),
      coverPath: coverPath(m.id, m.relationships ?? []),
      trackable: ids.muId !== null,
    };
  });
}

/** The cover bytes, fetched here because the browser may not hotlink them. */
export async function fetchCover(url: string): Promise<{ body: ArrayBuffer; contentType: string }> {
  if (!url.startsWith(`${COVERS}/`)) throw new MangaDexError('not a MangaDex cover');
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new MangaDexError(`cover answered ${response.status}`);
  return {
    body: await response.arrayBuffer(),
    contentType: response.headers.get('content-type') ?? 'image/jpeg',
  };
}
