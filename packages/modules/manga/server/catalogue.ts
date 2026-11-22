/**
 * The chapter catalogue (2026-11-21): which sources carry each series in the
 * library, and how many chapters each copy has.
 *
 * Asked for to make three things faster or possible: opening a series, looking
 * for other sources, and a nudge when another source has more chapters. Only
 * the sites themselves can say how many chapters they have, and Suwayomi keeps
 * every chapter list it fetched, but in a database it can read only while its
 * JVM is running and, measured, for 172 of the library's series on more than
 * one source. So this keeps its own, in text, readable whether Suwayomi is up
 * or not:
 *
 * - **What every source lists**, by Suwayomi's id and title, one file per
 *   source (`data/manga-catalogue/source-<id>.json`). Filled for free by every
 *   search and listing the adapter answers (`catalogue-notes.ts`), seeded from
 *   what Suwayomi already stored, and on a source not yet mapped, by paging its
 *   whole popular list in the background.
 * - **How many chapters each copy has**, the comparison's own profile
 *   (`profileChapters`), with when it was counted (`index.json`). Filled by
 *   every chapter list fetched from a site, wherever in the app.
 *
 * **A copy is the same series by name, exactly** (`titleKey` over every name the
 * series goes by): a wrong match would put another series' chapters beside
 * yours, as Switch sources says.
 *
 * **Every installed source in your languages is asked**, as chosen: the
 * library check searches each one for every series not searched there in a
 * month. **Except a source whose whole list has been mapped**: once its popular
 * list has been read to the end and holds nearly every series a search found
 * there (`mapVerdict`), a series is looked up in the map instead of searched
 * for, and the source is only looked at once a day for what is new (its latest
 * list, the first pages until nothing is new), or mapped again monthly when it
 * has no latest list.
 *
 * Gentle with the sites: each source is asked one thing at a time with a pause
 * between, at most six sources at once, Suwayomi's idle timer pushed out while
 * it runs. The background mapping happens only in the release sweep and only
 * while Suwayomi is already up, a few pages a sweep; it is never woken for it.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { changes, dataDir, db, getSettings, isGuest, nudges, writeFileAtomic } from '@everything/server/module-api';
import { resolvePush } from '@everything/shared';
import { hearNotes, type ListedSource } from './catalogue-notes.js';
import { isPutAway, read, type Series } from './library.js';
import { nameKeys, namesFor, searchQueries } from './names.js';
import { suwayomiProcess } from './process.js';
import { effectiveUrl, profileChapters, SourceError, sourcesToSearch, type SourceChapter, type SourceMatch } from './sources.js';
import { DEFAULT_BASE_URL, SuwayomiAdapter } from './suwayomi.js';
import { testSources } from './test-source.js';
import { titleKey } from './titles.js';
import { peerCopiesFor, peerCount, refreshPeerCatalogues } from './peer-catalogue.js';
import {
  afterRefusal,
  DAY_MS,
  REST_AFTER_DROP_MS,
  triedRecently,
  aheadOf,
  aheadText,
  isNovel,
  isRefusal,
  latestDue,
  mapVerdict,
  PAUSE_MS,
  recountDue,
  REMAP_EVERY_MS,
  searchDue,
  worthTelling,
  type CopyCount,
} from '../web/catalogue-rules.js';

/* ---------------------------------------------------------------- the store */

/** The comparison's profile of a copy, less the parts that only make sense on the day. */
export interface CopyProfile {
  entries: number;
  distinct: number;
  first: number | null;
  latest: number | null;
  missing: number;
  newestUpload: number | null;
}

interface Counted {
  p: CopyProfile;
  /** When it was counted. */
  at: number;
}

export interface SourceState {
  name: string;
  lang: string;
  supportsLatest: boolean;
  /** Its whole list read and trusted: series are looked up here rather than searched for. */
  mapped: boolean;
  mappedAt: number | null;
  /** A mapping under way: the next page of its popular list, and how many read. */
  crawl: { page: number; pages: number; startedAt: number; stale: number } | null;
  /** Why it cannot be mapped (its list leaves series out), so it is searched instead. */
  why: string | null;
  /** When its latest list was last looked at, once mapped. */
  latestAt: number | null;
  /** Left out of a run for refusing: not asked by a check again until then. */
  restUntil?: number | null;
}

interface Index {
  v: 1;
  sources: Record<string, SourceState>;
  counts: Record<string, Counted>;
  /** When each series was last searched for on each source: series id → source id → when. */
  searched: Record<string, Record<string, number>>;
  /** The newest chapter already told about, per series, so a lead is said once. */
  told: Record<string, number>;
  /** When a search (`search:<series>:<source>`) or a count (`count:<manga id>`) was last tried, so one that fails is tried again a day later rather than on every run. */
  tried: Record<string, number>;
  settings: CatalogueSettings;
  seededAt: number | null;
}

export interface CatalogueSettings {
  /** A nudge when another source is ahead. */
  nudge: boolean;
  /** Map unmapped sources a few pages a sweep while Suwayomi is up. */
  background: boolean;
  /** Run the library check by itself, from the sweep, whenever something is due. */
  automatic: boolean;
}

