/**
 * The manga screen: a reading app's layout, inside this one.
 *
 * Laid out the way every manga reader on a phone is — a bar across the top with
 * the screen's name and a search, your library as covers, and five tabs along
 * the bottom: Browse, Library, History, Downloads, More. That is the shape of
 * the app this replaced on the phone, and a layout your thumb already knows is
 * worth more here than one argued from first principles.
 *
 * **The top bar's left corner is the app's ☰**, not a button of its own. The
 * menu button is fixed to the top-left of the screen on every page, so the bar
 * leaves it room rather than drawing a second control under it — which is also
 * why the page's own title is hidden while this screen shows: this bar is the
 * title.
 *
 * **The tab bar is sticky rather than fixed.** Fixed would pin it to the
 * *window*, and with the menu docked beside the content that is 260px too far
 * left; sticky pins it to the bottom of this screen's own column, so it is the
 * same bar at every width without knowing the drawer exists.
 */
import { useEffect, useState } from 'react';
import { useNow } from '@app/clock';
import { useAsync } from '@app/useAsync';
import { pushStep } from '@app/view-history';
import type { FeatureViewProps } from '@app/features/index';
import { Chapters } from './Chapters';
import { Extensions } from './Extensions';
import { SuwayomiUI } from './SuwayomiUI';
import { Compare } from './Compare';
import { Browse } from './Browse';
import { SeriesDetail } from './SeriesDetail';
import { Downloads } from './Downloads';
import { History } from './History';
import { Icon } from './Icons';
import { Library } from './Library';
import { More } from './More';
import { failing, needsSetup } from './SourceCard';
import { flushQueue } from './sync-queue';
import { resendRecent } from './reading-log';
import { openAtLoad } from './open-chapter';
import { manga, type SeriesSummary } from './manga-api';

type Tab = 'browse' | 'library' | 'history' | 'downloads' | 'more';

const TABS: Array<{ id: Tab; label: string; icon: () => React.ReactElement }> = [
  { id: 'browse', label: 'Browse', icon: Icon.browse },
  { id: 'library', label: 'Library', icon: Icon.library },
  { id: 'history', label: 'History', icon: Icon.history },
  { id: 'downloads', label: 'Downloads', icon: Icon.downloads },
  { id: 'more', label: 'More', icon: Icon.more },
];

