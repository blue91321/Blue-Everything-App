/**
 * The Downloads tab: everything saved on this device, and what is being saved.
 *
 * Per device, like the downloads themselves — the phone's tab lists what the
 * phone has. Four things, in the order you come here for them:
 *
 *   - **Space**: how much is saved, against what the browser allows.
 *   - **In progress**: the run as a whole (chapter N of M, the bytes so far),
 *     the chapter saving now with its pages, size, speed and time left, what
 *     is waiting in the order it will be saved, anything that failed and why,
 *     and what has just finished.
 *   - **Saved**: every series, opened to its chapters — each removable on its
 *     own, the read ones together, or the whole series.
 *   - **Waiting to sync**: reading done offline that has not reached the PC.
 *
 * Saving itself starts on a series' chapter list (⬇, or Next 5), where you can
 * see which chapter is which. This tab is for looking after what you have.
 *
 * Under that, what is kept **on the PC**, the Local collection: the archive
 * ("Kept for good") and the rules that fill it, with a way to read it in
 * Browse. They were on More; keeping a series is a download too, only to
 * the PC rather than this device, so it is looked after here.
 */
import { thePc } from '@app/device';
import { useEffect, useState } from 'react';
import { useConnectivity } from '@app/offline-sync';
import { Archive, CollectionRulesCard } from './Archive';
import { Cover } from './Cover';
import {
  cancelDownload,
  cancelWaiting,
  moveToFront,
  offlineSupported,
  removeChapter,
  removeSeries,
  retryAll,
  retryDownload,
  sizeText,
  usage,
  useOffline,
  type Finished,
  type Job,
  type Progress,
  type SavedSeries,
} from './offline-store';
import { ProgressRing, remainingText, speedText } from './ProgressRing';
import { flushQueue, pendingCount } from './sync-queue';
import { syncLog, unsentCount } from './reading-log';
import { COULD_NOT_SEND, keepingNote, keepOpenNote, NOT_YET_SENT, whereKeptNote, WHILE_REACHABLE } from './device-text';
import {
  chooseFolder,
  folderSupported,
  forgetFolder,
  grant as grantFolder,
  permission as folderPermission,
  savedFolder,
  type FolderPermission,
} from './folder-store';


/**
 * Where new downloads go: the browser, or a folder you picked.
 *
 * Offered rather than made the default, and the reason is the one cost a
 * folder has that Cache Storage does not — permission can lapse, and getting
 * it back needs a tap. A library that can ask you a question before it opens
 * is not the right default for something whose whole purpose is working when
 * nothing else does.
 *
 * **Per chapter, not per library.** Switching only changes where the *next*
 * download goes; everything already saved stays readable exactly where it is,
 * because each chapter records its own destination. Moving a library between
 * the two would be a long copy with a progress bar and a way to fail halfway,
 * which is a bigger thing than this button.
 *
 * On the PC this says so and points at the archive instead: that writes real
 * folders from the server with no picker, no permission, and no need for the
 * browser to be open — offering this as well would be two answers to one
 * question, and the worse one is the one with a prompt in it.
 */
function DownloadFolder() {
  const [state, setState] = useState<FolderPermission>('none');
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  const refresh = async () => {
    setState(await folderPermission());
    setName((await savedFolder())?.name ?? null);
  };

  useEffect(() => {
    void refresh();
  }, []);

  // Safari has never shipped the picker, so an iPhone is told the plain truth
  // rather than shown a control that cannot work.
  if (!folderSupported) return null;

  const pick = async () => {
    setBusy(true);
    setProblem('');
    try {
      // Straight from the click: the picker refuses without a user gesture, in
      // exactly those words.
      if (await chooseFolder()) await refresh();
    } catch (error) {
      // Said rather than swallowed — see `chooseFolder`, where the one failure
      // that is not a failure is told apart from every other.
      setProblem(error instanceof Error ? error.message : 'the folder could not be opened');
    } finally {
      setBusy(false);
    }
  };

  return (
    <p className="meta" style={{ marginTop: 4 }}>
      {state === 'granted' && name ? (
        <>
          New downloads go into <strong>{name}</strong> — ordinary folders of numbered images, which clearing this
          browser cannot touch.{' '}
          <button className="btn subtle" disabled={busy} onClick={() => void pick()}>
            Change folder
          </button>{' '}
          <button className="btn subtle" disabled={busy} onClick={() => void forgetFolder().then(refresh)}>
            Use the browser instead
          </button>
        </>
      ) : state === 'prompt' || state === 'denied' ? (
        <>
          <strong>{name ?? 'That folder'}</strong> needs permission again before anything saved in it can be read or
          written. Browsers ask again after a while; nothing in it has been lost.{' '}
          <button className="btn subtle" disabled={busy} onClick={() => void grantFolder().then(refresh)}>
            Allow again
          </button>
        </>
      ) : (
        <>
          Downloads go into this browser&apos;s storage. You can put them in a folder of your own instead, where
          clearing the browser cannot reach them.{' '}
          <button className="btn subtle" disabled={busy} onClick={() => void pick()}>
            {busy ? 'choosing…' : 'Choose a folder…'}
          </button>
        </>
      )}
      {problem && <span className="meta warn"> {problem}</span>}
    </p>
  );
}

