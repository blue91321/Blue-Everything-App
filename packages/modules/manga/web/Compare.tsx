/**
 * One series across every source you have installed.
 *
 * The view the old reader called "related": the same title side by side, used
 * to find a source that is further ahead, one whose pages are broken, and one
 * listing chapters it does not have. The first is a comparison of numbers; the
 * other two are why this screen does more than show numbers.
 *
 * ### Reachable from anywhere a source matters
 *
 * From a series row — linked or not — and from the chapter list, which is where
 * you are when a chapter turns out to be broken and you want it from somewhere
 * else. Switching keeps your place: read state is stored as chapter *numbers*,
 * not as one source's ids, which was decided for exactly this.
 *
 * ### Same title, and other titles
 *
 * Results that match the title are compared against each other. Results that do
 * not — a source calling it something else entirely — are listed below and left
 * out of the comparison, because one might be the same series under another
 * name and might be a different series altogether, and folding an unrelated
 * series' chapter count into "which source is furthest" would be exactly the
 * confident wrongness this screen exists to catch.
 *
 * ### Counts arrive late, checks only when asked
 *
 * Each count is a scrape of that series on that site, so the list arrives ranked
 * and immediately and the counts fill in behind it. Checking pages costs more
 * again — a page list and three images — so it is a button per source, for the
 * one that looks too good rather than for all of them.
 */
import { useEffect, useState } from 'react';
import {
  manga,
  type ChapterProfile,
  type PageCheck,
  type SeriesSummary,
  type SourceMatch,
  type SourceReview,
  type SourceSearch,
} from './manga-api';
import { chapterText, judgeSources, languageName, orderSources, type Flag, type SourceRow } from './judge';

/** At or above this, a result's title is the title searched for. See `titleScore`. */
const SAME_TITLE = 60;

/** Each count is a real page load on somebody else's server. */
const COUNTED = 16;
const AT_ONCE = 2;

type Row = SourceMatch & {
  profile?: ChapterProfile;
  counting?: boolean;
  countFailed?: boolean;
  check?: PageCheck;
  checking?: boolean;
};

const keyOf = (m: { sourceName: string; id: string }) => `${m.sourceName}:${m.id}`;

/** A server from before scoring sends none; every result is then treated as the same title. */
const isSameTitle = (r: Row) => r.score === undefined || r.score >= SAME_TITLE;

/** Counted, and has nothing — not merely still counting, and not a count that failed. */
const isEmpty = (r: Row) => r.profile !== undefined && !r.counting && r.profile.latest === null;

/**
 * Sources with no chapters go to the bottom; everything else keeps its ranking.
 *
 * The ranking is by how well the title matched, so an exact title with nothing
 * behind it sat at the top, above the sources you could actually read from.
 * Sorting at render rather than when the count lands means a row moves once,
 * when its answer arrives. `sort` is stable, so the rest stay in order.
 *
 * A failed count stays where it is. "We could not ask" is not "it has none",
 * and sinking it would read as the second.
 */
const sinkEmpty = (list: Row[]) => [...list].sort((a, b) => Number(isEmpty(a)) - Number(isEmpty(b)));

function toSourceRow(r: Row, reviews: readonly SourceReview[]): SourceRow {
  const review = reviews.find((v) => v.key === keyOf(r));
  return {
    review: review ? { verdict: review.verdict, upTo: review.upTo } : null,
    key: keyOf(r),
    sourceName: r.sourceName,
    lang: r.lang ?? null,
    latest: r.profile?.latest ?? null,
    distinct: r.profile?.distinct ?? 0,
    missing: r.profile?.missing ?? 0,
    missingSample: r.profile?.missingSample ?? [],
    newestUpload: r.profile?.newestUpload ?? null,
    failed: r.countFailed === true,
    // A count that failed is left out rather than read as zero — "we could not
    // ask" and "it has none" are different answers, and only one rules it out.
    counted: r.profile !== undefined && !r.counting,
  };
}

const GLYPH: Record<Flag['tone'], string> = { good: '✓', warn: '!', bad: '✕', info: '' };

