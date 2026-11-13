/**
 * Talking to this package's own endpoints.
 *
 * Its own thin client rather than entries on `api` in core, because core must
 * not know a package exists — the same rule that keeps `hidden_providers` an
 * opaque slug and `tasks.source` an unvalidated string. What it borrows from
 * core is `getToken`, since every `/api/` call needs the bearer token and there
 * is no sense keeping a second copy of where it is stored.
 */
import { apiRequest, getToken } from '@app/api';
import { cachedResponse, fetchPage, replaceSavedPage, savedPages } from './offline-store';
import { blobOriginal, noteOriginal, objectUrlFor, readOriginalSize } from './original-size';
import { blobIsWholeImage } from './image-bytes';
import { beginTransfer, readingLevel, withQuality } from './quality';
import { keptBlob } from '@app/offline-sync';

export type SeriesStatus = 'ongoing' | 'completed' | 'hiatus' | 'cancelled' | 'unknown';

export interface SeriesSummary {
  id: string;
  title: string;
  /** Names it went by before linking renamed it. Optional: an older server does not send them. */
  altTitles?: string[];
  status: SeriesStatus;
  latestChapter: string | null;
  totalChapters: number | null;
  chapterLabel: string;
  chapterTitle: string;
  checkedAt: number | null;
  error: string | null;
  /** Since when its checks have failed. Optional: an older server does not send it. */
  failingSince?: number | null;
  /** When an automatic switch last found no other source. */
  switchTriedAt?: number | null;
  /** The source it was last switched away from, when and why. */
  switchedFrom?: { sourceName: string; at: number; why: string; automatic: boolean } | null;
  addedAt: number;
  /** Starred. Optional: an older server does not send it. */
  favourite?: boolean;
  /** Your rating, 1 to 10, or null. Absent from an older server. */
  rating?: number | null;
  /** Which shelves it is on, by id. Absent means none — see `Series.libraries`. */
  libraries?: string[];
  coverPath: string | null;
  url: string | null;
  malId: number | null;
  anilistId: number | null;
  watching: boolean;
  notWatchingBecause: string | null;
  source: { adapter: string; sourceName: string; title: string; mangaId: string } | null;
  /** Your verdicts on sources that claimed to be ahead. Optional: an older server does not send them. */
  reviews?: SourceReview[];
  /** Where you are in it, on the library list. Optional for the same reason. */
  position?: ReadingPosition | null;
  /** The newest chapter as a number — the bar under each cover. The rest are for the grid's badge and sorting. */
  latestNumber?: number | null;
  /** The furthest chapter finished. */
  readUpTo?: number | null;
  /** When a chapter last landed, as far as this app has noticed. */
  lastReleaseAt?: number | null;
  /** When you last read any of it. */
  lastReadAt?: number | null;
  /** Brought in from another app: which, and the site it was last read on there. */
  origin?: { app: string; site: string };
  /** Genres from its source. Absent until they have been asked for. */
  tags?: string[];
  /** Kept on the PC, every chapter: by any copy, since the PC keeps one store for all. Absent from an older server. */
  kept?: boolean;
}

/** What was read in Manga Reader, from the backup — see `old-history.ts` on the server. */
export interface OldHistorySearch {
  available: boolean;
  total: number;
  matches: Array<{
    title: string;
    sites: string[];
    chaptersRead: number;
    furthest: number | null;
    lastChapter: string | null;
    lastReadAt: number | null;
    favourite: boolean;
    /** The series in your library now, if it is. */
    following: string | null;
  }>;
}

/** Finding a source for every series without one — see `find-sources.ts` on the server. */
export interface FindSourcesState {
  running: boolean;
  /** Absent from a server older than switching. */
  mode?: 'unlinked' | 'gone';
  total: number;
  done: number;
  linked: number;
  notFound: number;
  failed: number;
  recent: string[];
  finishedAt: number | null;
  problem: string | null;
  unlinked: number;
  /** Series whose source has lost them. Absent from a server older than switching. */
  gone?: number;
}

/** FlareSolverr on this PC: installed or not, running or not, and how a download is going. */
export interface FlareState {
  installed: boolean;
  version: string | null;
  bytes: number | null;
  running: boolean;
  lastUsedAt: number | null;
  installing: { step: string; received: number; total: number | null } | null;
  problem: string | null;
  unavailable: string | null;
}

/** A source left out of searching and browsing. */
export interface IgnoredSource {
  id: string;
  name: string;
}

/** One line of the History tab — a chapter finished, or the one you are partway through. */
export interface HistoryEntry {
  seriesId: string;
  title: string;
  coverPath: string | null;
  chapter: number;
  chapterName: string | null;
  source: string | null;
  at: number;
  kind: 'read' | 'reading';
  page: number | null;
  pages: number | null;
  /** Whether it is in your library. Optional: an older server sends only followed ones. */
  following?: boolean;
  /** The source's own id, on a not-following row — enough to open its details card. */
  sourceMangaId?: string;
}

/** Your place inside a chapter — see `ReadingPosition` on the server. */
export interface ReadingPosition {
  chapter: number;
  chapterId: string;
  chapterName: string;
  source: string;
  mangaId: string;
  page: number;
  /** How far down that page, 0 to 1. */
  offset: number;
  pages: number;
  at: number;
}

