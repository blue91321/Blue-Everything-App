/**
 * Reading one chapter.
 *
 * ### A continuous strip, not pages
 *
 * Every source this is likely to be pointed at is manhwa or webtoon, which are
 * drawn as one tall strip and cut into arbitrary slices — so paging through them
 * means an artificial break every few hundred pixels in the middle of a panel.
 * A strip also happens to be the right shape for a phone, which is where this is
 * read. Paged mode is the thing to add if a page-per-image series ever turns up;
 * it is deliberately not built on speculation.
 *
 * ### The controls get out of the way
 *
 * A bar across the top (back, the chapter's number, the gear) and one across
 * the bottom (previous and next page, where you are, and a strip of every page
 * to jump to) — laid out like the reading app this replaced on the phone. They
 * show when a chapter opens and go after a few seconds; a tap anywhere on the
 * pages brings them back, and another sends them away. Touching the controls
 * themselves restarts the countdown, so they never vanish under your finger.
 *
 * **Both countdowns are settings**, behind the gear's More: one for when a
 * chapter opens, one for after a tap, each with Never. They are two because
 * they answer different moments — arriving, when a glance at the chapter
 * number is all you want, and reaching for a control, when you may want it to
 * stay — and a single number would make one of them wrong.
 *
 * **The gear's panel holds them up while it is open**, since it is part of the
 * controls; a tap on the page closes it rather than hiding everything, which is
 * what a tap outside a popover means everywhere else.
 *
 * **Hidden is `opacity` and `pointer-events`, not `visibility`.** A hidden
 * control must not catch a tap meant for the page — that is the pointer half —
 * but it must still be reachable from a keyboard, and focusing it brings the
 * bars back. `visibility: hidden` would take it out of the tab order entirely.
 *
 * While there is nothing to read yet — the chapter is being fetched, or could
 * not be — the controls stay put, since Back is then the only useful thing on
 * the screen.
 *
 * Previous and next are **pages**, as in that app; the next *chapter* is the
 * button at the end of the strip, because finishing is something you say
 * rather than something inferred.
 *
 * ### It takes the whole screen
 *
 * The reader is drawn into the page's `body`, beside the app rather than inside
 * it, and the app is hidden while it is open. It opens from four places — a
 * chapter list, a series' details, a details card inside Browse, and the offline
 * shelf — and inside each it wore that screen's surroundings: a card's margins,
 * Browse's tabs above the first page, and Manga's own tab bar drawn over the
 * page strip. Hiding each of those by name is a list that grows with every
 * screen that learns to open a chapter. One rule instead: while a reader is
 * open, nothing else is — the ☰ included, as in the app this replaced, where
 * Back is the way out.
 *
 * The window still does the scrolling, so everything here that measures a place
 * (`scrollY`, the read line) is unchanged, and iOS still scrolls to the top when
 * the status bar is tapped. Closing puts you back where you were in the list you
 * opened it from.
 *
 * ### The page strip is drawn small, not shown small
 *
 * Each thumbnail is the page decoded once, drawn onto a 60×84 canvas and kept
 * as a few kilobytes of JPEG. Pointing a tiny `<img>` at the page itself would
 * be the obvious version and costs the full decode for every thumbnail on
 * screen: these strips arrive at 800×15000, about 48MB of bitmap each, and ten
 * across the bottom is half a gigabyte to draw ten stamps. Here the decode is
 * transient, one page at a time, nearest to where you are first, and only
 * while the controls are showing.
 *
 * The whole page is squeezed into the box rather than cropped, as the old app
 * did: a webtoon slice comes out as bands of colour, which is what makes the
 * page with the dark scene findable.
 *
 * ### Images are fetched, not `src`ed
 *
 * They sit behind `/api/` because what you are reading is as personal as
 * anything else here, and an `img src` sends no bearer token — the same bind the
 * habit pictures and note attachments are in. So the bytes are fetched and
 * wrapped in object URLs.
 *
 * **These are revoked on unmount, unlike `Cover`.** A cover is cached for the
 * life of the page and shared between rows; a chapter's images are ten to forty
 * megabytes that nothing will ask for again once you have moved on, and keeping
 * them would accumulate a chapter's worth per chapter read.
 *
 * ### Loaded a few at a time, in order
 *
 * Not all at once, which would open forty connections for one chapter, and not
 * one at a time, which leaves you waiting at every panel. Three in flight, in
 * reading order, appended as they arrive — the strip grows downward, away from
 * where you are looking, so nothing shifts under your eyes.
 *
 * A placeholder cannot be the right height, because nothing knows an image's
 * dimensions until it has arrived. Growing downward is what makes that
 * acceptable rather than something to solve with a guessed aspect ratio.
 *
 * **Jumping to a page is the same problem as returning to one**, and uses the
 * same machinery: every page above the target loads now rather than lazily, and
 * the scroll is re-applied as each lands, since each pushes the target down.
 *
 * ### `loading="lazy"` is doing real work, and cannot be verified in a pane
 *
 * The bytes are already in memory as blobs, so what lazy defers is the *decode*
 * — and a decoded page is far larger than its file. These strips arrive at
 * 800×15000, which is roughly 48MB of bitmap each; decoding eleven at once to
 * read the first is the difference between a reader and a memory problem.
 *
 * It also means the strip cannot be checked by eye in a browser pane that is not
 * compositing: lazy images never enter the viewport calculation there and never
 * decode, so every page reads as 0×0 while its blob is perfectly good. Verified
 * by decoding one of the same blobs through a bare `new Image()` — 1200×800 —
 * and again by removing the attribute at runtime, after which all eleven
 * decoded and the strip measured 113,209px tall.
 *
 * That puts it alongside `ResizeObserver`, `requestAnimationFrame`, focus events
 * and CSS transitions on this project's list of things that measure nothing in a
 * pane nobody is looking at.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ServerUnreachable } from '@app/api';
import { useNow } from '@app/clock';
import { manga } from './manga-api';
import { NEEDS } from './device-text';
import { Icon } from './Icons';
import { chapterText } from './judge';
import { ReaderSettings } from './ReaderSettings';
import { useReaderPrefs } from './reader-prefs';

const IN_FLIGHT = 3;

/** The line across the screen that counts as "where you are" — just under the top. */
const READ_LINE = 8;

