/**
 * Your library as covers: what you follow, three across on a phone.
 *
 * It was a list of rows with four buttons each — Continue, Details, Other
 * sources, Remove — which answered every question at once and made the one you
 * came with, *what do I read next*, the hardest to see. A shelf of covers is how
 * every reading app on a phone draws this, and the reason is that you pick a
 * series by recognising it.
 *
 * Tapping a cover opens its chapter list, which already says where to pick up
 * and carries everything the row's buttons did behind its ⋯ — so nothing was
 * lost, it moved one tap in. A series with no source yet has no chapter list
 * to open, so it opens the comparison that finds one.
 *
 * ### What each tile says
 *
 * - **NEW** when the source has a chapter past the furthest you have read or are
 *   reading. Only once you have read *something*: before that every chapter is
 *   unread, and a badge on every cover says nothing.
 * - **The bar** is the newest chapter's number — red when there is one you
 *   have not read, in the accent otherwise, so the colour says the same thing
 *   as NEW from across the room.
 * - **Under it**, where you read it.
 * - **!** on the cover when the last check failed, with the reason on hover and
 *   to a screen reader — the number beside it is then older than it looks, and
 *   saying nothing about that is the failure this app is built against.
 *
 * ### Sorting, and what stays on top
 *
 * **Last read is the default**, with series that have new chapters held at the
 * top by a ticked "New chapters on top" in the same menu. That was one fixed
 * order ("new chapters first"); it is two choices now, because "what was I
 * reading" and "what has moved" are both reasons to open the shelf, and
 * unticking the box is how you get the first without the second.
 *
 * **Most to catch up on** sorts by how far the newest chapter is past where you
 * are — whole chapters between the two numbers. An estimate, since a source can
 * skip numbers or split them, and the badge says `12 NEW` from the same sum.
 *
 * ### Filters
 *
 * New chapters, **source not answering** (its last check or the last time its
 * chapters were opened failed), no source yet, and a tag. In the not-answering
 * view a cover opens the search for another source rather than a chapter list
 * that will only fail again, which is the reason to open that view.
 *
 * ### Sixty at a time
 *
 * A library brought in from another app is several hundred series, and every
 * tile fetches its cover the moment it mounts — nine hundred requests at once,
 * most of them through a Suwayomi that may still be starting. So the grid draws
 * sixty and adds sixty more as the end comes into view. The count above says
 * how many there are in all, and the filter searches all of them.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useButtonMenu } from '@app/ContextMenu';
import { Icon } from './Icons';
import type { SeriesSummary } from './manga-api';
import { Tile } from './Tile';
/*
 * The ordering lives in `shelf.ts` so the Dashboard card can use it without
 * importing this screen — see the note at the top of that file. Re-exported
 * because several other files already take these from here, and moving a file
 * should not mean editing every importer.
 */
import { NEW_FIRST_KEY, SORT_KEY, SORT_LABEL, hasNew, notAnswering, sorted, sourceHasNothing, sourceLabel, storedSort, toCatchUp, type SortKey } from './shelf';
export { hasNew, notAnswering, sourceHasNothing, sourceLabel, toCatchUp, type SortKey };

export type Show = 'all' | 'starred' | 'new' | 'broken' | 'empty' | 'unlinked';

const SHOW_LABEL: Record<Show, string> = {
  all: 'All',
  /*
   * Second, not last. The other three are fault-finding — what is behind, what
   * is broken, what has no source — and this is the one you would actually
   * leave on, so it sits next to All rather than at the end of a row of
   * problems.
   */
  starred: 'Favourites',
  new: 'New chapters',
  broken: 'Source not answering',
  /*
   * Its own filter, because it is its own problem with its own fix. "Not
   * answering" means try again; this means the link is wrong — the series was
   * never on that source, or has been taken off it — and no amount of waiting
   * mends it.
   */
  empty: 'Source has nothing for it',
  unlinked: 'No source yet',
};

/** Divides by three, four, five, six and ten, so a page ends on a full row at every width. */
const PAGE = 60;


const SHOW_KEY = 'manga.library-show';
const SHELF_KEY = 'manga.library-shelf';

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Private mode, or storage blocked: the default is a fine answer.
    return null;
  }
}

function keep(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Kept for this visit only.
  }
}

function storedShow(): Show {
  const v = stored(SHOW_KEY);
  return v && v in SHOW_LABEL ? (v as Show) : 'all';
}