/** One verdict about one source's claim to be ahead — see `SourceReview` on the server. */
export interface SourceReview {
  key: string;
  upTo: number;
  verdict: 'real' | 'fake';
  at: number;
}

export interface SourceHealth {
  reachable: boolean;
  sources: string[];
  /** Languages the installed sources cover, most sources first. Optional: older servers omit it. */
  languages?: Array<{ code: string; count: number }>;
  problem: string | null;
}

/** What one source search asked, as well as what it found. */
export interface SourceSearch {
  results: SourceMatch[];
  /** How many sources were asked. Optional: an older server does not say. */
  searched?: number;
  /** How many were left out by language. */
  skipped?: number;
  /** The languages the search was limited to, or null when it asked every one. */
  languages?: string[] | null;
  /** The saved setting, which a one-off wide search does not change. */
  readLanguages?: string[];
  /** Every language the installed sources cover, most sources first. */
  available?: Array<{ code: string; count: number }>;
  /** Every name the series was searched under (its title, then others such as the English one). An older server does not say. */
  queries?: string[];
}

/**
 * How eagerly the app runs a source it manages.
 *
 * `on-demand` keeps a 166MB JVM off the machine for the hours you are not
 * reading, at six seconds when you are. `always` spends the memory to make
 * opening a chapter instant.
 */
export type SuwayomiMode = 'on-demand' | 'always';

export interface SourceExtension {
  pkg: string;
  name: string;
  lang: string;
  version: string;
  installed: boolean;
  hasUpdate: boolean;
  nsfw: boolean;
  iconUrl: string | null;
}

export interface ExtensionList {
  extensions: SourceExtension[];
  repos: string[];
  /** Offered by name, because a fresh Suwayomi has none and finds nothing. */
  suggestedRepo: string;
  /** By package: series linked to its sources, chapters read there, and the sources. Absent from an older server. */
  usage?: Record<string, ExtensionUsage>;
  /** Packages flagged to install later: asked for by a guest copy, or flagged from before any device could install. */
  flagged?: string[];
  /** By package, which guest copies asked for it (plan A). The host's screen lists them. */
  askedBy?: Record<string, string[]>;
  /** This is a guest copy: it asks the host for sources rather than managing them. */
  onHost?: boolean;
  readLanguages?: string[];
  /** Whether they update themselves once a day. Absent from an older server. */
  autoUpdate?: boolean;
  /** When they last updated, by themselves or from the button, and what that did. */
  lastCheck?: { at: number; note: string } | null;
}

export interface ExtensionUsage {
  series: number;
  chapters: number;
  sources: Array<{ id: string; name: string; lang: string }>;
}

/** How "Set up manga" is getting on — see `server/setup.ts`. */
export interface SetupState {
  running: boolean;
  step: string | null;
  received: number;
  total: number | null;
  done: boolean;
  problem: string | null;
  /** What the last run did, in words. Absent from an older server. */
  result?: string | null;
  /** When extensions last updated themselves (once a day while Suwayomi runs), and what it did. */
  lastExtensionCheck?: { at: number; note: string } | null;
}

/** What the app's own Suwayomi process is doing, when it is managing one. */
export type ManagedState =
  | { state: 'off' }
  | { state: 'starting'; since: number }
  | { state: 'running'; since: number; pid: number | null }
  | { state: 'failed'; problem: string };

export interface SourceState {
  configured: boolean;
  url: string | null;
  defaultUrl: string;
  /** Languages whose sources a search asks. Optional: an older server does not send it. */
  readLanguages?: string[];
  /** The jar this app may run, when one has been chosen. */
  jar: string | null;
  /** May the app start and stop it? */
  manage: boolean;
  /** How eagerly, when it does. */
  mode: SuwayomiMode;
  managed: ManagedState;
  /** Jars found lying around, offered only while none is chosen. */
  foundJars: string[];
  /**
   * Null when nothing is configured **or** when we manage it and it is simply
   * off — the resting state, which is not the same as unreachable.
   */
  health: SourceHealth | null;
  /**
   * A guest copy (plan A): it reads through the host's Suwayomi, which the host
   * sets up, starts and updates. Absent from an older server.
   */
  onHost?: boolean;
}

export interface SourceChapter {
  id: string;
  number: number;
  name: string;
  uploadedAt: number | null;
  scanlator: string | null;
  read: boolean;
  /** The source it was read on, when that was recorded. */
  readOn?: string | null;
}

export interface ChapterList {
  seriesTitle: string;
  sourceName: string;
  /** The linked copy's id, to tell whether a saved place was measured on it. */
  mangaId?: string;
  position?: ReadingPosition | null;
  chapters: SourceChapter[];
}

export interface SourceMatch {
  id: string;
  title: string;
  sourceName: string;
  /** The source's language code. Optional: an older server does not send it. */
  lang?: string | null;
  url: string | null;
  thumbnailUrl: string | null;
  /** How well the title answers the search, 0–100. Optional for the same reason. */
  score?: number;
}

/** The shape of one source's chapter list — see `profileChapters` on the server. */
export interface ChapterProfile {
  entries: number;
  distinct: number;
  first: number | null;
  latest: number | null;
  latestChapterId: string | null;
  missing: number;
  missingSample: number[];
  newestUpload: number | null;
}

/** Whether a chapter's pages are real — see `judgePages` on the server. */
export interface PageCheck {
  pages: number;
  state: 'fine' | 'suspicious' | 'broken';
  problem: string | null;
}

