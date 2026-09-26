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
import { DEFAULT_LANGUAGES, type SuwayomiMode } from './sources.js';

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
  /**
   * Chapter numbers you have read.
   *
   * Numbers rather than source chapter ids, deliberately: ids belong to one
   * source, and relinking a series to a different one would otherwise lose every
   * mark. A chapter number means the same thing wherever you read it.
   *
   * Written when a chapter is **finished**, not on every page turn — which is
   * what keeps a JSON file the right shape for this. Per-page position would be
   * a write per swipe, and that is the case this file is wrong for.
   */
  readChapters: number[];
  /**
   * What you decided about a source that claimed to be ahead of the rest.
   *
   * The comparison can only suspect: a source well clear of every other one is
   * either faster or listing chapters it does not have, and the numbers cannot
   * say which. Often it is simply faster — an official release trails the
   * scanlations as a matter of course. So the flag asks, and this is the answer.
   *
   * Kept on the series, so removing it takes the reviews with it; and on the
   * server, so a verdict given on the phone holds on the PC.
   */
  reviews: SourceReview[];
  /** When MangaUpdates last answered about this series, successful or not. */
  checkedAt: number | null;
  /** Why the last check failed, if it did. Kept beside the data it could not replace. */
  error: string | null;
  addedAt: number;
};

/**
 * One verdict about one source's claim.
 *
 * `upTo` is the chapter the source claimed when you looked, and the verdict
 * covers that claim and nothing past it. A source that later claims more has
 * made a new claim, and it is measured from the chapter you confirmed.
 */
export type SourceReview = {
  /** `sourceName:mangaId` — the same key the comparison screen uses. */
  key: string;
  upTo: number;
  verdict: 'real' | 'fake';
  at: number;
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
  /**
   * The Suwayomi jar this app may start, when you have pointed it at one.
   *
   * Separate from `suwayomiUrl` because they are different claims: a URL says
   * where to talk to one, a jar says we may run one. Somebody with Suwayomi
   * already running as a service wants the first and not the second.
   */
  suwayomiJar: string | null;
  /**
   * May the app start and stop it?
   *
   * Off unless you say so. Starting a 166MB JVM is not something to do to
   * somebody as a side effect of opening a tab they were only browsing.
   */
  manageSuwayomi: boolean;
  /**
   * How eagerly to run it — see `SuwayomiMode`.
   *
   * Defaults to `on-demand`, which is the setting that respects this project's
   * own numbers: a 166MB JVM resident all day for something used in bursts is
   * the trade Electron was rejected over. `always` is offered because somebody
   * who reads daily would rather spend the memory than six seconds every time.
   */
  suwayomiMode: SuwayomiMode;
  /**
   * Languages whose sources a search asks, as extension language codes.
   *
   * English by default, since every source this library started with was
   * English, and changeable on the source card. Not local-only: it decides
   * which of your sources are *searched*, not what this machine runs.
   */
  readLanguages: string[];
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

/**
 * A fresh empty store, built anew on every call.
 *
 * It was a module-level constant copied with `{ ...EMPTY }`, and a spread is
 * shallow: the copy shared the constant's `series` array, so adding a series to
 * a library with no file yet pushed onto the *default itself*. Harmless while the
 * file then existed — and wrong the moment it was deleted with the server
 * running, when the next read handed back a library with somebody's old series
 * already in it. Test clean-up in this module did exactly that, repeatedly.
 */
function emptyStore(): Store {
  return {
    suwayomiUrl: null,
    suwayomiJar: null,
    manageSuwayomi: false,
    suwayomiMode: 'on-demand',
    readLanguages: [...DEFAULT_LANGUAGES],
    series: [],
    links: [],
  };
}

export function read(): Store {
  if (!existsSync(STORE)) return emptyStore();
  try {
    const parsed = JSON.parse(readFileSync(STORE, 'utf8').replace(/^\uFEFF/, '')) as Partial<Store>;
    return {
      suwayomiUrl: typeof parsed.suwayomiUrl === 'string' && parsed.suwayomiUrl ? parsed.suwayomiUrl : null,
      suwayomiJar: typeof parsed.suwayomiJar === 'string' && parsed.suwayomiJar ? parsed.suwayomiJar : null,
      manageSuwayomi: parsed.manageSuwayomi === true,
      suwayomiMode: parsed.suwayomiMode === 'always' ? 'always' : 'on-demand',
      readLanguages:
        Array.isArray(parsed.readLanguages) && parsed.readLanguages.every((l) => typeof l === 'string')
          ? parsed.readLanguages
          : [...DEFAULT_LANGUAGES],
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
        readChapters: Array.isArray(s.readChapters) ? s.readChapters : [],
        reviews: Array.isArray(s.reviews) ? s.reviews : [],
      })),
      links: Array.isArray(parsed.links) ? parsed.links : [],
    };
  } catch {
    // A cache and a list, not a source of truth for anything irreplaceable.
    // Refusing to serve the screen over a stray comma would take away the only
    // place you could fix it.
    return emptyStore();
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
    | 'id'
    | 'addedAt'
    | 'checkedAt'
    | 'error'
    | 'latestChapter'
    | 'totalChapters'
    | 'source'
    | 'sourceChapter'
    | 'sourceCheckedAt'
    | 'readChapters'
    | 'reviews'
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
    readChapters: [],
    reviews: [],
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
