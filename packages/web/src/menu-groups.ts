/**
 * Headings in the menu that gather screens under them: Weather and Trips
 * under World.
 *
 * **A group is a heading, not a screen.** Weather and Trips are separate
 * packages and either can be switched off or deleted, so nothing here may
 * depend on both being present. Each member's `meta.ts` names the group itself
 * (`group: { id, label, glyph }`); the menu gathers every screen naming the same
 * id, wherever its `order` put it, at the place of the first. A group with one
 * member left still shows its heading, since the member still said where it
 * belongs, and a group with none is simply not drawn.
 *
 * The label is written in each member rather than once somewhere shared,
 * because there is nowhere shared: a package may not import another, and core
 * does not know which packages exist. If they disagree, the first member's
 * wins.
 *
 * Only the menu is grouped. Home is a launcher of screens and keeps a tile per
 * screen, and Settings lists screens as it always did.
 *
 * **A group starts folded**, so World is one line in the menu until you open
 * it. What is stored is the groups you have *opened*, per device in
 * `localStorage` like the notes tree: the menu is mostly the PC's and a choice
 * about it is about that screen. Storing the open ones rather than the shut
 * ones is what makes folded the default for a group added later too.
 */
import type { MenuEntry } from './menu-prefs';

export interface MenuGroup {
  id: string;
  label: string;
  glyph: string;
}

export type MenuRow =
  | { kind: 'entry'; entry: MenuEntry; inGroup: boolean }
  | { kind: 'group'; group: MenuGroup; members: string[] };

/**
 * The menu's rows in order: screens and their sections as before, with each
 * group's members gathered under one heading where the first of them falls.
 *
 * `groupOf` answers for screens only; a section goes wherever its screen goes.
 */
export function groupMenu(entries: readonly MenuEntry[], groupOf: (screenId: string) => MenuGroup | undefined): MenuRow[] {
  const rows: MenuRow[] = [];
  const emitted = new Set<string>();
  const screenOf = (e: MenuEntry) => e.parent ?? e.id;

  for (const e of entries) {
    const group = groupOf(screenOf(e));
    if (!group) {
      rows.push({ kind: 'entry', entry: e, inGroup: false });
      continue;
    }
    if (emitted.has(group.id)) continue;
    emitted.add(group.id);
    const inside = entries.filter((x) => groupOf(screenOf(x))?.id === group.id);
    rows.push({ kind: 'group', group, members: [...new Set(inside.map(screenOf))] });
    for (const x of inside) rows.push({ kind: 'entry', entry: x, inGroup: true });
  }
  return rows;
}

const OPEN_KEY = 'menu-groups-open';

export function readOpen(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveOpen(open: ReadonlySet<string>): void {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...open]));
  } catch {
    // Kept for this visit only.
  }
}
