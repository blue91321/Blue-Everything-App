/**
 * Reading what is saved on this device, with no server at all.
 *
 * Reached from the "isn't running" screen, which core draws and which finds
 * this through the features index without naming it. Everything here comes
 * from the saved manifest and the saved pages: the reader is the ordinary one,
 * and it reads saved chapters from this device because `manga.reader` looks
 * there first.
 *
 * What you read here is queued — a chapter finished, the place you stopped —
 * and sent the next time the Manga screen opens with the PC reachable. This
 * device's copy is updated at once, so the rows light up now rather than then.
 */
import { useRef, useState } from 'react';
import type { OfflineViewProps } from '@app/features/index';
import { Cover } from './Cover';
import { Reader } from './Reader';
import { chapterText } from './judge';
import { manga } from './manga-api';
import { sizeText, updateSnapshot, useOffline, type SavedChapter, type SavedSeries } from './offline-store';
import { enqueue, pendingCount } from './sync-queue';
import { usePositionSaver } from './usePositionSaver';
import { NEEDS, NOT_YET_SENT, WHILE_REACHABLE } from './device-text';

export default function MangaOffline({ onClose }: OfflineViewProps) {
  const { manifest } = useOffline();
  const [seriesId, setSeriesId] = useState<string | null>(null);

  const all = Object.values(manifest?.series ?? {}).sort((a, b) => a.title.localeCompare(b.title));
  const series = seriesId ? manifest?.series[seriesId] ?? null : null;

  if (series) return <OfflineSeries series={series} onBack={() => setSeriesId(null)} />;

  const waiting = pendingCount();
  return (
    <div className="card">
      <div className="row between">
        <button className="btn subtle" onClick={onClose}>
          ‹ Back
        </button>
        <span className="meta">Saved on this device</span>
      </div>
      {waiting > 0 && (
        <p className="meta">
          {waiting} change{waiting === 1 ? '' : 's'} to your reading, {NOT_YET_SENT} — sent the next time the Manga
          screen opens {WHILE_REACHABLE}.
        </p>
      )}
      {!manifest && <p className="empty">Looking…</p>}
      {manifest && all.length === 0 && (
        <p className="empty">
          Nothing saved yet. Open a series {WHILE_REACHABLE} and press ⬇ on a chapter — or “Next 5” — to keep it on
          this device.
        </p>
      )}
      {all.map((s) => {
        const chapters = Object.values(s.chapters);
        const bytes = chapters.reduce((sum, c) => sum + c.bytes, 0);
        return (
          <button key={s.seriesId} className="manga-row manga-offline-series" onClick={() => setSeriesId(s.seriesId)}>
            <Cover path={s.coverPath} title={s.title} size={40} />
            <span className="manga-row-text">
              <span className="title truncate">{s.title}</span>
              <span className="meta">
                {chapters.length} chapter{chapters.length === 1 ? '' : 's'} · {sizeText(bytes)} · {s.sourceName}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function OfflineSeries({ series, onBack }: { series: SavedSeries; onBack: () => void }) {
  const [open, setOpen] = useState<SavedChapter | null>(null);
  const [resume, setResume] = useState<{ page: number; offset: number } | null>(null);
  const saver = usePositionSaver(series.seriesId);
  const lastPlace = useRef<SavedSeries['position']>(null);

  const chapters = Object.values(series.chapters).sort((a, b) => b.number - a.number);
  const read = new Set(series.readChapters);
  const place = series.position;
  const placeChapter = place ? series.chapters[place.chapterId] ?? null : null;

  function start(chapter: SavedChapter) {
    const here = place?.chapterId === chapter.chapterId ? place : null;
    setResume(here ? { page: here.page, offset: here.offset } : null);
    setOpen(chapter);
  }

  if (open) {
    return (
      <Reader
        seriesId={series.seriesId}
        chapter={{ id: open.chapterId, number: open.number, name: open.name }}
        resume={resume}
        onClose={() => {
          saver.flush();
          if (lastPlace.current) void updateSnapshot(series.seriesId, { position: lastPlace.current });
          lastPlace.current = null;
          setResume(null);
          setOpen(null);
        }}
        onPosition={(p) => {
          const where = { chapter: open.number, chapterId: open.chapterId, chapterName: open.name, ...p };
          lastPlace.current = { ...where, at: Date.now() };
          saver.note(where);
        }}
        onFinished={async (n) => {
          saver.flush();
          lastPlace.current = null;
          try {
            await manga.reader.markRead(series.seriesId, n);
          } catch {
            enqueue({ kind: 'read', seriesId: series.seriesId, chapter: n, at: Date.now() });
          }
          // As the server will: finishing it, or a later one, settles the place.
          await updateSnapshot(series.seriesId, { read: n, ...(place && place.chapter <= n ? { position: null } : {}) });
          // The next saved one up — only what is on this device can be opened here.
          const next = chapters.filter((c) => c.number > n).sort((a, b) => a.number - b.number)[0];
          setResume(null);
          setOpen(next ?? null);
        }}
      />
    );
  }

  return (
    <div className="card">
      <div className="row between">
        <button className="btn subtle" onClick={onBack}>
          ‹ Saved
        </button>
        <span className="meta">
          {series.title} · {series.sourceName}
        </span>
      </div>

      {place && placeChapter && (
        <div className="manga-continue">
          <div className="manga-row-text">
            <span className="title">Continue {place.chapterName}</span>
            <span className="meta">
              page {place.page + 1} of {place.pages}
            </span>
          </div>
          <button className="btn primary" onClick={() => start(placeChapter)}>
            Continue
          </button>
        </div>
      )}

      <div className="manga-chapters">
        {chapters.map((c) => {
          const here = place?.chapterId === c.chapterId ? place : null;
          return (
            <button
              key={c.chapterId}
              className={`manga-chapter-row${read.has(c.number) ? ' read' : ''}${here ? ' started' : ''}`}
              onClick={() => start(c)}
            >
              <span className="title truncate">{c.name}</span>
              <span className="meta">
                {sizeText(c.bytes)}
                {here ? ` · page ${here.page + 1} of ${here.pages}` : ''}
                {read.has(c.number) ? ' · read' : ''}
              </span>
            </button>
          );
        })}
      </div>
      {chapters.length > 0 && (
        <p className="meta">
          {chapters.length} chapter{chapters.length === 1 ? '' : 's'} saved here, up to chapter{' '}
          {chapterText(chapters[0]!.number)}. Anything else {NEEDS}.
        </p>
      )}
    </div>
  );
}
