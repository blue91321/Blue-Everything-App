/**
 * Where chapters come from: the Suwayomi it talks to, starting and setting it up, and linking a series to a source.
 *
 * Registered by `routes` in `../index.ts`, in this order with the other groups.
 */
import type { FastifyInstance } from 'fastify';
import { and } from 'drizzle-orm';
import { config, isGuest } from '@everything/server/module-api';
import { search } from '../mangadex.js';
import { readSeries } from '../mangaupdates.js';
import { read, write } from '../library.js';
import { seriesSummary } from '../present.js';
import { SourceError, effectiveUrl, profileChapters, judgePages, type PageSample } from '../sources.js';
import { SuwayomiAdapter, DEFAULT_BASE_URL } from '../suwayomi.js';
import { suwayomiProcess, findJars, suwayomiLogPath } from '../process.js';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { extensionCheck, setupState, startSetup } from '../setup.js';
import { retitleFromSource } from '../titles.js';
import { chapterElsewhere, localOnly } from './shared.js';

export function sourceRoutes(app: FastifyInstance): void {
  /* ---- where chapters actually come from ---- */

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
    const url = effectiveUrl(store, DEFAULT_BASE_URL);

    // Only offered when nothing is chosen yet: a scan of Downloads on every
    // poll would be disk work for a question already answered.
    const foundJars = suwayomiJar ? [] : findJars();

    /*
     * Read *after* the health check below, not before.
     *
     * This used to be taken at the top, and the two halves of the answer then
     * came from different places and could disagree — the response said
     * `state: running, pid 16308` beside `could not reach Suwayomi`, about the
     * same JVM, in the same object. The process had been stopped by another
     * server and nothing here had noticed. Asking first and reporting second is
     * what keeps the two from arguing.
     */
    const base = () => ({
      defaultUrl: DEFAULT_BASE_URL,
      readLanguages: store.readLanguages,
      jar: suwayomiJar,
      manage: manageSuwayomi,
      mode: store.suwayomiMode,
      managed: suwayomiProcess.state,
      foundJars,
      // A guest copy uses the host's Suwayomi and sets none of this up itself.
      onHost: isGuest,
    });

    if (!url) return { ...base(), configured: false, url: null, health: null };

    /*
     * Not asked while we are managing it and it is off — that is the ordinary
     * resting state, and reporting it as "unreachable" would make the normal
     * case look broken. The `managed` state already says what is true.
     */
    if (manageSuwayomi && suwayomiProcess.state.state !== 'running') {
      return { ...base(), configured: true, url, health: null };
    }

    const health = await new SuwayomiAdapter(url).describe();
    // Which corrects the claim if it has stopped answering — see `noteReachable`.
    suwayomiProcess.noteReachable(health.reachable);
    return { ...base(), configured: true, url, health };
  });

  /** Start it now, and wait until it answers. */
  app.post('/api/manga/source/start', async (request, reply) => {
    localOnly(request as unknown as { isLocal: boolean });
    const { suwayomiJar, suwayomiUrl } = read();
    if (!suwayomiJar) return reply.code(400).send({ error: 'no Suwayomi jar has been chosen' });
    const { suwayomiMode } = read();
    return suwayomiProcess.ensureRunning(suwayomiJar, suwayomiUrl ?? DEFAULT_BASE_URL, suwayomiMode);
  });

  /**
   * Stop it now, rather than waiting out the idle timer.
   *
   * `force`, unlike every other stop here: this is somebody pressing Stop about
   * the thing on the port, not this server tidying up after itself. It is also
   * the way out of a JVM left behind by a server that went away without
   * releasing its claim, which is the one case nothing else can reach.
   */
  app.post('/api/manga/source/stop', async (request) => {
    localOnly(request as unknown as { isLocal: boolean });
    suwayomiProcess.stop(undefined, { force: true });
    return suwayomiProcess.state;
  });

  /**
   * One press: Java and Suwayomi downloaded into the app's folder, switched on,
   * started, and the extension list added — see `setup.ts`. Local-only: it
   * downloads and runs programs on this machine.
   */
  app.post('/api/manga/source/setup', { config: { announce: false } }, async (request) => {
    localOnly(request as unknown as { isLocal: boolean });
    return startSetup();
  });

  // With when extensions last updated themselves, for the card to say so.
  app.get('/api/manga/source/setup', async () => ({ ...setupState(), lastExtensionCheck: extensionCheck() }));

  /**
   * The end of Suwayomi's log, for the card to show when it will not start —
   * read in the app, so it works from the phone too, rather than a path to go
   * and find. The last 80 lines, which is several launches.
   */
  app.get('/api/manga/source/log', async () => {
    const path = suwayomiLogPath();
    if (!existsSync(path)) return { lines: [], path };
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    return { lines: lines.slice(-80), path };
  });

  /** The whole log, in Notepad, on the PC. Local-only: it opens a window here. */
  app.post('/api/manga/source/log/open', { config: { announce: false } }, async (request, reply) => {
    localOnly(request as unknown as { isLocal: boolean });
    const path = suwayomiLogPath();
    if (!existsSync(path)) return reply.code(404).send({ error: 'there is no log yet — Suwayomi has not been started' });
    spawn('notepad.exe', [path], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
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
      // The installer is the download people pick by mistake, and it is not a
      // jar: said now, rather than as "Invalid or corrupt jarfile" in a log.
      if (jar && !/\.jar$/i.test(jar)) {
        return reply.code(400).send({
          error: 'that is not a .jar — the .msi and .zip are installers. Press "Set up manga" and the app fetches the right file.',
        });
      }
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
          foundJars: after.suwayomiJar ? [] : findJars(),
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
      foundJars: after.suwayomiJar ? [] : findJars(),
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
      const outcome = await new SuwayomiAdapter(sourceUrl, store.ignoredSources.map((s) => s.id)).search(query, {
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
  /**
   * The same chapter, on another source: for the reader, when a page of the
   * chapter you are in will not come.
   *
   * A page that times out inside Suwayomi does not get better by asking again
   * (the Thunder Scans page that started this failed every time while the site
   * itself served it in 0.4s), and sources split a chapter into different
   * pages, so the only real way round one missing page is the whole chapter
   * from somewhere else. Reads are kept by chapter number, so reading it there
   * counts here.
   *
   * Strict, like the import's matching: a result is taken only when its title
   * is the series' title once case, punctuation and bracketed asides are set
   * aside (`titleKey`, with the old names the series has had), because a wrong
   * match would open another series' chapter 64 with nothing saying so. The
   * series' own source is left out, since that is the copy failing.
   *
   * On demand, from a button: it searches every installed source in your
   * languages and then lists chapters on up to six matches, which can take
   * tens of seconds and starts Suwayomi if it is asleep.
   */
  app.get('/api/manga/:id/elsewhere', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { number } = request.query as { number?: string };
    const wanted = Number(number);
    if (!number || !Number.isFinite(wanted)) return reply.code(400).send({ error: 'which chapter?' });

    const store = read();
    const series = store.series.find((s) => s.id === id) ?? store.glimpses.find((g) => g.id === id);
    if (!series) return reply.code(404).send({ error: 'no such series' });
    const url = effectiveUrl(store, DEFAULT_BASE_URL);
    if (!url) return reply.code(400).send({ error: 'no source is configured' });

    if (store.manageSuwayomi && store.suwayomiJar) {
      const state = await suwayomiProcess.ensureRunning(store.suwayomiJar, url, store.suwayomiMode);
      if (state.state !== 'running') {
        return reply.code(502).send({ error: state.state === 'failed' ? state.problem : 'Suwayomi is still starting' });
      }
    }

    try {
      const found = await chapterElsewhere(
        store,
        url,
        { title: series.title, altTitles: 'altTitles' in series ? (series.altTitles ?? []) : [], source: series.source },
        wanted,
        []
      );
      return { options: found.options, searched: found.searched };
    } catch (error) {
      if (error instanceof SourceError) return reply.code(502).send({ error: error.message });
      throw error;
    }
  });

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
    // Found under another name: go by it, when it is one worth having.
    retitleFromSource(series);

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
      let total: number | null = null;
      try {
        total = (await readSeries(series.muId)).totalChapters;
      } catch {
        // Left null. The row simply says less.
      }
      /*
       * The store is read again after that request rather than written as it
       * was before it: anything done in the app during the round trip — a
       * chapter finished on the phone — would otherwise be overwritten by a
       * copy from before it happened. The sweep's lesson, applied here.
       */
      const fresh = read();
      const row = fresh.series.find((s) => s.id === id);
      if (!row) return reply.code(404).send({ error: 'no such series' });
      row.source = series.source;
      row.title = series.title;
      row.altTitles = series.altTitles;
      row.latestChapter = null;
      row.sourceChapter = null;
      row.sourceCheckedAt = null;
      row.checkedAt = null;
      row.totalChapters = total;
      write(fresh);
      return seriesSummary(row);
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
}
