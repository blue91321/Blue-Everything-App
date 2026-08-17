/**
 * "Take me to that thing, on the screen that edits it."
 *
 * A tiny port rather than a prop threaded down from `App`, and the reason is the
 * distance: the thing asking is a row, three components below the only component
 * that knows what a view is, and none of the components in between have any
 * business carrying a navigate function. That is the same argument
 * `features/index.ts` makes for its enabled-list — except this one genuinely has
 * to cause a re-render, so it is a listener rather than a bare variable.
 *
 * Deliberately not a router. This app has one `useState` for the current view
 * and no URLs, which is worth keeping: the whole navigation model is a string,
 * and adding a router to satisfy one context-menu item would be a dependency and
 * a concept for something a callback already does.
 */

/** Where to go, and what to open when you get there. */
export interface NavRequest {
  /** A `NavId` from App — kept as a string here so this file imports nothing. */
  view: string;
  /** The id of the row to open for editing, if any. */
  focus?: string;
}

/**
 * One listener, not a set.
 *
 * There is exactly one `App`, and a second subscriber would mean two things
 * claiming to own the current view — which is a bug rather than a feature worth
 * supporting. Replacing rather than appending makes that impossible to get
 * wrong through a hot reload.
 */
let listener: ((request: NavRequest) => void) | null = null;

export function onNavigate(fn: (request: NavRequest) => void): () => void {
  listener = fn;
  return () => {
    if (listener === fn) listener = null;
  };
}

/**
 * Ignored when nothing is listening, which is the honest behaviour: the only
 * caller is a menu item inside a rendered `App`, so a dropped request means
 * something has gone wrong upstream and a throw here would take the app down to
 * report it.
 */
export function goTo(view: string, focus?: string): void {
  listener?.({ view, focus });
}
