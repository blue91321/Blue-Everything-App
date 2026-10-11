/**
 * A window left open across a rebuild reloads itself instead of going blank.
 *
 * Screens and Dashboard cards are separate files, fetched the first time they
 * are shown, under names that change with every build. A window opened before
 * the app was rebuilt still asks for the old names, the server no longer has
 * them, and the failed import took the whole page down with it: a blank window
 * with nothing on it saying why. Reloading picks up the new build, and the
 * service worker fetches the page network-first, so it is the new one.
 *
 * Vite announces a failed import as `vite:preloadError`, and cancelling that
 * event stops the error. It is cancelled only when the page is about to reload:
 * cancelled and not reloaded, the import would hand React nothing, which fails
 * worse than the error it replaced.
 *
 * Twice in a minute is not a stale window any more, so the second time the
 * error is let through rather than reloading forever. And not while offline:
 * reloading then would swap what is on screen for the cached shell, and the
 * part being opened still could not be fetched.
 */
import { connectivity } from './offline-sync';

const LAST_RELOAD = 'everything-stale-reload';
const NOT_AGAIN_WITHIN_MS = 60_000;

export function reloadOnStaleBuild(): void {
  window.addEventListener('vite:preloadError', (event: Event) => {
    if (connectivity().offline) return;
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(LAST_RELOAD)) || 0;
    } catch {
      // Storage refused: no record, so this counts as the first time.
    }
    if (Date.now() - last < NOT_AGAIN_WITHIN_MS) return;
    try {
      sessionStorage.setItem(LAST_RELOAD, String(Date.now()));
    } catch {
      // Without the record a broken build could reload in a loop, so not at all.
      return;
    }
    event.preventDefault();
    location.reload();
  });
}