/* ---- browsing: see `server/browse.ts` for why each of these is shaped so ---- */

export interface BrowseSource {
  id: string;
  name: string;
  lang: string;
  /** Not every source keeps a list of recent releases. */
  supportsLatest: boolean;
}

export interface BrowseState {
  /** The sources in the languages you read. */
  sources: BrowseSource[];
  selected: string | null;
  readLanguages: string[];
  /** Every source installed, whatever its language. */
  installed: number;
}

export interface BrowseResult extends SourceMatch {
  sourceId?: string;
  coverPath: string | null;
  /** The id of a series you follow that this is — by this copy, or by name. */
  following: string | null;
  /** That series has no source yet, so reading this copy would link it. */
  unlinked?: boolean;
  /**
   * How many chapters it has, as Suwayomi has stored them; null when it has
   * not fetched them yet (ask `browse.chapters`). Absent from an older server.
   */
  chapters?: number | null;
}

/** A filter as a source declares it. Redeclared by hand, as `api.ts` does, since the PWA imports nothing from the server. */
export type SourceFilter =
  | { kind: 'checkbox'; name: string; default: boolean }
  | { kind: 'tristate'; name: string; default: TriState }
  | { kind: 'select'; name: string; values: string[]; default: number }
  | { kind: 'sort'; name: string; values: string[]; default: { index: number; ascending: boolean } | null }
  | { kind: 'text'; name: string; default: string }
  | { kind: 'group'; name: string; filters: SourceFilter[] }
  | { kind: 'header'; name: string }
  | { kind: 'separator' };

export type TriState = 'ignore' | 'include' | 'exclude';

export type FilterChange = {
  position: number;
  inner?: number;
  checkbox?: boolean;
  tristate?: TriState;
  select?: number;
  sort?: { index: number; ascending: boolean };
  text?: string;
};

export interface ResultGroup {
  key: string;
  title: string;
  score: number;
  /** Whether the source you browse from has it. */
  preferred: boolean;
  entries: BrowseResult[];
  following: string | null;
}

export interface GroupedSearch {
  groups: ResultGroup[];
  searched: number;
  skipped: number;
  preferred: { id: string; name: string } | null;
  preferredProblem: string | null;
  filtersApplied: number;
  filtersDropped: number;
  onlyPreferred: boolean;
  languages: string[] | null;
}

/** A source's series, for its detail page — see the route of the same path. */
export interface SeriesDetailPage {
  id: string;
  title: string;
  author: string | null;
  artist: string | null;
  description: string | null;
  genres: string[];
  status: 'ongoing' | 'completed' | 'hiatus' | 'cancelled' | 'licensed' | 'unknown';
  url: string | null;
  sourceId: string | null;
  sourceName: string;
  lang: string | null;
  /** The site would not answer; this is Suwayomi's stored copy. */
  stale: boolean;
  coverPath: string | null;
  following: string | null;
  unlinked?: boolean;
  /** Newest first, with your read marks when you follow the series or have read it. */
  chapters: Array<Omit<SourceChapter, 'read'> & { read?: boolean }>;
  /** Your place, when you follow it or have read it, and it was measured on this copy. */
  position?: ReadingPosition | null;
  /** Your record of it when you read it without following — see `Glimpse`. */
  glimpseId?: string | null;
  profile: ChapterProfile;
  chaptersProblem: string | null;
}

export interface Candidate {
  mangadexId: string | null;
  malId: number | null;
  anilistId: number | null;
  muId: number | null;
  title: string;
  subtitle: string | null;
  status: SeriesStatus;
  year: number | null;
  coverUrl: string | null;
  coverPath: string | null;
  trackable: boolean;
  already: boolean;
}

export interface RecentRelease {
  seriesId: string;
  title: string;
  chapter: string;
  raisedAt: number;
  coverPath: string | null;
  url: string | null;
}

export interface Library {
  series: SeriesSummary[];
  /** What landed lately, which is what the panel draws. */
  recent: RecentRelease[];
  credit: string;
  watching: number;
  /** Whether a new chapter also becomes a task. Optional: an older server does not send it. */
  releaseTasks?: boolean;
  /** Whether a new chapter raises a notification at all. Optional for the same reason. */
  releaseNudges?: boolean;
  /** Which series notify: null for every one. Absent from an older server. */
  releaseNudgesFor?: { favourites: boolean; shelves: string[] } | null;
  /** Whether a source failing for two days is switched to another. Absent from an older server. */
  autoSwitchSources?: boolean;
  /** Chapters fetched ahead while reading. Optional: an older server sends neither. */
  readAheadChapters?: number;
  maxReadAhead?: number;
  /** What the Dashboard card lists and how. Optional: an older server sends neither. */
  shelfShow?: 'all' | 'favourites';
  shelfSort?: 'follow' | 'read' | 'catchup' | 'updated' | 'title' | 'added';
  shelfNewFirst?: boolean;
  shelfFavFirst?: boolean;
  /** The shelves, with how many series are on each. Counts overlap. */
  libraries?: Array<{ id: string; name: string; count: number; hidden?: boolean }>;
}

export interface SweepResult {
  checked: number;
  raised: number;
  failed: number;
  series: SeriesSummary[];
}

