/**
 * The Dashboard's main column: what can be in it, and in what order.
 *
 * The side column has been an ordered list of opaque ids since the panel work;
 * this column was a fixed run of JSX, so "put habits at the top" was an edit to
 * `Dashboard.tsx` rather than a setting, and a package could contribute a card
 * to the narrow column beside the content but never to the content itself.
 *
 * ### Core sections are ids like any other
 *
 * The seven built-in sections are listed here with `core:` ids, and the
 * Dashboard looks each one up in a map it builds from its own state. They are
 * not components and deliberately not: every one of them reads the same
 * `tasks`, `habits` and `settling`, so making them components would mean
 * passing all of that down to each, to gain nothing — they are closures in one
 * component, ordered by a list of strings.
 *
 * A panel put in this column *is* a component, resolved exactly as the side
 * column resolves it. So the main column holds two kinds of thing and the
 * ordering does not care which is which, which is the point.
 *
 * ### An empty list means the default order
 *
 * This is the one place this differs from `dashboard_panels`, where empty is a
 * real choice. An empty side column is something somebody picks; an empty
 * Dashboard is not, and it is what every existing install would have had on the
 * morning this shipped. So `[]` means "whatever the app ships with", and
 * removing every block gives you the default back rather than a blank page.
 *
 * ### Ids are opaque, and an unknown one is dropped
 *
 * Same rule as the panels, for the same reason: an id belonging to a package
 * that is switched off keeps its place in the stored list and comes back when
 * the package does, rather than being quietly rewritten away.
 */

/** A section the Dashboard draws itself. */
export interface CoreBlock {
  id: string;
  label: string;
  hint: string;
  /**
   * The feature this belongs to, when it belongs to one.
   *
   * `habits` is switchable but not removable, so its sections must disappear
   * from the Dashboard and from the picker when it is switched off — the same
   * respect `notes:recent` pays its own switch.
   */
  featureId?: string;
}

/**
 * Every section core draws, in the order it shipped in.
 *
 * **This array is also the default order**, so a fresh install and an install
 * that has never touched the setting both look exactly as they did before any
 * of this existed. Changing the order here changes the default for everybody
 * who has not chosen one, which is the right behaviour and worth knowing.
 */
export const CORE_BLOCKS: CoreBlock[] = [
  { id: 'core:capture', label: 'Capture', hint: 'the box you type a task into' },
  { id: 'core:queue', label: 'Waiting for a good moment', hint: 'the nudge queue, and what will join it' },
  { id: 'core:due-today', label: 'Due today', hint: 'tasks with a date of today or earlier' },
  { id: 'core:anytime', label: 'Anytime', hint: 'tasks with no date at all' },
  { id: 'core:coming-up', label: 'Coming up', hint: 'tasks dated later than today' },
  { id: 'core:habits', label: 'Habits left', hint: 'what still wants doing today', featureId: 'habits' },
  { id: 'core:finished', label: 'Finished today', hint: 'what you have already done, dimmed' },
];

const CORE_IDS = new Set(CORE_BLOCKS.map((b) => b.id));

/** Is this id one of core's own sections? */
export function isCoreBlock(id: string): boolean {
  return CORE_IDS.has(id);
}

/** The built-in order, as ids. */
export function defaultBlockOrder(): string[] {
  return CORE_BLOCKS.map((b) => b.id);
}

/**
 * The order to draw, out of what was chosen.
 *
 * `undefined` is a server older than this column and `[]` is an install that
 * has never chosen — both give the default, and they are the same answer for
 * two different reasons rather than one case. Worth keeping separate in the
 * reader's head even though the branch is shared: the first will start sending
 * a list after a restart, the second will not until somebody chooses one.
 *
 * **A core section left out of a chosen list stays out.** That is the feature —
 * hiding "Coming up" has to be possible or the picker is only a reorderer. New
 * core sections added in a later version are the cost: somebody who has chosen
 * an order will not see them until they add them, which is why the picker lists
 * everything available rather than only what is unused.
 */
export function chosenBlocks(settings: { dashboardBlocks?: string[] } | null | undefined): string[] {
  const stored = settings?.dashboardBlocks;
  if (!stored || stored.length === 0) return defaultBlockOrder();
  return stored;
}
