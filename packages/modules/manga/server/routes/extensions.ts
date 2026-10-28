/**
 * Suwayomi's own interface inside the app, and its extensions: installing, updating, and a guest asking for one.
 *
 * Registered by `routes` in `../index.ts`, in this order with the other groups.
 */
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db, changes, devices, isGuest, nameFor } from '@everything/server/module-api';
import { read, write, type Store } from '../library.js';
import { SourceError, effectiveUrl, supportsExtensions, type ExtensionCatalogue } from '../sources.js';
import { SuwayomiAdapter, DEFAULT_BASE_URL, KEIYOUSHI_REPO } from '../suwayomi.js';
import { suwayomiProcess } from '../process.js';
import { extensionUsage, readAskedBy, readFlags, setFlag, type ExtensionUsage } from '../extension-usage.js';
import { extensionCheck, extensionNote, noteExtensionCheck, updateWaitingExtensions } from '../setup.js';
import { registerUiProxy, mintSession, sessionCookie, UI_PREFIX } from '../uiproxy.js';
import { GUEST_SOURCES, askHost } from './shared.js';

export function extensionRoutes(app: FastifyInstance): void {
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
    // Suwayomi's own interface installs extensions and sets repositories, which
    // are the host's to do; a guest copy has no way in to it.
    if (isGuest) return reply.code(403).send({ error: GUEST_SOURCES });
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

  if (!isGuest) registerUiProxy(app, {
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
      /*
       * How much each installed one is used, and its sources, for the list to
       * sort by and to open Browse on. A detail: if Suwayomi will not say which
       * source is whose, the list is drawn without the counts.
       */
      let usage: Record<string, ExtensionUsage> = {};
      try {
        const sources = await new SuwayomiAdapter(effectiveUrl(ctx.store, DEFAULT_BASE_URL)!).sourcesWithExtension();
        usage = extensionUsage(ctx.store.series, ctx.store.glimpses, sources);
      } catch {
        // Drawn without them.
      }
      return {
        extensions,
        repos,
        usage,
        flagged: readFlags(),
        // Which guest copies asked for each flagged one (the host's screen).
        askedBy: Object.fromEntries(
          Object.entries(readAskedBy()).map(([pkg, who]) => [pkg, who.map((n) => nameFor(n, 'you'))])
        ),
        // A guest asks for sources; the host installs them (plan A).
        onHost: isGuest,
        readLanguages: ctx.store.readLanguages,
        autoUpdate: ctx.store.autoUpdateExtensions,
        lastCheck: extensionCheck(),
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

  /**
   * Flag one to install later, or unflag it. **Not local-only**, unlike
   * installing: a flag is a note on a list and runs nothing, which is what lets
   * a phone, where installing is refused, still ask for a source.
   */
  app.put('/api/manga/extensions/:pkg/flag', async (request, reply) => {
    const { pkg } = request.params as { pkg: string };
    const body = request.body as { flagged?: unknown } | null;
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(pkg)) return reply.code(400).send({ error: 'not an extension' });
    if (typeof body?.flagged !== 'boolean') return reply.code(400).send({ error: 'flagged is true or false' });
    /*
     * On a guest copy the ask goes to the host, whose Suwayomi it is, and is
     * kept here too so this screen can say it was asked.
     */
    if (isGuest) {
      const asked = await askHost('/api/manga/host/requests', { pkg, flagged: body.flagged });
      if ('error' in asked) return reply.code(502).send({ error: asked.error });
    }
    return { flagged: setFlag(pkg, body.flagged) };
  });

  /* ---- what guest copies ask of the host (plan A) ---- */

  /**
   * Wake the host's Suwayomi for a guest copy and wait until it answers.
   *
   * Only for a copy's key (`instance`), or this PC. A guest's reading also
   * counts as somebody using it, so this pushes the idle deadline out.
   */
  app.post('/api/manga/host/wake', async (request, reply) => {
    if (isGuest) return reply.code(404).send({ error: 'only the host runs Suwayomi' });
    const from = request as unknown as { isLocal: boolean; deviceKind: string | null };
    if (!from.isLocal && from.deviceKind !== 'instance') return reply.code(403).send({ error: 'only for copies on this PC' });
    const store = read();
    const url = effectiveUrl(store, DEFAULT_BASE_URL);
    if (!url) return reply.code(400).send({ error: 'the host has no source configured' });
    if (!store.manageSuwayomi || !store.suwayomiJar) {
      // Run by hand: nothing to start, so say whether it answers.
      const reachable = (await new SuwayomiAdapter(url).describe()).reachable;
      return { state: reachable ? { state: 'running', since: Date.now(), pid: null } : { state: 'off' } };
    }
    const state = await suwayomiProcess.ensureRunning(store.suwayomiJar, url, store.suwayomiMode);
    if (state.state === 'running') suwayomiProcess.touch(store.suwayomiMode);
    return { state };
  });

  /**
   * A guest copy asking for a source, or taking the ask back. Recorded as a
   * flag with the copy's name, which Manage extensions here lists at the top
   * with Install and Unflag.
   */
  app.post('/api/manga/host/requests', async (request, reply) => {
    if (isGuest) return reply.code(404).send({ error: 'only the host keeps the requests' });
    const from = request as unknown as { deviceKind: string | null; deviceId: string | null };
    if (from.deviceKind !== 'instance' || !from.deviceId) return reply.code(403).send({ error: 'only for copies on this PC' });
    const body = request.body as { pkg?: unknown; flagged?: unknown } | null;
    const pkg = typeof body?.pkg === 'string' ? body.pkg : '';
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(pkg)) return reply.code(400).send({ error: 'not an extension' });
    if (typeof body?.flagged !== 'boolean') return reply.code(400).send({ error: 'flagged is true or false' });
    const [device] = await db.select({ name: devices.name }).from(devices).where(eq(devices.id, from.deviceId));
    const by = (device?.name ?? 'a copy').replace(/^copy: /, '');
    if (body.flagged) setFlag(pkg, true, by);
    else {
      // Taking back one's own ask: the flag goes only if nobody else asked.
      const others = (readAskedBy()[pkg] ?? []).filter((n) => n !== by);
      setFlag(pkg, false);
      if (others.length > 0) for (const name of others) setFlag(pkg, true, name);
    }
    changes.emitChange('all');
    return { ok: true };
  });

  /**
   * Install one, remove it, or update it (`{ update: true }`).
   *
   * **From any device, not only the PC.** It used to be local-only on the
   * grounds that an extension is code that runs here, with a phone left to
   * flag one for the PC to install. But the phone already reaches Suwayomi's
   * own web interface through More (`/manga/ui`), which installs extensions
   * with no such rule, so the guard protected nothing and only added a trip.
   * What a device may reach is decided by the token it was paired with, here
   * as everywhere else.
   */
  app.put('/api/manga/extensions/:pkg', async (request, reply) => {
    if (isGuest) return reply.code(403).send({ error: GUEST_SOURCES });
    const { pkg } = request.params as { pkg: string };
    const body = request.body as { install?: unknown; update?: unknown } | null;
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(pkg)) return reply.code(400).send({ error: 'not an extension' });
    const ctx = await catalogue();
    if ('error' in ctx) return reply.code(ctx.code).send({ error: ctx.error });

    try {
      if (body?.update === true) await ctx.adapter.updateExtension(pkg);
      else if (body?.install === false) await ctx.adapter.uninstallExtension(pkg);
      else {
        await ctx.adapter.installExtension(pkg);
        // Flagged on the phone and now installed: the note has done its job.
        if (readFlags().includes(pkg)) setFlag(pkg, false);
      }
      // Answered with the fresh list so the row updates from its own response
      // rather than a second request.
      return { extensions: await ctx.adapter.extensions(false) };
    } catch (error) {
      if (error instanceof SourceError) return reply.code(502).send({ error: error.message });
      throw error;
    }
  });

  /**
   * Update every installed extension that has an update, now.
   *
   * The daily run's own function, so the button and the automatic update
   * cannot disagree about what "updated" means, and the note it leaves is the
   * one the setup card and this screen both show.
   */
  app.post('/api/manga/extensions/update', async (_request, reply) => {
    if (isGuest) return reply.code(403).send({ error: GUEST_SOURCES });
    const ctx = await catalogue();
    if ('error' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    const run = await updateWaitingExtensions(ctx.adapter);
    noteExtensionCheck(run);
    if (run.updated.length > 0) changes.emitChange('all');
    return { note: extensionNote(run), extensions: await ctx.adapter.extensions(false) };
  });

  /** Whether extensions update themselves once a day. */
  app.put('/api/manga/extensions/auto-update', async (request, reply) => {
    if (isGuest) return reply.code(403).send({ error: GUEST_SOURCES });
    const body = request.body as { on?: unknown } | null;
    if (typeof body?.on !== 'boolean') return reply.code(400).send({ error: 'on is true or false' });
    const store = read();
    store.autoUpdateExtensions = body.on;
    write(store);
    return { autoUpdate: store.autoUpdateExtensions };
  });

  /**
   * Which repositories to list from.
   *
   * From any device, like installing, and for the same reason: Suwayomi's own
   * interface, which the phone already reaches through More, sets these too.
   * Still https only, below.
   */
  app.put('/api/manga/extensions/repos', async (request, reply) => {
    if (isGuest) return reply.code(403).send({ error: GUEST_SOURCES });
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
}
