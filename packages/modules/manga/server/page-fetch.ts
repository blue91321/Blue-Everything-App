/**
 * One page image from Suwayomi, asked for again when it does not come.
 *
 * Most failed pages are not slow, they are refused: MangaFire's image server
 * now and then answers with a Cloudflare challenge, Suwayomi has no bypass
 * configured, and it gives up in well under a second ("Cloudflare bypass
 * currently disabled" — 52 of the 74 page failures in one evening's log). The
 * challenge comes and goes, which is why tapping "try again" two or three
 * times worked. So the asking again happens here, with a pause between, before
 * anybody has to tap anything.
 *
 * The timeout is per attempt and longer than it was (45s against 30s), for the
 * few that genuinely are slow: a long strip from a busy CDN.
 *
 * Retried: no answer, a 5xx, and a body that is not a whole picture. Not
 * retried: a 4xx, which is Suwayomi saying the request itself is wrong.
 *
 * **A slow failure is retried once, not twice.** Three tries suit a refusal,
 * which fails in under a second and often works on the next go. A timeout is
 * a different animal: page 11 of a Thunder Scans chapter failed inside
 * Suwayomi after 30 to 50 seconds on every attempt while the same image came
 * straight from the site in 0.4s, so three tries kept the reader on a bare
 * page number for 2 minutes 20 seconds before it could even offer to try
 * again. A failure that took `SLOW_FAILURE_MS` or more counts as slow; after
 * two of those this gives up with a 504 and says why, about 90 seconds in.
 */
import { isWholeImage } from '../web/image-bytes.js';

export const PAGE_TIMEOUT_MS = 45_000;
/** Pauses before the second and third attempts. */
export const PAGE_RETRY_PAUSES_MS = [1_500, 4_000];
/** A failure that took this long is the site being slow, not a refusal. */
export const SLOW_FAILURE_MS = 20_000;
/** How many slow failures end it. */
export const SLOW_FAILURES_ALLOWED = 2;

export class PageFetchError extends Error {
  constructor(
    message: string,
    readonly status: number | null
  ) {
    super(message);
  }
}

export async function fetchPage(
  url: string,
  { now = Date.now, get = fetch }: { now?: () => number; get?: typeof fetch } = {}
): Promise<{ body: Buffer; type: string }> {
  let last = new PageFetchError('could not fetch the page', null);
  let slow = 0;
  for (let attempt = 0; attempt <= PAGE_RETRY_PAUSES_MS.length; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, PAGE_RETRY_PAUSES_MS[attempt - 1]));
    const began = now();
    const failedSlowly = () => {
      if (now() - began < SLOW_FAILURE_MS) return false;
      slow += 1;
      return slow >= SLOW_FAILURES_ALLOWED;
    };
    try {
      const response = await get(url, { signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
      if (!response.ok) {
        last = new PageFetchError(`the source answered ${response.status}`, response.status);
        if (response.status < 500) throw last;
        if (failedSlowly()) break;
        continue;
      }
      const body = Buffer.from(await response.arrayBuffer());
      if (!isWholeImage(body.subarray(0, 32), body.subarray(Math.max(0, body.length - 1024)), body.length)) {
        last = new PageFetchError('the page arrived damaged', null);
        continue;
      }
      return { body, type: response.headers.get('content-type') ?? 'image/jpeg' };
    } catch (error) {
      if (error instanceof PageFetchError) throw error;
      last = new PageFetchError('could not fetch the page', null);
      if (failedSlowly()) break;
    }
  }
  if (slow >= SLOW_FAILURES_ALLOWED) {
    throw new PageFetchError('the site is too slow sending this page: it timed out twice', 504);
  }
  throw last;
}
