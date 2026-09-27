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
import { chapterText } from './judge';
import { manga, type SourceChapter } from './manga-api';
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

/** How many "Next" saves ahead of where you are. */
const SAVE_AHEAD = [5, 10] as const;

export function Chapters({
  seriesId,
  onClose,
  onCompare,
  continueOnOpen = false,
  coverPath = null,
}: {
  seriesId: string;
  /** Saved with any downloaded chapter, so the offline list has a picture. */
  coverPath?: string | null;
  onClose: () => void;
  /** Open the same series across every source — where you go when a chapter here is broken. */
  onCompare: () => void;
  /** Go straight back into the chapter you were reading — the library's Continue. */
  continueOnOpen?: boolean;
}) {
  const list = useAsync(() => manga.reader.chapters(seriesId), [seriesId]);
  const [open, setOpen] = useState<SourceChapter | null>(null);
  const [resume, setResume] = useState<{ page: number; offset: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const saver = usePositionSaver(seriesId);
  const continued = useRef(false);
  const offline = useOffline();
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
        onPosition={(p) =>
          saver.note({ chapter: open.number, chapterId: open.id, chapterName: open.name, ...p })
        }
      />
    );
  }

  return (
    <div className="card">
      <div className="row between">
        <button className="btn subtle" onClick={onClose}>
          ‹ Back
        </button>
        <span className="meta">
          {data ? `${data.seriesTitle} · ${data.sourceName}` : 'loading…'}
        </span>
        <span className="row">
          {/*
            * Here as well as on the series row, because this is where you are
            * when a chapter turns out to be broken or missing. Switching keeps
            * your place: what you have read is stored by chapter number, not by
            * this source's ids.
            */}
          <button className="btn subtle" onClick={onCompare}>
            Other sources
          </button>
          <button className="btn subtle" disabled={busy} onClick={() => void refresh()}>
            {busy ? 'Checking the site…' : 'Refresh'}
          </button>
        </span>
      </div>

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
          {offlineSupported ? (
            <>
              <span className="meta">Save for offline:</span>
              {SAVE_AHEAD.map((n) => (
                <button key={n} className="btn subtle" onClick={() => saveAhead(n)}>
                  Next {n}
                </button>
              ))}
              <span className="meta">
                {jobs.size > 0
                  ? `saving ${[...jobs.values()].filter((j) => !j.problem).length}…`
                  : savedHere.length > 0
                    ? `${savedHere.length} saved on this device · ${sizeText(savedBytes)}`
                    : 'or ⬇ on any chapter'}
              </span>
            </>
          ) : (
            // Cache Storage needs a secure page; the phone's https address is one.
            <span className="meta">Saving for offline works on the https address, which is the one your phone uses.</span>
          )}
        </div>
      )}

      {list.loading && <p className="empty">loading…</p>}
      {list.error && <p className="banner">Could not load: {list.error.message}</p>}
      {data?.chapters.length === 0 && (
        <p className="empty">
          The source has no chapters for this one. Try Refresh, or{' '}
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
                  {job?.problem ? ` · ${job.problem}` : ''}
                </span>
              </button>
              {offlineSupported && (
                <button
                  className={`manga-chapter-save${isSaved ? ' saved' : ''}${job?.problem ? ' failed' : ''}`}
                  aria-label={
                    isSaved ? `${c.name} is saved on this device — remove it` : job ? `Saving ${c.name}` : `Save ${c.name} for offline`
                  }
                  title={isSaved ? `Saved (${sizeText(saved[c.id]!.bytes)}) — tap to remove` : job?.problem ?? undefined}
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
