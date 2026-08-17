/**
 * A shape that empties as the day goes on, and fills back up when you do the
 * thing.
 *
 * ### Why this is drawn rather than a bar
 *
 * A progress bar would have been three lines of CSS and would have answered the
 * question. The reason for a shape is that it is read *without* being looked at:
 * a plant that is visibly half gone registers out of the corner of your eye,
 * where "last done 2 days ago" has to be parsed. That is the same argument the
 * whole app runs on — the nudge engine exists so you do not have to remember to
 * check anything — so a habit that is glanceable is worth some SVG.
 *
 * ### Emoji as well as shapes
 *
 * "A picture that empties" is satisfied by 🪴 or 💧 far more cheaply than by an
 * upload route and a file per habit. Every browser here draws emoji in colour,
 * which is the same reasoning the overlay avatar used and the same reasoning
 * that has the app icons generated rather than committed.
 *
 * An emoji cannot be clipped by an SVG path, so it is drawn twice — once faded
 * as the empty part, once clipped to the fill height on top. `overflow: hidden`
 * on a wrapper of a known height does the clipping, which is the one technique
 * that works on a glyph the browser owns.
 *
 * ### The colour
 *
 * `var(--accent)`, so the gauge matches whatever the app is set to — unlike the
 * presence dots, which deliberately do not follow the accent because green means
 * online everywhere and re-teaching that per accent would break a learned
 * meaning. Nothing is learned about a gauge's colour, so it may as well match.
 */

/** The four drawn shapes. Anything else is treated as an emoji. */
const PATHS: Record<string, string> = {
  circle: 'M 16 1 A 15 15 0 1 1 15.99 1 Z',
  square: 'M 2 2 H 30 V 30 H 2 Z',
  triangle: 'M 16 1 L 31 30 H 1 Z',
  bar: 'M 3 8 H 29 V 24 H 3 Z',
};

export function Gauge({
  shape,
  percent,
  size = 26,
  title,
}: {
  shape: string;
  /** 0–100. Clamped, because a server that has not caught up may send anything. */
  percent: number;
  size?: number;
  title?: string;
}) {
  const level = Math.max(0, Math.min(100, percent));
  const path = PATHS[shape];

  /*
   * A label, always. The shape is the entire message and a screen reader gets
   * nothing at all from an SVG path — the same reason the presence dots carry
   * one.
   */
  const label = title ?? `${Math.round(level)}% full`;

  if (!path) {
    // An emoji, or anything else stored in the column. Two copies, the top one
    // clipped to the fill height by a wrapper that hides its overflow.
    return (
      <span
        className="gauge-emoji"
        style={{ width: size, height: size, fontSize: size * 0.86 }}
        role="img"
        aria-label={label}
        title={label}
      >
        <span className="gauge-emoji-empty" aria-hidden="true">
          {shape}
        </span>
        {/*
          Positioned from the bottom so the fill rises, and the inner copy is
          pushed down by the same amount it is clipped by — otherwise the glyph
          would slide up as it filled instead of being revealed.
        */}
        <span className="gauge-emoji-full" style={{ height: `${level}%` }} aria-hidden="true">
          <span style={{ display: 'block', height: size, lineHeight: `${size}px` }}>{shape}</span>
        </span>
      </span>
    );
  }

  /*
   * The fill is a rect clipped to the shape, anchored to the bottom — so a
   * triangle empties to a point and a circle to a lens, which is what makes the
   * shape worth choosing rather than decoration on a bar.
   *
   * `clipPath` ids must be unique per instance or the first one on the page wins
   * for every gauge, so the shape name is enough: two gauges of the same shape
   * clip identically anyway.
   */
  const clipId = `gauge-clip-${shape}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className="gauge"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <defs>
        <clipPath id={clipId}>
          <path d={path} />
        </clipPath>
      </defs>
      {/* The outline is always whole, so an empty gauge is still visibly a
          shape rather than a blank space where something used to be. */}
      <path d={path} className="gauge-track" />
      <rect
        x="0"
        y={32 - (32 * level) / 100}
        width="32"
        height={(32 * level) / 100}
        clipPath={`url(#${clipId})`}
        className="gauge-fill"
      />
      <path d={path} className="gauge-edge" />
    </svg>
  );
}
