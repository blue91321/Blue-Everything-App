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
import { search, fetchCover, MangaDexError } from './mangadex.js';
import { CREDIT } from './mangaupdates.js';
import { read, write, newSeries, findExisting, type Series } from './library.js';
import { seriesSummary, recentReleases } from './present.js';
import { sweepReleases, pollable, SWEEP_EVERY_MS } from './releases.js';
import { SourceError } from './sources.js';
import { SuwayomiAdapter, DEFAULT_BASE_URL } from './suwayomi.js';
import { suwayomiProcess, findJars } from './process.js';
import { homedir } from 'node:os';

export async function routes(app: FastifyInstance): Promise<void> {
  /** The library, already shaped for the screen. */
  app.get('/api/manga', async () => {
    const store = read();
    return {
      series: store.series.map(seriesSummary),
      /** What landed lately, for the panel — see `recentReleases`. */
      recent: recentReleases(store),
      /** MangaUpdates asks to be credited for release data. The screen does it. */
      credit: CREDIT,
      /** How many rows the sweep is still watching, so the screen can say so. */
      watching: pollable(store).length,
    };
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
    const { suwayomiUrl, suwayomiJar, manageSuwayomi } = read();
    const managed = suwayomiProcess.state;

    // Only offered when nothing is chosen yet: a scan of Downloads on every
    // poll would be disk work for a question already answered.
    const foundJars = suwayomiJar ? [] : findJars(homedir());

    const base = {
      defaultUrl: DEFAULT_BASE_URL,
      jar: suwayomiJar,
      manage: manageSuwayomi,
      managed,
      foundJars,
    };

    if (!suwayomiUrl) return { ...base, configured: false, url: null, health: null };

    /*
     * Not asked while we are managing it and it is off — that is the ordinary
     * resting state, and reporting it as "unreachable" would make the normal
     * case look broken. The `managed` state above already says what is true.
     */
    if (manageSuwayomi && managed.state !== 'running') {
      return { ...base, configured: true, url: suwayomiUrl, health: null };
    }

    return { ...base, configured: true, url: suwayomiUrl, health: await new SuwayomiAdapter(suwayomiUrl).describe() };
  });

  /** Start it now, and wait until it answers. */
  app.post('/api/manga/source/start', async (request, reply) => {
    localOnly(request as unknown as { isLocal: boolean });
    const { suwayomiJar, suwayomiUrl } = read();
    if (!suwayomiJar) return reply.code(400).send({ error: 'no Suwayomi jar has been chosen' });
    return suwayomiProcess.ensureRunning(suwayomiJar, suwayomiUrl ?? DEFAULT_BASE_URL);
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
    const body = request.body as { url?: unknown; jar?: unknown; manage?: unknown } | null;

    /*
     * The jar and the switch are set through the same route as the URL, and each
     * key is optional — omitted means "leave it", which is the shape the
     * integrations credential form already uses. A single endpoint keeps the
     * three from being saved in an order that briefly makes no sense, such as
     * managing switched on with no jar chosen.
     */
    if (body && ('jar' in body || 'manage' in body)) {
      const store = read();
      const jar = 'jar' in body ? (typeof body.jar === 'string' && body.jar.trim() ? body.jar.trim() : null) : store.suwayomiJar;
      const manage = 'manage' in body ? body.manage === true : store.manageSuwayomi;

      // Switching management on with nothing to run is a setting that could only
      // fail later, so it is refused now with the reason.
      if (manage && !jar) return reply.code(400).send({ error: 'choose a Suwayomi jar first' });
      // Stopped rather than orphaned: turning management off while it is up
      // would leave a JVM nobody owns holding the port.
      if (!manage) suwayomiProcess.stop();

      write({ ...store, suwayomiJar: jar, manageSuwayomi: manage });
      if (!('url' in (body ?? {}))) {
        const after = read();
        return {
          configured: Boolean(after.suwayomiUrl),
          url: after.suwayomiUrl,
          defaultUrl: DEFAULT_BASE_URL,
          jar: after.suwayomiJar,
          manage: after.manageSuwayomi,
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
      managed: suwayomiProcess.state,
      foundJars: after.suwayomiJar ? [] : findJars(homedir()),
      health,
    };
  }

  /** Find this series in the source's own catalogue, so it can be linked. */
  app.get('/api/manga/:id/source/search', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { q } = request.query as { q?: string };
    const store = read();
    const series = store.series.find((s) => s.id === id);
    if (!series) return reply.code(404).send({ error: 'no such series' });
    if (!store.suwayomiUrl) return reply.code(400).send({ error: 'no source is configured' });

    // Defaults to the series' own title, because that is what you want in nine
    // cases out of ten and typing it again is a chore.
    const query = (typeof q === 'string' && q.trim()) || series.title;

    /*
     * This is the "on demand" in on-demand: searching sources is something you
     * pressed a button to do, so it is allowed to spend the ten seconds of JVM
     * startup. The sweep deliberately is not.
     */
    if (store.manageSuwayomi && store.suwayomiJar) {
      const state = await suwayomiProcess.ensureRunning(store.suwayomiJar, store.suwayomiUrl ?? DEFAULT_BASE_URL);
      if (state.state !== 'running') {
        return reply.code(502).send({ error: state.state === 'failed' ? state.problem : 'Suwayomi is still starting' });
      }
    }

    try {
      return { results: await new SuwayomiAdapter(store.suwayomiUrl).search(query) };
    } catch (error) {
      if (error instanceof SourceError) return reply.code(502).send({ error: error.message });
      throw error;
    }
  });

  /** Point a series at one of those results. */
  app.put('/api/manga/:id/source', async (request, reply) => {
    localOnly(request as unknown as { isLocal: boolean });
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
    write(store);

    return seriesSummary(series);
  });

  app.delete('/api/manga/:id/source', async (request, reply) => {
    localOnly(request as unknown as { isLocal: boolean });
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

  // Shortly after boot as well as on the interval, or a restart means half an
  // hour of not knowing about anything published while the machine was off.
  const firstRun = setTimeout(() => void sweep(), 45_000);
  const repeat = setInterval(() => void sweep(), SWEEP_EVERY_MS);
  // Neither may hold the process open — `smoke` and `features-check` build an
  // app, assert, and close it, and a live interval would leave them hanging.
  firstRun.unref();
  repeat.unref();
  app.addHook('onClose', () => {
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
