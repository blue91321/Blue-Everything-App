/**
 * The reading list.
 *
 * Two halves: a search that adds a series, and the list of what you follow. The
 * search is at the top rather than behind an "Add" button because adding is what
 * you come here to do until the list exists, and after that the list is the
 * thing you scroll — so the control you need first is the one at the top.
 *
 * ### The row says why it is not being watched
 *
 * A series MangaUpdates has no entry for can be added and can never produce a
 * nudge. So can a finished one. Both are legitimate things to keep in a list,
 * and both look exactly like a broken feature if the row does not say so — the
 * same reason the Voice screen reports which microphone is open rather than
 * showing a switch that reads "on".
 */
import { useEffect, useState } from 'react';
import { useNow } from '@app/clock';
import { useAsync } from '@app/useAsync';
import type { FeatureViewProps } from '@app/features/index';
import { Cover } from './Cover';
import { SourceCard } from './SourceCard';
import { SourceLink } from './SourceLink';
import { Chapters } from './Chapters';
import { Extensions } from './Extensions';
import { SuwayomiUI } from './SuwayomiUI';
import { Compare } from './Compare';
import { Browse } from './Browse';
import { ageOf, manga, type Candidate, type SeriesSummary } from './manga-api';

const STATUS_LABEL: Record<SeriesSummary['status'], string> = {
  ongoing: 'ongoing',
  completed: 'finished',
  hiatus: 'on hiatus',
  cancelled: 'cancelled',
  unknown: 'status unknown',
};

