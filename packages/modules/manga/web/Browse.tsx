/**
 * Browsing your sources: what is popular, what just came out, and a search.
 *
 * ### One source to browse from
 *
 * Popular and recent lists belong to a site — "popular across every source" is
 * not a list anybody publishes — so those two list the source picked at the top.
 * The pick is stored on the server, like the theme, so the phone browses the
 * same one. Search is the exception: it asks every source, and the picked one
 * leads. See `server/browse.ts`.
 *
 * ### Filters are two kinds, and the panel says which is which
 *
 * The chosen source's own — genre, status, sort — apply to that source only,
 * because every site declares different ones. Language, which sources, and
 * hiding what you follow apply to all of them. Drawn from what the source
 * declares rather than a fixed form, so a new extension's filters appear without
 * this file changing.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Cover } from './Cover';
import { Icon } from './Icons';
import { COMMON_TAGS, FIRST_TAGS, isFirstTag, loadHiddenTags, saveHiddenTags } from './hidden-tags';
import { SeriesDetail } from './SeriesDetail';
import { languageName } from './judge';
import {
  manga,
  type BrowseResult,
  type BrowseState,
  type FilterChange,
  type GroupedSearch,
  type SourceFilter,
  type TriState,
} from './manga-api';

type Sub = 'popular' | 'latest' | 'search';

const SUB_LABEL: Record<Sub, string> = { popular: 'Popular', latest: 'Recently released', search: 'Search' };

/**
 * Browse's "On this PC": the series kept on the PC with "Keep every chapter",
 * by any copy, listed like a source. Not a Suwayomi source: it is read from the
 * kept copy, so a series whose site has gone is still here.
 */
const KEPT = 'kept';

