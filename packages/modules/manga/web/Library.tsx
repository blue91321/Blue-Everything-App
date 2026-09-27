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
import { useButtonMenu, useContextMenu } from '@app/ContextMenu';
import { Cover } from './Cover';
import { Icon } from './Icons';
import { chapterText } from './judge';
import type { SeriesSummary } from './manga-api';

export type SortKey = 'read' | 'catchup' | 'updated' | 'title' | 'added';

export type Show = 'all' | 'new' | 'broken' | 'unlinked';

const SHOW_LABEL: Record<Show, string> = {
  all: 'All',
  new: 'New chapters',
  broken: 'Source not answering',
  unlinked: 'No source yet',
};

/** Divides by three, four, five, six and ten, so a page ends on a full row at every width. */
const PAGE = 60;

const SORT_LABEL: Record<SortKey, string> = {
  read: 'Last read',
  catchup: 'Most to catch up on',
  updated: 'Last updated',
  title: 'Title',
  added: 'Recently added',
};

/*
 * Remembered per device, like the folded note folders: it is a view of one
 * screen, and sorting the phone's shelf should not reorder the PC's.
 */
const SORT_KEY = 'manga.library-sort';
const NEW_FIRST_KEY = 'manga.library-new-first';
const SHOW_KEY = 'manga.library-show';

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

function storedSort(): SortKey {
  const v = stored(SORT_KEY);
  // "New chapters first" was its own order; it is last read with the box ticked now.
  if (v === 'unread') return 'read';
  return v && v in SORT_LABEL ? (v as SortKey) : 'read';
}

function storedShow(): Show {
  const v = stored(SHOW_KEY);
  return v && v in SHOW_LABEL ? (v as Show) : 'all';
}

/** Somewhere past where you are — see the note at the top. */
export function hasNew(s: SeriesSummary): boolean {
  const latest = s.latestNumber;
  if (latest === null || latest === undefined) return false;
  const reached = Math.max(s.readUpTo ?? -Infinity, s.position?.chapter ?? -Infinity);
  return reached > -Infinity && latest > reached;
}

/**
 * Whole chapters between where you are and the newest — see the note at the
 * top. Zero when either is unknown, like `hasNew`.
 */
export function toCatchUp(s: SeriesSummary): number {
  if (!hasNew(s)) return 0;
  const reached = Math.max(s.readUpTo ?? -Infinity, s.position?.chapter ?? -Infinity);
  return Math.max(1, Math.floor(s.latestNumber!) - Math.floor(reached));
}

/** Its source failed when last asked — by the sweep, or by opening its chapters. */
export const notAnswering = (s: SeriesSummary) => s.source !== null && s.error !== null;

/** "Asura Scans (EN)" → "Asura Scans": the language is the same on every tile and costs a third of its width. */
export function sourceLabel(name: string): string {
  return name.replace(/\s*\((?:[A-Za-z]{2,3}(?:-[A-Za-z]+)?|ALL|all)\)\s*$/, '');
}

function sorted(list: SeriesSummary[], key: SortKey, newFirst: boolean): SeriesSummary[] {
  const byTitle = (a: SeriesSummary, b: SeriesSummary) => a.title.localeCompare(b.title);
  const desc = (f: (s: SeriesSummary) => number | null | undefined) => (a: SeriesSummary, b: SeriesSummary) =>
    (f(b) ?? 0) - (f(a) ?? 0) || byTitle(a, b);
  const copy = [...list];
  switch (key) {
    case 'title':
      copy.sort(byTitle);
      break;
    case 'added':
      copy.sort(desc((s) => s.addedAt));
      break;
    case 'read':
      copy.sort(desc((s) => s.lastReadAt));
      break;
    case 'catchup':
      copy.sort(desc(toCatchUp));
      break;
    case 'updated':
      copy.sort(desc((s) => s.lastReleaseAt));
      break;
  }
  // Stable, so within each half the order chosen above holds.
  return newFirst ? copy.sort((a, b) => Number(hasNew(b)) - Number(hasNew(a))) : copy;
}

