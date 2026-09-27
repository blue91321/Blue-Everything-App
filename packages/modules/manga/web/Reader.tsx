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
import { useEffect, useRef, useState } from 'react';
import { ServerUnreachable } from '@app/api';
import { manga } from './manga-api';
import { NEEDS } from './device-text';

const IN_FLIGHT = 3;

/** The line across the screen that counts as "where you are" — just under the top. */
const READ_LINE = 8;

/** How often scrolling is turned into a place, at most. */
const MEASURE_MS = 300;

export function Reader({
  seriesId,
  preview,
  chapter,
  onClose,
  onFinished,
  resume = null,
  onPosition,
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
}) {
  const [urls, setUrls] = useState<(string | null)[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const top = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  /**
   * A place still being returned to. Pages above it arrive one by one and each
   * pushes it further down, so the scroll is re-applied as they land — until
   * every page up to it has, or you touch the screen yourself, since a reader
   * that yanks you back while you are scrolling is worse than one a line out.
   * While it is set, nothing is saved: the top of an empty strip is not where
   * you were.
   */
  const returning = useRef<{ page: number; offset: number } | null>(resume);
  const [returned, setReturned] = useState(resume === null);

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
              // count below says how many arrived.
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
    setReturned(resume === null);
    if (!resume) top.current?.scrollIntoView({ block: 'start' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter.id]);

  /** Scroll to the remembered place; true once every page up to it has loaded. */
  const returnTo = (): boolean => {
    const target = returning.current;
    const kids = strip.current?.children;
    if (!target || !kids || kids.length === 0) return false;
    const page = Math.min(target.page, kids.length - 1);
    const el = kids[page] as HTMLElement;
    const y = window.scrollY + el.getBoundingClientRect().top + target.offset * el.offsetHeight - READ_LINE;
    window.scrollTo(0, Math.max(0, y));
    return [...kids]
      .slice(0, page + 1)
      .every((k) => k instanceof HTMLImageElement && k.complete && k.naturalHeight > 0);
  };

  // Each page landing moves everything below it, so keep returning until done.
  useEffect(() => {
    if (!returning.current || total === null) return;
    if (returnTo()) {
      returning.current = null;
      setReturned(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urls, total]);

  // Touching the screen ends the return: you have taken over.
  useEffect(() => {
    const stop = () => {
      if (returning.current) {
        returning.current = null;
        setReturned(true);
      }
    };
    const events = ['wheel', 'touchstart', 'keydown', 'mousedown'] as const;
    for (const e of events) window.addEventListener(e, stop, { passive: true });
    return () => {
      for (const e of events) window.removeEventListener(e, stop);
    };
  }, []);

  /*
   * Where you are: the page crossing the read line, and how far down it that
   * line is. Measured on scroll, at most every MEASURE_MS, with a timer rather
   * than `requestAnimationFrame` — which does not run in a window nobody is
   * looking at, the trap this app has fallen into three times.
   */
  // Held in a ref so a parent passing a fresh function each render does not
  // tear down the listener — and a measurement waiting on its timer — every time.
  const report = useRef(onPosition);
  report.current = onPosition;
  const reporting = onPosition !== undefined;

  useEffect(() => {
    if (!reporting) return;
    let waiting: ReturnType<typeof setTimeout> | null = null;
    const measure = () => {
      waiting = null;
      const kids = strip.current?.children;
      if (!kids || kids.length === 0 || returning.current) return;
      for (let i = 0; i < kids.length; i++) {
        const box = (kids[i] as HTMLElement).getBoundingClientRect();
        if (box.bottom > READ_LINE) {
          const offset = box.height > 0 ? Math.min(1, Math.max(0, (READ_LINE - box.top) / box.height)) : 0;
          report.current?.({ page: i, offset, pages: kids.length });
          return;
        }
      }
      report.current?.({ page: kids.length - 1, offset: 1, pages: kids.length });
    };
    const onScroll = () => {
      if (!waiting) waiting = setTimeout(measure, MEASURE_MS);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (waiting) clearTimeout(waiting);
    };
  }, [reporting]);

  const arrived = urls.filter(Boolean).length;

  return (
    <div className="manga-reader" ref={top}>
      <div className="row between manga-reader-bar">
        <button className="btn subtle" onClick={onClose}>
          ‹ Chapters
        </button>
        <span className="meta">
          {chapter.name}
          {total !== null && ` · ${arrived} of ${total}`}
        </span>
      </div>

      {problem && <p className="banner">{problem}</p>}
      {total === null && !problem && <p className="empty">Asking the source for this chapter…</p>}

      {!returned && resume && (
        // Fixed rather than in the flow: a notice above the strip would move every
        // page down by its height, and then up again as it went.
        <p className="meta manga-returning">
          Returning to page {resume.page + 1}…{' '}
          <button
            className="btn subtle"
            onClick={() => {
              returning.current = null;
              setReturned(true);
              top.current?.scrollIntoView({ block: 'start' });
            }}
          >
            Start from the top
          </button>
        </p>
      )}

      <div className="manga-strip" ref={strip}>
        {urls.map((url, index) =>
          url ? (
            <img
              key={index}
              src={url}
              alt={`Page ${index + 1}`}
              // Lazy pages above the place being returned to would load only as
              // they scroll into view, pushing it down afterwards — so up to
              // there they load now, and the return can finish.
              loading={resume && index <= resume.page + 1 ? 'eager' : 'lazy'}
              onLoad={() => {
                if (returning.current && returnTo()) {
                  returning.current = null;
                  setReturned(true);
                }
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
        <div className="row between manga-reader-bar">
          <button className="btn subtle" onClick={onClose}>
            ‹ Chapters
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
    </div>
  );
}
