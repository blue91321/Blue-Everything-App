/**
 * The right-click menu.
 *
 * Built as a general list of items rather than as an Edit button, because it is
 * going to grow — but with one item today, which is the honest amount to ship.
 *
 * ### It replaces the browser's menu, so it has to earn that
 *
 * Two concessions make the trade defensible:
 *
 *   - **A text selection wins.** Right-clicking on selected text still gets the
 *     browser's own menu, so copying a task title never stops working. That is
 *     the one thing the native menu is genuinely used for here.
 *   - **Only rows that offer something intercept it.** Everywhere else on the
 *     page behaves exactly as it did.
 *
 * ### There is no long-press
 *
 * Touch devices have no right-click, so this is a desktop affordance and is
 * stated as one rather than half-built. The phone reaches the same editors
 * through the tab and the `edit` button, which is why nothing is *only* here.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Rendered in the warning colour, for anything that destroys something. */
  danger?: boolean;
}

interface At {
  x: number;
  y: number;
}

/**
 * Wire a menu to an element.
 *
 * Returns the handler to spread onto whatever should offer it, and the menu
 * itself to render — which the caller places inside its own markup so the menu
 * unmounts with the row rather than outliving it.
 *
 * `items` is a function so it is evaluated when the menu opens, not on every
 * render of every row on the Dashboard.
 */
export function useContextMenu(items: () => MenuItem[]): {
  onContextMenu: (event: React.MouseEvent) => void;
  menu: React.ReactNode;
} {
  const [at, setAt] = useState<At | null>(null);
  const [open, setOpen] = useState<MenuItem[]>([]);

  const onContextMenu = useCallback(
    (event: React.MouseEvent) => {
      // Copying a title has to keep working — see the note at the top.
      if ((window.getSelection()?.toString() ?? '') !== '') return;

      const list = items();
      if (list.length === 0) return;

      event.preventDefault();
      // Or a nested row would open its parent's menu as well as its own.
      event.stopPropagation();
      setOpen(list);
      setAt({ x: event.clientX, y: event.clientY });
    },
    [items]
  );

  const close = useCallback(() => setAt(null), []);

  return {
    onContextMenu,
    menu: at ? <Menu at={at} items={open} onClose={close} /> : null,
  };
}

function Menu({ at, items, onClose }: { at: At; items: MenuItem[]; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState(at);

  /*
   * Clamped after measuring rather than guessed at.
   *
   * The menu's width depends on its longest label, which will change as items
   * are added, so a hard-coded estimate is a thing that silently stops being
   * true. `useLayoutEffect` so the correction happens before paint — measuring
   * in a normal effect would show one frame in the wrong place, and a menu that
   * visibly jumps is worse than one slightly off the edge.
   */
  useLayoutEffect(() => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return;
    const margin = 8;
    setPlaced({
      x: Math.max(margin, Math.min(at.x, window.innerWidth - rect.width - margin)),
      y: Math.max(margin, Math.min(at.y, window.innerHeight - rect.height - margin)),
    });
  }, [at]);

  useEffect(() => {
    /*
     * Everything that should dismiss it. Scroll and resize are in the list
     * because the menu is positioned in viewport coordinates against a point in
     * the document — leaving it up while the page moves would leave it pointing
     * at the wrong row, which is worse than closing.
     *
     * `pointerdown` rather than `click`, so it closes on the press rather than
     * on the release; a menu that survives until you let go feels stuck.
     */
    const dismiss = () => onClose();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={box}
      className="context-menu"
      role="menu"
      style={{ left: placed.x, top: placed.y }}
      // The window-level `pointerdown` closes on any press; without this, a press
      // that lands on the menu itself would close it before the click ran.
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          className={item.danger ? 'danger' : undefined}
          disabled={item.disabled}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
