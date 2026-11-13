/**
 * Browsing the sources: listings, search, a series' page before you follow it, and following from there.
 *
 * Registered by `routes` in `../index.ts`, in this order with the other groups.
 */
import type { FastifyInstance } from 'fastify';
import { changes } from '@everything/server/module-api';
import { PageFetchError, sharedPage } from '../page-fetch.js';
import { compressCached, originalSizeHeader, qualityFrom } from '../compress.js';
import { search, type Candidate } from '../mangadex.js';
import { readSeries } from '../mangaupdates.js';
import {
  read,
  write,
  newSeries,
  findExisting,
  readPositions,
  writePosition,
  type Series,
  type Store,
} from '../library.js';
import { seriesSummary, thumbPath, THUMB_PATH } from '../present.js';
import { groupMatches, isIndexSource, toSuwayomiChanges, type FilterChange } from '../browse.js';
import {
  SourceError,
  distinctChapters,
  effectiveUrl,
  profileChapters,
  sourcesToSearch,
  rankMatches,
  titleScore,
  type SourceMatch,
} from '../sources.js';
import { SuwayomiAdapter, DEFAULT_BASE_URL } from '../suwayomi.js';
import { suwayomiProcess } from '../process.js';
import { tagsForLevel, withoutTags } from '../mature.js';
import { retitleFromSource } from '../titles.js';
import { COVER_CACHE, present } from './shared.js';

