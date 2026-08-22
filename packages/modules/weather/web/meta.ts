import type { FeatureMeta, PanelMeta } from '@app/features/index';

// After Notes (40) and before the vault (50): a glance-at-it screen belongs
// nearer the top than the ones you go and work in.
export const meta: FeatureMeta = { id: 'weather', label: 'Weather', glyph: '⛅', order: 45 };

/**
 * One panel, and it is the reason this package exists.
 *
 * The tab is where you set the place and see the next few days; the panel is
 * the answer in the corner of your eye while you are doing something else,
 * which is the whole test for a panel. Splitting the forecast into a second one
 * would fail that test — four days of highs is something you go and look at.
 */
export const panels: PanelMeta[] = [
  {
    id: 'weather:now',
    label: 'Weather',
    hint: 'what it is doing outside, with a button to check again',
  },
];
