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
 */
import { isWholeImage } from '../web/image-bytes.js';

export const PAGE_TIMEOUT_MS = 45_000;
/** Pauses before the second and third attempts. */
export const PAGE_RETRY_PAUSES_MS = [1_500, 4_000];

export class PageFetchError extends Error {
  constructor(
    message: string,
    readonly status: number | null
  ) {
    super(message);
  }
}

export async function fetchPage(url: string): Promise<{ body: Buffer; type: string }> {
  let last = new PageFetchError('could not fetch the page', null);
  for (let attempt = 0; attempt <= PAGE_RETRY_PAUSES_MS.length; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, PAGE_RETRY_PAUSES_MS[attempt - 1]));
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
      if (!response.ok) {
        last = new PageFetchError(`the source answered ${response.status}`, response.status);
        if (response.status < 500) throw last;
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
    }
  }
  throw last;
}
