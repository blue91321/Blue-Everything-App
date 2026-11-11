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
}

const KEY = 'menu-folders';
const EMPTY: FolderPrefs = { made: [], placed: {}, removed: [] };
/** A folder you make starts as this; the name is changed in edit mode. */
export const NEW_FOLDER_GLYPH = '📁';

function read(): FolderPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<FolderPrefs> | null;
    if (!raw || typeof raw !== 'object') return EMPTY;
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
    return { made, placed, removed };
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
  write({
    made: prefs.made.filter((f) => f.id !== id),
    placed,
    removed: made || prefs.removed.includes(id) ? prefs.removed : [...prefs.removed, id],
  });
}

/** Everything back as the packages declare it. */
export function resetFolders(): void {
  write(EMPTY);
}

export const foldersChanged = () => prefs.made.length > 0 || prefs.removed.length > 0 || Object.keys(prefs.placed).length > 0;