export default function MangaView({ search, focus, onFocused, local }: FeatureViewProps) {
  useNow();
  const library = useAsync(() => manga.list());
  // Whether chapters can come from anywhere yet — for the banner below.
  const source = useAsync(() => manga.source.get());
  /** Bumped to send the More tab's setup card into view. */
  const [setupFocus, setSetupFocus] = useState(0);
  /** The same, for the Dashboard card's settings — see the effect below. */
  const [shelfFocus, setShelfFocus] = useState(0);
  const goToSetup = () => {
    goTab('more');
    setSetupFocus((n) => n + 1);
  };

  /** The MangaDex search on More, held here so it survives switching tabs. */
  const [query, setQuery] = useState('');
  /** The library's title filter. */
  const [filter, setFilter] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  /** Which series' chapters are open, if any. The reader lives inside it. */
  /** A chapter open when the page was reloaded, reopened once — see `open-chapter.ts`. */
  const [reopen, setReopen] = useState(openAtLoad);
  const [reading, setReading] = useState<string | null>(() => reopen?.seriesId ?? null);
  /** Opened with Continue, so the chapter list goes straight back into the reader. */
  const [continuing, setContinuing] = useState(false);
  const [managingExtensions, setManagingExtensions] = useState(false);
  const [suwayomiOpen, setSuwayomiOpen] = useState(false);
  /**
   * Which series is being compared across sources, and where it was opened
   * from — so Back and switching return you to the chapter list if that is
   * where you came from, rather than dropping you at the top of the library.
   */
  const [comparing, setComparing] = useState<{ id: string; from: 'list' | 'chapters' } | null>(null);
  /** Which of the five. `useState`, like every other bit of navigation here. */
  const [tab, setTab] = useState<Tab>('library');

  /**
   * Switch tabs, and leave a step behind so back comes back to this one.
   *
   * Android's back button used to jump straight out of the manga screen from
   * anywhere inside it — from Browse to the Dashboard in one press — because
   * these five tabs are this package's own idea and the app's history knew
   * nothing about them.
   *
   * One step per change rather than one for "not on Library": going
   * Library → Browse → History and pressing back should reach Browse, which is
   * where you were, not the tab this screen happens to open on.
   *
   * `setTab` itself is left alone for the one caller that is not a tap — a
   * title handed in from the Dashboard's release rows, which is already a
   * navigation and should not owe a second back press to undo.
   */
  const goTab = (next: Tab) => {
    if (next === tab) return;
    const previous = tab;
    pushStep(() => setTab(previous));
    setTab(next);
  };
  /** A library series whose source page is open — Series details. */
  const [details, setDetails] = useState<string | null>(null);
  /**
   * A History row for something read but not followed.
   *
   * Held as what the source calls it rather than as a series id, because there
   * is no series — the details card below is rebuilt from this, which is where
   * Continue and Follow already are.
   */
  const [glimpsing, setGlimpsing] = useState<{ sourceMangaId: string; title: string; sourceName: string; carryOn: boolean } | null>(null);
  /** A search handed to Browse — the 🔍, or details on a series with no source yet. */
  const [browseSearch, setBrowseSearch] = useState<{ query: string; at: number } | null>(null);
  const [browsed, setBrowsed] = useState(false);
  useEffect(() => {
    if (tab === 'browse') setBrowsed(true);
  }, [tab]);

  /*
   * Reading done offline reaches the PC here: the first time this screen opens
   * with the server answering. The list is reloaded if anything was sent, so
   * the NEW badges and Continue show it.
   */
  useEffect(() => {
    void flushQueue().then((sent) => {
      if (sent > 0) library.reload();
    });
    // And this device's reading log: anything not yet delivered, plus the last
    // month again so a read the PC lost is put back — see `reading-log.ts`.
    // A restored read announces itself, which reloads the library on its own.
    resendRecent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * A title handed in — the Dashboard panel's release rows. A series you follow
   * by that name opens straight to its chapters, which is what tapping a new
   * chapter means; anything else filters the library to it. Waits for the list,
   * since which of the two it is depends on it, and is cleared through
   * `onFocused` at the end, since clearing it re-runs this.
   */
  useEffect(() => {
    if (!search || !library.data) return;
    const exact = library.data.series.find((s) => s.title.toLowerCase() === search.toLowerCase());
    if (exact?.source) {
      setReading(exact.id);
    } else {
      setTab('library');
      setFilter(search);
    }
    onFocused?.();
  }, [search, onFocused, library.data]);

  /*
   * Something elsewhere asked for one thing on this screen — today only the
   * Dashboard card's "Change what's here", which lands on More and brings its
   * shelf settings into view.
   *
   * Cleared through `onFocused` at the end, like the search above: clearing it
   * changes `focus`, which re-runs this, and announcing it first would cancel
   * the thing it just asked for. That ordering cost three goes on the Settings
   * screen and is written down there.
   */
  useEffect(() => {
    if (focus !== 'shelf') return;
    goTab('more');
    setShelfFocus((n) => n + 1);
    onFocused?.();
  }, [focus, onFocused]);

  async function remove(series: SeriesSummary) {
    if (!confirm(`Stop following ${series.title}?`)) return;
    try {
      await manga.remove(series.id);
      library.reload();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'could not remove it');
    }
  }

  /** A cover tapped: its chapters, or — with nowhere to read it yet — the search for somewhere. */
  function open(series: SeriesSummary) {
    if (series.source) setReading(series.id);
    else setComparing({ id: series.id, from: 'list' });
  }

  /**
   * The source's page for this series, the one Browse shows — or, with no
   * source linked yet, a search of every source for it, since there is no one
   * page to show until you pick where to read.
   */
  function showDetails(series: SeriesSummary) {
    if (series.source) {
      setDetails(series.id);
      window.scrollTo(0, 0);
    } else {
      goTab('browse');
      setBrowseSearch({ query: series.title, at: Date.now() });
    }
  }

  const data = library.data;

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
    const current = data?.series.find((x) => x.id === reading);
    overlay = (
      <Chapters
        seriesId={reading}
        series={current}
        coverPath={current?.coverPath ?? null}
        libraries={data?.libraries ?? []}
        continueOnOpen={continuing}
        reopenChapterId={reopen?.seriesId === reading ? reopen.chapterId : undefined}
        onClose={() => {
          setReading(null);
          setContinuing(false);
          setReopen(null);
          // The place was saved without announcing itself; this list should know.
          library.reload();
        }}
        onCompare={() => {
          setComparing({ id: reading, from: 'chapters' });
          setReading(null);
          setContinuing(false);
        }}
        onDetails={
          current
            ? () => {
                setReading(null);
                setContinuing(false);
                showDetails(current);
              }
            : undefined
        }
        onChanged={() => library.reload()}
      />
    );
  }
  /*
   * Something from History you are not following, shown as the source's own
   * details card — the same card Browse opens, with no `ownSeriesId`, so it
   * finds its own record again through `glimpse` the moment a chapter opens.
   */
  if (!overlay && glimpsing) {
    overlay = (
      <div className="card manga-browse">
        <SeriesDetail
          result={{
            id: glimpsing.sourceMangaId,
            title: glimpsing.title,
            sourceName: glimpsing.sourceName,
            lang: null,
            url: null,
            thumbnailUrl: null,
            coverPath: null,
            following: null,
          }}
          others={[]}
          following={null}
          onBack={() => setGlimpsing(null)}
          onOpen={() => undefined}
          onFollow={async (r) => {
            /*
             * The same call Browse makes, not a copy of its handler — and the
             * server moves this row's read log onto the new series and drops
             * the row, so History shows one record of it rather than two.
             */
            await manga.browse.follow(r);
            setGlimpsing(null);
            library.reload();
          }}
          onRead={(id) => {
            setGlimpsing(null);
            setReading(id);
          }}
        />
      </div>
    );
  }
  if (!overlay && details) {
    const own = data?.series.find((s) => s.id === details);
    if (own?.source) {
      overlay = (
        <div className="card manga-browse">
          <SeriesDetail
            result={{
              id: own.source.mangaId,
              title: own.source.title,
              sourceName: own.source.sourceName,
              lang: null,
              url: null,
              thumbnailUrl: null,
              coverPath: own.coverPath,
              following: own.id,
            }}
            others={[]}
            following={own.id}
            ownSeriesId={own.id}
            updatesUrl={own.url}
            onBack={() => setDetails(null)}
            onOpen={() => undefined}
            onFollow={async () => undefined}
            onRead={(id) => {
              setDetails(null);
              setReading(id);
            }}
          />
        </div>
      );
    }
  }
  if (!overlay && managingExtensions) overlay = <Extensions local={local} onClose={() => setManagingExtensions(false)} />;
  if (!overlay && suwayomiOpen) overlay = <SuwayomiUI onClose={() => setSuwayomiOpen(false)} />;

  const title = TABS.find((t) => t.id === tab)!.label;

  return (
    <>
      {overlay}
      <div className="manga-screen" hidden={overlay !== null}>
        {/*
          * The ☰ is the app's own, fixed to this corner — the empty first cell
          * is its room. The search goes straight to Browse → Search, which asks
          * every source; the Title box on Library only filters what you have.
          */}
        <div className="manga-topbar">
          <span aria-hidden="true" />
          <h1>{title}</h1>
          <button
            className="manga-icon-btn"
            aria-label="Search every source"
            title="Search every source"
            onClick={() => {
              goTab('browse');
              setBrowseSearch({ query: '', at: Date.now() });
            }}
          >
            <Icon.search />
          </button>
        </div>

        <div className="manga-body">
          {problem && <p className="banner">{problem}</p>}

          {/*
            * Every tab but More says so when manga cannot work yet, with the one
            * button that fixes it — "where do I click" should never be a question.
            */}
          {tab !== 'more' && source.data && (needsSetup(source.data) || failing(source.data)) && (
            <div className="banner manga-setup-banner">
              <span>
                {needsSetup(source.data)
                  ? 'Manga needs a one-time setup before it can find or read anything.'
                  : 'Suwayomi, which finds and serves chapters, is not starting.'}
              </span>
              <button className="btn primary" onClick={goToSetup}>
                {needsSetup(source.data) ? 'Set up manga' : 'See what is wrong'}
              </button>
            </div>
          )}

          {/*
            * Browse mounts the first time it is opened — it starts Suwayomi,
            * which somebody only looking at their list should not pay for — and
            * then stays, hidden, so switching tabs keeps what you were looking at.
            */}
          {(tab === 'browse' || browsed) && (
            <div hidden={tab !== 'browse'}>
              <Browse onFollowed={() => library.reload()} onRead={(id) => setReading(id)} search={browseSearch} />
            </div>
          )}

          {tab === 'library' && (
            <>
              {library.loading && <p className="empty">loading…</p>}
              {library.error && <p className="banner">Could not load: {library.error.message}</p>}
              {data && data.series.length === 0 && (
                <div className="card">
                  <p className="empty">
                    Nothing yet. Find something in{' '}
                    <button className="btn subtle" onClick={() => goTab('browse')}>
                      Browse
                    </button>
                    , or follow a series by name under{' '}
                    <button className="btn subtle" onClick={() => goTab('more')}>
                      More
                    </button>
                    .
                  </p>
                </div>
              )}
              {data && data.series.length > 0 && (
                <Library
                  series={data.series}
                  filter={filter}
                  onFilter={setFilter}
                  onOpen={open}
                  onDetails={showDetails}
                  onCompare={(s) => setComparing({ id: s.id, from: 'list' })}
                  onRemove={(s) => void remove(s)}
                  libraries={data.libraries ?? []}
                  onShelves={(s, ids) => {
                    void manga.libraries
                      .set(s.id, ids)
                      .then(() => library.reload())
                      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : 'could not save that'));
                  }}
                />
              )}
            </>
          )}

          {/* Mounted only while shown, so it is fetched fresh each time — see `History`. */}
          {tab === 'history' && (
            <History
              onOpen={(id, carryOn) => {
                setContinuing(carryOn);
                setReading(id);
              }}
              onGlimpse={(e) => setGlimpsing(e)}
            />
          )}

          {/* Everything saved on this device, and what is being saved. */}
          {tab === 'downloads' && <Downloads onRead={(id) => setReading(id)} />}

          {tab === 'more' && (
            <More
              data={data}
              local={local}
              query={query}
              onQuery={setQuery}
              onChanged={() => library.reload()}
              onExtensions={() => setManagingExtensions(true)}
              onOpenUi={() => setSuwayomiOpen(true)}
              onCompare={(s) => setComparing({ id: s.id, from: 'list' })}
              setupFocus={setupFocus}
              shelfFocus={shelfFocus}
              setupFirst={Boolean(source.data && (needsSetup(source.data) || failing(source.data)))}
            />
          )}
        </div>

        <nav className="manga-tabbar" role="tablist" aria-label="Manga">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? 'on' : undefined}
              onClick={() => {
                // Tapping the tab you are on goes back to its top, as on every
                // phone — and leaves no step, because you have not gone anywhere.
                if (tab === t.id) {
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                  return;
                }
                goTab(t.id);
              }}
            >
              <t.icon />
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
      </div>
    </>
  );
}
