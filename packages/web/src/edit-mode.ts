/**
 * Edit mode: the screens show what you can change, and changing it is a click.
 *
 * Switched on from the menu (✎ Edit screens) and off from the bar it puts at
 * the top of the screen. While it is on, outlined text can be renamed
 * (`ui-text.tsx`) and sections that can move have a ⠿ to drag them by
 * (`reorder.ts`).
 *
 * Per device and per visit, deliberately not saved: a reload in the middle of
 * editing coming back in edit mode would leave every label in the app a click
 * away from a rename. What you change is saved; being in the mode is not.
 */
import { useEffect, useState } from 'react';

let on = false;
const listeners = new Set<() => void>();

export function editMode(): boolean {
  return on;
}

export function setEditMode(next: boolean): void {
  if (next === on) return;
  on = next;
  // For the stylesheet: outlines, grips and the bar are drawn off this class.
  document.body.classList.toggle('editing', on);
  listeners.forEach((l) => l());
}

/** Whether edit mode is on, re-rendering the caller when it changes. */
export function useEditMode(): boolean {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return on;
}