interface SourceList {
  /** Every series this source has listed: Suwayomi id → title. */
  titles: Record<string, string>;
  /** Series a search for a library series found here: the test of a full list (`mapVerdict`). */
  found: string[];
  /** Series seen in the current mapping's list, so far. */
  seen: string[];
}

const DIR = () => join(dataDir, 'manga-catalogue');
const INDEX = () => join(DIR(), 'index.json');
const listFile = (sourceId: string) => join(DIR(), `source-${sourceId.replace(/[^0-9A-Za-z-]/g, '')}.json`);

const EMPTY = (): Index => ({ v: 1, sources: {}, counts: {}, searched: {}, told: {}, tried: {}, settings: { nudge: true, background: true, automatic: true }, seededAt: null });

interface Loaded {
  data: SourceList;
  /** Title key → ids, for looking a series up. */
  keys: Map<string, string[]>;
  found: Set<string>;
  seen: Set<string>;
}

let index: Index | null = null;
const lists = new Map<string, Loaded>();
/** Which source an id belongs to. */
const owner = new Map<string, string>();
const dirty = new Set<string>();
let flushTimer: NodeJS.Timeout | null = null;

function parse<T>(file: string): T | null {
  try {
    const raw = readFileSync(file, 'utf8');
    return JSON.parse(raw.startsWith('﻿') ? raw.slice(1) : raw) as T;
  } catch {
    // A cache: a file that will not read is started again, as the weather's is.
    return null;
  }
}

function load(): Index {
  if (index) return index;
  const raw = existsSync(INDEX()) ? parse<Partial<Index>>(INDEX()) : null;
  index = { ...EMPTY(), ...(raw ?? {}), settings: { ...EMPTY().settings, ...(raw?.settings ?? {}) } };
  if (existsSync(DIR())) {
    for (const name of readdirSync(DIR())) {
      const m = /^source-(.+)\.json$/.exec(name);
      if (!m) continue;
      const data = parse<SourceList>(join(DIR(), name));
      if (data?.titles) adopt(m[1]!, { titles: data.titles, found: data.found ?? [], seen: data.seen ?? [] });
    }
  }
  return index;
}

function adopt(sourceId: string, data: SourceList): Loaded {
  const loaded: Loaded = { data, keys: new Map(), found: new Set(data.found), seen: new Set(data.seen) };
  for (const [id, title] of Object.entries(data.titles)) index_(loaded, sourceId, id, title);
  lists.set(sourceId, loaded);
  return loaded;
}

function index_(loaded: Loaded, sourceId: string, id: string, title: string): void {
  owner.set(id, sourceId);
  const key = titleKey(title);
  if (!key) return;
  const ids = loaded.keys.get(key);
  if (!ids) loaded.keys.set(key, [id]);
  else if (!ids.includes(id)) ids.push(id);
}

function listOf(sourceId: string): Loaded {
  load();
  return lists.get(sourceId) ?? adopt(sourceId, { titles: {}, found: [], seen: [] });
}

/** Written a few seconds after the last change, whole files at a time, as the blueprints' run log is. */
function touched(what: string): void {
  dirty.add(what);
  if (flushTimer) return;
  flushTimer = setTimeout(flushCatalogue, 3_000);
  flushTimer.unref();
}

export function flushCatalogue(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (!index || dirty.size === 0) return;
  mkdirSync(DIR(), { recursive: true });
  for (const what of dirty) {
    try {
      if (what === 'index') writeFileAtomic(INDEX(), `${JSON.stringify(index)}\n`);
      else {
        const l = lists.get(what);
        if (l) writeFileAtomic(listFile(what), `${JSON.stringify({ titles: l.data.titles, found: [...l.found], seen: [...l.seen] })}\n`);
      }
    } catch {
      // Tried again at the next change.
      continue;
    }
  }
  dirty.clear();
}

function slim(chapters: readonly SourceChapter[]): CopyProfile {
  const p = profileChapters(chapters);
  return { entries: p.entries, distinct: p.distinct, first: p.first, latest: p.latest, missing: p.missing, newestUpload: p.newestUpload };
}

function ensureSource(source: { id: string; name: string; lang: string; supportsLatest?: boolean }): SourceState {
  const idx = load();
  const known = idx.sources[source.id];
  if (known) {
    if (known.name !== source.name || known.lang !== source.lang || (source.supportsLatest !== undefined && known.supportsLatest !== source.supportsLatest)) {
      known.name = source.name;
      known.lang = source.lang;
      if (source.supportsLatest !== undefined) known.supportsLatest = source.supportsLatest;
      touched('index');
    }
    return known;
  }
  const state: SourceState = { name: source.name, lang: source.lang, supportsLatest: source.supportsLatest ?? true, mapped: false, mappedAt: null, crawl: null, why: null, latestAt: null };
  idx.sources[source.id] = state;
  touched('index');
  return state;
}

/* ---------------------------------------------------------------- what the adapter notes */

function noteListing(source: ListedSource, _kind: string, matches: readonly SourceMatch[]): void {
  if (testSources().some((t) => t.id === source.id)) return;
  ensureSource({ id: source.id, name: source.displayName, lang: source.lang });
  const l = listOf(source.id);
  let changed = false;
  for (const m of matches) {
    if (l.data.titles[m.id] === m.title) continue;
    l.data.titles[m.id] = m.title;
    index_(l, source.id, m.id, m.title);
    changed = true;
  }
  if (changed) touched(source.id);
}

