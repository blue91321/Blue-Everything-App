/**
 * Reading: a chapter list, its pages, what you have read and where you are.
 *
 * Registered by `routes` in `../index.ts`, in this order with the other groups.
 */
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { db, nudges, changes, config, isGuest } from '@everything/server/module-api';
import { chapterValue } from '../identity.js';
import { applyReadMark, placeIsAtEnd } from '../read-marks.js';
import { isWholeImage } from '../../web/image-bytes.js';
import { PageFetchError, sharedPage } from '../page-fetch.js';
import { compressCached, qualityFrom } from '../compress.js';
import { read, write, readPositions, writePosition, type ReadingPosition, type Store } from '../library.js';
import { SourceError, effectiveUrl } from '../sources.js';
import { DEFAULT_BASE_URL } from '../suwayomi.js';
import { suwayomiProcess } from '../process.js';
import {
  cachedPage,
  cachedPageList,
  chapterIsComplete,
  fillChapter,
  keepPage,
  readAheadAt,
  rememberChapter,
} from '../page-cache.js';
import { archivedPage, archivedPageList } from '../archive.js';
import { happenedAt, hostFetch, hostJson, hostKept, mangaIdFor, reader } from './shared.js';

export function readingRoutes(app: FastifyInstance): void {
  /* ---- reading ---- */

  /**
   * The chapter list, from the source's own cache.
   *
   * `?refresh=1` goes and asks the site again. Off by default because opening a
   * list should not scrape a website — that is seconds of latency and a request
   * to somebody else's server for a screen you may only be glancing at.
   */
  /**
   * What the source says about a series you follow or have read: its
   * description, who made it and its genres, for the chapter list's head — the
   * same facts the series' page shows before you follow it. Suwayomi's stored
   * copy first, the site only when that has no description. A detail, so a
   * failure answers with nothing rather than an error over the chapter list.
   */
  app.get('/api/manga/:id/about', async (request, reply) => {
    const { id } = request.params as { id: string };
    const ctx = await reader(id);
    if ('error' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    try {
      const d = await ctx.adapter.details(ctx.series.source!.mangaId, { stored: true });
      return { description: d.description, author: d.author, artist: d.artist, genres: d.genres, url: d.url };
    } catch {
      return { description: null, author: null, artist: null, genres: [], url: null };
    }
  });

  app.get('/api/manga/:id/chapters', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { refresh } = request.query as { refresh?: string };
    const ctx = await reader(id);
    if ('error' in ctx) return reply.code(ctx.code).send({ error: ctx.error });

    try {
      let chapters: Awaited<ReturnType<typeof ctx.adapter.chapters>>;
      try {
        chapters = await ctx.adapter.chapters(ctx.series.source!.mangaId, refresh === '1');
      } catch (error) {
        /*
         * Recorded on the series, so the library can show it and the "source
         * not answering" filter can find it. Only the sweep wrote this before,
         * which it does half-hourly and only for a dozen series at a time — a
         * source that had died read as fine until then.
         */
        if (error instanceof SourceError) {
          const store = read();
          const row = store.series.find((s) => s.id === id);
          if (row) {
            row.error = error.message;
            write(store);
          }
        }
        throw error;
      }
      /*
       * The bookkeeping below is a *followed* series' — clearing the failure
       * flag the library grid shows, and taking a baseline so the sweep has
       * something to compare against. A glimpse has neither: nothing watches it
       * for new chapters and nothing draws it in the grid, so there is nothing
       * to record and `followed` is undefined.
       */
      const followed = 'muId' in ctx.series ? ctx.series : undefined;

      /*
       * Only an answer from the site clears it. Without `refresh` the list is
       * Suwayomi's saved copy, which answers whether or not the site would:
       * opening a MangaHub series while MangaHub shut apps out cleared its
       * failure, and with it the warning and the two-day count on its page.
       */
      if (followed && followed.error !== null && refresh === '1') {
        const store = read();
        const row = store.series.find((s) => s.id === id);
        if (row && row.error !== null) {
          row.error = null;
          write(store);
        }
      }
      /*
       * A series never checked on its source takes its baseline from the list
       * you just opened, rather than showing nothing (or another site's number)
       * until the next sweep. Only when nothing is recorded: a baseline is the
       * sweep's silent first reading, and doing it here raises nothing either.
       */
      if (followed && followed.latestChapter === null && followed.sourceChapter === null) {
        const numbers = chapters.map((c) => c.number).filter((n) => Number.isFinite(n));
        if (numbers.length > 0) {
          const store = read();
          const row = store.series.find((s) => s.id === id);
          if (row && row.latestChapter === null && row.sourceChapter === null) {
            const newest = Math.max(...numbers);
            const now = Date.now();
            row.sourceChapter = newest;
            row.latestChapter = String(newest);
            row.sourceCheckedAt = now;
            row.checkedAt = now;
            write(store);
          }
        }
      }
      const read_ = new Set(ctx.series.readChapters);
      const readOn = new Map(ctx.series.readLog.map((r) => [r.chapter, r.source]));
      return {
        seriesTitle: ctx.series.title,
        sourceName: ctx.series.source!.sourceName,
        mangaId: ctx.series.source!.mangaId,
        position: readPositions()[id] ?? null,
        chapters: chapters
          // Newest first, which is how every reader in this space lists them and
          // how anybody following a running series wants to see it.
          .sort((a, b) => b.number - a.number)
          .map((c) => ({ ...c, read: read_.has(c.number), readOn: readOn.get(c.number) ?? null })),
      };
    } catch (error) {
      if (error instanceof SourceError) return reply.code(502).send({ error: error.message });
      throw error;
    }
  });

  /**
   * One chapter's pages, as URLs this app will serve.
   *
   * The source's own paths are **never handed to the browser**. They point at
   * Suwayomi, which has no authentication and is not what the PWA is talking to
   * — and over Tailscale the phone cannot reach it at all. So each one becomes a
   * proxied URL, and the path travels as an opaque parameter this server checks.
   */

  const readingAhead = new Set<string>();

  /**
   * Fetch the next few chapters while you read this one.
   *
   * The cache fills *behind* you — a chapter is kept once opened — so going
   * back was instant and going forward was not, which is the direction people
   * read in. `Store.readAheadChapters` says how many, 0 to 3, one by default.
   *
   * Four things about this are deliberate, and three of them are about not
   * taking something away to provide it:
   *
   *   - **it never starts Suwayomi.** `reader()` would, which is right for a
   *     chapter you asked for and wrong for a guess about one you have not:
   *     on-demand mode exists so a JVM is not resident for something used in
   *     bursts, and waking it to speculate would quietly undo that. So this
   *     asks whether it is already up — the same question the release sweep
   *     asks — and does nothing if not;
   *   - **it runs after the current chapter is filled, and one chapter at a
   *     time.** The reader's own page requests are what must be fast; a
   *     prefetch racing them for the same source would make the chapter you are
   *     reading slower to serve the one you are not;
   *   - **"next" is by chapter number, not list position**, the same rule the
   *     reader's arrows follow, so a source listing two editions of chapter 50
   *     does not spend the whole budget on the second copy of where you are;
   *   - **anything already archived or already complete is skipped**, so
   *     re-reading a series you have saved costs nothing at all.
   *
   * Failures are silent by design. Nothing asked for this, nobody is waiting on
   * it, and a chapter that did not prefetch is simply a chapter that loads the
   * way it always did.
   */
  async function readAhead(seriesId: string, chapterId: string, openedAt: number): Promise<void> {
    const store = read();
    const ahead = store.readAheadChapters;
    if (ahead <= 0 || readingAhead.has(seriesId)) return;

    // Already running is the only state worth speculating in — see above.
    if (store.manageSuwayomi && suwayomiProcess.state.state !== 'running') return;

    readingAhead.add(seriesId);
    try {
      const ctx = await reader(seriesId);
      if ('error' in ctx) return;

      const list = await ctx.adapter.chapters(ctx.series.source!.mangaId, false);
      const here = list.find((c) => c.id === chapterId);
      if (!here) return;
      const mangaId = ctx.series.source!.mangaId;
      // Kept on the host for a guest copy: its chapters are already on the PC.
      const keptHere = isGuest && (await hostKept()).has(mangaId);

      /*
       * Distinct numbers above this one, nearest first. Distinct because a
       * source listing two editions of chapter 51 should cost one slot, not
       * two — and the first of them is the one the reader's own Next lands on.
       */
      const seen = new Set<number>();
      const next: typeof list = [];
      for (const c of [...list].sort((a, b) => a.number - b.number)) {
        if (c.number <= here.number || seen.has(c.number)) continue;
        seen.add(c.number);
        next.push(c);
        if (next.length >= ahead) break;
      }

      for (const [i, chapter] of next.entries()) {
        if (keptHere || archivedPageList(seriesId, chapter.id, mangaId) || chapterIsComplete(seriesId, chapter.id)) continue;
        const pages = cachedPageList(seriesId, chapter.id) ?? (await ctx.adapter.pages(chapter.id));
        if (pages.length === 0) continue;
        /*
         * Behind the chapter being read, and behind each other in the order
         * they would be opened — so the cache evicts the furthest guess first
         * and never the chapter in your hands. See `rememberChapter`.
         *
         * **Measured from when the chapter was opened, not from now.** The
         * first version used `Date.now()` here, which is evaluated at prefetch
         * time — by then the current chapter had been filling for twenty
         * seconds, so "a millisecond behind it" was ten seconds in front, and
         * the cache ordered itself exactly backwards: no.4, no.3, then the
         * chapter actually being read. Caught by the test written for it.
         */
        if (rememberChapter(seriesId, chapter.id, pages, readAheadAt(openedAt, i))) {
          await fillChapter(ctx.url, seriesId, chapter.id);
        }
      }
    } catch {
      // Nobody is waiting on this; the next chapter simply loads as before.
    } finally {
      readingAhead.delete(seriesId);
    }
  }

  app.get('/api/manga/:id/chapters/:chapterId/pages', async (request, reply) => {
    const { id, chapterId } = request.params as { id: string; chapterId: string };
    const asUrls = (pages: string[]) => ({
      pages: pages.map((path) => `/api/manga/${id}/page?p=${encodeURIComponent(path)}`),
      /*
       * How many chapters to fetch ahead (`Store.readAheadChapters`), so the
       * reader follows the same setting on the device: at more than 0 it also
       * fetches the next chapter onto the device while this one is read — see
       * `holdNext` in `manga-api.ts`.
       */
      readAhead: read().readAheadChapters,
    });

    /*
     * The archive first, because it is the copy meant to outlast the source
     * — and unlike the cache it is never evicted, so a hit here is a hit for
     * good. Nothing is fetched and Suwayomi is not needed.
     */
    const mangaId = mangaIdFor(read(), id);
    if (isGuest) {
      // Kept on the host's disk, which every copy reads.
      if (mangaId && (await hostKept()).has(mangaId)) {
        const got = await hostJson<{ pages: string[] }>(
          `/api/manga/host/archive/pages?manga=${encodeURIComponent(mangaId)}&chapter=${encodeURIComponent(chapterId)}`
        );
        if (!('error' in got)) return asUrls(got.pages);
      }
    } else {
      const archived = archivedPageList(id, chapterId, mangaId);
      if (archived) return asUrls(archived);
    }

    // One of the last ten opened: from disk, with no Suwayomi needed — see `page-cache.ts`.
    const kept = cachedPageList(id, chapterId);
    if (kept) {
      const store = read();
      const url = effectiveUrl(store, DEFAULT_BASE_URL);
      // Moved to the front; any page still missing is fetched if Suwayomi happens to be up.
      const openedAt = Date.now();
      if (rememberChapter(id, chapterId, kept, openedAt) && url) {
        void fillChapter(url, id, chapterId).then(() => readAhead(id, chapterId, openedAt));
      } else void readAhead(id, chapterId, openedAt);
      return asUrls(kept);
    }

    const ctx = await reader(id);
    if ('error' in ctx) return reply.code(ctx.code).send({ error: ctx.error });

    try {
      const pages = await ctx.adapter.pages(chapterId);
      // After this chapter is on disk, never beside it — see `readAhead`.
      const openedAt = Date.now();
      if (pages.length > 0 && rememberChapter(id, chapterId, pages, openedAt)) {
        void fillChapter(ctx.url, id, chapterId).then(() => readAhead(id, chapterId, openedAt));
      } else void readAhead(id, chapterId, openedAt);
      return asUrls(pages);
    } catch (error) {
      if (error instanceof SourceError) return reply.code(502).send({ error: error.message });
      throw error;
    }
  });

  /**
   * One page image.
   *
   * Behind `/api/` like the covers and the habit pictures, because what you are
   * reading is as personal as anything else here — so the PWA fetches the bytes
   * with the token and wraps them in an object URL rather than using `img src`.
   *
   * The path is checked against the exact shape Suwayomi publishes rather than
   * trusted. It arrived from us a moment ago, but it travels through the browser
   * to get here, so it is caller input by the time it is read — and an
   * unchecked one would make this an open proxy to anything the server can
   * reach, which is the same rule the game launcher and the cover route follow.
   */
  app.get('/api/manga/:id/page', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { p, fresh, q } = request.query as { p?: string; fresh?: string; q?: string };
    if (!p || !/^\/api\/v1\/manga\/\d+\/chapter\/\d+\/page\/\d+$/.test(p)) {
      return reply.code(400).send({ error: 'not a page' });
    }
    /*
     * `fresh=1` is "tap to try again": the copy that would not draw may be one
     * of these two, so both are passed over and the source asked. The answer
     * replaces the cached copy, through `keepPage`, if it is a whole picture.
     */
    const skipKept = fresh === '1';
    /*
     * `q=smaller` or `q=smallest`: a smaller copy for a weak connection or a
     * device that keeps less (`compress.ts`). Made from whichever copy is found
     * below, never kept in place of it: the cache and the archive hold what
     * they hold, and this is only what is sent.
     */
    const level = qualityFrom(q);
    const send = async (body: Buffer, type: string) => {
      const out = await compressCached(p!, { body, type }, level);
      return (
        reply
          .header('content-type', out.type)
          .header('cache-control', 'private, max-age=604800')
          // How long this took before a byte was sent, so the reader can tell
          // a slow connection from a slow site — see `quality.ts`.
          .header('x-made-in', String(Math.round(reply.elapsedTime)))
          .send(out.body)
      );
    };

    // Kept for good, and preferred over everything: see the chapter route above.
    // Either kept copy is used only while it is still a whole picture — one
    // damaged on disk falls through to the source rather than being served.
    const whole = (b: Buffer) => isWholeImage(b.subarray(0, 32), b.subarray(Math.max(0, b.length - 1024)), b.length);
    const mangaId = mangaIdFor(read(), id);
    let saved = skipKept ? undefined : isGuest ? undefined : archivedPage(id, p, mangaId);
    if (!skipKept && isGuest && mangaId && (await hostKept()).has(mangaId)) {
      const response = await hostFetch(`/api/manga/host/archive/page?manga=${encodeURIComponent(mangaId)}&p=${encodeURIComponent(p)}`);
      if (!('error' in response) && response.ok) {
        saved = { body: Buffer.from(await response.arrayBuffer()), type: response.headers.get('content-type') ?? 'image/jpeg' };
      }
    }
    if (saved && whole(saved.body)) return send(saved.body, saved.type);

    const kept = skipKept ? undefined : cachedPage(id, p);
    if (kept && whole(kept.body)) return send(kept.body, kept.type);

    const ctx = await reader(id);
    if ('error' in ctx) return reply.code(ctx.code).send({ error: ctx.error });

    try {
      // Asked again on a refusal before giving up, and shared with anyone else
      // asking for this page now — see `page-fetch.ts`. Not for "try again".
      const { body, type } = await sharedPage(`${ctx.url}${p}`, { share: !skipKept });
      // Kept if its chapter is one of the last ten; ignored otherwise.
      keepPage(id, p, body, type);
      // A page never changes once it exists, and a reader fetches it again on
      // every revisit — so this is the one image here worth caching hard.
      return send(body, type);
    } catch (error) {
      // 504 when it timed out twice, so the reader knows waiting again will not help.
      const code = error instanceof PageFetchError && error.status === 504 ? 504 : 502;
      return reply.code(code).send({ error: error instanceof Error ? error.message : 'could not fetch the page' });
    }
  });

  /**
   * Mark a chapter read, or not.
   *
   * Stored as a chapter *number* rather than the source's id, so relinking a
   * series to a different source keeps your place. Written when a chapter is
   * finished rather than on every page turn — see `readChapters`.
   */
  app.put('/api/manga/:id/read', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { chapter?: unknown; read?: unknown; at?: unknown } | null;
    const chapter = typeof body?.chapter === 'number' && Number.isFinite(body.chapter) ? body.chapter : null;
    if (chapter === null) return reply.code(400).send({ error: 'which chapter?' });
    const at = happenedAt(body?.at);

    const store = read();
    // A glimpse too — the fields below are the ones it shares with a series.
    const series = store.series.find((s) => s.id === id) ?? store.glimpses.find((g) => g.id === id);
    if (!series) return reply.code(404).send({ error: 'no such series' });

    const read_ = body?.read !== false;
    applyReadMark(series, chapter, read_, at);
    write(store);
    if (read_) await settleAfterRead(store, id, chapter, at);

    return { readChapters: series.readChapters };
  });

  /**
   * What finishing a chapter settles besides the mark itself.
   *
   * Finishing the chapter you were partway through, or a later one, clears the
   * place: "continue" would otherwise point back into something done. Unless
   * that place is newer than the read — a chapter finished offline on Tuesday
   * does not clear a place you left in the next one on Wednesday.
   *
   * And it answers the nudge about it. With a task, ticking the task off did
   * this through `freshenForDelivery`; with tasks switched off this is the only
   * route, so a chapter read on the phone mid-match is not announced at the
   * next stopping point. Only a nudge still waiting — `expired` is what
   * happened to it, the state freshening uses too.
   */
  async function settleAfterRead(store: Store, id: string, chapter: number, at: number): Promise<void> {
    const place = readPositions()[id];
    if (place && place.chapter <= chapter && place.at <= at) {
      writePosition(id, null);
      // Finishing a later chapter from the end of an earlier one: that one was
      // read too, and this place was the last record of it — see `placeIsAtEnd`.
      if (place.chapter < chapter && placeIsAtEnd(place)) {
        const row = store.series.find((s) => s.id === id) ?? store.glimpses.find((g) => g.id === id);
        if (row && applyReadMark(row, place.chapter, true, place.at)) write(store);
      }
    }

    const waiting = store.links
      .filter((l) => l.seriesId === id && l.nudgeId && chapterValue(l.chapter) !== null && chapterValue(l.chapter)! <= chapter)
      .map((l) => l.nudgeId!);
    if (waiting.length > 0) {
      await db
        .update(nudges)
        .set({ state: 'expired' })
        .where(and(inArray(nudges.id, waiting), eq(nudges.state, 'pending')));
    }
  }

  /**
   * A device's reading log, or the recent part of it again.
   *
   * Every read is written down on the device before anything is sent (see
   * `reading-log.ts`), and this is where that log arrives — the first time,
   * and then again for the last few weeks whenever the Manga screen opens, so a
   * read that never made it here, or was lost after it did, is put back. Which
   * is only safe because `applyReadMark` makes a repeated claim harmless and an
   * older one powerless against a newer.
   *
   * **Quiet unless something changed.** A re-send nearly always changes
   * nothing, and announcing it anyway would reload every open screen on every
   * device each time the Manga tab opened.
   *
   * One read of the store and one write, done without an `await` between —
   * the sweep's lesson about holding a store across anything slow.
   */
  app.post('/api/manga/journal', { config: { announce: false } }, async (request, reply) => {
    const body = request.body as { entries?: unknown } | null;
    if (!Array.isArray(body?.entries) || body.entries.length > 5000) {
      return reply.code(400).send({ error: 'that is not a reading log' });
    }
    const now = Date.now();
    const store = read();
    const unknown = new Set<string>();
    const settle: { id: string; chapter: number; at: number }[] = [];
    let changed = 0;
    for (const raw of body.entries as unknown[]) {
      const e = raw as { seriesId?: unknown; chapter?: unknown; read?: unknown; at?: unknown } | null;
      if (
        typeof e?.seriesId !== 'string' ||
        typeof e.chapter !== 'number' || !Number.isFinite(e.chapter) ||
        typeof e.read !== 'boolean' ||
        typeof e.at !== 'number' || !Number.isFinite(e.at)
      ) {
        continue;
      }
      /*
       * Not clamped to "now" when old, unlike `happenedAt`: a re-sent claim
       * stamped with the time it *arrived* would beat every genuine claim made
       * since, which is the opposite of the point. Too old is simply ignored —
       * the device only re-sends a month — and the future is refused outright.
       */
      if (e.at > now + 60_000 || e.at < now - 45 * 24 * 60 * 60_000) continue;
      const row = store.series.find((s) => s.id === e.seriesId) ?? store.glimpses.find((g) => g.id === e.seriesId);
      if (!row) {
        unknown.add(e.seriesId);
        continue;
      }
      if (applyReadMark(row, e.chapter, e.read, e.at)) {
        changed += 1;
        if (e.read) settle.push({ id: row.id, chapter: e.chapter, at: e.at });
      }
    }
    if (changed > 0) {
      write(store);
      for (const s of settle) await settleAfterRead(store, s.id, s.chapter, s.at);
      changes.emitChange('all');
    }
    return { changed, unknown: [...unknown] };
  });

  /**
   * Where you are in a chapter, saved as you read.
   *
   * **Quiet**: `announce: false` keeps this out of the change stream, because
   * the reader saves every few seconds while you scroll and each announcement
   * reloads every open screen, the phone's included. It announces itself only
   * when you have moved to a different chapter — the one change another device
   * shows, in its "Continue" button — so a place saved on the PC is waiting on
   * the phone without the phone reloading all the way through.
   *
   * The source is taken from the series, not the caller, for the reason read
   * marks are: the reader only serves the linked source.
   */
  /**
   * Forget where you were in this series.
   *
   * The other half of taking something out of History: a series you are partway
   * through appears there as `reading`, and that entry is the saved place
   * rather than a read record, so `read: false` cannot reach it.
   *
   * Not local-only. What you have read is your data, editable from the phone
   * like the rest of it — the same call the habit pictures make.
   */
  app.delete('/api/manga/:id/position', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!read().series.some((s) => s.id === id)) return reply.code(404).send({ error: 'no such series' });
    writePosition(id, null);
    return { ok: true };
  });

  app.put('/api/manga/:id/position', { config: { announce: false } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Partial<Record<keyof ReadingPosition, unknown>> | null;
    const pages = Number.isInteger(body?.pages) ? (body!.pages as number) : null;
    const page = Number.isInteger(body?.page) ? (body!.page as number) : null;
    const offset = typeof body?.offset === 'number' && Number.isFinite(body.offset) ? body.offset : null;
    const chapter = typeof body?.chapter === 'number' && Number.isFinite(body.chapter) ? body.chapter : null;
    if (
      pages === null || pages < 1 || pages > 5000 ||
      page === null || page < 0 || page >= pages ||
      offset === null || chapter === null ||
      typeof body?.chapterId !== 'string' || !/^\d{1,20}$/.test(body.chapterId)
    ) {
      return reply.code(400).send({ error: 'that is not a place in a chapter' });
    }

    /*
     * A followed series or something you only glanced at — see `Glimpse`. Both
     * carry an `id` and a `source` and this route touches nothing else, which
     * is why the two can share it rather than there being a second copy of the
     * same validation under another name.
     */
    const here = read();
    const series = here.series.find((s) => s.id === id) ?? here.glimpses.find((g) => g.id === id);
    if (!series) return reply.code(404).send({ error: 'no such series' });
    if (!series.source) return reply.code(400).send({ error: 'this series is not linked to a source' });

    const position: ReadingPosition = {
      chapter,
      chapterId: body.chapterId,
      chapterName: typeof body.chapterName === 'string' ? body.chapterName.slice(0, 200) : `Chapter ${chapter}`,
      source: series.source.sourceName,
      mangaId: series.source.mangaId,
      page,
      offset: Math.min(1, Math.max(0, offset)),
      pages,
      at: happenedAt(body.at),
    };
    // Newest wins: a place queued offline and sent later must not undo one
    // made since, on this device or another.
    const current = readPositions()[id];
    if (current && current.at > position.at) return { position: current, kept: 'newer' };
    /*
     * And a place older than finishing that chapter, or a later one, is not a
     * place any more. Leaving the end of a chapter sends both — the last place
     * and the read — at the same instant, and if the place lands second it
     * would sit in a chapter you have finished, with Continue pointing back
     * into it. The read clearing the place only works if the place cannot come
     * back afterwards.
     */
    if (series.readLog.some((r) => r.chapter >= position.chapter && r.at >= position.at)) {
      return { position: null, kept: 'finished' };
    }
    const before = writePosition(id, position);
    /*
     * Opening a later chapter replaces the place in the earlier one, and if
     * that place was at its end, the earlier chapter was finished without the
     * read ever arriving. Recorded now, at the time the place was saved, rather
     * than lost with it — see `placeIsAtEnd`. One store read, no await before
     * this write.
     */
    if (before && before.chapter < position.chapter && placeIsAtEnd(before)) {
      if (applyReadMark(series, before.chapter, true, before.at)) {
        write(here);
        changes.emitChange('all');
      }
    }
    if (!before || before.chapter !== position.chapter || before.mangaId !== position.mangaId) {
      changes.emitChange('all');
    }
    return { position };
  });

  /**
   * Your verdict on a source that claimed to be ahead, or `null` to take it back.
   *
   * Not local-only: it is a judgement about your reading, like marking a chapter
   * read, and the phone is where you are when you notice a source is right.
   * One verdict per source per series — a new one replaces the old.
   */
  app.put('/api/manga/:id/review', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { key?: unknown; upTo?: unknown; verdict?: unknown } | null;
    const key = typeof body?.key === 'string' && body.key.length > 0 && body.key.length <= 300 ? body.key : null;
    if (key === null) return reply.code(400).send({ error: 'which source?' });
    const verdict = body?.verdict === 'real' || body?.verdict === 'fake' ? body.verdict : null;
    if (verdict === null && body?.verdict !== null) {
      return reply.code(400).send({ error: 'a verdict is real, fake, or null to clear it' });
    }
    const upTo = typeof body?.upTo === 'number' && Number.isFinite(body.upTo) ? body.upTo : null;
    if (verdict !== null && upTo === null) return reply.code(400).send({ error: 'up to which chapter?' });

    const store = read();
    const series = store.series.find((s) => s.id === id);
    if (!series) return reply.code(404).send({ error: 'no such series' });

    series.reviews = series.reviews.filter((r) => r.key !== key);
    if (verdict !== null && upTo !== null) series.reviews.push({ key, upTo, verdict, at: Date.now() });
    write(store);

    return { reviews: series.reviews };
  });
}
