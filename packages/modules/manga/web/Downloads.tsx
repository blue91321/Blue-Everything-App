/**
 * What is saved on this device, on the Library tab.
 *
 * Per device, like the downloads themselves: the phone lists what the phone has.
 * Removing is per series here and per chapter on the chapter list, where the ✓
 * beside a saved chapter takes it off again.
 */
import { useEffect, useState } from 'react';
import { offlineSupported, removeSeries, sizeText, usage, useOffline } from './offline-store';
import { pendingCount } from './sync-queue';

export function Downloads() {
  const { manifest, jobs } = useOffline();
  const [space, setSpace] = useState<{ saved: number; quota: number | null } | null>(null);
  const all = Object.values(manifest?.series ?? {}).sort((a, b) => a.title.localeCompare(b.title));

  useEffect(() => {
    void usage().then(setSpace);
  }, [manifest]);

  // Nothing saved, nothing saving, nothing waiting to sync: nothing to say. The
  // chapter list is where saving starts, and says how.
  const waiting = pendingCount();
  if (!offlineSupported || (all.length === 0 && jobs.length === 0 && waiting === 0)) return null;

  return (
    <div className="card">
      <div className="row between">
        <h3>Saved on this device</h3>
        {space && (
          <span className="meta">
            {sizeText(space.saved)}
            {space.quota ? ` of ${sizeText(space.quota)} the browser allows` : ''}
          </span>
        )}
      </div>
      {jobs.some((j) => !j.problem) && (
        <p className="meta">Saving {jobs.filter((j) => !j.problem).length} chapter(s) — keep the app open until it finishes.</p>
      )}
      {waiting > 0 && (
        <p className="meta">
          {waiting} change{waiting === 1 ? '' : 's'} read offline still to reach the PC.
        </p>
      )}
      {all.map((s) => {
        const chapters = Object.values(s.chapters);
        const numbers = chapters.map((c) => c.number).sort((a, b) => a - b);
        return (
          <div key={s.seriesId} className="row between manga-download-row">
            <span className="manga-row-text">
              <span className="title truncate">{s.title}</span>
              <span className="meta">
                {chapters.length} chapter{chapters.length === 1 ? '' : 's'}
                {numbers.length > 0 ? ` (${numbers[0]}–${numbers[numbers.length - 1]})` : ''} ·{' '}
                {sizeText(chapters.reduce((sum, c) => sum + c.bytes, 0))} · {s.sourceName}
              </span>
            </span>
            <button
              className="btn subtle"
              onClick={() => {
                if (confirm(`Remove the ${chapters.length} saved chapter(s) of ${s.title} from this device?`)) {
                  void removeSeries(s.seriesId);
                }
              }}
            >
              Remove
            </button>
          </div>
        );
      })}
      <p className="meta">
        Readable with no connection: when the PC cannot be reached, the app offers “Read offline”. What you read there
        reaches the PC the next time this screen opens with it reachable.
      </p>
    </div>
  );
}