export function Browse({
  onFollowed,
  onRead,
  search,
  pick,
  onExtensions,
}: {
  onFollowed: () => void;
  onRead: (seriesId: string) => void;
  /**
   * A search asked for from elsewhere — the library's Details on a series with
   * no source yet. `at` makes asking twice for the same title a second request.
   */
  search?: { query: string; at: number } | null;
  /** A source to show, from Manage extensions' Browse. */
  pick?: { source: string; at: number } | null;
  /** Open Manage extensions, from beside the source picker. */
  onExtensions?: () => void;
}) {
  const [state, setState] = useState<BrowseState | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sub, setSub] = useState<Sub>('popular');
  // Ecchi, Mature and Adult unless changed, and per device: what is fine on the
  // PC may not be on the phone. See `hidden-tags.ts`.
  const [hide, setHide] = useState<string[]>(loadHiddenTags);
  // A small button at the end of the tab row opens the tags, rather than a row
  // of them above every grid: set once and left, so not a line of every visit.
  const [hideOpen, setHideOpen] = useState(false);

  /** Series followed from this screen since it opened, by result key, so buttons change at once. */
  const [followed, setFollowed] = useState<Record<string, string>>({});
  const [note, setNote] = useState<string | null>(null);
  /**
   * The series whose page is open, and the other sources' copies of it when it
   * came from a search. The lists stay mounted underneath, hidden, so Back
   * returns to the same page of results rather than the top of an empty one.
   */
  const [detail, setDetail] = useState<{ result: BrowseResult; others: BrowseResult[] } | null>(null);
  /*
   * Where the list was scrolled to, so Back lands on the cover you tapped rather
   * than the top of fifty. The page itself opens at the top: arriving halfway
   * down a description is arriving in the middle of it.
   */
  const scrolledTo = useRef(0);
  const open = (result: BrowseResult, others: BrowseResult[] = []) => {
    scrolledTo.current = window.scrollY;
    setDetail({ result, others });
    window.scrollTo(0, 0);
  };
  const back = () => {
    setDetail(null);
    // After the list is shown again, or there is nothing to scroll yet.
    setTimeout(() => window.scrollTo(0, scrolledTo.current), 0);
  };

  useEffect(() => {
    manga.browse.get().then(setState, (e: unknown) => setProblem(e instanceof Error ? e.message : 'could not reach your sources'));
  }, []);

  const keptSelected = state?.selected === KEPT;
  const source = keptSelected ? null : (state?.sources.find((s) => s.id === state?.selected) ?? null);

  // A source with no recent-releases list has no such tab; land on Popular.
  useEffect(() => {
    if (sub === 'latest' && source && !source.supportsLatest) setSub('popular');
  }, [source, sub]);

  async function choose(id: string) {
    setState((s) => (s ? { ...s, selected: id } : s));
    try {
      await manga.browse.setSource(id);
    } catch {
      // The pick still applies on this screen; it simply is not remembered.
    }
  }

  async function follow(result: BrowseResult) {
    setNote(null);
    try {
      const { series, matchedOn } = await manga.browse.follow(result);
      setFollowed((f) => ({ ...f, [keyOf(result)]: series.id }));
      setNote(
        matchedOn === 'existing'
          ? `${series.title} was already in your list — it now reads from ${result.sourceName}.`
          : matchedOn === 'mangadex'
            ? `Following ${series.title}, reading from ${result.sourceName}.`
            : `Following ${series.title}, reading from ${result.sourceName}. MangaDex has no close match, so its numbers come from ${result.sourceName} alone.`
      );
      onFollowed();
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'could not follow it');
    }
  }

  /** Linked on this screen — the server's "unlinked" is out of date once pressed. */
  const needsSource = (r: BrowseResult) => r.unlinked === true && followed[keyOf(r)] === undefined;
  /*
   * A followed series with no source counts as not followed *here*: its only
   * useful button is the one that links this copy to it, and a Read button
   * would open a chapter list that cannot exist yet.
   */
  const followingOf = (r: BrowseResult) => followed[keyOf(r)] ?? (needsSource(r) ? null : r.following);

  // Opened on a source from Manage extensions: that source, on Popular, at the list.
  useEffect(() => {
    if (!pick || !state || (pick.source !== KEPT && !state.sources.some((s) => s.id === pick.source))) return;
    setDetail(null);
    setSub('popular');
    void choose(pick.source);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pick?.at, state === null]);

  useEffect(() => {
    if (!search) return;
    setDetail(null);
    setSub('search');
  }, [search?.at]);

  if (problem) return <p className="banner">{problem}</p>;
  if (!state) return <p className="empty">Asking your sources what they have…</p>;
  if (state.sources.length === 0) {
    return (
      <p className="empty">
        No sources in the languages you read. Install an extension, or widen your languages.{' '}
        {onExtensions && (
          <button className="btn subtle" onClick={onExtensions}>
            Manage extensions
          </button>
        )}
      </p>
    );
  }

  const subs: Sub[] = ['popular', ...(source?.supportsLatest ? (['latest'] as const) : []), 'search'];
  const subLabel = (s: Sub) => (keptSelected && s === 'popular' ? 'Everything kept' : SUB_LABEL[s]);

  function chooseHide(next: string[]) {
    setHide(next);
    saveHiddenTags(next);
  }

  return (
    <div className="card manga-browse">
      {note && <p className="meta">{note}</p>}

      {detail && (
        <SeriesDetail
          key={keyOf(detail.result)}
          result={detail.result}
          others={detail.others}
          following={followingOf(detail.result)}
          onBack={back}
          onOpen={(o) =>
            setDetail({ result: o, others: [detail.result, ...detail.others.filter((x) => keyOf(x) !== keyOf(o))] })
          }
          onFollow={follow}
          onRead={onRead}
        />
      )}

      <div hidden={detail !== null}>
      <div className="row">
        <label className="meta" htmlFor="manga-browse-source">
          Browse from
        </label>
        <select id="manga-browse-source" value={state.selected ?? ''} onChange={(e) => void choose(e.target.value)}>
          <option value={KEPT}>Local collection</option>
          {state.sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        {/* Beside the list of sources, which is where you notice you want another. */}
        {onExtensions && (
          <button className="btn subtle" onClick={onExtensions}>
            Manage extensions
          </button>
        )}
      </div>

      <div className="tabs" role="tablist">
        {subs.map((s) => (
          <button key={s} role="tab" aria-selected={sub === s} className={`tab${sub === s ? ' on' : ''}`} onClick={() => setSub(s)}>
            {subLabel(s)}
          </button>
        ))}
        {sub !== 'search' && !keptSelected && (
          <button
            className={`manga-browse-hide${hide.length > 0 ? ' on' : ''}`}
            onClick={() => setHideOpen((o) => !o)}
            aria-expanded={hideOpen}
            aria-label={hide.length > 0 ? `Hidden tags: ${hide.join(', ')}` : 'Hide tags'}
            title={hide.length > 0 ? `Hiding ${hide.join(', ')}` : 'Hide tags you don\u2019t want to see'}
          >
            <Icon.filter />
          </button>
        )}
      </div>
      {hideOpen && sub !== 'search' && <HideTags hide={hide} onChange={chooseHide} />}

      {keptSelected && sub !== 'search' && <KeptList following={followingOf} onOpen={open} />}
      {source && sub !== 'search' && (
        <SourceList
          key={`${source.id}:${sub}:${hide.join('|')}`}
          sourceId={source.id}
          type={sub}
          hide={hide}
          following={followingOf}
          onOpen={open}
        />
      )}
      {sub === 'search' && (
        <Search state={state} following={followingOf} onOpen={open} asked={search ?? null} />
      )}
      </div>
    </div>
  );
}

