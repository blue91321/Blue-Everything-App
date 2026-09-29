/**
 * The screen you are on, written into the URL.
 *
 * Two complaints from a phone, and they turn out to be one missing thing:
 *
 *   - **refreshing lands you somewhere else.** The current view is a `useState`
 *     in `App`, so a reload throws it away and the app opens on its default —
 *     the launcher on a phone, the Dashboard anywhere else. Pulling to refresh
 *     is an ordinary thing to do on Android, and being moved for it reads as
 *     the app having lost your place;
 *   - **the back arrow leaves the app.** An installed PWA with one history
 *     entry has nowhere to go back *to*, so Android does the only thing left
 *     and closes it. Every other app on that phone goes up a screen first.
 *
 * Both are the same absence: the app never told the browser it had navigated,
 * so the browser had nothing to restore and nothing to go back through. One
 * history entry per screen answers both at once.
 *
 * **This is still not a router**, which `nav.ts` argues against at length and
 * this file does not reverse. Nothing is fetched, no dependency arrives, there
 * are no route patterns and no parameters — the navigation model is the same
 * one string it has always been, and this writes it down where the browser can
 * see it. What a router would add is the part that is deliberately still
 * absent: a URL per row, per folder, per settings tab.
 *
 * ### The fragment, rather than a path
 *
 * `#/tasks` rather than `/tasks`, and that is not cosmetic. A path would be a
 * real URL the server has to answer — every deep link a 404 unless Fastify
 * learns to serve the shell for arbitrary paths, and the service worker's
 * navigation handling would have to agree with it. A fragment never leaves the
 * browser. The app is served at one URL and keeps being served at one URL.
 *
 * The slash earns its place too: a bare `#tasks` is an anchor, and a browser
 * will happily scroll an element with that id into view. `#/` can never name
 * one.
 */

import { useCallback, useEffect, useRef } from 'react';

/** Everything this file writes is under here, so nothing else collides with it. */
const PREFIX = '#/';

/** The launcher, and the screen every back button eventually reaches. */
const ROOT = 'home';

/** What `history.state` carries, so a pop can be told from any other entry. */
interface ViewState {
  everythingView: string;
  /**
   * Set on an entry that is a *step inside* a screen rather than a screen of
   * its own — see the steps section below. Absent on a plain view entry, which
   * is why the comparison there treats "no id" as zero.
   */
  stepId?: number;
}

function isViewState(value: unknown): value is ViewState {
  return typeof (value as ViewState | null)?.everythingView === 'string';
}

/**
 * The view named by the current URL, or null.
 *
 * Read from the URL rather than from `history.state` because the URL is the
 * half that survives being typed, bookmarked, or handed to somebody. The state
 * object is the faster answer and only exists for entries this app pushed.
 */
export function viewFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const { hash } = window.location;
  if (!hash.startsWith(PREFIX)) return null;
  const id = decodeURIComponent(hash.slice(PREFIX.length)).trim();
  return id === '' ? null : id;
}

function urlFor(view: string): string {
  return `${PREFIX}${view}`;
}

/**
 * Put the starting screen in the URL, with the launcher underneath it.
 *
 * The seeding is the half that answers "back closed my app". Going back from a
 * screen you opened should reach the screen you opened it from, and on a cold
 * start there isn't one — so the launcher is made to be it. That is what every
 * app on the phone does: back walks up to the home screen, and only then out.
 *
 * Nothing is seeded when the launcher *is* where you started, because back out
 * of the root screen is the correct place to leave. An entry there would mean
 * pressing back and watching nothing happen, which is worse than leaving.
 *
 * `replaceState` first, then `pushState`: an entry cannot be inserted beneath
 * the one you are on, so the one you are on becomes the launcher and the real
 * starting screen is pushed on top of it.
 */
