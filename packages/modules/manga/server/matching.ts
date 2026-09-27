/**
 * Finding series brought in from another app on your installed sources.
 *
 * An import knows each series as a site and a title — `mangakakalot`, "The
 * Player Hides His Past" — and nothing more. This asks the installed source for
 * that site to search for the title, and links the result when it is plainly
 * the same series. Linked, a series can be opened and is checked for new
 * chapters like any other.
 *
 * ### Strict on purpose
 *
 * A link is taken only when a result's title is the same title once case and
 * punctuation are set aside (`groupKey`). Anything looser links the wrong
 * series some of the time, and a wrong link is worse than none: it silently
 * reports another series' chapters, where an unlinked one says plainly that it
 * has no source and offers to find one.
 *
 * ### Only the sites it was read on
 *
 * Asking every installed source about several hundred titles would be several
 * thousand searches against other people's sites. The ones it was read on are
 * the most likely to have it under that exact name, and they are tried newest
 * first. A site with no installed
 * source is counted and named, so the screen can say which extension would
 * bring the most in.
 *
 * ### Gently, and in the background
 *
 * One search at a time with a pause between, most recently read first — so
 * what you are reading now is linked in the first minute and a library from
 * 2020 trickles in behind it. The screen follows along through the change
 * events it already listens to; nothing polls.
 */
import { changes } from '@everything/server/module-api';
import { groupKey } from './browse.js';
import { read, write, type Series } from './library.js';
import { suwayomiProcess } from './process.js';
import { effectiveUrl, type SourceMatch } from './sources.js';
import { DEFAULT_BASE_URL, SuwayomiAdapter, type BrowseSource } from './suwayomi.js';

export type MatchingState = {
  running: boolean;
  /** Series that had no source when this run began. */
  total: number;
  done: number;
  linked: number;
  /** Searched, and nothing had exactly that title. */
  notFound: number;
  /** The source would not answer. Worth trying again later. */
  failed: number;
  /** Sites with no installed source, most series first. */
  noSource: Array<{ site: string; count: number }>;
  finishedAt: number | null;
  problem: string | null;
};

const IDLE: MatchingState = {
  running: false,
  total: 0,
  done: 0,
  linked: 0,
  notFound: 0,
  failed: 0,
  noSource: [],
  finishedAt: null,
  problem: null,
};

/** Between searches. A site being asked hundreds of questions in a row deserves the gap. */
const PAUSE_MS = 750;

/** Announce progress this often, so the screen moves without reloading on every link. */
const ANNOUNCE_EVERY = 20;

let state: MatchingState = { ...IDLE };

export function matchingState(): MatchingState {
  return state;
}

/** `Manhwa18.cc (EN)` → `manhwa18cc`; `mangakakalot` stays itself. */
export function siteKey(name: string): string {
  return name.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]/g, '');
}

/**
 * The installed source for a site the old app named, preferring a language you
 * read — MangaFire is installed six times over, once per language.
 */
export function sourceForSite(site: string, sources: BrowseSource[], languages: readonly string[]): BrowseSource | null {
  const want = siteKey(site);
  if (want.length < 4) return null;
  const candidates = sources.filter((s) => {
    const have = siteKey(s.name);
    return have === want || have.startsWith(want) || (have.length >= 5 && want.startsWith(have));
  });
  const rank = (s: BrowseSource) => {
    const at = languages.indexOf(s.lang);
    return at >= 0 ? at : s.lang === 'all' ? languages.length : languages.length + 1;
  };
  return candidates.sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/** The result that is plainly the same series, or nothing. */
export function pickMatch(title: string, matches: SourceMatch[]): SourceMatch | null {
  const want = groupKey(title);
  return matches.find((m) => groupKey(m.title) === want) ?? null;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const pending = (series: Series[]) => series.filter((s) => s.origin && s.source === null);

/** How many imported series still have no source. */
export function unmatchedCount(): number {
  return pending(read().series).length;
}

/**
 * Link every imported series with no source that can be found. Returns at once;
 * the work runs in the background and reports through `matchingState`.
 */
export function startMatching(): MatchingState {
  if (state.running) return state;
  const store = read();
  const todo = pending(store.series);
  state = { ...IDLE, running: true, total: todo.length };
  void run(todo).catch((error) => {
    state = { ...state, running: false, finishedAt: Date.now(), problem: error instanceof Error ? error.message : 'matching failed' };
    changes.emitChange('all');
  });
  return state;
}

async function run(todo: Series[]): Promise<void> {
  const store = read();
  const url = effectiveUrl(store, DEFAULT_BASE_URL);
  if (!url) throw new Error('no source is set up — choose where chapters come from first');
  if (todo.length === 0) {
    state = { ...state, running: false, finishedAt: Date.now() };
    return;
  }
  // Asked for, so starting Suwayomi is inside what was asked.
  if (store.manageSuwayomi && store.suwayomiJar) {
    const started = await suwayomiProcess.ensureRunning(store.suwayomiJar, url, store.suwayomiMode);
    if (started.state === 'failed') throw new Error(`Suwayomi would not start — ${started.problem}`);
  }
  const adapter = new SuwayomiAdapter(url);
  const sources = await adapter.listSources();

  // Most recently read first: an import sets `addedAt` to when it was last read.
  todo.sort((a, b) => b.addedAt - a.addedAt);
  const noSource = new Map<string, number>();
  let sinceAnnounce = 0;

  for (const series of todo) {
    const origin = series.origin!;
    // Each site it was read on that has an installed source, most recent first.
    const candidates = (origin.sites ?? [origin.site])
      .map((site) => sourceForSite(site, sources, store.readLanguages))
      .filter((s): s is BrowseSource => s !== null)
      .filter((s, i, all) => all.findIndex((o) => o.id === s.id) === i);
    if (candidates.length === 0) {
      noSource.set(origin.site, (noSource.get(origin.site) ?? 0) + 1);
    } else {
      try {
        let hit: SourceMatch | null = null;
        for (const source of candidates) {
          // A run outlasts the idle timer many times over, and each search is
          // use: without this an on-demand Suwayomi stops fifteen minutes in
          // and every series after that is counted as failed.
          if (store.manageSuwayomi) suwayomiProcess.touch(store.suwayomiMode);
          const { matches } = await adapter.browse(
            { id: source.id, displayName: source.name, lang: source.lang },
            'SEARCH',
            1,
            origin.title
          );
          hit = pickMatch(origin.title, matches);
          if (hit) break;
          await sleep(PAUSE_MS);
        }
        if (hit) {
          // Read fresh and written at once: you may be reading while this runs.
          const now = read();
          const row = now.series.find((s) => s.id === series.id);
          if (row && row.source === null) {
            row.source = { adapter: 'suwayomi', mangaId: hit.id, title: hit.title, sourceName: hit.sourceName };
            // The first check sets the baseline and says nothing — see `sweepReleases`.
            // The old app's number stays on `origin` for the badge until then.
            row.latestChapter = null;
            row.sourceChapter = null;
            row.sourceCheckedAt = null;
            row.checkedAt = null;
            write(now);
            state.linked += 1;
          }
        } else {
          state.notFound += 1;
        }
      } catch {
        state.failed += 1;
      }
      await sleep(PAUSE_MS);
    }
    state.done += 1;
    state.noSource = [...noSource].map(([site, count]) => ({ site, count })).sort((a, b) => b.count - a.count);
    if (++sinceAnnounce >= ANNOUNCE_EVERY) {
      sinceAnnounce = 0;
      changes.emitChange('all');
    }
  }

  state = { ...state, running: false, finishedAt: Date.now() };
  changes.emitChange('all');
}