export function Library({
  series,
  onOpen,
  onDetails,
  onCompare,
  onRemove,
  filter,
  onFilter,
  libraries = [],
  onShelves,
}: {
  series: SeriesSummary[];
  onOpen: (s: SeriesSummary) => void;
  onDetails: (s: SeriesSummary) => void;
  onCompare: (s: SeriesSummary) => void;
  onRemove: (s: SeriesSummary) => void;
  /** The shelves, with counts. Empty on a server older than them. */
  libraries?: Array<{ id: string; name: string; count: number; hidden?: boolean }>;
  /** Set the whole set of shelves for one series — a whole-list write. */
  onShelves?: (s: SeriesSummary, libraries: string[]) => void;
  /** Held by the screen, so the Dashboard panel can hand a title in. */
  filter: string;
  onFilter: (text: string) => void;
}) {
  const [sort, setSort] = useState<SortKey>(storedSort);
  const [newFirst, setNewFirst] = useState(() => stored(NEW_FIRST_KEY) !== '0');
  const [show, setShow] = useState<Show>(storedShow);
  /*
   * Which shelf is being looked at, or null for everything you follow.
   *
   * Per device like the sort and the other filters — which shelf you are on is
   * a view of one screen, not a fact about the library. A shelf since deleted
   * reads as null rather than emptying the grid, the same rule the panel ids
   * follow.
   */
  /*
   * `|| null`, and not for tidiness. "Everything" is stored as the empty
   * string, which `getItem` hands back as `''` rather than null — so a reload
   * filtered the grid for a shelf whose id is `''`, matched nothing, and showed
   * an empty library with the count saying "0 of 891". Only on a reload, which
   * is exactly when nobody is watching the thing they just changed.
   */
  const [shelf, setShelf] = useState<string | null>(() => stored(SHELF_KEY) || null);
  const hiddenShelves = useMemo(
    () => new Set(libraries.filter((l) => l.hidden).map((l) => l.id)),
    [libraries]
  );
  // Not remembered: a tag is a question you are asking now, and coming back to
  // a shelf silently narrowed to "Isekai" would read as series gone missing.
  const [tag, setTag] = useState<string | null>(null);

  const sortMenu = useButtonMenu(() => [
    ...(Object.keys(SORT_LABEL) as SortKey[]).map((key) => ({
      label: `${key === sort ? '✓ ' : ' '}${SORT_LABEL[key]}`,
      onSelect: () => {
        setSort(key);
        keep(SORT_KEY, key);
      },
    })),
    {
      label: `${newFirst ? '☑' : '☐'} New chapters on top`,
      onSelect: () => {
        setNewFirst(!newFirst);
        keep(NEW_FIRST_KEY, newFirst ? '0' : '1');
      },
    },
  ]);

  const counts = useMemo(
    () => ({
      all: series.length,
      starred: series.filter((s) => s.favourite === true).length,
      new: series.filter(hasNew).length,
      broken: series.filter(notAnswering).length,
      empty: series.filter(sourceHasNothing).length,
      unlinked: series.filter((s) => !s.source).length,
    }),
    [series]
  );

  // Most common first, so the tags worth filtering by are at the top.
  const tags = useMemo(() => {
    const n = new Map<string, number>();
    for (const s of series) for (const t of s.tags ?? []) n.set(t, (n.get(t) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [series]);

  const shown = useMemo(() => {
    const words = filter.trim().toLowerCase();
    const matching = series.filter(
      (s) =>
        (!words ||
          s.title.toLowerCase().includes(words) ||
          (s.source?.title.toLowerCase().includes(words) ?? false)) &&
        /*
         * On a hidden shelf, so out of *Everything* — but still there when the
         * shelf itself is picked. Hidden wins over any visible shelf the same
         * series is also on: the two say opposite things and an unreliable hide
         * is worth nothing.
         */
        (shelf === null ? !s.libraries?.some((id) => hiddenShelves.has(id)) : s.libraries?.includes(shelf)) &&
        (show === 'all' ||
          (show === 'starred' && s.favourite === true) ||
          (show === 'new' && hasNew(s)) ||
          (show === 'broken' && notAnswering(s)) ||
          (show === 'empty' && sourceHasNothing(s)) ||
          (show === 'unlinked' && !s.source)) &&
        (tag === null || (s.tags ?? []).includes(tag))
    );
    return sorted(matching, sort, newFirst);
  }, [series, filter, sort, newFirst, show, tag, shelf, hiddenShelves]);

  const fresh = counts.new;
  /*
   * Is the grid showing less than everything?
   *
   * The shelf counts, and so does a hidden shelf while on *Everything* — the
   * count line read "891 series" with one of them deliberately kept out, which
   * is the stale-number-as-fact this app is against. It says "890 of 891" now,
   * and the line below says why.
   */
  const hiding = shelf === null && series.some((x) => x.libraries?.some((id) => hiddenShelves.has(id)));
  const narrowed = Boolean(filter.trim()) || show !== 'all' || tag !== null || shelf !== null || hiding;

  // A new filter or order starts from the top again.
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [filter, sort, newFirst, show, tag, shelf]);

  return (
    <div className="manga-library">
      <div className="manga-lib-controls">
        <input
          type="search"
          value={filter}
          placeholder="Title"
          aria-label="Filter your library by title"
          onChange={(e) => onFilter(e.target.value)}
        />
        <button className="btn manga-sort" onClick={sortMenu.open} aria-haspopup="menu" title={`Sorted: ${SORT_LABEL[sort]}`}>
          <Icon.sort /> Sort
        </button>
      </div>
      {sortMenu.menu}

      {/*
        Its own row above the others, because it answers a different question.
        The filters below narrow *within* what you are looking at — what is
        behind, what is broken — while this chooses what you are looking at.
        Hidden entirely when there are no shelves, so an install that has not
        made one looks exactly as it did.
      */}
      {libraries.length > 0 && (
        <div className="manga-lib-filters manga-lib-shelves" role="group" aria-label="Shelf">
          <button
            className={`manga-lib-filter${shelf === null ? ' on' : ''}`}
            aria-pressed={shelf === null}
            onClick={() => {
              setShelf(null);
              keep(SHELF_KEY, '');
            }}
          >
            Everything
          </button>
          {libraries.map((l) => (
            <button
              key={l.id}
              className={`manga-lib-filter${shelf === l.id ? ' on' : ''}`}
              aria-pressed={shelf === l.id}
              onClick={() => {
                setShelf(l.id);
                keep(SHELF_KEY, l.id);
              }}
            >
              {l.hidden ? '◌ ' : ''}
              {l.name}
              <span className="count">{l.count}</span>
            </button>
          ))}
        </div>
      )}

      <div className="manga-lib-filters" role="group" aria-label="Show">
        {(Object.keys(SHOW_LABEL) as Show[])
          // A filter with nothing in it is left off, except the one you are on.
          .filter((key) => key === 'all' || key === show || counts[key] > 0)
          .map((key) => (
            <button
              key={key}
              className={`manga-lib-filter${show === key ? ' on' : ''}${key === 'broken' ? ' warn' : ''}`}
              aria-pressed={show === key}
              onClick={() => {
                setShow(key);
                keep(SHOW_KEY, key);
              }}
            >
              {SHOW_LABEL[key]}
              {key !== 'all' && <span className="count">{counts[key]}</span>}
            </button>
          ))}
        {tags.length > 0 && (
          <select
            className={`manga-lib-tag${tag ? ' on' : ''}`}
            value={tag ?? ''}
            aria-label="Filter by tag"
            onChange={(e) => setTag(e.target.value || null)}
          >
            <option value="">Any tag</option>
            {tags.map(([name, n]) => (
              <option key={name} value={name}>
                {name} ({n})
              </option>
            ))}
          </select>
        )}
      </div>

      <p className="meta manga-lib-count">
        {narrowed ? `${shown.length} of ${series.length}` : `${series.length} series`}
        {/*
          Named rather than left as a smaller number: a count that has quietly
          dropped is the thing somebody goes looking for a bug in.
        */}
        {hiding ? ` · ${series.length - shown.length} put away` : ''}
        {fresh > 0 ? ` · ${fresh} with new chapters` : ''} · {SORT_LABEL[sort].toLowerCase()}
        {newFirst ? ', new on top' : ''}
      </p>
      {show === 'broken' && shown.length > 0 && (
        <p className="meta">
          When it was last asked — which for something you have not opened in a while may be a day or two
          ago. A failed check is retried within the hour. Tap one to find it on another source.
        </p>
      )}
      {show === 'empty' && shown.length > 0 && (
        <p className="meta">
          The source answered and has no chapters for this — usually the wrong entry was linked, or it has
          been taken off that source. Tap one to find it on another.
        </p>
      )}

      {shown.length === 0 && narrowed && (
        <p className="empty">
          Nothing in your library matches
          {filter.trim() ? ` “${filter.trim()}”` : ''}
          {show !== 'all' ? ` in ${SHOW_LABEL[show].toLowerCase()}` : ''}
          {tag ? ` tagged ${tag}` : ''}.
        </p>
      )}

      <div className="manga-lib-grid">
        {shown.slice(0, limit).map((s) => (
          <Tile
            key={s.id}
            series={s}
            onOpen={() => (show === 'broken' ? onCompare(s) : onOpen(s))}
            onDetails={() => onDetails(s)}
            onCompare={() => onCompare(s)}
            onRemove={() => onRemove(s)}
            libraries={libraries}
            onShelves={onShelves && ((ids) => onShelves(s, ids))}
          />
        ))}
      </div>
      {shown.length > limit && (
        // Keyed on the limit so it is observed afresh each time: an observer
        // reports crossings, and one still in view after a page lands would
        // otherwise never say so again.
        <ShowMore key={limit} left={shown.length - limit} onMore={() => setLimit((n) => n + PAGE)} />
      )}
    </div>
  );
}

/**
 * The end of the grid, which asks for more when it comes near the screen and
 * is a button for when it does not — an observer measures nothing in a window
 * that is not being drawn, the same list `requestAnimationFrame` is on.
 */
function ShowMore({ left, onMore }: { left: number; onMore: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const seen = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && onMore(), {
      rootMargin: '600px 0px',
    });
    seen.observe(el);
    return () => seen.disconnect();
  }, [onMore]);
  return (
    <button ref={ref} className="btn subtle manga-lib-more" onClick={onMore}>
      Show more ({left.toLocaleString()})
    </button>
  );
}

