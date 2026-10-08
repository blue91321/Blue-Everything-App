import type { FeatureMeta, PanelMeta } from '@app/features/index';

// After the vault (50), which is the other feature-owned tab. Settings pins
// itself to the foot of the drawer regardless, so a growing list of features
// never pushes it out of reach.
export const meta: FeatureMeta = {
  id: 'integrations',
  label: 'Connections',
  glyph: '🔌',
  order: 55,
  /*
   * Each tab can be reached directly. Music is in the menu from the start and
   * goes on Home once Spotify is set up — before that its tile would only open
   * the setup. The rest can be switched on in Settings → General.
   */
  sections: [
    {
      id: 'music',
      label: 'Music',
      glyph: '🎧',
      inMenu: true,
      onHome: 'ready',
      // Connected, and allowed to start playback: what Play needs.
      // Both read the small status route; asked together, api.ts makes them one request.
      ready: () => import('@app/api').then(({ api }) => api.integrations.spotifyStatus().then((s) => s.connected && s.canPlay)),
      // Shuffle is on: the session is keeping the queue topped up.
      live: () => import('@app/api').then(({ api }) => api.integrations.spotifyStatus().then((s) => s.active)),
      // Asked again only when Spotify's side changes, not on every habit tick.
      watch: ['integrations'],
    },
    { id: 'friends', label: 'Friends', glyph: '👥' },
    { id: 'live', label: 'Live', glyph: '📺' },
    { id: 'following', label: 'Following', glyph: '⭐' },
    { id: 'connections', label: 'Services', glyph: '🔑' },
  ],
};

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