function noteCount(mangaId: string, chapters: readonly SourceChapter[], at = Date.now()): void {
  const idx = load();
  const known = idx.counts[mangaId];
  if (known && known.at > at) return;
  idx.counts[mangaId] = { p: slim(chapters), at };
  touched('index');
}

hearNotes(noteListing, (mangaId, chapters) => noteCount(mangaId, chapters));

/* ---------------------------------------------------------------- copies of a series */

const keysOf = (s: Series): Set<string> => nameKeys([s.title, s.source?.title, ...(s.altTitles ?? []), s.origin?.title].filter((x): x is string => !!x));

export interface KnownCopy {
  mangaId: string;
  sourceId: string;
  sourceName: string;
  lang: string;
  title: string;
  /** This copy is the one the series is linked to. */
  current: boolean;
  profile: CopyProfile | null;
  countedAt: number | null;
  /** Counted by a linked server rather than this one (`peer-catalogue.ts`): its name. */
  via: string | null;
}

/**
 * A linked server's count of the same copy (same source, same name), when it
 * is newer than this server's: used in its place, and said to be theirs.
 */
function overlay(copy: KnownCopy): KnownCopy {
  const theirs = copy.sourceId ? peerCount(copy.sourceId, titleKey(copy.title)) : null;
  if (!theirs || (copy.countedAt !== null && copy.countedAt >= theirs.at)) return copy;
  return { ...copy, profile: theirs.p, countedAt: theirs.at, via: theirs.via };
}

/** Every copy of a series the catalogue knows, by an exact name, its own included. */
export function knownCopies(s: Series, keys: Set<string> = keysOf(s)): KnownCopy[] {
  const idx = load();
  const out: KnownCopy[] = [];
  const own = s.source?.mangaId ?? null;
  const seen = new Set<string>();
  // The novel is not the comic (`isNovel`), unless the series is the novel.
  const novelsToo = isNovel(s.title) || isNovel(s.source?.title ?? '');
  for (const [sourceId, l] of lists) {
    const src = idx.sources[sourceId];
    for (const key of keys) {
      for (const id of l.keys.get(key) ?? []) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (id !== own && !novelsToo && isNovel(l.data.titles[id] ?? '')) continue;
        const c = idx.counts[id];
        out.push(
          overlay({ mangaId: id, sourceId, sourceName: src?.name ?? sourceId, lang: src?.lang ?? '', title: l.data.titles[id] ?? '', current: id === own, profile: c?.p ?? null, countedAt: c?.at ?? null, via: null })
        );
      }
    }
  }
  // The linked copy, even when no listing has named it yet.
  if (own && !seen.has(own)) {
    const c = idx.counts[own];
    out.push({ mangaId: own, sourceId: owner.get(own) ?? '', sourceName: s.source!.sourceName, lang: '', title: s.source!.title, current: true, profile: c?.p ?? null, countedAt: c?.at ?? null, via: null });
  }
  return out;
}

/** The newest chapter on the linked source: its counted copy, else what the sweep recorded. */
function ownNewest(s: Series): number | null {
  const own = s.source?.mangaId;
  const c = own ? load().counts[own] : undefined;
  if (c) return c.p.latest;
  return s.sourceChapter ?? null;
}

/** Copies of a series ahead of its own, best first (`aheadOf`). */
export function aheadCopies(s: Series, now = Date.now()): CopyCount[] {
  const known = knownCopies(s);
  const copies: CopyCount[] = known
    .filter((c) => !c.current && c.profile && c.countedAt !== null && c.sourceName !== s.source?.sourceName)
    .map((c) => ({ source: c.sourceName, mangaId: c.mangaId, latest: c.profile!.latest, distinct: c.profile!.distinct, at: c.countedAt!, ...(c.via ? { via: c.via } : {}) }));
  // And copies only a linked server knows of, on a source this one has no copy listed on.
  const here = new Set(known.map((c) => c.sourceId));
  const novelsToo = isNovel(s.title) || isNovel(s.source?.title ?? '');
  for (const c of peerCopiesFor(keysOf(s))) {
    if (here.has(c.s) || c.sourceName === s.source?.sourceName || (!novelsToo && isNovel(c.t))) continue;
    here.add(c.s);
    copies.push({ source: c.sourceName, mangaId: '', latest: c.p.latest, distinct: c.p.distinct, at: c.at, via: c.via });
  }
  return aheadOf(ownNewest(s), copies, now);
}

/* ---------------------------------------------------------------- telling you */

/** Up to three a pass by name; more than that is one nudge saying how many, so a first check does not fill the screen. */
const NAMED_AT_MOST = 3;
const NUDGE_LIFE_MS = 3 * 24 * 60 * 60_000;

