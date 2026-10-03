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
  /**
   * Genres, as the linked source lists them — see `tags.ts`. Absent means not
   * asked yet; an empty list means asked, and the source has none.
   */
  tags?: string[];
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
   * Where each read chapter was read — which source, and when.
   *
   * Beside `readChapters` rather than replacing it: that list is what every
   * reader of "is this read" already asks, and a chapter marked before this
   * existed has no source to report, which is an honest gap rather than one to
   * fill with a guess. Written when a chapter is finished, like the list.
   */
  readLog: ReadRecord[];
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
  /**
   * Starred, so it can be picked out of a library of hundreds.
   *
   * **Optional, and absent means no.** Nine hundred series arrived from the
   * Manga Reader import and none of them was starred by anybody, so writing
   * `false` onto every one would be a lot of JSON saying nothing. Only `true`
   * is ever stored.
   *
   * Deliberately not the same thing as following a series. Everything here is
   * followed — that is what being in the library means — and a star is the
   * smaller set you actually keep up with.
   */
  favourite?: boolean;
  /**
   * Which libraries this is on, by id.
   *
   * **Optional, and absent means none**, like `favourite` — nine hundred series
   * arrived from an import belonging to no shelf anybody had made, and writing
   * an empty array onto every one would be a lot of JSON saying nothing.
   *
   * Ids nothing answers to are ignored rather than cleaned up, the same rule
   * `hidden_providers` and the panel ids follow: a library deleted by accident
   * and recreated with the same id would find its series again.
   */
  libraries?: string[];
  /**
   * Where a series brought in from another app came from: the app, the site it
   * was last read on there (and every site it was read on, newest first), the
   * title it had, and the newest chapter that app knew of. `matching.ts` finds it on an installed source by the site and title;
   * the chapter stands in for the NEW badge until that source has been asked.
   * Absent on everything followed from here.
   */
  origin?: { app: string; site: string; sites?: string[]; title: string; latest: string | null };
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

/** One finished chapter: its number, where it was read, and when. */
export type ReadRecord = {
  chapter: number;
  /** The source's name as the series was linked at the time, or null if it predates this. */
  source: string | null;
  mangaId: string | null;
  at: number;
};

/**
 * Where you are inside a chapter, to start again from.
 *
 * `page` and `offset` together: a page index alone is useless for a webtoon,
 * where one "page" is a strip taller than a phone is long, so `offset` is how
 * far down that page the top of the screen was, from 0 to 1. The chapter and
 * source are stored with it because the numbers are only meaningful on the copy
 * they were measured on — another source splits the same chapter into
 * different pages.
 */
