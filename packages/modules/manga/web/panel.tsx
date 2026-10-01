/**
 * What landed lately, beside the Dashboard.
 *
 * Deliberately **not** the list of things to read — the Dashboard already shows
 * the tasks these releases raised, and a panel repeating them would be a second
 * copy of something already on that screen. This is the release itself, with its
 * cover, which is a picture rather than a list and answers "what turned up this
 * week" without being read.
 *
 * Each row is a button, like the friends panel's rows and for the same reason: a
 * whole-row hit target in a 320px column beats an icon per row, which is width
 * taken from the thing the column is for.
 */
import { useNow } from '@app/clock';
import { useAsync } from '@app/useAsync';
import { goTo } from '@app/nav';
import { Cover } from './Cover';
import { ageOf, manga } from './manga-api';
import { sorted, storedNewFirst, storedSort } from './shelf';
import { Tile } from './Tile';

/**
 * Two panels, one module, chosen by the id the Dashboard asks for.
 *
 * `features/index.ts` resolves a panel id to one lazy component per module, so
 * a second panel is a second branch rather than a second chunk — which is also
 * the cheaper arrangement, since these two share the request, the `Cover` and
 * the empty states.
 */
export default function MangaPanel({ panelId }: { panelId?: string }) {
  return panelId === 'manga:shelf' ? <ShelfPanel /> : <WaitingPanel />;
}

/**
 * Your library, in the order the Library tab is using — or only the starred.
 *
 * **The order follows that tab by default, and that is a `localStorage` read
 * on purpose.** The Library's sort is per device, deliberately, so a card that
 * followed a server-side copy would disagree with the screen it claims to
 * follow. Pinning an order instead is stored on the server, so a pinned card
 * agrees everywhere; `shelfSort` holds `follow` or the order itself.
 */
function ShelfPanel() {
  const state = useAsync(() => manga.list());

  if (state.loading) return <div className="empty">loading…</div>;
  if (state.error) return <div className="empty">Could not load: {state.error.message}</div>;
  const data = state.data;
  if (!data) return null;

  const show = data.shelfShow ?? 'all';
  const pinned = data.shelfSort ?? 'follow';
  // Read live rather than captured, so changing the Library's sort reaches this
  // card the next time the Dashboard draws without anything telling it to.
  const order = pinned === 'follow' ? storedSort() : pinned;
  /*
   * "New chapters on top" is half of how the Library is sorted, so following
   * the sort and ignoring the box would be following half a control — which is
   * what the first version did, and it read as the card not following at all.
   *
   * Pinned, the box is the card's own, kept on the server, so a pinned card
   * agrees across devices in both halves rather than one.
   */
  const newFirst = pinned === 'follow' ? storedNewFirst() : data.shelfNewFirst !== false;

  const picked = show === 'favourites' ? data.series.filter((s) => s.favourite) : data.series;
  const list = sorted(picked, order, newFirst).slice(0, SHELF_TILES);

  if (data.series.length === 0) {
    return (
      <div className="empty">
        Nothing followed yet.{' '}
        <button className="btn subtle" onClick={() => goTo('manga')}>
          Add a series
        </button>
      </div>
    );
  }

  /*
   * Two empty states again, because "you have starred nothing" and "you follow
   * nothing" are different situations with different fixes — and the first is
   * the one the favourites mode will meet on the day it is switched on.
   */
  if (list.length === 0) {
    return (
      <div className="empty">
        Nothing starred yet — open a series and choose <em>Add to favourites</em>.{' '}
        <button className="btn subtle" onClick={() => goTo('manga')}>
          Open Manga
        </button>
      </div>
    );
  }

  return (
    /*
     * The Library's own grid and the Library's own tile — the cover, the NEW
     * badge, the newest chapter on its bar, the source underneath. A card that
     * showed the same series as thin rows would be a second way of drawing a
     * shelf, and the one you would have to learn twice.
     *
     * `.manga-lib-grid` sizes its columns as `min(130px, a third of the row)`,
     * so this is three across in the side column and as many as fit in the main
     * one, with no CSS of its own.
     */
    <div className="manga-shelf-panel">
      <div className="manga-lib-grid">
        {list.map((series) => (
          <Tile key={series.id} series={series} onOpen={() => goTo('manga', { search: series.title })} />
        ))}
      </div>
      <div className="row" style={{ marginTop: 8, gap: '.35rem' }}>
        {picked.length > list.length && (
          <button className="btn subtle" onClick={() => goTo('manga')}>
            and {picked.length - list.length} more
          </button>
        )}
        {/*
          * The side column has one "Change what's here" on its `aside`, which
          * every panel gets for free — the slot is core's, so the button about
          * the slot belongs to core. In the main column there is no such shared
          * edge: a card sits among the task sections with nothing around it.
          *
          * So this one is the package's own, and it goes somewhere core could
          * not have sent you anyway: these settings are on the Manga tab, not
          * in Settings, because everything they decide is about manga.
          *
          * **Not "Change what's here", which is what the side column's button
          * says.** Both can be on screen at once — this card in the main
          * column, that button on the `aside` — and two buttons with one label
          * going to two different screens is worse than either name being
          * slightly longer. Found by clicking the wrong one.
          */}
        <button
          className="btn subtle"
          title="What this card shows, and in what order"
          onClick={() => goTo('manga', { focus: 'shelf' })}
        >
          Change this shelf
        </button>
      </div>
    </div>
  );
}

/**
 * How many tiles the shelf draws.
 *
 * A bound rather than the whole library, because every tile fetches its cover
 * when it mounts and this install follows nine hundred series — the Library tab
 * draws sixty at a time for exactly that reason, and a Dashboard card is a
 * glance rather than a page.
 *
 * Twelve divides by three, four and six, so it ends on a full row at the widths
 * the grid actually produces — the same reason the Library's page size is sixty.
 */
const SHELF_TILES = 12;

function WaitingPanel() {
  // Redraws the ages on screen without asking the server anything.
  useNow();
  const state = useAsync(() => manga.list());

  if (state.loading) return <div className="empty">loading…</div>;
  // Said rather than swallowed: a panel silently showing nothing when the
  // request failed is indistinguishable from one with nothing to show, and the
  // two want completely different reactions.
  if (state.error) return <div className="empty">Could not load: {state.error.message}</div>;

  const data = state.data;
  if (!data) return null;

  if (data.series.length === 0) {
    return (
      <div className="empty">
        Nothing followed yet.{' '}
        <button className="btn subtle" onClick={() => goTo('manga')}>
          Add a series
        </button>
      </div>
    );
  }

  if (data.recent.length === 0) {
    /*
     * Two empty states, because "nothing has come out" and "nothing is being
     * watched" are different situations with different fixes — the same
     * distinction the live panel draws between a quiet evening and a filter
     * hiding everybody.
     */
    return (
      <div className="empty">
        {data.watching > 0
          ? `Watching ${data.watching} series. Nothing new yet.`
          : 'Nothing is being watched — every series you follow has finished.'}
      </div>
    );
  }

  const now = Date.now();

  return (
    <div className="manga-panel">
      {data.recent.map((release) => (
        <button
          key={`${release.seriesId}:${release.chapter}`}
          className="manga-panel-row"
          onClick={() => goTo('manga', { search: release.title })}
          title={`${release.title} — chapter ${release.chapter}`}
        >
          <Cover path={release.coverPath} title={release.title} size={34} />
          <span className="manga-panel-text">
            <span className="title truncate">{release.title}</span>
            <span className="meta">
              ch {release.chapter} · {ageOf(release.raisedAt, now)}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
