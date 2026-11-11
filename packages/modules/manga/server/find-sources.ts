/**
 * Finding a source for every series that has none: the Library's **No source
 * yet** filter has a button that starts this. And, the same search, **switching
 * every series its source has lost** (a 404 or "no chapters", `goneFromSource`)
 * to another that has it: the **Source has nothing for it** filter's button,
 * asked for on 2026-11-07 when MangaFox and Mangahere took down 21 series.
 *
 * A switch is stricter than a first link, since a series that works is not
 * being touched and one that is gone is better gone than wrong: the title must
 * be the same, the source must be another one, and it must give chapters when
 * asked (a few candidates at most, the most-used source first). One that
 * reaches as far as you have read is taken over one that does not. Read marks
 * and your place are kept by chapter number, so they carry over.
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
import { effectiveUrl, profileChapters, type SourceMatch } from './sources.js';
import { goneFromSource, SWITCH_AFTER_MS } from '../web/shelf.js';
import { DEFAULT_BASE_URL, SuwayomiAdapter } from './suwayomi.js';
import { suwayomiProcess } from './process.js';
import { retitleFromSource, titleKey } from './titles.js';
import { fillTags } from './tags.js';

export interface FindSourcesState {
  running: boolean;
  /** Linking series with no source, or switching series whose source has lost them. */
  mode: FindMode;
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

export type FindMode = 'unlinked' | 'gone';
const PAUSE_MS = 1_500;
/** How many same-titled results a switch asks for chapters before giving up on a series: each is a request to a site. */
const CANDIDATES = 3;
const IDLE: FindSourcesState = { running: false, mode: 'unlinked', total: 0, done: 0, linked: 0, notFound: 0, failed: 0, recent: [], finishedAt: null, problem: null };
let state: FindSourcesState = { ...IDLE };

export function findSourcesState(): FindSourcesState {
  return state;
}

const unlinked = (series: Series[]) => series.filter((s) => s.source === null);

/** Series whose source has lost them: linked, and the last check said it is gone there. */
const gone = (series: Series[]) => series.filter((s) => s.source !== null && goneFromSource(s.error));

/** How many have no source now. */
export function unlinkedCount(): number {
  return unlinked(read().series).length;
}

/** How many are gone from their source now. */
export function goneCount(): number {
  return gone(read().series).length;
}

/** The match to take: plainly the same series, on the source the library uses most. */
export function pickSource(names: Set<string>, matches: SourceMatch[], usage: Map<string, number>): SourceMatch | null {
  const same = matches.filter((m) => names.has(titleKey(m.title)));
  if (same.length === 0) return null;
  return [...same].sort((a, b) => (usage.get(b.sourceName) ?? 0) - (usage.get(a.sourceName) ?? 0))[0]!;
}

