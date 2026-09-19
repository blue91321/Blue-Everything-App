/**
 * One shape for a series, read by the tab and the panel alike.
 *
 * The same arrangement the weather module's `present` makes, and for the same
 * reason: two surfaces computing "is this one waiting for a chapter" from raw
 * fields is two chances to disagree, and the one that disagrees is the one
 * nobody looks at twice.
 */
import { worthPolling } from './identity.js';
import type { Series, Store } from './library.js';
import { seriesUrl } from './releases.js';

export type SeriesSummary = {
  id: string;
  title: string;
  status: Series['status'];
  latestChapter: string | null;
  checkedAt: number | null;
  error: string | null;
  addedAt: number;
  /** Present only when there is a cover to fetch, so the screen need not guess. */
  coverPath: string | null;
  /** The MangaUpdates page, which is also where the credit link points. */
  url: string | null;
  malId: number | null;
  anilistId: number | null;
  /**
   * Is this row being watched for new chapters?
   *
   * False for a finished series, and false for one MangaDex knows no
   * MangaUpdates id for — which happens for doujin and one-shots. Said out loud
   * rather than left to be inferred from a chapter number that never moves: a
   * row that silently never produces a nudge is indistinguishable from the
   * feature being broken.
   */
  watching: boolean;
  /** Why not, when it is not. Null when it is. */
  notWatchingBecause: string | null;
};

export function seriesSummary(series: Series): SeriesSummary {
  const trackable = series.muId !== null;
  const running = worthPolling(series.status);
  const watching = trackable && running;

  return {
    id: series.id,
    title: series.title,
    status: series.status,
    latestChapter: series.latestChapter,
    checkedAt: series.checkedAt,
    error: series.error,
    addedAt: series.addedAt,
    coverPath: series.coverUrl ? `/api/manga/${series.id}/cover` : null,
    url: series.muId ? seriesUrl(series.muId) : null,
    malId: series.malId,
    anilistId: series.anilistId,
    watching,
    notWatchingBecause: watching
      ? null
      : !trackable
        ? 'MangaUpdates has no entry for it, so there is nothing to ask'
        : series.status === 'completed'
          ? 'there will be no more chapters'
          : 'it was cancelled',
  };
}

/**
 * What has landed lately, newest first.
 *
 * The Dashboard already lists the *tasks* these raised, so a panel repeating
 * them would be a second copy of something already on that screen. This is the
 * other half — the release itself, with its cover, whether or not you have
 * ticked the task off — which is a picture rather than a list and answers "what
 * turned up this week" at a glance.
 *
 * Read from the release links because those are already the record of every
 * chapter we told you about. Nothing new is stored for this.
 */
export type RecentRelease = {
  seriesId: string;
  title: string;
  chapter: string;
  raisedAt: number;
  coverPath: string | null;
  url: string | null;
};

export function recentReleases(store: Store, limit = 8): RecentRelease[] {
  const byId = new Map(store.series.map((s) => [s.id, s]));

  return store.links
    .slice()
    .sort((a, b) => b.raisedAt - a.raisedAt)
    .slice(0, limit)
    .flatMap((link) => {
      const series = byId.get(link.seriesId);
      // A link whose series has been removed. The delete route clears these, so
      // this is only reachable on a store written by an older version — skipped
      // rather than rendered as a release of nothing.
      if (!series) return [];
      return [
        {
          seriesId: series.id,
          title: series.title,
          chapter: link.chapter,
          raisedAt: link.raisedAt,
          coverPath: series.coverUrl ? `/api/manga/${series.id}/cover` : null,
          url: series.muId ? seriesUrl(series.muId) : null,
        },
      ];
    });
}
