/**
 * Finding a source for every series that has none: the Library's **No source
 * yet** filter has a button that starts this.
 *
 * Each series is searched for by its title, in the languages you read, and a
 * result is linked only when its title is the series' own once `titleKey` has
 * folded case and punctuation away, or one of its old names (`altTitles`, the
 * name it arrived with). Strict on purpose: a wrong link silently reports
 * another series' chapters, and an unlinked one at least says so. Nothing
 * found is left as it was.
 *
 * Of several exact matches, the source your library already uses most is
 * taken, as the one most likely to keep working; then the search's own order.
 *
 * Gentle, because every search asks every source in your languages: one
 * series at a time, a pause between, and it pushes Suwayomi's idle timer out
 * so an on-demand Suwayomi does not stop halfway through. It replaces the
 * Manga Reader import's matcher, retired with it, for any series without a
 * source, however it got that way.
 */
import { changes } from '@everything/server/module-api';
import { read, write, type Series } from './library.js';
import { effectiveUrl, type SourceMatch } from './sources.js';
import { DEFAULT_BASE_URL, SuwayomiAdapter } from './suwayomi.js';
import { suwayomiProcess } from './process.js';
import { retitleFromSource, titleKey } from './titles.js';
import { fillTags } from './tags.js';

export interface FindSourcesState {
  running: boolean;
  /** Series without a source when the run began. */
  total: number;
  done: number;
  linked: number;
  /** Searched, and no source had it under that name. */
  notFound: number;
  /** The search itself failed. */
  failed: number;
  /** The last few linked, newest first, for the screen to name. */
  recent: string[];
  finishedAt: number | null;
  problem: string | null;
}

const PAUSE_MS = 1_500;
const IDLE: FindSourcesState = { running: false, total: 0, done: 0, linked: 0, notFound: 0, failed: 0, recent: [], finishedAt: null, problem: null };
let state: FindSourcesState = { ...IDLE };

export function findSourcesState(): FindSourcesState {
  return state;
}

const unlinked = (series: Series[]) => series.filter((s) => s.source === null);

/** How many have no source now. */
export function unlinkedCount(): number {
  return unlinked(read().series).length;
}

/** The match to take: plainly the same series, on the source the library uses most. */
export function pickSource(names: Set<string>, matches: SourceMatch[], usage: Map<string, number>): SourceMatch | null {
  const same = matches.filter((m) => names.has(titleKey(m.title)));
  if (same.length === 0) return null;
  return [...same].sort((a, b) => (usage.get(b.sourceName) ?? 0) - (usage.get(a.sourceName) ?? 0))[0]!;
}

/** Start a run, unless one is going. Answers at once; the run carries on in the background. */
export function startFindingSources(): FindSourcesState {
  if (state.running) return state;
  const todo = unlinked(read().series);
  state = { ...IDLE, running: true, total: todo.length };
  void run(todo.map((s) => s.id)).catch((error: unknown) => {
    state = { ...state, running: false, finishedAt: Date.now(), problem: error instanceof Error ? error.message : String(error) };
    changes.emitChange('all');
  });
  return state;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function run(ids: string[]): Promise<void> {
  const store = read();
  const url = effectiveUrl(store, DEFAULT_BASE_URL);
  if (!url) throw new Error('no source is set up — choose where chapters come from first');
  if (store.manageSuwayomi && store.suwayomiJar) {
    const started = await suwayomiProcess.ensureRunning(store.suwayomiJar, url, store.suwayomiMode);
    if (started.state === 'failed') throw new Error(`Suwayomi would not start — ${started.problem}`);
  }
  const adapter = new SuwayomiAdapter(url, store.ignoredSources.map((s) => s.id));

  for (const id of ids) {
    // Read fresh each time: you may be reading, or have linked one by hand.
    const now = read();
    const series = now.series.find((s) => s.id === id);
    if (!series || series.source !== null) {
      state.done += 1;
      continue;
    }
    const names = new Set(
      [series.title, ...(series.altTitles ?? []), series.origin?.title ?? ''].map(titleKey).filter(Boolean)
    );
    const usage = new Map<string, number>();
    for (const s of now.series) if (s.source) usage.set(s.source.sourceName, (usage.get(s.source.sourceName) ?? 0) + 1);

    // Its title first, then the one other name it is likeliest to be listed under.
    const queries = [...new Set([series.title, series.origin?.title, series.altTitles?.[0]].filter((q): q is string => !!q?.trim()))].slice(0, 2);
    let hit: SourceMatch | null = null;
    let answered = false;
    for (const query of queries) {
      if (store.manageSuwayomi) suwayomiProcess.touch(store.suwayomiMode);
      try {
        const { matches } = await adapter.search(query, { languages: now.readLanguages });
        answered = true;
        hit = pickSource(names, matches, usage);
      } catch {
        // Counted below if no query answered.
      }
      await sleep(PAUSE_MS);
      if (hit) break;
    }

    if (hit) {
      const fresh = read();
      const row = fresh.series.find((s) => s.id === id);
      if (row && row.source === null) {
        row.source = { adapter: 'suwayomi', mangaId: hit.id, title: hit.title, sourceName: hit.sourceName };
        // The first check sets the baseline and says nothing — see `sweepReleases`.
        row.latestChapter = null;
        row.sourceChapter = null;
        row.sourceCheckedAt = null;
        row.checkedAt = null;
        retitleFromSource(row);
        write(fresh);
        state.linked += 1;
        state.recent = [`${row.title} (${hit.sourceName})`, ...state.recent].slice(0, 5);
      }
    } else if (answered) {
      state.notFound += 1;
    } else {
      state.failed += 1;
    }
    state.done += 1;
    if (state.done % 10 === 0) changes.emitChange('all');
  }

  state = { ...state, running: false, finishedAt: Date.now() };
  changes.emitChange('all');
  // Everything just linked wants its genres, and Suwayomi is up now.
  void fillTags().catch(() => {});
}
