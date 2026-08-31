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
/**
 * The states, declared here rather than imported.
 *
 * **This file has no imports, and that is now load-bearing twice over.** It was
 * already split out so the Dashboard panel would not drag in the Connections
 * chunk; having nothing to resolve is what additionally lets `smoke` import it
 * and check the formatting below, which is the half that ends up on screen.
 * `@app/api` is a Vite alias, so a single type import from it put this file
 * beyond the server's typechecker the moment the suite reached for it.
 *
 * Mirrors `PRESENCE_STATES` in shared, which this package cannot import — the
 * same duplication, for the same reason, that `api.ts` already carries.
 */
export type PresenceState =
  | 'offline'
  | 'online'
  | 'away'
  | 'in-game'
  | 'in-game-away'
  | 'dnd'
  | 'unknown';

export const STATE_LABEL: Record<PresenceState, string> = {
  'in-game': 'playing',
  online: 'online',
  /*
   * Says both halves, because either alone is the misreading this state exists
   * to stop: "playing" reads as available and "away" hides that a match is
   * running and they may be back in a minute.
   */
  'in-game-away': 'playing, but away',
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

/**
 * How long somebody has been away, or empty when nobody can say.
 *
 * Only the two away states. `online` for twenty minutes is a fact about
 * nothing, `offline` already has a better line in "last on Tuesday", and
 * `unknown` is specifically the state that means we cannot vouch for anything —
 * putting a duration on it would be the confident wrong answer this screen
 * exists to avoid.
 *
 * Deliberately coarse. The point is "long enough to bother?", and to a minute is
 * a precision this number does not have: it is measured from when the app first
 * noticed the state, not from when the person walked away.
 */
/**
 * What the duration actually means, for a `title`.
 *
 * Every value here is a lower bound: it is counted from when this app first saw
 * somebody in the state they are in now, not from when they walked away. That
 * is usually the same thing and sometimes very much not — a row backfilled on
 * the sync after an update starts from zero however long they had already been
 * gone — so the number says so on hover rather than presenting itself as a fact
 * about the person.
 */
export const AWAY_TITLE = 'Counted from when this app first saw them this way, so it may be an undercount.';

export function awayFor(friend: { state: PresenceState; stateSince?: number | null }): string {
  if (friend.state !== 'away' && friend.state !== 'in-game-away') return '';
  if (!friend.stateSince) return '';

  const minutes = Math.floor((Date.now() - friend.stateSince) / 60_000);
  /*
   * Only the first minute is silent, and it was five.
   *
   * Five was reasoning about the wrong thing — that a fresh "away 1m" is noise
   * — but on a real list it meant rows sitting in the away section with nothing
   * against them for five minutes, which reads as the feature being broken
   * rather than as restraint. "away 2m" is a small fact; a blank where every
   * neighbour has a number is a puzzle.
   */
  if (minutes < 1) return '';
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;

  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day' : `${days} days`;
}
