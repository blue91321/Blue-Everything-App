/**
 * The app mark, drawn in the page.
 *
 * Inline SVG rather than an `<img>` pointing at `/icon/64.png`, for one reason
 * that matters: it paints from `var(--accent)`, so it changes in the same frame
 * as everything else when a colour is picked. Fetching a PNG would make the
 * logo the one thing on screen that lagged a round trip behind the rest of the
 * app, which is precisely the interaction where that reads as broken.
 *
 * The server renders the same shapes as PNGs for the places that cannot take an
 * SVG — the home-screen icon, the Windows taskbar. Two implementations of four
 * shapes is real duplication, but each is a few lines of arithmetic, and the
 * alternative was either an SVG rasteriser on the server or a laggy logo here.
 *
 * An uploaded picture is the exception: that genuinely is a file, so it is an
 * `<img>` with the version in the query so a replacement is not cached forever.
 */

export type LogoShape = 'pause' | 'circle' | 'triangle' | 'square' | 'image';

export function Logo({
  shape,
  size = 28,
  version = 0,
}: {
  shape: LogoShape;
  size?: number;
  /** Bumped on upload; only used to bust the cache on a custom picture. */
  version?: number;
}) {
  if (shape === 'image') {
    return (
      <img
        className="logo-mark"
        src={`/icon/128.png?v=${version}`}
        width={size}
        height={size}
        alt=""
        aria-hidden="true"
      />
    );
  }

  // A 100-unit box, so the numbers below read as percentages of the mark.
  return (
    <svg
      className="logo-mark"
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="0" y="0" width="100" height="100" rx="22" fill="var(--logo-bg, #14161c)" />
      {shape === 'pause' && (
        <>
          <rect x="33.25" y="30" width="11.5" height="40" rx="5.75" fill="var(--accent)" />
          <rect x="55.25" y="30" width="11.5" height="40" rx="5.75" fill="var(--accent)" />
        </>
      )}
      {shape === 'circle' && <circle cx="50" cy="50" r="23" fill="var(--accent)" />}
      {shape === 'square' && <rect x="30" y="30" width="40" height="40" rx="6" fill="var(--accent)" />}
      {/* Matches the server's geometry: apex above centre, base below, so it
          reads as centred rather than sitting low the way a box-centred
          triangle does. */}
      {shape === 'triangle' && <polygon points="50,24.9 74,70.5 26,70.5" fill="var(--accent)" />}
    </svg>
  );
}
