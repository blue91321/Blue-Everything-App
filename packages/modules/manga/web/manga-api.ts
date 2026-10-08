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
import { cachedResponse, replaceSavedPage, savedPages } from './offline-store';
import { blobIsWholeImage } from './image-bytes';
import { keptBlob } from '@app/offline-sync';

export type SeriesStatus = 'ongoing' | 'completed' | 'hiatus' | 'cancelled' | 'unknown';

export interface SeriesSummary {
  id: string;
  title: string;
  status: SeriesStatus;
  latestChapter: string | null;
  totalChapters: number | null;
  chapterLabel: string;
  chapterTitle: string;
  checkedAt: number | null;
  error: string | null;
  addedAt: number;
  /** Starred. Optional: an older server does not send it. */
  favourite?: boolean;
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
}

/** What a Manga Reader backup holds, and — once committed — what was done with it. */
export interface MangaReaderImport {
  /** Favourites, with one favourited on two sites counted once. */
  favourites: number;
  /** Opened at some point and never favourited — counted, not brought in. */
  historyOnly: number;
  /** How many each choice would bring in. */
  scopes: Record<ImportScope, number>;
  scope: ImportScope;
  /** New to the library. */
  add: number;
  /** Titles already followed, which gain the old app's progress. */
  merge: string[];
  bySite: Array<{ site: string; count: number }>;
  readChapters: number;
  committed: boolean;
  added?: number;
  merged?: number;
  matching?: MatchingState;
}

export type ImportScope = 'all' | 'year' | 'quarter';

/** A source left out of searching, browsing and finding imports. */
export interface IgnoredSource {
  id: string;
  name: string;
}

/** Finding imported series on your sources — see `matching.ts` on the server. */
export interface MatchingState {
  running: boolean;
  total: number;
  done: number;
  linked: number;
  notFound: number;
  failed: number;
  noSource: Array<{ site: string; count: number }>;
  /** Sources set aside because they kept failing, with what they said. Optional: older servers. */
  broken?: Array<{ id?: string; source: string; reason: string }>;
  finishedAt: number | null;
  problem: string | null;
  /** Imported series still without a source. Only on the status read. */
  unmatched?: number;
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
}

/** How "Set up manga" is getting on — see `server/setup.ts`. */
export interface SetupState {
  running: boolean;
  step: string | null;
  received: number;
  total: number | null;
  done: boolean;
  problem: string | null;
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
  /** Chapters fetched ahead while reading. Optional: an older server sends neither. */
  readAheadChapters?: number;
  maxReadAhead?: number;
  /** What the Dashboard card lists and how. Optional: an older server sends neither. */
  shelfShow?: 'all' | 'favourites';
  shelfSort?: 'follow' | 'read' | 'catchup' | 'updated' | 'title' | 'added';
  shelfNewFirst?: boolean;
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
}

export interface ArchiveOverview {
  series: ArchiveProgress[];
  queued: number;
  working: { seriesId: string; number: number; name: string } | null;
  bytes: number;
  root: string;
  disk?: { bytes: number; files: number };
}

export const manga = {
  list: () => call<Library>('/api/manga'),
  history: () => call<{ entries: HistoryEntry[] }>('/api/manga/history'),
  search: (q: string) => call<{ results: Candidate[] }>(`/api/manga/search?q=${encodeURIComponent(q)}`),
  add: (candidate: Candidate) =>
    call<SeriesSummary>('/api/manga', { method: 'POST', body: JSON.stringify(candidate) }),
  remove: (id: string) => call<{ ok: true }>(`/api/manga/${id}`, { method: 'DELETE' }),
  checkNow: () => call<SweepResult>('/api/manga/check', { method: 'POST' }),
  setReleaseNudges: (on: boolean) =>
    call<{ releaseNudges: boolean }>('/api/manga/release-nudges', { method: 'PUT', body: JSON.stringify({ on }) }),
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
  setFavourite: (id: string, on: boolean) =>
    call<{ favourite: boolean }>(`/api/manga/${id}/favourite`, { method: 'PUT', body: JSON.stringify({ on }) }),
  setShelf: (body: { show?: 'all' | 'favourites'; sort?: string; newFirst?: boolean }) =>
    call<{ shelfShow: string; shelfSort: string }>('/api/manga/shelf', { method: 'PUT', body: JSON.stringify(body) }),
  setReadAhead: (chapters: number) =>
    call<{ readAheadChapters: number }>('/api/manga/read-ahead', {
      method: 'PUT',
      body: JSON.stringify({ chapters }),
    }),
  setReleaseTasks: (on: boolean) =>
    call<{ releaseTasks: boolean }>('/api/manga/release-tasks', { method: 'PUT', body: JSON.stringify({ on }) }),

  import: {
    /** Without `commit` this only reads the file and says what it found. */
    mangaReader: (data: string, scope: ImportScope, commit = false) =>
      call<MangaReaderImport>('/api/manga/import/mangareader', {
        method: 'POST',
        body: JSON.stringify({ data, scope, commit }),
      }),
    matching: () => call<MatchingState>('/api/manga/import/matching'),
    matchAgain: () => call<MatchingState>('/api/manga/import/matching', { method: 'POST' }),
  },

  /**
   * Keeping a series for good — see the server's `archive.ts`.
   *
   * `start` is also "catch up" and "try the failed ones again": the server
   * queues only what is not already complete, so pressing it twice costs
   * nothing.
   */
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
    /** `safe` leaves adult titles out; `hidden` and `unchecked` say what that did. Older servers send neither. */
    list: (source: string, type: 'popular' | 'latest', page: number, safe: 'adult' | 'mature' | null = null) =>
      call<{ results: BrowseResult[]; hasNextPage: boolean; page: number; hidden?: number; unchecked?: number }>(
        `/api/manga/browse/list?source=${encodeURIComponent(source)}&type=${type}&page=${page}${safe ? `&safe=${safe}` : ''}`
      ),
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
    setRepos: (repos: string[]) =>
      call<ExtensionList>('/api/manga/extensions/repos', { method: 'PUT', body: JSON.stringify({ repos }) }),
  },

  reader: {
    chapters: (id: string, refresh = false) =>
      call<ChapterList>(`/api/manga/${id}/chapters${refresh ? '?refresh=1' : ''}`),
    /**
     * A saved chapter's pages come from this device — no request, no Suwayomi,
     * no PC needed. Otherwise the server is asked.
     */
    pages: async (id: string, chapterId: string) => {
      const saved = await savedPages(id, chapterId);
      if (saved) return { pages: saved };
      return call<{ pages: string[] }>(`/api/manga/${id}/chapters/${chapterId}/pages`);
    },
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
        const saved = await cachedResponse(path);
        if (saved) {
          const blob = await saved.blob();
          if (await blobIsWholeImage(blob)) return URL.createObjectURL(blob);
        }
      }
      // `fresh` reaches the server too: its own page cache could hold the bad copy.
      const response = await fetch(options.fresh ? `${path}&fresh=1` : path, {
        headers: { authorization: `Bearer ${getToken()}` },
      });
      if (!response.ok) throw new Error(`page failed (${response.status})`);
      const blob = await response.blob();
      if (!(await blobIsWholeImage(blob))) throw new Error('the page arrived damaged');
      // Mend a saved chapter with the good copy, if this page was one.
      void replaceSavedPage(path, await blob.arrayBuffer(), blob.type || 'image/jpeg');
      return URL.createObjectURL(blob);
    },
  },
};

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
