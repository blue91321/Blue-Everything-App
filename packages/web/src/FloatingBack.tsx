/**
 * A Back beside the ☰, shown while the page's own Back is out of sight.
 *
 * A screen with a Back at its top (a chapter list four hundred chapters long, a
 * series' page) made you scroll all the way up to leave it. This watches that
 * button and, once it has scrolled up past the ☰'s line, puts a second one
 * next to the ☰, which never moves. It goes again when the real one is back.
 *
 * Measured from the button's position on scroll and resize, not with an
 * `IntersectionObserver`: an observer reports nothing in a window that is not
 * drawing, and this is cheap. Drawn into `#root` rather than `body`, so the
 * manga reader, which hides `#root`, hides this too.
 */
import { useEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';

export function FloatingBack({ target, onBack }: { target: RefObject<HTMLElement | null>; onBack: () => void }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const check = () => {
      const el = target.current;
      // Gone past the ☰'s band (about 50px down) is gone from where you would reach for it.
      setShow(el ? el.getBoundingClientRect().bottom < 50 : false);
    };
    check();
    window.addEventListener('scroll', check, { passive: true });
    window.addEventListener('resize', check);
    return () => {
      window.removeEventListener('scroll', check);
      window.removeEventListener('resize', check);
    };
  }, [target]);

  const root = document.getElementById('root');
  if (!show || !root) return null;
  return createPortal(
    <button className="floating-back" onClick={onBack}>
      ‹ Back
    </button>,
    root
  );
}
