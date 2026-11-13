/**
 * Pages mode's pull towards a page (2026-11-12). It replaced the browser's
 * scroll snapping (`scroll-snap-type: y mandatory`), which decided for itself
 * where the screen went: Safari remembered which page it was snapped to and
 * put you back on it after anything changed, which undid hops from the page
 * bar, and every way of moving the screen had to lift the snapping and put it
 * back around itself. Asked for as "slight magnetism instead of being forceful".
 *
 * Now the screen scrolls freely, and once it has stopped, a page whose middle
 * is near the middle of the screen is slid the rest of the way. One further
 * off is left where it is: that is somebody looking at the gap, or at two.
 *
 * **It pulls forwards further than it pulls back.** Pulling back equally would
 * make a mouse wheel useless: one notch moves about 100px, and pausing after
 * it would slide the page you just scrolled off straight back. So a page
 * behind the way you were going pulls only from very close (a flick that
 * overshot by a little), and the one ahead from the full reach.
 *
 * No imports, so `manga-check` tests it directly.
 */

/** Where the screen would sit with a page in the middle of it, and how far from there it pulls. */
export interface MagnetSpot {
  /** The scroll position, in document pixels. */
  at: number;
  /** Within this many pixels of `at` it pulls, ahead of the way you were going. */
  reach: number;
}

/** How near, as a share of the page's height (or the screen's, if smaller), before it pulls. */
export const PULL_SHARE = 0.2;
/** A page behind the way you were going pulls from this share of the reach. */
export const BACK_SHARE = 0.3;
/** Closer than this it is already there. */
export const SETTLED_PX = 2;

/** The reach for a page this tall. */
export function reachFor(pageHeight: number, screenHeight: number): number {
  return Math.min(pageHeight, screenHeight) * PULL_SHARE;
}

/**
 * Where to slide the screen to, or null to leave it: the nearest spot whose
 * reach the screen is inside, kept inside what can be scrolled to (`max`).
 * `heading` is the way the screen last moved: 1 down, -1 up, 0 not known
 * (every spot then pulls from its full reach).
 */
export function magnetTarget(spots: readonly MagnetSpot[], scrollY: number, max: number, heading: 1 | -1 | 0 = 0): number | null {
  let best: number | null = null;
  let bestOff = Infinity;
  for (const spot of spots) {
    const at = Math.max(0, Math.min(max, spot.at));
    const off = Math.abs(at - scrollY);
    const behind = heading !== 0 && Math.sign(at - scrollY) === -heading;
    const reach = behind ? spot.reach * BACK_SHARE : spot.reach;
    if (off <= reach && off < bestOff) {
      best = at;
      bestOff = off;
    }
  }
  if (best === null || bestOff <= SETTLED_PX) return null;
  return best;
}