export async function tellAhead(now = Date.now()): Promise<number> {
  const idx = load();
  if (!idx.settings.nudge) return 0;
  const store = read();
  const news: Array<{ s: Series; best: CopyCount }> = [];
  for (const s of store.series) {
    if (!s.source || isPutAway(store, s)) continue;
    const best = aheadCopies(s, now)[0];
    if (worthTelling(best, idx.told[s.id])) news.push({ s, best: best! });
  }
  if (news.length === 0) return 0;
  const pushDefault = Boolean((await getSettings()).pushDefault);
  const base = { taskId: null, earliestAt: now, expiresAt: now + NUDGE_LIFE_MS, minQuality: 'any' as const, pushToPhone: resolvePush(null, pushDefault) ? 1 : 0 };
  if (news.length <= NAMED_AT_MOST) {
    for (const { s, best } of news) {
      await db.insert(nudges).values({ ...base, title: `📚 ${s.title}`, body: `More chapters elsewhere: ${aheadText(best, ownNewest(s), s.source?.sourceName ?? null)}` });
    }
  } else {
    await db.insert(nudges).values({
      ...base,
      title: '📚 More chapters on other sources',
      body: `${news.length} series have chapters on another source that yours does not, ${news.slice(0, 3).map(({ s }) => s.title).join(', ')} among them. Manga → More lists them.`,
    });
  }
  for (const { s, best } of news) idx.told[s.id] = best.latest!;
  touched('index');
  changes.emitChange('nudges');
  return news.length;
}

/** The series with another source ahead, for the card on More. */
export function aheadList(now = Date.now()): Array<{ id: string; title: string; own: number | null; ownSource: string | null; best: CopyCount; others: number }> {
  const store = read();
  const out = [];
  for (const s of store.series) {
    if (!s.source) continue;
    const ahead = aheadCopies(s, now);
    if (ahead.length) out.push({ id: s.id, title: s.title, own: ownNewest(s), ownSource: s.source.sourceName, best: ahead[0]!, others: ahead.length });
  }
  return out.sort((a, b) => b.best.latest! - (b.own ?? 0) - (a.best.latest! - (a.own ?? 0)));
}

/* ---------------------------------------------------------------- Suwayomi */

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
/** Sources asked at once. Each is still asked one thing at a time, so a site sees no more than before; this only decides how many sites are being asked. */
const AT_ONCE = 6;

async function adapterFor(start: boolean): Promise<SuwayomiAdapter | null> {
  const store = read();
  const url = effectiveUrl(store, DEFAULT_BASE_URL);
  if (!url) throw new Error('no source is set up — choose where chapters come from first');
  if (store.manageSuwayomi && store.suwayomiJar) {
    if (!start && suwayomiProcess.state.state !== 'running') return null;
    const started = await suwayomiProcess.ensureRunning(store.suwayomiJar, url, store.suwayomiMode);
    if (started.state === 'failed') throw new Error(`Suwayomi would not start — ${started.problem}`);
  }
  return new SuwayomiAdapter(url, store.ignoredSources.map((s) => s.id));
}

const keepAwake = () => {
  const store = read();
  if (store.manageSuwayomi) suwayomiProcess.touch(store.suwayomiMode);
};

/** The sources to ask: installed, in your languages, not ignored, not the test ones, not your own files. */
async function sourcesToAsk(adapter: SuwayomiAdapter): Promise<Array<{ id: string; displayName: string; lang: string; supportsLatest: boolean }>> {
  const tests = new Set(testSources().map((t) => t.id));
  const all = (await adapter.listSources()).filter((s) => !tests.has(s.id) && s.id !== '0' && s.lang !== 'localsourcelang');
  const wanted = sourcesToSearch(all, read().readLanguages).searched;
  for (const s of wanted) ensureSource({ id: s.id, name: s.name, lang: s.lang, supportsLatest: s.supportsLatest });
  return wanted.map((s) => ({ id: s.id, displayName: s.name, lang: s.lang, supportsLatest: s.supportsLatest }));
}

/**
 * What Suwayomi already stored: every series it has listed, and the chapter
 * lists it fetched, each counted as of when it was fetched. Its own database,
 * no site asked. Once a day at most.
 */
async function seed(adapter: SuwayomiAdapter): Promise<void> {
  const idx = load();
  if (idx.seededAt !== null && Date.now() - idx.seededAt < 24 * 60 * 60_000) return;
  const names = new Map((await adapter.listSources()).map((s) => [s.id, s]));
  const stored = await adapter.storedSeries();
  const toCount: string[] = [];
  for (const m of stored) {
    const src = names.get(m.sourceId);
    if (!src || testSources().some((t) => t.id === m.sourceId)) continue;
    ensureSource({ id: src.id, name: src.name, lang: src.lang, supportsLatest: src.supportsLatest });
    const l = listOf(src.id);
    if (l.data.titles[m.id] !== m.title) {
      l.data.titles[m.id] = m.title;
      index_(l, src.id, m.id, m.title);
      touched(src.id);
    }
    if (m.chaptersAt !== null && (idx.counts[m.id]?.at ?? 0) < m.chaptersAt) toCount.push(m.id);
  }
  const at = new Map(stored.map((m) => [m.id, m.chaptersAt]));
  const lists_ = await adapter.storedChapterLists(toCount);
  for (const id of toCount) noteCount(id, lists_.get(id) ?? [], at.get(id) ?? Date.now());
  idx.seededAt = Date.now();
  touched('index');
}

/* ---------------------------------------------------------------- the library check */