function Flags({ flags }: { flags: Flag[] | undefined }) {
  if (!flags?.length) return null;
  return (
    <span className="manga-flags">
      {flags.map((f) => (
        // The glyph carries the tone as well as the colour, so it still reads
        // for anybody who cannot tell the green from the red.
        <span key={f.text} className={`manga-flag ${f.tone}`}>
          {GLYPH[f.tone] && <span aria-hidden="true">{GLYPH[f.tone]} </span>}
          {f.text}
        </span>
      ))}
    </span>
  );
}

function Stats({ row }: { row: Row }) {
  if (row.counting) return <span className="meta">counting…</span>;
  if (row.countFailed) return <span className="meta">count unknown</span>;
  const p = row.profile;
  if (!p) return null;
  if (p.latest === null) return <span className="meta urgent">no chapters</span>;
  return (
    <span className="meta">
      <span className="strong">up to {chapterText(p.latest)}</span>
      {p.first !== null && p.first > 1 ? ` · starts at ${chapterText(p.first)}` : ''}
      {p.newestUpload !== null ? ` · last upload ${new Date(p.newestUpload).toLocaleDateString()}` : ''}
    </span>
  );
}

function CheckResult({ check }: { check: PageCheck | undefined }) {
  if (!check) return null;
  if (check.state === 'fine') {
    return <span className="manga-flag good">✓ newest chapter: {check.pages} pages, all loading</span>;
  }
  return (
    <span className={`manga-flag ${check.state === 'broken' ? 'bad' : 'warn'}`}>
      {check.state === 'broken' ? '✕' : '!'} newest chapter: {check.problem}
    </span>
  );
}

/**
 * The answer to a flag, given by somebody who looked.
 *
 * Offered only against a claim the comparison is asking about, and after that
 * an Undo — a verdict given by mistake has to be as easy to take back as it was
 * to give, or it quietly decides every comparison after it.
 */
function ReviewControls({
  awaiting,
  given,
  busy,
  onReview,
}: {
  awaiting: number | undefined;
  given: SourceReview | undefined;
  busy: boolean;
  onReview: (upTo: number, verdict: 'real' | 'fake' | null) => void;
}) {
  if (awaiting !== undefined) {
    return (
      <span className="manga-flags">
        <button className="btn subtle" disabled={busy} onClick={() => onReview(awaiting, 'real')}>
          They're real
        </button>
        <button className="btn subtle" disabled={busy} onClick={() => onReview(awaiting, 'fake')}>
          They're not
        </button>
      </span>
    );
  }
  if (given) {
    return (
      <span className="manga-flags">
        <button className="btn subtle" disabled={busy} onClick={() => onReview(given.upTo, null)}>
          Undo my verdict
        </button>
      </span>
    );
  }
  return null;
}

