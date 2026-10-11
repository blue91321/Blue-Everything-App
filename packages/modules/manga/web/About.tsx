/**
 * A series' description, two lines of it, and the rest behind More.
 *
 * The same on the series' page and on the chapter list of one you follow, so
 * the two screens about one series read alike: it was a 420-character cut on
 * the page and nothing at all on the chapter list, which is the screen you
 * land on most.
 *
 * Two *lines*, not a character count, so it is two lines on a phone and on a
 * monitor alike. More is offered only when something is hidden: the text was
 * cut, or there is `extra` (who made it, the genres) to show under it.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export function About({ text, extra }: { text: string; extra?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  const box = useRef<HTMLParagraphElement>(null);

  // Measured rather than guessed: whether two lines hold it depends on the width.
  useLayoutEffect(() => {
    const measure = () => {
      const el = box.current;
      if (el && !open) setCut(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [text, open]);

  return (
    <div className="manga-about">
      <p ref={box} className={open ? 'manga-about-text' : 'manga-about-text clamped'}>
        {text}
      </p>
      {open && extra}
      {(cut || open || extra) && (
        <button className="btn subtle manga-about-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Less' : 'More'}
        </button>
      )}
    </div>
  );
}
