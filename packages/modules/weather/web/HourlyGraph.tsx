/**
 * The next twenty-four hours, drawn.
 *
 * Hand-rolled SVG, like `Gauge.tsx` — a line, an area under it, and some text.
 * A chart library would be the largest dependency in this repo by some margin,
 * for one graph on one screen in an app whose whole bundle is 90KB and nearly
 * all of it React.
 *
 * ### It scrolls rather than squashing
 *
 * Twenty-four hours at a legible spacing is wider than a phone, and the two ways
 * out of that are both worse than scrolling: shrinking the labels until they are
 * unreadable, or dropping hours until the graph is no longer the thing it says
 * it is. So the SVG keeps a fixed width and sits in an `overflow-x: auto`
 * wrapper — the rule this project already states for wide content, and the
 * reason it is a rule.
 *
 * ### Colours come from the theme, except the two that mean something
 *
 * The line is `--accent`, so the graph matches whatever colour the app is set
 * to. Night shading and the rain bars use `--muted` and a fixed blue, because
 * they are carrying meaning rather than decoration — the same argument the
 * presence dots make for not following the accent.
 */
import type { Reading } from './weather-api';

type Hour = Reading['hours'][number];

/** Room for the labels above and the hour strip below. */
const PADDING = { top: 26, bottom: 42, left: 10, right: 10 };
/** Per hour. 30px is the narrowest that leaves a three-digit label readable. */
const HOUR_WIDTH = 31;
const PLOT_HEIGHT = 96;

/** `2026-08-22T14:00` → `2pm`, without going near `Date`. */
function hourLabel(time: string): string {
  const hour = Number(time.slice(11, 13));
  if (!Number.isFinite(hour)) return '';
  if (hour === 0) return '12am';
  if (hour === 12) return '12pm';
  return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
}

export function HourlyGraph({ hours, units }: { hours: Hour[]; units: 'c' | 'f' }) {
  // Two points is not a graph. Better to draw nothing than a line with no shape.
  if (hours.length < 3) return null;

  const width = PADDING.left + PADDING.right + (hours.length - 1) * HOUR_WIDTH;
  const height = PADDING.top + PLOT_HEIGHT + PADDING.bottom;

  const temps = hours.map((hour) => hour.temperature);
  const lowest = Math.min(...temps);
  const highest = Math.max(...temps);
  /*
   * A degree of padding, and never a zero span: a day that never moves off 70°
   * would otherwise divide by zero and put the line at the very top or off the
   * chart entirely, depending on which way the rounding fell.
   */
  const span = Math.max(highest - lowest, 1);
  const top = highest + span * 0.15;
  const bottom = lowest - span * 0.15;

  const x = (i: number) => PADDING.left + i * HOUR_WIDTH;
  const y = (temp: number) => PADDING.top + PLOT_HEIGHT * (1 - (temp - bottom) / (top - bottom));

  const line = hours.map((hour, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(hour.temperature)}`).join(' ');
  const area = `${line} L ${x(hours.length - 1)} ${PADDING.top + PLOT_HEIGHT} L ${x(0)} ${PADDING.top + PLOT_HEIGHT} Z`;

  /*
   * Night as shaded bands, computed as runs rather than one rect per hour — a
   * rect per hour leaves hairline seams between them at some zoom levels, which
   * reads as a rendering bug rather than as shading.
   */
  const nightBands: Array<{ from: number; to: number }> = [];
  for (let i = 0; i < hours.length; i += 1) {
    if (hours[i]!.isDay) continue;
    const start = i;
    while (i + 1 < hours.length && !hours[i + 1]!.isDay) i += 1;
    nightBands.push({ from: start, to: i });
  }

  // Every third hour, plus the last, so the right edge is never left unlabelled.
  const labelled = hours.map((_, i) => i).filter((i) => i % 3 === 0 || i === hours.length - 1);

  const rainiest = Math.max(...hours.map((hour) => hour.rain ?? 0));

  return (
    <div className="hourly-scroll">
      <svg
        className="hourly"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        /*
         * A colour and a line say nothing to a screen reader, and the numbers
         * are the whole content. The summary is the same one a person would
         * give if asked what the graph showed.
         */
        aria-label={`Hourly forecast: ${lowest}° to ${highest}°${units.toUpperCase()} over the next ${hours.length} hours, starting at ${hourLabel(hours[0]!.time)}.`}
      >
        <defs>
          <linearGradient id="hourly-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {nightBands.map((band) => {
          /*
           * Clamped to the chart rather than left to be clipped. A band half an
           * hour wider than the data is right in the middle — night does not
           * begin exactly on the hour the sample was taken — but at either end
           * it would hang outside the viewBox, and relying on the SVG overflow
           * default to tidy that up is the sort of thing that stops being true
           * the day this is dropped inside something with its own overflow.
           */
          const from = Math.max(0, x(band.from) - HOUR_WIDTH / 2);
          const to = Math.min(width, x(band.to) + HOUR_WIDTH / 2);
          return (
            <rect
              key={`night-${band.from}`}
              x={from}
              y={PADDING.top - 8}
              width={to - from}
              height={PLOT_HEIGHT + 8}
              className="hourly-night"
            />
          );
        })}

        {/* Rain first, so the temperature line sits over it rather than under. */}
        {rainiest > 0 &&
          hours.map((hour, i) =>
            hour.rain && hour.rain > 0 ? (
              <rect
                key={`rain-${hour.time}`}
                x={x(i) - 5}
                // Scaled against the wettest hour rather than against 100, or a
                // day of light drizzle would draw as a flat empty strip and look
                // like no rain at all.
                y={PADDING.top + PLOT_HEIGHT - (hour.rain / rainiest) * 20}
                width={10}
                height={(hour.rain / rainiest) * 20}
                rx={2}
                className="hourly-rain"
              >
                <title>{`${hourLabel(hour.time)} — ${hour.rain}% chance of rain`}</title>
              </rect>
            ) : null
          )}

        <path d={area} fill="url(#hourly-fill)" />
        <path d={line} className="hourly-line" fill="none" />

        {labelled.map((i) => (
          <g key={`point-${hours[i]!.time}`}>
            <circle cx={x(i)} cy={y(hours[i]!.temperature)} r={3} className="hourly-dot" />
            <text x={x(i)} y={y(hours[i]!.temperature) - 9} className="hourly-value" textAnchor="middle">
              {hours[i]!.temperature}°
            </text>
          </g>
        ))}

        {/* The hour strip: glyph then time, so the shape of the day reads at a
            glance before any of the numbers do. */}
        {labelled.map((i) => (
          <g key={`axis-${hours[i]!.time}`}>
            <text x={x(i)} y={PADDING.top + PLOT_HEIGHT + 20} textAnchor="middle" fontSize="13">
              {hours[i]!.glyph}
            </text>
            <text x={x(i)} y={PADDING.top + PLOT_HEIGHT + 34} className="hourly-axis" textAnchor="middle">
              {i === 0 ? 'Now' : hourLabel(hours[i]!.time)}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
