/**
 * Pages far from the screen let go of their pixels, and take them back as you
 * come near.
 *
 * A page is a small file and a large picture. *Divine Beast Kindergarten*'s
 * are 200KB JPEGs of 800×3565, so a chapter of 45 is 8MB to fetch and **624MB
 * once decoded**, four bytes a pixel. A phone decodes what it draws and keeps
 * it, so with *Endless* carrying two finished chapters above the one being
 * read, iPhone Safari was holding close to 2GB of pictures and killed the page:
 * found in the server's log on 2026-11-11 as two fresh sessions 13 seconds
 * apart, mid-chapter, followed by the reload's reopening of the chapter.
 *
 * So, in scroll mode, a page more than `UNLOAD_SCREENS` screens away has its
 * picture swapped for a one-pixel blank, and gets it back once it is within
 * `RELOAD_SCREENS`. What it costs to draw it again is a decode, not a fetch:
 * the bytes stay in memory as the blob its URL names, 8MB a chapter here.
 *
 * - **Nothing moves.** Before the swap the page is given its own shape as an
 *   `aspect-ratio`, which wins over the blank's 1:1, so at the width the strip
 *   sets it is exactly as tall as before and the scroll position is untouched.
 *   It stays on, so a width change while it is blank still sizes it right.
 * - **Only a page that has drawn.** One not loaded yet (lazy, far below) costs
 *   no pixels and has no shape to keep.
 * - **Done to the DOM, beside React.** React sets `src` only when the page's
 *   URL changes, so it leaves the blank alone; when it does change (a page
 *   fetched again), the new picture is simply what is shown, and is let go
 *   again the next time it is far.
 * - **Not in pages mode**, whose pages are book-sized (a few MB decoded) and
 *   whose sheets size themselves from the picture.
 * - **No timer**: a pass on scroll (at most every quarter second), on a resize
 *   and when a page finishes loading.
 */
import { useEffect } from 'react';

/*
 * Two and one and a half (2026-11-11; it was three and two). Still a screen
 * and a half of pictures ready either side, which a quarter-second pass keeps
 * ahead of any ordinary scroll, and fewer held when a second crash came at the
 * moment a chapter carried on.
 */
const UNLOAD_SCREENS = 2;
const RELOAD_SCREENS = 1.5;
const PASS_MS = 250;
/** A transparent 1×1 GIF: decodes to four bytes. */
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const SELECTOR = '.manga-reader .manga-strip:not(.paged) > img';

function pass(): void {
  const vh = window.innerHeight || 800;
  for (const img of document.querySelectorAll<HTMLImageElement>(SELECTOR)) {
    const box = img.getBoundingClientRect();
    const away = box.bottom < 0 ? -box.bottom / vh : box.top > vh ? (box.top - vh) / vh : 0;
    const kept = img.dataset.farSrc;
    if (kept) {
      if (away <= RELOAD_SCREENS) {
        // Only if React has not put a newer picture there meanwhile.
        if (img.getAttribute('src') === BLANK) img.src = kept;
        delete img.dataset.farSrc;
      }
    } else if (away > UNLOAD_SCREENS && img.complete && img.naturalWidth > 1 && img.naturalHeight > 1) {
      const src = img.getAttribute('src');
      if (!src || src === BLANK) continue;
      img.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
      img.dataset.farSrc = src;
      img.src = BLANK;
    }
  }
}

/** Every page given its picture back, for pages mode and for leaving. */
function restoreAll(): void {
  for (const img of document.querySelectorAll<HTMLImageElement>('.manga-reader img[data-far-src]')) {
    if (img.getAttribute('src') === BLANK) img.src = img.dataset.farSrc!;
    delete img.dataset.farSrc;
  }
}

export function useFarPages(active: boolean): void {
  useEffect(() => {
    if (!active) {
      restoreAll();
      return;
    }
    let waiting: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (!waiting)
        waiting = setTimeout(() => {
          waiting = null;
          pass();
        }, PASS_MS);
    };
    const onLoad = (event: Event) => {
      if (event.target instanceof HTMLImageElement && event.target.getAttribute('src') !== BLANK) soon();
    };
    window.addEventListener('scroll', soon, { passive: true });
    window.addEventListener('resize', soon);
    // `load` does not bubble, so it is heard on the way down.
    document.addEventListener('load', onLoad, true);
    soon();
    return () => {
      window.removeEventListener('scroll', soon);
      window.removeEventListener('resize', soon);
      document.removeEventListener('load', onLoad, true);
      if (waiting) clearTimeout(waiting);
    };
  }, [active]);
}
