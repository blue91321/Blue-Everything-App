/**
 * The slide a mouse drag carries on with after you let go, as a phone's does.
 *
 * Two questions, kept apart from the reader so `manga-check` can ask them with
 * no browser: how fast was the drag going when it was released, and how far
 * does that carry over the next frame. No imports, like `chapter-nav.ts`.
 */

/** Where the pointer was, and when, during a drag. */
export interface DragSample {
  t: number;
  y: number;
}

/**
 * Only the last stretch of a drag says how fast it was going when released.
 * A phone measures over about this long; any further back and a drag that
 * slowed before letting go would still be thrown at its early speed.
 */
export const VELOCITY_WINDOW_MS = 80;

/**
 * Held still this long before letting go is putting it down, not throwing it.
 * Without this, dragging to a place, pausing to read and then releasing sent the
 * page off with the speed of the drag that got it there.
 */
export const HELD_STILL_MS = 60;

/** Fast enough to cross a long chapter, not so fast a twitch empties it. px per ms. */
export const MAX_SPEED = 6;

/**
 * Below this the slide is over. px per ms: 0.05 is under a pixel a frame at
 * sixty frames a second, and below a pixel a frame there is nothing smooth left
 * to show — on a screen without scaling the page can only move in whole pixels,
 * so the tail becomes a pixel, a pause, a pixel. Stopping here costs the last
 * 25px of a slide, which is less than a line of text.
 */
export const STOP_SPEED = 0.05;

/**
 * Speed kept per millisecond. 0.998 is iOS's own "normal" deceleration, which
 * is what a hand used to a phone expects: a flick at 2px/ms carries about a
 * thousand pixels and settles in about two seconds.
 */
export const DECAY_PER_MS = 0.998;

/**
 * The scroll speed at release, in px per ms, positive downwards — or 0 when the
 * drag had stopped before it was let go.
 *
 * The pointer and the page move opposite ways (pulling up scrolls down), so the
 * sign is flipped here once rather than at every caller.
 */
export function releaseVelocity(samples: readonly DragSample[], releasedAt: number): number {
  const last = samples.at(-1);
  if (!last || releasedAt - last.t > HELD_STILL_MS) return 0;

  const recent = samples.filter((s) => last.t - s.t <= VELOCITY_WINDOW_MS);
  const first = recent[0];
  const span = last.t - first.t;
  if (span <= 0) return 0;

  const speed = -(last.y - first.y) / span;
  return Math.max(-MAX_SPEED, Math.min(MAX_SPEED, speed));
}

/**
 * One frame of the slide: how far to move, and the speed left after it.
 *
 * Integrated exactly rather than as `v * dt`, so the distance does not depend on
 * how often frames arrive — a busy page dropping to twenty frames a second would
 * otherwise slide further than an idle one at sixty.
 */
export function glideStep(velocity: number, dt: number): { distance: number; velocity: number } {
  const k = Math.log(DECAY_PER_MS);
  const next = velocity * Math.pow(DECAY_PER_MS, dt);
  return { distance: (next - velocity) / k, velocity: next };
}

/** How far a slide at this speed goes in total, for the test and nothing else. */
export function glideDistance(velocity: number): number {
  return velocity / -Math.log(DECAY_PER_MS);
}