export function Downloads({ onRead, onBrowseKept }: { onRead: (seriesId: string) => void; onBrowseKept: () => void }) {
  const { manifest, jobs, recent, progress } = useOffline();
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

  const onThePc = <OnThePc onBrowseKept={onBrowseKept} />;

  if (!offlineSupported) {
    return (
      <div className="manga-downloads">
        <div className="card">
          <p className="empty">
            Saving to this device needs the app's https address — the one Settings → Add a device shows. This page
            isn't one, so there is nothing saved here.
          </p>
        </div>
        {onThePc}
      </div>
    );
  }

  const all = Object.values(manifest?.series ?? {}).sort((a, b) => a.title.localeCompare(b.title));
  // Manga reading only: tasks, habits and notes waiting to sync are on the
  // banner at the top of every screen, and counting them here as "changes to
  // your reading" said something untrue.
  const waiting = pendingCount() + unsentCount();

  async function syncNow() {
    setSyncNote('Sending…');
    const sent = (await flushQueue()) + (await syncLog()).sent;
    bump((n) => n + 1);
    setSyncNote(pendingCount() + unsentCount() === 0 ? `Sent ${sent}.` : COULD_NOT_SEND);
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
        {/* And where they are, which is the question that gets asked first. */}
        <p className="meta">{whereKeptNote(kept)}</p>
        <DownloadFolder />
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

      <SavingCard jobs={jobs} recent={recent} progress={progress} offline={net.offline} />

      <div className="card">
        <h3>Saved{all.length > 0 ? ` (${all.length})` : ''}</h3>
        {manifest && all.length === 0 && (
          <p className="empty">
            Nothing saved yet. Open a series from Library and press Read while you wait, ⬇ on a chapter, or Next 5,{' '}
            {WHILE_REACHABLE}.
          </p>
        )}
        {all.map((s) => (
          <SavedSeriesRow key={s.seriesId} series={s} onRead={onRead} />
        ))}
      </div>

      {onThePc}
    </div>
  );
}

