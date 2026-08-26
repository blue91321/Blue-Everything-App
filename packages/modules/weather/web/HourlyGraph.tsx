/**
 * The next twenty-four hours, drawn.
 *
 * Hand-rolled SVG, like `Gauge.tsx` — a line, an area under it, and some text.
 * A chart library would be the largest dependency in this repo by some margin,
 * for one graph on one screen in an app whose whole bundle is 90KB and nearly
 * all of it React.
 *
 * ### It is measured, not scrolled and not scaled
 *
 * This started as a fixed-width SVG in an `overflow-x: auto` box, which is the
 * rule this project states for wide content — and it is the wrong rule here. A
 * graph you have to drag sideways is not one you can glance at, which is the
 * only reason to draw a graph rather than print a table.
 *
 * The other obvious fix is worse: `viewBox` plus `width: 100%` scales the
 * *text* along with the geometry, so a phone gets a chart with six-pixel labels.
 *
 * So the container is measured and the SVG drawn at exactly that width, with
 * the text at a fixed size — the same thing `ContextMenu` does when it measures
 * itself rather than guessing. All twenty-four hours are always plotted; what
 * gives way on a narrow screen is how many of them are *labelled*, which is the
 * one thing that can be dropped without the graph becoming a different graph.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import type { Reading } from './weather-api';

type Hour = Reading['hours'][number];

/** Room for the labels above and the hour strip below. */
const PADDING = { top: 26, bottom: 42, left: 14, right: 14 };
const PLOT_HEIGHT = 96;

/**
 * The narrowest a label may sit from its neighbour.
 *
 * `12am` is about 26px at this size, so 38 leaves a clear gap rather than the
 * "technically not overlapping" that reads as a mistake.
 */
const LABEL_ROOM = 38;

/**
 * Steps worth using, in preference order.
 *
 * Only divisors of the day, so the labels land on hours a person thinks in —
 * every 3 or every 6, not every 5, which would drift across noon and midnight
 * and make the strip harder to read than no labels at all.
 */
const STEPS = [1, 2, 3, 4, 6, 8, 12];

/** `2026-08-22T14:00` → `2pm`, without going near `Date`. */
function hourLabel(time: string): string {
  const hour = Number(time.slice(11, 13));
  if (!Number.isFinite(hour)) return '';
  if (hour === 0) return '12am';
  if (hour === 12) return '12pm';
  return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
}