export interface CheckState {
  running: boolean;
  /** Checking the library, or mapping whole sources. */
  kind: 'check' | 'map' | null;
  phase: 'starting' | 'seeding' | 'naming' | 'searching' | 'counting' | 'mapping' | 'done';
  total: number;
  done: number;
  /** Copies of library series found on other sources. */
  found: number;
  /** Series with another source ahead, at the end. */
  ahead: number;
  sources: number;
  startedAt: number | null;
  finishedAt: number | null;
  problem: string | null;
  stopping: boolean;
  /** Sources resting after refusing, and until when. */
  held: { source: string; until: number; why: string }[];
  /** Sources left out of the rest of this run, having refused after every rest. */
  dropped: { source: string; why: string }[];
  /** Started by the sweep rather than by the button. */
  automatic: boolean;
}

let state: CheckState = {
  running: false,
  kind: null,
  phase: 'done',
  total: 0,
  done: 0,
  found: 0,
  ahead: 0,
  sources: 0,
  startedAt: null,
  finishedAt: null,
  problem: null,
  stopping: false,
  held: [],
  dropped: [],
  automatic: false,
};

/** A wait that ends early when the run is stopped. */
async function nap(ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!state.stopping && Date.now() < end) await sleep(Math.min(1_000, end - Date.now()));
}

/** "HTTP error 502" out of Suwayomi's "Exception while fetching data (/fetchSourceManga) : HTTP error 502" and the Java stack trace under it. */
const shortReason = (message: string) =>
  message
    .replace(/^Exception while fetching data \([^)]*\)\s*:\s*/, '')
    .split('\n')[0]!
    .trim()
    .slice(0, 160);

/**
 * One queue per source, at most `AT_ONCE` sources at a time, each one thing at a
 * time with `PAUSE_MS` after every answer.
 *
 * A source that refuses (`isRefusal`: too many requests, a Cloudflare check, no
 * answer in time) is left alone for 10, then 20, then 40 minutes while the
 * others carry on, and the series it refused is asked again first when it is
 * back. Refusing once more after all three is the site saying no for today: it
 * is left out of the rest of the run, and the card says so. Carrying on at the
 * same pace through a site that has said stop is how a short block becomes a
 * long one, and it is the same connection you read on.
 */
async function bySource<T>(queues: Map<string, T[]>, nameOf: (sourceId: string) => string, work: (sourceId: string, item: T) => Promise<void>): Promise<void> {
  const left = new Map([...queues].map(([id, items]) => [id, [...items]]));
  const busy = new Set<string>();
  const notBefore = new Map<string, number>();
  const refusals = new Map<string, number>();
  const unhold = (sourceId: string) => (state.held = state.held.filter((h) => h.source !== nameOf(sourceId)));
  const ready = () => {
    const now = Date.now();
    for (const [id, items] of left) if (items.length && !busy.has(id) && (notBefore.get(id) ?? 0) <= now) return id;
    return null;
  };
  const worker = async () => {
    while (!state.stopping) {
      const sourceId = ready();
      if (!sourceId) {
        // Nothing to take: the rest are being asked by other workers, or resting.
        if (![...left].some(([id, items]) => items.length && !busy.has(id))) return;
        await nap(1_000);
        continue;
      }
      busy.add(sourceId);
      unhold(sourceId);
      const items = left.get(sourceId)!;
      try {
        while (items.length && !state.stopping) {
          keepAwake();
          let refused: string | null = null;
          try {
            await work(sourceId, items[0]!);
            refusals.delete(sourceId);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // Anything else is about one series, and does not stop the rest.
            if (isRefusal(message)) refused = shortReason(message);
          }
          if (refused) {
            const inARow = (refusals.get(sourceId) ?? 0) + 1;
            refusals.set(sourceId, inARow);
            const next = afterRefusal(inARow);
            if ('drop' in next) {
              state.done += items.length;
              items.length = 0;
              state.dropped.push({ source: nameOf(sourceId), why: `refused ${inARow} times in a row (${refused})` });
              const st = load().sources[sourceId];
              if (st) {
                st.restUntil = Date.now() + REST_AFTER_DROP_MS;
                touched('index');
              }
            } else {
              const until = Date.now() + next.holdMs;
              notBefore.set(sourceId, until);
              state.held.push({ source: nameOf(sourceId), until, why: refused });
            }
            break;
          }
          items.shift();
          state.done++;
          await sleep(PAUSE_MS);
        }
      } finally {
        busy.delete(sourceId);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, left.size) }, worker));
  state.held = [];
}

type AskedSource = { id: string; displayName: string; lang: string; supportsLatest: boolean };

const resting = (sourceId: string, now: number) => (load().sources[sourceId]?.restUntil ?? 0) > now;

/** The searches due: each series on each source that is not mapped and not resting, not searched there in a month nor tried in a day. */
function planSearches(sources: readonly AskedSource[], series: readonly Series[], now: number): Map<string, Series[]> {
  const idx = load();
  const out = new Map<string, Series[]>();
  for (const src of sources) {
    if (idx.sources[src.id]?.mapped || resting(src.id, now)) continue;
    const due = series.filter((s) => searchDue(idx.searched[s.id]?.[src.id], now) && !triedRecently(idx.tried[`search:${s.id}:${src.id}`], now));
    if (due.length) out.set(src.id, due);
  }
  return out;
}

