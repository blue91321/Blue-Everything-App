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
import { manga } from './manga-api';

const IN_FLIGHT = 3;

export function Reader({
  seriesId,
  chapter,
  onClose,
  onFinished,
}: {
  seriesId: string;
  chapter: { id: string; number: number; name: string };
  onClose: () => void;
  onFinished: (chapterNumber: number) => void;
}) {
  const [urls, setUrls] = useState<(string | null)[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const top = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const made: string[] = [];

    (async () => {
      setUrls([]);
      setTotal(null);
      setProblem(null);
      try {
        const { pages } = await manga.reader.pages(seriesId, chapter.id);
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
        if (alive) setProblem(error instanceof Error ? error.message : 'could not load this chapter');
      }
    })();

    return () => {
      alive = false;
      for (const url of made) URL.revokeObjectURL(url);
    };
  }, [seriesId, chapter.id]);

  // Back to the top when the chapter changes, or reading the next one starts you
  // at the bottom of it.
  useEffect(() => {
    top.current?.scrollIntoView({ block: 'start' });
  }, [chapter.id]);

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

      <div className="manga-strip">
        {urls.map((url, index) =>
          url ? (
            <img key={index} src={url} alt={`Page ${index + 1}`} loading="lazy" />
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
            Finished — next chapter
          </button>
        </div>
      )}
    </div>
  );
}