const keyOf = (r: { sourceName: string; id: string }) => `${r.sourceName}:${r.id}`;

/** " (Adult 3, BL 2)", or nothing from a server that does not say. */
function byTag(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([tag, n]) => `${tag} ${n}`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/* ---- Tags to hide ---- */

/**
 * Ecchi, Mature and Adult first, as switches that stay in place; then any other
 * tag hidden, tapped to show it again; then quick picks, your library's own
 * tags and the common ones, tapped to hide; and a box for anything else.
 */
function HideTags({ hide, onChange }: { hide: string[]; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const [libraryTags, setLibraryTags] = useState<string[]>([]);

  useEffect(() => {
    // The tags your library's series carry, most common first, as suggestions.
    manga.list().then(
      (lib) => {
        const counts = new Map<string, number>();
        for (const s of lib.series) for (const tag of s.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
        setLibraryTags([...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag));
      },
      () => undefined
    );
  }, []);

  const on = (tag: string) => hide.some((h) => h.toLowerCase() === tag.toLowerCase());
  const toggle = (tag: string) => onChange(on(tag) ? hide.filter((h) => h.toLowerCase() !== tag.toLowerCase()) : [...hide, tag]);
  const others = hide.filter((t) => !isFirstTag(t));
  const picks: string[] = [];
  for (const tag of [...COMMON_TAGS, ...libraryTags]) {
    if (!on(tag) && !isFirstTag(tag) && !picks.some((p) => p.toLowerCase() === tag.toLowerCase())) picks.push(tag);
  }

  function add(event: FormEvent) {
    event.preventDefault();
    const typed = draft.replace(/\s+/g, ' ').trim();
    // "romance" typed is the Romance on offer, spelled as sources spell it.
    const tag = picks.find((p) => p.toLowerCase() === typed.toLowerCase()) ?? typed;
    if (tag && !on(tag)) onChange([...hide, tag]);
    setDraft('');
  }

  return (
    <div className="manga-hide-tags">
      <p className="meta">
        Hidden from Popular and Latest on this device. Some sources tag violent series Mature too, such as Jujutsu
        Kaisen and Berserk.
      </p>
      <div className="manga-shelf-chips">
        {FIRST_TAGS.map((tag) => (
          <button key={tag} className={`manga-shelf-chip${on(tag) ? ' on' : ''}`} aria-pressed={on(tag)} onClick={() => toggle(tag)}>
            {tag}
          </button>
        ))}
        {others.map((tag) => (
          <button key={tag} className="manga-shelf-chip on" aria-pressed onClick={() => toggle(tag)} title={`Show ${tag} again`}>
            {tag} ×
          </button>
        ))}
      </div>
      {picks.length > 0 && (
        <div className="manga-shelf-chips">
          {picks.slice(0, 14).map((tag) => (
            <button key={tag} className="manga-shelf-chip" aria-pressed={false} onClick={() => toggle(tag)} title={`Hide ${tag}`}>
              + {tag}
            </button>
          ))}
        </div>
      )}
      <form className="row manga-hide-add" onSubmit={add}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          list="manga-hide-suggest"
          placeholder="Another tag to hide"
          aria-label="Another tag to hide"
          maxLength={40}
        />
        <button className="btn subtle" disabled={!draft.trim()}>
          Hide
        </button>
        <datalist id="manga-hide-suggest">
          {picks.map((tag) => (
            <option key={tag} value={tag} />
          ))}
        </datalist>
      </form>
    </div>
  );
}

/* ---- On this PC ---- */

function KeptList({
  following,
  onOpen,
}: {
  following: (r: BrowseResult) => string | null;
  onOpen: (r: BrowseResult) => void;
}) {
  const [results, setResults] = useState<BrowseResult[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { countOf: chaptersOf, seen } = useChapterCounts(results ?? []);

  useEffect(() => {
    manga.kept().then(
      (got) => setResults(got.results),
      (e: unknown) => setProblem(e instanceof Error ? e.message : 'could not list what is kept')
    );
  }, []);

  if (problem) return <p className="banner">{problem}</p>;
  if (!results) return <p className="empty">Loading…</p>;
  if (results.length === 0) {
    return (
      <p className="empty">
        Nothing is in the Local collection yet. Open a series, then <strong>Keep every chapter in the Local collection</strong>{' '}
        from the ⋯ menu on its chapter list, and it shows up here for everyone who shares this Blue Everything.
      </p>
    );
  }
  return (
    <>
      <p className="meta">
        {results.length} series in the Local collection, every chapter, for everyone who shares it. They read even when their site is down.
      </p>
      <div className="manga-browse-grid">
        {results.map((r) => (
          <Tile
            key={keyOf(r)}
            result={r}
            title={r.title}
            chapters={chaptersOf(r)}
            following={following(r) !== null}
            onOpen={() => onOpen(r)}
            seen={seen}
          />
        ))}
      </div>
    </>
  );
}

/* ---- Popular and Recently released ---- */

function SourceList({
  sourceId,
  type,
  hide,
  following,
  onOpen,
}: {
  sourceId: string;
  type: 'popular' | 'latest';
  hide: string[];
  following: (r: BrowseResult) => string | null;
  onOpen: (r: BrowseResult) => void;
}) {
  const [results, setResults] = useState<BrowseResult[]>([]);
  const [page, setPage] = useState(0);
  const [more, setMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [hidden, setHidden] = useState(0);
  const [hiddenBy, setHiddenBy] = useState<Record<string, number>>({});
  const [unchecked, setUnchecked] = useState(0);
  const { countOf: chaptersOf, seen } = useChapterCounts(results);

  async function load(next: number) {
    setLoading(true);
    setProblem(null);
    try {
      const got = await manga.browse.list(sourceId, type, next, hide);
      setHidden((n) => n + (got.hidden ?? 0));
      setHiddenBy((was) => {
        const sum = { ...was };
        for (const [tag, n] of Object.entries(got.hiddenBy ?? {})) sum[tag] = (sum[tag] ?? 0) + n;
        return sum;
      });
      // Only the latest page's: an earlier page's unknowns are known by now.
      setUnchecked(got.unchecked ?? 0);
      // A source's next page often repeats the tail of the last; shown once.
      setResults((rs) => {
        const seen = new Set(rs.map(keyOf));
        return [...rs, ...got.results.filter((r) => !seen.has(keyOf(r)))];
      });
      setPage(next);
      setMore(got.hasNextPage);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'the source did not answer');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(1);
    // Keyed by the parent on source and list, so this runs once per list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      {problem && <p className="banner">{problem}</p>}
      {results.length === 0 && loading && <p className="empty">Loading…</p>}
      {results.length === 0 && !loading && !problem && (
        <p className="empty">
          {hidden > 0 ? 'Everything on this page had a tag you hide.' : 'This source listed nothing.'}
        </p>
      )}
      {hide.length > 0 && (hidden > 0 || unchecked > 0) && (
        <p className="meta">
          {hidden > 0 ? `${hidden} hidden${byTag(hiddenBy)}.` : ''}
          {unchecked > 0
            ? ` ${unchecked} could not be checked in time and are shown; they will be checked next time.`
            : ''}
        </p>
      )}
      <div className="manga-browse-grid">
        {results.map((r) => (
          <Tile
            key={keyOf(r)}
            result={r}
            title={r.title}
            chapters={chaptersOf(r)}
            following={following(r) !== null}
            onOpen={() => onOpen(r)}
            seen={seen}
          />
        ))}
      </div>
      {more && (results.length > 0 || hidden > 0) && (
        <button className="btn" disabled={loading} onClick={() => void load(page + 1)}>
          {loading ? 'Loading…' : 'More'}
        </button>
      )}
    </>
  );
}

/**
 * A cover, its title, and how many chapters it has: what a result is, in every
 * tab. There is no Follow button. Following is done from the series' page,
 * after looking at it, which is where you find out whether it is the right one
 * and whether you want to read it at all.
 */
function Tile({
  result,
  title,
  chapters,
  following,
  onOpen,
  seen,
}: {
  result: BrowseResult;
  title: string;
  /** A count, null when it could not be found, undefined while it is being asked for. */
  chapters: number | null | undefined;
  following: boolean;
  onOpen: () => void;
  /** Watches the tile, so its count is asked for once it is on screen. */
  seen: (el: HTMLElement | null) => void;
}) {
  const count =
    chapters === undefined ? '\u2026' : chapters === null ? '' : chapters === 1 ? '1 chapter' : `${chapters} chapters`;
  return (
    <div className="manga-browse-tile" ref={seen} data-id={result.id}>
      {/* One button: a real one, so it takes Enter and is announced as something to press. */}
      <button className="manga-browse-open" onClick={onOpen} title={title}>
        {/* As wide as its column, so the columns set the spacing rather than a fixed-size cover inside them. */}
        <Cover path={result.coverPath} title={title} fill />
        <span className="title manga-browse-title">{title}</span>
        <span className="meta manga-browse-chapters">
          {count}
          {following && <span className="manga-flag good">{count ? ' · ' : ''}following</span>}
        </span>
      </button>
    </div>
  );
}

/**
 * Chapter counts for a list of results: what the server had stored comes with
 * them, and the rest are asked for after the page is drawn, six at a time, one
 * request in flight, so they fill in rather than holding the page up.
 */
function useChapterCounts(results: readonly BrowseResult[]) {
  const [found, setFound] = useState<Record<string, number | null>>({});
  /*
   * Only for tiles that have been on screen. A search can return two hundred
   * results, and a count not stored is a request to that series' site: asking
   * for all of them is two hundred requests for one search, which is how a
   * source starts refusing. Popular's forty-odd are seen as you scroll.
   */
  const [seenIds, setSeenIds] = useState<ReadonlySet<string>>(new Set());
  const observer = useRef<IntersectionObserver | null>(null);
  if (observer.current === null && typeof IntersectionObserver !== 'undefined') {
    observer.current = new IntersectionObserver(
      (entries) => {
        const ids = entries.filter((e) => e.isIntersecting).map((e) => (e.target as HTMLElement).dataset.id ?? '');
        if (ids.length === 0) return;
        for (const e of entries) if (e.isIntersecting) observer.current?.unobserve(e.target);
        // A new set only when something new was seen, or each report would re-render.
        setSeenIds((s) => (ids.every((id) => s.has(id)) ? s : new Set([...s, ...ids])));
      },
      // A screen's worth ahead, so a count is usually there by the time its tile is.
      { rootMargin: '0px 0px 100% 0px' }
    );
  }
  useEffect(() => () => observer.current?.disconnect(), []);
  // Without an observer at all, every tile counts as seen: a count late is better than none.
  // Stable, so React does not detach and re-attach it on every render.
  const seen = useCallback((el: HTMLElement | null) => {
    if (el) observer.current?.observe(el);
  }, []);
  const isSeen = (id: string) => observer.current === null || seenIds.has(id);
  const asked = useRef(new Set<string>());
  const running = useRef(false);
  const alive = useRef(true);
  // Read by the loop each time round, so results added by "More" while it runs are counted too.
  const latest = useRef(results);
  latest.current = results;
  const isSeenNow = useRef(isSeen);
  isSeenNow.current = isSeen;
  useEffect(() => () => {
    alive.current = false;
  }, []);

  useEffect(() => {
    if (running.current) return;
    const todo = () =>
      latest.current
        .filter((r) => r.chapters == null && /^\d+$/.test(r.id) && !asked.current.has(r.id) && isSeenNow.current(r.id))
        .map((r) => r.id);
    if (todo().length === 0) return;
    running.current = true;
    void (async () => {
      for (let batch = todo().slice(0, 6); batch.length > 0 && alive.current; batch = todo().slice(0, 6)) {
        batch.forEach((id) => asked.current.add(id));
        try {
          const { counts } = await manga.browse.chapters(batch);
          if (alive.current) setFound((f) => ({ ...f, ...counts }));
        } catch {
          // An older server, or Suwayomi stopped: those stay blank.
          if (alive.current) setFound((f) => ({ ...f, ...Object.fromEntries(batch.map((id) => [id, null])) }));
        }
      }
      running.current = false;
    })();
  }, [results, seenIds]);

  const countOf = (r: BrowseResult): number | null | undefined => {
    if (typeof r.chapters === 'number') return r.chapters;
    if (r.id in found) return found[r.id];
    // An older server sends no field at all; nothing is coming for those.
    return r.chapters === undefined || !/^\d+$/.test(r.id) ? null : undefined;
  };
  return { countOf, seen };
}

/* ---- Search ---- */

/** Where a change sits: `3` for a top-level filter, `3.7` for one inside a group. */
const slot = (position: number, inner?: number) => (inner === undefined ? `${position}` : `${position}.${inner}`);

function Search({
  state,
  following,
  onOpen,
  asked,
}: {
  state: BrowseState;
  following: (r: BrowseResult) => string | null;
  onOpen: (r: BrowseResult, others: BrowseResult[]) => void;
  asked: { query: string; at: number } | null;
}) {
  const [query, setQuery] = useState('');
  const box = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<GroupedSearch | null>(null);
  const [searching, setSearching] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // The app's filters, which apply to every source.
  const [allLanguages, setAllLanguages] = useState(false);
  /** Sources left out. Empty means all — so a newly installed source is included. */
  const [leftOut, setLeftOut] = useState<Set<string>>(new Set());
  const [hideFollowed, setHideFollowed] = useState(false);

  // The chosen source's own filters.
  const [filters, setFilters] = useState<SourceFilter[] | null>(null);
  const [filtersProblem, setFiltersProblem] = useState<string | null>(null);
  const [changes, setChanges] = useState<Record<string, FilterChange>>({});

  const chosen = state.sources.find((s) => s.id === state.selected) ?? null;

  useEffect(() => {
    setFilters(null);
    setChanges({});
    setFiltersProblem(null);
    if (!chosen) return;
    manga.browse.filters(chosen.id).then(
      (r) => setFilters(r.filters),
      (e: unknown) => setFiltersProblem(e instanceof Error ? e.message : 'could not read its filters')
    );
  }, [chosen?.id]);

  const set = (change: FilterChange, isDefault: boolean) =>
    setChanges((c) => {
      const next = { ...c };
      const at = slot(change.position, change.inner);
      // A value put back to its default is no change at all, and sending it
      // would count as "a filter applied" on a search that filters nothing.
      if (isDefault) delete next[at];
      else next[at] = change;
      return next;
    });

  const changeList = Object.values(changes);

  // A search asked for from the library: filled in and run, so it lands with
  // the answers rather than an empty box.
  useEffect(() => {
    if (!asked) return;
    /*
     * The top bar's 🔍 asks with nothing: a search you are about to type, so the
     * box is focused rather than anything run — and what was there is kept,
     * since tapping it again should not throw away the last search's words.
     */
    if (!asked.query) {
      box.current?.focus();
      return;
    }
    setQuery(asked.query);
    void run(undefined, asked.query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked?.at]);

  async function run(event?: React.FormEvent, text: string = query) {
    event?.preventDefault();
    const words = text.trim();
    if (!words && changeList.length === 0) return;
    setSearching(true);
    setProblem(null);
    try {
      setResult(
        await manga.browse.search({
          query: words,
          source: chosen?.id ?? null,
          changes: changeList,
          allLanguages,
          only: leftOut.size === 0 ? null : state.sources.map((s) => s.id).filter((id) => !leftOut.has(id)),
        })
      );
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'the search failed');
    } finally {
      setSearching(false);
    }
  }

  const groups = (result?.groups ?? []).filter(
    (g) => !hideFollowed || !g.entries.map(following).find(Boolean)
  );
  const hidden = (result?.groups.length ?? 0) - groups.length;
  // Counted for each group's first entry, which is the copy its tile opens.
  const leads = useMemo(() => groups.map((g) => g.entries[0]!), [result, hideFollowed]);
  const { countOf: chaptersOf, seen } = useChapterCounts(leads);
  const active = changeList.length + leftOut.size + (allLanguages ? 1 : 0) + (hideFollowed ? 1 : 0);

  return (
    <>
      <form className="row" onSubmit={run}>
        <input
          ref={box}
          value={query}
          placeholder="Title…"
          aria-label="Title to search every source for"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" className="btn primary" disabled={searching || (!query.trim() && changeList.length === 0)}>
          {searching ? 'Searching…' : 'Search'}
        </button>
      </form>

      <details className="manga-compare-other">
        <summary>Filters{active > 0 ? ` (${active} on)` : ''}</summary>

        <p className="meta strong">Every source</p>
        <div className="manga-flags">
          <label className="meta">
            <input type="checkbox" checked={allLanguages} onChange={(e) => setAllLanguages(e.target.checked)} /> Every
            language, not just {state.readLanguages.map(languageName).join(', ') || 'yours'}
          </label>
          <label className="meta">
            <input type="checkbox" checked={hideFollowed} onChange={(e) => setHideFollowed(e.target.checked)} /> Hide
            series I follow
          </label>
        </div>
        <p className="meta">Sources to ask:</p>
        <div className="manga-flags">
          {state.sources.map((s) => {
            const on = !leftOut.has(s.id);
            return (
              <button
                key={s.id}
                type="button"
                className={on ? 'btn primary' : 'btn subtle'}
                // The chosen source is always asked — it is the one whose own
                // filters apply, and a search that left it out would drop them.
                disabled={s.id === chosen?.id}
                onClick={() =>
                  setLeftOut((l) => {
                    const next = new Set(l);
                    if (on) next.add(s.id);
                    else next.delete(s.id);
                    return next;
                  })
                }
              >
                {s.name}
              </button>
            );
          })}
        </div>

        {chosen && (
          <>
            <p className="meta strong">{chosen.name}'s own filters — they apply to {chosen.name} only</p>
            {filtersProblem && <p className="meta">{filtersProblem}</p>}
            {!filters && !filtersProblem && <p className="meta">Reading its filters…</p>}
            {filters && filters.length === 0 && <p className="meta">It declares none.</p>}
            {filters && (
              <div className="manga-filters">
                {filters.map((f, position) => (
                  <FilterControl key={position} filter={f} position={position} changes={changes} onChange={set} />
                ))}
              </div>
            )}
            {changeList.length > 0 && (
              <button type="button" className="btn subtle" onClick={() => setChanges({})}>
                Reset {chosen.name}'s filters
              </button>
            )}
          </>
        )}
      </details>

      {problem && <p className="banner">{problem}</p>}

      {result && (
        <p className="meta">
          {result.onlyPreferred
            ? `Only ${result.preferred?.name ?? 'the chosen source'} was asked — the others need words to search for, and its filters mean nothing to them.`
            : `Asked ${result.searched} source${result.searched === 1 ? '' : 's'}${
                result.languages ? ` in ${result.languages.map(languageName).join(', ')}` : ' in every language'
              }${result.skipped ? ` — ${result.skipped} in other languages left out` : ''}.`}
          {result.filtersApplied > 0 &&
            ` ${result.filtersApplied} of ${result.preferred?.name}'s filters applied to its results.`}
          {result.filtersDropped > 0 && ` ${result.filtersDropped} could not be applied and were ignored.`}
          {hidden > 0 && ` ${hidden} you follow hidden.`}
        </p>
      )}
      {result?.preferredProblem && (
        <p className="banner">
          {result.preferred?.name} failed: {result.preferredProblem}. The other sources' results are below.
        </p>
      )}
      {result && groups.length === 0 && <p className="empty">Nothing matched.</p>}

      {/*
        * The same tiles as Popular and Latest: cover, title, chapter count.
        * Which sources have it, the other editions and following are all on
        * the series' page, which a tap opens with the other copies beside it.
        */}
      {groups.length > 0 && (
        <div className="manga-browse-grid">
          {groups.map((g) => {
            const lead = g.entries[0]!;
            // From the entries, not the group's own field: `following` here already
            // knows that a followed series with no source is not followed *here*.
            const followingId = g.entries.map(following).find(Boolean) ?? null;
            return (
              <Tile
                key={g.key}
                result={lead}
                title={g.title}
                chapters={chaptersOf(lead)}
                following={followingId !== null}
                onOpen={() => onOpen(lead, g.entries.slice(1))}
                seen={seen}
              />
            );
          })}
        </div>
      )}
    </>
  );
}

/* ---- one filter, drawn from what the source declared ---- */

const TRI_NEXT: Record<TriState, TriState> = { ignore: 'include', include: 'exclude', exclude: 'ignore' };
const TRI_GLYPH: Record<TriState, string> = { ignore: '', include: '✓ ', exclude: '✕ ' };

function FilterControl({
  filter,
  position,
  inner,
  changes,
  onChange,
}: {
  filter: SourceFilter;
  position: number;
  inner?: number;
  changes: Record<string, FilterChange>;
  onChange: (change: FilterChange, isDefault: boolean) => void;
}) {
  const current = changes[slot(position, inner)];
  const base = { position, ...(inner === undefined ? {} : { inner }) };

  switch (filter.kind) {
    case 'separator':
      return null;
    case 'header':
      return filter.name ? <p className="meta">{filter.name}</p> : null;
    case 'checkbox': {
      const on = current?.checkbox ?? filter.default;
      return (
        <button
          type="button"
          className={on ? 'btn primary' : 'btn subtle'}
          onClick={() => onChange({ ...base, checkbox: !on }, !on === filter.default)}
        >
          {filter.name}
        </button>
      );
    }
    case 'tristate': {
      // Include, exclude, or neither — a genre you want, one you do not, and
      // one you do not mind. The glyph carries the state as well as the colour.
      const value = current?.tristate ?? filter.default;
      const next = TRI_NEXT[value];
      return (
        <button
          type="button"
          className={value === 'ignore' ? 'btn subtle' : value === 'include' ? 'btn primary' : 'btn danger'}
          title={value === 'ignore' ? 'Either way — tap to require' : value === 'include' ? 'Required — tap to exclude' : 'Excluded — tap to clear'}
          onClick={() => onChange({ ...base, tristate: next }, next === filter.default)}
        >
          {TRI_GLYPH[value]}
          {filter.name}
        </button>
      );
    }
    case 'select': {
      const value = current?.select ?? filter.default;
      return (
        <label className="meta manga-filter-field">
          {filter.name}{' '}
          <select value={value} onChange={(e) => onChange({ ...base, select: Number(e.target.value) }, Number(e.target.value) === filter.default)}>
            {filter.values.map((v, i) => (
              <option key={i} value={i}>
                {v || '—'}
              </option>
            ))}
          </select>
        </label>
      );
    }
    case 'sort': {
      const value = current?.sort ?? filter.default ?? { index: 0, ascending: false };
      const isDefault = (s: { index: number; ascending: boolean }) =>
        filter.default !== null && s.index === filter.default.index && s.ascending === filter.default.ascending;
      return (
        <label className="meta manga-filter-field">
          {filter.name}{' '}
          <select
            value={value.index}
            onChange={(e) => {
              const s = { index: Number(e.target.value), ascending: value.ascending };
              onChange({ ...base, sort: s }, isDefault(s));
            }}
          >
            {filter.values.map((v, i) => (
              <option key={i} value={i}>
                {v}
              </option>
            ))}
          </select>{' '}
          <button
            type="button"
            className="btn subtle"
            onClick={() => {
              const s = { index: value.index, ascending: !value.ascending };
              onChange({ ...base, sort: s }, isDefault(s));
            }}
          >
            {value.ascending ? 'ascending' : 'descending'}
          </button>
        </label>
      );
    }
    case 'text': {
      const value = current?.text ?? filter.default;
      return (
        <label className="meta manga-filter-field">
          {filter.name}{' '}
          <input value={value} onChange={(e) => onChange({ ...base, text: e.target.value }, e.target.value === filter.default)} />
        </label>
      );
    }
    case 'group': {
      const on = filter.filters.filter((_, i) => changes[slot(position, i)]).length;
      return (
        <details className="manga-filter-group">
          <summary className="meta">
            {filter.name}
            {on > 0 ? ` (${on} set)` : ''}
          </summary>
          <div className="manga-flags">
            {filter.filters.map((f, i) => (
              <FilterControl key={i} filter={f} position={position} inner={i} changes={changes} onChange={onChange} />
            ))}
          </div>
        </details>
      );
    }
  }
}