/** The counts due: every copy known, and each series' own, missing or a week old, on a source not resting, not tried in a day. */
function planCounts(
  sources: readonly AskedSource[],
  series: readonly Series[],
  now: number,
  keys?: (s: Series) => Set<string>
): { counts: Map<string, string[]>; found: number } {
  const idx = load();
  const counts = new Map<string, string[]>();
  let found = 0;
  const wanted = new Set(sources.map((s) => s.id));
  for (const s of series) {
    for (const c of keys ? knownCopies(s, keys(s)) : knownCopies(s)) {
      if (!c.current && !wanted.has(c.sourceId)) continue;
      if (!c.current) found++;
      if (!recountDue(c.countedAt ?? undefined, now) || triedRecently(idx.tried[`count:${c.mangaId}`], now)) continue;
      if (c.sourceId && resting(c.sourceId, now)) continue;
      const key = c.sourceId || 'unknown';
      (counts.get(key) ?? counts.set(key, []).get(key)!).push(c.mangaId);
    }
  }
  return { counts, found };
}

async function runCheck(): Promise<void> {
  const adapter = (await adapterFor(true))!;
  state.phase = 'seeding';
  await seed(adapter);
  const sources = await sourcesToAsk(adapter);
  state.sources = sources.length;
  const idx = load();
  const store = read();
  const series = store.series;

  // Every name each series goes by (MangaDex's English one among them, kept a month, so slow only the first time).
  state.phase = 'naming';
  state.total = series.length;
  state.done = 0;
  const names = new Map<string, string[]>();
  for (const s of series) {
    if (state.stopping) return;
    names.set(s.id, await namesFor(s.title, [s.source?.title, ...(s.altTitles ?? []), s.origin?.title]).catch(() => [s.title]));
    state.done++;
  }

  // 1. Searching each source that is not mapped, for each series not searched there in a month.
  state.phase = 'searching';
  const now = Date.now();
  for (const [key, at] of Object.entries(idx.tried)) if (!triedRecently(at, now)) delete idx.tried[key];
  const searches = planSearches(sources, series, now);
  state.total = [...searches.values()].reduce((n, q) => n + q.length, 0);
  state.done = 0;
  const byId = new Map(sources.map((s) => [s.id, s]));
  const nameOf = (id: string) => byId.get(id)?.displayName ?? idx.sources[id]?.name ?? id;
  await bySource(searches, nameOf, async (sourceId, s) => {
    const source = byId.get(sourceId)!;
    idx.tried[`search:${s.id}:${sourceId}`] = Date.now();
    const all = names.get(s.id) ?? [s.title];
    const keys = nameKeys(all);
    const l = listOf(sourceId);
    // The title first; the other names only when it found nothing, which is most of the saving.
    for (const query of searchQueries(all)) {
      const { matches } = await adapter.browse(source, 'SEARCH', 1, query);
      const novelsToo = isNovel(s.title);
      const hits = matches.filter((m) => keys.has(titleKey(m.title)) && (novelsToo || !isNovel(m.title)));
      for (const h of hits) if (!l.found.has(h.id)) (l.found.add(h.id), touched(sourceId), state.found++);
      if (hits.length) break;
      await sleep(PAUSE_MS);
    }
    (idx.searched[s.id] ??= {})[sourceId] = Date.now();
    touched('index');
  });
  if (state.stopping) return;

  // 2. Counting every copy found, and the series' own, where the count is missing or a week old.
  state.phase = 'counting';
  const { counts, found } = planCounts(sources, series, Date.now(), (s) => nameKeys(names.get(s.id) ?? [s.title]));
  state.found = found;
  state.total = [...counts.values()].reduce((n, q) => n + q.length, 0);
  state.done = 0;
  await bySource(counts, nameOf, async (_sourceId, mangaId) => {
    idx.tried[`count:${mangaId}`] = Date.now();
    touched('index');
    try {
      await adapter.chapters(mangaId, true);
    } catch (error) {
      // "No chapters found" is an answer: that copy has none.
      if (error instanceof SourceError && /no chapters/i.test(error.message)) noteCount(mangaId, []);
      else throw error;
    }
  });
  if (state.stopping) return;

  state.ahead = aheadList().length;
  await tellAhead();
}

/* ---------------------------------------------------------------- mapping whole sources */

/** Pages of a source's list read with nothing new before a mapping decides the list repeats. */
const STALE_PAGES = 3;
const MAX_PAGES = 5_000;

