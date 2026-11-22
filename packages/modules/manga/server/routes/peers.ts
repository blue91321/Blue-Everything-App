/**
 * Manga between linked servers (2026-11-21): another person's own Blue
 * Everything, linked on purpose over Tailscale (`peers.ts` in the server holds
 * the link, the keys and the switches).
 *
 * **What a linked server may read here** (`/api/peer/manga/…`), each route
 * checked against what this side chose to share with that server
 * (`sharesWith`), read-only:
 *
 * - the Local collection: the series kept, their whole chapters, their pages,
 *   and a cover while Suwayomi is already up (never woken for it);
 * - the chapter catalogue's counts, by source id and name (`catalogueForPeer`);
 * - ratings, by MangaUpdates id and name, only if chosen.
 *
 * Not the library, what is being read, history, or anything of a friend's copy
 * on this PC. A series copied here from another linked server is not offered
 * on, since it is theirs to share.
 *
 * **What this side reads of theirs** (`/api/manga/peers/…`): their collection
 * in Browse, its chapters in the reader (through this server, which checks
 * every page is a whole picture), and **Copy to my Local collection**, which
 * queues it with the archive worker, fetched from their server a page at a
 * time (`startPeerCopy`, `peerCopyTools`). Copies are read back from
 * `/api/manga/copies/…`, from this disk, linked or not.
 *
 * "Copying" being refused by a server that shares reading is a courtesy its
 * server keeps (`purpose=copy`), not a wall: pages read can be kept by a server
 * that wanted to. The screen says so.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { changes, freshPeer, isGuest, linkedPeers, peerById, peerFetch, peerJson, sharesWith } from '@everything/server/module-api';
import { read } from '../library.js';
import { archivedPage, archivedPageList, copiedChapters, keptChapters, keptSeries, peerCopies, peerCopyId, startPeerCopy } from '../archive.js';
import { catalogueForPeer } from '../catalogue.js';
import { nameKeys } from '../names.js';
import { effectiveUrl } from '../sources.js';
import { DEFAULT_BASE_URL } from '../suwayomi.js';
import { suwayomiProcess } from '../process.js';
import { LINK_ID, PAGE_PATH, PeerError, peerPage, peerPages, SUWAYOMI_ID } from '../peer-reading.js';
import { workArchive } from './shared.js';

const refuse = (reply: FastifyReply, code: number, error: string) => reply.code(code).send({ error });

/** Yours: this PC or one of your devices, on the host. Linked servers are the host's, not a friend's copy's. */
const owner = (request: FastifyRequest) => !isGuest && (request.isLocal || (request.deviceId !== null && request.deviceKind !== 'instance' && request.deviceKind !== 'peer'));

/** Covers fetched from linked servers, kept a while in memory: a grid of them is asked for on every visit. */
const covers = new Map<string, { at: number; body: Buffer; type: string }>();
const COVER_MS = 60 * 60_000;
const COVERS_KEPT = 300;

