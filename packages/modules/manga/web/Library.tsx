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
 */
import { useMemo, useState } from 'react';
import { useButtonMenu, useContextMenu } from '@app/ContextMenu';
import { Cover } from './Cover';
import { Icon } from './Icons';
import { chapterText } from './judge';
import type { SeriesSummary } from './manga-api';

export type SortKey = 'unread' | 'updated' | 'read' | 'title' | 'added';

const SORT_LABEL: Record<SortKey, string> = {
  unread: 'New chapters first',
  updated: 'Last updated',
  read: 'Recently read',
  title: 'Title',
  added: 'Recently added',
};

/*
 * Remembered per device, like the folded note folders: it is a view of one
 * screen, and sorting the phone's shelf should not reorder the PC's.
 */
const SORT_KEY = 'manga.library-sort';

function storedSort(): SortKey {
  try {
    const v = localStorage.getItem(SORT_KEY);
    if (v && v in SORT_LABEL) return v as SortKey;
  } catch {
    // Private mode, or storage blocked: the default is a fine answer.
  }
  return 'unread';
}

/** Somewhere past where you are — see the note at the top. */
export function hasNew(s: SeriesSummary): boolean {
  const latest = s.latestNumber;
  if (latest === null || latest === undefined) return false;
  const reached = Math.max(s.readUpTo ?? -Infinity, s.position?.chapter ?? -Infinity);
  return reached > -Infinity && latest > reached;
}

/** "Asura Scans (EN)" → "Asura Scans": the language is the same on every tile and costs a third of its width. */
export function sourceLabel(name: string): string {
  return name.replace(/\s*\((?:[A-Za-z]{2,3}(?:-[A-Za-z]+)?|ALL|all)\)\s*$/, '');
}

function sorted(list: SeriesSummary[], key: SortKey): SeriesSummary[] {
  const byTitle = (a: SeriesSummary, b: SeriesSummary) => a.title.localeCompare(b.title);
  const desc = (f: (s: SeriesSummary) => number | null | undefined) => (a: SeriesSummary, b: SeriesSummary) =>
    (f(b) ?? 0) - (f(a) ?? 0) || byTitle(a, b);
  const copy = [...list];
  switch (key) {
    case 'title':
      return copy.sort(byTitle);
    case 'added':
      return copy.sort(desc((s) => s.addedAt));
    case 'read':
      return copy.sort(desc((s) => s.lastReadAt));
    case 'updated':
      return copy.sort(desc((s) => s.lastReleaseAt));
    case 'unread':
      // New first; within each half, the one you were reading most recently.
      return copy.sort((a, b) => Number(hasNew(b)) - Number(hasNew(a)) || desc((s) => s.lastReadAt)(a, b));
  }
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

  const sortMenu = useButtonMenu(() =>
    (Object.keys(SORT_LABEL) as SortKey[]).map((key) => ({
      label: `${key === sort ? '✓ ' : ' '}${SORT_LABEL[key]}`,
      onSelect: () => {
        setSort(key);
        try {
          localStorage.setItem(SORT_KEY, key);
        } catch {
          // Kept for this visit only.
        }
      },
    }))
  );

  const shown = useMemo(() => {
    const words = filter.trim().toLowerCase();
    const matching = words
      ? series.filter(
          (s) => s.title.toLowerCase().includes(words) || (s.source?.title.toLowerCase().includes(words) ?? false)
        )
      : series;
    return sorted(matching, sort);
  }, [series, filter, sort]);

  const fresh = series.filter(hasNew).length;

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

      <p className="meta manga-lib-count">
        {filter.trim() ? `${shown.length} of ${series.length}` : `${series.length} series`}
        {fresh > 0 ? ` · ${fresh} with new chapters` : ''} · {SORT_LABEL[sort].toLowerCase()}
      </p>

      {shown.length === 0 && filter.trim() && <p className="empty">Nothing in your library matches “{filter.trim()}”.</p>}

      <div className="manga-lib-grid">
        {shown.map((s) => (
          <Tile
            key={s.id}
            series={s}
            onOpen={() => onOpen(s)}
            onDetails={() => onDetails(s)}
            onCompare={() => onCompare(s)}
            onRemove={() => onRemove(s)}
          />
        ))}
      </div>
    </div>
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
  const latest = s.latestNumber;
  const where = s.source ? sourceLabel(s.source.sourceName) : null;

  return (
    <>
      <button
        className="manga-lib-tile"
        onClick={onOpen}
        onContextMenu={menu.onContextMenu}
        aria-label={[
          s.title,
          fresh ? 'new chapters' : null,
          latest !== null && latest !== undefined ? `newest chapter ${chapterText(latest)}` : null,
          where ? `read on ${where}` : 'no source yet',
          s.error ? `last check failed: ${s.error}` : null,
        ]
          .filter(Boolean)
          .join(', ')}
      >
        <span className="manga-lib-cover">
          <Cover path={s.coverPath} title={s.title} fill />
          {fresh && <span className="manga-lib-new">NEW</span>}
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
        <span className={`manga-lib-source${where ? '' : ' none'}`}>{where ?? 'no source yet'}</span>
      </button>
      {menu.menu}
    </>
  );
}
