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
 *
 * ### Where the routes are
 *
 * In `routes/`, one file per group, registered below in the order they were
 * written. What several groups share is `routes/shared.ts`.
 */
import type { FastifyInstance } from 'fastify';
import { isGuest } from '@everything/server/module-api';
import { fetchPagesThroughHost, PageFetchError } from './page-fetch.js';
import { read, write } from './library.js';
import { sweepReleases, SWEEP_EVERY_MS } from './releases.js';
import { effectiveUrl } from './sources.js';
import { DEFAULT_BASE_URL } from './suwayomi.js';
import { suwayomiProcess, portOf, whenSuwayomiUp } from './process.js';
import { fillTags } from './tags.js';
import { updateExtensionsIfDue } from './setup.js';
import { mendEditions, sweepArchive } from './archive.js';
import { retitleFromSource } from './titles.js';
import { archiveTools, autoKeep, hostFetch, useLogger, workArchive } from './routes/shared.js';
import { libraryRoutes } from './routes/library.js';
import { sourceRoutes } from './routes/source.js';
import { extensionRoutes } from './routes/extensions.js';
import { browseRoutes } from './routes/browse.js';
import { readingRoutes } from './routes/reading.js';
import { archiveRoutes } from './routes/archive.js';
import { hostRoutes } from './routes/host.js';
import { flaresolverrRoutes } from './routes/flaresolverr.js';
import { configureSuwayomiFlare, stopFlare, stopLeftover } from './flaresolverr.js';
import { autoSwitch } from './find-sources.js';

export async function routes(app: FastifyInstance): Promise<void> {
  /*
   * A friend's copy fetches pages through the host (`/api/manga/host/page`),
   * so a page the host or another copy is already fetching is fetched once.
   * See `sharedPage` in page-fetch.ts. The host's retries happen there; this
   * waits long enough for them.
   */
  if (isGuest) {
    fetchPagesThroughHost(async (path, fresh) => {
      const response = await hostFetch(
        `/api/manga/host/page?p=${encodeURIComponent(path)}${fresh ? '&fresh=1' : ''}`,
        {},
        150_000
      );
      if ('error' in response) throw new PageFetchError(response.error, null);
      if (!response.ok) {
        const said = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new PageFetchError(said?.error ?? `the host answered ${response.status}`, response.status);
      }
      return { body: Buffer.from(await response.arrayBuffer()), type: response.headers.get('content-type') ?? 'image/jpeg' };
    });
  }

  /*
   * Series linked before linking renamed anything keep the name they arrived
   * with. One pass at startup gives them their source's name under the same
   * rule as a fresh link — see `titles.ts` — and does nothing on every start
   * after, since a renamed series already matches its source.
   */
  /*
   * Kept series saved two editions of a chapter where the source lists two,
   * into one folder; once at startup, down to one. See `mendManifest`.
   */
  if (!isGuest) {
    const mended = mendEditions();
    if (mended.series > 0) app.log.info(mended, 'manga: kept one edition of each kept chapter');
  }

  {
    const store = read();
    const renamed = store.series.filter((series) => retitleFromSource(series));
    if (renamed.length > 0) {
      write(store);
      app.log.info({ renamed: renamed.map((s) => s.title) }, 'manga: renamed series after their sources');
    }
  }

  /** What you read in Manga Reader, searched by title — see `old-history.ts`. */

  useLogger(app.log);

  libraryRoutes(app);
  sourceRoutes(app);
  extensionRoutes(app);
  browseRoutes(app);
  readingRoutes(app);
  archiveRoutes(app);
  hostRoutes(app);
  flaresolverrRoutes(app);
  // One a killed server left running is stopped now; Suwayomi learns this run's door each time it comes up.
  stopLeftover();
  whenSuwayomiUp(configureSuwayomiFlare);

  /* ---- the timer ---- */

  /** Sites asked for genres per sweep; Suwayomi's own copy answers the rest for free. */
  const TAGS_PER_SWEEP = 20;

  const sweep = async () => {
    try {
      await sweepReleases();
      // A few series whose sources have failed for two days, switched to another that has them — see `autoSwitch`.
      await autoSwitch().catch(() => 0);
      // A few series' genres each sweep, only while Suwayomi is up — see `tags.ts`.
      await fillTags(TAGS_PER_SWEEP);
      // Extensions, once a day, only while Suwayomi is up — see `updateExtensionsIfDue`.
      await updateExtensionsIfDue().catch(() => undefined);
      /*
       * And anything new for an archived series, queued and then fetched.
       *
       * Here rather than on an interval of its own: the process is already
       * awake for the sweep, and this project requires a timer to justify
       * itself against the attention loop's numbers. An install with nothing
       * archived does no work at all — `sweepArchive` returns on an empty
       * list before it asks anything.
       */
      await sweepArchive(archiveTools());
      // The Local collection's own rules: favourites, and what you rated highly.
      await autoKeep();
      workArchive();
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
     *
     * The port is passed for the one case the process cannot know it: a JVM
     * adopted after a restart that nothing has asked anything of yet. Only
     * while the app manages Suwayomi — one you run yourself is not ours to stop.
     *
     * **Deliberately not forced.** This is the line that killed the running
     * app's Suwayomi every time the smoke suite closed its own app: the suite
     * adopts whatever is on 4567 and this then stopped it. `stop` now declines
     * unless this server holds the claim, so a second server tidies up after
     * itself and leaves the first one's JVM alone.
     */
    const store = read();
    const url = store.manageSuwayomi ? effectiveUrl(store, DEFAULT_BASE_URL) : null;
    suwayomiProcess.stop(url ? portOf(url) : undefined);
    // FlareSolverr too, always: it is ours alone, and nothing else would stop it.
    stopFlare();
  });
}
