/**
 * Folders in the menu that you arrange yourself (2026-11-03): World and
 * Command as the packages declare them, and any you make, with screens moved
 * in and out of them.
 *
 * **What the packages say is the default, and yours are overrides**, the
 * arrangement `menu-prefs.ts` uses. A package's `meta.ts` names its folder
 * (`group`), so Weather and Trips arrive in World and Voice, Blueprints and
 * Code in Command. What is stored is only what you changed: where you put a
 * screen (`placed`, a folder id, or '' for the top of the menu), the folders
 * you made, and the package folders you removed. A screen you never moved
 * follows its package, so one added later lands where it says.
 *
 * **Per device**, like the rest of the menu's choices: the menu is mostly the
 * PC's, and how a phone's drawer is arranged is a fact about that phone.
 * A folder's name is the exception, since it is renamed the way edit mode
 * renames any heading (`group:<id>` in ui-text), which every device shares.
 *
 * ### How a folder starts, and what shows while it is folded (2026-11-20)
 *
 * Each folder starts **open or folded**, your choice (`open`), every time the
 * app opens; folding or opening one by its heading lasts until the app is
 * opened again (`menu-groups.ts` keeps that for the visit). And any screen or
 * section in a folder can be **shown while it is folded** (`shown`), under the
 * heading, so a folder can be one line plus the one thing you use daily.
 * Asked for together with folding the menu's two settings cards into one.
 *
 * Folders were remembered open the other way: opening one by hand kept it open
 * on this device for good (`menu-groups-open`). Those are read once as folders
 * that start open, so nothing on screen moved the day this changed.
 */
import { useSyncExternalStore } from 'react';
import type { MenuGroup } from './menu-groups';

export interface FolderPrefs {
  /** Folders you made, in the order you made them. */
  made: MenuGroup[];
  /** Where you put a screen: a folder's id, or '' for the top of the menu. */
  placed: Record<string, string>;
  /** Package folders you removed; their screens go to the top of the menu. */
  removed: string[];
  /** Folders that start open when the app opens; the rest start folded. */
  open: Record<string, boolean>;
  /** Screens and sections (`<screen>#<section>`) shown under their folder's heading even while it is folded. */
  shown: string[];
}

const KEY = 'menu-folders';
const EMPTY: FolderPrefs = { made: [], placed: {}, removed: [], open: {}, shown: [] };
/** Where folders opened by hand used to be kept for good; read once as folders that start open. */
const OLD_OPEN_KEY = 'menu-groups-open';
/** A folder you make starts as this; the name is changed in edit mode. */
export const NEW_FOLDER_GLYPH = '📁';

function read(): FolderPrefs {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<FolderPrefs> | null;
    const raw: Partial<FolderPrefs> = parsed && typeof parsed === 'object' ? parsed : {};
    const made = Array.isArray(raw.made)
      ? raw.made.filter(
          (f): f is MenuGroup => !!f && typeof f.id === 'string' && typeof f.label === 'string' && typeof f.glyph === 'string'
        )
      : [];
    const placed: Record<string, string> = {};
    if (raw.placed && typeof raw.placed === 'object') {
      for (const [screen, folder] of Object.entries(raw.placed)) if (typeof folder === 'string') placed[screen] = folder;
    }
    const removed = Array.isArray(raw.removed) ? raw.removed.filter((x): x is string => typeof x === 'string') : [];
    const open: Record<string, boolean> = {};
    if (raw.open && typeof raw.open === 'object') {
      for (const [id, v] of Object.entries(raw.open)) if (typeof v === 'boolean') open[id] = v;
    } else {
      // Before folders had a starting state: the ones you had opened start open.
      try {
        const old = JSON.parse(localStorage.getItem(OLD_OPEN_KEY) ?? '[]') as unknown;
        if (Array.isArray(old)) for (const id of old) if (typeof id === 'string') open[id] = true;
      } catch {
        // Nothing to carry over.
      }
    }
    const shown = Array.isArray(raw.shown) ? raw.shown.filter((x): x is string => typeof x === 'string') : [];
    return { made, placed, removed, open, shown };
  } catch {
    return EMPTY;
  }
}