export function browseRoutes(app: FastifyInstance): void {
  /* ---- browsing ---- */

  /**
   * The source, up — for things that are not about one series.
   *
   * The same start-on-demand as the reader: browsing is something you opened a
   * tab to do, so it may spend the JVM's startup.
   */
  type ReadyContext = { error: string; code: 400 | 502 } | { store: Store; adapter: SuwayomiAdapter; url: string };

  async function ready(): Promise<ReadyContext> {
    const store = read();
    const url = effectiveUrl(store, DEFAULT_BASE_URL);
    if (!url) return { error: 'no source is configured', code: 400 as const };
    if (store.manageSuwayomi && store.suwayomiJar) {
      const state = await suwayomiProcess.ensureRunning(store.suwayomiJar, url, store.suwayomiMode);
      if (state.state !== 'running') {
        return { error: state.state === 'failed' ? state.problem : 'Suwayomi is still starting', code: 502 as const };
      }
    } else {
      suwayomiProcess.touch(store.suwayomiMode);
    }
    return { store, adapter: new SuwayomiAdapter(url, store.ignoredSources.map((s) => s.id)), url };
  }

  const SOURCE_ID = /^\d{1,25}$/;

  /**
   * Each result with how many chapters it has, from what Suwayomi has stored —
   * one local query, nothing asked of any site. `null` is "not known yet": the
   * screen asks `/browse/chapters` for those after drawing the page, so a page
   * is as quick as before and the counts fill in.
   */
  async function withChapterCounts<T extends SourceMatch>(adapter: SuwayomiAdapter, results: T[]) {
    let counts = new Map<string, number>();
    try {
      counts = await adapter.storedChapterCounts(results.map((r) => r.id));
    } catch {
      // Unknown, all of them: the screen asks for each.
    }
    return results.map((r) => ({ ...r, chapters: counts.get(r.id) ?? null }));
  }

  /**
   * The sources Browse can list from — the languages you read, like search —
   * and which one it lists from now.
   */
  app.get('/api/manga/browse', async (_request, reply) => {
    const ctx = await ready();
    if ('error' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    try {
      const all = await ctx.adapter.listSources();
      const sources = sourcesToSearch(all, ctx.store.readLanguages)
        .searched.filter((s) => s.lang !== 'localsourcelang')
        .sort((a, b) => Number(isIndexSource(a.name)) - Number(isIndexSource(b.name)) || a.name.localeCompare(b.name));
      // `kept` is the Local collection, the series kept on the PC, which is no
      // Suwayomi source. It is where Browse opens until a source is chosen, and
      // where it falls back to when the chosen one is gone: the first source in
      // alphabetical order was a default nobody picked.
      const selected =
        ctx.store.browseSource === 'kept' ? 'kept' : (sources.find((s) => s.id === ctx.store.browseSource)?.id ?? 'kept');
      return { sources, selected, readLanguages: ctx.store.readLanguages, installed: all.length };
    } catch (error) {
      if (error instanceof SourceError) return reply.code(502).send({ error: error.message });
      throw error;
    }
  });

  /**
   * Which source to browse from. Not local-only — it is a preference about
   * reading, and it lives on the server so the phone and the PC browse the same
   * one, as the theme does.
   */
  app.put('/api/manga/browse/source', async (request, reply) => {
    const body = request.body as { id?: unknown } | null;
    if (typeof body?.id !== 'string' || !(SOURCE_ID.test(body.id) || body.id === 'kept')) {
      return reply.code(400).send({ error: 'which source?' });
    }
    const store = read();
    store.browseSource = body.id;
    write(store);
    return { selected: store.browseSource };
  });

  /** One page of a source's popular list or its newest releases. */
  app.get('/api/manga/browse/list', async (request, reply) => {
    const { source, type, page, safe, hide } = request.query as {
      source?: string;
      type?: string;
      page?: string;
      safe?: string;
      hide?: string | string[];
    };
    if (!source || !SOURCE_ID.test(source)) return reply.code(400).send({ error: 'which source?' });
    if (type !== 'popular' && type !== 'latest') return reply.code(400).send({ error: 'popular or latest' });
    const n = Number.parseInt(page ?? '1', 10);
    if (!Number.isInteger(n) || n < 1 || n > 500) return reply.code(400).send({ error: 'not a page' });

    const ctx = await ready();
    if ('error' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    try {
      const meta = (await ctx.adapter.listSources()).find((s) => s.id === source);
      if (!meta) return reply.code(404).send({ error: 'that source is not installed any more' });
      if (type === 'latest' && !meta.supportsLatest) {
        return reply.code(400).send({ error: `${meta.name} does not list recent releases` });
      }
      const got = await ctx.adapter.browse(
        { id: meta.id, displayName: meta.name, lang: meta.lang },
        type === 'popular' ? 'POPULAR' : 'LATEST',
        n
      );
      /*
       * `hide` names the tags to leave out, once per tag — see `mature.ts` for
       * how they are matched and found. `safe` is what a screen from before
       * tags sends, and means the same three it used to.
       */
      const tags = (hide === undefined ? tagsForLevel(safe) : Array.isArray(hide) ? hide : [hide])
        .map((t) => t.trim())
        .filter((t) => t.length > 0 && t.length <= 40)
        .slice(0, 50);
      const filtered = tags.length > 0 ? await withoutTags(ctx.adapter, got.matches, tags) : null;
      return {
        results: await withChapterCounts(
          ctx.adapter,
          (filtered?.matches ?? got.matches).map((m) => present(ctx.store, m))
        ),
        hasNextPage: got.hasNextPage,
        page: n,
        hidden: filtered?.hidden ?? 0,
        hiddenBy: filtered?.hiddenBy ?? {},
        unchecked: filtered?.unchecked ?? 0,
      };
    } catch (error) {
      if (error instanceof SourceError) return reply.code(502).send({ error: error.message });
      throw error;
    }
  });

  /** A source's own filters, for the search panel. */
  app.get('/api/manga/browse/filters', async (request, reply) => {
    const { source } = request.query as { source?: string };
    if (!source || !SOURCE_ID.test(source)) return reply.code(400).send({ error: 'which source?' });
    const ctx = await ready();
    if ('error' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    try {
      return { filters: await ctx.adapter.filters(source) };
    } catch (error) {
      if (error instanceof SourceError) return reply.code(502).send({ error: error.message });
      throw error;
    }
  });

  /**
   * Search every source, grouped by series, the chosen source first.
   *
   * The chosen source is searched with its own filters; every other source with
   * the query alone, since filters mean something different on each. A search
   * with filters and no words can only go to the chosen source — the others
   * have nothing to be asked — and the answer says so rather than presenting
   * one source's results as everyone's.
   */
  /**
   * How many chapters each of these has, for the Browse results whose count
   * was not stored. A dozen at most per request, three at a time: each one not
   * stored is a request to the site, and the screen asks in small batches so
   * counts appear as they come rather than all at the end. Suwayomi keeps what
   * it fetched, so the next look is free.
   *
   * A count that could not be found is `null`, and the tile shows nothing for
   * it rather than an error: it is a detail, not the point of the page.
   */
  app.post('/api/manga/browse/chapters', async (request, reply) => {
    const body = request.body as { ids?: unknown } | null;
    const ids = Array.isArray(body?.ids)
      ? body.ids.filter((x): x is string => typeof x === 'string' && /^\d{1,12}$/.test(x)).slice(0, 12)
      : [];
    if (ids.length === 0) return reply.code(400).send({ error: 'which series?' });
    const ctx = await ready();
    if ('error' in ctx) return reply.code(ctx.code).send({ error: ctx.error });

    const counts: Record<string, number | null> = {};
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const id = ids[next++]!;
        try {
          // Suwayomi's copy when it has one, else the site once, which it keeps.
          counts[id] = distinctChapters((await ctx.adapter.chapters(id, false)).map((c) => c.number));
        } catch {
          counts[id] = null;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, ids.length) }, worker));
    return { counts };
  });

  app.post('/api/manga/browse/search', async (request, reply) => {
    const body = request.body as {
      query?: unknown;
      source?: unknown;
      changes?: unknown;
      allLanguages?: unknown;
      only?: unknown;
    } | null;
    const query = typeof body?.query === 'string' ? body.query.trim().slice(0, 200) : '';
    const sourceId = typeof body?.source === 'string' && SOURCE_ID.test(body.source) ? body.source : null;
    const changes = Array.isArray(body?.changes) ? (body.changes.slice(0, 300) as FilterChange[]) : [];
    const only =
      Array.isArray(body?.only) && body.only.every((s) => typeof s === 'string' && SOURCE_ID.test(s))
        ? (body.only as string[])
        : null;
    if (!query && changes.length === 0) return reply.code(400).send({ error: 'type a title, or choose a filter' });

    const ctx = await ready();
    if ('error' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    const languages = body?.allLanguages === true ? null : ctx.store.readLanguages;

    try {
      const installed = await ctx.adapter.listSources();
      const meta = sourceId ? installed.find((s) => s.id === sourceId) ?? null : null;

      let applied = 0;
      let dropped = 0;
      let preferredProblem: string | null = null;

      const preferred = (async () => {
        if (!meta) return [] as SourceMatch[];
        let input: Array<Record<string, unknown>> = [];
        if (changes.length > 0) {
          const checked = toSuwayomiChanges(await ctx.adapter.filters(meta.id), changes);
          input = checked.input;
          applied = input.length;
          dropped = checked.dropped;
        }
        if (!query && input.length === 0) return [];
        try {
          return (
            await ctx.adapter.browse({ id: meta.id, displayName: meta.name, lang: meta.lang }, 'SEARCH', 1, query, input)
          ).matches;
        } catch (error) {
          // Reported beside the other sources' results rather than failing
          // them: one broken extension is the ordinary case, and losing every
          // other source's answer over it would read as nothing existing.
          preferredProblem = error instanceof SourceError ? error.message : 'the search failed';
          return [];
        }
      })();

      const others = query
        ? ctx.adapter.search(query, { limit: 400, languages, only, exclude: meta?.id ?? null })
        : Promise.resolve(null);

      const [mine, rest] = await Promise.all([preferred, others]);
      const ranked = query ? rankMatches(query, [...mine, ...(rest?.matches ?? [])]) : mine.map((m) => ({ ...m, score: 0 }));
      const groups = groupMatches(
        await withChapterCounts(
          ctx.adapter,
          ranked.map((m) => present(ctx.store, m))
        ),
        meta?.id ?? null
      ).map((g) => ({ ...g, following: g.entries.find((e) => e.following)?.following ?? null }));

      return {
        groups,
        searched: (rest?.searched ?? 0) + (meta ? 1 : 0),
        skipped: rest?.skipped ?? 0,
        preferred: meta ? { id: meta.id, name: meta.name } : null,
        preferredProblem,
        filtersApplied: applied,
        filtersDropped: dropped,
        /** True when there were filters and no words, so only the chosen source was asked. */
        onlyPreferred: !query,
        languages,
      };
    } catch (error) {
      if (error instanceof SourceError) return reply.code(502).send({ error: error.message });
      throw error;
    }
  });

  /**
   * A cover from a source.
   *
   * Proxied for the reason pages are: Suwayomi has no authentication and the
   * phone cannot reach it. Checked against the one shape Suwayomi publishes, or
   * this would be an open proxy to anything the server can reach.
   */
  app.get('/api/manga/thumb', async (request, reply) => {
    const { p } = request.query as { p?: string };
    if (!p || !THUMB_PATH.test(p)) return reply.code(400).send({ error: 'not a cover' });
    const ctx = await ready();
    if ('error' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    try {
      const response = await fetch(`${ctx.url}${p}`, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) return reply.code(502).send({ error: `the source answered ${response.status}` });
      return reply
        .header('content-type', response.headers.get('content-type') ?? 'image/jpeg')
        .header('cache-control', COVER_CACHE)
        .send(Buffer.from(await response.arrayBuffer()));
    } catch {
      return reply.code(502).send({ error: 'could not fetch the cover' });
    }
  });

  /**
   * Follow something found while browsing, already linked to where it was found.
   *
   * It is also looked up on MangaDex by name, because that is what gives it a
   * MangaUpdates id, a MyAnimeList id for exporting later, and a proper cover.
   * Only a close match is taken — a title starting with what the source calls it
   * or better — since attaching the wrong series' ids would be worse than none.
   * With no match it is still followed: a linked series is watched through its
   * source, and the row says where its numbers come from.
   *
   * Already following that series by name, without a source? Then this links
   * the source to it rather than making a second row for the same thing.
   */
  /**
   * Hand a glimpse's history over to the series that now covers it.
   *
   * Following something you had only dipped into must not leave two records of
   * it — History would list the same chapters twice, once as "not following"
   * and once not, and neither would be wrong. So the read log moves across and
   * the glimpse goes.
   *
   * Only chapters the series does not already know about: following something
   * you had *also* read elsewhere should not duplicate a chapter inside one
   * log. The place moves too, unless the series already has a newer one.
   */
  function absorbGlimpse(store: Store, series: Series, mangaId: string): void {
    const glimpse = store.glimpses.find((g) => g.source.mangaId === mangaId);
    if (!glimpse) return;

    const known = new Set(series.readChapters);
    for (const chapter of glimpse.readChapters) known.add(chapter);
    series.readChapters = [...known].sort((a, b) => a - b);

    const logged = new Set(series.readLog.map((r) => r.chapter));
    for (const record of glimpse.readLog) {
      if (!logged.has(record.chapter)) series.readLog.push(record);
    }
    series.readLog.sort((a, b) => a.chapter - b.chapter);

    const place = readPositions()[glimpse.id];
    const already = readPositions()[series.id];
    if (place && (!already || already.at < place.at)) writePosition(series.id, place);
    writePosition(glimpse.id, null);

    store.glimpses = store.glimpses.filter((g) => g.id !== glimpse.id);
  }

  app.post('/api/manga/follow-source', async (request, reply) => {
    const body = request.body as { mangaId?: unknown; title?: unknown; sourceName?: unknown } | null;
    if (typeof body?.mangaId !== 'string' || !/^\d{1,20}$/.test(body.mangaId)) {
      return reply.code(400).send({ error: 'that is not a source result' });
    }
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : '';
    const sourceName = typeof body.sourceName === 'string' ? body.sourceName.slice(0, 80) : '';
    if (!title || !sourceName) return reply.code(400).send({ error: 'that is not a source result' });

    const store = read();
    const link = { adapter: 'suwayomi', mangaId: body.mangaId, title, sourceName };

    /*
     * A series you already follow, named by id: this is "read it from here" on
     * one with no source yet. Linked directly rather than through the MangaDex
     * lookup below, because a lookup that missed would add a second row for a
     * series already in the list.
     */
    if (typeof (body as { seriesId?: unknown }).seriesId === 'string') {
      const target = store.series.find((s) => s.id === (body as { seriesId: string }).seriesId);
      if (!target) return reply.code(404).send({ error: 'no such series' });
      if (target.source) {
        return reply.code(409).send({ error: `${target.title} already reads from ${target.source.sourceName}`, id: target.id });
      }
      target.source = link;
      target.latestChapter = null;
      target.sourceChapter = null;
      target.sourceCheckedAt = null;
      target.checkedAt = null;
      retitleFromSource(target);
      absorbGlimpse(store, target, body.mangaId);
      write(store);
      return { series: seriesSummary(target), matchedOn: 'existing' };
    }

    const same = store.series.find((s) => s.source?.mangaId === body.mangaId && s.source?.sourceName === sourceName);
    if (same) return reply.code(409).send({ error: `already following ${same.title}`, id: same.id });

    let best: Candidate | null = null;
    try {
      const found = await search(title, 8);
      let bestScore = 0;
      for (const c of found) {
        const score = Math.max(titleScore(title, c.title), c.subtitle ? titleScore(title, c.subtitle) : 0);
        if (score >= 80 && score > bestScore) {
          best = c;
          bestScore = score;
        }
      }
    } catch {
      // MangaDex being down is not a reason to refuse. The series is followed
      // through its source either way; it just arrives without the extra ids.
    }

    let totalChapters: number | null = null;
    if (best?.muId) {
      // One MangaUpdates read for the "N written" context, as linking does —
      // after this the series is watched through its source.
      try {
        totalChapters = (await readSeries(best.muId)).totalChapters;
      } catch {
        // Left null. The row simply says less.
      }
    }

    /*
     * Read again now that the slow part is over, so what is written is the
     * store as it is rather than as it was before two network requests — a
     * chapter marked read meanwhile would otherwise be lost. And the duplicate
     * check is asked again of it, since the answer may have changed too.
     */
    const store2 = read();
    if (store2.series.some((s) => s.source?.mangaId === body.mangaId && s.source?.sourceName === sourceName)) {
      return reply.code(409).send({ error: `already following ${title}` });
    }
    const existing = best ? findExisting(store2, best) : undefined;
    if (existing) {
      if (existing.source) {
        return reply
          .code(409)
          .send({ error: `already following ${existing.title}, from ${existing.source.sourceName}`, id: existing.id });
      }
      existing.source = link;
      existing.latestChapter = null;
      existing.sourceChapter = null;
      existing.sourceCheckedAt = null;
      existing.checkedAt = null;
      retitleFromSource(existing);
      absorbGlimpse(store2, existing, body.mangaId);
      write(store2);
      return { series: seriesSummary(existing), matchedOn: 'existing' };
    }

    const series = newSeries({
      mangadexId: best?.mangadexId ?? null,
      malId: best?.malId ?? null,
      anilistId: best?.anilistId ?? null,
      muId: best?.muId ?? null,
      title: best?.title ?? title,
      coverUrl: best?.coverUrl?.startsWith('https://uploads.mangadex.org/') ? best.coverUrl : null,
      status: best?.status ?? 'unknown',
    });
    series.source = link;
    series.totalChapters = totalChapters;
    store2.series.push(series);
    absorbGlimpse(store2, series, body.mangaId);
    write(store2);
    return { series: seriesSummary(series), matchedOn: best ? 'mangadex' : null };
  });

  /**
   * One series from a source, for the page you get by tapping it in Browse:
   * what the site says about it, and its chapters.
   *
   * Chapters are read from Suwayomi's copy first and fetched from the site only
   * when there is none — which, for something you have only ever seen in a
   * list, is nearly always, since nothing asks for its chapters until now. A
   * chapter list that will not load is reported beside the details rather than
   * failing the page, so the blurb and Follow survive a flaky site.
   */
  app.get('/api/manga/browse/manga/:mangaId', async (request, reply) => {
    const { mangaId } = request.params as { mangaId: string };
    if (!/^\d{1,20}$/.test(mangaId)) return reply.code(400).send({ error: 'not a source series' });
    const ctx = await ready();
    if ('error' in ctx) return reply.code(ctx.code).send({ error: ctx.error });

    try {
      const details = await ctx.adapter.details(mangaId);
      let chapters: Awaited<ReturnType<SuwayomiAdapter['chapters']>> = [];
      let chaptersProblem: string | null = null;
      try {
        chapters = await ctx.adapter.chapters(mangaId, false);
        if (chapters.length === 0) chapters = await ctx.adapter.chapters(mangaId, true);
      } catch (error) {
        chaptersProblem = error instanceof SourceError ? error.message : 'could not list its chapters';
      }
      const { following, unlinked } = present(ctx.store, {
        id: details.id,
        title: details.title,
        sourceName: details.sourceName,
        lang: details.lang,
        url: details.url,
        thumbnailUrl: details.thumbnailUrl,
      });
      /*
       * Your reading of it, when you follow it: read marks by chapter *number*,
       * so they hold on any source's copy — a chapter read on MangaFire is read
       * whichever site you are looking at — and your place only on the copy it
       * was measured on, since another source's page 12 is somewhere else.
       */
      const own = following ? ctx.store.series.find((s) => s.id === following) : undefined;
      /*
       * Or your reading of it when you do *not* follow it. A glimpse carries the
       * same read log and place, and leaving it out meant a series you were
       * twenty chapters into offered "Read chapter 1" and drew every chapter
       * unread — its history was in History and nowhere on its own page.
       */
      const glimpse = own
        ? undefined
        : ctx.store.glimpses.find((g) => g.source.mangaId === mangaId && g.source.sourceName === details.sourceName);
      const record = own ?? glimpse;
      const readSet = new Set(record?.readChapters ?? []);
      const readOn = new Map((record?.readLog ?? []).map((r) => [r.chapter, r.source]));
      const place = record ? readPositions()[record.id] ?? null : null;

      return {
        ...details,
        // Only a link a person can follow: the site's own http(s) page.
        url: details.url && /^https?:\/\//i.test(details.url) ? details.url : null,
        coverPath: thumbPath(details.thumbnailUrl),
        following,
        unlinked,
        // So the page writes into the record it already has from its first chapter.
        glimpseId: glimpse?.id ?? null,
        position: place && place.mangaId === mangaId ? place : null,
        chapters: [...chapters]
          .sort((a, b) => b.number - a.number)
          .map((c) => ({ ...c, read: readSet.has(c.number), readOn: readOn.get(c.number) ?? null })),
        profile: profileChapters(chapters),
        chaptersProblem,
      };
    } catch (error) {
      if (error instanceof SourceError) return reply.code(502).send({ error: error.message });
      throw error;
    }
  });

  /**
   * A chapter's pages, for reading something you have not followed.
   *
   * Nothing is marked read — there is no series to keep a place in — which the
   * page says. The pages come back as this app's URLs, for the reason the
   * followed reader's do.
   */
  app.get('/api/manga/browse/manga/:mangaId/chapters/:chapterId/pages', async (request, reply) => {
    const { mangaId, chapterId } = request.params as { mangaId: string; chapterId: string };
    if (!/^\d{1,20}$/.test(mangaId) || !/^\d{1,20}$/.test(chapterId)) {
      return reply.code(400).send({ error: 'not a chapter' });
    }
    const ctx = await ready();
    if ('error' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    try {
      const pages = await ctx.adapter.pages(chapterId);
      return { pages: pages.map((path) => `/api/manga/browse/page?p=${encodeURIComponent(path)}`) };
    } catch (error) {
      if (error instanceof SourceError) return reply.code(502).send({ error: error.message });
      throw error;
    }
  });

  /** One page image for the preview reader — checked exactly as the followed reader's are. */
  app.get('/api/manga/browse/page', async (request, reply) => {
    const { p, q } = request.query as { p?: string; q?: string };
    if (!p || !/^\/api\/v1\/manga\/\d+\/chapter\/\d+\/page\/\d+$/.test(p)) {
      return reply.code(400).send({ error: 'not a page' });
    }
    const ctx = await ready();
    if ('error' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    try {
      // Asked again on a refusal before giving up, and shared — see `page-fetch.ts`.
      // Made smaller when asked, as the followed reader's are (`compress.ts`).
      const out = await compressCached(p, await sharedPage(`${ctx.url}${p}`), qualityFrom(q));
      return reply
        .header('content-type', out.type)
        .header('cache-control', 'private, max-age=604800')
        .header('x-made-in', String(Math.round(reply.elapsedTime)))
        .headers(originalSizeHeader(out))
        .send(out.body);
    } catch (error) {
      // 504 when it timed out twice, so the reader knows waiting again will not help.
      const code = error instanceof PageFetchError && error.status === 504 ? 504 : 502;
      return reply.code(code).send({ error: error instanceof Error ? error.message : 'could not fetch the page' });
    }
  });
}
