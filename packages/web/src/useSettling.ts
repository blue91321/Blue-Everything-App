import { useCallback, useEffect, useRef, useState } from 'react';

/** Long enough to register the tick, short enough not to feel stuck. */
export const SETTLE_MS = 1800;

export interface Settling {
  /** True while this item should stay where it is, despite being done. */
  has: (id: string) => boolean;
  /** Pin an item in place for the settle delay. */
  hold: (id: string) => void;
}

/**
 * Keeps a just-completed item in place for a moment before it moves.
 *
 * Ticking something off and having it vanish instantly is disorienting — you
 * lose the confirmation that you hit the right one, and the list jumps under
 * your finger. So the row stays put, visibly done, and only then moves to the
 * finished section.
 *
 * The delay is purely visual. The server is updated immediately, so nothing is
 * lost if the app is closed mid-settle.
 */
export function useSettling(delayMs = SETTLE_MS): Settling {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const hold = useCallback(
    (id: string) => {
      const existing = timers.current.get(id);
      if (existing) clearTimeout(existing);

      setIds((current) => new Set(current).add(id));

      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          setIds((current) => {
            const next = new Set(current);
            next.delete(id);
            return next;
          });
        }, delayMs)
      );
    },
    [delayMs]
  );

  // Unmounting mid-settle must not leave timers firing into a dead component.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const has = useCallback((id: string) => ids.has(id), [ids]);

  return { has, hold };
}
