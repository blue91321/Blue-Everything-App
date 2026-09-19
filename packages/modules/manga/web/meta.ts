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
];
