/**
 * Pages mode's scroll: where a flick ends, and the slide that takes it there.
 * Asked for (2026-11-12) as changing the friction of the scroll so the page
 * stops in the middle of the screen: more friction when a slow scroll would
 * carry past the page, less when a short flick would fall short of the next.
 * And, a second time, as changing the friction "and not speeding things up".
 *
 * So the slide is friction and nothing else: it starts at exactly the speed
 * the finger let go at and slows at an even rate (`settlePlan`, a constant
 * deceleration, which is what friction is) until it rests on a sheet's
 * middle. Only the rate is chosen. It never goes faster than it was thrown.
 *
 * Which sheet: the one nearest where the same flick would have stopped on its
 * own (`NATURAL_PER_SPEED`, iOS's own deceleration, as `glide.ts`), of those
 * ahead that it can reach with friction lowered no further than taking
 * `MAX_MS`. Never one behind the way it was thrown. A flick too weak to reach
 * any, or a release that was barely moving, settles on whichever is nearest,
 * from rest.
 *
 * No imports, like `glide.ts` and `magnet.ts`, so `manga-check` asks it.
 */

/** Below this a release is putting the page down, not throwing it. px per ms. */
export const SLOW_SPEED = 0.3;

/** How far a slide goes per px/ms of release speed at iOS's 0.998 a ms (as `glideDistance`). */
export const NATURAL_PER_SPEED = 1 / -Math.log(0.998);

/** Already this close to the middle of a page is there. px. */
export const SETTLED_PX = 2;

/**
 * The longest a thrown slide may take, which is how far friction may be
 * lowered: past this a flick is too weak for the page ahead, and settles on
 * the nearest instead. ms.
 */
export const MAX_MS = 2000;

/** The shortest a slide takes, so a tiny correction still moves rather than jumps. ms. */
export const MIN_MS = 120;

const clamp = (y: number, max: number) => Math.max(0, Math.min(max, y));

/** How long friction takes to bring a slide at `velocity` to rest exactly `distance` on: 2d/v. Infinity the wrong way. */
export function frictionTime(distance: number, velocity: number): number {
  if (distance === 0) return 0;
  if (Math.sign(velocity) !== Math.sign(distance)) return Infinity;
  return (2 * Math.abs(distance)) / Math.abs(velocity);
}

/**
 * Where a release at `velocity` (px per ms, positive downwards) from `from`
 * comes to rest, given where the screen sits with each page in its middle.
 * Null when there is nowhere to go.
 */
export function settleTarget(stops: readonly number[], from: number, velocity: number, max: number): number | null {
  const spots = stops.map((s) => clamp(s, max));
  if (spots.length === 0) return null;
  const natural = clamp(from + velocity * NATURAL_PER_SPEED, max);
  const nearest = (pool: number[], to: number) => pool.reduce((best, s) => (Math.abs(s - to) < Math.abs(best - to) ? s : best));
  if (Math.abs(velocity) >= SLOW_SPEED) {
    const ahead = spots.filter((s) => (s - from) * Math.sign(velocity) > SETTLED_PX && frictionTime(s - from, velocity) <= MAX_MS);
    if (ahead.length > 0) return nearest(ahead, natural);
  }
  return nearest(spots, from);
}

/**
 * The slide from `from` to `to`: how long it takes and where it is `t` ms in.
 *
 * Moving that way already, it is friction: x = d(1 - (1 - t/T)²) with
 * T = 2d/v, so it starts at the release speed and slows evenly to rest.
 * Kept to at least `MIN_MS`, which can only mean starting slower than thrown
 * (friction raised), never faster. Otherwise, a release barely moving or the
 * other way, it eases from rest, the one case where the page has to be got
 * moving.
 */
export function settlePlan(from: number, to: number, velocity: number): { duration: number; at: (t: number) => number } {
  const d = to - from;
  const thrown = frictionTime(d, velocity);
  if (thrown <= MAX_MS && Math.abs(velocity) >= 0.05) {
    const duration = Math.max(MIN_MS, thrown);
    return {
      duration,
      at: (t) => {
        const r = 1 - Math.max(0, Math.min(1, t / duration));
        return from + d * (1 - r * r);
      },
    };
  }
  const duration = Math.max(MIN_MS, Math.min(700, 250 + Math.abs(d) * 0.6));
  return {
    duration,
    at: (t) => {
      const s = Math.max(0, Math.min(1, t / duration));
      return from + d * s * s * (3 - 2 * s);
    },
  };
}
