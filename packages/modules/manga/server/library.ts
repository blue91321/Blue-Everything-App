/**
 * What you are reading, on disk beside the database.
 *
 * ### A package cannot add a table
 *
 * Migrations are a linear journal and the schema is core's whatever is
 * installed, so a package with state of its own keeps it in `dataDir` — the same
 * arrangement the app logo, the habit pictures and the weather reading already
 * use. This is `data/manga.json`.
 *
 * **That is comfortable for this and will not be comfortable forever.** A few
 * hundred series with four ids and a chapter number each is tens of kilobytes,
 * rewritten when you add a series or when a poll finds something — which is
 * rare. Per-*chapter* read state, written on every page turn, is the case a JSON
 * file is wrong for, and it is not in this slice. When the reader lands that is
 * the decision to revisit, and the honest options are a second file per series
 * or asking core for a table. It is written down here rather than discovered at
 * three hundred series.
 *
 * ### Nothing here is a chapter
 *
 * Titles, ids, a status, chapter *numbers* — and, once you link one, the name of
 * a source and an id within it. No page, no image, and no address: a
 * `SeriesSource` says "Suwayomi calls this 412", which is meaningless without
 * the Suwayomi you chose to run. Nothing in this repository will tell anybody
 * where to read anything, which is what keeps this half publishable.
 *
 * That is a narrower claim than the one this comment made before sources
 * existed, and it is narrower on purpose — it is the honest version.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataDir } from '@everything/server/module-api';
import type { SeriesIds, SeriesStatus } from './identity.js';

const STORE = join(dataDir, 'manga.json');

export type Series = SeriesIds & {
  id: string;
  title: string;
  /** A full URL. MangaDex cover art is public and hotlink-discouraged, so this is proxied. */
  coverUrl: string | null;
  status: SeriesStatus;
  /**
   * The newest chapter known to exist, as the source spelled it.
   *
   * A string because `220.5` and `12-2` are real chapters — see `chapterValue`.
   * Null until the first successful poll, which is also what stops adding a
   * series raising a nudge about the chapter that was already out.
   */
  latestChapter: string | null;
  /**
   * How many chapters exist, when MangaUpdates says so.
   *
   * Kept beside `latestChapter` rather than replacing it because they answer
   * different questions — what you can read, and what has been written. Showing
   * only the first is what made the screen confidently wrong; showing only the
   * second would nudge about chapters nobody has translated.
   */
  totalChapters: number | null;
  /**
   * Where this series can actually be read, when it has been pointed at one.
   *
   * Null for everything until you link it, which is the ordinary state and not a
   * gap: the library works without a source, it just reports the narrower
   * MangaUpdates number. Linked, the source becomes the authority for the
   * chapter number, because it is the thing serving the chapter.
   */
  source: SeriesSource | null;
  /** The newest chapter the source has, as of `sourceCheckedAt`. */
  sourceChapter: number | null;
  sourceCheckedAt: number | null;
  /** When MangaUpdates last answered about this series, successful or not. */
  checkedAt: number | null;
  /** Why the last check failed, if it did. Kept beside the data it could not replace. */
  error: string | null;
  addedAt: number;
};

/** A series as one source knows it. `mangaId` is opaque — Suwayomi's is numeric, another's may not be. */
export type SeriesSource = {
  adapter: string;
  mangaId: string;
  /** What the source calls it, which is often not what MangaDex calls it. */
  title: string;
  sourceName: string;
};

export type Store = {
  /**
   * Where Suwayomi is, when it is anywhere.
   *
   * Kept here rather than in core `settings` because core must not learn that a
   * package exists — the same rule that keeps `hidden_providers` an opaque slug.
   * Null means "not configured", which is distinct from the default URL being
   * unreachable: one is a thing you have not done, the other is a thing that is
   * broken, and they have different fixes.
   */
  suwayomiUrl: string | null;
  series: Series[];
  /** Raised-and-linked releases, so a task you deleted is never recreated. */
  links: ReleaseLink[];
};