/** The Local collection: kept on the PC rather than this device. */
function OnThePc({ onBrowseKept }: { onBrowseKept: () => void }) {
  return (
    <>
      <div className="card">
        <div className="row between">
          <h3>Local collection</h3>
          <button className="btn" onClick={onBrowseKept}>
            Read it in Browse
          </button>
        </div>
        <p className="meta">
          Series kept on {thePc()}, every chapter, for everyone who shares this Blue Everything. They stay readable if the
          site goes.
        </p>
      </div>
      <Archive />
      <CollectionRulesCard />
    </>
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

/** "Next", "3rd in line" — where a waiting chapter stands. */
function inLine(position: number): string {
  if (position === 1) return 'next';
  const suffix = position % 10 === 2 && position % 100 !== 12 ? 'nd' : position % 10 === 3 && position % 100 !== 13 ? 'rd' : 'th';
  return `${position}${suffix} in line`;
}

/**
 * What is being saved, said in full.
 *
 * The run first — chapter 3 of 10, a bar across all of them, the bytes so far —
 * because "is it nearly done" is what you come here to ask. Then the chapter
 * saving now, with its pages, size, speed and an estimate once there is enough
 * to make one; then the line in the order it will go, each movable to the
 * front; then failures with their reason; then what has just finished, so a
 * chapter leaving the list reads as done rather than gone.
 *
 * The waiting list is cut at a dozen with a count of the rest: "All" on a long
 * series is several hundred rows, and a list that long answers nothing.
 */
function SavingCard({
  jobs,
  recent,
  progress,
  offline,
}: {
  jobs: Job[];
  recent: Finished[];
  progress: Progress;
  offline: boolean;
}) {
  const now = Date.now();
  const saving = jobs.find((j) => j.state === 'saving') ?? null;
  const waiting = jobs.filter((j) => j.state === 'waiting');
  const broken = jobs.filter((j) => j.problem);
  const shownWaiting = waiting.slice(0, 12);
  if (!saving && waiting.length === 0 && broken.length === 0 && recent.length === 0) return null;

  const over = progress.finished + progress.failed;
  const all = over + progress.left;
  const through = saving?.total ? saving.done / saving.total : 0;
  const overall = all > 0 ? (over + through) / all : 0;
  const bytesSoFar = progress.bytes + (saving?.bytes ?? 0);

  return (
    <div className="card">
      {progress.left > 0 ? (
        <>
          <div className="row between">
            <h3>
              Saving {progress.left === 1 && over === 0 ? '1 chapter' : `chapter ${over + 1} of ${all}`}
            </h3>
            {waiting.length > 0 && (
              <button className="btn subtle" onClick={cancelWaiting} title="The chapter saving now finishes; the rest are taken off the list">
                Cancel the rest
              </button>
            )}
          </div>
          <div className="manga-space" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(overall * 100)}>
            <div style={{ width: `${(overall * 100).toFixed(1)}%` }} />
          </div>
          <p className="meta">
            {Math.round(overall * 100)}% · {sizeText(bytesSoFar)} so far
            {progress.finished > 0 ? ` · ${progress.finished} done` : ''}
            {progress.failed > 0 ? ` · ${progress.failed} did not save` : ''}
            {waiting.length > 0 ? ` · ${waiting.length} waiting` : ''}
          </p>
          <p className="meta">{keepOpenNote()}</p>
        </>
      ) : (
        <h3>{broken.length > 0 ? 'Not saved' : 'Just saved'}</h3>
      )}

      {saving && (
        <div className="manga-download-job now">
          <ProgressRing
            value={saving.total ? saving.done / saving.total : null}
            spin={!saving.total}
            size={36}
            label={saving.total ? `${Math.round((saving.done / saving.total) * 100)}%` : 'starting'}
          />
          <div className="manga-row-text">
            <span className="title truncate">
              {saving.seriesTitle} — {saving.name}
            </span>
            <span className="meta">
              {saving.total
                ? [
                    `Saving now · ${saving.done} of ${saving.total} pages`,
                    sizeText(saving.bytes),
                    speedText(saving.bytes, now - (saving.startedAt ?? now)),
                    remainingText(saving.done, saving.total, now - (saving.startedAt ?? now)),
                    saving.missing > 0 ? `${saving.missing} would not come — it will say which at the end` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : `Asking ${thePc()} for the page list…`}
            </span>
            {saving.cancelled && <span className="meta">Stopping after the pages already on their way…</span>}
          </div>
          <div className="manga-row-actions">
            <button className="btn subtle" disabled={saving.cancelled} onClick={() => cancelDownload(saving.key)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {shownWaiting.map((j, i) => (
        <div key={j.key} className="manga-download-job">
          <ProgressRing value={null} size={22} label="waiting" />
          <div className="manga-row-text">
            <span className="title truncate">
              {j.seriesTitle} — {j.name}
            </span>
            <span className="meta">{inLine(i + 1)}</span>
          </div>
          <div className="manga-row-actions">
            {i > 0 && (
              <button className="btn subtle" onClick={() => moveToFront([j.key])} title="Save this one next">
                Next
              </button>
            )}
            <button className="btn subtle" onClick={() => cancelDownload(j.key)}>
              Cancel
            </button>
          </div>
        </div>
      ))}
      {waiting.length > shownWaiting.length && (
        <p className="meta">and {waiting.length - shownWaiting.length} more after these</p>
      )}

      {broken.length > 0 && (
        <>
          {broken.length > 1 && (
            <div className="row between">
              <span className="meta">{broken.length} could not be saved</span>
              <button className="btn subtle" disabled={offline} onClick={retryAll}>
                Retry all
              </button>
            </div>
          )}
          {broken.map((j) => (
            <div key={j.key} className="manga-download-job failed">
              <span className="manga-download-mark" aria-hidden="true">
                !
              </span>
              <div className="manga-row-text">
                <span className="title truncate">
                  {j.seriesTitle} — {j.name}
                </span>
                <span className="meta">{j.problem}</span>
              </div>
              <div className="manga-row-actions">
                <button className="btn" disabled={offline} onClick={() => retryDownload(j.key)}>
                  Retry
                </button>
                <button className="btn subtle" onClick={() => cancelDownload(j.key)}>
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      {recent.length > 0 && (
        <details className="manga-download-recent" open={progress.left === 0 && broken.length === 0}>
          <summary className="meta">Saved this visit ({recent.length})</summary>
          {recent.map((f) => (
            <div key={`${f.key}:${f.at}`} className="manga-download-job">
              <span className="manga-download-mark ok" aria-hidden="true">
                ✓
              </span>
              <div className="manga-row-text">
                <span className="title truncate">
                  {f.seriesTitle} — {f.name}
                </span>
                <span className="meta">
                  {f.pages} pages · {sizeText(f.bytes)} · took {Math.max(1, Math.round(f.ms / 1000))}s ·{' '}
                  {new Date(f.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                </span>
              </div>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