export function startHistory(view: string): void {
  if (typeof window === 'undefined') return;
  steps.length = 0;
  closing.clear();
  /*
   * Already seeded, so leave the stack alone.
   *
   * A browser restores `history.state` across a reload, so this entry carrying
   * one means the app has run here before and whatever was behind it still is
   * — seeding again would bury a real back stack under a second launcher.
   *
   * It covers the development case for free: React's StrictMode mounts, throws
   * the mount away and mounts again, and without this each of those would add
   * an entry that does nothing when you press back.
   */
  if (isViewState(window.history.state)) return;
  window.history.replaceState({ everythingView: ROOT } satisfies ViewState, '', urlFor(ROOT));
  if (view === ROOT) return;
  window.history.pushState({ everythingView: view } satisfies ViewState, '', urlFor(view));
}

/** Going somewhere new: one entry, so back comes back here. */
export function pushView(view: string): void {
  if (typeof window === 'undefined') return;
  if (viewFromUrl() === view) return; // Already here; a duplicate entry is a dead back press.
  // A different screen's insides are not ours to unwind any more.
  steps.length = 0;
  closing.clear();
  window.history.pushState({ everythingView: view } satisfies ViewState, '', urlFor(view));
}

/* ------------------------------------------------------------------ *
 * Steps inside a screen
 * ------------------------------------------------------------------ *
 *
 * The manga screen is the reason this exists. It has five tabs of its own, a
 * chapter list that covers them and a reader that covers that — three levels
 * of navigation core has never heard of, because they belong to a package. So
 * back went straight past all of it and left the screen entirely: from halfway
 * through a chapter to the Dashboard in one press.
 *
 * A step is an entry that means "something opened *within* the screen you are
 * on". Popping it runs the handler that closes that something and changes no
 * view. The screen stays where it is.
 *
 * **Identified by a number that only ever goes up, not by depth.** Depth was
 * the first version and it cannot survive a screen being abandoned: leave the
 * manga tab with a reader open and its entries are still in the stack with
 * nothing left to close, so every later count is one out and the wrong handler
 * runs. An id compares honestly instead — anything we are still holding whose
 * id is above the entry we landed on gets closed, and an entry belonging to a
 * screen that is gone matches nothing and quietly does nothing.
 */

/** Open steps, oldest first. Each one owns exactly one history entry. */
const steps: Array<{ id: number; onPop: () => void }> = [];

/**
 * Steps whose `history.back()` has been asked for and not yet arrived.
 *
 * `back()` is asynchronous, so a double-tap on a ✕ would ask twice and go back
 * two entries — closing the reader *and* the chapter list under it from one
 * press that was meant for the reader.
 */
const closing = new Set<number>();

/** Never reused, so an id is a moment rather than a position. */
let nextStepId = 0;

/**
 * Something opened inside the current screen; back should close it.
 *
 * The URL deliberately does not change. A step is a state of the screen rather
 * than an address, and inventing one would promise that reloading brings the
 * reader back — which it would not.
 *
 * **Call it from something the person did.** Chrome skips a `pushState` made
 * without a user gesture when deciding where back goes, so a step pushed from
 * a timer is one back walks straight past. Every caller here is inside a tap.
 */
export function pushStep(onPop: () => void): number {
  if (typeof window === 'undefined') return 0;
  const id = ++nextStepId;
  steps.push({ id, onPop });
  const view = (isViewState(window.history.state) ? window.history.state.everythingView : viewFromUrl()) ?? ROOT;
  window.history.pushState({ everythingView: view, stepId: id } satisfies ViewState, '', window.location.hash || urlFor(view));
  return id;
}

/** The screen closed it some other way, and its entry is already behind us. */
export function forgetStep(id: number): void {
  closing.delete(id);
  const at = steps.findIndex((step) => step.id === id);
  if (at >= 0) steps.splice(at, 1);
}

/**
 * Close a step from inside the app — the ✕ on a reader, the ‹ Back on a list.
 *
 * It goes through `history.back()` rather than closing directly, so there is
 * **one way out and not two**. Two would mean a control that closes the screen
 * and leaves its entry behind, and the next back press would then appear to do
 * nothing at all.
 */
