/**
 * MangaUpdates, asked one question per series: what is the newest chapter?
 *
 * ### Why this and not the daily release feed
 *
 * `/v1/releases/days` looks like the right endpoint and is not. It returns every
 * release the site knows about — about nine thousand a day — and **each record
 * carries only a title string, no series id**. Joining that to a library means
 * matching titles across nine thousand rows a day, which is precisely the fuzzy
 * matching the MangaDex ids exist to make unnecessary, with a wrong match
 * raising a nudge about somebody else's manga.
 *
 * `GET /v1/series/{id}` is keyed exactly and answers directly: `latest_chapter`
 * as a number, and `completed` as a boolean. Verified live — series 27728982867
 * returns *VINLAND SAGA*, `latest_chapter: 220`, `completed: true`.
 *
 * ### One request per series, and most series stop asking
 *
 * The cost is therefore proportional to the library rather than to the world,
 * and it falls further because a finished work never gains a chapter — see
 * `worthPolling`. On a real reading list most rows are finished, so the rotation
 * is a fraction of the library and shrinks as series end.
 *
 * ### Their acceptable-use policy asks for two things and both are honoured
 *
 * Reads need no account, which is unusually generous, and in exchange the policy
 * asks for **reasonable spacing between requests** and **caching**. There is no
 * published rate limit, which is a reason to be conservative rather than a
 * licence. So the poller takes a slice of the library per tick with a pause
 * between each request, and never a burst. It also asks that MangaUpdates be
 * **credited**, which the screen does.
 */

const BASE = 'https://api.mangaupdates.com/v1';
const USER_AGENT = 'blue-everything/0.3 (personal self-hosted reading list)';

/** Their policy asks for spacing, so requests within a sweep are separated by this. */
export const SPACING_MS = 1_200;

export class MangaUpdatesError extends Error {}

export type SeriesReading = {
  /** As they spell it. A number in their JSON, kept as text for display. */
  latestChapter: string | null;
  /** Their own judgement that the original run has ended. */
  completed: boolean;
  title: string | null;
};

export async function readSeries(muId: number): Promise<SeriesReading> {
  let response: Response;
  try {
    response = await fetch(`${BASE}/series/${muId}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new MangaUpdatesError(
      error instanceof Error && error.name === 'TimeoutError'
        ? 'MangaUpdates did not answer in time'
        : 'could not reach MangaUpdates'
    );
  }

  // A series can be merged or removed upstream. Said plainly, because the fix is
  // to re-add it rather than to wait.
  if (response.status === 404) throw new MangaUpdatesError('MangaUpdates no longer has this series');
  if (response.status === 429) throw new MangaUpdatesError('MangaUpdates is rate limiting us');
  if (!response.ok) throw new MangaUpdatesError(`MangaUpdates answered ${response.status}`);

  const body = (await response.json()) as Record<string, unknown>;
  const latest = body.latest_chapter;

  return {
    latestChapter:
      typeof latest === 'number' && Number.isFinite(latest)
        ? String(latest)
        : typeof latest === 'string' && latest.trim()
          ? latest.trim()
          : null,
    completed: body.completed === true,
    title: typeof body.title === 'string' ? body.title : null,
  };
}

export const CREDIT = 'Release dates from MangaUpdates.';
