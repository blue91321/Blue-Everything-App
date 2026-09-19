/**
 * Pointing one series at somewhere it can actually be read.
 *
 * Declared at the top level, not inside the row that renders it. A component
 * defined during render is a *new type* on every render, so React unmounts and
 * remounts it — taking whatever was typed in the search box with it. That is
 * written down in this project as a bug that already shipped once, in the habit
 * stepper, and it survived testing there only by luck.
 *
 * The matches are **proposed, never applied**. Source titles and MangaDex titles
 * disagree constantly — romaji against English, a season split one way on one
 * and not the other — and a wrong link silently reports one series' chapter
 * count for another. That is the same reasoning the friend linker uses, and the
 * same answer: suggest, and let a person click.
 */
import { useState } from 'react';
import { manga, type SeriesSummary, type SourceMatch } from './manga-api';

export function SourceLink({
  series,
  local,
  onChanged,
}: {
  series: SeriesSummary;
  local: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<SourceMatch[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [query, setQuery] = useState(series.title);

  async function find(q: string) {
    setBusy(true);
    setProblem(null);
    try {
      setResults((await manga.source.search(series.id, q)).results);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'the search failed');
      setResults(null);
    } finally {
      setBusy(false);
    }
  }

  async function link(match: SourceMatch) {
    setBusy(true);
    setProblem(null);
    try {
      await manga.source.link(series.id, match);
      setOpen(false);
      setResults(null);
      onChanged();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'could not link that');
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    setBusy(true);
    try {
      await manga.source.unlink(series.id);
      onChanged();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'could not unlink');
    } finally {
      setBusy(false);
    }
  }

  if (series.source) {
    return (
      <span className="manga-source">
        <span className="meta">Reading from {series.source.sourceName}</span>
        {local && (
          <button className="btn subtle" disabled={busy} onClick={unlink}>
            Unlink
          </button>
        )}
        {problem && <span className="meta urgent">{problem}</span>}
      </span>
    );
  }

  if (!open) {
    // Hidden entirely away from the PC rather than disabled: linking is refused
    // there, and a dead button is a worse answer than no button.
    if (!local) return null;
    return (
      <button
        className="btn subtle"
        onClick={() => {
          setOpen(true);
          void find(series.title);
        }}
      >
        Find a source
      </button>
    );
  }

  return (
    <div className="manga-source-picker">
      <div className="row">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={`Search sources for ${series.title}`}
        />
        <button className="btn" disabled={busy} onClick={() => void find(query)}>
          {busy ? 'Searching…' : 'Search'}
        </button>
        <button className="btn subtle" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>

      {problem && <p className="banner">{problem}</p>}

      {results !== null && results.length === 0 && (
        <p className="meta">Nothing matched. Try a shorter title, or the name the source uses.</p>
      )}

      {results?.map((match) => (
        <button key={`${match.sourceName}:${match.id}`} className="manga-source-row" disabled={busy} onClick={() => link(match)}>
          <span className="title truncate">{match.title}</span>
          <span className="meta">{match.sourceName}</span>
        </button>
      ))}
    </div>
  );
}
