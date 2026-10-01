import type { FeatureMeta, PanelMeta } from '@app/features/index';

// After the weather (45) and before the vault (50). This is a list you go and
// tend rather than glance at, so it sits below the glance-at-it screens.
export const meta: FeatureMeta = { id: 'manga', label: 'Manga', glyph: '📖', order: 47 };

/**
 * One panel: what has landed that you have not read.
 *
 * Not the whole library, which is the tab's job — a panel has to answer a
 * question at a glance, and "what is waiting for me" is that question. A list of
 * everything you follow is something you go and look at, which is the test a
 * panel has to fail.
 */
export const panels: PanelMeta[] = [
  {
    id: 'manga:waiting',
    label: 'New chapters',
    hint: 'series with a chapter you have not marked off',
  },
  /*
   * The shelf, which the note above argued against — and the main column is
   * what changed. That argument was about the *side* column: 320px beside your
   * tasks, where a panel has to answer a question at a glance and a list of
   * everything you follow is something you go and look at instead.
   *
   * The Dashboard's main column is not that. It is the full width and it is
   * already a list of things you go and look at, so a shelf belongs in it on
   * exactly the terms the task sections do. It can still be put in the side
   * column, where it will be narrow and long — which is your call to make, not
   * this file's to prevent.
   */
  {
    id: 'manga:shelf',
    label: 'My shelf',
    hint: 'your library, or just the starred ones — set on the Manga tab',
  },
];
