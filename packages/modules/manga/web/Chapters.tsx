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
import { useBackStep } from '@app/view-history';
import { useButtonMenu } from '@app/ContextMenu';
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
import { enqueue } from './sync-queue';
import { useConnectivity } from '@app/offline-sync';
import { NEEDS } from './device-text';

/** How many "Next" saves ahead of where you are. — and see `saveAll` for the rest. */
const SAVE_AHEAD = [5, 10] as const;

const STATUS_LABEL: Record<SeriesSummary['status'], string> = {
  ongoing: 'ongoing',
  completed: 'finished',
  hiatus: 'on hiatus',
  cancelled: 'cancelled',
  unknown: 'status unknown',
};

export function Chapters({
  seriesId,
  series,
  onClose,
  onCompare,
  onDetails,
  onChanged,
  continueOnOpen = false,
  coverPath = null,
}: {
  seriesId: string;
  /** The library's summary of it: status, when it was checked, and whether that failed. */
  series?: SeriesSummary;
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
  const [open, setOpen] = useState<SourceChapter | null>(null);
  const [resume, setResume] = useState<{ page: number; offset: number } | null>(null);
  const [busy, setBusy] = useState(false);
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
    { label: 'Unlink this source', onSelect: () => void unlink() },
    { label: 'Stop following', onSelect: () => void unfollow(), danger: true },
  ]);

  function go(direction: -1 | 1) {
    if (!open) return;
    saver.flush();
    const target = beside(list.data?.chapters ?? [], open.number, direction);
    if (!target) return;
    setResume(null);
    setOpen(target);
  }

  async function finished(chapterNumber: number) {
    saver.flush();
    try {
      await manga.reader.markRead(seriesId, chapterNumber);
    } catch {
      // The connection dropped mid-chapter: queued, and sent when it is back.
      enqueue({ kind: 'read', seriesId, chapter: chapterNumber, at: Date.now() });
    }
    void updateSnapshot(seriesId, { read: chapterNumber });
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
        onGo={go}
        hasPrevious={beside(list.data?.chapters ?? [], open.number, -1) !== undefined}
        hasNext={beside(list.data?.chapters ?? [], open.number, 1) !== undefined}
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
        {data?.chapters.map((c) => {
          const here = sameCopy && place?.chapterId === c.id;
          const job = jobs.get(c.id);
          const isSaved = saved[c.id] !== undefined;
          return (
            // Two buttons in a row rather than one inside another, which no
            // browser will render: the chapter, and saving it.
            <div key={c.id} className={`manga-chapter-row${c.read ? ' read' : ''}${here ? ' started' : ''}`}>
              <button
                className="manga-chapter-open"
                onClick={() => read(c, here && place ? { page: place.page, offset: place.offset } : null)}
              >
                <span className="title truncate">{c.name}</span>
                <span className="meta">
                  {c.scanlator ? `${c.scanlator} · ` : ''}
                  {c.uploadedAt ? new Date(c.uploadedAt).toLocaleDateString() : ''}
                  {here && place ? ` · page ${place.page + 1} of ${place.pages}` : ''}
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

/** The chapter next to `n` by number, one way or the other — duplicate editions of `n` skipped. */
function beside<T extends { number: number }>(list: readonly T[], n: number, direction: -1 | 1): T | undefined {
  return list
    .filter((c) => (direction === 1 ? c.number > n : c.number < n))
    .sort((a, b) => (a.number - b.number) * direction)[0];
}
