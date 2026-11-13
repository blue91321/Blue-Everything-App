/**
 * What more than one group of manga routes needs.
 *
 * These were closures inside the one `routes` function that held every
 * route; split into files, they are module functions here. The logger is the
 * server's, handed over by `useLogger` when the routes are registered.
 */
import { and } from 'drizzle-orm';
import { changes, config, isGuest, readHostKey } from '@everything/server/module-api';
import { search } from '../mangadex.js';
import { read, type Glimpse, type Series, type Store } from '../library.js';
import { thumbPath } from '../present.js';
import { groupKey } from '../browse.js';
import { SourceError, effectiveUrl, type SourceMatch } from '../sources.js';
import { SuwayomiAdapter, DEFAULT_BASE_URL } from '../suwayomi.js';
import { suwayomiProcess } from '../process.js';
import {
  keptMangaIds,
  runQueue,
  startArchive,
  type ArchiveTools,
  type ChapterToArchive,
} from '../archive.js';
import { titleKey } from '../titles.js';
import { nameKeys, namesFor } from '../names.js';
import type { FastifyBaseLogger } from 'fastify';

let log: FastifyBaseLogger | null = null;
/** Called by `routes` in `../index.ts`, before anything here can run. */
export function useLogger(logger: FastifyBaseLogger): void {
  log = logger;
}
/**
 * When something happened, as a device that was offline says it did.
 *
 * A read or a place queued on the phone with no connection arrives later, and
 * stamping it with the arrival time would let an old place from the train
 * overwrite the newer one you left on the PC. So the device's time is taken —
 * but only within reason: nothing from the future (a phone clock running fast
 * would win every merge forever) and nothing older than a month, beyond which
 * the queue is not a queue.
 */
export function happenedAt(value: unknown): number {
  const now = Date.now();
  if (typeof value !== 'number' || !Number.isFinite(value)) return now;
  if (value > now + 60_000 || value < now - 30 * 24 * 60 * 60_000) return now;
  return Math.min(value, now);
}

/** What a guest copy says when asked to manage sources: they are the host's. */
export const GUEST_SOURCES =
  "Sources are managed on the host's copy, which runs the Suwayomi every copy shares. Ask for one from Manage extensions and the host can add it.";

/**
 * Ask the host something, as this guest copy, with its key. See
 * `instances.ts` in the server for where the key comes from.
 */
