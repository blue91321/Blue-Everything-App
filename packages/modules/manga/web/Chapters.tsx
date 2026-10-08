/**
 * The chapter list for one series, and the reader it opens.
 *
 * Holds the "which chapter am I in" state so the list and the reader are one
 * screen rather than two that have to agree. Newest first, which is the order
 * every reader in this space uses and the one anybody following a running series
 * wants — you come here for chapter 107, not chapter 1.
 *
 * The list is read from the source's **cache** by default. Refreshing scrapes
 * the site, takes seconds and is a button, because opening a list should not
 * make a request to somebody else's server every time.
 *
 * ### Where you left off
 *
 * The top of the list says where to pick up: the chapter you were partway
 * through and the page, or failing that the next one after the furthest you
 * have finished. A place is only returned to *exactly* on the copy it was
 * measured on — another source splits the same chapter into different pages,
 * so page 12 there is somewhere else here — and the card says so rather than
 * dropping you in the wrong spot.
 */
import { useEffect, useRef, useState } from 'react';
import { useAsync } from '@app/useAsync';
import { beside, skippedBetween, skipTarget } from './chapter-nav.js';
import { useBackStep } from '@app/view-history';
import { isIncognito } from './incognito';
import { useButtonMenu, type MenuItem } from '@app/ContextMenu';
import { Cover } from './Cover';
import { Icon } from './Icons';
import { chapterText } from './judge';
import { sourceLabel } from './Library';
import { ageOf, manga, type SeriesSummary, type SourceChapter } from './manga-api';
import { Reader } from './Reader';
import { usePositionSaver } from './usePositionSaver';
import {
  clearProblem,
  offlineSupported,
  queueDownload,
  removeChapter,
  sizeText,
  updateSnapshot,
  useOffline,
} from './offline-store';
import { logRead } from './reading-log';
import { useConnectivity } from '@app/offline-sync';
import { NEEDS } from './device-text';
import { rememberOpen } from './open-chapter';

/** How many "Next" saves ahead of where you are. — and see `saveAll` for the rest. */
const SAVE_AHEAD = [5, 10] as const;

const STATUS_LABEL: Record<SeriesSummary['status'], string> = {
  ongoing: 'ongoing',
  completed: 'finished',
  hiatus: 'on hiatus',
  cancelled: 'cancelled',
  unknown: 'status unknown',
};

/**
 * One row per chapter number, and which entry that row is.
 *
 * Sources list the same chapter more than once — MangaFire carries two
 * editions of most of them, which is why the head here already counts distinct
 * *numbers* rather than entries and read "864 chapters" for a series at 419.
 * A list where every chapter appears twice is one you cannot scan, and the two
 * rows offer no way to tell which is the one to open.
 *
 * **Nothing here can know which is "real", and it does not pretend to.** That
 * is the hard half, and the honest answer is a rule stated plainly rather than
 * a guess dressed as a fact:
 *
 *   1. the entry you already have a place in, so collapsing the list can never
 *      move the chapter you are halfway through;
 *   2. otherwise the most recently uploaded, which is the later of two
 *      editions and usually the corrected one;
 *   3. otherwise whichever the source listed first, because the order it sends
 *      is the order it leads with.
 *
 * None of that is certain, so it is reversible: the ⋯ menu turns it off and
 * every entry comes back. Collapsing hides rows, and a list that quietly hides
 * things had better say so and offer the way back.
 */
export function pickOnePerNumber(
  chapters: readonly SourceChapter[],
  placeChapterId: string | null
): { shown: SourceChapter[]; duplicates: number } {
  const byNumber = new Map<number, SourceChapter[]>();
  for (const c of chapters) {
    const had = byNumber.get(c.number);
    if (had) had.push(c);
    else byNumber.set(c.number, [c]);
  }

  const shown: SourceChapter[] = [];
  let duplicates = 0;
  for (const group of byNumber.values()) {
    duplicates += group.length - 1;
    shown.push(
      group.find((c) => c.id === placeChapterId) ??
        [...group].sort((a, b) => (b.uploadedAt ?? 0) - (a.uploadedAt ?? 0))[0]!
    );
  }
  // Back into the order the source sent, which is what the list is sorted by.
  const order = new Map(chapters.map((c, i) => [c.id, i]));
  shown.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return { shown, duplicates };
}

