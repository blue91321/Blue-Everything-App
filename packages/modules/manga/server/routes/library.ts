/**
 * The library: following, shelves, stars and ratings, the Local collection's rules, history and covers.
 *
 * Registered by `routes` in `../index.ts`, in this order with the other groups.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db, nudges, config, devices, isGuest, nameFor } from '@everything/server/module-api';
import { available as compressionAvailable, isQuality } from '../compress.js';
import { chapterValue } from '../identity.js';
import { search, fetchCover, MangaDexError } from '../mangadex.js';
import { CREDIT } from '../mangaupdates.js';
import {
  read,
  write,
  MAX_READ_AHEAD,
  clampShelfSort,
  newSeries,
  findExisting,
  readPositions,
  writePosition,
  cleanReleaseScope,
  inReleaseScope,
  type Series,
  isRating,
} from '../library.js';
import { seriesSummary, recentReleases, thumbPath } from '../present.js';
import { sweepReleases, pollable } from '../releases.js';
import { readableChapter } from '../sources.js';
import { findSourcesState, goneCount, startFindingSources, switchNow, unlinkedCount } from '../find-sources.js';
import { searchOldHistory } from '../old-history.js';
import { othersRatings, setShared } from '../shared-ratings.js';
import { keptMangaIds } from '../archive.js';
import { COVER_CACHE, askHost, autoKeep, hostJson, hostKept, mangaIdFor } from './shared.js';

/** A glimpse's cover as the screen can fetch it: Suwayomi's through the proxy, anything else as it is. */
function glimpseCover(url: string | null): string | null {
  if (!url) return null;
  return thumbPath(url) ?? (/^https?:\/\//.test(url) ? url : null);
}

export function libraryRoutes(app: FastifyInstance): void {
  app.get('/api/manga/old-history', async (request) => {
    const { q } = request.query as { q?: string };
    return searchOldHistory(typeof q === 'string' ? q.slice(0, 200) : '', read());
  });

  /**
   * Finding a source for every series without one — see `find-sources.ts`.
   * Not local-only: it is about your library, like linking one by hand.
   */
  /**
   * A new source for one series, now: the button on its page. Not local-only,
   * like linking one by hand. Takes as long as the searches do (about fifteen
   * seconds), and answers with what happened and the series as it now is.
   */
  app.post('/api/manga/:id/switch-source', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const outcome = await switchNow(id);
      const row = read().series.find((s) => s.id === id);
      return { outcome, series: row ? seriesSummary(row) : null };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : 'the sources could not be asked' });
    }
  });

  /** Switching sources after two days of failing, on or off. Not local-only: it is about your library. */
  app.put('/api/manga/auto-switch', async (request, reply) => {
    const body = request.body as { on?: unknown } | null;
    if (typeof body?.on !== 'boolean') return reply.code(400).send({ error: 'send on: true or false' });
    const store = read();
    store.autoSwitchSources = body.on;
    write(store);
    return { autoSwitchSources: store.autoSwitchSources };
  });

  app.get('/api/manga/find-sources', async () => ({ ...findSourcesState(), unlinked: unlinkedCount(), gone: goneCount() }));
  // `mode: 'gone'` switches every series its source has lost to another source that has it.
  app.post('/api/manga/find-sources', { config: { announce: false } }, async (request) => {
    const mode = (request.body as { mode?: unknown } | null)?.mode === 'gone' ? 'gone' : 'unlinked';
    return { ...startFindingSources(mode), unlinked: unlinkedCount(), gone: goneCount() };
  });

  /**
   * Sources left out of searching and browsing. Not local-only: it is
   * about what you read, like the language setting.
   */
  app.put('/api/manga/ignored-sources', async (request, reply) => {
    const body = request.body as { id?: unknown; name?: unknown; ignored?: unknown } | null;
    if (typeof body?.id !== 'string' || typeof body.ignored !== 'boolean') {
      return reply.code(400).send({ error: 'send id and ignored' });
    }
    const store = read();
    store.ignoredSources = store.ignoredSources.filter((s) => s.id !== body.id);
    if (body.ignored) {
      store.ignoredSources.push({ id: body.id, name: typeof body.name === 'string' ? body.name.slice(0, 80) : body.id });
    }
    write(store);
    return { ignoredSources: store.ignoredSources };
  });

  app.get('/api/manga/ignored-sources', async () => ({ ignoredSources: read().ignoredSources }));

  /** The library, already shaped for the screen. */
  app.get('/api/manga', async () => {
    const store = read();
    const positions = readPositions();
    // Kept on the PC, for the library's "On this PC" filter: the host's own
    // archive, or on a guest copy the host's, which every copy shares.
    const kept = isGuest ? await hostKept() : keptMangaIds();
    return {
      series: store.series.map((s) => {
        const place = positions[s.id] ?? null;
        const shown = readableChapter(s.sourceChapter, s.latestChapter).chapter;
        return {
          ...seriesSummary(s),
          position: place,
          kept: s.source !== null && kept.has(s.source.mangaId),
          /*
           * What the library grid draws and sorts by: the newest chapter as a
           * number (the red bar), the furthest you have finished (the NEW badge
           * is a chapter past it), when a chapter last landed and when you last
           * read — "updated" and "recently read" orders.
           */
          /*
           * An import's own newest chapter stands in only while there is no
           * source at all. Once linked, it is another site's numbering: Colorist
           * read to 61 on topmanhua showed 63 and NEW over a source that has 49.
           */
          latestNumber: chapterValue(shown) ?? (s.source ? null : chapterValue(s.origin?.latest ?? null)),
          readUpTo: s.readChapters.length > 0 ? Math.max(...s.readChapters) : null,
          lastReleaseAt: Math.max(0, ...store.links.filter((l) => l.seriesId === s.id).map((l) => l.raisedAt)) || null,
          lastReadAt: Math.max(0, place?.at ?? 0, ...s.readLog.map((r) => r.at)) || null,
        };
      }),
      /** What landed lately, for the panel — see `recentReleases`. */
      recent: recentReleases(store),
      /** MangaUpdates asks to be credited for release data. The screen does it. */
      credit: CREDIT,
      /** How many rows the sweep is still watching, so the screen can say so. */
      watching: pollable(store).length,
      /** Whether a new chapter also becomes a task — see `Store.releaseTasks`. */
      releaseTasks: store.releaseTasks,
      /** Whether a new chapter raises a nudge — see `Store.releaseNudges`. */
      releaseNudges: store.releaseNudges,
      /** Which series notify — see `Store.releaseNudgesFor`. */
      releaseNudgesFor: store.releaseNudgesFor,
      /** Whether a source failing for two days is switched — see `Store.autoSwitchSources`. */
      autoSwitchSources: store.autoSwitchSources,
      /** How many chapters are fetched ahead — see `Store.readAheadChapters`. */
      readAheadChapters: store.readAheadChapters,
      /** The cap, sent rather than written into the screen twice. */
      maxReadAhead: MAX_READ_AHEAD,
      /** What the Dashboard card lists, and in what order — see `Store.shelfShow`. */
      shelfShow: store.shelfShow,
      shelfSort: store.shelfSort,
      shelfNewFirst: store.shelfNewFirst,
      shelfFavFirst: store.shelfFavFirst,
      /**
       * The shelves, with how many series are on each.
       *
       * Counted here rather than in the browser because the browser is handed
       * a page of sixty tiles, not the whole library — a count taken there
       * would be a count of what happens to be on screen.
       *
       * They overlap: a series on two shelves is counted by both, so these do
       * not add up to the total. That is what many-to-many membership means
       * and the screen says so rather than letting the arithmetic look broken.
       */
      libraries: store.libraries.map((l) => ({
        ...l,
        hidden: l.hidden === true,
        count: store.series.filter((x) => x.libraries?.includes(l.id)).length,
      })),
    };
  });

  /**
   * What you have read, newest first: every chapter finished, where and when,
   * with the chapter you are partway through at the top of its series.
   *
   * The History tab. Built from what is already stored — the read log beside
   * each series and the saved places — so nothing new is written to have it,
   * and a chapter finished before sources were recorded is listed without one
   * rather than with a guess.
   */
  app.get('/api/manga/history', async () => {
    const store = read();
    const positions = readPositions();
    const entries: Array<{
      seriesId: string;
      title: string;
      coverPath: string | null;
      chapter: number;
      chapterName: string | null;
      source: string | null;
      at: number;
      kind: 'read' | 'reading';
      page: number | null;
      pages: number | null;
      /** Read without following it — see `Glimpse`. The row offers to follow it. */
      following: boolean;
      /**
       * The source's own id for it, on a not-following row only.
       *
       * Enough to rebuild a browse result and open the details card, which is
       * where Continue and Follow already are — so getting back to something
       * you dipped into needs no new screen.
       */
      sourceMangaId?: string;
    }> = [];
    for (const s of store.series) {
      const summary = seriesSummary(s);
      for (const r of s.readLog) {
        entries.push({
          seriesId: s.id,
          title: s.title,
          coverPath: summary.coverPath,
          chapter: r.chapter,
          chapterName: null,
          source: r.source,
          at: r.at,
          kind: 'read',
          page: null,
          pages: null,
          following: true,
        });
      }
      const place = positions[s.id];
      if (place) {
        entries.push({
          seriesId: s.id,
          title: s.title,
          coverPath: summary.coverPath,
          chapter: place.chapter,
          chapterName: place.chapterName,
          source: place.source,
          at: place.at,
          kind: 'reading',
          page: place.page,
          pages: place.pages,
          following: true,
        });
      }
    }

    /*
     * And the things read without following them.
     *
     * Same shape, same list, sorted together — history is when you read
     * something, not whether you decided to keep it. The only difference the
     * screen draws is a note and a Follow button, which is the one thing you
     * might want to do about a row like this.
     *
     * No cover route exists for these: nothing is stored for them, so the
     * source's own thumbnail is used, and the tile falls back to the title when
     * there is none, as an unlinked import does. That thumbnail is Suwayomi's
     * address (`/api/v1/manga/N/thumbnail`), which only Suwayomi answers, so it
     * goes through the thumbnail proxy as Browse's covers do (`glimpseCover`).
     * Handed over as it was, the History row asked this server for it and drew
     * no cover.
     */
    for (const g of store.glimpses) {
      for (const r of g.readLog) {
        entries.push({
          seriesId: g.id,
          title: g.title,
          coverPath: glimpseCover(g.coverUrl),
          chapter: r.chapter,
          chapterName: null,
          source: r.source,
          at: r.at,
          kind: 'read',
          page: null,
          pages: null,
          following: false,
          sourceMangaId: g.source.mangaId,
        });
      }
      const place = positions[g.id];
      if (place) {
        entries.push({
          seriesId: g.id,
          title: g.title,
          coverPath: glimpseCover(g.coverUrl),
          chapter: place.chapter,
          chapterName: place.chapterName,
          source: place.source,
          at: place.at,
          kind: 'reading',
          page: place.page,
          pages: place.pages,
          following: false,
          sourceMangaId: g.source.mangaId,
        });
      }
    }

    return { entries: entries.sort((a, b) => b.at - a.at).slice(0, 300) };
  });

  /**
   * Whether new chapters also become tasks.
   *
   * Not local-only: it decides what lands in your task list, which is yours to
   * change from the phone like the list itself. Affects releases from here on —
   * tasks already made stay, since removing them would delete things you may
   * have ticked or edited.
   */
  app.put('/api/manga/release-tasks', async (request, reply) => {
    const body = request.body as { on?: unknown } | null;
    if (typeof body?.on !== 'boolean') return reply.code(400).send({ error: 'send on: true or false' });
    const store = read();
    store.releaseTasks = body.on;
    write(store);
    return { releaseTasks: store.releaseTasks };
  });

  /**
   * New-chapter nudges on or off. Not local-only, like the task switch beside
   * it. Switching off also clears the ones still waiting: "I don't want these"
   * said while four sit on the Dashboard means those four as well.
   */
  app.put('/api/manga/release-nudges', async (request, reply) => {
    const body = request.body as { on?: unknown } | null;
    if (typeof body?.on !== 'boolean') return reply.code(400).send({ error: 'send on: true or false' });
    const store = read();
    store.releaseNudges = body.on;
    write(store);
    if (!body.on) {
      const waiting = store.links.map((l) => l.nudgeId).filter((id): id is string => typeof id === 'string');
      if (waiting.length > 0) {
        await db
          .update(nudges)
          .set({ state: 'expired' })
          .where(and(inArray(nudges.id, waiting), eq(nudges.state, 'pending')));
      }
    }
    return { releaseNudges: store.releaseNudges };
  });

  /**
   * Which series a new chapter notifies about: `{ favourites, shelves }`, or
   * null for every series. Like switching off, narrowing clears the waiting
   * ones it now leaves out, since those are the ones just said to be unwanted.
   */
  app.put('/api/manga/release-nudges/scope', async (request, reply) => {
    const body = request.body as { scope?: unknown } | null;
    if (!body || !('scope' in body)) return reply.code(400).send({ error: 'send scope: { favourites, shelves } or null' });
    const store = read();
    store.releaseNudgesFor = cleanReleaseScope(body.scope, store.libraries);
    write(store);
    const outside = new Set(store.series.filter((s) => !inReleaseScope(store.releaseNudgesFor, s)).map((s) => s.id));
    const waiting = store.links.filter((l) => outside.has(l.seriesId)).map((l) => l.nudgeId).filter((id): id is string => typeof id === 'string');
    if (waiting.length > 0) {
      await db.update(nudges).set({ state: 'expired' }).where(and(inArray(nudges.id, waiting), eq(nudges.state, 'pending')));
    }
    return { releaseNudgesFor: store.releaseNudgesFor };
  });

  /**
   * What the Dashboard card lists, and how it is ordered.
   *
   * One route for both, because they are two fields of one card and a screen
   * changing one nearly always wants to leave the other alone — which an
   * optional field says better than two endpoints would.
   */
  app.put('/api/manga/shelf', async (request, reply) => {
    const body = request.body as { show?: unknown; sort?: unknown; newFirst?: unknown; favFirst?: unknown } | null;
    const store = read();

    if (body?.show !== undefined) {
      if (body.show !== 'all' && body.show !== 'favourites') {
        return reply.code(400).send({ error: "show must be 'all' or 'favourites'" });
      }
      store.shelfShow = body.show;
    }
    if (body?.newFirst !== undefined) {
      if (typeof body.newFirst !== 'boolean') return reply.code(400).send({ error: 'newFirst must be true or false' });
      store.shelfNewFirst = body.newFirst;
    }
    if (body?.favFirst !== undefined) {
      if (typeof body.favFirst !== 'boolean') return reply.code(400).send({ error: 'favFirst must be true or false' });
      store.shelfFavFirst = body.favFirst;
    }
    if (body?.sort !== undefined) {
      // Checked rather than clamped here: a value the screen cannot have sent
      // is a mistake worth reporting, where a hand-edited file is not.
      if (clampShelfSort(body.sort) !== body.sort) {
        return reply.code(400).send({ error: 'that is not an order this card offers' });
      }
      store.shelfSort = body.sort as typeof store.shelfSort;
    }
    write(store);
    return {
      shelfShow: store.shelfShow,
      shelfSort: store.shelfSort,
      shelfNewFirst: store.shelfNewFirst,
      shelfFavFirst: store.shelfFavFirst,
    };
  });

  /**
   * Start keeping history for something you are reading but not following.
   *
   * Find-or-create on the source and its id for the series, so opening the same
   * thing again carries on the same record rather than starting a second.
   *
   * It is the *reader* that asks for this, when it is opened on something with
   * no series of its own — not Browse, and not opening a details page. Looking
   * at a cover is not reading it, and a history of everything you glanced at on
   * a browse page would be worth less than no history at all.
   */
  app.post('/api/manga/glimpse', async (request, reply) => {
    const body = request.body as {
      adapter?: unknown;
      mangaId?: unknown;
      sourceName?: unknown;
      title?: unknown;
      coverUrl?: unknown;
    } | null;
    const adapter = typeof body?.adapter === 'string' ? body.adapter : '';
    const mangaId = typeof body?.mangaId === 'string' ? body.mangaId : '';
    const title = typeof body?.title === 'string' ? body.title.trim().slice(0, 300) : '';
    if (!adapter || !mangaId || !title) return reply.code(400).send({ error: 'needs a source, an id and a title' });

    const store = read();

    /*
     * Already following it? Then that is the record, and this returns it. The
     * reader only asks when it has no series id of its own, but Browse can
     * reach a series you already follow by another route, and two records of
     * one thing is the failure this is meant to avoid.
     */
    const followed = store.series.find((x) => x.source?.adapter === adapter && x.source?.mangaId === mangaId);
    if (followed) return { id: followed.id, following: true };

    const had = store.glimpses.find((g) => g.source.adapter === adapter && g.source.mangaId === mangaId);
    if (had) return { id: had.id, following: false };

    const made = {
      id: randomUUID(),
      title,
      coverUrl: typeof body?.coverUrl === 'string' ? body.coverUrl : null,
      source: {
        adapter,
        mangaId,
        title,
        sourceName: typeof body?.sourceName === 'string' ? body.sourceName : adapter,
      },
      readChapters: [],
      readLog: [],
      addedAt: Date.now(),
    };
    store.glimpses.push(made);
    write(store);
    return { id: made.id, following: false };
  });

  /** Forget one entirely — the row, its read log and its place. */
  app.delete('/api/manga/glimpse/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const store = read();
    if (!store.glimpses.some((g) => g.id === id)) return reply.code(404).send({ error: 'nothing to forget' });
    store.glimpses = store.glimpses.filter((g) => g.id !== id);
    write(store);
    writePosition(id, null);
    return { ok: true };
  });

  /**
   * Make a shelf.
   *
   * The name is the whole of it. Nothing else is stored, because a library here
   * is a label on a set of series rather than a thing with settings of its own —
   * the moment one gains a sort or a filter it stops being a shelf and starts
   * being a saved search, which is a different feature with different rules.
   */
  app.post('/api/manga/libraries', async (request, reply) => {
    const body = request.body as { name?: unknown } | null;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) return reply.code(400).send({ error: 'give it a name' });
    if (name.length > 60) return reply.code(400).send({ error: 'that name is too long' });

    const store = read();
    // Case-insensitively, since two shelves called "Reading" and "reading" are
    // a mistake rather than a plan, and the picker would show them identically.
    if (store.libraries.some((l) => l.name.toLowerCase() === name.toLowerCase())) {
      return reply.code(409).send({ error: 'you already have one called that' });
    }
    const made = { id: randomUUID(), name };
    store.libraries.push(made);
    write(store);
    return made;
  });

  /**
   * Rename one, or hide it from *Everything*.
   *
   * Both on one route and both optional, because they are two fields of one
   * shelf and a screen changing either nearly always wants the other left
   * alone — which an optional field says better than two endpoints would.
   */
  app.patch('/api/manga/libraries/:id', async (request, reply) => {
    const body = request.body as { name?: unknown; hidden?: unknown } | null;
    const { id } = request.params as { id: string };

    const store = read();
    const library = store.libraries.find((l) => l.id === id);
    if (!library) return reply.code(404).send({ error: 'no such library' });

    if (body?.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) return reply.code(400).send({ error: 'give it a name' });
      if (name.length > 60) return reply.code(400).send({ error: 'that name is too long' });
      if (store.libraries.some((l) => l.id !== id && l.name.toLowerCase() === name.toLowerCase())) {
        return reply.code(409).send({ error: 'you already have one called that' });
      }
      library.name = name;
    }

    if (body?.hidden !== undefined) {
      if (typeof body.hidden !== 'boolean') return reply.code(400).send({ error: 'hidden is true or false' });
      // Only `true` is stored, like every other optional flag in this file.
      if (body.hidden) library.hidden = true;
      else delete library.hidden;
    }

    write(store);
    return library;
  });

  /**
   * Remove a shelf. The series on it are untouched — only the label goes.
   *
   * Worth being explicit about, because "delete library" is the same words a
   * file manager uses for something that takes the contents with it. Nothing is
   * deleted here but a name and a set of memberships.
   */
  app.delete('/api/manga/libraries/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const store = read();
    if (!store.libraries.some((l) => l.id === id)) return reply.code(404).send({ error: 'no such library' });

    store.libraries = store.libraries.filter((l) => l.id !== id);
    let cleared = 0;
    for (const series of store.series) {
      if (!series.libraries?.includes(id)) continue;
      const left = series.libraries.filter((x) => x !== id);
      if (left.length > 0) series.libraries = left;
      else delete series.libraries;
      cleared += 1;
    }
    write(store);
    return { ok: true, seriesKept: cleared };
  });

  /**
   * Which shelves a series is on — the whole set, not one added or removed.
   *
   * A whole-list write, like the Dashboard's block order and the Habits screen's
   * reordering: the screen holds a set of checkboxes and sends what they say,
   * so there is no question of two half-applied changes crossing.
   */
  app.put('/api/manga/:id/libraries', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { libraries?: unknown } | null;
    if (!Array.isArray(body?.libraries) || body.libraries.some((l) => typeof l !== 'string')) {
      return reply.code(400).send({ error: 'send libraries: a list of ids' });
    }

    const store = read();
    const series = store.series.find((x) => x.id === id);
    if (!series) return reply.code(404).send({ error: 'no such series' });

    // Only ids that exist, and each once: an unknown id would sit there
    // forever, since nothing else ever prunes this list.
    const known = new Set(store.libraries.map((l) => l.id));
    const chosen = [...new Set(body.libraries as string[])].filter((l) => known.has(l));
    if (chosen.length > 0) series.libraries = chosen;
    else delete series.libraries;
    write(store);
    return { libraries: series.libraries ?? [] };
  });

  /**
   * Star a series, or take the star off.
   *
   * Not local-only, like the read log beside it: what you keep up with is your
   * data, editable from the phone like the rest of it.
   *
   * Only `true` is stored — see `Series.favourite`. Taking a star off deletes
   * the key rather than writing `false`, so the file does not slowly fill with
   * nine hundred denials.
   */
  app.put('/api/manga/:id/favourite', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { on?: unknown } | null;
    if (typeof body?.on !== 'boolean') return reply.code(400).send({ error: 'send on: true or false' });

    const store = read();
    const series = store.series.find((s) => s.id === id);
    if (!series) return reply.code(404).send({ error: 'no such series' });

    if (body.on) series.favourite = true;
    else delete series.favourite;
    write(store);
    // A new favourite may be one to keep on the PC.
    if (body.on) void autoKeep();
    return { favourite: series.favourite === true };
  });

  /**
   * Rate a series, 1 to 10, or take the rating off with null. Like the star:
   * only a rating is stored, and it is your data, editable from the phone.
   */
  /**
   * Which edge of a page this series keeps plain paper on (`Series.pageMargins`),
   * or null to forget it. Learned by the reader when **Move along one** is
   * pressed on a chapter whose margins say which pairing is which. Any of your
   * devices, like the star: it is about how you read.
   */
  app.put('/api/manga/:id/page-margins', async (request, reply) => {
    const { id } = request.params as { id: string };
    const side = (request.body as { side?: unknown } | null)?.side;
    if (side !== null && side !== 'inner' && side !== 'outer') return reply.code(400).send({ error: 'side is inner, outer or null' });
    const store = read();
    const series = store.series.find((s) => s.id === id) ?? store.glimpses.find((g) => g.id === id);
    if (!series) return reply.code(404).send({ error: 'no such series' });
    if (side) series.pageMargins = side;
    else delete series.pageMargins;
    write(store);
    return { pageMargins: series.pageMargins ?? null };
  });

  app.put('/api/manga/:id/rating', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { rating?: unknown } | null;
    if (body?.rating !== null && !isRating(body?.rating)) {
      return reply.code(400).send({ error: 'a rating is a whole number from 1 to 10, or null' });
    }
    const store = read();
    const series = store.series.find((s) => s.id === id);
    if (!series) return reply.code(404).send({ error: 'no such series' });
    if (body.rating === null) delete series.rating;
    else series.rating = body.rating;
    write(store);
    if (store.shareRatingsWithCopies) void publishRatings();
    void autoKeep();
    return { rating: series.rating ?? null };
  });

  /** What friends on this PC who share their ratings gave this series. */
  app.get('/api/manga/:id/ratings', async (request, reply) => {
    const { id } = request.params as { id: string };
    const mangaId = mangaIdFor(read(), id);
    if (!mangaId) return { others: [] };
    if (!isGuest) return { others: othersRatings(mangaId, 'you').map((o) => ({ ...o, who: nameFor(o.who, 'you') })) };
    const got = await hostJson<{ others: Array<{ who: string; rating: number }> }>(
      `/api/manga/host/ratings?manga=${encodeURIComponent(mangaId)}`
    );
    if ('error' in got) return reply.code(502).send({ error: got.error });
    return got;
  });

  /**
   * The Local collection's rules and rating sharing, as Manga → More shows them.
   * Not local-only: how your manga is kept and shared is yours, from any of your
   * devices.
   */
  app.get('/api/manga/collection-rules', async () => {
    const store = read();
    return {
      autoKeepFavourites: store.autoKeepFavourites,
      autoKeepMinRating: store.autoKeepMinRating,
      shareRatingsWithCopies: store.shareRatingsWithCopies,
      // The host's to set: a friend's copy keeps nothing of its own.
      ...(isGuest ? {} : { archiveQuality: store.archiveQuality, compressionAvailable: await compressionAvailable() }),
    };
  });

  app.put('/api/manga/collection-rules', async (request, reply) => {
    const body = (request.body ?? {}) as {
      autoKeepFavourites?: unknown;
      autoKeepMinRating?: unknown;
      shareRatingsWithCopies?: unknown;
      archiveQuality?: unknown;
    };
    const store = read();
    if (body.archiveQuality !== undefined) {
      if (isGuest) return reply.code(403).send({ error: 'The host decides how the Local collection keeps pictures.' });
      if (!isQuality(body.archiveQuality)) return reply.code(400).send({ error: 'archiveQuality is original, smaller or smallest' });
      store.archiveQuality = body.archiveQuality;
    }
    if (body.autoKeepFavourites !== undefined) {
      if (typeof body.autoKeepFavourites !== 'boolean') return reply.code(400).send({ error: 'autoKeepFavourites is true or false' });
      store.autoKeepFavourites = body.autoKeepFavourites;
    }
    if (body.autoKeepMinRating !== undefined) {
      if (body.autoKeepMinRating !== null && !isRating(body.autoKeepMinRating)) {
        return reply.code(400).send({ error: 'autoKeepMinRating is 1 to 10, or null' });
      }
      store.autoKeepMinRating = body.autoKeepMinRating;
    }
    const sharingWas = store.shareRatingsWithCopies;
    if (body.shareRatingsWithCopies !== undefined) {
      if (typeof body.shareRatingsWithCopies !== 'boolean') return reply.code(400).send({ error: 'shareRatingsWithCopies is true or false' });
      store.shareRatingsWithCopies = body.shareRatingsWithCopies;
    }
    write(store);
    // Turned on: hand them over. Turned off: take them back out.
    if (store.shareRatingsWithCopies !== sharingWas) void publishRatings();
    void autoKeep();
    return {
      autoKeepFavourites: store.autoKeepFavourites,
      autoKeepMinRating: store.autoKeepMinRating,
      shareRatingsWithCopies: store.shareRatingsWithCopies,
      ...(isGuest ? {} : { archiveQuality: store.archiveQuality, compressionAvailable: await compressionAvailable() }),
    };
  });

  /**
   * This copy's ratings, handed to the host's shared set, or taken out of it
   * when sharing is off. The whole set each time, so nothing can drift.
   */
  async function publishRatings(): Promise<void> {
    const store = read();
    const ratings: Record<string, { rating: number; title: string }> = {};
    if (store.shareRatingsWithCopies) {
      for (const s of store.series) {
        if (s.rating !== undefined && s.source) ratings[s.source.mangaId] = { rating: s.rating, title: s.title };
      }
    }
    if (isGuest) await askHost('/api/manga/host/ratings', { ratings });
    else setShared('you', ratings);
  }

  /** Copies hand over their shared ratings, and read everyone else's. */
  app.post('/api/manga/host/ratings', async (request, reply) => {
    if (isGuest) return reply.code(404).send({ error: 'only the host keeps shared ratings' });
    const from = request as unknown as { deviceKind: string | null; deviceId: string | null };
    if (from.deviceKind !== 'instance' || !from.deviceId) return reply.code(403).send({ error: 'only for copies on this PC' });
    const body = request.body as { ratings?: unknown } | null;
    if (!body?.ratings || typeof body.ratings !== 'object') return reply.code(400).send({ error: 'send ratings' });
    const ratings: Record<string, { rating: number; title: string }> = {};
    for (const [mangaId, value] of Object.entries(body.ratings as Record<string, unknown>)) {
      const v = value as { rating?: unknown; title?: unknown };
      if (/^\d{1,25}$/.test(mangaId) && isRating(v?.rating)) {
        ratings[mangaId] = { rating: v.rating, title: typeof v.title === 'string' ? v.title.slice(0, 300) : '' };
      }
    }
    const [device] = await db.select({ name: devices.name }).from(devices).where(eq(devices.id, from.deviceId));
    setShared((device?.name ?? 'a copy').replace(/^copy: /, ''), ratings);
    return { ok: true };
  });

  app.get('/api/manga/host/ratings', async (request, reply) => {
    if (isGuest) return reply.code(404).send({ error: 'only the host keeps shared ratings' });
    const from = request as unknown as { isLocal: boolean; deviceKind: string | null; deviceId: string | null };
    if (!from.isLocal && from.deviceKind !== 'instance') return reply.code(403).send({ error: 'only for copies on this PC' });
    const { manga } = request.query as { manga?: string };
    if (!manga || !/^\d{1,25}$/.test(manga)) return reply.code(400).send({ error: 'which series?' });
    const [device] = from.deviceId
      ? await db.select({ name: devices.name }).from(devices).where(eq(devices.id, from.deviceId))
      : [];
    const asking = (device?.name ?? '').replace(/^copy: /, '') || 'you';
    // By display name; the host's own reads as the host's name to a friend.
    const others = othersRatings(manga, asking).map((o) => ({ ...o, who: nameFor(o.who, asking) }));
    return { others };
  });

  /**
   * How many chapters to fetch ahead, 0 to 3 — see `Store.readAheadChapters`.
   *
   * Not local-only, like the two switches above it: what gets cached is a fact
   * about your reading rather than about this machine, and it is as editable
   * from the phone as the rest of it.
   *
   * Nothing is fetched on the way out. The number is read at the start of the
   * next chapter you open, which is the moment it can act on it without
   * speculating about a series you are not in.
   */
  app.put('/api/manga/read-ahead', async (request, reply) => {
    const body = request.body as { chapters?: unknown } | null;
    if (typeof body?.chapters !== 'number' || !Number.isInteger(body.chapters)) {
      return reply.code(400).send({ error: 'send chapters: a whole number' });
    }
    if (body.chapters < 0 || body.chapters > MAX_READ_AHEAD) {
      return reply.code(400).send({ error: `chapters must be between 0 and ${MAX_READ_AHEAD}` });
    }
    const store = read();
    store.readAheadChapters = body.chapters;
    write(store);
    return { readAheadChapters: store.readAheadChapters };
  });

  /** Candidates from MangaDex for what was typed. Writes nothing. */
  app.get('/api/manga/search', async (request, reply) => {
    const { q } = request.query as { q?: string };
    if (!q || q.trim().length < 2) return { results: [] };

    try {
      const results = await search(q.trim());
      const store = read();
      return {
        // Marked rather than filtered: a series you already have should be
        // visible and obviously already there, not mysteriously absent from a
        // search for its own name.
        results: results.map((c) => ({ ...c, already: Boolean(findExisting(store, c)) })),
      };
    } catch (error) {
      if (error instanceof MangaDexError) return reply.code(502).send({ error: error.message });
      throw error;
    }
  });

  /**
   * Add one.
   *
   * The whole candidate is sent back rather than an id, because the search has
   * already paid for it and re-fetching would be a second request to learn what
   * the browser is already holding.
   */
  app.post('/api/manga', async (request, reply) => {
    const body = request.body as Partial<Series> | null;
    if (!body || typeof body.title !== 'string' || !body.title.trim()) {
      return reply.code(400).send({ error: 'that is not a series' });
    }

    const store = read();
    const ids = {
      mangadexId: typeof body.mangadexId === 'string' ? body.mangadexId : null,
      malId: typeof body.malId === 'number' ? body.malId : null,
      anilistId: typeof body.anilistId === 'number' ? body.anilistId : null,
      muId: typeof body.muId === 'number' ? body.muId : null,
    };

    const existing = findExisting(store, ids);
    if (existing) return reply.code(409).send({ error: 'already in your list', id: existing.id });

    const series = newSeries({
      ...ids,
      title: body.title.trim().slice(0, 200),
      // Only ever a MangaDex cover URL, because that is the only thing the proxy
      // route will fetch. Anything else is dropped rather than stored and later
      // refused, which would look like the cover being broken.
      coverUrl:
        typeof body.coverUrl === 'string' && body.coverUrl.startsWith('https://uploads.mangadex.org/')
          ? body.coverUrl
          : null,
      status: (body.status as Series['status']) ?? 'unknown',
    });

    store.series.push(series);
    write(store);
    // The change announcer fires for every successful non-GET under /api/,
    // so nothing here has to announce itself. Only the sweep does, having no
    // request behind it.
    return seriesSummary(series);
  });

  app.delete('/api/manga/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const store = read();
    const before = store.series.length;
    store.series = store.series.filter((s) => s.id !== id);
    if (store.series.length === before) return reply.code(404).send({ error: 'no such series' });

    /*
     * The release links go too, which is the opposite of the coursework rule and
     * deliberately so. There, a null `taskId` means "raised once, and you threw
     * the task away" and must never be revisited. Here you have removed the
     * *series*; adding it back later is a fresh start, and its first poll
     * records the current chapter without raising anything anyway.
     */
    store.links = store.links.filter((l) => l.seriesId !== id);
    write(store);
    writePosition(id, null);
    return { ok: true };
  });

  /**
   * Go and look now.
   *
   * Present whether or not anything is due, like the weather's button: it is how
   * you find out the thing works without waiting half an hour to see whether it
   * was going to.
   */
  app.post('/api/manga/check', async () => {
    const result = await sweepReleases();
    const store = read();
    return { ...result, series: store.series.map(seriesSummary) };
  });

  /**
   * A cover, fetched here rather than by the browser.
   *
   * MangaDex asks that images be proxied rather than hotlinked, and this sits
   * behind `/api/` anyway because it is a picture in *your* list — the same call
   * the habit pictures make, which is why the PWA fetches the bytes with the
   * token and wraps them in an object URL rather than using an `img src`.
   *
   * The URL is read from the stored row and never taken from the caller, which
   * is the rule the game launcher follows: a route that accepted a URL would be
   * an open proxy wearing a cover's name.
   */
  app.get('/api/manga/:id/cover', async (request, reply) => {
    const { id } = request.params as { id: string };
    const series = read().series.find((s) => s.id === id);
    if (!series?.coverUrl) return reply.code(404).send({ error: 'no cover' });

    try {
      const { body, contentType } = await fetchCover(series.coverUrl);
      return reply
        .header('content-type', contentType)
        .header('cache-control', COVER_CACHE)
        .send(Buffer.from(body));
    } catch {
      return reply.code(502).send({ error: 'could not fetch the cover' });
    }
  });

  /**
   * A cover for something you have **not** added yet.
   *
   * The route above is keyed by library id, which a search result does not have
   * — so candidates rendered a blank placeholder and every search was a list of
   * grey rectangles, with the cover URL sitting unused in the response.
   *
   * This is the one place a caller names what to fetch, so the two path parts
   * are pattern-checked rather than trusted: a MangaDex id is a UUID and a cover
   * filename is a UUID plus an extension, optionally with their `.256.jpg`
   * thumbnail suffix. The host is fixed here and `fetchCover` re-checks the
   * assembled prefix, so the worst a crafted request can reach is a different
   * cover on MangaDex. That is a narrower claim than "not an open proxy" by
   * accident — it is two checks that are only equivalent while both are right,
   * the arrangement the zip reader's path guard already uses.
   */
  app.get('/api/manga/cover/mangadex/:mangaId/:file', async (request, reply) => {
    const { mangaId, file } = request.params as { mangaId: string; file: string };
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const FILE = /^[0-9a-f-]{36}\.(jpg|jpeg|png)(\.\d{2,4}\.jpg)?$/i;
    if (!UUID.test(mangaId) || !FILE.test(file)) return reply.code(400).send({ error: 'not a cover' });

    try {
      const { body, contentType } = await fetchCover(`https://uploads.mangadex.org/covers/${mangaId}/${file}`);
      return reply
        .header('content-type', contentType)
        .header('cache-control', COVER_CACHE)
        .send(Buffer.from(body));
    } catch {
      return reply.code(502).send({ error: 'could not fetch the cover' });
    }
  });
}
