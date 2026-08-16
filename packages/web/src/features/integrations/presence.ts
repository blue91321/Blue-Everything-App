/**
 * What each presence state is called.
 *
 * **Its own module rather than a `const` in `Friends.tsx`, and the reason is
 * measured.** The Dashboard panel needs these six words, and importing them from
 * the Friends screen made choosing that panel download the entire Connections
 * chunk — 34KB, 9.5KB gzipped, of searching, filtering and account-linking — to
 * render a label. The panel itself is under a kilobyte.
 *
 * Rollup cannot tree-shake that away: `Friends.tsx` is one module and importing
 * any part of it pulls the module in.
 */
import type { FriendRow } from '../../api';

export const STATE_LABEL: Record<FriendRow['state'], string> = {
  'in-game': 'playing',
  online: 'online',
  away: 'away',
  dnd: 'busy',
  offline: 'offline',
  /*
   * Named after the service rather than the absence.
   *
   * It read "status unknown", which is accurate and says nothing you can act
   * on. These rows are Discord friends and nothing else — Discord is the only
   * provider here whose API carries no presence — so naming the service tells
   * you where the entry came from and, by implication, why there is no status
   * next to it.
   */
  unknown: 'discord',
};
