import type { FeatureMeta, PanelMeta } from '@app/features/index';

// Just after core's screens (10–40): the day's events sit beside the day's tasks.
export const meta: FeatureMeta = { id: 'calendar', label: 'Calendar', glyph: '📅', order: 41 };

/**
 * What is coming up: today, and the next week. Usable in either Dashboard
 * column. Nothing coming up says so in a line rather than a card, since an
 * empty calendar is an ordinary week.
 */
export const panels: PanelMeta[] = [
  {
    id: 'calendar:upcoming',
    label: 'Coming up',
    hint: 'today’s events, then the rest of the week',
  },
];
