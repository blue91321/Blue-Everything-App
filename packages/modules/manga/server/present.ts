/**
 * One shape for a series, read by the tab and the panel alike.
 *
 * The same arrangement the weather module's `present` makes, and for the same
 * reason: two surfaces computing "is this one waiting for a chapter" from raw
 * fields is two chances to disagree, and the one that disagrees is the one
 * nobody looks at twice.
 */
import { chapterValue, worthPolling } from './identity.js';
import type { Series, Store } from './library.js';
import { seriesUrl } from './releases.js';

export type SeriesSummary = {
  id: string;
  title: string;
  status: Series['status'];
  latestChapter: string | null;
  totalChapters: number | null;
  /**
   * The chapter line, written once here rather than on each surface.
   *
   * It carries **two numbers on purpose**. `latestChapter` is the newest
   * release MangaUpdates has logged — what somebody can actually read — and
   * `totalChapters` is how many have been written. Showing only the first is
   * what made this confidently wrong: *Archmage Curriculum* read "chapter 23"
   * while 41 existed and an aggregator was carrying 45.
   */
  chapterLabel: string;
  /** What those numbers mean, for the row's tooltip. A colour and a number say nothing on their own. */
  chapterTitle: string;
  checkedAt: number | null;
  error: string | null;
  addedAt: number;
  /** Starred — see `Series.favourite`. Always a boolean here, unlike on disk. */
  favourite: boolean;
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
  /** Where this can be read, when it has been pointed at a source. */
  source: { adapter: string; sourceName: string; title: string; mangaId: string } | null;
  /** Your verdicts on sources that claimed to be ahead — see `SourceReview`. */
  reviews: Series['reviews'];
  /** Brought in from another app, and read on which site there. Absent otherwise. */
  origin?: { app: string; site: string };
  /** Genres from the source. Absent until asked. */
  tags?: string[];
};

/**
 * The chapter line and the sentence explaining it.
 *
 * Kept together because they must never disagree: the moment the label says
 * "ch 23" without the tooltip saying *which* 23, the screen is back to stating
 * a narrow fact as a broad one.
 */
function chapterLine(series: Series): { chapterLabel: string; chapterTitle: string } {
  /*
   * A linked series is answered by its source, and the line says so.
   *
   * This is the case the whole source layer exists for. MangaUpdates logged
   * chapter 23 of *Archmage Curriculum* while the site being read was on 45 —
   * so a linked row must not merely show a different number, it must say where
   * the number came from, or the two states are indistinguishable when one of
   * them is wrong.
   */
  if (series.source && series.sourceChapter !== null) {
    const via = series.source.sourceName || series.source.adapter;
    /*
     * The total is dropped when the source is *ahead* of it.
     *
     * "ch 45 of 41" is two honest numbers from two services and reads as a bug —
     * which is worse than saying less. MangaUpdates counts what has been written
     * and lags behind sites carrying unofficial translations, so a source
     * running ahead is the ordinary case rather than a contradiction to explain.
     * It stays in the tooltip, where there is room to say which is which.
     */
    const total = series.totalChapters !== null && series.totalChapters >= series.sourceChapter ? series.totalChapters : null;
    return {
      chapterLabel:
        total === null
          ? `ch ${series.sourceChapter} · via ${via}`
          : `ch ${series.sourceChapter} of ${total} · via ${via}`,
      chapterTitle:
        `Chapter ${series.sourceChapter} is the newest ${via} has. ` +
        (total === null ? '' : `MangaUpdates counts ${total} written. `) +
        'This is what you could actually open right now.',
    };
  }

  const read = series.latestChapter;
  const total = series.totalChapters;

  if (read === null && total === null) {
    return {
      chapterLabel: 'not checked yet',
      chapterTitle: 'MangaUpdates has not been asked about this one yet.',
    };
  }

  // Known to exist but nothing released yet — rare, and the honest reading is
  // that there is nothing to read rather than that we failed to look.
  if (read === null) {
    return {
      chapterLabel: `${total} written`,
      chapterTitle: `${total} chapters exist. MangaUpdates has logged no release yet.`,
    };
  }

  // Same rule unlinked: "ch 418 · 417 written" is two services disagreeing by
  // one, printed as though it were a fact about the series.
  if (total === null || (chapterValue(read) ?? 0) > total) {
    return {
      chapterLabel: `ch ${read}`,
      chapterTitle:
        total === null
          ? `Chapter ${read} is the newest release MangaUpdates has logged. It does not publish a total for this one.`
          : `Chapter ${read} is the newest release MangaUpdates has logged, which is ahead of the ${total} it counts as written.`,
    };
  }

  return {
    chapterLabel: `ch ${read} · ${total} written`,
    chapterTitle:
      `Chapter ${read} is the newest release MangaUpdates has logged; ${total} chapters have been written. ` +
      'Sites carrying unofficial translations are often further ahead than either number.',
  };
}

