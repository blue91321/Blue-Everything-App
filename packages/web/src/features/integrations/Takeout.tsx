/**
 * Importing a YouTube watch history from a Google Takeout export.
 *
 * **Two-phase, and the preview is not a formality.** A Takeout archive contains
 * several files that look alike — search history, comment history, YouTube Music
 * — and picking the wrong one produces a plausible number of plausible-looking
 * rows. So the first pass reads the file, reports what it found and the window
 * it covers, and writes nothing. You confirm against dates you recognise.
 *
 * The file is read in the browser and posted as a string. A year of YouTube is
 * tens of megabytes, which is fine over loopback and is why this is local-only.
 */
import { useState } from 'react';
import { api, type TakeoutResult } from '../../api';

export function TakeoutImport({ onDone }: { onDone: () => void }) {
  const [result, setResult] = useState<TakeoutResult | null>(null);
  const [json, setJson] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  const preview = async (file: File) => {
    setBusy(true);
    setProblem('');
    setResult(null);
    try {
      const text = await file.text();
      setJson(text);
      setResult(await api.integrations.takeout(text, false));
    } catch (error) {
      setProblem((error as Error).message);
      setJson('');
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    setBusy(true);
    try {
      setResult(await api.integrations.takeout(json, true));
      // The parsed copy is dropped as soon as it is written. Nothing here is
      // secret, but holding tens of megabytes in component state after it has
      // served its purpose is pure waste.
      setJson('');
      onDone();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const dates = (from: number | null, to: number | null) =>
    from && to
      ? `${new Date(from).toLocaleDateString()} – ${new Date(to).toLocaleDateString()}`
      : 'no dated entries';

  return (
    <details style={{ marginTop: '.75rem' }}>
      <summary>Import watch history from Google Takeout</summary>

      <ol className="meta" style={{ marginTop: '.5rem', paddingLeft: '1.2rem' }}>
        <li>
          At <code>takeout.google.com</code>, deselect everything and choose YouTube.
        </li>
        <li>
          In "All YouTube data included", keep only <strong>history</strong>.
        </li>
        <li>
          In "Multiple formats", set history to <strong>JSON</strong>. The HTML export cannot be read
          reliably and will be refused.
        </li>
        <li>
          Export, then pick <code>watch-history.json</code> below.
        </li>
      </ol>

      <input
        type="file"
        accept="application/json,.json"
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void preview(file);
        }}
      />

      {busy && <div className="meta" style={{ marginTop: '.5rem' }}>Reading…</div>}
      {problem && <div className="banner" style={{ marginTop: '.5rem' }}>{problem}</div>}

      {result && (
        <div className="card" style={{ marginTop: '.75rem' }}>
          {result.committed ? (
            <>
              <div className="title">Imported</div>
              <div className="meta">
                {result.added} new plays, {result.videos} videos the library had not seen before.
              </div>
              <div className="meta" style={{ marginTop: '.4rem' }}>
                Importing the same file again is safe — plays already recorded are skipped.
              </div>
            </>
          ) : (
            <>
              <div className="title">
                {result.summary.usable.toLocaleString()} plays, {dates(result.summary.earliest, result.summary.latest)}
              </div>
              <div className="meta" style={{ marginTop: '.4rem' }}>
                {result.summary.total.toLocaleString()} entries in the file. Skipped:{' '}
                {result.summary.skipped.noVideo} removed or private, {result.summary.skipped.ads} adverts,{' '}
                {result.summary.skipped.otherProduct} from another Google product,{' '}
                {result.summary.skipped.noTime} with no timestamp.
              </div>

              {/* Titles you recognise are the actual check. The counts above
                  look equally reasonable for the wrong file. */}
              {result.summary.sample.length > 0 && (
                <div className="meta" style={{ marginTop: '.4rem' }}>
                  Starts with: {result.summary.sample.join('; ')}
                </div>
              )}

              {result.summary.usable === 0 ? (
                <div className="banner" style={{ marginTop: '.5rem' }}>
                  Nothing usable in that file. If the counts above are mostly "another Google product",
                  this is the YouTube Music history rather than the video one.
                </div>
              ) : (
                <button className="btn primary" style={{ marginTop: '.6rem' }} disabled={busy} onClick={commit}>
                  Import these {result.summary.usable.toLocaleString()} plays
                </button>
              )}
            </>
          )}
        </div>
      )}
    </details>
  );
}