/** Read up to `pages` more of a source's popular list. True once it is finished, one way or the other. */
async function mapStep(adapter: SuwayomiAdapter, source: { id: string; displayName: string; lang: string; supportsLatest: boolean }, pages: number): Promise<boolean> {
  const idx = load();
  const st = ensureSource({ id: source.id, name: source.displayName, lang: source.lang, supportsLatest: source.supportsLatest });
  if (st.why) return true;
  if (st.mapped && !st.crawl) return true;
  const l = listOf(source.id);
  st.crawl ??= { page: 1, pages: 0, startedAt: Date.now(), stale: 0 };
  for (let i = 0; i < pages && !state.stopping; i++) {
    keepAwake();
    const { matches, hasNextPage } = await adapter.browse(source, 'POPULAR', st.crawl.page);
    let fresh = 0;
    for (const m of matches) if (!l.seen.has(m.id)) (l.seen.add(m.id), fresh++);
    st.crawl.page++;
    st.crawl.pages++;
    st.crawl.stale = fresh === 0 ? st.crawl.stale + 1 : 0;
    touched(source.id);
    touched('index');
    const ended = !hasNextPage || matches.length === 0 || st.crawl.stale >= STALE_PAGES || st.crawl.pages >= MAX_PAGES;
    if (ended) {
      const verdict = st.crawl.stale >= STALE_PAGES ? { mapped: false as const, why: 'its list repeats the same page' } : mapVerdict([...l.found], l.seen, st.crawl.pages);
      if (verdict.mapped) {
        st.mapped = true;
        st.mappedAt = Date.now();
        st.why = null;
      } else if (!st.mapped) {
        st.why = verdict.why;
      }
      st.crawl = null;
      l.seen.clear();
      touched(source.id);
      return true;
    }
    await sleep(PAUSE_MS);
  }
  idx.sources[source.id] = st;
  return false;
}

/**
 * A mapped source's look at what is new: its latest list, page by page until a
 * page holds nothing new (three at most). A library series on it is counted
 * again, since something changed there. A mapped source with no latest list is
 * mapped again from the start, monthly, still mapped meanwhile.
 */
async function latestStep(adapter: SuwayomiAdapter, source: { id: string; displayName: string; lang: string; supportsLatest: boolean }): Promise<void> {
  const st = ensureSource({ id: source.id, name: source.displayName, lang: source.lang, supportsLatest: source.supportsLatest });
  const now = Date.now();
  if (!st.mapped || st.crawl) return;
  if (!source.supportsLatest) {
    if (st.mappedAt !== null && now - st.mappedAt >= REMAP_EVERY_MS) st.crawl = { page: 1, pages: 0, startedAt: now, stale: 0 };
    return;
  }
  if (!latestDue(st.latestAt, now)) return;
  const l = listOf(source.id);
  const libraryIds = new Set(read().series.flatMap((s) => knownCopies(s).filter((c) => c.sourceId === source.id).map((c) => c.mangaId)));
  for (let page = 1; page <= 3; page++) {
    keepAwake();
    const before = new Set(Object.keys(l.data.titles));
    const { matches } = await adapter.browse(source, 'LATEST', page);
    for (const m of matches) {
      if (!libraryIds.has(m.id)) continue;
      await sleep(PAUSE_MS);
      await adapter.chapters(m.id, true).catch((error: unknown) => {
        // A site saying stop ends this look; the next sweep tries again.
        if (error instanceof Error && isRefusal(error.message)) throw error;
      });
    }
    if (matches.every((m) => before.has(m.id))) break;
    await sleep(PAUSE_MS);
  }
  st.latestAt = Date.now();
  touched('index');
}

async function runMap(): Promise<void> {
  const adapter = (await adapterFor(true))!;
  state.phase = 'seeding';
  await seed(adapter);
  const sources = (await sourcesToAsk(adapter)).filter((s) => {
    const st = load().sources[s.id];
    return !st?.why && !(st?.mapped && !st.crawl);
  });
  state.sources = sources.length;
  state.phase = 'mapping';
  state.total = sources.length;
  state.done = 0;
  let next = 0;
  const worker = async () => {
    while (next < sources.length && !state.stopping) {
      const source = sources[next++]!;
      try {
        while (!state.stopping && !(await mapStep(adapter, source, 25))) {
          // Twenty-five pages at a time, so the card moves.
        }
      } catch {
        // A source that fails partway keeps its place for next time.
      }
      state.done++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, sources.length) }, worker));
}

function start(kind: 'check' | 'map', automatic = false): CheckState {
  if (state.running) return state;
  state = {
    running: true,
    kind,
    phase: 'starting',
    total: 0,
    done: 0,
    found: 0,
    ahead: 0,
    sources: 0,
    startedAt: Date.now(),
    finishedAt: null,
    problem: null,
    stopping: false,
    held: [],
    dropped: [],
    automatic,
  };
  void (kind === 'check' ? runCheck() : runMap())
    .catch((error: unknown) => {
      state.problem = error instanceof Error ? error.message : String(error);
    })
    .finally(() => {
      state.running = false;
      state.phase = 'done';
      state.finishedAt = Date.now();
      flushCatalogue();
      // A run nobody pressed for need not refetch every screen; the card asks for itself.
      if (!automatic) changes.emitChange('all');
    });
  return state;
}

export const startCheck = () => start('check');
export const startMapping = () => start('map');

/** Until when the automatic check waits after Stop: a day, or it would start again at the next sweep. In memory, so a restart lets it go again. */
let autoPausedUntil = 0;

export function stopCatalogue(): CheckState {
  if (state.running) {
    state.stopping = true;
    autoPausedUntil = Date.now() + DAY_MS;
  }
  return state;
}

/**
 * The automatic check: started from the sweep when the setting is on, nothing
 * else is running, Suwayomi is already up and something is due. Not on a
 * friend's copy, which shares this connection: every copy searching every site
 * for its own library would multiply what the sites see from this PC.
 */