export type ReadingPosition = {
  chapter: number;
  chapterId: string;
  chapterName: string;
  source: string;
  mangaId: string;
  page: number;
  offset: number;
  pages: number;
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

/** What the Dashboard card lists — see `Store.shelfShow`. */
export type ShelfShow = 'all' | 'favourites';

/**
 * How it is ordered: the Library tab's own order on this device, or a fixed one.
 *
 * The keys mirror the Library's `SortKey` and are deliberately not imported
 * from it — that file is the browser's and this is the server's, and the server
 * only ever stores the string.
 */
export type ShelfSort = 'follow' | 'read' | 'catchup' | 'updated' | 'title' | 'added';

const SHELF_SORTS: ShelfSort[] = ['follow', 'read', 'catchup', 'updated', 'title', 'added'];

/** Anything unrecognised falls back, so a hand-edited file cannot break the card. */
export function clampShelfSort(value: unknown): ShelfSort {
  return SHELF_SORTS.includes(value as ShelfSort) ? (value as ShelfSort) : 'follow';
}

/**
 * A named shelf you put series on.
 *
 * **Membership is many-to-many**, which is a choice and not the obvious one. A
 * series could have belonged to one library like a file to a folder, and that
 * is simpler to build and to answer "which one is this in". These behave like
 * tags instead: a series can be in *Reading* and *Korean* and *Favourites* at
 * once, because that is what somebody sorting nine hundred series actually
 * wants, and a single field would have made every arrangement exclusive.
 *
 * The cost is stated rather than hidden: counts overlap, so the libraries do
 * not add up to the total, and the screen says so rather than letting the
 * arithmetic look broken.
 */
export interface MangaLibrary {
  id: string;
  name: string;
  /**
   * Keep what is on it out of *Everything*.
   *
   * For the pile you do not want to look at — dropped, finished, saved for
   * later — without unfollowing it and losing where you were. The shelf is
   * still there and still one tap away; it simply stops filling the view you
   * open by default.
   *
   * **Hidden wins over every other shelf a series is on.** With many-to-many
   * membership a series can be on a hidden shelf and a visible one at once,
   * and the two say opposite things about *Everything* — so the one that
   * answers "keep this out of my way" takes it, because the other reading
   * makes hiding unreliable and an unreliable hide is worth nothing. Picking
   * the shelf itself always shows what is on it.
   */
  hidden?: boolean;
}

/**
 * Something you read without following it.
 *
 * Opening a chapter from Browse used to record nothing at all — no history, no
 * place kept — so dipping into something and coming back to it a week later
 * meant finding it again and remembering where you were. These rows exist for
 * exactly that and nothing else.
 *
 * **Deliberately not a `Series` with a flag.** 87 places in this module read
 * `store.series`, and every one of them — the release sweep, the counts, the
 * library grid, the matcher, the archive — would have had to learn to skip a
 * kind of series it had never heard of. A list of its own is a list nothing
 * reads unless it means to.
 *
 * The fields are named to match `Series` where they overlap, which is not
 * tidiness either: `/api/manga/:id/read` and the two position routes then work
 * on one of these unchanged, because they only ever touch these fields.
 */
export interface Glimpse {
  id: string;
  title: string;
  coverUrl: string | null;
  source: SeriesSource;
  readChapters: number[];
  readLog: ReadRecord[];
  addedAt: number;
}

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
   * Where a kept series is written, when it should not be the default.
   *
   * Null means the app's own data folder, which is the right answer until a
   * library outgrows the drive the app is installed on — an archive is the one
   * thing here that can reach hundreds of gigabytes, and the disk it belongs on
   * is a fact about the machine rather than about the app.
   *
   * An absolute path, and validated as one: a relative path would resolve
   * against the server's working directory, which Task Scheduler sets to
   * `C:\Windows\System32` — the exact trap `paths.ts` exists to describe.
   */
  archiveFolder: string | null;
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
  /**
   * Whether a new chapter also becomes a task, as well as a nudge.
   *
   * Off by default. The nudge is the point — it is what waits for a stopping
   * point and tells you — while a task per chapter turns the task list into a
   * reading log, and one that grows by every chapter of every series you follow.
   * Somebody who wants the chapter to sit on the Dashboard until ticked off can
   * say so; nobody should have to clear a list of chapters to find their tasks.
   */
  releaseTasks: boolean;
  /**
   * How many chapters ahead to fetch while you read, 0 to 3.
   *
   * The page cache fills *behind* you — a chapter is kept once you open it — so
   * going back was instant and going forward was not, which is the direction
   * people actually read in. One chapter ahead means the next one opens from
   * disk, through a source that may be slow and a Suwayomi that may be asleep.
   *
   * **One by default**, because that is the chapter you are nearly certainly
   * about to open, and it costs one chapter of somebody else's bandwidth for
   * one you were going to ask for anyway. Reading two ahead is a guess, and
   * three is a guess that costs three.
   *
   * **Three at most, because the cache keeps ten.** Prefetching further would
   * spend your history on chapters you have not read: at three ahead, seven of
   * the ten are still chapters you actually opened. A bound here is a bound on
   * how much of the cache a guess may take.
   *
   * **Zero is genuinely off** — nothing is fetched and nothing is queued, which
   * is the setting somebody on a metered connection is choosing.
   */
  readAheadChapters: number;
  /**
   * What the Dashboard card shows: your whole shelf, or only the starred ones.
   *
   * `all` by default rather than `favourites`, because a fresh install has
   * nothing starred and a card that opens empty is a card you take off again.
   */
  shelfShow: ShelfShow;
  /**
   * How the Dashboard card is ordered.
   *
   * **`follow` is the default and means "whatever the Library tab is set to on
   * this device"** — which is `localStorage`, so the PC and the phone can
   * differ, exactly as their Library tabs already do. That is one control in
   * two places, which is what "based on the current sorting" asks for.
   *
   * Pinning an order instead stores it *here*, on the server, so a pinned card
   * agrees across devices. The storage follows the wish rather than the other
   * way round: "keep these in step" is per device because the thing it follows
   * is, and "I want this one order" is shared because you said it once about
   * the card itself.
   */
  shelfSort: ShelfSort;
  /**
   * "New chapters on top" for the card — **only consulted when the sort is
   * pinned.**
   *
   * In `follow` the box comes from the Library tab on that device, along with
   * the order, because the two are one control there and reading half of it
   * from here would make the card disagree with the screen it claims to
   * follow. Pinned, the card is self-contained and this is its own answer, kept
   * on the server so every device draws it the same way.
   *
   * On by default, matching the Library's own default.
   */
  shelfNewFirst: boolean;
  /**
   * Whether a new chapter raises a nudge at all. On unless switched off, which
   * is what it always did. Off, chapters are still noticed and recorded — the
   * NEW badge, "last updated" and the release log all carry on — and nothing
   * waits on the Dashboard or interrupts you about them.
   */
  releaseNudges: boolean;
  /**
   * The source the Browse tab lists from, and whose results a search puts first.
   * An opaque source id; one that is no longer installed is simply not found,
   * and the tab falls back to the first source it has.
   */
  browseSource: string | null;
  /**
   * Sources left out of searching, browsing and finding imports: one that has
   * stopped working, or one you would rather not read from. By id, with the
   * name kept so the screen can say which without asking Suwayomi.
   */
  ignoredSources: Array<{ id: string; name: string }>;
  /**
   * The shelves, in the order they were made.
   *
   * No default is created: an install with none behaves exactly as it did
   * before they existed, which is one library called "everything you follow".
   */
  libraries: MangaLibrary[];
  series: Series[];
  /**
   * Read, not followed — see `Glimpse`.
   *
   * Never checked for new chapters, never counted, on no shelf. History is the
   * only place these appear, and following one moves it into `series`.
   */
  glimpses: Glimpse[];
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
 * `taskId: null` means "raised once, and there is no task" — because the task
 * was deleted, or because chapters were not being made into tasks — a decision,
 * not a gap, and never acted on again. Without that, deleting the task for a chapter
 * you have read recreates it on the next poll, within the half hour, with
 * nothing on screen to explain why.
 */
export type ReleaseLink = {
  seriesId: string;
  chapter: string;
  taskId: string | null;
  /**
   * The nudge raised for it, so reading the chapter can cancel a nudge still
   * waiting. With a task, finishing the task did that; without one, this does.
   * Absent on links written before it existed.
   */
  nudgeId?: string | null;
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
/** The most chapters that may be fetched ahead — see `Store.readAheadChapters`. */
export const MAX_READ_AHEAD = 3;

/** 0 to 3, whole chapters, defaulting to one. Anything else is not a number. */
export function clampReadAhead(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.min(MAX_READ_AHEAD, Math.max(0, Math.round(value)));
}

function emptyStore(): Store {
  return {
    suwayomiUrl: null,
    archiveFolder: null,
    suwayomiJar: null,
    manageSuwayomi: false,
    suwayomiMode: 'on-demand',
    readLanguages: [...DEFAULT_LANGUAGES],
    releaseTasks: false,
    readAheadChapters: 1,
    shelfShow: 'all',
    shelfSort: 'follow',
    shelfNewFirst: true,
    releaseNudges: true,
    browseSource: null,
    libraries: [],
    glimpses: [],
    ignoredSources: [],
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
      releaseTasks: parsed.releaseTasks === true,
      /*
       * Clamped on read rather than trusted. This file is the one place a
       * hand-edited manga.json is made sense of, and a 50 here would be fifty
       * chapters of somebody else's bandwidth fetched from one tap.
       */
      readAheadChapters: clampReadAhead(parsed.readAheadChapters),
      shelfShow: parsed.shelfShow === 'favourites' ? 'favourites' : 'all',
      shelfSort: clampShelfSort(parsed.shelfSort),
      shelfNewFirst: parsed.shelfNewFirst !== false,
      archiveFolder:
        typeof parsed.archiveFolder === 'string' && parsed.archiveFolder.trim() ? parsed.archiveFolder : null,
      releaseNudges: parsed.releaseNudges !== false,
      browseSource: typeof parsed.browseSource === 'string' && parsed.browseSource ? parsed.browseSource : null,
      glimpses: Array.isArray(parsed.glimpses)
        ? parsed.glimpses.map((g) => ({
            ...g,
            readChapters: Array.isArray(g.readChapters) ? g.readChapters : [],
            readLog: Array.isArray(g.readLog) ? g.readLog : [],
            coverUrl: g.coverUrl ?? null,
          }))
        : [],
      libraries: Array.isArray(parsed.libraries)
        ? parsed.libraries.filter(
            (l: unknown): l is MangaLibrary =>
              typeof (l as MangaLibrary)?.id === 'string' && typeof (l as MangaLibrary)?.name === 'string'
          )
        : [],
      ignoredSources: Array.isArray(parsed.ignoredSources)
        ? parsed.ignoredSources.filter(
            (x): x is { id: string; name: string } =>
              typeof x === 'object' && x !== null && typeof x.id === 'string' && typeof x.name === 'string'
          )
        : [],
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
        readLog: Array.isArray(s.readLog) ? s.readLog : [],
        reviews: Array.isArray(s.reviews) ? s.reviews : [],
        // Only `true` survives, so a stray `"yes"` in a hand-edited file is a no.
        ...(s.favourite === true ? { favourite: true as const } : {}),
        ...(Array.isArray(s.libraries) && s.libraries.some((l: unknown) => typeof l === 'string')
          ? { libraries: s.libraries.filter((l: unknown): l is string => typeof l === 'string') }
          : {}),
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

/* ---- reading positions, in a file of their own ---- */

/**
 * Where you are in each series, kept apart from the library.
 *
 * The library file is written when something is *decided* — a series added, a
 * chapter finished — and this note at the top of `readChapters` has always said
 * per-page position is the case that file is wrong for. So it is not in it: a
 * position is saved every few seconds while you read, and rewriting the whole
 * library that often would put every series you follow at risk each time for
 * the sake of a scroll offset. This file holds one small record per series, is
 * written the same atomic way, and losing it costs a place in a chapter.
 */
const POSITIONS = join(dataDir, 'manga-positions.json');

export function readPositions(): Record<string, ReadingPosition> {
  if (!existsSync(POSITIONS)) return {};
  try {
    const parsed = JSON.parse(readFileSync(POSITIONS, 'utf8').replace(/^\uFEFF/, '')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, ReadingPosition>) : {};
  } catch {
    return {};
  }
}

/** Set one series' position, or clear it with null. Returns the one it replaced. */
export function writePosition(seriesId: string, position: ReadingPosition | null): ReadingPosition | null {
  const all = readPositions();
  const before = all[seriesId] ?? null;
  if (position) all[seriesId] = position;
  else delete all[seriesId];
  mkdirSync(dataDir, { recursive: true });
  const tmp = `${POSITIONS}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(all)}\n`, 'utf8');
  renameSync(tmp, POSITIONS);
  return before;
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
    | 'readLog'
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
    readLog: [],
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
