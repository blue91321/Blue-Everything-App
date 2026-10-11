/**
 * Read while you wait: the chapter you asked for, being saved, in the reader's
 * own dark screen.
 *
 * The point of the mode is that the reader only ever opens a chapter that is
 * already on this device — no "Asking the source…", no pages loading one at a
 * time down the strip, no "tap to try again" halfway through. So when the next
 * chapter is not saved yet, this stands where the reader would and says how far
 * it has got, then opens it the moment it is whole.
 *
 * Drawn into `body` like the reader, so moving from the end of one chapter to
 * here and on to the next never flashes the chapter list in between.
 *
 * Two ways out, both said plainly: read it now from the PC (the ordinary
 * reader, pages arriving as they come), or stop reading ahead altogether.
 */
import { createPortal } from 'react-dom';
import { chapterText } from './judge';
import { ProgressRing, remainingText, speedText } from './ProgressRing';
import { retryDownload, sizeText, type Job } from './offline-store';

export type WaitLine = { id: string; number: number; saved: boolean; job: Job | undefined };

export function WaitForChapter({
  title,
  chapter,
  job,
  line,
  offline,
  onReadNow,
  onSave,
  onStop,
}: {
  title: string;
  chapter: { id: string; number: number; name: string };
  job: Job | undefined;
  /** The chapters after it that are being kept ready, in reading order. */
  line: WaitLine[];
  offline: boolean;
  onReadNow: () => void;
  /** Ask for it again, when nothing is saving it. */
  onSave: () => void;
  onStop: () => void;
}) {
  const now = Date.now();
  const fraction = job?.total ? job.done / job.total : null;
  const position = job?.state === 'waiting' ? 'waiting for the chapter saving before it' : null;

  let status: string;
  if (offline) status = 'Not saved yet, and the PC cannot be reached. It will carry on once it can.';
  else if (!job) status = 'Not being saved.';
  else if (job.problem) status = job.problem;
  else if (job.state === 'waiting') status = position ?? 'waiting its turn';
  else if (!job.total) status = 'Asking the PC for the page list…';
  else {
    const ms = now - (job.startedAt ?? now);
    status = [
      `${job.done} of ${job.total} pages`,
      sizeText(job.bytes),
      speedText(job.bytes, ms),
      remainingText(job.done, job.total, ms),
    ]
      .filter(Boolean)
      .join(' · ');
  }

  return createPortal(
    <div className="manga-reader manga-wait">
      <div className="card manga-wait-card" role="status" aria-live="polite">
        <div className="manga-wait-head">
          <ProgressRing
            value={fraction}
            spin={job?.state === 'saving' && !job.total}
            size={52}
            label={fraction === null ? 'waiting' : `${Math.round(fraction * 100)}%`}
          />
          <div className="manga-row-text">
            <span className="meta truncate">{title}</span>
            <span className="title">Getting chapter {chapterText(chapter.number)} ready</span>
            <span className="meta">{status}</span>
          </div>
        </div>
        <p className="meta">
          It opens by itself once every page is on this device, so it reads without stopping to load.
        </p>

        {line.length > 0 && (
          <div>
            <span className="meta">After it:</span>
            {line.map((l) => (
              <div key={l.id} className="manga-wait-line">
                {l.saved ? (
                  <span className="manga-download-mark ok" aria-hidden="true">
                    ✓
                  </span>
                ) : l.job?.problem ? (
                  <span className="manga-download-mark" aria-hidden="true">
                    !
                  </span>
                ) : (
                  <ProgressRing
                    value={l.job?.total ? l.job.done / l.job.total : null}
                    spin={l.job?.state === 'saving' && !l.job.total}
                    size={18}
                  />
                )}
                <span className="meta">
                  Chapter {chapterText(l.number)} —{' '}
                  {l.saved
                    ? 'saved'
                    : l.job?.problem
                      ? 'did not save'
                      : l.job?.state === 'saving'
                        ? 'saving'
                        : l.job
                          ? 'waiting'
                          : 'not asked for'}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="row wrap">
          {job?.problem ? (
            <button className="btn primary" disabled={offline} onClick={() => retryDownload(job.key)}>
              Try again
            </button>
          ) : !job ? (
            <button className="btn primary" disabled={offline} onClick={onSave}>
              Save it
            </button>
          ) : null}
          <button className="btn" disabled={offline} onClick={onReadNow} title="The ordinary reader: pages arrive as they come">
            Read it now from the PC
          </button>
          <button className="btn subtle" onClick={onStop}>
            Stop reading ahead
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