/**
 * Where a series' cover comes from: MangaDex's, or failing that its source's.
 *
 * A series followed from the Browse tab may have no MangaDex entry at all, and
 * a library row with a blank where every other row has a picture reads as
 * something having failed. The source's thumbnail is the same picture you
 * chose it by. It goes through `thumbPath`, which is the only way the browser
 * reaches a Suwayomi image.
 */
export function coverPathOf(series: Series): string | null {
  if (series.coverUrl) return `/api/manga/${series.id}/cover`;
  if (series.source?.adapter === 'suwayomi' && /^\d+$/.test(series.source.mangaId)) {
    return thumbPath(`/api/v1/manga/${series.source.mangaId}/thumbnail`);
  }
  return null;
}

/**
 * A Suwayomi thumbnail as a URL this app serves, or null for anything else.
 *
 * Built here so the browser never assembles one, and checked against the one
 * shape Suwayomi publishes — the route checks it again, since by then it has
 * travelled through the browser and is caller input.
 */
export function thumbPath(thumbnailUrl: string | null | undefined): string | null {
  if (!thumbnailUrl) return null;
  const path = thumbnailUrl.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '');
  return THUMB_PATH.test(path) ? `/api/manga/thumb?p=${encodeURIComponent(path)}` : null;
}

export const THUMB_PATH = /^\/api\/v1\/manga\/\d+\/thumbnail$/;

export function seriesSummary(series: Series): SeriesSummary {
  // A linked source is enough on its own: it answers the chapter question
  // directly, so a series MangaUpdates has never heard of becomes watchable the
  // moment you point it at somewhere it can be read.
  const trackable = series.muId !== null || series.source !== null;
  const running = worthPolling(series.status);
  const watching = trackable && running;

  return {
    id: series.id,
    title: series.title,
    status: series.status,
    latestChapter: series.latestChapter,
    totalChapters: series.totalChapters,
    ...chapterLine(series),
    checkedAt: series.checkedAt,
    error: series.error,
    addedAt: series.addedAt,
    favourite: series.favourite === true,
    coverPath: coverPathOf(series),
    url: series.muId ? seriesUrl(series.muId) : null,
    malId: series.malId,
    anilistId: series.anilistId,
    watching,
    source: series.source,
    reviews: series.reviews,
    ...(series.origin ? { origin: { app: series.origin.app, site: series.origin.site } } : {}),
    ...(series.tags ? { tags: series.tags } : {}),
    notWatchingBecause: watching
      ? null
      : !trackable && series.origin
        ? `no source yet — it was read on ${series.origin.site} in ${series.origin.app}`
        : !trackable
        ? 'MangaUpdates has no entry for it — link it to a source and it can be watched anyway'
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
          coverPath: coverPathOf(series),
          url: series.muId ? seriesUrl(series.muId) : null,
        },
      ];
    });
}
