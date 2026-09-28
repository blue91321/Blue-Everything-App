/**
 * The More tab: everything about the library that is not reading it.
 *
 * Following a series by name, where the chapters come from, and what happens
 * when a new one lands. These sat above the library when it was a list, which
 * put three cards of setup between you and the thing you open the screen for;
 * they are set once and visited rarely, which is what a More tab is for.
 *
 * One card is new: **series that cannot be watched**, with why. Those reasons
 * were printed on each row of the old list, and a grid of covers has no room
 * for a sentence — so they are gathered here rather than dropped, because a
 * series that silently never nudges looks exactly like a broken feature.
 *
 * Series brought in from another app and not yet found on a source are the
 * exception: there can be hundreds, and a row each would bury the handful that
 * genuinely need a look. The import card counts them instead, says which sites
 * they came from, and offers to search again.
 */
import { useState } from 'react';
import { Cover } from './Cover';
import { ImportCard } from './Import';
import { SourceCard } from './SourceCard';
import { manga, type Candidate, type Library, type SeriesSummary } from './manga-api';

const STATUS_LABEL: Record<SeriesSummary['status'], string> = {
  ongoing: 'ongoing',
  completed: 'finished',
  hiatus: 'on hiatus',
  cancelled: 'cancelled',
  unknown: 'status unknown',
};

export function More({
  data,
  local,
  query,
  onQuery,
  onChanged,
  onExtensions,
  onOpenUi,
  onCompare,
  setupFocus = 0,
  setupFirst = false,
}: {
  data: Library | undefined;
  local: boolean;
  /** Held by the screen so a search survives switching tabs. */
  query: string;
  onQuery: (q: string) => void;
  onChanged: () => void;
  onExtensions: () => void;
  onOpenUi: () => void;
  onCompare: (s: SeriesSummary) => void;
  /** Bumped by the screen's setup banner: open the setup card and scroll to it. */
  setupFocus?: number;
  /** Manga is not set up, or not starting: the card that fixes it goes first rather than under three others. */
  setupFirst?: boolean;
}) {
  const sourceCard = (
    <SourceCard local={local} onExtensions={onExtensions} onOpenUi={onOpenUi} focus={setupFocus} />
  );

  const [results, setResults] = useState<Candidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [sweep, setSweep] = useState<string | null>(null);
  const [savingReleaseTasks, setSavingReleaseTasks] = useState(false);
  const [savingNudges, setSavingNudges] = useState(false);

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
      onChanged();
      // Marked in place rather than removed: a row vanishing when you press its
      // button looks like the press went somewhere else.
      setResults((rs) => rs?.map((r) => (r.mangadexId === candidate.mangadexId ? { ...r, already: true } : r)) ?? null);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'could not add it');
    }
  }

  async function checkNow() {
    setChecking(true);
    setSweep(null);
    try {
      const result = await manga.checkNow();
      setSweep(
        result.raised > 0
          ? `${result.raised} new chapter${result.raised === 1 ? '' : 's'}${data?.releaseTasks ? ' — added to your tasks' : ''}`
          : `Checked ${result.checked}${result.failed ? `, ${result.failed} failed` : ''}. Nothing new.`
      );
      onChanged();
    } catch (error) {
      setSweep(error instanceof Error ? error.message : 'the check failed');
    } finally {
      setChecking(false);
    }
  }

  const troubled = (data?.series ?? []).filter(
    (s) => s.error || ((s.notWatchingBecause || !s.source) && !(s.origin && !s.source))
  );

  return (
    <div className="manga-more">
      {setupFirst && sourceCard}
      <form className="card manga-search" onSubmit={runSearch}>
        <label htmlFor="manga-q">Follow a series by name</label>
        <div className="row">
          <input id="manga-q" value={query} placeholder="Title…" onChange={(e) => onQuery(e.target.value)} />
          <button type="submit" className="btn primary" disabled={searching || query.trim().length < 2}>
            {searching ? 'Searching…' : 'Search'}
          </button>
        </div>
        <p className="meta">
          Looked up on MangaDex, which also tells us what it is called on MyAnimeList, AniList and MangaUpdates — so
          everything else here is a lookup rather than a guess. To find one on your sources instead, use Browse.
        </p>
      </form>

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
                    * Said before you add it rather than after: a series that can
                    * never be watched saves perfectly and then never does anything.
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
          <h3>New chapters</h3>
          <button className="btn" onClick={checkNow} disabled={checking || !data || data.watching === 0}>
            {checking ? 'Checking…' : 'Check now'}
          </button>
        </div>
        {sweep && <p className="meta">{sweep}</p>}
        {data && (
          <p className="meta">
            {data.watching > 0
              ? `Watching ${data.watching} for new chapters, about every half hour. Finished series are not checked.`
              : 'Nothing is being watched, so no requests are made.'}{' '}
            {/*
              * Only while something still depends on MangaUpdates: with every
              * series linked to a source, those numbers come from the site
              * itself and the sentence would be false.
              */}
            {data.series.some((s) => !s.source && !s.origin) && (
              <>
                {data.credit} Numbers without a source are the newest release it has logged, and sites carrying
                unofficial translations are often further ahead.
              </>
            )}
          </p>
        )}
        {/* Hidden against an older server, which would ignore it. */}
        {data?.releaseNudges !== undefined && (
          <label className="meta">
            <input
              type="checkbox"
              checked={data.releaseNudges}
              disabled={savingNudges}
              onChange={async (e) => {
                setSavingNudges(true);
                try {
                  await manga.setReleaseNudges(e.target.checked);
                  onChanged();
                } finally {
                  setSavingNudges(false);
                }
              }}
            />{' '}
            Notify me when a new chapter is out. Off, new chapters still show on the library — the NEW badge and the
            count — and nothing waits on the Dashboard; switching it off clears the ones waiting now.
          </label>
        )}
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
                  onChanged();
                } finally {
                  setSavingReleaseTasks(false);
                }
              }}
            />{' '}
            Also add each new chapter to Tasks, so it sits on the Dashboard until you tick it off.
          </label>
        )}
      </div>

      {troubled.length > 0 && (
        <div className="card">
          <h3>Needs a look ({troubled.length})</h3>
          {troubled.map((s) => (
            <div className="manga-row" key={s.id}>
              <Cover path={s.coverPath} title={s.title} size={32} />
              <div className="manga-row-text">
                <span className="title truncate">{s.title}</span>
                {!s.source && <span className="meta">No source to read it from yet.</span>}
                {/*
                  * The failure is shown beside the reading it could not
                  * replace, never instead of it — the tile still carries the
                  * last number, with a ! on the cover pointing here.
                  */}
                {s.error && <span className="meta urgent">Last check failed: {s.error}</span>}
                {s.notWatchingBecause && <span className="meta">Not watched — {s.notWatchingBecause}</span>}
              </div>
              {!s.source && (
                <button className="btn subtle" onClick={() => onCompare(s)}>
                  Find a source
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <ImportCard local={local} onChanged={onChanged} />

      {!setupFirst && sourceCard}
    </div>
  );
}