/**
 * Through core's request rather than a fetch of its own, which is what makes
 * this package work offline like the rest of the app: your library and chapter
 * lists open offline, and changes that cannot be queued say they need the PC.
 * Same token, the server's own words in errors, and the same "unreachable".
 */
async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  return apiRequest<T>(path, init);
}

/** One archived series, as the server counts it. */
export interface ArchiveProgress {
  seriesId: string;
  title: string;
  folder: string;
  addedAt: number;
  chapters: number;
  complete: number;
  /** Tried and could not be finished. Reported, never hidden. */
  failed: number;
  pages: number;
  bytes: number;
  queued: number;
  updatedAt: number;
  /** Chapter numbers complete on the PC — see the server's `archive.ts`. */
  savedChapters: number[];
  /** Who asked for it to be kept: `you`, or friends' copies by name. Absent from an older server. */
  /** Chapters saved from another source because the series' own would not give them whole. */
  fromElsewhere?: Array<{ sourceName: string; count: number }>;
  /** Parts (3.1) kept as the whole chapter they are in (3), from another source. */
  asWhole?: Array<{ number: number; whole: number; sourceName: string }>;
  keptFor?: string[];
}

export interface ArchiveOverview {
  series: ArchiveProgress[];
  queued: number;
  working: { seriesId: string; number: number; name: string } | null;
  bytes: number;
  root: string;
  disk?: { bytes: number; files: number };
  /** A friend's copy: this is the host's store, which it reads and adds to but does not manage. */
  onHost?: boolean;
}

/** What adds to the Local collection by itself, and who sees your ratings. */
export interface CollectionRules {
  autoKeepFavourites: boolean;
  autoKeepMinRating: number | null;
  shareRatingsWithCopies: boolean;
  /** How the collection keeps pictures; absent on a friend's copy, where the host decides. */
  archiveQuality?: 'original' | 'smaller' | 'smallest';
  /** Whether the PC can make pictures smaller at all (`server/compress.ts`). */
  compressionAvailable?: boolean;
}