/**
 * One chapter we have already told you about.
 *
 * Exactly the `integration_task_links` idea, kept here rather than in that
 * table because the table belongs to a different package and two modules
 * writing one table is the `cache.json` collision one level up.
 *
 * `taskId: null` means "raised once, and the task is gone" — a decision, not a
 * gap, and never acted on again. Without that, deleting the task for a chapter
 * you have read recreates it on the next poll, within the half hour, with
 * nothing on screen to explain why.
 */
export type ReleaseLink = {
  seriesId: string;
  chapter: string;
  taskId: string | null;
  raisedAt: number;
};

const EMPTY: Store = { suwayomiUrl: null, series: [], links: [] };

export function read(): Store {
  if (!existsSync(STORE)) return { ...EMPTY };
  try {
    const parsed = JSON.parse(readFileSync(STORE, 'utf8').replace(/^\uFEFF/, '')) as Partial<Store>;
    return {
      suwayomiUrl: typeof parsed.suwayomiUrl === 'string' && parsed.suwayomiUrl ? parsed.suwayomiUrl : null,
      /*
       * Every optional field is filled in, not merely trusted.
       *
       * A row written before a field existed has it `undefined`, not `null`, and
       * the two are not interchangeable to code that tests `=== null` \u2014 which is
       * how `totalChapters` would have rendered as "ch 23 \u00B7 undefined written"
       * on a store that predated it. This file is a schema whether or not it is
       * a table, and it gains fields; normalising here is what stops every
       * reader downstream having to remember that.
       */
      series: (Array.isArray(parsed.series) ? parsed.series : []).map((s) => ({
        ...s,
        latestChapter: s.latestChapter ?? null,
        totalChapters: s.totalChapters ?? null,
        checkedAt: s.checkedAt ?? null,
        error: s.error ?? null,
        coverUrl: s.coverUrl ?? null,
        source: s.source ?? null,
        sourceChapter: s.sourceChapter ?? null,
        sourceCheckedAt: s.sourceCheckedAt ?? null,
      })),
      links: Array.isArray(parsed.links) ? parsed.links : [],
    };
  } catch {
    // A cache and a list, not a source of truth for anything irreplaceable.
    // Refusing to serve the screen over a stray comma would take away the only
    // place you could fix it.
    return { ...EMPTY };
  }
}

/**
 * Written through a temporary file and renamed.
 *
 * Unlike the weather store this one holds something you built by hand, and a
 * process dying mid-write would leave a truncated file that `read` would treat
 * as empty — silently losing the library. `rename` is atomic on both Windows and
 * POSIX, so the file is either the old one or the new one.
 */
export function write(next: Store): void {
  mkdirSync(dataDir, { recursive: true });
  const tmp = `${STORE}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(tmp, STORE);
}

export function newSeries(
  fields: Omit<
    Series,
    'id' | 'addedAt' | 'checkedAt' | 'error' | 'latestChapter' | 'totalChapters' | 'source' | 'sourceChapter' | 'sourceCheckedAt'
  >
): Series {
  return {
    ...fields,
    id: randomUUID(),
    latestChapter: null,
    totalChapters: null,
    source: null,
    sourceChapter: null,
    sourceCheckedAt: null,
    checkedAt: null,
    error: null,
    addedAt: Date.now(),
  };
}

/** Already in the library? Compared on MangaDex id, which is the one we always have. */
export function findExisting(store: Store, ids: SeriesIds): Series | undefined {
  return store.series.find(
    (s) =>
      (ids.mangadexId && s.mangadexId === ids.mangadexId) ||
      (ids.muId && s.muId === ids.muId) ||
      (ids.malId && s.malId === ids.malId)
  );
}

/** Have we already raised this chapter of this series? */
export function alreadyRaised(store: Store, seriesId: string, chapter: string): boolean {
  return store.links.some((l) => l.seriesId === seriesId && l.chapter === chapter);
}
