/**
 * Where a series is read from, and the way into choosing somewhere else.
 *
 * This was the whole source picker — search, counts and linking crammed into the
 * row — and is now two buttons, because choosing a source became a screen of
 * its own: `Compare`, which is also reachable from the chapter list, and which
 * does what the old reader's "related" view did.
 *
 * **Shown on the phone too**, which it was not. Linking was held to the PC on
 * the reasoning that governs the source *address*; linking reaches nothing that
 * address does not already name, so the gate was solving a problem it does not
 * have — and it meant seeing from the sofa that a source had broken pages and
 * being unable to switch.
 */
import { useState } from 'react';
import { manga, type SeriesSummary } from './manga-api';

export function SourceLink({
  series,
  onCompare,
  onChanged,
}: {
  series: SeriesSummary;
  onCompare: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function unlink() {
    setBusy(true);
    setProblem(null);
    try {
      await manga.source.unlink(series.id);
      onChanged();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'could not unlink');
    } finally {
      setBusy(false);
    }
  }

  if (!series.source) {
    return (
      <button className="btn subtle" onClick={onCompare}>
        Find a source
      </button>
    );
  }

  return (
    <span className="manga-source">
      <span className="meta">Reading from {series.source.sourceName}</span>
      <button className="btn subtle" onClick={onCompare}>
        Other sources
      </button>
      <button className="btn subtle" disabled={busy} onClick={() => void unlink()}>
        Unlink
      </button>
      {problem && <span className="meta urgent">{problem}</span>}
    </span>
  );
}