export default function MangaView({ search, onFocused, local }: FeatureViewProps) {
  useNow();
  const library = useAsync(() => manga.list());

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Candidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [savingReleaseTasks, setSavingReleaseTasks] = useState(false);
  const [sweep, setSweep] = useState<string | null>(null);
  /** Which series' chapters are open, if any. The reader lives inside it. */
  const [reading, setReading] = useState<string | null>(null);
  const [managingExtensions, setManagingExtensions] = useState(false);
  const [suwayomiOpen, setSuwayomiOpen] = useState(false);
  /**
   * Which series is being compared across sources, and where it was opened
   * from — so Back and switching return you to the chapter list if that is
   * where you came from, rather than dropping you at the top of the library.
   */
  const [comparing, setComparing] = useState<{ id: string; from: 'list' | 'chapters' } | null>(null);
  /** Your list, or browsing your sources. `useState`, like every other bit of navigation here. */
  const [tab, setTab] = useState<'library' | 'browse'>('library');
  const [browsed, setBrowsed] = useState(false);
  useEffect(() => {
    if (tab === 'browse') setBrowsed(true);
  }, [tab]);

  /*
   * A search handed in from elsewhere — the Dashboard panel's rows land here
   * with a title. Cleared through `onFocused` at the *end*, since clearing it
   * changes the prop and re-runs this effect.
   */
  useEffect(() => {
    if (!search) return;
    setQuery(search);
    onFocused?.();
  }, [search, onFocused]);

  async function runSearch(event: React.FormEvent) {
    event.preventDefault();
    if (query.trim().length < 2) return;
    setSearching(true);
    setProblem(null);
    try {
      setResults((await manga.search(query.trim())).results);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'the search failed');
      setResults(null);
    } finally {
      setSearching(false);
    }
  }

  async function add(candidate: Candidate) {
    setProblem(null);
    try {
      await manga.add(candidate);
      library.reload();
      // Marked as already-added in place rather than removed from the results:
      // a row vanishing when you press its button looks like the press went
      // somewhere else.
      setResults((rs) => rs?.map((r) => (r.mangadexId === candidate.mangadexId ? { ...r, already: true } : r)) ?? null);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'could not add it');
    }
  }

  async function remove(series: SeriesSummary) {
    if (!confirm(`Stop following ${series.title}?`)) return;
    try {
      await manga.remove(series.id);
      library.reload();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'could not remove it');
    }
  }

  async function checkNow() {
    setChecking(true);
    setSweep(null);
    try {
      const result = await manga.checkNow();
      setSweep(
        result.raised > 0
          ? `${result.raised} new chapter${result.raised === 1 ? '' : 's'}${library.data?.releaseTasks ? ' — added to your tasks' : ''}`
          : `Checked ${result.checked}${result.failed ? `, ${result.failed} failed` : ''}. Nothing new.`
      );
      library.reload();
    } catch (error) {
      setSweep(error instanceof Error ? error.message : 'the check failed');
    } finally {
      setChecking(false);
    }
  }

  const data = library.data;
  const now = Date.now();

  /*
   * The chapter list replaces the screen rather than sitting under it. Reading
   * is a place you go, not a row that grows — the same call the Notes screen
   * makes about opening a note on a phone, and for the same reason: what opens
   * is a full-width document, and putting one inside a list leaves it wearing
   * the list's width with the rest of the list above and below it.
   *
   * Replaced, but not unmounted. The tabs stay underneath, hidden, so opening a
   * series you found while browsing and coming back returns you to your search
   * and its results rather than an empty box — `display: none` for the reason
   * Notes uses it, since React keeps the state and CSS decides what is shown.
   */
  let overlay: React.ReactNode = null;
  if (comparing) {
    const compared = data?.series.find((s) => s.id === comparing.id);
    if (compared) {
      const back = () => {
        setComparing(null);
        if (comparing.from === 'chapters') setReading(compared.id);
      };
      overlay = (
        <Compare
          series={compared}
          onClose={back}
          onLinked={() => {
            library.reload();
            back();
          }}
        />
      );
    }
  }
  if (!overlay && reading) {
    overlay = (
      <Chapters
        seriesId={reading}
        onClose={() => setReading(null)}
        onCompare={() => {
          setComparing({ id: reading, from: 'chapters' });
          setReading(null);
        }}
      />
    );
  }
  if (!overlay && managingExtensions) overlay = <Extensions local={local} onClose={() => setManagingExtensions(false)} />;
  if (!overlay && suwayomiOpen) overlay = <SuwayomiUI onClose={() => setSuwayomiOpen(false)} />;

  return (
    <>
    {overlay}
    <div className="manga" hidden={overlay !== null}>
      <div className="tabs" role="tablist">
        {(['library', 'browse'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`tab${tab === t ? ' on' : ''}`} onClick={() => setTab(t)}>
            {t === 'library' ? 'Library' : 'Browse'}
          </button>
        ))}
      </div>

      {/*
        * Browse mounts the first time it is opened — it starts Suwayomi, which
        * somebody only looking at their list should not pay for — and then stays,
        * hidden, so switching tabs keeps what you were looking at.
        */}
      {(tab === 'browse' || browsed) && (
        <div hidden={tab !== 'browse'}>
          <Browse onFollowed={() => library.reload()} onRead={(id) => setReading(id)} />
        </div>
      )}

      <div hidden={tab !== 'library'}>
      <form className="card manga-search" onSubmit={runSearch}>
        <label htmlFor="manga-q">Follow a series</label>
        <div className="row">
          <input
            id="manga-q"
            value={query}
            placeholder="Title…"
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit" className="btn primary" disabled={searching || query.trim().length < 2}>
            {searching ? 'Searching…' : 'Search'}
          </button>
        </div>
        <p className="meta">
          Looked up on MangaDex, which also tells us what it is called on MyAnimeList, AniList and MangaUpdates — so
          everything else here is a lookup rather than a guess.
        </p>
      </form>

      <SourceCard local={local} onExtensions={() => setManagingExtensions(true)} onOpenUi={() => setSuwayomiOpen(true)} />

      {problem && <p className="banner">{problem}</p>}

      {results !== null && (
        <div className="card">
          <h3>Results</h3>
          {results.length === 0 && <p className="empty">Nothing matched.</p>}
          {results.map((candidate) => (
            <div className="manga-row" key={candidate.mangadexId ?? candidate.title}>
              <Cover path={candidate.coverPath} title={candidate.title} size={40} />
              <div className="manga-row-text">
                <span className="title truncate">{candidate.title}</span>
                {candidate.subtitle && <span className="meta"> {candidate.subtitle}</span>}
                <span className="meta">
                  {STATUS_LABEL[candidate.status]}
                  {candidate.year ? ` · ${candidate.year}` : ''}
                  {/*
                    * Said before you add it rather than after, because a series
                    * that can never be watched saves perfectly and then simply
                    * never does anything — which reads as the feature being
                    * broken. The Games tab learned this about a row with no
                    * path known yet.
                    */}
                  {!candidate.trackable && ' · MangaUpdates has no entry, so this one cannot be watched'}
                </span>
              </div>
              <button className="btn" disabled={candidate.already} onClick={() => add(candidate)}>
                {candidate.already ? 'Following' : 'Follow'}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <div className="row between">
          <h3>Following{data ? ` (${data.series.length})` : ''}</h3>
          <button className="btn" onClick={checkNow} disabled={checking || !data || data.watching === 0}>
            {checking ? 'Checking…' : 'Check now'}
          </button>
        </div>

        {sweep && <p className="meta">{sweep}</p>}

        {library.loading && <p className="empty">loading…</p>}
        {library.error && <p className="banner">Could not load: {library.error.message}</p>}

        {data && data.series.length === 0 && (
          <p className="empty">Nothing yet. Search above to follow something.</p>
        )}

        <div className="manga-list">
          {data?.series.map((series) => (
          <div className="manga-row" key={series.id}>
            <Cover path={series.coverPath} title={series.title} size={40} />
            <div className="manga-row-text">
              <span className="title truncate">{series.title}</span>
              <span className="meta" title={series.chapterTitle}>
                {series.chapterLabel}
                {' · '}
                {STATUS_LABEL[series.status]}
                {series.checkedAt && ` · checked ${ageOf(series.checkedAt, now)}`}
              </span>
              {/*
                * The failure is shown beside the reading it could not replace,
                * not instead of it: a stale chapter number with nothing admitting
                * it is stale is the failure this app is against.
                */}
              {series.error && <span className="meta urgent">{series.error}</span>}
              {series.notWatchingBecause && <span className="meta">Not watched — {series.notWatchingBecause}</span>}
            </div>
            {/*
              * Outside the text column, so the picker gets the row's whole
              * width rather than the ~230px left over beside a cover and three
              * buttons — which is what made every result read "Ao no Miburo
              * —S...". `.manga-row` already wraps, so this lands on its own
              * line.
              */}
            <SourceLink
              series={series}
              onCompare={() => setComparing({ id: series.id, from: 'list' })}
              onChanged={() => library.reload()}
            />
            <div className="manga-row-actions">
              {/* Only when there is somewhere to read it from. */}
              {series.source && (
                <button className="btn primary" onClick={() => setReading(series.id)}>
                  Read
                </button>
              )}
              {series.url && (
                <a href={series.url} target="_blank" rel="noreferrer noopener" className="btn subtle">
                  Details
                </a>
              )}
              <button className="btn danger" onClick={() => remove(series)}>
                Remove
              </button>
            </div>
          </div>
          ))}
        </div>

        {data && (
          <p className="meta">
            {data.watching > 0
              ? `Watching ${data.watching} for new chapters, about every half hour. Finished series are not checked.`
              : 'Nothing is being watched, so no requests are made.'}{' '}
            {/*
              * Only said while something still depends on MangaUpdates. With
              * every series linked to a source the sentence is simply false —
              * those numbers come from the site itself — and a footer that
              * contradicts the rows above it is worse than no footer.
              */}
            {data.series.some((s) => !s.source) && (
              <>
                {data.credit} Numbers without a source beside them are the newest release it has logged, and sites
                carrying unofficial translations are often further ahead.
              </>
            )}
          </p>
        )}

        {/*
          * Beside the sentence about watching, because it is the other half of
          * the same question: what happens when a chapter lands. Hidden against
          * an older server, which would ignore it.
          */}
        {data?.releaseTasks !== undefined && (
          <label className="meta">
            <input
              type="checkbox"
              checked={data.releaseTasks}
              disabled={savingReleaseTasks}
              onChange={async (e) => {
                setSavingReleaseTasks(true);
                try {
                  await manga.setReleaseTasks(e.target.checked);
                  library.reload();
                } finally {
                  setSavingReleaseTasks(false);
                }
              }}
            />{' '}
            Also add each new chapter to Tasks. You are told when one lands either way; this puts it on the
            Dashboard until you tick it off.
          </label>
        )}
      </div>
      </div>
    </div>
    </>
  );
}
