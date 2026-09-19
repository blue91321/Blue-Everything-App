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
}

export interface SourceHealth {
  reachable: boolean;
  sources: string[];
  problem: string | null;
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
  url: string | null;
  thumbnailUrl: string | null;
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
    search: (id: string, q?: string) =>
      call<{ results: SourceMatch[] }>(
        `/api/manga/${id}/source/search${q ? `?q=${encodeURIComponent(q)}` : ''}`
      ),
    count: (id: string, mangaId: string) =>
      call<{ chapters: number; latest: number | null }>(
        `/api/manga/${id}/source/count?mangaId=${encodeURIComponent(mangaId)}`
      ),
    link: (id: string, match: SourceMatch) =>
      call<SeriesSummary>(`/api/manga/${id}/source`, {
        method: 'PUT',
        body: JSON.stringify({ mangaId: match.id, title: match.title, sourceName: match.sourceName }),
      }),
    unlink: (id: string) => call<SeriesSummary>(`/api/manga/${id}/source`, { method: 'DELETE' }),
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
