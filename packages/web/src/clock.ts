/**
 * One clock, for everything on screen that is a duration.
 *
 * ### The problem this fixes
 *
 * "Only when something changes" is the default and the honest description of
 * how this app updates — except that *time passing* is something changing, and
 * a screen full of durations was frozen until an unrelated refetch happened to
 * shake it. A friend read "away 25m" for an hour; a gauge said "empty in 4
 * hours" all evening; the weather said "1 hour ago" long after it was three.
 *
 * The fix is not a refetch. Every one of those is arithmetic on data already in
 * hand, so the screen only needs to be told that the current time moved.
 *
 * ### One interval, not one per component
 *
 * A `setInterval` per row would be dozens of timers on the Dashboard doing the
 * same thing at slightly different moments. This is a single timer with a
 * subscriber list, started when the first component asks and stopped when the
 * last one goes — so a screen with no durations on it pays nothing at all.
 *
 * **It makes no requests.** That distinction is the whole point: the refresh
 * setting decides how often to ask the *server* anything, and this decides how
 * often the numbers already on screen are redrawn. Leaving the refresh off and
 * still having the timers tick is exactly what "only when something changes"
 * should have meant all along.
 */
import { useEffect, useState } from 'react';

type Listener = () => void;

const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Ten seconds, which is finer than anything shown.
 *
 * Nothing here displays seconds — the coarsest unit on screen is a minute — so
 * a ten-second tick means a number is never more than ten seconds late to
 * change, at a cost of six wakeups a minute doing nothing but a comparison.
 * A minute-long tick would be cheaper and would show "away 4m" for up to a
 * minute after it became five, which is the sort of small wrongness that is
 * hard to notice and impossible to trust.
 */
const TICK_MS = 10_000;

function start(): void {
  if (timer) return;
  timer = setInterval(() => {
    /*
     * Skipped while the tab is hidden, like the refresh interval — a background
     * tab redrawing timers is work for a screen nobody is looking at. Coming
     * back re-renders anyway, because the visibility handler in `live.ts`
     * announces a change and every reader refetches.
     */
    if (document.visibilityState !== 'visible') return;
    for (const listener of [...listeners]) listener();
  }, TICK_MS);
}

function stop(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/**
 * The current time, re-rendering the caller as it moves.
 *
 * Returned rather than merely forcing a render, so a component reads one
 * consistent value — two calls to `Date.now()` in the same render can differ,
 * which is how a row shows one duration in its text and another in its title.
 */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const listener = () => setNow(Date.now());
    listeners.add(listener);
    start();

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) stop();
    };
  }, []);

  return now;
}