export function peerMangaRoutes(app: FastifyInstance): void {
  /* ================================================================ what a linked server may read */

  app.get('/api/peer/manga/collection', async (request, reply) => {
    if (!sharesWith(request, 'collection')) return refuse(reply, 403, 'this server does not share its Local collection with yours');
    const peer = sharesWith(request, 'collection')!;
    return {
      copy: peer.share.copy,
      // Who each was kept for is between the people on this PC, and stays here.
      series: keptSeries().map((k) => ({ mangaId: k.mangaId, title: k.title, sourceName: k.sourceName, complete: k.complete })),
    };
  });

  app.get('/api/peer/manga/collection/chapters', async (request, reply) => {
    if (!sharesWith(request, 'collection')) return refuse(reply, 403, 'this server does not share its Local collection with yours');
    const { manga } = request.query as { manga?: string };
    if (!manga || !SUWAYOMI_ID.test(manga)) return refuse(reply, 400, 'which series?');
    const chapters = keptChapters(manga);
    if (!chapters) return refuse(reply, 404, 'not in the Local collection');
    const kept = keptSeries().find((k) => k.mangaId === manga);
    return { title: kept?.title ?? '', sourceName: kept?.sourceName ?? '', chapters };
  });

  /** `purpose=copy`: refused when this side shares reading but not copying. See the head of this file. */
  const allowed = (request: FastifyRequest) => {
    const peer = sharesWith(request, 'collection');
    if (!peer) return 'this server does not share its Local collection with yours';
    if ((request.query as { purpose?: string }).purpose === 'copy' && !peer.share.copy) return 'this server shares its Local collection to read, not to copy';
    return null;
  };

  app.get('/api/peer/manga/collection/pages', async (request, reply) => {
    const no = allowed(request);
    if (no) return refuse(reply, 403, no);
    const { manga, chapter } = request.query as { manga?: string; chapter?: string };
    if (!manga || !SUWAYOMI_ID.test(manga) || !chapter || !SUWAYOMI_ID.test(chapter)) return refuse(reply, 400, 'which chapter?');
    const pages = archivedPageList('', chapter, manga);
    if (!pages) return refuse(reply, 404, 'not kept');
    return { pages };
  });

  app.get('/api/peer/manga/collection/page', async (request, reply) => {
    const no = allowed(request);
    if (no) return refuse(reply, 403, no);
    const { manga, chapter, p } = request.query as { manga?: string; chapter?: string; p?: string };
    if (!manga || !SUWAYOMI_ID.test(manga) || !chapter || !SUWAYOMI_ID.test(chapter) || !p || !PAGE_PATH.test(p)) return refuse(reply, 400, 'not a page');
    const saved = archivedPage('', p, manga, chapter);
    if (!saved) return refuse(reply, 404, 'not kept');
    return reply.header('content-type', saved.type).send(saved.body);
  });

  /** A kept series' cover, only while Suwayomi is already answering: a linked server's grid never wakes it. */
  app.get('/api/peer/manga/collection/cover', async (request, reply) => {
    if (!sharesWith(request, 'collection')) return refuse(reply, 403, 'this server does not share its Local collection with yours');
    const { manga } = request.query as { manga?: string };
    if (!manga || !SUWAYOMI_ID.test(manga) || !keptSeries().some((k) => k.mangaId === manga)) return refuse(reply, 404, 'no such cover');
    const store = read();
    const url = effectiveUrl(store, DEFAULT_BASE_URL);
    if (!url || (store.manageSuwayomi && suwayomiProcess.state.state !== 'running')) return refuse(reply, 404, 'no cover just now');
    try {
      const response = await fetch(`${url}/api/v1/manga/${manga}/thumbnail`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return refuse(reply, 404, 'no cover');
      return reply.header('content-type', response.headers.get('content-type') ?? 'image/jpeg').send(Buffer.from(await response.arrayBuffer()));
    } catch {
      return refuse(reply, 404, 'no cover');
    }
  });

  app.get('/api/peer/manga/catalogue', async (request, reply) => {
    if (!sharesWith(request, 'catalogue')) return refuse(reply, 403, 'this server does not share its chapter catalogue with yours');
    return catalogueForPeer();
  });

  /** Ratings by MangaUpdates id and every name a series goes by, since Suwayomi's ids are this install's own. */
  app.get('/api/peer/manga/ratings', async (request, reply) => {
    if (!sharesWith(request, 'ratings')) return refuse(reply, 403, 'this server does not share ratings with yours');
    const ratings = read()
      .series.filter((s) => s.rating !== undefined)
      .map((s) => ({
        keys: [...nameKeys([s.title, s.source?.title, ...(s.altTitles ?? [])].filter((x): x is string => !!x))].slice(0, 10),
        muId: s.muId,
        rating: s.rating!,
      }));
    return { ratings };
  });

  /* ================================================================ reading theirs */

  /** The linked servers that share a Local collection with this one, for Browse. */
  app.get('/api/manga/peers', async (request, reply) => {
    if (!owner(request)) return isGuest ? { peers: [] } : refuse(reply, 403, 'only your own devices');
    const out = [];
    for (const link of linkedPeers()) {
      const fresh = (await freshPeer(link.id)) ?? link;
      out.push({ id: fresh.id, name: fresh.name, collection: fresh.theirs?.share.collection ?? false, copy: fresh.theirs?.share.copy ?? false, problem: fresh.problem });
    }
    return { peers: out };
  });

  const linkParam = (request: FastifyRequest, reply: FastifyReply) => {
    const { peer } = request.params as { peer: string };
    if (!owner(request)) return void refuse(reply, 403, 'only your own devices');
    if (!LINK_ID.test(peer)) return void refuse(reply, 400, 'which linked server?');
    const link = peerById(peer);
    if (!link) return void refuse(reply, 404, 'that server is no longer linked');
    return link;
  };

  const failed = (reply: FastifyReply, error: unknown) =>
    error instanceof PeerError ? refuse(reply, error.status, error.message) : refuse(reply, 502, error instanceof Error ? error.message : String(error));

  app.get('/api/manga/peers/:peer/collection', async (request, reply) => {
    const link = linkParam(request, reply);
    if (!link) return reply;
    const got = await peerJson<{ copy?: unknown; series?: unknown }>(link, '/api/peer/manga/collection', { timeoutMs: 20_000 });
    if ('error' in got) return refuse(reply, got.status === 403 ? 403 : 502, `${link.name}'s server: ${got.error}`);
    const copied = new Set(peerCopies().map((c) => c.seriesId));
    const series = (Array.isArray(got.series) ? got.series : [])
      .map((x) => x as { mangaId?: unknown; title?: unknown; sourceName?: unknown; complete?: unknown })
      .filter((x) => typeof x.mangaId === 'string' && SUWAYOMI_ID.test(x.mangaId) && typeof x.title === 'string')
      .slice(0, 20_000)
      .map((x) => ({
        mangaId: x.mangaId as string,
        title: (x.title as string).slice(0, 300),
        sourceName: typeof x.sourceName === 'string' ? x.sourceName.slice(0, 80) : '',
        complete: typeof x.complete === 'number' ? x.complete : 0,
        copied: copied.has(peerCopyId(link.id, x.mangaId as string)),
      }));
    return { name: link.name, copy: got.copy === true, series };
  });

  app.get('/api/manga/peers/:peer/series/:manga', async (request, reply) => {
    const link = linkParam(request, reply);
    if (!link) return reply;
    const { manga } = request.params as { manga: string };
    if (!SUWAYOMI_ID.test(manga)) return refuse(reply, 400, 'which series?');
    const got = await peerJson<{ title?: unknown; sourceName?: unknown; chapters?: unknown }>(
      link,
      `/api/peer/manga/collection/chapters?manga=${manga}`,
      { timeoutMs: 20_000 }
    );
    if ('error' in got) return refuse(reply, got.status === 404 ? 404 : 502, `${link.name}'s server: ${got.error}`);
    const chapters = (Array.isArray(got.chapters) ? got.chapters : [])
      .map((c) => c as { chapterId?: unknown; number?: unknown; name?: unknown; pages?: unknown })
      .filter((c) => typeof c.chapterId === 'string' && SUWAYOMI_ID.test(c.chapterId) && typeof c.number === 'number' && Number.isFinite(c.number))
      .slice(0, 10_000)
      .map((c) => ({
        id: c.chapterId as string,
        number: c.number as number,
        name: typeof c.name === 'string' ? c.name.slice(0, 200) : `Chapter ${c.number}`,
        pages: typeof c.pages === 'number' ? c.pages : 0,
      }))
      .sort((a, b) => a.number - b.number);
    const copied = copiedChapters(peerCopyId(link.id, manga));
    return {
      peer: { id: link.id, name: link.name, copy: link.theirs?.share.copy ?? false },
      title: typeof got.title === 'string' ? got.title.slice(0, 300) : '',
      sourceName: typeof got.sourceName === 'string' ? got.sourceName.slice(0, 80) : '',
      chapters,
      copy: copied ? { chapters: copied.length, complete: copied.filter((c) => c.done).length } : null,
    };
  });

  app.get('/api/manga/peers/:peer/series/:manga/chapters/:chapter/pages', async (request, reply) => {
    const link = linkParam(request, reply);
    if (!link) return reply;
    const { manga, chapter } = request.params as { manga: string; chapter: string };
    if (!SUWAYOMI_ID.test(manga) || !SUWAYOMI_ID.test(chapter)) return refuse(reply, 400, 'which chapter?');
    try {
      const paths = await peerPages(link.id, manga, chapter);
      const at = (p: string) => `/api/manga/peers/${link.id}/page?${new URLSearchParams({ m: manga, c: chapter, p })}`;
      return { pages: paths.map(at) };
    } catch (error) {
      return failed(reply, error);
    }
  });

  app.get('/api/manga/peers/:peer/page', async (request, reply) => {
    const link = linkParam(request, reply);
    if (!link) return reply;
    const { m, c, p } = request.query as { m?: string; c?: string; p?: string };
    if (!m || !SUWAYOMI_ID.test(m) || !c || !SUWAYOMI_ID.test(c) || !p || !PAGE_PATH.test(p)) return refuse(reply, 400, 'not a page');
    try {
      const page = await peerPage(link.id, m, c, p);
      return reply.header('content-type', page.type).header('cache-control', 'private, max-age=86400').send(page.body);
    } catch (error) {
      return failed(reply, error);
    }
  });

  app.get('/api/manga/peers/:peer/cover', async (request, reply) => {
    const link = linkParam(request, reply);
    if (!link) return reply;
    const { manga } = request.query as { manga?: string };
    if (!manga || !SUWAYOMI_ID.test(manga)) return refuse(reply, 400, 'which cover?');
    const key = `${link.id}:${manga}`;
    const had = covers.get(key);
    if (had && Date.now() - had.at < COVER_MS) return reply.header('content-type', had.type).header('cache-control', 'private, max-age=3600').send(had.body);
    const got = await peerFetch(link, `/api/peer/manga/collection/cover?manga=${manga}`, { maxBytes: 4 * 1024 * 1024, timeoutMs: 15_000 });
    if (!got.ok || !got.type.startsWith('image/')) return refuse(reply, 404, 'no cover just now');
    if (covers.size >= COVERS_KEPT) covers.delete(covers.keys().next().value!);
    covers.set(key, { at: Date.now(), body: got.body, type: got.type });
    return reply.header('content-type', got.type).header('cache-control', 'private, max-age=3600').send(got.body);
  });

  /**
   * Copy a series of theirs into this Local collection, or catch an earlier
   * copy up with what they kept since. Only when they share copying.
   */
  app.post('/api/manga/peers/:peer/series/:manga/copy', async (request, reply) => {
    const link = linkParam(request, reply);
    if (!link) return reply;
    const { manga } = request.params as { manga: string };
    if (!SUWAYOMI_ID.test(manga)) return refuse(reply, 400, 'which series?');
    const fresh = (await freshPeer(link.id)) ?? link;
    if (!fresh.theirs?.share.copy) return refuse(reply, 403, `${fresh.name} shares their Local collection to read, not to copy`);
    const got = await peerJson<{ title?: unknown; sourceName?: unknown; chapters?: unknown }>(fresh, `/api/peer/manga/collection/chapters?manga=${manga}`, {
      timeoutMs: 20_000,
    });
    if ('error' in got) return refuse(reply, 502, `${fresh.name}'s server: ${got.error}`);
    const chapters = (Array.isArray(got.chapters) ? got.chapters : [])
      .map((c) => c as { chapterId?: unknown; number?: unknown; name?: unknown })
      .filter((c) => typeof c.chapterId === 'string' && SUWAYOMI_ID.test(c.chapterId) && typeof c.number === 'number' && Number.isFinite(c.number))
      .map((c) => ({ id: c.chapterId as string, number: c.number as number, name: typeof c.name === 'string' ? c.name.slice(0, 200) : '' }));
    const title = typeof got.title === 'string' && got.title.trim() ? got.title.slice(0, 300) : 'Untitled';
    const added = startPeerCopy(
      { id: fresh.id, name: fresh.name, mangaId: manga, sourceName: typeof got.sourceName === 'string' ? got.sourceName.slice(0, 80) : '' },
      title,
      chapters
    );
    workArchive();
    changes.emitChange('all');
    return added;
  });

  /* ================================================================ copies, from this disk */

  app.get('/api/manga/copies', async (request, reply) => {
    if (!owner(request)) return isGuest ? { copies: [] } : refuse(reply, 403, 'only your own devices');
    const linked = new Set(linkedPeers().map((l) => l.id));
    return { copies: peerCopies().map((c) => ({ ...c, stillLinked: linked.has(c.of.id) })) };
  });

  app.get('/api/manga/copies/:series', async (request, reply) => {
    if (!owner(request)) return refuse(reply, 403, 'only your own devices');
    const { series } = request.params as { series: string };
    const chapters = copiedChapters(series);
    if (!chapters) return refuse(reply, 404, 'no such copy');
    const copy = peerCopies().find((c) => c.seriesId === series)!;
    return {
      title: copy.title,
      of: copy.of,
      chapters: chapters.filter((c) => c.done).map((c) => ({ id: c.chapterId, number: c.number, name: c.name, pages: c.pages })),
      waiting: chapters.filter((c) => !c.done).length,
    };
  });

  app.get('/api/manga/copies/:series/chapters/:chapter/pages', async (request, reply) => {
    if (!owner(request)) return refuse(reply, 403, 'only your own devices');
    const { series, chapter } = request.params as { series: string; chapter: string };
    if (!copiedChapters(series) || !SUWAYOMI_ID.test(chapter)) return refuse(reply, 404, 'no such copy');
    const pages = archivedPageList(series, chapter);
    if (!pages) return refuse(reply, 404, 'not copied yet');
    return { pages: pages.map((p) => `/api/manga/copies/page?${new URLSearchParams({ s: series, c: chapter, p })}`) };
  });

  app.get('/api/manga/copies/page', async (request, reply) => {
    if (!owner(request)) return refuse(reply, 403, 'only your own devices');
    const { s, c, p } = request.query as { s?: string; c?: string; p?: string };
    if (!s || !copiedChapters(s) || !c || !SUWAYOMI_ID.test(c) || !p || !PAGE_PATH.test(p)) return refuse(reply, 400, 'not a page');
    const saved = archivedPage(s, p, null, c);
    if (!saved) return refuse(reply, 404, 'not copied');
    return reply.header('content-type', saved.type).send(saved.body);
  });
}
