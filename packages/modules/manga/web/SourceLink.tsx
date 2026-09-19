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
 * count for another. Same reasoning as the friend linker, same answer: suggest,
 * and let a person click.
 *
 * ### The counts are the point, and they arrive late
 *
 * Two sources carrying the same title are not equivalent. MangaFire's Spanish
 * source has *none* of Archmage Curriculum while its English one has 45, and
 * before this the only way to find that out was to link it and watch the row go
 * quiet. So each candidate shows how many chapters it actually has.
 *
 * They cannot come with the search: Suwayomi stores a manga record but no
 * chapters, so every count is a fresh scrape of that series. Asking for all of
 * them up front would turn a third of a second into the better part of a minute.
 * So the list arrives ranked and immediately, and the counts fill in behind it —
 * a few at a time, best matches first, because those are the ones you are
 * choosing between.
 */
import { useState } from 'react';
import { manga, type SeriesSummary, type SourceMatch } from './manga-api';

/** How many candidates get a count. Each one is a scrape of somebody else's site. */
const COUNTED = 8;

/** Gentle: these are real page loads on a real server. */
const AT_ONCE = 2;

type Counted = SourceMatch & { chapters?: number | null; latest?: number | null; counting?: boolean };

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
  const [results, setResults] = useState<Counted[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [query, setQuery] = useState(series.title);

  async function find(q: string) {
    setBusy(true);
    setProblem(null);
    setResults(null);
    try {
      const { results: found } = await manga.source.search(series.id, q);
      setResults(found);
      void countThem(found);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'the search failed');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Fill in the chapter counts, best matches first.
   *
   * Results are already ranked by the server, so taking the first `COUNTED` is
   * taking the ones worth choosing between — not an arbitrary slice.
   */
  async function countThem(found: SourceMatch[]) {
    const todo = found.slice(0, COUNTED);
    setResults((current) =>
      (current ?? []).map((r, i) => (i < todo.length ? { ...r, counting: true } : r))
    );

    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const index = next++;
        const match = todo[index];
        let counted: Partial<Counted>;
        try {
          const { chapters, latest } = await manga.source.count(series.id, match.id);
          counted = { chapters, latest, counting: false };
        } catch {
          // One candidate failing must not stall the rest, and a missing count
          // is shown as unknown rather than as zero — "we could not ask" and
          // "it has none" are different answers and only one rules it out.
          counted = { chapters: null, counting: false };
        }
        setResults((current) =>
          (current ?? []).map((r) => (r.id === match.id && r.sourceName === match.sourceName ? { ...r, ...counted } : r))
        );
      }
    };
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, todo.length) }, worker));
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
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void find(query);
        }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={`Search sources for ${series.title}`}
        />
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Searching…' : 'Search'}
        </button>
        <button className="btn subtle" type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </form>

      {problem && <p className="banner">{problem}</p>}
      {busy && !results && <p className="empty">Asking every installed source…</p>}
      {results?.length === 0 && (
        <p className="meta">Nothing matched. Try a shorter title, or the name the source uses.</p>
      )}

      {results && results.length > 0 && (
        <p className="meta">
          Best matches first. Chapter counts are fetched from each site, so the first few fill in as they arrive.
        </p>
      )}

      {results?.map((match) => (
        <button
          key={`${match.sourceName}:${match.id}`}
          className="manga-source-row"
          disabled={busy}
          onClick={() => link(match)}
        >
          <span className="title truncate">{match.title}</span>
          <span className="manga-source-meta">
            <span className="meta">{match.sourceName}</span>
            {/*
              * Three states, and they are not the same. Counting is in progress;
              * zero is an answer that rules this source out; unknown means we
              * could not ask, which does not.
              */}
            {match.counting ? (
              <span className="meta">counting…</span>
            ) : match.chapters === undefined ? null : match.chapters === null ? (
              <span className="meta">count unknown</span>
            ) : match.chapters === 0 ? (
              <span className="meta urgent">no chapters</span>
            ) : (
              <span className="meta strong">
                {match.chapters} ch{match.latest ? ` · to ${match.latest}` : ''}
              </span>
            )}
          </span>
        </button>
      ))}
    </div>
  );
}
