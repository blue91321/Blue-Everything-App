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
 */
import { useState } from 'react';
import { useAsync } from '@app/useAsync';
import { manga, type SourceChapter } from './manga-api';
import { Reader } from './Reader';

export function Chapters({
  seriesId,
  onClose,
  onCompare,
}: {
  seriesId: string;
  onClose: () => void;
  /** Open the same series across every source — where you go when a chapter here is broken. */
  onCompare: () => void;
}) {
  const list = useAsync(() => manga.reader.chapters(seriesId), [seriesId]);
  const [open, setOpen] = useState<SourceChapter | null>(null);
  const [busy, setBusy] = useState(false);

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
    await manga.reader.markRead(seriesId, chapterNumber);
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
    setOpen(next ?? null);
  }

  if (open) {
    return (
      <Reader
        seriesId={seriesId}
        chapter={open}
        onClose={() => setOpen(null)}
        onFinished={(n) => void finished(n)}
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
          {list.data ? `${list.data.seriesTitle} · ${list.data.sourceName}` : 'loading…'}
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

      {list.loading && <p className="empty">loading…</p>}
      {list.error && <p className="banner">Could not load: {list.error.message}</p>}
      {list.data?.chapters.length === 0 && (
        <p className="empty">
          The source has no chapters for this one. Try Refresh, or{' '}
          <button className="btn subtle" onClick={onCompare}>
            see it on other sources
          </button>
          .
        </p>
      )}

      <div className="manga-chapters">
        {list.data?.chapters.map((c) => (
          <button
            key={c.id}
            className={c.read ? 'manga-chapter-row read' : 'manga-chapter-row'}
            onClick={() => setOpen(c)}
          >
            <span className="title truncate">{c.name}</span>
            <span className="meta">
              {c.scanlator ? `${c.scanlator} · ` : ''}
              {c.uploadedAt ? new Date(c.uploadedAt).toLocaleDateString() : ''}
              {c.read ? ' · read' : ''}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
