import type { FeatureMeta, PanelMeta } from '../index';

// After the vault (50), which is the other feature-owned tab. Settings pins
// itself to the foot of the drawer regardless, so a growing list of features
// never pushes it out of reach.
export const meta: FeatureMeta = { id: 'integrations', label: 'Connections', glyph: '🔌', order: 55 };

/**
 * What this feature offers to put beside the Dashboard.
 *
 * Only the friends list. Following and Music are things you go and browse; who
 * is around is the one answer here that changes minute to minute and is worth
 * having in the corner of your eye while you are doing something else — which
 * is the whole test for a panel.
 */
export const panels: PanelMeta[] = [
  {
    id: 'integrations:friends',
    label: 'Who is online',
    hint: 'friends in a game or around, from Steam, Discord and Riot',
  },
  /*
   * The second panel, and the reason `panels` was a list from the start rather
   * than one entry per feature: this is a different question from the friends
   * one and wants its own column, not a section inside it.
   */
  {
    id: 'integrations:live',
    label: 'Who is live',
    hint: 'followed channels currently streaming, from Twitch',
  },
];
