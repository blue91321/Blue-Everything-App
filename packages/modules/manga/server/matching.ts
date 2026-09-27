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
 * ### The sites it was read on first, then the others
 *
 * The sites it was read on are the most likely to have it under that exact
 * name, so they are tried first, newest first. Then up to `FALLBACKS` of your
 * other sources in the languages you read — because the site it was read on
 * may have no extension, or one that has stopped working. The first real run
 * found Mangakakalot, where 633 of 886 had been read, refusing every search
 * with "Cloudflare bypass currently disabled", and linked 9.
 *
 * The fallbacks are ordered by what has worked this run: a source that keeps
 * finding things is asked sooner, so the order settles on the big catalogues
 * without a list of names in this file to go stale.
 *
 * ### A broken source is noticed once, not 633 times
 *
 * `BROKEN_AFTER` failures in a row and a source is set aside for the rest of
 * the run, with the reason it gave, which the screen shows. A failure used to
 * be counted and its reason thrown away, so "748 could not be asked" said
 * nothing about why or what to do.
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
import { repairMojibake } from './mangareader.js';
import { suwayomiProcess } from './process.js';
import { effectiveUrl, type SourceMatch } from './sources.js';
import { DEFAULT_BASE_URL, SuwayomiAdapter, type BrowseSource } from './suwayomi.js';
import { fillTags } from './tags.js';

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
  /** Sources set aside this run because they kept failing, with what they said. */
  broken: Array<{ id: string; source: string; reason: string }>;
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
  broken: [],
  finishedAt: null,
  problem: null,
};

/** Between searches. A site being asked hundreds of questions in a row deserves the gap. */
const PAUSE_MS = 500;

/** Other sources tried once the sites it was read on have not found it. */
const FALLBACKS = 4;

/** Failures in a row before a source is set aside for the rest of a run. */
const BROKEN_AFTER = 3;

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

/** Sources worth asking about something not found where it was read: your languages, not your own files. */
export function fallbackSources(sources: BrowseSource[], languages: readonly string[]): BrowseSource[] {
  return sources.filter((s) => s.id !== '0' && languages.includes(s.lang));
}

/** The first line of what a source said, which is the part a person can act on. */
export function failureReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = text.split('\n').find((l) => l.trim()) ?? 'no answer';
  // Suwayomi wraps the extension's own message: keep what the extension said.
  return line.replace(/^Exception while fetching data \([^)]*\)\s*:\s*/, '').trim().slice(0, 160);
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const pending = (series: Series[]) => series.filter((s) => s.origin && s.source === null);

/** How many imported series still have no source. */
export function unmatchedCount(): number {
  return pending(read().series).length;
}

/**
 * Titles imported before `repairMojibake` existed, put right before searching:
 * a garbled title is what gets searched for, and can never be found.
 */
function repairImportedTitles(): void {
  const store = read();
  let changed = false;
  for (const s of store.series) {
    if (!s.origin) continue;
    const title = repairMojibake(s.title);
    const originTitle = repairMojibake(s.origin.title);
    if (title !== s.title || originTitle !== s.origin.title) {
      s.title = title;
      s.origin.title = originTitle;
      changed = true;
    }
  }
  if (changed) write(store);
}

/**
 * Link every imported series with no source that can be found. Returns at once;
 * the work runs in the background and reports through `matchingState`.
 */
export function startMatching(): MatchingState {
  if (state.running) return state;
  repairImportedTitles();
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
  // Every installed source, ignored ones included, so a site whose only source
  // you have set aside is not reported as having none installed.
  const installed = await adapter.listSources();
  const ignored = new Set(store.ignoredSources.map((s) => s.id));
  const sources = installed.filter((s) => !ignored.has(s.id));
  const others = fallbackSources(sources, store.readLanguages);

  // Most recently read first: an import sets `addedAt` to when it was last read.
  todo.sort((a, b) => b.addedAt - a.addedAt);
  const noSource = new Map<string, number>();
  const wins = new Map<string, number>();
  const streak = new Map<string, number>();
  const broken = new Map<string, string>();
  let sinceAnnounce = 0;

  for (const series of todo) {
    const origin = series.origin!;
    const siteSources = (origin.sites ?? [origin.site])
      .map((site) => sourceForSite(site, installed, store.readLanguages))
      .filter((s): s is BrowseSource => s !== null);
    if (siteSources.length === 0) noSource.set(origin.site, (noSource.get(origin.site) ?? 0) + 1);
    const own = siteSources.filter((s) => !ignored.has(s.id));
    // Whatever has been finding things this run goes first.
    const ranked = [...others].sort((a, b) => (wins.get(b.id) ?? 0) - (wins.get(a.id) ?? 0));
    const usable = (list: BrowseSource[]) => list.filter((s) => !broken.has(s.id));
    const mine = usable(own).filter((s, i, all) => all.findIndex((o) => o.id === s.id) === i);
    const candidates = [...mine, ...usable(ranked).filter((s) => !mine.some((o) => o.id === s.id)).slice(0, FALLBACKS)];

    let hit: SourceMatch | null = null;
    let answered = false;
    for (const source of candidates) {
      if (broken.has(source.id)) continue;
      // A run outlasts the idle timer many times over, and each search is
      // use: without this an on-demand Suwayomi stops fifteen minutes in
      // and every series after that is counted as failed.
      if (store.manageSuwayomi) suwayomiProcess.touch(store.suwayomiMode);
      try {
        const { matches } = await adapter.browse(
          { id: source.id, displayName: source.name, lang: source.lang },
          'SEARCH',
          1,
          origin.title
        );
        answered = true;
        streak.delete(source.id);
        hit = pickMatch(origin.title, matches);
      } catch (error) {
        const n = (streak.get(source.id) ?? 0) + 1;
        streak.set(source.id, n);
        if (n >= BROKEN_AFTER) {
          broken.set(source.id, failureReason(error));
          state.broken = [...broken].map(([id, reason]) => ({
            id,
            source: sources.find((s) => s.id === id)?.name ?? id,
            reason,
          }));
        }
      }
      await sleep(PAUSE_MS);
      if (hit) {
        wins.set(source.id, (wins.get(source.id) ?? 0) + 1);
        break;
      }
    }

    if (hit) {
      // Read fresh and written at once: you may be reading while this runs.
      const now = read();
      const row = now.series.find((s) => s.id === series.id);
      if (row && row.source === null) {
        row.source = { adapter: 'suwayomi', mangaId: hit.id, title: hit.title, sourceName: hit.sourceName };
        // The first check sets the baseline and says nothing — see `sweepReleases`.
        row.latestChapter = null;
        row.sourceChapter = null;
        row.sourceCheckedAt = null;
        row.checkedAt = null;
        write(now);
        state.linked += 1;
      }
    } else if (answered) {
      state.notFound += 1;
    } else {
      state.failed += 1;
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
  // Everything just linked wants its genres, and Suwayomi is up now.
  void fillTags().catch(() => {});
}
