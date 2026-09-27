/**
 * The Downloads tab: everything saved on this device, and what is being saved.
 *
 * Per device, like the downloads themselves — the phone's tab lists what the
 * phone has. Four things, in the order you come here for them:
 *
 *   - **Space**: how much is saved, against what the browser allows.
 *   - **In progress**: each download with its pages so far, to cancel; and any
 *     that failed, with why, to retry.
 *   - **Saved**: every series, opened to its chapters — each removable on its
 *     own, the read ones together, or the whole series.
 *   - **Waiting to sync**: reading done offline that has not reached the PC.
 *
 * Saving itself starts on a series' chapter list (⬇, or Next 5), where you can
 * see which chapter is which. This tab is for looking after what you have.
 */
import { useEffect, useState } from 'react';
import { useConnectivity } from '@app/offline-sync';
import { Cover } from './Cover';
import {
  cancelDownload,
  offlineSupported,
  removeChapter,
  removeSeries,
  retryDownload,
  sizeText,
  usage,
  useOffline,
  type SavedSeries,
} from './offline-store';
import { flushQueue, pendingCount } from './sync-queue';
import { COULD_NOT_SEND, keepingNote, keepOpenNote, NOT_YET_SENT, WHILE_REACHABLE } from './device-text';

export function Downloads({ onRead }: { onRead: (seriesId: string) => void }) {
  const { manifest, jobs } = useOffline();
  const net = useConnectivity();
  const [space, setSpace] = useState<{ saved: number; quota: number | null } | null>(null);
  const [kept, setKept] = useState<boolean | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [, bump] = useState(0);

  useEffect(() => {
    void usage().then(setSpace);
  }, [manifest]);

  useEffect(() => {
    // Whether the browser has promised not to clear this under storage pressure.
    void navigator.storage?.persisted?.().then(setKept, () => setKept(null));
  }, [manifest]);

  if (!offlineSupported) {
    return (
      <div className="card">
        <p className="empty">
          Saving for offline needs the app's https address — the one Settings → Add a device shows. This page isn't
          one, so there is nothing to manage here.
        </p>
      </div>
    );
  }

  const all = Object.values(manifest?.series ?? {}).sort((a, b) => a.title.localeCompare(b.title));
  const running = jobs.filter((j) => !j.problem);
  const broken = jobs.filter((j) => j.problem);
  // Manga reading only: tasks, habits and notes waiting to sync are on the
  // banner at the top of every screen, and counting them here as "changes to
  // your reading" said something untrue.
  const waiting = pendingCount();

  async function syncNow() {
    setSyncNote('Sending…');
    const sent = await flushQueue();
    bump((n) => n + 1);
    setSyncNote(pendingCount() === 0 ? `Sent ${sent}.` : COULD_NOT_SEND);
  }

  return (
    <div className="manga-downloads">
      <div className="card">
        <div className="row between">
          <h3>On this device</h3>
          {space && (
            <span className="meta">
              {sizeText(space.saved)}
              {space.quota ? ` of ${sizeText(space.quota)} the browser allows` : ''}
            </span>
          )}
        </div>
        {space && space.quota ? (
          <div className="manga-space" aria-hidden="true">
            <div style={{ width: `${Math.min(100, (space.saved / space.quota) * 100).toFixed(2)}%` }} />
          </div>
        ) : null}
        {/* What can happen to these depends on the device — see `device-text.ts`. */}
        <p className="meta">{keepingNote(kept)}</p>
        {waiting > 0 && (
          <p className="meta">
            {waiting} change{waiting === 1 ? '' : 's'} to your reading made offline, {NOT_YET_SENT}.{' '}
            <button className="btn subtle" onClick={() => void syncNow()}>
              Sync now
            </button>{' '}
            {syncNote}
          </p>
        )}
      </div>

      {(running.length > 0 || broken.length > 0) && (
        <div className="card">
          <h3>{running.length > 0 ? `Saving ${running.length}` : 'Not saved'}</h3>
          {running.length > 0 && <p className="meta">{keepOpenNote()}</p>}
          {[...running, ...broken].map((j) => (
            <div key={j.key} className="manga-download-job">
              <div className="manga-row-text">
                <span className="title truncate">
                  {j.seriesTitle} — {j.name}
                </span>
                {j.problem ? (
                  <span className="meta">{j.problem}</span>
                ) : (
                  <span className="meta">{j.total ? `${j.done} of ${j.total} pages` : 'waiting…'}</span>
                )}
                {!j.problem && j.total ? (
                  <div className="manga-space" aria-hidden="true">
                    <div style={{ width: `${((j.done / j.total) * 100).toFixed(1)}%` }} />
                  </div>
                ) : null}
              </div>
              <div className="manga-row-actions">
                {j.problem && (
                  <button className="btn" disabled={net.offline} onClick={() => retryDownload(j.key)}>
                    Retry
                  </button>
                )}
                <button className="btn subtle" onClick={() => cancelDownload(j.key)}>
                  {j.problem ? 'Dismiss' : 'Cancel'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h3>Saved{all.length > 0 ? ` (${all.length})` : ''}</h3>
        {manifest && all.length === 0 && (
          <p className="empty">
            Nothing saved yet. Open a series from Library and press ⬇ on a chapter, or Next 5, {WHILE_REACHABLE}.
          </p>
        )}
        {all.map((s) => (
          <SavedSeriesRow key={s.seriesId} series={s} onRead={onRead} />
        ))}
      </div>
    </div>
  );
}

function SavedSeriesRow({ series, onRead }: { series: SavedSeries; onRead: (seriesId: string) => void }) {
  const chapters = Object.values(series.chapters).sort((a, b) => b.number - a.number);
  const read = new Set(series.readChapters);
  const readSaved = chapters.filter((c) => read.has(c.number));
  const bytes = chapters.reduce((sum, c) => sum + c.bytes, 0);
  const readBytes = readSaved.reduce((sum, c) => sum + c.bytes, 0);

  return (
    <details className="manga-download-series">
      <summary>
        <Cover path={series.coverPath} title={series.title} size={36} />
        <span className="manga-row-text">
          <span className="title truncate">{series.title}</span>
          <span className="meta">
            {chapters.length} chapter{chapters.length === 1 ? '' : 's'} · {sizeText(bytes)}
            {readSaved.length > 0 ? ` · ${readSaved.length} already read` : ''} · {series.sourceName}
          </span>
        </span>
      </summary>

      <div className="manga-download-actions">
        <button className="btn primary" onClick={() => onRead(series.seriesId)}>
          Open
        </button>
        {readSaved.length > 0 && (
          <button
            className="btn"
            onClick={() => {
              for (const c of readSaved) void removeChapter(series.seriesId, c.chapterId);
            }}
          >
            Remove the {readSaved.length} read ({sizeText(readBytes)})
          </button>
        )}
        <button
          className="btn danger"
          onClick={() => {
            if (confirm(`Remove all ${chapters.length} saved chapter(s) of ${series.title} from this device?`)) {
              void removeSeries(series.seriesId);
            }
          }}
        >
          Remove all
        </button>
      </div>

      {chapters.map((c) => {
        const here = series.position?.chapterId === c.chapterId ? series.position : null;
        return (
          <div
            key={c.chapterId}
            className={`manga-chapter-row${read.has(c.number) ? ' read' : ''}${here ? ' started' : ''}`}
          >
            <span className="manga-chapter-open">
              <span className="title truncate">{c.name}</span>
              <span className="meta">
                {sizeText(c.bytes)} · saved {new Date(c.at).toLocaleDateString()}
                {here ? ` · page ${here.page + 1} of ${here.pages}` : ''}
                {read.has(c.number) ? ' · read' : ''}
              </span>
            </span>
            <button
              className="manga-chapter-save saved"
              aria-label={`Remove ${c.name} from this device`}
              title="Remove from this device"
              onClick={() => void removeChapter(series.seriesId, c.chapterId)}
            >
              ✕
            </button>
          </div>
        );
      })}
    </details>
  );
}
