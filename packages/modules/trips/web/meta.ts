import type { FeatureMeta, PanelMeta } from '@app/features/index';

/*
 * Under World in the menu, beside Weather. Written out here and again in that
 * package's own meta, since a package may not import another: see
 * `menu-groups.ts` in core.
 */
const WORLD = { id: 'world', label: 'World', glyph: '🌍' };

// Beside the weather (45): another glance-at-it screen, nearer the top than the
// ones you go and work in.
export const meta: FeatureMeta = { id: 'trips', label: 'Trips', glyph: '✈️', order: 46, group: WORLD };

/**
 * The next flight, and nothing else.
 *
 * That passes the panel test, the answer in the corner of your eye: when it
 * leaves, from which gate, and whether that has changed. A trip's places and
 * checklist are things you go and look at.
 */
export const panels: PanelMeta[] = [
  {
    id: 'trips:next',
    label: 'Next flight',
    hint: 'when it leaves, the gate, and any delay',
  },
];