let prefs = read();
const listeners = new Set<() => void>();

function write(next: FolderPrefs): void {
  prefs = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Kept for this visit only.
  }
  for (const listener of listeners) listener();
}

export function useFolderPrefs(): FolderPrefs {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => prefs
  );
}

/**
 * Every folder there is: the packages' (first declarer's name wins, as in
 * `menu-groups.ts`) less the ones you removed, then yours.
 */
export function foldersFrom(declared: readonly (MenuGroup | undefined)[], p: FolderPrefs = prefs): MenuGroup[] {
  const out = new Map<string, MenuGroup>();
  for (const g of declared) if (g && !p.removed.includes(g.id) && !out.has(g.id)) out.set(g.id, g);
  for (const g of p.made) if (!out.has(g.id)) out.set(g.id, g);
  return [...out.values()];
}

/** Which folder a screen is in now: where you put it, else where its package said, else none. */
export function folderFor(
  screenId: string,
  declared: MenuGroup | undefined,
  folders: readonly MenuGroup[],
  p: FolderPrefs = prefs
): MenuGroup | undefined {
  const placed = p.placed[screenId];
  const id = placed !== undefined ? placed : declared?.id;
  return id ? folders.find((f) => f.id === id) : undefined;
}

/** Whether a folder starts open when the app opens. */
export const startsOpen = (folderId: string, p: FolderPrefs = prefs): boolean => p.open[folderId] === true;

export function setStartsOpen(folderId: string, open: boolean): void {
  write({ ...prefs, open: { ...prefs.open, [folderId]: open } });
}

/** Whether a screen or section shows under its folder's heading while the folder is folded. */
export const shownFolded = (entryId: string, p: FolderPrefs = prefs): boolean => p.shown.includes(entryId);

export function setShownFolded(entryId: string, shown: boolean): void {
  const rest = prefs.shown.filter((id) => id !== entryId);
  write({ ...prefs, shown: shown ? [...rest, entryId] : rest });
}

/** Put a screen in a folder, or at the top of the menu with ''. */
export function putInFolder(screenId: string, folderId: string): void {
  write({ ...prefs, placed: { ...prefs.placed, [screenId]: folderId } });
}

/** Make a folder, empty, and say its id. */
export function makeFolder(label: string): string {
  const id = `folder-${Date.now().toString(36)}`;
  write({ ...prefs, made: [...prefs.made, { id, label: label.trim() || 'New folder', glyph: NEW_FOLDER_GLYPH }] });
  return id;
}

/**
 * Remove a folder. What was in it goes to the top of the menu, not with it:
 * a folder is a heading, and removing a heading must never take a screen away.
 */
export function removeFolder(id: string): void {
  const made = prefs.made.some((f) => f.id === id);
  const placed = Object.fromEntries(Object.entries(prefs.placed).filter(([, folder]) => folder !== id));
  const { [id]: _gone, ...open } = prefs.open;
  write({
    ...prefs,
    made: prefs.made.filter((f) => f.id !== id),
    placed,
    removed: made || prefs.removed.includes(id) ? prefs.removed : [...prefs.removed, id],
    open,
  });
}

/** Everything back as the packages declare it. */
export function resetFolders(): void {
  write(EMPTY);
  try {
    localStorage.removeItem(OLD_OPEN_KEY);
  } catch {
    // Read only when nothing newer is stored, which is no longer the case.
  }
}

export const foldersChanged = () =>
  prefs.made.length > 0 || prefs.removed.length > 0 || Object.keys(prefs.placed).length > 0 || Object.keys(prefs.open).length > 0 || prefs.shown.length > 0;
