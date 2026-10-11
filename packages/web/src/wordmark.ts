/**
 * The app's name, and the one way to change it.
 *
 * Tap the name ten times in a row and it becomes "Blue Dabadee" until the page
 * is reloaded. Held in this module rather than in `localStorage` or settings,
 * because "until I refresh" is exactly the lifetime of a module's variables.
 *
 * In a row means each tap within a second and a half of the last, so ten taps
 * spread over a week of opening the menu do not set it off.
 */
import { useSyncExternalStore } from 'react';

const NAME = 'Blue Everything';
const EGG = 'Blue Dabadee';
const TAPS = 10;
const WITHIN_MS = 1500;

let dabadee = false;
let taps = 0;
let lastTap = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Count a tap on the name; the tenth in a row turns it. */
export function tapWordmark() {
  if (dabadee) return;
  const now = Date.now();
  taps = now - lastTap <= WITHIN_MS ? taps + 1 : 1;
  lastTap = now;
  if (taps < TAPS) return;
  dabadee = true;
  document.title = document.title.replace(NAME, EGG);
  for (const l of listeners) l();
}

/** The name to show, which every place drawing it reads so they change together. */
export function useWordmark(): string {
  return useSyncExternalStore(subscribe, () => (dabadee ? EGG : NAME));
}
