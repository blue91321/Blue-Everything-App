/**
 * The reading list, and the one thing here that runs on a timer.
 *
 * ### Why this polls when nothing else in the app does
 *
 * Almost everything here is refresh-on-read: the weather, the friends list, the
 * live streams. A screen nobody is looking at costs nothing. That is the right
 * shape for data you *go and look at*, and the wrong shape for this — a chapter
 * release's whole job is to reach the nudge queue while you are thinking about
 * something else. A "Check now" button as the only route in would mean the one
 * feature that exists to remember things for you had to be remembered.
 *
 * It is the same argument the coursework sweep makes, and it is held to the same
 * numbers: half an hour, a dozen series a tick, and nothing at all when the
 * library is empty or every series has finished. A fresh install makes no
 * requests. The handles are `unref`ed and cleared on close, or `smoke` and
 * `features-check` hang on an app that will not shut down.
 *
 * ### The library is not local-only; the source is
 *
 * Adding a series is your data, like a habit, so it is editable from the phone.
 * A reading list is not a write that changes *this machine*.
 *
 * Pointing the module at a **source** is, and it is gated. The stored URL is
 * something the server then POSTs to on a timer, so a phone-settable version
 * would turn a stolen device token into a server-side request forgery. That
 * puts it with minting a device token and installing a package.
 */
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { db, nudges, changes } from '@everything/server/module-api';
import { chapterValue } from './identity.js';
import { search, fetchCover, MangaDexError, type Candidate } from './mangadex.js';
import { CREDIT, readSeries } from './mangaupdates.js';
import {
  read,
  write,
  newSeries,
  findExisting,
  readPositions,
  writePosition,
  type ReadingPosition,
  type Series,
  type Store,
} from './library.js';
import { seriesSummary, recentReleases, thumbPath, THUMB_PATH } from './present.js';
import { groupKey, groupMatches, isIndexSource, toSuwayomiChanges, type FilterChange } from './browse.js';
import { sweepReleases, pollable, SWEEP_EVERY_MS } from './releases.js';
import {
  SourceError,
  effectiveUrl,
  supportsExtensions,
  profileChapters,
  judgePages,
  type ExtensionCatalogue,
  type PageSample,
  sourcesToSearch,
  rankMatches,
  titleScore,
  type SourceMatch,
} from './sources.js';
import { SuwayomiAdapter, DEFAULT_BASE_URL, KEIYOUSHI_REPO } from './suwayomi.js';
import { suwayomiProcess, findJars } from './process.js';
import { homedir } from 'node:os';
import { registerUiProxy, mintSession, sessionCookie, UI_PREFIX } from './uiproxy.js';