export function Library({
  series,
  onOpen,
  onDetails,
  onCompare,
  onRemove,
  filter,
  onFilter,
}: {
  series: SeriesSummary[];
  onOpen: (s: SeriesSummary) => void;
  onDetails: (s: SeriesSummary) => void;
  onCompare: (s: SeriesSummary) => void;
  onRemove: (s: SeriesSummary) => void;
  /** Held by the screen, so the Dashboard panel can hand a title in. */
  filter: string;
  onFilter: (text: string) => void;
}) {
  const [sort, setSort] = useState<SortKey>(storedSort);
  const [newFirst, setNewFirst] = useState(() => stored(NEW_FIRST_KEY) !== '0');
  const [show, setShow] = useState<Show>(storedShow);
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
      new: series.filter(hasNew).length,
      broken: series.filter(notAnswering).length,
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
        (show === 'all' ||
          (show === 'new' && hasNew(s)) ||
          (show === 'broken' && notAnswering(s)) ||
          (show === 'unlinked' && !s.source)) &&
        (tag === null || (s.tags ?? []).includes(tag))
    );
    return sorted(matching, sort, newFirst);
  }, [series, filter, sort, newFirst, show, tag]);

  const fresh = counts.new;
  const narrowed = Boolean(filter.trim()) || show !== 'all' || tag !== null;

  // A new filter or order starts from the top again.
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [filter, sort, newFirst, show, tag]);

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
        {fresh > 0 ? ` · ${fresh} with new chapters` : ''} · {SORT_LABEL[sort].toLowerCase()}
        {newFirst ? ', new on top' : ''}
      </p>
      {show === 'broken' && shown.length > 0 && (
        <p className="meta">Tap one to find it on another source.</p>
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

function Tile({
  series: s,
  onOpen,
  onDetails,
  onCompare,
  onRemove,
}: {
  series: SeriesSummary;
  onOpen: () => void;
  onDetails: () => void;
  onCompare: () => void;
  onRemove: () => void;
}) {
  /*
   * The row's old buttons, on a right-click — the desktop affordance the
   * Dashboard's rows already have. Nothing is only here: the chapter list's ⋯
   * has all of it, which is how the phone reaches it.
   */
  const menu = useContextMenu(() => [
    { label: s.source ? 'Open chapters' : 'Find a source', onSelect: onOpen },
    { label: 'Series details', onSelect: onDetails },
    ...(s.source ? [{ label: 'Other sources', onSelect: onCompare }] : []),
    { label: 'Stop following', onSelect: onRemove, danger: true },
  ]);

  const fresh = hasNew(s);
  const catchUp = toCatchUp(s);
  const latest = s.latestNumber;
  const where = s.source ? sourceLabel(s.source.sourceName) : null;
  // Brought in and not found yet: where it was, rather than a bare "no source".
  const whereText = where ?? (s.origin ? `was on ${s.origin.site}` : 'no source yet');

  return (
    <>
      <button
        className="manga-lib-tile"
        onClick={onOpen}
        onContextMenu={menu.onContextMenu}
        aria-label={[
          s.title,
          fresh ? `${catchUp} new chapter${catchUp === 1 ? '' : 's'}` : null,
          notAnswering(s) ? 'source not answering' : null,
          latest !== null && latest !== undefined ? `newest chapter ${chapterText(latest)}` : null,
          where ? `read on ${where}` : s.origin ? `no source yet, read on ${s.origin.site} in ${s.origin.app}` : 'no source yet',
          s.error ? `last check failed: ${s.error}` : null,
        ]
          .filter(Boolean)
          .join(', ')}
      >
        <span className="manga-lib-cover">
          <Cover path={s.coverPath} title={s.title} fill />
          {fresh && <span className="manga-lib-new">{catchUp > 1 ? `${catchUp} NEW` : 'NEW'}</span>}
          {s.error && (
            <span className="manga-lib-warn" title={`Last check failed: ${s.error}`}>
              !
            </span>
          )}
        </span>
        <span className="manga-lib-title">{s.title}</span>
        <span
          className={`manga-lib-bar${latest === null || latest === undefined ? ' unknown' : ''}${fresh ? ' new' : ''}`}
        >
          {latest !== null && latest !== undefined ? chapterText(latest) : '–'}
        </span>
        <span className={`manga-lib-source${where ? '' : ' none'}`}>{whereText}</span>
      </button>
      {menu.menu}
    </>
  );
}