/** Start a run, unless one is going. Answers at once; the run carries on in the background. */
export function startFindingSources(mode: FindMode = 'unlinked'): FindSourcesState {
  if (state.running) return state;
  const todo = mode === 'gone' ? gone(read().series) : unlinked(read().series);
  state = { ...IDLE, mode, running: true, total: todo.length };
  void (mode === 'gone' ? switchAll(todo.map((s) => s.id)) : run(todo.map((s) => s.id))).catch((error: unknown) => {
    state = { ...state, running: false, finishedAt: Date.now(), problem: error instanceof Error ? error.message : String(error) };
    changes.emitChange('all');
  });
  return state;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Suwayomi up and an adapter to ask, or why not. */
async function adapterFor(): Promise<SuwayomiAdapter> {
  const store = read();
  const url = effectiveUrl(store, DEFAULT_BASE_URL);
  if (!url) throw new Error('no source is set up — choose where chapters come from first');
  if (store.manageSuwayomi && store.suwayomiJar) {
    const started = await suwayomiProcess.ensureRunning(store.suwayomiJar, url, store.suwayomiMode);
    if (started.state === 'failed') throw new Error(`Suwayomi would not start — ${started.problem}`);
  }
  return new SuwayomiAdapter(url, store.ignoredSources.map((s) => s.id));
}

/**
 * Of the same-titled results on other sources, the one to switch to: asked for
 * chapters in turn, most-used source first, and the first that reaches as far
 * as you have read taken; failing that, the one that reaches furthest. Null when
 * none gives a chapter.
 */
export function pickReplacement(
  results: Array<{ match: SourceMatch; latest: number | null; chapters: number }>,
  readUpTo: number
): SourceMatch | null {
  const working = results.filter((r) => r.chapters > 0);
  if (!working.length) return null;
  const far = working.find((r) => (r.latest ?? -1) >= readUpTo);
  if (far) return far.match;
  return [...working].sort((a, b) => (b.latest ?? -1) - (a.latest ?? -1))[0]!.match;
}

/** What one switch came to. */
export type SwitchOutcome =
  | { kind: 'switched'; from: string; to: string; chapters: number }
  | { kind: 'notFound'; from: string }
  | { kind: 'failed'; problem: string }
  | { kind: 'skipped' };

/**
 * Switch one series to another source that has it: searched by its title (and
 * the name its source gives it), taken only where the title is exactly the
 * same, the source is another one, and asking it for chapters gives some; of
 * up to three, most-used first, one reaching as far as you have read wins. Read
 * marks and your place are by chapter number, so they carry over.
 *
 * `when` decides whether it still applies when the result comes back: a switch
 * by hand meanwhile, or the source answering again, wins.
 */
export async function switchOne(adapter: SuwayomiAdapter, id: string, why: string, automatic: boolean, when: (s: Series) => boolean): Promise<SwitchOutcome> {
  const now = read();
  const series = now.series.find((s) => s.id === id);
  if (!series?.source || !when(series)) return { kind: 'skipped' };
  const from = series.source;
  const names = new Set([series.title, from.title, ...(series.altTitles ?? []), series.origin?.title ?? ''].map(titleKey).filter(Boolean));
  const usage = new Map<string, number>();
  for (const s of now.series) if (s.source) usage.set(s.source.sourceName, (usage.get(s.source.sourceName) ?? 0) + 1);
  const queries = [...new Set([series.title, from.title, series.altTitles?.[0]].filter((q): q is string => !!q?.trim()))].slice(0, 2);
  const seen = new Map<string, SourceMatch>();
  let answered = false;
  for (const query of queries) {
    if (now.manageSuwayomi) suwayomiProcess.touch(now.suwayomiMode);
    try {
      const { matches } = await adapter.search(query, { languages: now.readLanguages });
      answered = true;
      for (const m of matches) if (names.has(titleKey(m.title)) && m.sourceName !== from.sourceName && m.id !== from.mangaId) seen.set(m.id, m);
    } catch {
      // Counted below if no query answered.
    }
    await sleep(PAUSE_MS);
  }
  if (!answered) return { kind: 'failed', problem: 'no source would answer a search' };
  const candidates = [...seen.values()].sort((a, b) => (usage.get(b.sourceName) ?? 0) - (usage.get(a.sourceName) ?? 0)).slice(0, CANDIDATES);
  const results: Array<{ match: SourceMatch; latest: number | null; chapters: number }> = [];
  for (const match of candidates) {
    if (now.manageSuwayomi) suwayomiProcess.touch(now.suwayomiMode);
    try {
      const profile = profileChapters(await adapter.chapters(match.id, true));
      results.push({ match, latest: profile.latest, chapters: profile.distinct });
    } catch {
      // That one has nothing, or would not say: not a replacement.
    }
    await sleep(PAUSE_MS);
  }
  const readUpTo = series.readChapters.length ? Math.max(...series.readChapters) : 0;
  const hit = pickReplacement(results, readUpTo);

  const fresh = read();
  const row = fresh.series.find((s) => s.id === id);
  if (!row?.source || row.source.mangaId !== from.mangaId || !when(row)) return { kind: 'skipped' };
  if (!hit) {
    if (automatic) {
      row.switchTriedAt = Date.now();
      write(fresh);
    }
    return { kind: 'notFound', from: from.sourceName };
  }
  row.source = { adapter: 'suwayomi', mangaId: hit.id, title: hit.title, sourceName: hit.sourceName };
  // The first check sets the baseline and says nothing — see `sweepReleases`.
  row.latestChapter = null;
  row.sourceChapter = null;
  row.sourceCheckedAt = null;
  row.checkedAt = null;
  row.error = null;
  delete row.switchTriedAt;
  row.switchedFrom = { sourceName: from.sourceName, at: Date.now(), why, automatic };
  write(fresh);
  return { kind: 'switched', from: from.sourceName, to: hit.sourceName, chapters: results.find((r) => r.match.id === hit.id)?.chapters ?? 0 };
}

async function switchAll(ids: string[]): Promise<void> {
  const adapter = await adapterFor();
  for (const id of ids) {
    const outcome = await switchOne(adapter, id, 'its source had taken it down', false, (s) => goneFromSource(s.error));
    if (outcome.kind === 'switched') {
      state.linked += 1;
      const title = read().series.find((s) => s.id === id)?.title ?? '';
      state.recent = [`${title} (${outcome.from} → ${outcome.to})`, ...state.recent].slice(0, 5);
    } else if (outcome.kind === 'notFound') state.notFound += 1;
    else if (outcome.kind === 'failed') state.failed += 1;
    state.done += 1;
    if (state.done % 5 === 0) changes.emitChange('all');
  }
  state = { ...state, running: false, finishedAt: Date.now() };
  changes.emitChange('all');
  void fillTags().catch(() => {});
}

/** Whether a series has failed long enough to be switched automatically. */
export function dueForSwitch(s: Series, now: number): boolean {
  if (!s.source || !s.error || typeof s.failingSince !== 'number') return false;
  if (now - s.failingSince < SWITCH_AFTER_MS) return false;
  return typeof s.switchTriedAt !== 'number' || now - s.switchTriedAt >= 24 * 60 * 60_000;
}

/** Series switched by a sweep, at most: each is a few searches and chapter lists, so a hundred at once would be an hour of asking sites. */
const AUTO_PER_SWEEP = 4;

/**
 * Switch the series whose sources have failed for two days, a few each sweep,
 * when switching is on and only while Suwayomi is already up: it is never
 * started for this. Runs from the release sweep, which is already awake.
 */
export async function autoSwitch(): Promise<number> {
  const store = read();
  if (!store.autoSwitchSources || state.running) return 0;
  if (store.manageSuwayomi && suwayomiProcess.state.state !== 'running') return 0;
  const now = Date.now();
  const due = store.series.filter((s) => dueForSwitch(s, now)).sort((a, b) => (a.failingSince ?? 0) - (b.failingSince ?? 0));
  if (!due.length) return 0;
  const url = effectiveUrl(store, DEFAULT_BASE_URL);
  if (!url) return 0;
  const adapter = new SuwayomiAdapter(url, store.ignoredSources.map((s) => s.id));
  let switched = 0;
  for (const s of due.slice(0, AUTO_PER_SWEEP)) {
    const outcome = await switchOne(adapter, s.id, `${s.source!.sourceName} had not answered for two days`, true, (row) => dueForSwitch(row, Date.now()));
    if (outcome.kind === 'switched') switched += 1;
  }
  if (switched) {
    changes.emitChange('all');
    void fillTags().catch(() => {});
  }
  return switched;
}

/** The button on a series' page: switch it now, whatever the clock says, starting Suwayomi if need be since it was asked for. */
export async function switchNow(id: string): Promise<SwitchOutcome> {
  const adapter = await adapterFor();
  const outcome = await switchOne(adapter, id, 'you asked for a new source', false, () => true);
  if (outcome.kind === 'switched') {
    changes.emitChange('all');
    void fillTags().catch(() => {});
  }
  return outcome;
}

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
