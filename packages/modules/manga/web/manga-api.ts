/**
 * Talking to this package's own endpoints.
 *
 * Its own thin client rather than entries on `api` in core, because core must
 * not know a package exists — the same rule that keeps `hidden_providers` an
 * opaque slug and `tasks.source` an unvalidated string. What it borrows from
 * core is `getToken`, since every `/api/` call needs the bearer token and there
 * is no sense keeping a second copy of where it is stored.
 */
import { getToken } from '@app/api';

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
  coverPath: string | null;
  url: string | null;
  malId: number | null;
  anilistId: number | null;
  watching: boolean;
  notWatchingBecause: string | null;
  source: { adapter: string; sourceName: string; title: string; mangaId: string } | null;
  /** Your verdicts on sources that claimed to be ahead. Optional: an older server does not send them. */
  reviews?: SourceReview[];
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
}

export interface ChapterList {
  seriesTitle: string;
  sourceName: string;
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
}

export interface SweepResult {
  checked: number;
  raised: number;
  failed: number;
  series: SeriesSummary[];
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      authorization: `Bearer ${getToken()}`,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const manga = {
  list: () => call<Library>('/api/manga'),
  search: (q: string) => call<{ results: Candidate[] }>(`/api/manga/search?q=${encodeURIComponent(q)}`),
  add: (candidate: Candidate) =>
    call<SeriesSummary>('/api/manga', { method: 'POST', body: JSON.stringify(candidate) }),
  remove: (id: string) => call<{ ok: true }>(`/api/manga/${id}`, { method: 'DELETE' }),
  checkNow: () => call<SweepResult>('/api/manga/check', { method: 'POST' }),
  setReleaseTasks: (on: boolean) =>
    call<{ releaseTasks: boolean }>('/api/manga/release-tasks', { method: 'PUT', body: JSON.stringify({ on }) }),

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
    list: (source: string, type: 'popular' | 'latest', page: number) =>
      call<{ results: BrowseResult[]; hasNextPage: boolean; page: number }>(
        `/api/manga/browse/list?source=${encodeURIComponent(source)}&type=${type}&page=${page}`
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
    follow: (result: BrowseResult) =>
      call<{ series: SeriesSummary; matchedOn: 'mangadex' | 'existing' | null }>('/api/manga/follow-source', {
        method: 'POST',
        body: JSON.stringify({ mangaId: result.id, title: result.title, sourceName: result.sourceName }),
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
    pages: (id: string, chapterId: string) =>
      call<{ pages: string[] }>(`/api/manga/${id}/chapters/${chapterId}/pages`),
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
    page: async (path: string): Promise<string> => {
      const response = await fetch(path, { headers: { authorization: `Bearer ${getToken()}` } });
      if (!response.ok) throw new Error(`page failed (${response.status})`);
      return URL.createObjectURL(await response.blob());
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
    const response = await fetch(path, {
      headers: { authorization: `Bearer ${getToken()}` },
    });
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