export async function routes(app: FastifyInstance): Promise<void> {
  /** The library, already shaped for the screen. */
  app.get('/api/manga', async () => {
    const store = read();
    const positions = readPositions();
    return {
      series: store.series.map((s) => ({ ...seriesSummary(s), position: positions[s.id] ?? null })),
      /** What landed lately, for the panel — see `recentReleases`. */
      recent: recentReleases(store),
      /** MangaUpdates asks to be credited for release data. The screen does it. */
      credit: CREDIT,
      /** How many rows the sweep is still watching, so the screen can say so. */
      watching: pollable(store).length,
      /** Whether a new chapter also becomes a task — see `Store.releaseTasks`. */
      releaseTasks: store.releaseTasks,
    };
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
        .header('cache-control', 'private, max-age=86400')
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
        .header('cache-control', 'private, max-age=86400')
        .send(Buffer.from(body));
    } catch {
      return reply.code(502).send({ error: 'could not fetch the cover' });
    }
  });

  /* ---- where chapters actually come from ---- */

  /**
   * Pointing this at a source is **local-only**, and that is a security gate
   * rather than tidiness.
   *
   * The stored URL becomes a thing the *server* POSTs to on a timer. Settable
   * from the phone, a stolen device token would turn this install into a probe
   * for whatever it can reach — the ordinary shape of a server-side request
   * forgery. Local-only puts it with minting a device token and installing a
   * package: an attacker has to already be on this machine, at which point they
   * do not need this route.
   *
   * No host allow-list on top of that, deliberately. Suwayomi is usually on
   * loopback and legitimately might not be — a second machine on the LAN, or
   * across a tailnet — and a list that blocked those would break real setups to
   * re-solve a problem the local-only gate has already solved.
   */
  const localOnly = (request: { isLocal: boolean }) => {
    if (!request.isLocal) {
      throw Object.assign(new Error('the source can only be changed from the PC running the server'), {
        statusCode: 403,
      });
    }
  };

  /**
   * Is a source configured, is it answering, and may we run it ourselves?
   *
   * All four of "not set up", "set up and broken", "off but startable" and
   * "running" are reported separately. Collapsing any pair of them into one flag
   * gives a screen that says "not working" to a person whose actual fix is one
   * click away — the distinction `features` and `featuresMissing` draw.
   */
  app.get('/api/manga/source', async () => {
    const store = read();
    const { suwayomiUrl, suwayomiJar, manageSuwayomi } = store;
    const managed = suwayomiProcess.state;
    const url = effectiveUrl(store, DEFAULT_BASE_URL);

    // Only offered when nothing is chosen yet: a scan of Downloads on every
    // poll would be disk work for a question already answered.
    const foundJars = suwayomiJar ? [] : findJars(homedir());

    const base = {
      defaultUrl: DEFAULT_BASE_URL,
      readLanguages: store.readLanguages,
      jar: suwayomiJar,
      manage: manageSuwayomi,
      mode: store.suwayomiMode,
      managed,
      foundJars,
    };

    if (!url) return { ...base, configured: false, url: null, health: null };

    /*
     * Not asked while we are managing it and it is off — that is the ordinary
     * resting state, and reporting it as "unreachable" would make the normal
     * case look broken. The `managed` state above already says what is true.
     */
    if (manageSuwayomi && managed.state !== 'running') {
      return { ...base, configured: true, url, health: null };
    }

    return { ...base, configured: true, url, health: await new SuwayomiAdapter(url).describe() };
  });

  /** Start it now, and wait until it answers. */
  app.post('/api/manga/source/start', async (request, reply) => {
    localOnly(request as unknown as { isLocal: boolean });
    const { suwayomiJar, suwayomiUrl } = read();
    if (!suwayomiJar) return reply.code(400).send({ error: 'no Suwayomi jar has been chosen' });
    const { suwayomiMode } = read();
    return suwayomiProcess.ensureRunning(suwayomiJar, suwayomiUrl ?? DEFAULT_BASE_URL, suwayomiMode);
  });

  /** Stop it now, rather than waiting out the idle timer. */
  app.post('/api/manga/source/stop', async (request) => {
    localOnly(request as unknown as { isLocal: boolean });
    suwayomiProcess.stop();
    return suwayomiProcess.state;
  });

  /** Set, or clear with an empty string. */
  app.put('/api/manga/source', async (request, reply) => {
    localOnly(request as unknown as { isLocal: boolean });
    const body = request.body as { url?: unknown; jar?: unknown; manage?: unknown; mode?: unknown } | null;

    /*
     * The jar and the switch are set through the same route as the URL, and each
     * key is optional — omitted means "leave it", which is the shape the
     * integrations credential form already uses. A single endpoint keeps the
     * three from being saved in an order that briefly makes no sense, such as
     * managing switched on with no jar chosen.
     */
    if (body && ('jar' in body || 'manage' in body || 'mode' in body)) {
      const store = read();
      const jar = 'jar' in body ? (typeof body.jar === 'string' && body.jar.trim() ? body.jar.trim() : null) : store.suwayomiJar;
      const manage = 'manage' in body ? body.manage === true : store.manageSuwayomi;
      const mode = 'mode' in body ? (body.mode === 'always' ? 'always' : 'on-demand') : store.suwayomiMode;

      // Switching management on with nothing to run is a setting that could only
      // fail later, so it is refused now with the reason.
      if (manage && !jar) return reply.code(400).send({ error: 'choose a Suwayomi jar first' });
      // Stopped rather than orphaned: turning management off while it is up
      // would leave a JVM nobody owns holding the port.
      if (!manage) suwayomiProcess.stop();

      write({ ...store, suwayomiJar: jar, manageSuwayomi: manage, suwayomiMode: mode });

      /*
       * Switching to `always` while it is off starts it now rather than at the
       * next thing that happens to need it — otherwise choosing "always on"
       * would leave it off, which is the setting failing to mean what it says.
       * Switching to `on-demand` arms the idle timer, so it winds down on its
       * own rather than staying up until a restart.
       */
      if (manage && jar) {
        const url = effectiveUrl({ suwayomiUrl: store.suwayomiUrl, manageSuwayomi: manage }, DEFAULT_BASE_URL)!;
        if (mode === 'always' && suwayomiProcess.state.state === 'off') {
          void suwayomiProcess.ensureRunning(jar, url, mode);
        } else {
          suwayomiProcess.touch(mode);
        }
      }

      if (!('url' in (body ?? {}))) {
        const after = read();
        return {
          configured: Boolean(after.suwayomiUrl),
          url: after.suwayomiUrl,
          defaultUrl: DEFAULT_BASE_URL,
          jar: after.suwayomiJar,
          manage: after.manageSuwayomi,
          mode: after.suwayomiMode,
          managed: suwayomiProcess.state,
          foundJars: after.suwayomiJar ? [] : findJars(homedir()),
          health: null,
        };
      }
    }

    const raw = typeof body?.url === 'string' ? body.url.trim() : null;

    if (raw === null) return reply.code(400).send({ error: 'send a url' });
    if (raw === '') {
      const store = read();
      write({ ...store, suwayomiUrl: null });
      return sourceState(null, null);
    }

    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return reply.code(400).send({ error: 'that is not a URL' });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return reply.code(400).send({ error: 'only http and https' });
    }

    // Stored without a trailing slash so the adapter can append `/api/graphql`
    // without ever producing a double slash, which some proxies 404.
    const url = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
    const store = read();
    write({ ...store, suwayomiUrl: url });

    // Answered with the health check rather than `{ ok: true }`, so pressing
    // Save tells you whether it worked instead of leaving you to go and look.
    return sourceState(url, await new SuwayomiAdapter(url).describe());
  });

  /**
   * One shape for the source card, so a save and a reload never disagree.
   *
   * Both were assembled by hand at first and the PUT quietly omitted the jar and
   * the managed state — so saving an address blanked half the card until the
   * next poll refilled it, which reads as the save having lost something.
   */
  function sourceState(url: string | null, health: Awaited<ReturnType<SuwayomiAdapter['describe']>> | null) {
    const after = read();
    return {
      configured: Boolean(url),
      url,
      defaultUrl: DEFAULT_BASE_URL,
      jar: after.suwayomiJar,
      manage: after.manageSuwayomi,
      mode: after.suwayomiMode,
      managed: suwayomiProcess.state,
      foundJars: after.suwayomiJar ? [] : findJars(homedir()),
      health,
    };
  }

  /** Find this series in the source's own catalogue, so it can be linked. */
  app.get('/api/manga/:id/source/search', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { q, all } = request.query as { q?: string; all?: string };
    const store = read();
    const series = store.series.find((s) => s.id === id);
    if (!series) return reply.code(404).send({ error: 'no such series' });
    const sourceUrl = effectiveUrl(store, DEFAULT_BASE_URL);
    if (!sourceUrl) return reply.code(400).send({ error: 'no source is configured' });

    // Defaults to the series' own title, because that is what you want in nine
    // cases out of ten and typing it again is a chore.
    const query = (typeof q === 'string' && q.trim()) || series.title;

    /*
     * This is the "on demand" in on-demand: searching sources is something you
     * pressed a button to do, so it is allowed to spend the ten seconds of JVM
     * startup. The sweep deliberately is not.
     */
    if (store.manageSuwayomi && store.suwayomiJar) {
      const state = await suwayomiProcess.ensureRunning(store.suwayomiJar, sourceUrl, store.suwayomiMode);
      if (state.state !== 'running') {
        return reply.code(502).send({ error: state.state === 'failed' ? state.problem : 'Suwayomi is still starting' });
      }
    }

    try {
      const outcome = await new SuwayomiAdapter(sourceUrl).search(query, {
        // `?all=1` is the comparison screen's "include other languages" — a
        // one-off, deliberately not a change to the setting.
        languages: all === '1' ? null : store.readLanguages,
      });
      return {
        results: outcome.matches,
        searched: outcome.searched,
        skipped: outcome.skipped,
        languages: all === '1' ? null : store.readLanguages,
        readLanguages: store.readLanguages,
        available: outcome.available,
      };
    } catch (error) {
      if (error instanceof SourceError) return reply.code(502).send({ error: error.message });
      throw error;
    }
  });

  /**
   * How many chapters one candidate actually has.
   *
   * Its own endpoint, asked one result at a time, because **the count is not
   * free**. Suwayomi stores a manga record when you search but no chapters —
   * `chapters.totalCount` reads 0 for every fresh result — so the only way to
   * know is to make it go and scrape that series' chapter list.
   *
   * Folding it into the search would mean a scrape per result before anything
   * appeared, turning a third of a second into the better part of a minute. So
   * the list arrives ranked and immediately, and the browser fills the counts in
   * behind it, for the few results worth considering.
   *
   * It is also the number that decides the choice. Two sources carrying the same
   * title are not equivalent — MangaFire's Spanish source had *none* of Archmage
   * Curriculum while its English one had 45 — and without the count that is
   * invisible until after you have linked it and the row goes quiet.
   */
  app.get('/api/manga/:id/source/count', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { mangaId } = request.query as { mangaId?: string };
    if (!mangaId) return reply.code(400).send({ error: 'which candidate?' });

    const store = read();
    if (!store.series.some((s) => s.id === id)) return reply.code(404).send({ error: 'no such series' });

    const url = effectiveUrl(store, DEFAULT_BASE_URL);
    if (!url) return reply.code(400).send({ error: 'no source is configured' });

    if (store.manageSuwayomi && store.suwayomiJar) {
      const state = await suwayomiProcess.ensureRunning(store.suwayomiJar, url, store.suwayomiMode);
      if (state.state !== 'running') {
        return reply.code(502).send({ error: state.state === 'failed' ? state.problem : 'Suwayomi is still starting' });
      }
    }

    try {
      const profile = profileChapters(await new SuwayomiAdapter(url).chapters(mangaId, true));
      return {
        /*
         * `chapters` and `latest` are kept beside the profile rather than
         * replaced by it, because the PWA and the server update independently:
         * a browser still holding the previous bundle reads exactly these two,
         * and dropping them would blank its counts until it reloaded.
         */
        chapters: profile.entries,
        latest: profile.latest,
        profile,
      };
    } catch (error) {
      /*
       * A source with nothing for this id answers "No chapters found", which is
       * an *answer* rather than a failure — it is exactly what you wanted to
       * know before choosing. Reported as zero rather than as an error, so the
       * row says "no chapters" instead of going blank.
       */
      const message = error instanceof SourceError ? error.message : 'the source failed';
      if (/no chapters/i.test(message)) return { chapters: 0, latest: null, profile: profileChapters([]) };
      return reply.code(502).send({ error: message });
    }
  });

  /**
   * Are one chapter's pages real?
   *
   * The answer to "is this source corrupted, or listing chapters it does not
   * have" — the two things the newest number cannot tell you, and the reason
   * the old reader's side-by-side view was worth having.
   *
   * On demand, one source at a time, because it is not cheap: the source has to
   * work out the page list, and then three images are fetched through Suwayomi,
   * which fetches them from the site. Somebody comparing eight sources wants to
   * check the one that looks too good, not all eight.
   *
   * Samples the first, the middle and the last page. See `judgePages` for why
   * those three and what counts as wrong.
   */
  app.get('/api/manga/:id/source/check', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { chapterId } = request.query as { chapterId?: string };
    if (!chapterId) return reply.code(400).send({ error: 'which chapter?' });

    const store = read();
    if (!store.series.some((s) => s.id === id)) return reply.code(404).send({ error: 'no such series' });

    const url = effectiveUrl(store, DEFAULT_BASE_URL);
    if (!url) return reply.code(400).send({ error: 'no source is configured' });

    if (store.manageSuwayomi && store.suwayomiJar) {
      const state = await suwayomiProcess.ensureRunning(store.suwayomiJar, url, store.suwayomiMode);
      if (state.state !== 'running') {
        return reply.code(502).send({ error: state.state === 'failed' ? state.problem : 'Suwayomi is still starting' });
      }
    }

    let paths: string[];
    try {
      paths = await new SuwayomiAdapter(url).pages(chapterId);
    } catch (error) {
      // A chapter the source cannot produce a page list for *is* the finding —
      // reported as a verdict, not as an error the screen would show as "failed
      // to check".
      const message = error instanceof SourceError ? error.message : 'the source failed';
      return { pages: 0, samples: [], state: 'broken' as const, problem: `the source could not list its pages: ${message}` };
    }

    const picks = [...new Set([0, Math.floor(paths.length / 2), paths.length - 1])].filter(
      (i) => i >= 0 && i < paths.length
    );

    const samples: PageSample[] = [];
    for (const index of picks) {
      const path = paths[index];
      // The same shape check the page proxy makes. These came from Suwayomi a
      // moment ago rather than from a caller, but the rule is about what may be
      // fetched, and it costs nothing to hold it everywhere.
      if (!/^\/api\/v1\/manga\/\d+\/chapter\/\d+\/page\/\d+$/.test(path)) {
        samples.push({ ok: false, bytes: 0, contentType: null });
        continue;
      }
      try {
        const response = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(30_000) });
        const bytes = response.ok ? (await response.arrayBuffer()).byteLength : 0;
        samples.push({ ok: response.ok, bytes, contentType: response.headers.get('content-type') });
      } catch {
        samples.push({ ok: false, bytes: 0, contentType: null });
      }
    }

    return { samples, ...judgePages(paths.length, samples) };
  });

  /**
   * Point a series at one of those results.
   *
   * **Not local-only**, which it was until the phone needed it. The gate on the
   * source exists because the *address* becomes something the server POSTs to
   * on a timer — a request forgery waiting for a stolen token. Linking stores an
   * opaque id inside a source that address already names; it reaches nothing
   * new. Holding it to the PC meant you could see from the sofa that a source
   * had broken pages and not do anything about it, which is the case the
   * comparison view exists for.
   */
  app.put('/api/manga/:id/source', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { mangaId?: unknown; title?: unknown; sourceName?: unknown } | null;
    if (typeof body?.mangaId !== 'string' || !body.mangaId) {
      return reply.code(400).send({ error: 'that is not a source result' });
    }

    const store = read();
    const series = store.series.find((s) => s.id === id);
    if (!series) return reply.code(404).send({ error: 'no such series' });

    series.source = {
      adapter: 'suwayomi',
      mangaId: body.mangaId,
      title: typeof body.title === 'string' ? body.title.slice(0, 200) : series.title,
      sourceName: typeof body.sourceName === 'string' ? body.sourceName.slice(0, 80) : 'Suwayomi',
    };
    /*
     * The stored chapter is cleared, not kept.
     *
     * It was MangaUpdates' number and the source's is about to replace it — and
     * the two routinely disagree by twenty chapters. Leaving the old one would
     * make the next sweep compare a source number against a MangaUpdates number
     * and raise a nudge for every chapter in between.
     */
    series.latestChapter = null;
    series.sourceChapter = null;
    series.sourceCheckedAt = null;
    series.checkedAt = null;

    /*
     * Ask MangaUpdates once, here, and never again for this series.
     *
     * A linked series stops polling them, so without this the "N written"
     * context is lost the moment you link — which real use showed immediately:
     * a series linked before its first check had no total at all, and the row
     * lost the one number that says how much of the work a source is carrying.
     *
     * One request at link time is not the per-sweep cost that rule was avoiding,
     * and a failure is ignored rather than blocking the link: the context is a
     * nicety and the link is the thing you asked for.
     */
    if (series.muId !== null && series.totalChapters === null) {
      try {
        series.totalChapters = (await readSeries(series.muId)).totalChapters;
      } catch {
        // Left null. The row simply says less.
      }
    }

    write(store);

    return seriesSummary(series);
  });

  // Not local-only either, for the same reason as linking.
  app.delete('/api/manga/:id/source', async (request, reply) => {
    const { id } = request.params as { id: string };
    const store = read();
    const series = store.series.find((s) => s.id === id);
    if (!series) return reply.code(404).send({ error: 'no such series' });

    series.source = null;
    series.sourceChapter = null;
    series.sourceCheckedAt = null;
    // Same reasoning as linking, in the other direction.
    series.latestChapter = null;
    series.checkedAt = null;
    write(store);
    return seriesSummary(series);
  });

  /**
   * Which languages a search asks.
   *
   * Its own route rather than part of `PUT /api/manga/source`, because that one
   * is local-only — it sets an address the server then POSTs to — and this sets
   * nothing of the kind. Choosing which of your sources are searched is a
   * reading preference, and belongs on the phone as much as the PC.
   */
  app.put('/api/manga/languages', async (request, reply) => {
    const body = request.body as { languages?: unknown } | null;
    if (!Array.isArray(body?.languages)) return reply.code(400).send({ error: 'send a list of languages' });

    const languages = [
      ...new Set(
        body.languages
          .filter((l): l is string => typeof l === 'string')
          .map((l) => l.trim())
          // Extension language codes are short tags like `en` or `pt-BR`.
          .filter((l) => /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(l))
      ),
    ].slice(0, 30);

    const store = read();
    write({ ...store, readLanguages: languages });
    return { languages };
  });

  /* ---- Suwayomi's own UI, inside this app ---- */

  /**
   * Mint the cookie that lets the frame talk to the proxy.
   *
   * An ordinary authenticated `/api/` call, so the bearer token is still what
   * proves who you are — the cookie only carries that proof somewhere a header
   * cannot go. See `uiproxy.ts` for why a cookie and not a path token.
   *
   * **Not local-only**, unlike changing the source. Opening the UI is reading
   * and managing *your* library, which is the whole point of wanting it on a
   * phone; it changes nothing about which machine runs what.
   */
  app.post('/api/manga/ui-session', async (request, reply) => {
    const store = read();
    const url = effectiveUrl(store, DEFAULT_BASE_URL);
    if (!url) return reply.code(400).send({ error: 'no source is configured' });

    if (store.manageSuwayomi && store.suwayomiJar) {
      const state = await suwayomiProcess.ensureRunning(store.suwayomiJar, url, store.suwayomiMode);
      if (state.state !== 'running') {
        return reply.code(502).send({ error: state.state === 'failed' ? state.problem : 'Suwayomi is still starting' });
      }
    }

    const { token, maxAgeSeconds } = mintSession();
    /*
     * `Secure` only when the request actually arrived over TLS. Set
     * unconditionally it would be rejected over plain http to a tailnet address;
     * behind `tailscale serve` the app sees loopback http, so the forwarded
     * protocol is what tells the truth about the browser's connection.
     */
    const secure = request.protocol === 'https' || request.headers['x-forwarded-proto'] === 'https';
    return reply.header('set-cookie', sessionCookie(token, maxAgeSeconds, secure)).send({ path: `${UI_PREFIX}/` });
  });

  registerUiProxy(app, {
    target: () => effectiveUrl(read(), DEFAULT_BASE_URL),
    ensure: async () => {
      const store = read();
      if (!store.manageSuwayomi || !store.suwayomiJar) return true;
      const url = effectiveUrl(store, DEFAULT_BASE_URL);
      if (!url) return false;
      const state = await suwayomiProcess.ensureRunning(store.suwayomiJar, url, store.suwayomiMode);
      return state.state === 'running';
    },
  });

  /* ---- extensions ---- */

  /**
   * The source, for the extension screen.
   *
   * Extensions are **not** a `SourceAdapter` method — they are a capability an
   * adapter may also have, and `supportsExtensions` asks rather than assumes.
   * An adapter that talks to one site has nothing to install, and its screen
   * should say so instead of erroring.
   */
  type CatalogueContext =
    | { error: string; code: 400 | 502 }
    | { adapter: SuwayomiAdapter & ExtensionCatalogue; store: Store };

  // Annotated for the same reason `reader()` is: without it TypeScript widens
  // the two shapes into one object with every field optional, and `ctx.code`
  // arrives as `number | undefined`.
  async function catalogue(): Promise<CatalogueContext> {
    const store = read();
    const url = effectiveUrl(store, DEFAULT_BASE_URL);
    if (!url) return { error: 'no source is configured', code: 400 as const };

    if (store.manageSuwayomi && store.suwayomiJar) {
      const state = await suwayomiProcess.ensureRunning(store.suwayomiJar, url, store.suwayomiMode);
      if (state.state !== 'running') {
        return { error: state.state === 'failed' ? state.problem : 'Suwayomi is still starting', code: 502 as const };
      }
    }

    const adapter = new SuwayomiAdapter(url);
    if (!supportsExtensions(adapter)) return { error: 'this source does not manage extensions', code: 400 as const };
    return { adapter, store };
  }

  /**
   * Everything the repositories offer, and where they are listed from.
   *
   * `?refresh=1` re-reads the repos, which fetches a large index — so the screen
   * shows the stored list and refreshing is a button.
   */
  app.get('/api/manga/extensions', async (request, reply) => {
    const { refresh } = request.query as { refresh?: string };
    const ctx = await catalogue();
    if ('error' in ctx) return reply.code(ctx.code).send({ error: ctx.error });

    try {
      const [extensions, repos] = await Promise.all([ctx.adapter.extensions(refresh === '1'), ctx.adapter.repos()]);
      return {
        extensions,
        repos,
        /*
         * Offered by name, because a fresh Suwayomi ships with no repositories
         * and finds nothing — which is the commonest confusing first experience
         * here, and not one anybody should have to solve by going and finding a
         * URL.
         */
        suggestedRepo: KEIYOUSHI_REPO,
      };
    } catch (error) {
      if (error instanceof SourceError) return reply.code(502).send({ error: error.message });
      throw error;
    }
  });

  /** Install one, or remove it. Local-only, like everything that runs code here. */
  app.put('/api/manga/extensions/:pkg', async (request, reply) => {
    localOnly(request as unknown as { isLocal: boolean });
    const { pkg } = request.params as { pkg: string };
    const body = request.body as { install?: unknown } | null;
    const ctx = await catalogue();
    if ('error' in ctx) return reply.code(ctx.code).send({ error: ctx.error });

    try {
      if (body?.install === false) await ctx.adapter.uninstallExtension(pkg);
      else await ctx.adapter.installExtension(pkg);
      // Answered with the fresh list so the row updates from its own response
      // rather than a second request.
      return { extensions: await ctx.adapter.extensions(false) };
    } catch (error) {
      if (error instanceof SourceError) return reply.code(502).send({ error: error.message });
      throw error;
    }
  });

  /**
   * Which repositories to list from.
   *
   * Local-only: a repository is a URL the *source* then downloads and runs code
   * from, which is a larger thing than any other setting here and belongs with
   * installing a package.
   */
  app.put('/api/manga/extensions/repos', async (request, reply) => {
    localOnly(request as unknown as { isLocal: boolean });
    const body = request.body as { repos?: unknown } | null;
    if (!Array.isArray(body?.repos)) return reply.code(400).send({ error: 'send a list of repositories' });

    const repos: string[] = [];
    for (const raw of body.repos) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      let parsed: URL;
      try {
        parsed = new URL(raw.trim());
      } catch {
        return reply.code(400).send({ error: `not a URL: ${String(raw).slice(0, 80)}` });
      }
      if (parsed.protocol !== 'https:') {
        // https only, unlike the Suwayomi address itself. That one is usually
        // loopback; this is a URL something downloads executable extensions
        // from, and over plain http anybody on the path chooses what runs.
        return reply.code(400).send({ error: 'repositories must be https' });
      }
      repos.push(parsed.toString());
    }

    const ctx = await catalogue();
    if ('error' in ctx) return reply.code(ctx.code).send({ error: ctx.error });

    try {
      const saved = await ctx.adapter.setRepos(repos);
      return { repos: saved, extensions: await ctx.adapter.extensions(true) };
    } catch (error) {
      if (error instanceof SourceError) return reply.code(502).send({ error: error.message });
      throw error;
    }
  });

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
    return { store, adapter: new SuwayomiAdapter(url), url };
  }

  const SOURCE_ID = /^\d{1,25}$/;

  /**
   * What a result looks like to the screen: a cover it can fetch, and whether
   * you already follow it — by this exact copy, or by a series of the same name
   * from anywhere.
   */
  function present<T extends SourceMatch>(store: Store, match: T) {
    const series = store.series.find(
      (s) =>
        (s.source?.mangaId === match.id && s.source?.sourceName === match.sourceName) ||
        groupKey(s.title) === groupKey(match.title) ||
        (s.source !== null && groupKey(s.source.title) === groupKey(match.title))
    );
    return {
      ...match,
      coverPath: thumbPath(match.thumbnailUrl),
      following: series?.id ?? null,
      /*
       * Followed, but with nowhere to read it yet. The screen then offers to
       * read it *from here* — which links this source to the series you have —
       * rather than a Read button onto a chapter list that cannot exist.
       */
      unlinked: series !== undefined && series.source === null,
    };
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
      const selected = sources.find((s) => s.id === ctx.store.browseSource)?.id ?? sources[0]?.id ?? null;
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
    if (typeof body?.id !== 'string' || !SOURCE_ID.test(body.id)) return reply.code(400).send({ error: 'which source?' });
    const store = read();
    store.browseSource = body.id;
    write(store);
    return { selected: store.browseSource };
  });

  /** One page of a source's popular list or its newest releases. */
  app.get('/api/manga/browse/list', async (request, reply) => {
    const { source, type, page } = request.query as { source?: string; type?: string; page?: string };
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
      return { results: got.matches.map((m) => present(ctx.store, m)), hasNextPage: got.hasNextPage, page: n };
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
        ranked.map((m) => present(ctx.store, m)),
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
        .header('cache-control', 'private, max-age=86400')
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

    const existing = best ? findExisting(store, best) : undefined;
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
      write(store);
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
    // One MangaUpdates read for the "N written" context, as linking does —
    // after this the series is watched through its source.
    if (series.muId !== null) {
      try {
        series.totalChapters = (await readSeries(series.muId)).totalChapters;
      } catch {
        // Left null. The row simply says less.
      }
    }
    store.series.push(series);
    write(store);
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
      return {
        ...details,
        // Only a link a person can follow: the site's own http(s) page.
        url: details.url && /^https?:\/\//i.test(details.url) ? details.url : null,
        coverPath: thumbPath(details.thumbnailUrl),
        following,
        unlinked,
        chapters: [...chapters].sort((a, b) => b.number - a.number),
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
    const { p } = request.query as { p?: string };
    if (!p || !/^\/api\/v1\/manga\/\d+\/chapter\/\d+\/page\/\d+$/.test(p)) {
      return reply.code(400).send({ error: 'not a page' });
    }
    const ctx = await ready();
    if ('error' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    try {
      const response = await fetch(`${ctx.url}${p}`, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) return reply.code(502).send({ error: `the source answered ${response.status}` });
      return reply
        .header('content-type', response.headers.get('content-type') ?? 'image/jpeg')
        .header('cache-control', 'private, max-age=604800')
        .send(Buffer.from(await response.arrayBuffer()));
    } catch {
      return reply.code(502).send({ error: 'could not fetch the page' });
    }
  });

  /* ---- reading ---- */

  /**
   * The source, started if we manage it and it is not up.
   *
   * Everything under here is something you did on purpose — opening a chapter
   * list, turning a page — so it is allowed to spend the JVM's startup. The
   * sweep is the one caller that deliberately does not.
   */
  type ReaderContext =
    | { error: string; code: 400 | 404 | 502 }
    | { store: Store; series: Series; adapter: SuwayomiAdapter; url: string };

  /*
   * Annotated rather than inferred. Without it TypeScript widens the two return
   * shapes into one object with every field optional, so `ctx.code` arrives as
   * `number | undefined` and the `'error' in ctx` check narrows nothing.
   */
  async function reader(seriesId: string): Promise<ReaderContext> {
    const store = read();
    const series = store.series.find((s) => s.id === seriesId);
    if (!series) return { error: 'no such series', code: 404 as const };
    if (!series.source) return { error: 'this series is not linked to a source', code: 400 as const };

    const url = effectiveUrl(store, DEFAULT_BASE_URL);
    if (!url) return { error: 'no source is configured', code: 400 as const };

    if (store.manageSuwayomi && store.suwayomiJar) {
      const state = await suwayomiProcess.ensureRunning(store.suwayomiJar, url, store.suwayomiMode);
      if (state.state !== 'running') {
        return { error: state.state === 'failed' ? state.problem : 'Suwayomi is still starting', code: 502 as const };
      }
    } else {
      // Not managed, so nothing to start — but the idle timer still wants to
      // know this is in use, in case management is switched on later.
      suwayomiProcess.touch(store.suwayomiMode);
    }

    return { store, series, adapter: new SuwayomiAdapter(url), url };
  }

  /**
   * The chapter list, from the source's own cache.
   *
   * `?refresh=1` goes and asks the site again. Off by default because opening a
   * list should not scrape a website — that is seconds of latency and a request
   * to somebody else's server for a screen you may only be glancing at.
   */
  app.get('/api/manga/:id/chapters', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { refresh } = request.query as { refresh?: string };
    const ctx = await reader(id);
    if ('error' in ctx) return reply.code(ctx.code).send({ error: ctx.error });

    try {
      const chapters = await ctx.adapter.chapters(ctx.series.source!.mangaId, refresh === '1');
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
  app.get('/api/manga/:id/chapters/:chapterId/pages', async (request, reply) => {
    const { id, chapterId } = request.params as { id: string; chapterId: string };
    const ctx = await reader(id);
    if ('error' in ctx) return reply.code(ctx.code).send({ error: ctx.error });

    try {
      const pages = await ctx.adapter.pages(chapterId);
      return {
        pages: pages.map((path) => `/api/manga/${id}/page?p=${encodeURIComponent(path)}`),
      };
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
    const { p } = request.query as { p?: string };
    if (!p || !/^\/api\/v1\/manga\/\d+\/chapter\/\d+\/page\/\d+$/.test(p)) {
      return reply.code(400).send({ error: 'not a page' });
    }

    const ctx = await reader(id);
    if ('error' in ctx) return reply.code(ctx.code).send({ error: ctx.error });

    try {
      const response = await fetch(`${ctx.url}${p}`, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) return reply.code(502).send({ error: `the source answered ${response.status}` });
      return reply
        .header('content-type', response.headers.get('content-type') ?? 'image/jpeg')
        // A page never changes once it exists, and a reader fetches it again on
        // every revisit — so this is the one image here worth caching hard.
        .header('cache-control', 'private, max-age=604800')
        .send(Buffer.from(await response.arrayBuffer()));
    } catch {
      return reply.code(502).send({ error: 'could not fetch the page' });
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
    const body = request.body as { chapter?: unknown; read?: unknown } | null;
    const chapter = typeof body?.chapter === 'number' && Number.isFinite(body.chapter) ? body.chapter : null;
    if (chapter === null) return reply.code(400).send({ error: 'which chapter?' });

    const store = read();
    const series = store.series.find((s) => s.id === id);
    if (!series) return reply.code(404).send({ error: 'no such series' });

    const marked = new Set(series.readChapters);
    if (body?.read === false) marked.delete(chapter);
    else marked.add(chapter);
    series.readChapters = [...marked].sort((a, b) => a - b);

    /*
     * Which source it was read on is the source the series reads from now — the
     * reader only ever serves the linked one, so there is nothing to take from
     * the caller. Re-reading replaces the record rather than adding a second.
     */
    series.readLog = series.readLog.filter((r) => r.chapter !== chapter);
    if (body?.read !== false) {
      series.readLog.push({
        chapter,
        source: series.source?.sourceName ?? null,
        mangaId: series.source?.mangaId ?? null,
        at: Date.now(),
      });
      series.readLog.sort((a, b) => a.chapter - b.chapter);
    }
    write(store);

    // Finishing the chapter you were partway through, or a later one, settles
    // the place: "continue" would otherwise point back into something done.
    const place = readPositions()[id];
    if (body?.read !== false && place && place.chapter <= chapter) writePosition(id, null);

    /*
     * Reading a chapter answers the nudge about it. With a task, ticking the
     * task off did this through `freshenForDelivery`; with tasks switched off
     * this is the only route, so a chapter read on the phone mid-match is not
     * announced at the next stopping point. Only a nudge still waiting —
     * `expired` is what happened to it, the state freshening uses too.
     */
    if (body?.read !== false) {
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

    return { readChapters: series.readChapters };
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

    const series = read().series.find((s) => s.id === id);
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
      at: Date.now(),
    };
    const before = writePosition(id, position);
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

  /* ---- the timer ---- */

  const sweep = async () => {
    try {
      await sweepReleases();
    } catch (error) {
      // Never allowed to escape. This runs with nobody waiting on it, and an
      // unhandled rejection would take the server down over somebody else's
      // service being briefly unreachable.
      app.log.warn({ err: error }, 'manga release sweep failed');
    }
  };

  /*
   * `always` starts shortly after the app, not with it.
   *
   * A delayed, `unref`ed timer rather than a call at registration, which is the
   * same idiom the coursework sweep uses and for a sharper reason here: `smoke`
   * and `features-check` build an app, assert and close it, and a JVM spawned at
   * registration would be started by every one of those runs. Nothing
   * short-lived reaches twenty seconds, and `onClose` stops it if anything does.
   *
   * It stays off in `on-demand`, which is the default — a fresh install spawns
   * nothing whatever this file does.
   */
  const bootStart = setTimeout(() => {
    const store = read();
    if (!store.manageSuwayomi || store.suwayomiMode !== 'always' || !store.suwayomiJar) return;
    const url = effectiveUrl(store, DEFAULT_BASE_URL);
    if (!url) return;
    void suwayomiProcess.ensureRunning(store.suwayomiJar, url, 'always').catch(() => {
      // Recorded on the process state and shown on the card. Never thrown: this
      // runs with nobody waiting on it.
    });
  }, 20_000);
  bootStart.unref();

  // Shortly after boot as well as on the interval, or a restart means half an
  // hour of not knowing about anything published while the machine was off.
  const firstRun = setTimeout(() => void sweep(), 45_000);
  const repeat = setInterval(() => void sweep(), SWEEP_EVERY_MS);
  // Neither may hold the process open — `smoke` and `features-check` build an
  // app, assert, and close it, and a live interval would leave them hanging.
  firstRun.unref();
  repeat.unref();
  app.addHook('onClose', () => {
    clearTimeout(bootStart);
    clearTimeout(firstRun);
    clearInterval(repeat);
    /*
     * Suwayomi goes down with us. A surviving child would hold port 4567 with
     * nobody owning it, and the next start would fail against a server that
     * cannot be stopped from inside the app — the opposite requirement to the
     * tray's, whose children must outlive the process that spawned them.
     */
    suwayomiProcess.stop();
  });
}
