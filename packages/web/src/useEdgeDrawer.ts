import { useCallback, useEffect, useRef, useState } from 'react';

/** Must match --drawer-width in styles.css. */
export const DRAWER_WIDTH = 260;

/** How far in from the left edge a drag may start to count as "open the menu". */
const EDGE_ZONE = 28;

/** Movement needed before deciding whether this is a horizontal or vertical drag. */
const AXIS_LOCK = 12;

export interface EdgeDrawer {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** Live position while a finger is down, or null when it isn't. */
  dragX: number | null;
}

const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max);

/**
 * Swipe-from-the-left-edge to open, swipe back to close.
 *
 * The drawer follows the finger rather than snapping on a threshold, because a
 * menu that moves with you feels like a drawer and one that jumps feels like a
 * bug. It commits on release based on how far it got.
 *
 * Axis locking matters: a vertical drag that happens to start near the left
 * edge is someone scrolling the list, and stealing it would make the app feel
 * broken. Nothing is preventDefault'd until the gesture is known to be
 * horizontal.
 */
export function useEdgeDrawer(enabled: boolean): EdgeDrawer {
  const [open, setOpen] = useState(false);
  const [dragX, setDragX] = useState<number | null>(null);

  const openRef = useRef(open);
  const gesture = useRef<{ startX: number; startY: number; axis: '?' | 'x' } | null>(null);

  /**
   * Where the drawer actually is, updated synchronously as the finger moves.
   *
   * `dragX` exists only to trigger a render. Deciding open-or-closed from it
   * would be a bug: React batches state updates, so when the final touchmove
   * and the touchend land in the same frame the rendered value is still stale
   * and the whole gesture is silently dropped.
   */
  const positionRef = useRef<number | null>(null);

  openRef.current = open;

  const toggle = useCallback(() => setOpen((v) => !v), []);

  useEffect(() => {
    if (!enabled) {
      // On desktop the drawer is always visible, so any half-finished mobile
      // gesture state has to be discarded or it leaks into the layout.
      setOpen(false);
      setDragX(null);
      return;
    }

    function onTouchStart(event: TouchEvent) {
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];

      // Closed: only start from the edge. Open: anywhere, so it can be pushed back.
      if (!openRef.current && touch.clientX > EDGE_ZONE) {
        gesture.current = null;
        return;
      }
      gesture.current = { startX: touch.clientX, startY: touch.clientY, axis: '?' };
    }

    function onTouchMove(event: TouchEvent) {
      const active = gesture.current;
      if (!active) return;

      const touch = event.touches[0];
      const dx = touch.clientX - active.startX;
      const dy = touch.clientY - active.startY;

      if (active.axis === '?') {
        if (Math.abs(dx) < AXIS_LOCK && Math.abs(dy) < AXIS_LOCK) return;
        if (Math.abs(dy) >= Math.abs(dx)) {
          gesture.current = null; // vertical — let the page scroll
          return;
        }
        active.axis = 'x';
      }

      // Only now, once it's certainly a horizontal drag, claim the gesture.
      event.preventDefault();
      const next = clamp((openRef.current ? DRAWER_WIDTH : 0) + dx, 0, DRAWER_WIDTH);
      positionRef.current = next;
      setDragX(next);
    }

    function onTouchEnd() {
      if (gesture.current?.axis === 'x' && positionRef.current !== null) {
        setOpen(positionRef.current > DRAWER_WIDTH / 2);
      }
      gesture.current = null;
      positionRef.current = null;
      setDragX(null);
    }

    // passive:false on move only, so preventDefault is allowed there.
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);
    document.addEventListener('touchcancel', onTouchEnd);

    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [enabled]);

  // Escape closes it, which costs nothing and is expected of anything modal.
  useEffect(() => {
    if (!enabled || !open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, open]);

  return { open, setOpen, toggle, dragX };
}

/** Tracks a media query, so layout decisions live in one place. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches
  );

  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