/** How often scrolling is turned into a place, at most. */
const MEASURE_MS = 300;

/** A thumbnail's box, drawn at twice this for a sharp screen. */
const THUMB_W = 30;
const THUMB_H = 42;

type Heading = { page: number; why: 'resume' | 'jump' };

export function Reader({
  seriesId,
  preview,
  chapter,
  onClose,
  onFinished,
  resume = null,
  onPosition,
  backLabel = 'Chapters',
}: {
  /** A followed series. */
  seriesId?: string;
  /**
   * Or a source's series id, read before following — from its detail page in
   * Browse. Nothing is marked read then, so the last button says "next" rather
   * than "finished".
   */
  preview?: string;
  chapter: { id: string; number: number; name: string };
  onClose: () => void;
  onFinished: (chapterNumber: number) => void;
  /** Where to start, when continuing: a page and how far down it. */
  resume?: { page: number; offset: number } | null;
  /** Told where you are as you scroll — see `usePositionSaver`, which decides how often to save it. */
  onPosition?: (place: { page: number; offset: number; pages: number }) => void;
  /** Where Back goes, named: the chapter list, or a series' details page. */
  backLabel?: string;
}) {
  const [urls, setUrls] = useState<(string | null)[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /*
   * Where the screen underneath was scrolled to, taken during the first render
   * — before the app is hidden and the page shrinks to the reader — and given
   * back on closing.
   */
  const underneath = useRef(window.scrollY);
  useEffect(() => {
    const y = underneath.current;
    return () => window.scrollTo(0, y);
  }, []);

  /** The page crossing the read line — what the counter says. */
  const [page, setPage] = useState(resume?.page ?? 0);
  const top = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  /**
   * A place still being returned to, or jumped to. Pages above it arrive one by
   * one and each pushes it further down, so the scroll is re-applied as they
   * land — until every page up to it has, or you touch the screen yourself,
   * since a reader that yanks you back while you are scrolling is worse than
   * one a line out. While it is set, nothing is saved: the top of an empty
   * strip is not where you were.
   */
  const returning = useRef<{ page: number; offset: number } | null>(resume);
  const [heading, setHeading] = useState<Heading | null>(resume ? { page: resume.page, why: 'resume' } : null);
  /** Pages up to here load at once rather than lazily — see "Jumping to a page". */
  const [eagerTo, setEagerTo] = useState(resume ? resume.page + 1 : -1);

  const arrived = () => {
    returning.current = null;
    setHeading(null);
  };

  useEffect(() => {
    let alive = true;
    const made: string[] = [];

    (async () => {
      setUrls([]);
      setTotal(null);
      setProblem(null);
      try {
        const { pages } = preview
          ? await manga.browse.pages(preview, chapter.id)
          : await manga.reader.pages(seriesId!, chapter.id);
        if (!alive) return;
        setTotal(pages.length);
        setUrls(new Array(pages.length).fill(null));

        let next = 0;
        const worker = async () => {
          while (alive) {
            const index = next++;
            if (index >= pages.length) return;
            try {
              const url = await manga.reader.page(pages[index]);
              if (!alive) {
                URL.revokeObjectURL(url);
                return;
              }
              made.push(url);
              setUrls((current) => {
                const copy = [...current];
                copy[index] = url;
                return copy;
              });
            } catch {
              // One page failing must not stop the rest: a strip with a gap is
              // readable, a blank screen is not. The slot stays null and the
              // count says how many arrived.
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(IN_FLIGHT, pages.length) }, worker));
      } catch (error) {
        if (!alive) return;
        setProblem(
          // Offline, a chapter not saved on this device is the ordinary case,
          // and "Failed to fetch" says nothing about what to do.
          error instanceof ServerUnreachable
            ? `This chapter isn't saved on this device, so it ${NEEDS}. Save chapters with ⬇ first to read them offline.`
            : error instanceof Error
              ? error.message
              : 'could not load this chapter'
        );
      }
    })();

    return () => {
      alive = false;
      for (const url of made) URL.revokeObjectURL(url);
    };
  }, [seriesId, preview, chapter.id]);

  // Back to the top when the chapter changes, or reading the next one starts you
  // at the bottom of it — unless this chapter is being continued.
  useEffect(() => {
    returning.current = resume;
    setHeading(resume ? { page: resume.page, why: 'resume' } : null);
    setEagerTo(resume ? resume.page + 1 : -1);
    setPage(resume?.page ?? 0);
    if (!resume) top.current?.scrollIntoView({ block: 'start' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter.id]);

  /** Scroll to the place being headed for; true once every page up to it has loaded. */
  const returnTo = (): boolean => {
    const target = returning.current;
    const kids = strip.current?.children;
    if (!target || !kids || kids.length === 0) return false;
    const at = Math.min(target.page, kids.length - 1);
    const el = kids[at] as HTMLElement;
    const y = window.scrollY + el.getBoundingClientRect().top + target.offset * el.offsetHeight - READ_LINE;
    window.scrollTo(0, Math.max(0, y));
    return [...kids]
      .slice(0, at + 1)
      .every((k) => k instanceof HTMLImageElement && k.complete && k.naturalHeight > 0);
  };

  // Each page landing moves everything below it, so keep going until done.
  useEffect(() => {
    if (!returning.current || total === null) return;
    if (returnTo()) arrived();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urls, total, eagerTo]);

  // Touching the screen ends the return: you have taken over.
  useEffect(() => {
    const stop = () => {
      if (returning.current) arrived();
    };
    const events = ['wheel', 'touchstart', 'keydown', 'mousedown'] as const;
    for (const e of events) window.addEventListener(e, stop, { passive: true });
    return () => {
      for (const e of events) window.removeEventListener(e, stop);
    };
  }, []);

  /** Previous, next, or a thumbnail: go to the top of that page. */
  function jumpTo(target: number) {
    if (total === null || total === 0) return;
    const to = Math.max(0, Math.min(total - 1, target));
    returning.current = { page: to, offset: 0 };
    setHeading({ page: to, why: 'jump' });
    setEagerTo((e) => Math.max(e, to + 1));
    setPage(to);
    if (returnTo()) arrived();
    // However it was pressed — a tap, a key, VoiceOver — you are using them.
    wake();
  }

  /*
   * Where you are: the page crossing the read line, and how far down it that
   * line is. Measured on scroll, at most every MEASURE_MS, with a timer rather
   * than `requestAnimationFrame` — which does not run in a window nobody is
   * looking at, the trap this app has fallen into three times. Always measured,
   * for the counter; passed on only when somebody is saving it.
   */
  // Held in a ref so a parent passing a fresh function each render does not
  // tear down the listener — and a measurement waiting on its timer — every time.
  const report = useRef(onPosition);
  report.current = onPosition;

  /**
   * The page crossing the read line, and how far down it the line is.
   *
   * A page counts only once more than a pixel of it is below the line. Putting
   * a page's top exactly on the line — which a jump and a zoom both do — lands
   * a fraction off after scaling, and without the pixel the page above, with a
   * sliver of itself still showing, was the one counted: page 4 at the top of
   * the screen and the counter saying 3.
   */
  const where = (): { page: number; offset: number; pages: number } | null => {
    const kids = strip.current?.children;
    if (!kids || kids.length === 0) return null;
    for (let i = 0; i < kids.length; i++) {
      const box = (kids[i] as HTMLElement).getBoundingClientRect();
      if (box.bottom > READ_LINE + 1) {
        const offset = box.height > 0 ? Math.min(1, Math.max(0, (READ_LINE - box.top) / box.height)) : 0;
        return { page: i, offset, pages: kids.length };
      }
    }
    return { page: kids.length - 1, offset: 1, pages: kids.length };
  };

  useEffect(() => {
    let waiting: ReturnType<typeof setTimeout> | null = null;
    const measure = () => {
      waiting = null;
      if (returning.current) return;
      const place = where();
      if (!place) return;
      setPage(place.page);
      report.current?.(place);
    };
    const onScroll = () => {
      if (!waiting) waiting = setTimeout(measure, MEASURE_MS);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (waiting) clearTimeout(waiting);
    };
  }, []);

  /*
   * The controls: up when the chapter opens, away after the countdown for that
   * moment, back on a tap. Held up while there is nothing to read, when Back is
   * all there is, and while the gear's panel is open.
   */
  const [prefs, setPrefs] = useReaderPrefs();
  const [shown, setShown] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = problem !== null || total === null;
  // Read by the timer rather than closed over, so the callbacks below stay the
  // same function and a changed setting applies to the next countdown.
  const settings = useRef({ prefs, open: settingsOpen });
  settings.current = { prefs, open: settingsOpen };
  /** Which countdown is running: the one for arriving, or the one after a tap. */
  const phase = useRef<'open' | 'tap'>('open');

  /** Show them, and start this moment's countdown again — or none, when it is Never. */
  const wake = useCallback((next?: 'open' | 'tap') => {
    if (next) phase.current = next;
    setShown(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
    const { prefs: p, open } = settings.current;
    const ms = phase.current === 'open' ? p.hideOnOpenMs : p.hideAfterTapMs;
    if (ms !== null && !open) hideTimer.current = setTimeout(() => setShown(false), ms);
  }, []);

  /** A touch on the controls: the same countdown, from the start. */
  const touched = useCallback(() => wake(), [wake]);

  const sleep = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setShown(false);
  };

  /** Open or close the gear's panel; the countdown waits while it is open. */
  const showSettings = (open: boolean) => {
    settings.current = { ...settings.current, open };
    setSettingsOpen(open);
    wake();
  };

  // A new chapter shows its number, and the countdown starts once there is
  // something to read under them.
  useEffect(() => {
    if (!held) wake('open');
  }, [held, chapter.id, wake]);

  // Escape closes the panel, as it does every other popover here.
  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') showSettings(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen]);

  /*
   * Changing the page width moves everything below the top of the screen, so
   * the place is taken before the change and put back after it — in a layout
   * effect, so the jump is never painted.
   */
  const anchor = useRef<{ page: number; offset: number } | null>(null);
  const changePrefs = (change: Partial<typeof prefs>) => {
    if (change.width !== undefined && change.width !== prefs.width) anchor.current = where();
    setPrefs(change);
  };
  useLayoutEffect(() => {
    const place = anchor.current;
    anchor.current = null;
    const el = place ? (strip.current?.children[place.page] as HTMLElement | undefined) : undefined;
    if (!place || !el) return;
    const y = window.scrollY + el.getBoundingClientRect().top + place.offset * el.offsetHeight - READ_LINE;
    window.scrollTo(0, Math.max(0, y));
  }, [prefs.width]);

  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    []
  );

  /**
   * A tap on the pages. Anything that is a control of its own is left alone,
   * and with the panel open a tap closes it rather than hiding everything.
   */
  function onTap(event: React.MouseEvent) {
    const target = event.target as HTMLElement;
    if (target.closest('button, a, input, .manga-reader-chrome, .manga-returning, .manga-reader-settings')) return;
    if (settingsOpen) showSettings(false);
    else if (shown) sleep();
    else wake('tap');
  }

  const visible = shown || held;
  const count = urls.filter(Boolean).length;
  const thumbs = useThumbnails(urls, visible, page, chapter.id);

  // Keep the current page's thumbnail in view — centred, as the old app did.
  const thumbBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = thumbBox.current;
    const current = box?.children[page] as HTMLElement | undefined;
    if (!box || !current || !visible) return;
    box.scrollLeft = current.offsetLeft - box.clientWidth / 2 + current.offsetWidth / 2;
  }, [page, visible, total]);

  return createPortal(
    <div className={`manga-reader${visible ? '' : ' chrome-off'}`} ref={top} onClick={onTap}>
      <div
        className="manga-reader-chrome top"
        onPointerDown={touched}
        onKeyDown={touched}
        onFocusCapture={touched}
      >
        <button className="btn subtle manga-reader-back" onClick={onClose}>
          ‹ {backLabel}
        </button>
        <span className="manga-reader-title" title={chapter.name}>
          {chapterText(chapter.number)}
          {total !== null && count < total && (
            <span className="meta">
              {count} of {total} loaded
            </span>
          )}
        </span>
        <button
          className="manga-icon-btn manga-reader-gear"
          aria-label="Reader settings"
          aria-expanded={settingsOpen}
          onClick={() => showSettings(!settingsOpen)}
        >
          <Icon.gear />
        </button>
      </div>

      {settingsOpen && visible && <ReaderSettings prefs={prefs} onChange={changePrefs} />}

      {/*
        * Dimming is a veil over the pages, below the controls — the screen's
        * own brightness is not something a web app can reach.
        */}
      {prefs.brightness < 1 && (
        <div className="manga-reader-dim" style={{ opacity: 1 - prefs.brightness }} aria-hidden="true" />
      )}

      {problem && <p className="banner">{problem}</p>}
      {total === null && !problem && <p className="empty">Asking the source for this chapter…</p>}

      {heading && (heading.why === 'resume' || total !== null) && (
        // Fixed rather than in the flow: a notice above the strip would move every
        // page down by its height, and then up again as it went.
        <p className="meta manga-returning">
          {heading.why === 'resume' ? 'Returning to' : 'Going to'} page {heading.page + 1}…{' '}
          {heading.why === 'resume' && (
            <button
              className="btn subtle"
              onClick={() => {
                arrived();
                top.current?.scrollIntoView({ block: 'start' });
              }}
            >
              Start from the top
            </button>
          )}
        </p>
      )}

      <div
        className="manga-strip"
        ref={strip}
        style={{ '--page-width': `${prefs.width}%` } as React.CSSProperties}
      >
        {urls.map((url, index) =>
          url ? (
            <img
              key={index}
              src={url}
              alt={`Page ${index + 1}`}
              // Lazy pages above a place being returned or jumped to would load
              // only as they scroll into view, pushing it down afterwards — so up
              // to there they load now, and the move can finish.
              loading={index <= eagerTo ? 'eager' : 'lazy'}
              onLoad={() => {
                if (returning.current && returnTo()) arrived();
              }}
            />
          ) : (
            <div key={index} className="manga-page-waiting">
              {index + 1}
            </div>
          )
        )}
      </div>

      {total !== null && (
        <div className="row between manga-reader-end">
          <button className="btn subtle" onClick={onClose}>
            ‹ {backLabel}
          </button>
          {/*
            * Marking read is a button rather than something inferred from
            * scrolling to the bottom. Scroll detection guesses, and guessing
            * wrong here either loses your place or marks something you skimmed
            * past as finished.
            */}
          <button className="btn primary" onClick={() => onFinished(chapter.number)}>
            {preview ? 'Next chapter' : 'Finished — next chapter'}
          </button>
        </div>
      )}

      {total !== null && total > 0 && (
        <div
          className="manga-reader-chrome bottom"
          onPointerDown={touched}
          onKeyDown={touched}
          onFocusCapture={touched}
        >
          <div className="manga-reader-nav">
            <button
              className="manga-reader-arrow"
              aria-label="Previous page"
              disabled={page <= 0}
              onClick={() => jumpTo(page - 1)}
            >
              <Icon.previous />
            </button>
            <span className="manga-reader-count">
              {page + 1} / {total}
            </span>
            <button
              className="manga-reader-arrow"
              aria-label="Next page"
              disabled={page >= total - 1}
              onClick={() => jumpTo(page + 1)}
            >
              <Icon.next />
            </button>
          </div>
          {/*
            * Wheel, not scroll: this box is also scrolled by the code that keeps
            * the current page centred, and a scroll handler would take that for
            * you touching it and hold the controls up for as long as you read.
            */}
          <div className="manga-reader-thumbs" ref={thumbBox} onWheel={touched}>
            {urls.map((_, index) => (
              <button
                key={index}
                className={index === page ? 'on' : undefined}
                aria-label={`Page ${index + 1}`}
                aria-current={index === page ? 'page' : undefined}
                onClick={() => jumpTo(index)}
              >
                {thumbs[index] ? <img src={thumbs[index]!} alt="" /> : <span>{index + 1}</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* With the controls away, the one line that says where you are — and the time, as the old app did. */}
      {!visible && total !== null && <ReaderStatus text={`${chapterText(chapter.number)}  ${page + 1}/${total}`} />}
    </div>,
    document.body
  );
}

/** Its own component so the clock ticking redraws a line, not a chapter of images. */
function ReaderStatus({ text }: { text: string }) {
  const now = useNow();
  return (
    <p className="manga-reader-status" aria-hidden="true">
      {text}  {new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
    </p>
  );
}

/**
 * One small picture per page, made one at a time — see "The page strip is
 * drawn small, not shown small". Returns a list in page order, null where a
 * page has no thumbnail yet.
 */
function useThumbnails(urls: (string | null)[], active: boolean, near: number, chapterId: string): (string | null)[] {
  /** Page object URL → its thumbnail's object URL, or '' when one could not be made. */
  const made = useRef(new Map<string, string>());
  const working = useRef(false);
  const [, redraw] = useState(0);
  // Read when a thumbnail finishes, which may be after the chapter has changed
  // or the reader has closed: the closure's own copy would be out of date.
  const current = useRef(urls);
  current.current = urls;
  const open = useRef(true);
  useEffect(
    () => () => {
      open.current = false;
    },
    []
  );

  // A new chapter's pages are new URLs; the old thumbnails go.
  useEffect(() => {
    const own = made.current;
    return () => {
      for (const thumb of own.values()) if (thumb) URL.revokeObjectURL(thumb);
      own.clear();
    };
  }, [chapterId]);

  useEffect(() => {
    if (!active || working.current) return;
    // The nearest page to where you are that has arrived and has no thumbnail.
    let pick = -1;
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      if (!url || made.current.has(url)) continue;
      if (pick < 0 || Math.abs(i - near) < Math.abs(pick - near)) pick = i;
    }
    if (pick < 0) return;
    const url = urls[pick]!;
    working.current = true;
    void drawThumbnail(url).then((thumb) => {
      working.current = false;
      // Closed, or a chapter changed underneath: its pages are gone, and so
      // should this be.
      if (!open.current || !current.current.includes(url)) {
        if (thumb) URL.revokeObjectURL(thumb);
        return;
      }
      made.current.set(url, thumb ?? '');
      redraw((n) => n + 1);
    });
  });

  return urls.map((url) => (url ? made.current.get(url) || null : null));
}

async function drawThumbnail(url: string): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = THUMB_W * 2;
    canvas.height = THUMB_H * 2;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const small = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/jpeg', 0.7));
    return small ? URL.createObjectURL(small) : null;
  } catch {
    return null;
  }
}