export function HourlyGraph({ hours, units }: { hours: Hour[]; units: 'c' | 'f' }) {
  const box = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  /*
   * `useLayoutEffect` so the measurement lands before paint — with `useEffect`
   * the graph would draw once at zero width and again at the real one, which is
   * a visible flicker on every visit to the tab.
   *
   * **Two signals, on purpose.** `ResizeObserver` is the right one: the width
   * that matters is this box's, and opening the drawer or the Dashboard's side
   * column narrows it without the window changing at all. The `resize` listener
   * is the coarse backstop for the commonest case, and it exists because the one
   * environment available for testing this cannot deliver RO callbacks at all —
   * a browser pane that is not compositing frames delivers neither those nor
   * `requestAnimationFrame`, which this project has already been caught by once.
   *
   * Two cheap listeners against a measurement that must not silently stop
   * happening is a trade worth making. `setWidth` with the same number is a
   * no-op in React, so the overlap costs nothing.
   */
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;

    const measure = () => setWidth(element.clientWidth);
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  /*
   * And a re-measure after every render, which catches the case both listeners
   * miss: the box changing width as a *result* of something else re-rendering —
   * a longer place name, the error line appearing — where no resize event is
   * raised for the window and RO's notification arrives a frame later than the
   * paint that already looked wrong.
   *
   * It cannot loop: the state is only set when the number actually differs, and
   * the width does not depend on the width.
   */
  useLayoutEffect(() => {
    const element = box.current;
    if (element && element.clientWidth !== width) setWidth(element.clientWidth);
  });

  // Two points is not a graph. Better to draw nothing than a line with no shape.
  if (hours.length < 3) return null;

  const height = PADDING.top + PLOT_HEIGHT + PADDING.bottom;
  const plotWidth = Math.max(0, width - PADDING.left - PADDING.right);
  const hourWidth = plotWidth / (hours.length - 1);

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

  const x = (i: number) => PADDING.left + i * hourWidth;
  const y = (temp: number) => PADDING.top + PLOT_HEIGHT * (1 - (temp - bottom) / (top - bottom));

  /* As many labels as fit, at a spacing that lands on sensible hours. */
  const step = STEPS.find((candidate) => candidate * hourWidth >= LABEL_ROOM) ?? STEPS[STEPS.length - 1]!;
  const labelled = hours.map((_, i) => i).filter((i) => i % step === 0);
  /*
   * The last hour is labelled too, unless doing so would crowd the one before
   * it — the right-hand edge unlabelled looks like the graph was cut off.
   */
  const last = hours.length - 1;
  if (!labelled.includes(last) && (last - labelled[labelled.length - 1]!) * hourWidth >= LABEL_ROOM) {
    labelled.push(last);
  }

  const line = hours.map((hour, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(hour.temperature)}`).join(' ');
  const area = `${line} L ${x(last)} ${PADDING.top + PLOT_HEIGHT} L ${x(0)} ${PADDING.top + PLOT_HEIGHT} Z`;

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

  const rainiest = Math.max(...hours.map((hour) => hour.rain ?? 0));

  return (
    <div className="hourly-wrap" ref={box}>
      {/*
        Nothing until the width is known. One frame at zero width would draw
        every point stacked on the left edge, and `useLayoutEffect` means that
        frame is never painted anyway — this is only here so the maths below is
        never handed a zero.
      */}
      {width > 0 && (
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
             * Clamped to the chart rather than left to be clipped. A band half
             * an hour wider than the data is right in the middle — night does
             * not begin exactly on the hour the sample was taken — but at either
             * end it would hang outside the viewBox.
             */
            const from = Math.max(0, x(band.from) - hourWidth / 2);
            const to = Math.min(width, x(band.to) + hourWidth / 2);
            return (
              <rect
                key={`night-${band.from}`}
                x={from}
                y={PADDING.top - 8}
                width={Math.max(0, to - from)}
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
                  // Narrower than the slot, so the bars read as bars rather than
                  // as a solid block once the hours are close together.
                  x={x(i) - Math.min(5, hourWidth * 0.32)}
                  // Scaled against the wettest hour rather than against 100, or a
                  // day of light drizzle would draw as a flat empty strip and look
                  // like no rain at all.
                  y={PADDING.top + PLOT_HEIGHT - (hour.rain / rainiest) * 20}
                  width={Math.min(10, hourWidth * 0.64)}
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
              <text
                x={x(i)}
                y={y(hours[i]!.temperature) - 9}
                className="hourly-value"
                // The first and last labels are pulled inside the chart, or they
                // hang off the edge — the one place `textAnchor: middle` fails.
                textAnchor={i === 0 ? 'start' : i === last ? 'end' : 'middle'}
              >
                {hours[i]!.temperature}°
              </text>
            </g>
          ))}

          {/* The hour strip: glyph then time, so the shape of the day reads at a
              glance before any of the numbers do. */}
          {labelled.map((i) => (
            <g key={`axis-${hours[i]!.time}`}>
              <text
                x={x(i)}
                y={PADDING.top + PLOT_HEIGHT + 20}
                textAnchor={i === 0 ? 'start' : i === last ? 'end' : 'middle'}
                fontSize="13"
              >
                {hours[i]!.glyph}
              </text>
              <text
                x={x(i)}
                y={PADDING.top + PLOT_HEIGHT + 34}
                className="hourly-axis"
                textAnchor={i === 0 ? 'start' : i === last ? 'end' : 'middle'}
              >
                {i === 0 ? 'Now' : hourLabel(hours[i]!.time)}
              </text>
            </g>
          ))}
        </svg>
      )}
    </div>
  );
}
