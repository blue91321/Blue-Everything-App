/**
 * The reader takes the whole screen by hiding the app behind it, and handing
 * the screen back has to make the app actually draw again.
 *
 * Reported from an iPhone: after reading for a while, going back left the list
 * blank until it was scrolled. Two things on that path are WebKit's to get
 * wrong, and neither can be watched from the PC, so both are covered:
 *
 *   - **The app was hidden by `body:has(> .manga-reader) > #root`.** Removing
 *     the reader is then the only thing that says the app is back, and WebKit
 *     has had more than one bug re-checking a `:has()` when the element it
 *     names goes. A class added and removed here is the plainest change a
 *     browser can be told about.
 *   - **iOS can leave a page it has just shown unpainted until it scrolls.** A
 *     chapter decodes strips of 48MB each, and under that memory pressure
 *     Safari drops the tiles of what is hidden; showing the app again does not
 *     always repaint it. So the window is moved one pixel and back, which is
 *     the scroll it was waiting for, too small to see.
 */
import { useLayoutEffect } from 'react';

/** Readers and waiting screens open now: moving from one to the next overlaps. */
let holders = 0;

/** Hide the app while this component is on screen. */
export function useTakeScreen(): void {
  useLayoutEffect(() => {
    holders++;
    document.body.classList.add('manga-reading');
    return () => {
      holders--;
      if (holders > 0) return;
      document.body.classList.remove('manga-reading');
      repaintSoon();
    };
  }, []);
}

/**
 * Nudge the window a pixel and back once the screen has settled, so a page
 * that was just shown is painted. Does nothing while a reader is open again,
 * where a scroll put back 30ms later would undo the reader finding your page.
 */
export function repaintSoon(): void {
  setTimeout(() => {
    if (holders > 0) return;
    const y = window.scrollY;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (max < 1) return;
    window.scrollTo(0, y < max ? y + 1 : y - 1);
    setTimeout(() => {
      if (holders === 0) window.scrollTo(0, y);
    }, 30);
  }, 60);
}
