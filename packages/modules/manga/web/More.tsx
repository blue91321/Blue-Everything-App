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
import { useEffect, useRef, useState } from 'react';
import { Cover } from './Cover';
import { Archive } from './Archive';
import { isIncognito, setIncognito } from './incognito';
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

/**
 * Reading without it being written down — see `incognito.ts`.
 *
 * Its own card rather than a line inside "New chapters", which is about what
 * gets *announced*: this is about what gets *recorded*, and folding them
 * together would put a switch about your reading history under a heading about
 * notifications.
 *
 * `useState` seeded once from storage rather than read on every render: it is
 * a device setting that only this control changes, and `localStorage` on a
 * render path is a synchronous read nobody needs.
 */
function Incognito() {
  const [on, setOn] = useState(isIncognito);

  return (
    <div className="card">
      <h3>Reading privately</h3>
      <label className="meta">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            setIncognito(e.target.checked);
            setOn(e.target.checked);
          }}
        />{' '}
        Do not record what I read on this device
      </label>
      <p className="meta">
        Chapters you open are not marked read and your place is not saved, so nothing new reaches History. What is
        already there is untouched — History&apos;s ✕ is what removes that, one row at a time.
      </p>
      <p className="meta">
        {/* The honest boundary, said rather than left to be found. */}
        Saving a chapter for offline still writes it to this device: a file is a file whatever this switch says. It is
        per device, so turning it on here leaves your phone as it was.
      </p>
    </div>
  );
}

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
  shelfFocus = 0,
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
  /** Bumped when the Dashboard card's button asked for these settings. */
  shelfFocus?: number;
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
  const [savingAhead, setSavingAhead] = useState(false);
  const [savingShelf, setSavingShelf] = useState(false);
  const shelfRef = useRef<HTMLDivElement | null>(null);

  /*
   * Bring the shelf settings into view when the Dashboard card asked for them,
   * and say so with a moment of highlight — otherwise arriving here is
   * indistinguishable from the More tab happening to look like this.
   *
   * `setTimeout`, not `requestAnimationFrame`: this screen is behind a tab and
   * a `useAsync`, and rAF does not fire at all when the page is not
   * compositing. Written down at length on the Settings screen, which took
   * three goes to learn it.
   */
  useEffect(() => {
    if (!shelfFocus) return;
    const id = setTimeout(() => {
      const el = shelfRef.current;
      if (!el) return;
      el.scrollIntoView({ block: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1400);
    }, 60);
    return () => clearTimeout(id);
  }, [shelfFocus]);

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

      {/* Above "New chapters", because this is the setting about what is kept
          rather than what is announced. */}
      <Archive />

      <Incognito />

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
        {/*
          The Dashboard card. Here rather than on the Settings screen because
          everything it decides is about *manga* — which series, in which order
          — while Settings decides only whether the card is on the Dashboard at
          all and where in the column it sits. The split is the same one the
          live panel's scope draws, from the other side.
        */}
        {data?.shelfShow !== undefined && (
          <div style={{ marginTop: 10 }} ref={shelfRef} className="manga-shelf-settings">
            <div className="meta">On the Dashboard — add "My shelf" in Settings first</div>

            <div className="row wrap" style={{ gap: '.35rem', marginTop: 6 }}>
              {([
                { key: 'all', label: 'Everything' },
                { key: 'favourites', label: 'Favourites only' },
              ] as const).map((option) => (
                <button
                  key={option.key}
                  type="button"
                  className={data.shelfShow === option.key ? 'btn primary' : 'btn subtle'}
                  disabled={savingShelf}
                  onClick={async () => {
                    setSavingShelf(true);
                    try {
                      await manga.setShelf({ show: option.key });
                      onChanged();
                    } finally {
                      setSavingShelf(false);
                    }
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div className="row wrap" style={{ gap: '.35rem', marginTop: 6 }}>
              {([
                { key: 'follow', label: 'Same as the Library tab' },
                { key: 'read', label: 'Last read' },
                { key: 'catchup', label: 'Most to catch up on' },
                { key: 'updated', label: 'Last updated' },
                { key: 'title', label: 'Title' },
                { key: 'added', label: 'Recently added' },
              ] as const).map((option) => (
                <button
                  key={option.key}
                  type="button"
                  className={data.shelfSort === option.key ? 'btn primary' : 'btn subtle'}
                  disabled={savingShelf}
                  onClick={async () => {
                    setSavingShelf(true);
                    try {
                      await manga.setShelf({ sort: option.key });
                      onChanged();
                    } finally {
                      setSavingShelf(false);
                    }
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>

            {/*
              Only while the order is pinned. In `follow` this box comes from
              the Library tab along with the sort — the two are one control
              there, and a second copy here that did nothing would be the lie
              the disabled-slider case already argues against.
            */}
            {data.shelfSort !== 'follow' && (
              <label className="meta" style={{ display: 'block', marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={data.shelfNewFirst !== false}
                  disabled={savingShelf}
                  onChange={async (e) => {
                    setSavingShelf(true);
                    try {
                      await manga.setShelf({ newFirst: e.target.checked });
                      onChanged();
                    } finally {
                      setSavingShelf(false);
                    }
                  }}
                />{' '}
                New chapters on top
              </label>
            )}

            <div className="meta" style={{ marginTop: 6 }}>
              {data.shelfSort === 'follow'
                ? 'The card is ordered however this device has the Library tab sorted, including its "New chapters on top" box — change either there and the card follows. Both are per device, so your PC and phone can differ.'
                : 'A fixed order for the card, kept on the server, so every device shows it the same way. The Library tab keeps its own sort and its own box.'}
            </div>
          </div>
        )}

        {/*
          Buttons rather than a slider, the same call the refresh rate and the
          drawer breakpoint make: four named answers, where every position
          between them is a worse version of a neighbour. Hidden entirely
          against an older server, which would ignore the setting.
        */}
        {data?.readAheadChapters !== undefined && (
          <div style={{ marginTop: 10 }}>
            <div className="meta">Fetch ahead while reading</div>
            <div className="row wrap" style={{ gap: '.35rem', marginTop: 6 }}>
              {[0, 1, 2, 3].slice(0, (data.maxReadAhead ?? 3) + 1).map((n) => (
                <button
                  key={n}
                  type="button"
                  className={data.readAheadChapters === n ? 'btn primary' : 'btn subtle'}
                  disabled={savingAhead}
                  onClick={async () => {
                    setSavingAhead(true);
                    try {
                      await manga.setReadAhead(n);
                      onChanged();
                    } finally {
                      setSavingAhead(false);
                    }
                  }}
                >
                  {n === 0 ? 'Off' : n === 1 ? '1 chapter' : `${n} chapters`}
                </button>
              ))}
            </div>
            <div className="meta" style={{ marginTop: 6 }}>
              {data.readAheadChapters === 0
                ? 'Off — a chapter is only saved once you open it, so the next one loads from the source.'
                : 'The next ' +
                  (data.readAheadChapters === 1 ? 'chapter is' : `${data.readAheadChapters} chapters are`) +
                  ' downloaded while you read, so they open from this PC. Only while the source is already' +
                  ' running — this never starts it — and the ten kept chapters still favour what you opened' +
                  ' yourself.'}
            </div>
          </div>
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