function startAutomatic(sources: readonly AskedSource[]): void {
  const idx = load();
  if (isGuest || !idx.settings.automatic || state.running || Date.now() < autoPausedUntil) return;
  const now = Date.now();
  const series = read().series;
  if (planSearches(sources, series, now).size === 0 && planCounts(sources, series, now).counts.size === 0) return;
  start('check', true);
}

/* ---------------------------------------------------------------- the sweep's part */

/** Pages a sweep reads of a source not yet mapped, and how many such sources. */
const SWEEP_PAGES = 4;
const SWEEP_SOURCES = 2;

/**
 * From the release sweep, only while Suwayomi is already up: a few pages of a
 * couple of sources not yet mapped (when background mapping is on), each mapped
 * source's daily look at what is new, and the nudges.
 */
export async function catalogueSweep(): Promise<void> {
  // Linked servers' catalogues, every six hours each: asks them, never a site, so not only while Suwayomi is up.
  await refreshPeerCatalogues().catch(() => 0);
  if (state.running) return;
  const adapter = await adapterFor(false).catch(() => null);
  if (!adapter) {
    await tellAhead().catch(() => 0);
    return;
  }
  const idx = load();
  // What Suwayomi already holds, once a day: its own database, no site asked.
  await seed(adapter).catch(() => undefined);
  const sources = await sourcesToAsk(adapter).catch(() => []);
  if (idx.settings.background) {
    const unmapped = sources.filter((s) => !idx.sources[s.id]?.why && (!idx.sources[s.id]?.mapped || idx.sources[s.id]?.crawl)).slice(0, SWEEP_SOURCES);
    for (const s of unmapped) await mapStep(adapter, s, SWEEP_PAGES).catch(() => false);
  }
  for (const s of sources) await latestStep(adapter, s).catch(() => undefined);
  await tellAhead().catch(() => 0);
  flushCatalogue();
  if (sources.length) startAutomatic(sources);
}

/* ---------------------------------------------------------------- for linked servers */

/**
 * Every copy this server has counted, by source id and the series' name there,
 * for a linked server (`/api/peer/manga/catalogue`). Counts only: no Suwayomi id,
 * which means nothing to another install, and nothing about the library.
 */
export function catalogueForPeer(): { sources: Array<{ id: string; name: string; lang: string }>; copies: Array<{ s: string; t: string; p: CopyProfile; at: number }> } {
  const idx = load();
  const tests = new Set(testSources().map((t) => t.id));
  const copies = [];
  for (const [id, counted] of Object.entries(idx.counts)) {
    const sourceId = owner.get(id);
    if (!sourceId || tests.has(sourceId) || !/^\d{1,25}$/.test(sourceId)) continue;
    const title = lists.get(sourceId)?.data.titles[id];
    if (!title) continue;
    copies.push({ s: sourceId, t: title, p: counted.p, at: counted.at });
  }
  const sources = Object.entries(idx.sources)
    .filter(([id]) => !tests.has(id))
    .map(([id, src]) => ({ id, name: src.name, lang: src.lang }));
  return { sources, copies };
}

/* ---------------------------------------------------------------- for the screen */

export function catalogueStatus() {
  const idx = load();
  const store = read();
  const wanted = new Set(store.readLanguages.map((l) => l.toLowerCase()));
  const sources = Object.entries(idx.sources)
    .filter(([, s]) => wanted.size === 0 || wanted.has(s.lang.toLowerCase()) || s.lang === 'all')
    .map(([id, s]) => ({
      id,
      name: s.name,
      series: Object.keys(lists.get(id)?.data.titles ?? {}).length,
      mapped: s.mapped,
      mappedAt: s.mappedAt,
      mapping: s.crawl ? { pages: s.crawl.pages } : null,
      why: s.why,
      latestAt: s.latestAt,
    }))
    .sort((a, b) => Number(b.mapped) - Number(a.mapped) || b.series - a.series);
  const counted = Object.keys(idx.counts).length;
  const linked = store.series.filter((s) => s.source);
  const withOthers = linked.filter((s) => knownCopies(s).some((c) => !c.current && c.profile)).length;
  return {
    state,
    settings: idx.settings,
    sources,
    counted,
    library: linked.length,
    withOthers,
    ahead: aheadList().slice(0, 50),
    seededAt: idx.seededAt,
    automaticHere: !isGuest,
    autoPausedUntil: autoPausedUntil > Date.now() ? autoPausedUntil : null,
  };
}

export function setCatalogueSettings(patch: Partial<CatalogueSettings>): CatalogueSettings {
  const idx = load();
  if (typeof patch.nudge === 'boolean') idx.settings.nudge = patch.nudge;
  if (typeof patch.background === 'boolean') idx.settings.background = patch.background;
  if (typeof patch.automatic === 'boolean') {
    idx.settings.automatic = patch.automatic;
    if (patch.automatic) autoPausedUntil = 0;
  }
  touched('index');
  flushCatalogue();
  return idx.settings;
}

/** Allows a source that could not be mapped to be tried again. */
export function retryMapping(sourceId: string): void {
  const st = load().sources[sourceId];
  if (!st) return;
  st.why = null;
  st.crawl = null;
  touched('index');
}