export async function hostFetch(path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response | { error: string }> {
  const key = readHostKey();
  if (!key) return { error: "this copy has no key to the host yet; restarting the host's Blue Everything gives it one" };
  try {
    return await fetch(`${config.EVERYTHING_HOST_URL.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${key}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { error: "the host's Blue Everything isn't answering" };
  }
}

export async function askHost(path: string, body: unknown): Promise<{ ok: true } | { error: string }> {
  const response = await hostFetch(path, { method: 'POST', body: JSON.stringify(body) });
  if ('error' in response) return response;
  if (response.ok) return { ok: true };
  const said = (await response.json().catch(() => null)) as { error?: string } | null;
  return { error: `the host said: ${said?.error ?? response.status}` };
}

/** The host's answer as JSON, or what went wrong. */
export async function hostJson<T>(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<T | { error: string; status?: number }> {
  const response = await hostFetch(path, init, timeoutMs);
  if ('error' in response) return response;
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || body === null) return { error: body?.error ?? `the host answered ${response.status}`, status: response.status };
  return body;
}

/**
 * What the host keeps on its disk, by Suwayomi id, for a guest copy: asked at
 * most once a minute. Every page a guest reads checks it, so a series nobody
 * kept costs no request to the host.
 */
let keptOnHost: { at: number; ids: Set<string> } = { at: 0, ids: new Set() };
export async function hostKept(): Promise<Set<string>> {
  if (Date.now() - keptOnHost.at < 60_000) return keptOnHost.ids;
  const got = await hostJson<{ series: Array<{ mangaId: string }> }>('/api/manga/host/archive');
  keptOnHost = { at: Date.now(), ids: 'error' in got ? keptOnHost.ids : new Set(got.series.map((k) => k.mangaId)) };
  return keptOnHost.ids;
}
/** After a guest asks to keep one, so its own screens see it at once. */
export const forgetHostKept = () => {
  keptOnHost = { at: 0, ids: keptOnHost.ids };
};

/** Suwayomi's id for one of this copy's series or glimpses, or null. */
export function mangaIdFor(store: Store, id: string): string | null {
  return (store.series.find((s) => s.id === id) ?? store.glimpses.find((g) => g.id === id))?.source?.mangaId ?? null;
}

/**
 * A chapter on other sources than the series' own: searched by its title in
 * your languages, kept only where the result's title is the series' own once
 * `titleKey` has folded it (or one of its old names), strict for the reason
 * the import was: a loose match is another series' chapter with nothing saying
 * so. Up to six results are asked for their chapter lists, three at a time.
 *
 * Ranked by `around`: how many of the given neighbouring chapter numbers the
 * source also has, so the one numbering the series the same way comes first;
 * then by the search's own order. The reader's "read from another source" and
 * the archive's fallback both use it.
 *
 * `orWhole`: for a part of a chapter (3.1) that no other source splits off,
 * the whole chapter it is part of (3) will do, marked `whole`. Found on
 * Eleceed: MangaFire alone calls the second half of chapter 3 "3.1", and six
 * other sources have chapter 3 entire.
 */
export async function chapterElsewhere(
  store: Store,
  url: string,
  series: { title: string; altTitles: string[]; source: Series['source'] },
  wanted: number,
  around: number[],
  orWhole = false
): Promise<{
  options: Array<{
    sourceName: string;
    lang: string | null;
    mangaId: string;
    chapterId: string;
    chapterName: string;
    matching: number;
    whole: boolean;
  }>;
  searched: number;
}> {
  const own = series.source;
  // Every name it goes by (`names.ts`): a source listing it in English is the same series.
  const allNames = await namesFor(series.title, [...series.altTitles, own?.title]);
  const names = nameKeys(allNames);
  const adapter = new SuwayomiAdapter(url, store.ignoredSources.map((s) => s.id));
  const { matches } = await adapter.searchNames(allNames, { languages: store.readLanguages, limit: 200 });
  const candidates = matches
    .filter((m) => names.has(titleKey(m.title)))
    .filter((m) => !(own && m.sourceName === own.sourceName && m.id === own.mangaId))
    .slice(0, 6);

  type Option = {
    sourceName: string;
    lang: string | null;
    mangaId: string;
    chapterId: string;
    chapterName: string;
    matching: number;
    whole: boolean;
  };
  const wholeNumber = Math.floor(wanted);
  const isPart = orWhole && wholeNumber !== wanted;
  const options: Option[] = [];
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const m = candidates[next++]!;
      try {
        // Suwayomi's stored list first, the site only when it has none.
        let chapters = await adapter.chapters(m.id, false).catch(() => []);
        if (!chapters.some((c) => c.number === wanted)) chapters = await adapter.chapters(m.id, true);
        const exact = chapters.find((c) => c.number === wanted);
        const hit = exact ?? (isPart ? chapters.find((c) => c.number === wholeNumber) : undefined);
        if (hit) {
          const numbers = new Set(chapters.map((c) => c.number));
          options.push({
            sourceName: m.sourceName,
            lang: m.lang,
            mangaId: m.id,
            chapterId: hit.id,
            chapterName: hit.name,
            matching: around.filter((n) => numbers.has(n)).length,
            whole: !exact,
          });
        }
      } catch {
        // That source cannot say; the others still might.
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  const rank = (o: Option) => candidates.findIndex((c) => c.id === o.mangaId);
  // The chapter itself before the whole one it is part of; then neighbours; then the search's order.
  options.sort((a, b) => Number(a.whole) - Number(b.whole) || b.matching - a.matching || rank(a) - rank(b));
  return { options, searched: candidates.length };
}

/**
 * How long a browser keeps a cover: 30 days. A series' cover almost never
 * changes, and at a day the phone fetched every cover it showed again each
 * morning, over Tailscale, from a PC that already had them. A cover that does
 * change shows the new one within the month.
 */
export const COVER_CACHE = 'private, max-age=2592000';

/**
 * The Local collection's rules: every favourite, and anything rated at or
 * above the chosen number, kept on the PC by themselves.
 *
 * Run by the release sweep and straight after a star, a rating or a rule
 * changes. A few series a run, because each is a whole series to download and
 * the archive's worker fetches one chapter at a time anyway: the rest follow
 * on the next run. On a guest the host keeps them, as it keeps everything.
 */
const AUTO_KEEP_PER_RUN = 3;

let autoKeeping = false;

export async function autoKeep(): Promise<number> {
  if (autoKeeping) return 0;
  autoKeeping = true;
  try {
    const store = read();
    if (!store.autoKeepFavourites && store.autoKeepMinRating === null) return 0;
    const wanted = store.series.filter(
      (s) =>
        s.source !== null &&
        ((store.autoKeepFavourites && s.favourite === true) ||
          (store.autoKeepMinRating !== null && (s.rating ?? 0) >= store.autoKeepMinRating))
    );
    const kept = isGuest ? await hostKept() : keptMangaIds();
    let started = 0;
    for (const s of wanted) {
      if (started >= AUTO_KEEP_PER_RUN) break;
      if (kept.has(s.source!.mangaId)) continue;
      if (isGuest) {
        const got = await hostJson<Record<string, unknown>>('/api/manga/host/archive', { method: 'POST', body: JSON.stringify({ title: s.title, source: s.source }) }, 60_000);
        if ('error' in got) break;
        forgetHostKept();
      } else {
        try {
          const chapters = await archiveTools().chapters(s.source!.mangaId);
          startArchive({ id: s.id, title: s.title, source: s.source }, chapters);
        } catch {
          break; // The source is not answering; the next run tries again.
        }
      }
      started += 1;
    }
    if (started > 0) {
      if (!isGuest) workArchive();
      changes.emitChange('all');
    }
    return started;
  } finally {
    autoKeeping = false;
  }
}

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
export const localOnly = (request: { isLocal: boolean }) => {
  if (!request.isLocal) {
    throw Object.assign(new Error('the source can only be changed from the PC running the server'), {
      statusCode: 403,
    });
  }
};

/**
 * What a result looks like to the screen: a cover it can fetch, and whether
 * you already follow it — by this exact copy, or by a series of the same name
 * from anywhere.
 */
export function present<T extends SourceMatch>(store: Store, match: T) {
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
 * The source, started if we manage it and it is not up.
 *
 * Everything under here is something you did on purpose — opening a chapter
 * list, turning a page — so it is allowed to spend the JVM's startup. The
 * sweep is the one caller that deliberately does not.
 */
export type ReaderContext =
  | { error: string; code: 400 | 404 | 502 }
  /*
   * `Series | Glimpse`, because this resolves either — and widening it here
   * rather than casting is what made the compiler name the one caller that
   * genuinely needs a followed series. It was one, out of ten.
   */
  | { store: Store; series: Series | Glimpse; adapter: SuwayomiAdapter; url: string };

/*
 * Annotated rather than inferred. Without it TypeScript widens the two return
 * shapes into one object with every field optional, so `ctx.code` arrives as
 * `number | undefined` and the `'error' in ctx` check narrows nothing.
 */
export async function reader(seriesId: string): Promise<ReaderContext> {
  const store = read();
  /*
   * A followed series, or something read without following it.
   *
   * Both carry the `source` this needs and nothing else here touches the
   * difference. Without the second the reader could not fetch a *page* for a
   * glimpse — it asks this route by id, got "no such series", and the whole
   * feature failed with a message about the one thing it was meant to avoid
   * needing. Reported as "it says no such series but works after I add it".
   */
  const series = store.series.find((s) => s.id === seriesId) ?? store.glimpses.find((g) => g.id === seriesId);
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
 * What the archive worker needs, resolved fresh each time.
 *
 * Built here rather than inside `archive.ts` so that file talks to no source
 * and touches no store: it owns the folder and the queue, and everything
 * about *where chapters come from* stays on this side of the line. It is the
 * same split `ArchiveTools` describes from the other end.
 */
export function archiveTools(): ArchiveTools & { chapters: (mangaId: string) => Promise<ChapterToArchive[]> } {
  const connect = async (): Promise<string | null> => {
    const store = read();
    const url = effectiveUrl(store, DEFAULT_BASE_URL);
    if (!url) return null;
    if (store.manageSuwayomi && store.suwayomiJar) {
      const state = await suwayomiProcess.ensureRunning(store.suwayomiJar, url, store.suwayomiMode);
      if (state.state !== 'running') return null;
    } else {
      suwayomiProcess.touch(store.suwayomiMode);
    }
    return url;
  };

  return {
    connect,
    pages: async (chapterId: string) => {
      const url = await connect();
      if (!url) throw new SourceError('the source is not running');
      return new SuwayomiAdapter(url).pages(chapterId);
    },
    chapters: async (mangaId: string) => {
      const url = await connect();
      if (!url) throw new SourceError('the source is not running');
      const list = await new SuwayomiAdapter(url).chapters(mangaId, true);
      return list.map((c) => ({ id: c.id, number: c.number, name: c.name, uploadedAt: c.uploadedAt }));
    },
    // A chapter the series' own source will not give whole: see `tryElsewhere` in archive.ts.
    elsewhere: async (series, number, around) => {
      const url = await connect();
      if (!url || !series.source) return null;
      const store = read();
      const row = store.series.find((x) => x.id === series.seriesId);
      const found = await chapterElsewhere(
        store,
        url,
        { title: series.title, altTitles: row?.altTitles ?? [], source: series.source },
        number,
        around,
        true
      );
      // With neighbours to compare, one must agree: numbering that matches nothing near is a guess.
      const best = found.options.find((o) => around.length === 0 || o.matching > 0);
      if (best) {
        log?.info(
          { series: series.title, number, from: best.sourceName, whole: best.whole, matching: best.matching },
          'manga: keeping a chapter from another source'
        );
      }
      return best
        ? { sourceName: best.sourceName, chapterId: best.chapterId, ...(best.whole ? { whole: Math.floor(number) } : {}) }
        : null;
    },
  };
}

/** Nudge the worker, never awaited: a caller should not wait on a download. */
export const workArchive = () => {
  void runQueue(archiveTools()).catch((error) => {
    log?.warn({ err: error }, 'manga archive worker stopped');
  });
};