export function popStep(id: number): void {
  if (typeof window === 'undefined') return;
  if (closing.has(id)) return;
  if (!steps.some((step) => step.id === id)) return;
  /*
   * The handler is deliberately left in place. Removing it here and then going
   * back was the first version, and it did exactly half the job: the entry went
   * and the reader stayed open, because the thing that closes it only ever runs
   * from the pop. Found on the emulator — the ✕ took a press off the history
   * and changed nothing on screen.
   *
   * So this asks the browser to go back and lets `popstate` do the closing,
   * which is the whole point of having one way out.
   */
  closing.add(id);
  window.history.back();
}

/**
 * Back or forward was pressed.
 *
 * The view is taken from the URL, with `history.state` as the check that this
 * entry is one of ours — an entry from before this shipped, or one some other
 * code pushed, should leave the app where it is rather than navigating it to
 * nothing.
 */
export function onPopView(handler: (view: string | null) => void): () => void {
  const listener = (event: PopStateEvent) => {
    const state = isViewState(event.state) ? event.state : null;

    /*
     * Steps first, and every step above where we landed — one press can cross
     * more than one when a long-press or a gesture goes back twice, and closing
     * only the top would leave a reader open underneath a closed chapter list.
     *
     * A plain view entry carries no id, which reads as zero, so landing on one
     * closes everything the screen had open. Closed newest first, because that
     * is the order they were opened in and a handler may depend on what is
     * still underneath it.
     */
    const landed = state?.stepId ?? 0;
    while (steps.length > 0 && steps[steps.length - 1].id > landed) {
      const step = steps.pop()!;
      closing.delete(step.id);
      step.onPop();
    }

    /*
     * The view is set either way. When steps were closed it is the same view
     * they were opened on, so this is a no-op — which is what makes a step
     * invisible to every screen that does not have any.
     */
    handler(viewFromUrl() ?? state?.everythingView ?? null);
  };
  window.addEventListener('popstate', listener);
  return () => window.removeEventListener('popstate', listener);
}

/**
 * A step for as long as this component is mounted.
 *
 * Returns the way out: call it from whatever closes the thing, instead of
 * calling the close handler directly. That keeps the entry and the screen
 * agreeing with each other, since both routes then end in the same pop.
 *
 * ```tsx
 * const close = useBackStep(onClose);
 * <button onClick={close}>Back</button>
 * ```
 *
 * The handler is read from a ref, so a component that rebuilds its `onBack`
 * every render — which is most of them — does not push and pop an entry each
 * time.
 */
export function useBackStep(onBack: () => void, options: { consumeOnUnmount?: boolean } = {}): () => void {
  const latest = useRef(onBack);
  latest.current = onBack;
  const id = useRef(0);
  const consume = useRef(options.consumeOnUnmount === true);
  consume.current = options.consumeOnUnmount === true;

  useEffect(() => {
    id.current = pushStep(() => latest.current());
    return () => {
      /*
       * **`consumeOnUnmount` is for a screen that cannot be left any other
       * way**, and the reader is the one: it draws over the whole app, so the
       * only ways out are back and its own controls. Anything that unmounts it
       * therefore *was* a close, and the entry should go with it.
       *
       * That is the bug this option exists for, reported as "the back button
       * wouldn't work after I got sent to the chapter select screen by tapping
       * next chapter". Next with nothing after it closes the reader by setting
       * its chapter to null — a plain unmount, down a path that never went
       * through `close()` — so its entry stayed in the stack with no handler,
       * and the next back press spent itself on it and appeared to do nothing.
       *
       * Everything else keeps the old behaviour, and must: a screen you can
       * navigate *away* from unmounts for reasons that are not closing, and
       * calling `history.back()` then would take you somewhere nobody asked to
       * go. Dropping the handler is all that is safe there.
       */
      if (consume.current) popStep(id.current);
      else forgetStep(id.current);
    };
  }, []);

  return useCallback(() => popStep(id.current), []);
}