export function Compare({
  series,
  onClose,
  onLinked,
}: {
  series: SeriesSummary;
  onClose: () => void;
  onLinked: () => void;
}) {
  const [query, setQuery] = useState(series.title);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** A one-off search across every language, without changing the setting. */
  const [wide, setWide] = useState(false);
  /** What the last search asked, so the screen can say what it left out. */
  const [scope, setScope] = useState<Omit<SourceSearch, 'results'> | null>(null);
  const [savingLanguages, setSavingLanguages] = useState(false);
  /**
   * Your verdicts, held here once the screen is open so a click shows at once.
   * Seeded from the series; every answer from the server replaces it whole.
   */
  const [reviews, setReviews] = useState<SourceReview[]>(series.reviews ?? []);
  const [reviewing, setReviewing] = useState<string | null>(null);

  async function review(row: Row, upTo: number, verdict: 'real' | 'fake' | null) {
    setReviewing(keyOf(row));
    setProblem(null);
    try {
      setReviews((await manga.source.review(series.id, keyOf(row), upTo, verdict)).reviews);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'could not save that');
    } finally {
      setReviewing(null);
    }
  }

  const patch = (key: string, change: Partial<Row>) =>
    setRows((current) => (current ?? []).map((r) => (keyOf(r) === key ? { ...r, ...change } : r)));

  async function count(found: Row[]) {
    // Same-title results first, because those are the comparison; the rest are
    // counted after, for anybody who opens that section.
    const order = [...found.filter(isSameTitle), ...found.filter((r) => !isSameTitle(r))].slice(0, COUNTED);
    for (const r of order) patch(keyOf(r), { counting: true });

    let next = 0;
    const worker = async () => {
      while (next < order.length) {
        const r = order[next++];
        try {
          const answer = await manga.source.count(series.id, r.id);
          /*
           * An older server sends only `chapters` and `latest`. A profile is
           * built from those two so the row still shows how far the source goes;
           * it simply cannot be checked for gaps or pages until the server
           * catches up.
           */
          const profile: ChapterProfile = answer.profile ?? {
            entries: answer.chapters,
            distinct: answer.chapters,
            first: null,
            latest: answer.latest,
            latestChapterId: null,
            missing: 0,
            missingSample: [],
            newestUpload: null,
          };
          patch(keyOf(r), { profile, counting: false });
        } catch {
          patch(keyOf(r), { countFailed: true, counting: false });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, order.length) }, worker));
  }

  async function find(q: string, allLanguages = wide) {
    setSearching(true);
    setProblem(null);
    setRows(null);
    try {
      const { results, ...asked } = await manga.source.search(series.id, q, allLanguages);
      setRows(results);
      setScope(asked);
      void count(results);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'the search failed');
    } finally {
      setSearching(false);
    }
  }

  useEffect(() => {
    void find(series.title);
    // Once, on opening. A later search is the button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series.id]);

  async function checkPages(row: Row) {
    const chapterId = row.profile?.latestChapterId;
    if (!chapterId) return;
    patch(keyOf(row), { checking: true });
    try {
      patch(keyOf(row), { check: await manga.source.check(series.id, chapterId), checking: false });
    } catch (error) {
      patch(keyOf(row), {
        checking: false,
        check: { pages: 0, state: 'broken', problem: error instanceof Error ? error.message : 'the check failed' },
      });
    }
  }

  async function use(row: Row) {
    setLinking(keyOf(row));
    setProblem(null);
    try {
      await manga.source.link(series.id, row);
      onLinked();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'could not switch to that source');
      setLinking(null);
    }
  }

  const sameRows = (rows ?? []).filter(isSameTitle);
  const other = sinkEmpty((rows ?? []).filter((r) => !isSameTitle(r)));
  const verdict = judgeSources(sameRows.map((r) => toSourceRow(r, reviews)));
  // Furthest first — see `orderSources`, which is also what keeps MangaDex off
  // the top unless it is genuinely ahead.
  const byKey = new Map(sameRows.map((r) => [keyOf(r), r]));
  const same = orderSources(sameRows.map((r) => toSourceRow(r, reviews)), verdict).map((s) => byKey.get(s.key)!);
  const isCurrent = (r: Row) => series.source?.mangaId === r.id && series.source?.sourceName === r.sourceName;

  const renderRow = (r: Row, flags: Flag[] | undefined) => (
    <div key={keyOf(r)} className={`manga-compare-row${isCurrent(r) ? ' current' : ''}`}>
      <div className="manga-row-text">
        <span className="title truncate">
          {r.title}
          {isCurrent(r) && <span className="manga-flag good"> · reading now</span>}
        </span>
        <span className="meta">{r.sourceName}</span>
        <Stats row={r} />
        <Flags flags={flags} />
        <ReviewControls
          awaiting={verdict.awaiting[keyOf(r)]}
          given={reviews.find((v) => v.key === keyOf(r))}
          busy={reviewing === keyOf(r)}
          onReview={(upTo, answer) => void review(r, upTo, answer)}
        />
        <CheckResult check={r.check} />
      </div>
      <div className="manga-row-actions">
        {r.profile?.latestChapterId && (
          <button className="btn subtle" disabled={r.checking} onClick={() => void checkPages(r)}>
            {r.checking ? 'Checking…' : r.check ? 'Check again' : 'Check pages'}
          </button>
        )}
        {!isCurrent(r) && (
          <button
            className="btn"
            disabled={linking !== null || r.profile?.latest === null}
            onClick={() => void use(r)}
          >
            {linking === keyOf(r) ? 'Switching…' : series.source ? 'Switch to this' : 'Read from this'}
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="card">
      <div className="row between">
        <button className="btn subtle" onClick={onClose}>
          ‹ Back
        </button>
        <span className="meta">{series.title} across your sources</span>
      </div>

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void find(query);
        }}
      >
        <input value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Title to look for" />
        <button className="btn" type="submit" disabled={searching}>
          {searching ? 'Searching…' : 'Search'}
        </button>
      </form>

      {problem && <p className="banner">{problem}</p>}

      {/*
        * What the search asked, said out loud. A search limited to your
        * languages that did not say so would read as every other source lacking
        * the series — the silent cap that hid MangaFire's English source behind
        * twenty empty MangaDex languages, arriving by a different door.
        */}
      {scope?.searched !== undefined && (
        <p className="meta">
          {scope.languages
            ? `Searched ${scope.searched} source${scope.searched === 1 ? '' : 's'} in ${scope.languages
                .map(languageName)
                .join(', ')}${scope.skipped ? ` — ${scope.skipped} in other languages left out` : ''}. `
            : `Searched every installed source (${scope.searched}). `}
          <button
            className="btn subtle"
            disabled={searching}
            onClick={() => {
              setWide(!wide);
              void find(query, !wide);
            }}
          >
            {wide ? 'Only my languages' : 'Include other languages'}
          </button>
        </p>
      )}

      {/*
        * The setting, where it matters. Offered from the languages your sources
        * actually cover, so there is nothing here that cannot be searched.
        */}
      {scope?.available && scope.available.length > 1 && (
        <details className="manga-compare-other">
          <summary>Languages I read: {(scope.readLanguages ?? []).map(languageName).join(', ') || 'every language'}</summary>
          <div className="manga-flags">
            {scope.available
              .filter((l) => l.code !== 'all' && l.code !== 'localsourcelang')
              .map((l) => {
                const on = (scope.readLanguages ?? []).includes(l.code);
                return (
                  <button
                    key={l.code}
                    className={on ? 'btn primary' : 'btn subtle'}
                    disabled={savingLanguages}
                    onClick={async () => {
                      const current = scope.readLanguages ?? [];
                      const next = on ? current.filter((c) => c !== l.code) : [...current, l.code];
                      setSavingLanguages(true);
                      try {
                        await manga.source.setLanguages(next);
                        setWide(false);
                        await find(query, false);
                      } finally {
                        setSavingLanguages(false);
                      }
                    }}
                  >
                    {languageName(l.code)} · {l.count}
                  </button>
                );
              })}
          </div>
          <p className="meta">
            Sources that serve every language, and your own files, are always searched. Choosing none searches
            everything.
          </p>
        </details>
      )}
      {searching && !rows && <p className="empty">Asking every installed source…</p>}

      {verdict.summary && <p className="manga-compare-summary">{verdict.summary}</p>}

      {rows && same.length === 0 && (
        <p className="empty">
          No source lists a title matching this. Try a shorter title, or the name a site uses — or look under other
          titles below.
        </p>
      )}

      {same.map((r) => renderRow(r, verdict.flags[keyOf(r)]))}

      {other.length > 0 && (
        <details className="manga-compare-other">
          <summary>
            Other titles ({other.length}) — possibly this series under another name, left out of the comparison
          </summary>
          {other.map((r) => renderRow(r, undefined))}
        </details>
      )}

      {rows && rows.length > 0 && (
        <p className="meta">
          Counts come from each site, so they fill in as they arrive. "Check pages" loads a sample of a source's
          newest chapter to see whether it is real.
        </p>
      )}
    </div>
  );
}
