/**
 * One cover on a shelf: the picture, the NEW badge, the newest chapter, and
 * where it is read from.
 *
 * Lifted out of `Library.tsx` so the Dashboard card can draw the same thing.
 * Importing it from there would have pulled the whole Library screen — its
 * paging, its filters, its sort row — into the card's chunk, which is the 9.5KB
 * the friends panel once paid to render six words. Rollup cannot tree-shake
 * that: importing any part of a module pulls the module in.
 *
 * The four actions are optional and the menu is built from whichever arrived.
 * On the Library every tile offers all of them; on the Dashboard card only
 * opening makes sense, because details, other-sources and stop-following are
 * things you do *to* a library rather than from a glance at one.
 */
import { useContextMenu } from '@app/ContextMenu';
import type { SeriesSummary } from './manga-api';
import { Cover } from './Cover';
import { chapterText } from './judge';
import { hasNew, notAnswering, sourceHasNothing, sourceLabel, toCatchUp } from './shelf';
import { ageOf } from './manga-api';

export function Tile({
  series: s,
  onOpen,
  onDetails,
  onCompare,
  onRemove,
  libraries = [],
  onShelves,
}: {
  series: SeriesSummary;
  onOpen: () => void;
  onDetails?: () => void;
  onCompare?: () => void;
  onRemove?: () => void;
  /** The shelves on offer, for the right-click menu. */
  libraries?: Array<{ id: string; name: string }>;
  /** Set the whole set for this series. */
  onShelves?: (libraries: string[]) => void;
}) {
  /*
   * The row's old buttons, on a right-click — the desktop affordance the
   * Dashboard's rows already have. Nothing is only here: the chapter list's ⋯
   * has all of it, which is how the phone reaches it.
   */
  const menu = useContextMenu(() => [
    { label: s.source ? 'Open chapters' : 'Find a source', onSelect: onOpen },
    ...(onDetails ? [{ label: 'Series details', onSelect: onDetails }] : []),
    ...(s.source && onCompare ? [{ label: 'Other sources', onSelect: onCompare }] : []),
    /*
      Each shelf is a line that ticks and unticks, rather than a sub-menu or a
      dialogue. Membership is many-to-many, so the question is never "which
      one" but "which of these" — and a tick beside a name answers it in one
      glance and one click, the idiom the sort menu's "New chapters on top"
      already uses.
    */
    ...(onShelves
      ? libraries.map((l) => {
          const on = s.libraries?.includes(l.id) === true;
          return {
            label: `${on ? '☑' : '☐'} ${l.name}`,
            onSelect: () =>
              onShelves(on ? (s.libraries ?? []).filter((x) => x !== l.id) : [...(s.libraries ?? []), l.id]),
          };
        })
      : []),
    ...(onRemove ? [{ label: 'Stop following', onSelect: onRemove, danger: true }] : []),
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
          sourceHasNothing(s) ? 'the source has no chapters for this' : notAnswering(s) ? 'source not answering' : null,
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
          {/*
            The time matters as much as the message. "Not answering" reads as a
            claim about right now, and it is a claim about whenever it was last
            asked — which for something you have not opened in a while can be a
            day or two ago.
          */}
          {s.error && (
            <span
              className="manga-lib-warn"
              title={`${s.error}${s.checkedAt ? ` — when last asked, ${ageOf(s.checkedAt, Date.now())}` : ''}`}
            >
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
