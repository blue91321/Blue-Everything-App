/**
 * How far a download has got, as a ring.
 *
 * Drawn by hand like the gauge and the weather graph. A bar is the better shape
 * where there is a row's width to fill — the Downloads tab has one — and the
 * wrong one inside a 44px button beside a chapter, where a ring says the same
 * thing in the space a "12/40" took.
 *
 * `value` null is "waiting its turn": a dashed track with nothing filled, so a
 * chapter in the queue looks different from one at nought per cent, which is
 * a chapter that has started and found nothing yet. `spin` is for the moment
 * between starting and knowing how many pages there are.
 */
export function ProgressRing({
  value,
  size = 22,
  spin = false,
  label,
}: {
  value: number | null;
  size?: number;
  spin?: boolean;
  /** Said to a screen reader; a ring is nothing without it. */
  label?: string;
}) {
  const stroke = Math.max(2, Math.round(size / 9));
  const r = (size - stroke) / 2;
  const around = 2 * Math.PI * r;
  const filled = value === null ? 0 : Math.min(1, Math.max(0, value));
  return (
    <svg
      className={`manga-ring${spin ? ' spin' : ''}${value === null && !spin ? ' waiting' : ''}`}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <circle className="manga-ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
      {(filled > 0 || spin) && (
        <circle
          className="manga-ring-fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${spin ? around * 0.25 : around * filled} ${around}`}
          // From twelve o'clock, as a clock is read.
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      )}
    </svg>
  );
}

/** "1.2 MB/s" from bytes over a span — nothing until there is enough to say. */
export function speedText(bytes: number, ms: number): string | null {
  if (ms < 1500 || bytes <= 0) return null;
  const perSecond = bytes / (ms / 1000);
  if (perSecond < 1024 * 1024) return `${Math.max(1, Math.round(perSecond / 1024))} KB/s`;
  return `${(perSecond / 1024 / 1024).toFixed(1)} MB/s`;
}

/** "about 40s left" from how far one chapter has got — nothing while it is a guess. */
export function remainingText(done: number, total: number | null, ms: number): string | null {
  if (!total || done < 3 || done >= total || ms < 3000) return null;
  const left = ((total - done) * ms) / done / 1000;
  if (left < 60) return `about ${Math.max(5, Math.round(left / 5) * 5)}s left`;
  return `about ${Math.round(left / 60)} min left`;
}
