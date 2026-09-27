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
import { useEffect, useRef, useState } from 'react';
import { Cover } from './Cover';
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

export function Browse({
  onFollowed,
  onRead,
  search,
}: {
  onFollowed: () => void;
  onRead: (seriesId: string) => void;
  /**
   * A search asked for from elsewhere — the library's Details on a series with
   * no source yet. `at` makes asking twice for the same title a second request.
   */
  search?: { query: string; at: number } | null;
}) {
  const [state, setState] = useState<BrowseState | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sub, setSub] = useState<Sub>('popular');
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

  const source = state?.sources.find((s) => s.id === state.selected) ?? null;

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
        No sources in the languages you read. Install an extension under Library → Where chapters come from, or widen
        your languages.
      </p>
    );
  }

  const subs: Sub[] = ['popular', ...(source?.supportsLatest ? (['latest'] as const) : []), 'search'];

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
          {state.sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      <div className="tabs" role="tablist">
        {subs.map((s) => (
          <button key={s} role="tab" aria-selected={sub === s} className={`tab${sub === s ? ' on' : ''}`} onClick={() => setSub(s)}>
            {SUB_LABEL[s]}
          </button>
        ))}
      </div>

      {source && sub !== 'search' && (
        <SourceList
          key={`${source.id}:${sub}`}
          sourceId={source.id}
          type={sub}
          following={followingOf}
          onFollow={follow}
          onRead={onRead}
          onOpen={open}
        />
      )}
      {sub === 'search' && (
        <Search state={state} following={followingOf} onFollow={follow} onRead={onRead} onOpen={open} asked={search ?? null} />
      )}
      </div>
    </div>
  );
}

const keyOf = (r: { sourceName: string; id: string }) => `${r.sourceName}:${r.id}`;

/* ---- Popular and Recently released ---- */

function SourceList({
  sourceId,
  type,
  following,
  onFollow,
  onRead,
  onOpen,
}: {
  sourceId: string;
  type: 'popular' | 'latest';
  following: (r: BrowseResult) => string | null;
  onFollow: (r: BrowseResult) => Promise<void>;
  onRead: (id: string) => void;
  onOpen: (r: BrowseResult) => void;
}) {
  const [results, setResults] = useState<BrowseResult[]>([]);
  const [page, setPage] = useState(0);
  const [more, setMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);

  async function load(next: number) {
    setLoading(true);
    setProblem(null);
    try {
      const got = await manga.browse.list(sourceId, type, next);
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
      {results.length === 0 && !loading && !problem && <p className="empty">This source listed nothing.</p>}
      <div className="manga-browse-grid">
        {results.map((r) => (
          <Tile key={keyOf(r)} result={r} following={following(r)} onFollow={onFollow} onRead={onRead} onOpen={onOpen} />
        ))}
      </div>
      {more && results.length > 0 && (
        <button className="btn" disabled={loading} onClick={() => void load(page + 1)}>
          {loading ? 'Loading…' : 'More'}
        </button>
      )}
    </>
  );
}

function Tile({
  result,
  following,
  onFollow,
  onRead,
  onOpen,
}: {
  result: BrowseResult;
  following: string | null;
  onFollow: (r: BrowseResult) => Promise<void>;
  onRead: (id: string) => void;
  onOpen: (r: BrowseResult) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="manga-browse-tile">
      {/* The cover and title are one button: a real one, so it takes Enter and is announced as something to press. */}
      <button className="manga-browse-open" onClick={() => onOpen(result)} title={result.title}>
        <Cover path={result.coverPath} title={result.title} size={110} />
        <span className="title manga-browse-title">{result.title}</span>
      </button>
      {following ? (
        <button className="btn subtle" onClick={() => onRead(following)}>
          Following · Read
        </button>
      ) : (
        <button
          className="btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onFollow(result);
            setBusy(false);
          }}
        >
          {busy ? 'Following…' : result.unlinked ? 'Read from here' : 'Follow'}
        </button>
      )}
    </div>
  );
}

/* ---- Search ---- */

/** Where a change sits: `3` for a top-level filter, `3.7` for one inside a group. */
const slot = (position: number, inner?: number) => (inner === undefined ? `${position}` : `${position}.${inner}`);

function Search({
  state,
  following,
  onFollow,
  onRead,
  onOpen,
  asked,
}: {
  state: BrowseState;
  following: (r: BrowseResult) => string | null;
  onFollow: (r: BrowseResult) => Promise<void>;
  onRead: (id: string) => void;
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

      {groups.map((g) => {
        const lead = g.entries[0];
        // From the entries, not the group's own field: `following` here already
        // knows that a followed series with no source is not followed *here*.
        const followingId = g.entries.map(following).find(Boolean) ?? null;
        // One site often lists a series more than once — the original and an
        // "(Official)" or colour edition — so sources are counted once each.
        // The editions themselves are all under "a different source".
        const sources = [...new Set(g.entries.map((e) => e.sourceName))];
        return (
          <div className="manga-row" key={g.key}>
            <button className="manga-browse-open" onClick={() => onOpen(lead, g.entries.slice(1))} aria-label={`About ${g.title}`}>
              <Cover path={lead.coverPath} title={g.title} size={48} />
            </button>
            <div className="manga-row-text">
              <button className="manga-browse-open title truncate" onClick={() => onOpen(lead, g.entries.slice(1))}>
                {g.title}
                {followingId && <span className="manga-flag good"> · following</span>}
                {!followingId && lead.unlinked && <span className="meta"> · in your list, with no source yet</span>}
              </button>
              <span className="meta">
                {g.preferred ? '' : `not on ${chosen?.name ?? 'the chosen source'} · `}
                on {sources.length} source{sources.length === 1 ? '' : 's'}: {sources.join(', ')}
              </span>
              {g.entries.length > 1 && !followingId && (
                <details className="manga-compare-other">
                  <summary>
                    {sources.length > 1 ? `${lead.unlinked ? 'Read' : 'Follow'} from a different source` : `Other editions on ${lead.sourceName}`}
                  </summary>
                  {g.entries.slice(1).map((e) => (
                    <div className="row between" key={keyOf(e)}>
                      <span className="meta truncate">
                        {e.sourceName} — {e.title}
                      </span>
                      <button className="btn subtle" onClick={() => void onFollow(e)}>
                        {e.unlinked ? 'Read' : 'Follow'} from here
                      </button>
                    </div>
                  ))}
                </details>
              )}
            </div>
            <div className="manga-row-actions">
              {followingId ? (
                <button className="btn subtle" onClick={() => onRead(followingId)}>
                  Read
                </button>
              ) : (
                <button className="btn" onClick={() => void onFollow(lead)}>
                  {lead.unlinked ? 'Read' : 'Follow'} from {lead.sourceName}
                </button>
              )}
            </div>
          </div>
        );
      })}
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
