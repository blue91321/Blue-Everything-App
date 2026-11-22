/**
 * Reading a linked server's Local collection: its page lists and pages, asked
 * of that server with the key it gave this one (`peerFetch` in the server's
 * `peers.ts`). Used by the routes that show it here and by the worker that
 * copies a series from it (`ArchiveTools.peer`).
 *
 * **A page is a whole picture or it is refused** (`isWholeImage`), the rule
 * every page cache here follows: a cut-off page kept would be a gap served for
 * ever, and a linked server's answer is data, not trusted to be right.
 */
import { peerById, peerFetch } from '@everything/server/module-api';
import { isWholeImage } from '../web/image-bytes.js';
import type { PeerCopyOf } from './archive.js';

export const LINK_ID = /^[0-9a-f]{8}$/;
export const SUWAYOMI_ID = /^\d{1,25}$/;
export const PAGE_PATH = /^\/api\/v1\/manga\/\d+\/chapter\/\d+\/page\/\d+$/;

/** A page as big as a long webtoon strip gets, and no more. */
const PAGE_MAX_BYTES = 40 * 1024 * 1024;

export class PeerError extends Error {
  constructor(
    message: string,
    readonly status = 502
  ) {
    super(message);
  }
}

const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

/** A kept chapter's page paths on a linked server. */
export async function peerPages(linkId: string, mangaId: string, chapterId: string, purpose: 'read' | 'copy' = 'read'): Promise<string[]> {
  const link = peerById(linkId);
  if (!link) throw new PeerError('that server is no longer linked', 404);
  const got = await peerFetch(link, `/api/peer/manga/collection/pages?${q({ manga: mangaId, chapter: chapterId, purpose })}`, { timeoutMs: 20_000 });
  if (!got.ok) throw new PeerError(`${link.name}'s server: ${got.error}`, got.status === 404 ? 404 : 502);
  let pages: unknown;
  try {
    pages = (JSON.parse(got.body.toString('utf8')) as { pages?: unknown }).pages;
  } catch {
    throw new PeerError(`${link.name}'s server sent a page list that would not read`);
  }
  if (!Array.isArray(pages)) throw new PeerError(`${link.name}'s server sent no page list`);
  return pages.filter((p): p is string => typeof p === 'string' && PAGE_PATH.test(p)).slice(0, 2000);
}

/** One page from a linked server, checked whole. */
export async function peerPage(
  linkId: string,
  mangaId: string,
  chapterId: string,
  path: string,
  purpose: 'read' | 'copy' = 'read'
): Promise<{ body: Buffer; type: string }> {
  const link = peerById(linkId);
  if (!link) throw new PeerError('that server is no longer linked', 404);
  if (!PAGE_PATH.test(path)) throw new PeerError('not a page', 400);
  const got = await peerFetch(link, `/api/peer/manga/collection/page?${q({ manga: mangaId, chapter: chapterId, p: path, purpose })}`, {
    maxBytes: PAGE_MAX_BYTES,
    timeoutMs: 60_000,
  });
  if (!got.ok) throw new PeerError(`${link.name}'s server: ${got.error}`, got.status === 404 ? 404 : 502);
  const type = got.type.split(';')[0]!.trim().toLowerCase();
  const body = got.body;
  if (!type.startsWith('image/') || !isWholeImage(body.subarray(0, 32), body.subarray(Math.max(0, body.length - 1024)), body.length)) {
    throw new PeerError(`${link.name}'s server sent a page that is not a whole picture`);
  }
  return { body, type };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * The worker's way to a linked server (`ArchiveTools.peer`): a page at a time,
 * a quarter of a second apart, which keeps a copy well under the 300 a minute a
 * linked server's key is allowed and leaves room for reading beside it.
 */
export const peerCopyTools = {
  pages: (of: PeerCopyOf, chapterId: string) => peerPages(of.id, of.mangaId, chapterId, 'copy'),
  page: async (of: PeerCopyOf, chapterId: string, path: string) => {
    await sleep(250);
    return peerPage(of.id, of.mangaId, chapterId, path, 'copy');
  },
};
