/**
 * What the menu and the Home screen show, chosen by you.
 *
 * Two lists of tiles were fixed: the menu showed every screen, and Home showed
 * the menu. Now a screen can carry **sections** — Connections → Music — which
 * appear under it in the menu and as tiles of their own on Home, and every
 * entry can be shown or hidden in either place from Settings → General.
 *
 * **Per device, in `localStorage`, unlike the theme.** The menu is mostly the
 * PC's and Home is mostly the phone's, and which tiles fit on a phone's first
 * screen is a fact about that phone. A choice made on one should not reshuffle
 * the other.
 *
 * Only *overrides* are stored. An entry nobody has touched follows its default,
 * so a section added in a later version appears where its default says rather
 * than being invisible because it was not in a list saved earlier.
 *
 * App publishes the entries it built here, which is how Settings — which
 * knows nothing about navigation — can list them.
 *
 * ### Home can be a list of your own
 *
 * Home follows the defaults until you arrange it. Once you do (Settings →
 * Home screen), `homeList` is the whole of it: exactly those tiles, in that
 * order, and nothing else, so "hide everything except these" is what an
 * arranged Home *is*. The cost is the one the Dashboard's own order states: a
 * part added in a later version is not on an arranged Home until you add it,
 * which Settings says, and it is offered there underneath.
 */
import { useEffect, useState } from 'react';

export type MenuEntry = {
  /** A screen's id, or `<screen>#<section>` for a section of one. */
  id: string;
  label: string;
  glyph: string;
  /** The screen a section belongs to; absent for a screen. */
  parent?: string;
  /** Shown in the menu unless you say otherwise. Screens always are. */
  defaultMenu: boolean;
  /** Shown on Home unless you say otherwise: yes, no, or once it is set up. */
  defaultHome: boolean | 'ready';
};

type Prefs = {
  menu: Record<string, boolean>;
  home: Record<string, boolean>;
  /** Home's tiles, in order, once arranged; absent while it follows the defaults. */
  homeList?: string[];
};
const KEY = 'menu-prefs';

function read(): Prefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>;
    const list = Array.isArray(v.homeList) ? v.homeList.filter((id): id is string => typeof id === 'string') : undefined;
    return { menu: v.menu ?? {}, home: v.home ?? {}, ...(list ? { homeList: list } : {}) };
  } catch {
    return { menu: {}, home: {} };
  }
}

let prefs = read();
let entries: MenuEntry[] = [];
let ready: Record<string, boolean> = {};
const listeners = new Set<() => void>();
const announce = () => listeners.forEach((l) => l());

/** Called by App with what it built, every render; cheap when nothing moved. */
export function publishEntries(next: MenuEntry[], nowReady: Record<string, boolean>): void {
  const same =
    next.length === entries.length &&
    next.every((e, i) => e.id === entries[i]!.id) &&
    JSON.stringify(nowReady) === JSON.stringify(ready);
  entries = next;
  ready = nowReady;
  if (!same) queueMicrotask(announce);
}

export function inMenu(entry: MenuEntry): boolean {
  if (!entry.parent) return true;
  return prefs.menu[entry.id] ?? entry.defaultMenu;
}

export function onHome(entry: MenuEntry): boolean {
  const chosen = prefs.home[entry.id];
  if (chosen !== undefined) return chosen;
  return entry.defaultHome === 'ready' ? ready[entry.id] === true : entry.defaultHome;
}

/**
 * The tiles on Home, in order: your list when you have arranged one (an id
 * nothing answers to, a switched-off feature, is skipped and kept), else every
 * entry shown by default, in the menu's order.
 */
export function homeTiles(all: readonly MenuEntry[]): MenuEntry[] {
  if (prefs.homeList) {
    return prefs.homeList.flatMap((id) => all.find((e) => e.id === id) ?? []);
  }
  return all.filter(onHome);
}

/** Whether Home is your own list rather than the defaults. */
export function homeArranged(): boolean {
  return prefs.homeList !== undefined;
}

/** Home's tiles, exactly these, in this order. */
export function setHomeList(ids: readonly string[]): void {
  prefs = { ...prefs, homeList: [...new Set(ids)] };
  save();
}

/** Whether a section is set up, for Settings to say so beside it. */
export function isReady(id: string): boolean | undefined {
  return ready[id];
}

export function setShown(where: 'menu' | 'home', id: string, shown: boolean): void {
  prefs = { ...prefs, [where]: { ...prefs[where], [id]: shown } };
  save();
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Kept for this visit only.
  }
  announce();
}

/** Home back to its defaults, leaving the menu's choices alone. */
export function resetHome(): void {
  prefs = { menu: prefs.menu, home: {} };
  save();
}

/** Back to every default, in one place. */
export function resetShown(): void {
  prefs = { menu: {}, home: {} };
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing stored to remove.
  }
  announce();
}

/** The entries App last published, re-rendering whoever asks when they or the choices change. */
export function useMenuEntries(): MenuEntry[] {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return entries;
}
