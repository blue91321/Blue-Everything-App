/**
 * Dragging things into a new order, by a grip, with a mouse or a finger.
 *
 * Written first inside `OrderedPicker` for the Dashboard's settings, and
 * lifted out when edit mode wanted the same on the Dashboard itself and on
 * Home's grid. One copy, because the parts that are easy to get wrong are the
 * same everywhere:
 *
 * - **Pointer events, on a grip.** A finger is a pointer, so there is one set
 *   of handlers; and only the grip takes `touch-action: none`, so the page
 *   still scrolls everywhere else.
 * - **The order on screen is a draft until the save comes back.** Dropping
 *   writes the whole list; clearing the draft at that moment would snap the
 *   item back for the length of the round trip, which reads as the drag having
 *   failed and then un-failed. It is held until `ids` changes.
 * - **A drag that ends where it started writes nothing.**
 *
 * Where the pointer is, is found from the items' own boxes rather than a row
 * height, so it works for rows of different heights and for a grid: the item
 * under the pointer, or failing that the nearest one.
 */
import { useEffect, useRef, useState, type PointerEvent } from 'react';

export function useReorder(ids: readonly string[], onCommit: (next: string[]) => void, disabled = false) {
  const [draft, setDraft] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const items = useRef(new Map<string, HTMLElement>());
  const order = draft ?? [...ids];

  const key = JSON.stringify(ids);
  useEffect(() => {
    setDraft(null);
    setDragging(null);
  }, [key]);

  const indexAt = (x: number, y: number, list: string[]): number => {
    let best = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < list.length; i++) {
      const el = items.current.get(list[i]!);
      if (!el) continue;
      const box = el.getBoundingClientRect();
      if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return i;
      const dx = x - (box.left + box.width / 2);
      const dy = y - (box.top + box.height / 2);
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    return best;
  };

  /** The ref for an item, so its box can be measured. */
  const item = (id: string) => (el: HTMLElement | null) => {
    if (el) items.current.set(id, el);
    else items.current.delete(id);
  };

  /** Everything the grip needs: spread onto it. */
  const grip = (id: string) => ({
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (disabled || order.length < 2) return;
      // Or the browser starts a text selection and the drag never happens.
      e.preventDefault();
      e.stopPropagation();
      // Capture keeps the moves coming to the grip once the pointer leaves it.
      // It throws for a pointer the browser no longer knows (one lifted in
      // the same instant), and the drag can still go ahead without it.
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Moves over the grip itself still arrive.
      }
      setDraft([...order]);
      setDragging(id);
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      if (dragging !== id) return;
      const current = draft ?? [...ids];
      const from = current.indexOf(id);
      const to = indexAt(e.clientX, e.clientY, current);
      if (to < 0 || to === from) return;
      const next = [...current];
      next.splice(to, 0, next.splice(from, 1)[0]!);
      setDraft(next);
    },
    onPointerUp: () => {
      if (dragging !== id) return;
      setDragging(null);
      if (draft && JSON.stringify(draft) !== key) onCommit(draft);
      else setDraft(null);
    },
    onPointerCancel: () => {
      setDragging(null);
      setDraft(null);
    },
    // Clicks on the grip are not clicks on whatever it sits in (a tile, a card).
    onClick: (e: { stopPropagation: () => void; preventDefault: () => void }) => {
      e.preventDefault();
      e.stopPropagation();
    },
  });

  /** Swap with a neighbour and write the whole list: the keyboard's way. */
  const move = (index: number, delta: number) => {
    const next = [...ids];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    onCommit(next);
  };

  return { order, dragging, item, grip, move };
}
