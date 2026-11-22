import type { FeatureMeta, PanelMeta } from '@app/features/index';

// Just after core's screens (10–40): the day's events sit beside the day's tasks.
export const meta: FeatureMeta = { id: 'calendar', label: 'Calendar', glyph: '📅', order: 41 };

/**
 * The week: today and the six days after, events and tasks with a due date
 * (Canvas assignments among them), as a week strip, an hour grid or today in
 * full. Usable in either Dashboard column. The id is the old "Coming up"
 * card's, so a Dashboard that had it has this.
 */
export const panels: PanelMeta[] = [
  {
    id: 'calendar:upcoming',
    label: 'This week',
    hint: 'the next seven days, events and tasks due, as a week, a grid or today first',
  },
];