export function Chapters({
  seriesId,
  series,
  libraries = [],
  onClose,
  onCompare,
  onDetails,
  onChanged,
  continueOnOpen = false,
  reopenChapterId,
  coverPath = null,
}: {
  seriesId: string;
  /** The library's summary of it: status, when it was checked, and whether that failed. */
  series?: SeriesSummary;
  /** The shelves on offer, drawn as chips on the head. Empty on an older server. */
  libraries?: Array<{ id: string; name: string; hidden?: boolean }>;
  /** The source's page for it — Series details. */
  onDetails?: () => void;
  /** Unlinked or unfollowed from the ⋯, so the library behind this reloads. */
  onChanged?: () => void;
  /** Saved with any downloaded chapter, so the offline list has a picture. */
  coverPath?: string | null;
  onClose: () => void;
  /** Open the same series across every source — where you go when a chapter here is broken. */
  onCompare: () => void;
  /** Go straight back into the chapter you were reading — the library's Continue. */
  continueOnOpen?: boolean;
  /** The chapter that was open when the page was reloaded: straight back into it. */
  reopenChapterId?: string;
}) {
  /*
   * Back closes the chapter list and returns to whichever tab opened it.
   *
   * The reader pushes one of these too, so a chapter open over this list is two
   * steps deep and back unwinds them one at a time — which is what the shelf,
   * the list and the page already look like on screen.
   */
  const close = useBackStep(onClose);
  const list = useAsync(() => manga.reader.chapters(seriesId), [seriesId]);
  /** What the device's reading log calls this series — a name, so the exported file is readable. */
  const logTitle = series?.title ?? list.data?.seriesTitle ?? '';
  const [open, setOpen] = useState<SourceChapter | null>(null);
  const [resume, setResume] = useState<{ page: number; offset: number } | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Collapse duplicate chapter numbers to one row.
   *
   * Remembered in `localStorage` like the library's sort and the folded note
   * folders, and for the same reason: it is a view preference about one screen,
   * and a list you collapsed on the phone should not collapse on the PC.
   */
  const [oneRow, setOneRow] = useState(() => {
    try {
      return localStorage.getItem('everything.manga.everyVersion') !== '1';
    } catch {
      return true;
    }
  });
  const saver = usePositionSaver(seriesId);
  const continued = useRef(false);
  const offline = useOffline();
  const net = useConnectivity();
  const saved = offline.manifest?.series[seriesId]?.chapters ?? {};
  const jobs = new Map(offline.jobs.filter((j) => j.seriesId === seriesId).map((j) => [j.chapterId, j]));

  const data = list.data;
  const place = data?.position ?? null;
  const sameCopy = place !== null && data?.mangaId !== undefined && place.mangaId === data.mangaId;
  const placeChapter =
    place && data
      ? sameCopy
        ? data.chapters.find((c) => c.id === place.chapterId) ?? null
        : data.chapters.find((c) => c.number === place.chapter) ?? null
      : null;
  const { shown: oneEach, duplicates } = pickOnePerNumber(data?.chapters ?? [], place?.chapterId ?? null);
  const listed = oneRow ? oneEach : (data?.chapters ?? []);

  const furthestRead = data ? Math.max(-Infinity, ...data.chapters.filter((c) => c.read).map((c) => c.number)) : -Infinity;
  const nextUp =
    data && furthestRead > -Infinity
      ? [...data.chapters].filter((c) => c.number > furthestRead).sort((a, b) => a.number - b.number)[0] ?? null
      : null;

  /*
   * This device's copy of your reading, for the offline screen: refreshed from
   * the server every time the list loads, so what the train shows is what the
   * PC last said. Nothing happens for a series with nothing saved.
   */
  useEffect(() => {
    if (!data) return;
    void updateSnapshot(seriesId, {
      readChapters: data.chapters.filter((c) => c.read).map((c) => c.number),
      position: sameCopy && place ? { ...place } : null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  function save(chapter: SourceChapter) {
    if (!data) return;
    queueDownload(
      {
        seriesId,
        title: data.seriesTitle,
        sourceName: data.sourceName,
        coverPath,
        readChapters: data.chapters.filter((c) => c.read).map((c) => c.number),
        position: sameCopy && place ? { ...place } : null,
      },
      { id: chapter.id, number: chapter.number, name: chapter.name },
      async () => (await manga.reader.pages(seriesId, chapter.id)).pages
    );
  }

  /**
   * The next few to read, not the newest few: from the chapter you are in (or
   * the one after the furthest you finished) upwards, skipping any already
   * saved. One per chapter number — a site listing two editions of a chapter
   * would otherwise spend half the download on duplicates.
   */
  function saveAhead(count: number) {
    if (!data) return;
    const from = placeChapter?.number ?? (nextUp?.number ?? -Infinity);
    const picked = new Map<number, SourceChapter>();
    for (const c of [...data.chapters].sort((a, b) => a.number - b.number)) {
      if (c.number < from || picked.has(c.number) || (c.read && c.number !== from)) continue;
      picked.set(c.number, c);
      if (picked.size >= count) break;
    }
    for (const c of picked.values()) if (!saved[c.id]) save(c);
  }

  /**
   * Every chapter, not the next few.
   *
   * Asked for: five and ten are the right sizes for "what I will read on the
   * train", and useless for "put this whole series on my laptop before the
   * site goes down" — which is the same wish the archive answers on the PC,
   * arriving here for the device in your hand.
   *
   * One per chapter *number*, like `saveAhead`, because a source listing two
   * editions of most chapters would otherwise spend half the download on
   * duplicates — MangaFire reads "864 chapters" for a series at 419.
   *
   * It asks first, and the question names the number. This is the one control
   * here that can commit a few gigabytes of somebody's disk in one press, and
   * on a phone that storage is the first thing iOS reclaims when space runs
   * short — which the offline copy already says in as many words.
   */
  function saveAll() {
    if (!data) return;
    const picked = new Map<number, SourceChapter>();
    for (const c of [...data.chapters].sort((a, b) => a.number - b.number)) {
      if (picked.has(c.number) || saved[c.id]) continue;
      picked.set(c.number, c);
    }
    if (picked.size === 0) return;
    if (!confirm(`Save all ${picked.size} remaining chapters to this device?`)) return;
    for (const c of picked.values()) save(c);
  }

  const savedHere = Object.values(saved);
  const savedBytes = savedHere.reduce((sum, c) => sum + c.bytes, 0);

  function read(chapter: SourceChapter, at: { page: number; offset: number } | null = null) {
    saver.flush();
    setResume(at);
    setOpen(chapter);
  }

  function carryOn() {
    if (!placeChapter || !place) return;
    read(placeChapter, sameCopy ? { page: place.page, offset: place.offset } : null);
  }

  // A reload mid-chapter: back into that chapter, at the saved place when the
  // place is in it. Every page is fetched again on the way, which is often why
  // somebody reloaded.
  useEffect(() => {
    if (!reopenChapterId || continued.current || !data) return;
    const chapter = data.chapters.find((c) => c.id === reopenChapterId);
    if (!chapter) return;
    continued.current = true;
    const here = sameCopy && place && place.chapterId === chapter.id;
    read(chapter, here ? { page: place.page, offset: place.offset } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reopenChapterId, data]);

  // Kept across a reload of the page — see `open-chapter.ts`.
  useEffect(() => {
    rememberOpen(open ? { seriesId, chapterId: open.id } : null);
  }, [seriesId, open?.id]);
  useEffect(() => () => rememberOpen(null), []);

  // The library's Continue: straight into the chapter once the list is here.
  useEffect(() => {
    if (!continueOnOpen || continued.current || !data) return;
    continued.current = true;
    if (placeChapter) carryOn();
    else if (nextUp) read(nextUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [continueOnOpen, data]);

  async function refresh() {
    setBusy(true);
    try {
      await manga.reader.chapters(seriesId, true);
      list.reload();
    } finally {
      setBusy(false);
    }
  }

  const [problem, setProblem] = useState<string | null>(null);

  /** Both leave nothing to show here, so both close it. */
  async function unlink() {
    if (!confirm(`Stop reading ${series?.title ?? 'this'} on ${data?.sourceName ?? 'this source'}? What you have read is kept.`)) return;
    try {
      await manga.source.unlink(seriesId);
      onChanged?.();
      close();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'could not unlink it');
    }
  }

  async function unfollow() {
    if (!confirm(`Stop following ${series?.title ?? data?.seriesTitle ?? 'this'}?`)) return;
    try {
      await manga.remove(seriesId);
      onChanged?.();
      close();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'could not remove it');
    }
  }

  /*
   * What the library's row buttons used to do, behind one ⋯ — the library is a
   * shelf of covers now, and this is the screen a cover opens. Other sources is
   * here as well as in the menu's old home because this is where you are when
   * a chapter turns out to be broken or missing; switching keeps your place,
   * since what you have read is stored by chapter number, not by source ids.
   */
  const count = data ? new Set(data.chapters.map((c) => c.number)).size : null;

  /*
   * Whether this series is kept for good — see the server's `archive.ts`.
   *
   * Read from the overview rather than asking about this one series, because
   * the card on More reads the same call and `api.ts` coalesces two readers of
   * one path into one request.
   */
  const archive = useAsync(() => manga.archive.overview());
  const kept = archive.data?.series.find((a) => a.seriesId === seriesId) ?? null;
  /**
   * Chapter numbers this PC is keeping for good, if the series is archived.
   *
   * A Set because the row asks once per chapter and a series runs to hundreds
   * — `includes` down a 182-long array on every render is the sort of thing
   * that is free until it is not.
   */
  const onThePc = new Set(kept?.savedChapters ?? []);

  const keepEverything = async () => {
    try {
      await manga.archive.start(seriesId);
      archive.reload();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'could not start keeping it');
    }
  };

  const stopKeeping = async () => {
    try {
      // Files kept: stopping what comes next and throwing away what you have
      // are different decisions, and only one can be undone. More has the other.
      await manga.archive.stop(seriesId, false);
      archive.reload();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'could not stop');
    }
  };

  const menu = useButtonMenu(() => [
    ...(onDetails ? [{ label: 'Series details', onSelect: onDetails }] : []),
    { label: 'Other sources', onSelect: onCompare },
    { label: busy ? 'Checking the site…' : 'Check the site for chapters', onSelect: () => void refresh(), disabled: busy },
    /*
     * Named for what it does rather than "Download": the Downloads tab already
     * means saving to *this device*, and this is the PC keeping the whole thing
     * for good. Two different promises deserve two different words.
     */
    kept
      ? {
          label: `Stop keeping chapters (${kept.complete}/${kept.chapters} saved)`,
          onSelect: () => void stopKeeping(),
        }
      : { label: 'Keep every chapter on the PC', onSelect: () => void keepEverything() },
    /*
     * Only offered when there is something to collapse. A switch about
     * duplicates on a source that lists none is a setting for a problem you do
     * not have, and it invites the question of what it would do.
     */
    ...(duplicates > 0
      ? [
          {
            label: oneRow
              ? `Show every version (${duplicates} more)`
              : `One row per chapter (hides ${duplicates})`,
            onSelect: () => {
              const next = !oneRow;
              setOneRow(next);
              try {
                if (next) localStorage.removeItem('everything.manga.everyVersion');
                else localStorage.setItem('everything.manga.everyVersion', '1');
              } catch {
                // A browser that will not remember it still honours the change
                // for as long as this screen is open.
              }
            },
          } satisfies MenuItem,
        ]
      : []),
    /*
     * First in the menu, because it is the only entry here you would use more
     * than once — everything below it is something you do to a series once and
     * never again (link it, unlink it, stop following it).
     */
    {
      label: series?.favourite ? 'Remove from favourites' : 'Add to favourites',
      onSelect: () => void toggleFavourite(),
    },
    { label: 'Unlink this source', onSelect: () => void unlink() },
    { label: 'Stop following', onSelect: () => void unfollow(), danger: true },
  ]);

  const [shelving, setShelving] = useState(false);

  /** Put this series on exactly these shelves — a whole-list write. */
  async function setShelves(ids: string[]) {
    if (!series) return;
    setShelving(true);
    try {
      await manga.libraries.set(series.id, ids);
      onChanged?.();
      list.reload();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'that could not be saved');
    } finally {
      setShelving(false);
    }
  }

  /** Star or unstar, then reload so the head and the library row agree. */
  async function toggleFavourite() {
    if (!series) return;
    try {
      await manga.setFavourite(series.id, !series.favourite);
      onChanged?.();
      list.reload();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'that could not be saved');
    }
  }

  function go(direction: -1 | 1) {
    if (!open) return;
    saver.flush();
    const target = beside(list.data?.chapters ?? [], open.number, direction);
    if (!target) return;
    setResume(null);
    setOpen(target);
  }

  /**
   * Go to the next whole chapter, passing over the point chapters.
   *
   * **Finishing marks the ones passed over read as well**, and that follows
   * from what pressing it means. Skipping 2.1 and 2.2 to reach 3 is the claim
   * that chapter 2 already contained them — so leaving them unread would put a
   * NEW badge and a catch-up count on chapters you have, in substance, read,
   * and it would stay wrong forever because nothing later would clear it.
   *
   * Moving on from partway through marks nothing, which is the arrow's own
   * rule: skipping is not finishing.
   */
  async function skip(finishing: boolean) {
    if (!open) return;
    const all = list.data?.chapters ?? [];
    const target = skipTarget(all, open.number);
    if (!target) return;
    saver.flush();

    if (finishing && !isIncognito()) {
      // This one and everything between, nearest first — see `skippedBetween`.
      await logRead(seriesId, [open.number, ...skippedBetween(all, open.number, target.number)], logTitle);
      void updateSnapshot(seriesId, { read: Math.max(open.number, ...skippedBetween(all, open.number, target.number)) });
      list.reload();
    }

    setResume(null);
    setOpen(target);
  }

  async function finished(chapterNumber: number) {
    saver.flush();
    /*
     * Incognito stops the *recording*, not the reading — see `incognito.ts`.
     *
     * Only this block is skipped. An earlier version returned here instead,
     * which also skipped moving on to the next chapter: reading without a
     * record is not the same as reading one chapter and stopping, and the
     * difference is the whole feature.
     *
     * The offline queue goes with it. Queued, the read would simply be written
     * down later, which is the thing that was not wanted rather than a delayed
     * version of it.
     */
    if (!isIncognito()) {
      // Written down on this device first, then sent — see `reading-log.ts`.
      await logRead(seriesId, [chapterNumber], logTitle);
      void updateSnapshot(seriesId, { read: chapterNumber });
    }
    const all = list.data?.chapters ?? [];
    /*
     * The next one *up*, not the next in the array. The list is newest-first, so
     * "next" in reading order is the entry before this one — and going by number
     * rather than by index keeps that true whatever the list is sorted by later.
     */
    const next = all
      .filter((c) => c.number > chapterNumber)
      .sort((a, b) => a.number - b.number)[0];
    list.reload();
    setResume(null);
    setOpen(next ?? null);
  }

  if (open) {
    return (
      <Reader
        seriesId={seriesId}
        chapter={open}
        resume={resume}
        onClose={() => {
          saver.flush();
          setOpen(null);
          setResume(null);
          // So the card and the row say the page you just left, not the one before.
          setTimeout(() => list.reload(), 400);
        }}
        onFinished={(n) => void finished(n)}
        onLeftAtEnd={(n) => {
          if (isIncognito()) return;
          void updateSnapshot(seriesId, { read: n });
          void logRead(seriesId, [n], logTitle).then(() => list.reload());
        }}
        onGo={go}
        onSkip={(finishing) => void skip(finishing)}
        skipTo={skipTarget(list.data?.chapters ?? [], open.number)?.number ?? null}
        hasPrevious={beside(list.data?.chapters ?? [], open.number, -1) !== undefined}
        hasNext={beside(list.data?.chapters ?? [], open.number, 1) !== undefined}
        nextNumber={beside(list.data?.chapters ?? [], open.number, 1)?.number ?? null}
        onPosition={(p) =>
          saver.note({ chapter: open.number, chapterId: open.id, chapterName: open.name, ...p })
        }
      />
    );
  }

  return (
    <div className="card manga-chapters-screen">
      <div className="row between">
        <button className="btn subtle" onClick={close}>
          ‹ Back
        </button>
        <button className="manga-icon-btn" aria-label="More for this series" aria-haspopup="menu" onClick={menu.open}>
          <Icon.more />
        </button>
      </div>
      {menu.menu}

      <div className="manga-chapters-head">
        <Cover path={coverPath} title={series?.title ?? data?.seriesTitle ?? ''} size={64} />
        <div className="manga-row-text">
          <span className="manga-chapters-title">{series?.title ?? data?.seriesTitle ?? 'loading…'}</span>
          <span className="meta">
            {data ? sourceLabel(data.sourceName) : ''}
            {series ? ` · ${STATUS_LABEL[series.status]}` : ''}
            {/*
              * Chapters, not entries: a site listing two editions of a chapter
              * would otherwise claim twice what it has.
              */}
            {count !== null ? ` · ${count} chapter${count === 1 ? '' : 's'}` : ''}
            {series?.checkedAt ? ` · checked ${ageOf(series.checkedAt, Date.now())}` : ''}
          </span>
          {/*
            * Beside the numbers it could not refresh, never instead of them —
            * the grid's ! points here.
            */}
          {series?.error && <span className="meta urgent">Last check failed: {series.error}</span>}
          {series?.notWatchingBecause && <span className="meta">Not watched — {series.notWatchingBecause}</span>}

          {/*
            Shelves, as chips you tap.
            
            This was only in the tile's right-click menu, which is a desktop
            affordance — **touch has no right-click**, so on a phone there was
            no way to shelve anything at all, and on a PC it was a feature you
            had to already know about. Reported as not being findable, which it
            was not.
            
            Here because this is where you land when you tap a cover, and it is
            the screen that is already about one series. Visible rather than
            behind the ⋯ beside it for the same reason: a menu is where you put
            what somebody already knows to look for.
            
            The star joins them, so the two things you can file a series under
            sit together rather than one being a chip and the other a menu item.
          */}
          {series && (
            <div className="manga-shelf-chips">
              <button
                className={`manga-shelf-chip${series.favourite ? ' on' : ''}`}
                aria-pressed={series.favourite === true}
                disabled={shelving}
                onClick={() => void toggleFavourite()}
                title={series.favourite ? 'Remove from favourites' : 'Add to favourites'}
              >
                {series.favourite ? '★' : '☆'} Favourite
              </button>
              {libraries.map((l) => {
                const on = series.libraries?.includes(l.id) === true;
                return (
                  <button
                    key={l.id}
                    className={`manga-shelf-chip${on ? ' on' : ''}`}
                    aria-pressed={on}
                    disabled={shelving}
                    onClick={() =>
                      void setShelves(
                        on ? (series.libraries ?? []).filter((x) => x !== l.id) : [...(series.libraries ?? []), l.id]
                      )
                    }
                  >
                    {on ? '✓ ' : '+ '}
                    {l.hidden ? '◌ ' : ''}
                    {l.name}
                  </button>
                );
              })}
              {libraries.length === 0 && (
                <span className="meta">No shelves yet — make one on the More tab.</span>
              )}
            </div>
          )}
        </div>
      </div>
      {problem && <p className="banner">{problem}</p>}

      {place && placeChapter && (
        <div className="manga-continue">
          <div className="manga-row-text">
            <span className="title">Continue {place.chapterName}</span>
            <span className="meta">
              {sameCopy
                ? `page ${place.page + 1} of ${place.pages}`
                : `You were on page ${place.page + 1} of ${place.pages} on ${place.source}. ${data?.sourceName} splits its pages differently, so this opens at the start of the chapter.`}
            </span>
          </div>
          <button className="btn primary" onClick={carryOn}>
            Continue
          </button>
        </div>
      )}
      {!placeChapter && nextUp && (
        <div className="manga-continue">
          <div className="manga-row-text">
            <span className="title">Next: {nextUp.name}</span>
            <span className="meta">the first after chapter {chapterText(furthestRead)}, the furthest you have finished</span>
          </div>
          <button className="btn primary" onClick={() => read(nextUp)}>
            Read
          </button>
        </div>
      )}

      {data && data.chapters.length > 0 && (
        <div className="manga-save-bar">
          {offlineSupported && net.offline ? (
            <span className="meta">
              Offline — ✓ marks what is saved on this device and opens now. Saving more {NEEDS}.
            </span>
          ) : offlineSupported ? (
            <>
              <span className="meta">Save for offline:</span>
              {SAVE_AHEAD.map((n) => (
                <button key={n} className="btn subtle" onClick={() => saveAhead(n)}>
                  Next {n}
                </button>
              ))}
              <button className="btn subtle" onClick={saveAll} title="Every chapter not already on this device">
                All
              </button>
              <span className="meta">
                {jobs.size > 0
                  ? `saving ${[...jobs.values()].filter((j) => !j.problem).length}…`
                  : savedHere.length > 0
                    ? `${savedHere.length} saved on this device · ${sizeText(savedBytes)}`
                    : 'or ⬇ on any chapter'}
              </span>
              {/*
                * Said here because the ✓ was read as broken.
                *
                * Reading a chapter while the series is being kept downloads it
                * — onto the PC — and the row's tick went on saying
                * nothing, because that tick has only ever meant "in this
                * browser's storage". Two true things, one mark, and the one it
                * was not about is the one that had just happened.
                *
                * So the two places are named rather than merged. Merging them
                * would make ✓ mean "a copy exists somewhere", which is the
                * one thing it must not mean on a phone that has left the house.
                */}
              {kept && (
                <span className="meta" title="Manga → More → Kept for good">
                  · {onThePc.size} of {kept.chapters} kept on the PC, separately
                </span>
              )}
            </>
          ) : (
            // Cache Storage needs a secure page; the https address is one on every device.
            <span className="meta">Saving for offline works on the app's https address — the one Settings → Add a device shows.</span>
          )}
        </div>
      )}

      {list.loading && <p className="empty">loading…</p>}
      {list.error && <p className="banner">Could not load: {list.error.message}</p>}
      {data?.chapters.length === 0 && (
        <p className="empty">
          The source has no chapters for this one. Try ⋯ → Check the site, or{' '}
          <button className="btn subtle" onClick={onCompare}>
            see it on other sources
          </button>
          .
        </p>
      )}

      <div className="manga-chapters">
        {listed.map((c) => {
          /*
           * Where you were, even after changing source.
           *
           * This asked `sameCopy`, which compares the source's own manga id —
           * so switching source silently dropped the marker, and the chapter
           * you were halfway through went back to looking untouched. Reported
           * as switching a source losing when you last read something.
           *
           * `placeChapter` already falls back to matching by chapter *number*,
           * which means the same thing wherever you read it — the rule
           * `readChapters` follows one level up. So the row is marked either
           * way; what changes is how much can honestly be said about it.
           */
          const here = placeChapter?.id === c.id;
          const job = jobs.get(c.id);
          const isSaved = saved[c.id] !== undefined;
          return (
            // Two buttons in a row rather than one inside another, which no
            // browser will render: the chapter, and saving it.
            <div key={c.id} className={`manga-chapter-row${c.read ? ' read' : ''}${here ? ' started' : ''}`}>
              <button
                className="manga-chapter-open"
                // Resumed at the page only on the copy that page was counted on.
                onClick={() => read(c, here && sameCopy && place ? { page: place.page, offset: place.offset } : null)}
              >
                <span className="title truncate">{c.name}</span>
                <span className="meta">
                  {c.scanlator ? `${c.scanlator} · ` : ''}
                  {c.uploadedAt ? new Date(c.uploadedAt).toLocaleDateString() : ''}
                  {/*
                    * The page only means something on the copy it was counted
                    * on: another source paginates differently, so "page 9 of
                    * 128" would be a precise claim about the wrong book. The
                    * chapter survives the move; the page does not, and says so
                    * rather than being quietly wrong.
                    */}
                  {here && place ? (sameCopy ? ` · page ${place.page + 1} of ${place.pages}` : ' · you were here') : ''}
                  {c.read ? (c.readOn ? ` · read on ${c.readOn}` : ' · read') : ''}
                  {/* Kept on the PC for good, which the ✓ beside it is not about. */}
                  {onThePc.has(c.number) ? ' · on the PC' : ''}
                  {job?.problem ? ` · ${job.problem}` : ''}
                </span>
              </button>
              {offlineSupported && (
                <button
                  className={`manga-chapter-save${isSaved ? ' saved' : ''}${job?.problem ? ' failed' : ''}`}
                  aria-label={
                    isSaved ? `${c.name} is saved on this device — remove it` : job ? `Saving ${c.name}` : `Save ${c.name} for offline`
                  }
                  title={
                    isSaved
                      ? `Saved on this device (${sizeText(saved[c.id]!.bytes)}) — tap to remove`
                      : (job?.problem ??
                        (onThePc.has(c.number)
                          ? 'Kept on the PC. This saves a copy into this device too, so it opens with nothing running.'
                          : undefined))
                  }
                  disabled={job !== undefined && !job.problem}
                  onClick={() => {
                    if (isSaved) void removeChapter(seriesId, c.id);
                    else {
                      if (job?.problem) clearProblem(job.key);
                      save(c);
                    }
                  }}
                >
                  {isSaved ? '✓' : job && !job.problem ? (job.total ? `${job.done}/${job.total}` : '…') : job?.problem ? '↻' : '⬇'}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