export const manga = {
  list: () => call<Library>('/api/manga'),
  history: () => call<{ entries: HistoryEntry[] }>('/api/manga/history'),
  /** Manga Reader's history, searched by title — see `old-history.ts` on the server. */
  oldHistory: (q: string) => call<OldHistorySearch>(`/api/manga/old-history?q=${encodeURIComponent(q)}`),
  search: (q: string) => call<{ results: Candidate[] }>(`/api/manga/search?q=${encodeURIComponent(q)}`),
  add: (candidate: Candidate) =>
    call<SeriesSummary>('/api/manga', { method: 'POST', body: JSON.stringify(candidate) }),
  remove: (id: string) => call<{ ok: true }>(`/api/manga/${id}`, { method: 'DELETE' }),
  checkNow: () => call<SweepResult>('/api/manga/check', { method: 'POST' }),
  setReleaseNudges: (on: boolean) =>
    call<{ releaseNudges: boolean }>('/api/manga/release-nudges', { method: 'PUT', body: JSON.stringify({ on }) }),
  setReleaseScope: (scope: { favourites: boolean; shelves: string[] } | null) =>
    call<{ releaseNudgesFor: { favourites: boolean; shelves: string[] } | null }>('/api/manga/release-nudges/scope', {
      method: 'PUT',
      body: JSON.stringify({ scope }),
    }),
  setAutoSwitch: (on: boolean) => call<{ autoSwitchSources: boolean }>('/api/manga/auto-switch', { method: 'PUT', body: JSON.stringify({ on }) }),
  /** A new source for one series, now. About fifteen seconds. */
  switchSource: (id: string) =>
    call<{
      outcome: { kind: 'switched'; from: string; to: string; chapters: number } | { kind: 'notFound'; from: string } | { kind: 'failed'; problem: string } | { kind: 'skipped' };
      series: SeriesSummary | null;
    }>(`/api/manga/${encodeURIComponent(id)}/switch-source`, {
      method: 'POST',
      // Searches every source and asks the best few for their chapters: often past the 15s a change normally gets.
      signal: AbortSignal.timeout(120_000),
    }),
  /**
   * Start (or find) the record for something being read but not followed.
   *
   * Asked for by the reader, not by Browse: looking at a cover is not reading
   * it, and a history of everything glanced at would be worth less than none.
   */
  glimpse: (body: { adapter: string; mangaId: string; sourceName: string; title: string; coverUrl?: string | null }) =>
    call<{ id: string; following: boolean }>('/api/manga/glimpse', { method: 'POST', body: JSON.stringify(body) }),
  forgetGlimpse: (id: string) => call<{ ok: true }>(`/api/manga/glimpse/${id}`, { method: 'DELETE' }),
  libraries: {
    create: (name: string) =>
      call<{ id: string; name: string }>('/api/manga/libraries', { method: 'POST', body: JSON.stringify({ name }) }),
    /** Rename, hide, or both — each field optional, so one leaves the other alone. */
    update: (id: string, change: { name?: string; hidden?: boolean }) =>
      call<{ id: string; name: string; hidden?: boolean }>(`/api/manga/libraries/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(change),
      }),
    remove: (id: string) => call<{ ok: true; seriesKept: number }>(`/api/manga/libraries/${id}`, { method: 'DELETE' }),
    /** The whole set for one series, not one added or removed. */
    set: (seriesId: string, libraries: string[]) =>
      call<{ libraries: string[] }>(`/api/manga/${seriesId}/libraries`, {
        method: 'PUT',
        body: JSON.stringify({ libraries }),
      }),
  },
  /** Rate a series 1 to 10, or null to take the rating off. */
  setRating: (id: string, rating: number | null) =>
    call<{ rating: number | null }>(`/api/manga/${id}/rating`, { method: 'PUT', body: JSON.stringify({ rating }) }),
  /** What friends on this PC who share their ratings gave it. */
  ratingsOf: (id: string) => call<{ others: Array<{ who: string; rating: number }> }>(`/api/manga/${id}/ratings`),
  /** The Local collection's rules, and whether your ratings are shared. */
  collectionRules: {
    get: () => call<CollectionRules>('/api/manga/collection-rules'),
    set: (rules: Partial<CollectionRules>) =>
      call<CollectionRules>('/api/manga/collection-rules', { method: 'PUT', body: JSON.stringify(rules) }),
  },
  setFavourite: (id: string, on: boolean) =>
    call<{ favourite: boolean }>(`/api/manga/${id}/favourite`, { method: 'PUT', body: JSON.stringify({ on }) }),
  setShelf: (body: { show?: 'all' | 'favourites'; sort?: string; newFirst?: boolean; favFirst?: boolean }) =>
    call<{ shelfShow: string; shelfSort: string }>('/api/manga/shelf', { method: 'PUT', body: JSON.stringify(body) }),
  setReadAhead: (chapters: number) =>
    call<{ readAheadChapters: number }>('/api/manga/read-ahead', {
      method: 'PUT',
      body: JSON.stringify({ chapters }),
    }),
  findSources: {
    get: () => call<FindSourcesState>('/api/manga/find-sources'),
    start: (mode: 'unlinked' | 'gone' = 'unlinked') => call<FindSourcesState>('/api/manga/find-sources', { method: 'POST', body: JSON.stringify({ mode }) }),
  },
  setReleaseTasks: (on: boolean) =>
    call<{ releaseTasks: boolean }>('/api/manga/release-tasks', { method: 'PUT', body: JSON.stringify({ on }) }),


  /**
   * Keeping a series for good — see the server's `archive.ts`.
   *
   * `start` is also "catch up" and "try the failed ones again": the server
   * queues only what is not already complete, so pressing it twice costs
   * nothing.
   */
  /** Browse's "On this PC": everything kept on the PC, by any copy. */
  kept: () => call<{ results: Array<BrowseResult & { keptFor?: string[] }> }>('/api/manga/kept'),
  archive: {
    overview: () => call<ArchiveOverview>('/api/manga/archive'),
    of: (id: string) => call<ArchiveProgress>(`/api/manga/${id}/archive`),
    start: (id: string) =>
      call<{ queued: number; already: number; progress: ArchiveProgress | null }>(`/api/manga/${id}/archive`, {
        method: 'POST',
      }),
    /** Keeps what is saved unless `deleteFiles` — two different decisions. */
    stop: (id: string, deleteFiles = false) =>
      call<{ removed: boolean; deleted: boolean }>(
        `/api/manga/${id}/archive${deleteFiles ? '?files=delete' : ''}`,
        { method: 'DELETE' }
      ),
    run: () => call<ArchiveOverview>('/api/manga/archive/run', { method: 'POST' }),
  },

  ignored: {
    list: () => call<{ ignoredSources: IgnoredSource[] }>('/api/manga/ignored-sources'),
    set: (id: string, name: string, ignored: boolean) =>
      call<{ ignoredSources: IgnoredSource[] }>('/api/manga/ignored-sources', {
        method: 'PUT',
        body: JSON.stringify({ id, name, ignored }),
      }),
  },

  /** The Cloudflare helper — see `flaresolverr.ts` on the server. Installing and removing it are for the PC. */
  flaresolverr: {
    get: () => call<FlareState>('/api/manga/flaresolverr'),
    install: () => call<FlareState>('/api/manga/flaresolverr/install', { method: 'POST' }),
    remove: () => call<FlareState>('/api/manga/flaresolverr', { method: 'DELETE' }),
  },

  source: {
    get: () => call<SourceState>('/api/manga/source'),
    set: (url: string) => call<SourceState>('/api/manga/source', { method: 'PUT', body: JSON.stringify({ url }) }),
    setJar: (jar: string) => call<SourceState>('/api/manga/source', { method: 'PUT', body: JSON.stringify({ jar }) }),
    setManage: (manage: boolean) =>
      call<SourceState>('/api/manga/source', { method: 'PUT', body: JSON.stringify({ manage }) }),
    setMode: (mode: SuwayomiMode) =>
      call<SourceState>('/api/manga/source', { method: 'PUT', body: JSON.stringify({ mode }) }),
    start: () => call<ManagedState>('/api/manga/source/start', { method: 'POST' }),
    stop: () => call<ManagedState>('/api/manga/source/stop', { method: 'POST' }),
    /** One press: Java and Suwayomi into the app's folder, started, extension list added. */
    setup: () => call<SetupState>('/api/manga/source/setup', { method: 'POST' }),
    setupState: () => call<SetupState>('/api/manga/source/setup'),
    /** The end of Suwayomi's log, for the card. */
    log: () => call<{ lines: string[]; path: string }>('/api/manga/source/log'),
    /** The whole log, in Notepad on the PC. */
    openLog: () => call<{ ok: true }>('/api/manga/source/log/open', { method: 'POST' }),
    /** `allLanguages` is a one-off wider search; it does not change the setting. */
    search: (id: string, q?: string, allLanguages = false) => {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (allLanguages) params.set('all', '1');
      const query = params.toString();
      return call<SourceSearch>(`/api/manga/${id}/source/search${query ? `?${query}` : ''}`);
    },
    setLanguages: (languages: string[]) =>
      call<{ languages: string[] }>('/api/manga/languages', { method: 'PUT', body: JSON.stringify({ languages }) }),
    count: (id: string, mangaId: string) =>
      call<{ chapters: number; latest: number | null; profile?: ChapterProfile }>(
        `/api/manga/${id}/source/count?mangaId=${encodeURIComponent(mangaId)}`
      ),
    check: (id: string, chapterId: string) =>
      call<PageCheck>(`/api/manga/${id}/source/check?chapterId=${encodeURIComponent(chapterId)}`),
    link: (id: string, match: SourceMatch) =>
      call<SeriesSummary>(`/api/manga/${id}/source`, {
        method: 'PUT',
        body: JSON.stringify({ mangaId: match.id, title: match.title, sourceName: match.sourceName }),
      }),
    /** `verdict: null` takes a review back. */
    review: (id: string, key: string, upTo: number, verdict: 'real' | 'fake' | null) =>
      call<{ reviews: SourceReview[] }>(`/api/manga/${id}/review`, {
        method: 'PUT',
        body: JSON.stringify({ key, upTo, verdict }),
      }),
    unlink: (id: string) => call<SeriesSummary>(`/api/manga/${id}/source`, { method: 'DELETE' }),
  },

  browse: {
    get: () => call<BrowseState>('/api/manga/browse'),
    setSource: (id: string) =>
      call<{ selected: string }>('/api/manga/browse/source', { method: 'PUT', body: JSON.stringify({ id }) }),
    /**
     * `hide` names the tags to leave out; `hidden`, `hiddenBy` and `unchecked`
     * say what that did. Older servers send none of them.
     */
    list: (source: string, type: 'popular' | 'latest', page: number, hide: readonly string[] = []) =>
      call<{
        results: BrowseResult[];
        hasNextPage: boolean;
        page: number;
        hidden?: number;
        hiddenBy?: Record<string, number>;
        unchecked?: number;
      }>(
        `/api/manga/browse/list?source=${encodeURIComponent(source)}&type=${type}&page=${page}` +
          hide.map((t) => `&hide=${encodeURIComponent(t)}`).join('')
      ),
    /** Chapter counts for results whose count was not stored: a dozen at most, fetched from the site. */
    chapters: (ids: string[]) =>
      call<{ counts: Record<string, number | null> }>('/api/manga/browse/chapters', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      }),
    filters: (source: string) =>
      call<{ filters: SourceFilter[] }>(`/api/manga/browse/filters?source=${encodeURIComponent(source)}`),
    search: (body: {
      query: string;
      source: string | null;
      changes: FilterChange[];
      allLanguages: boolean;
      only: string[] | null;
    }) => call<GroupedSearch>('/api/manga/browse/search', { method: 'POST', body: JSON.stringify(body) }),
    detail: (mangaId: string) => call<SeriesDetailPage>(`/api/manga/browse/manga/${encodeURIComponent(mangaId)}`),
    pages: (mangaId: string, chapterId: string) =>
      call<{ pages: string[] }>(
        `/api/manga/browse/manga/${encodeURIComponent(mangaId)}/chapters/${encodeURIComponent(chapterId)}/pages`
      ),
    follow: (result: BrowseResult) =>
      call<{ series: SeriesSummary; matchedOn: 'mangadex' | 'existing' | null }>('/api/manga/follow-source', {
        method: 'POST',
        body: JSON.stringify({
          mangaId: result.id,
          title: result.title,
          sourceName: result.sourceName,
          // A followed series with no source: link this copy to it.
          ...(result.unlinked && result.following ? { seriesId: result.following } : {}),
        }),
      }),
  },

  ui: {
    /** Mint the frame cookie, and get the path to point it at. */
    session: () => call<{ path: string }>('/api/manga/ui-session', { method: 'POST' }),
  },

  extensions: {
    list: (refresh = false) => call<ExtensionList>(`/api/manga/extensions${refresh ? '?refresh=1' : ''}`),
    install: (pkg: string, install = true) =>
      call<{ extensions: SourceExtension[] }>(`/api/manga/extensions/${encodeURIComponent(pkg)}`, {
        method: 'PUT',
        body: JSON.stringify({ install }),
      }),
    update: (pkg: string) =>
      call<{ extensions: SourceExtension[] }>(`/api/manga/extensions/${encodeURIComponent(pkg)}`, {
        method: 'PUT',
        body: JSON.stringify({ update: true }),
      }),
    updateAll: () =>
      call<{ note: string; extensions: SourceExtension[] }>('/api/manga/extensions/update', { method: 'POST', body: '{}' }),
    setAutoUpdate: (on: boolean) =>
      call<{ autoUpdate: boolean }>('/api/manga/extensions/auto-update', { method: 'PUT', body: JSON.stringify({ on }) }),
    setRepos: (repos: string[]) =>
      call<ExtensionList>('/api/manga/extensions/repos', { method: 'PUT', body: JSON.stringify({ repos }) }),
    /** Unflag one flagged before any device could install. */
    flag: (pkg: string, flagged: boolean) =>
      call<{ flagged: string[] }>(`/api/manga/extensions/${encodeURIComponent(pkg)}/flag`, {
        method: 'PUT',
        body: JSON.stringify({ flagged }),
      }),
  },

  reader: {
    chapters: (id: string, refresh = false) =>
      call<ChapterList>(`/api/manga/${id}/chapters${refresh ? '?refresh=1' : ''}`),
    /** The source's description, people and genres, for the chapter list's head. */
    about: (id: string) =>
      call<{ description: string | null; author: string | null; artist: string | null; genres: string[]; url: string | null }>(
        `/api/manga/${id}/about`
      ),
    /**
     * A saved chapter's pages come from this device — no request, no Suwayomi,
     * no PC needed. Otherwise the server is asked.
     */
    pages: async (id: string, chapterId: string): Promise<{ pages: string[]; readAhead?: number; pageMargins?: 'inner' | 'outer' | null; saved?: true }> => {
      const saved = await savedPages(id, chapterId);
      if (saved) return { pages: saved, saved: true };
      // Fetched while the chapter before it was read: see `holdNext`.
      if (held?.key === heldKey(id, chapterId)) {
        // Opened: the reader fetches the rest itself from here, three at a time.
        held.opened = true;
        const list = await held.list.catch(() => null);
        if (list) return list;
      }
      return call<{ pages: string[]; readAhead?: number; pageMargins?: 'inner' | 'outer' | null }>(`/api/manga/${id}/chapters/${chapterId}/pages`);
    },
    /** Which edge this series keeps its margins on, learned in the reader — see `MarginSide` in `page-layout.ts`. */
    setPageMargins: (id: string, side: 'inner' | 'outer' | null) =>
      call<{ pageMargins: 'inner' | 'outer' | null }>(`/api/manga/${id}/page-margins`, { method: 'PUT', body: JSON.stringify({ side }) }),
    /** Forget the saved place — the other half of removing a History row. */
    clearPosition: (id: string) => call<{ ok: true }>(`/api/manga/${id}/position`, { method: 'DELETE' }),
    markRead: (id: string, chapter: number, read = true) =>
      call<{ readChapters: number[] }>(`/api/manga/${id}/read`, {
        method: 'PUT',
        body: JSON.stringify({ chapter, read }),
      }),

    /**
     * One page's bytes as an object URL.
     *
     * Not cached here, unlike covers: a chapter's images are tens of megabytes
     * that nothing asks for again once you have moved on, and the caller revokes
     * them on unmount. A cache would turn reading into a memory leak measured in
     * chapters.
     */
    /** This chapter, by number, on your other sources with the same series. See the route. */
    elsewhere: (id: string, number: number) =>
      call<{
        options: Array<{ sourceName: string; lang: string | null; mangaId: string; chapterId: string; chapterName: string }>;
        searched: number;
      }>(`/api/manga/${id}/elsewhere?number=${encodeURIComponent(String(number))}`),
    page: async (path: string, options: { fresh?: boolean } = {}): Promise<string> => {
      /*
       * Saved on this device first: that is what makes a downloaded chapter
       * read on the train, and read faster at home — but only a saved copy
       * that is a whole picture. A damaged one falls through to the server as
       * though it were not saved, and `fresh` (tap to try again) skips the
       * saved copy outright, since retrying the thing that just failed would
       * fail the same way forever.
       */
      if (!options.fresh) {
        // Fetched ahead onto this device: handed over once, and then it is the caller's.
        const ahead = held?.blobs.get(path);
        if (ahead) {
          held?.blobs.delete(path);
          const blob = await ahead;
          if (blob) return objectUrlFor(blob);
        }
        const saved = await cachedResponse(path);
        if (saved) {
          const blob = noteOriginal(await saved.blob(), readOriginalSize(saved.headers.get('x-original-size')));
          if (await blobIsWholeImage(blob)) return objectUrlFor(blob);
        }
      }
      // `fresh` reaches the server too: its own page cache could hold the bad copy.
      let blob: Blob;
      // As big as reading asks for now: smaller over a slow connection, if chosen (`quality.ts`).
      const asked = withQuality(path, readingLevel());
      if (options.fresh) {
        const finish = beginTransfer();
        const response = await fetch(`${asked}&fresh=1`, { headers: { authorization: `Bearer ${getToken()}` } }).catch((e: unknown) => {
          finish(0, 0);
          throw e;
        });
        if (!response.ok) {
          finish(0, 0);
          throw new Error(`page failed (${response.status})`);
        }
        blob = noteOriginal(await response.blob(), readOriginalSize(response.headers.get('x-original-size')));
        finish(blob.size, Number(response.headers.get('x-made-in')) || 0);
      } else {
        // The same request as the download's, when this chapter is saving as you read it.
        blob = await fetchPage(asked);
      }
      if (!(await blobIsWholeImage(blob))) throw new Error('the page arrived damaged');
      // Mend a saved chapter with the good copy, if this page was one.
      void replaceSavedPage(path, await blob.arrayBuffer(), blob.type || 'image/jpeg', blobOriginal(blob));
      return objectUrlFor(blob);
    },
  },
};

/**
 * The next chapter, fetched onto this device while you read the one before it.
 *
 * The server's read-ahead (`readAhead` in `routes/reading.ts`) puts the next
 * chapters on the PC's disk, which is the slow half when the source is a site.
 * The other half is the PC to this device, and it was paid only at the moment
 * the next chapter opened: a page is often 3 to 5MB, so over Tailscale to a
 * phone the next chapter's first pages took seconds, in carrying on as well as
 * with Next. Found in the server's log on *As Written In the Lewd Notebook*:
 * chapter 10's page list answered in 29ms and each page in 14ms from disk, and
 * still the page asked for first arrived seconds after the open.
 *
 * So once the chapter being read has every page, the reader asks for the next
 * one here (`holdNext`): its page list, then its pages one at a time, in order,
 * so it never competes with anything you are looking at. Opening that chapter
 * takes them (`manga.reader.pages` and `.page`), each handed over once.
 *
 * - **One chapter, and only up to `HOLD_BYTES` of it.** These are held in
 *   memory, beside the chapter on screen and any carried above it, and a phone
 *   is where that matters. The pages past the cap load the ordinary way, three
 *   at a time from the moment the chapter opens, which keeps ahead of reading.
 * - **The same setting as the server's.** "Fetch ahead while reading" at 0 is
 *   off here too: the page list says what it is (`readAhead`).
 * - **Not for a chapter saved on this device**, which opens from here anyway.
 * - **Silent when it fails**, like the server's: that page loads as before.
 */
const HOLD_BYTES = 32 * 1024 * 1024;

let held: {
  key: string;
  list: Promise<{ pages: string[]; readAhead?: number; pageMargins?: 'inner' | 'outer' | null }>;
  blobs: Map<string, Promise<Blob | null>>;
  opened: boolean;
} | null = null;
const heldKey = (seriesId: string, chapterId: string) => `${seriesId}/${chapterId}`;

export async function holdNext(seriesId: string, chapterId: string): Promise<void> {
  const key = heldKey(seriesId, chapterId);
  if (held?.key === key) return;
  dropHeld();
  if (await savedPages(seriesId, chapterId)) return;
  const me = {
    key,
    list: call<{ pages: string[]; readAhead?: number; pageMargins?: 'inner' | 'outer' | null }>(`/api/manga/${seriesId}/chapters/${chapterId}/pages`),
    blobs: new Map<string, Promise<Blob | null>>(),
    opened: false,
  };
  held = me;
  let pages: string[];
  try {
    pages = (await me.list).pages;
  } catch {
    if (held === me) held = null;
    return;
  }
  let bytes = 0;
  for (const path of pages) {
    if (held !== me || me.opened || bytes >= HOLD_BYTES) return;
    const got = fetchPage(withQuality(path, readingLevel())).then(
      async (blob) => ((await blobIsWholeImage(blob)) ? blob : null),
      () => null
    );
    me.blobs.set(path, got);
    const blob = await got;
    if (blob) bytes += blob.size;
  }
}

/** Let go of the chapter held ahead, unless it is the one named. */
export function dropHeld(seriesId?: string, chapterId?: string): void {
  if (held && (seriesId === undefined || chapterId === undefined || held.key !== heldKey(seriesId, chapterId))) held = null;
}

/**
 * A cover, fetched with the token and handed back as an object URL.
 *
 * An `img src` sends no Authorization header, and these sit behind `/api/`
 * because a picture in your reading list is your data — the same bind the habit
 * pictures are in, solved the same way.
 *
 * Cached by series id rather than by URL, because a series' cover never changes
 * without the series changing. The promise is cached, not the result, so two
 * rows rendering at once share one request rather than racing.
 */
const covers = new Map<string, Promise<string>>();

/**
 * `path` is always built by the server — a library row's `coverPath` or a search
 * candidate's — so the browser never assembles one from a URL it took apart.
 */
export function coverFor(path: string): Promise<string> {
  const known = covers.get(path);
  if (known) return known;

  const loading = (async () => {
    /*
     * Library covers are kept for offline like every other read, so the list
     * still has its pictures on the train. Browse's thumbnails are not — they
     * are hundreds of pictures of things you do not follow, and keeping them
     * would fill the phone for nothing.
     */
    if (/^\/api\/manga\/[^/]+\/cover$/.test(path)) {
      try {
        return URL.createObjectURL(await keptBlob(path, getToken()));
      } catch (error) {
        const saved = await cachedResponse(path);
        if (saved) return URL.createObjectURL(await saved.blob());
        throw error;
      }
    }
    let response: Response;
    try {
      response = await fetch(path, {
        headers: { authorization: `Bearer ${getToken()}` },
      });
    } catch (error) {
      // Offline: the cover saved with a downloaded chapter, if there is one.
      const saved = await cachedResponse(path);
      if (saved) return URL.createObjectURL(await saved.blob());
      throw error;
    }
    if (!response.ok) throw new Error(`no cover (${response.status})`);
    return URL.createObjectURL(await response.blob());
  })();

  covers.set(path, loading);
  // A failure must not be cached, or one flaky fetch means a row with no
  // picture for the rest of the session.
  loading.catch(() => covers.delete(path));
  return loading;
}

/** How long ago, in the words the rest of the app uses. */
export function ageOf(at: number | null, now: number): string | null {
  if (at === null) return null;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
