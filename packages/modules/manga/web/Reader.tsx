/**
 * Reading one chapter.
 *
 * ### A continuous strip, or pages
 *
 * Most sources here are manhwa or webtoon, drawn as one tall strip and cut into
 * arbitrary slices, so the strip is the default: paging through those means an
 * artificial break in the middle of a panel. **Pages** (the gear) is for manga
 * printed as a book: a page to the screen, the screen snapping to each, and two
 * side by side, paired as the book pairs them, when the screen has the width.
 * See "Scroll or pages" below and `page-layout.ts`.
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
 * Previous and next are **chapters**. They were pages, as in that app, but
 * pages are what scrolling and the thumbnail strip are for, and the arrows
 * were the one control for leaving a chapter without scrolling to its end.
 * Going on from the **last page** marks the chapter read, as the button at the
 * end of the strip does; going on from partway through does not, because
 * skipping a chapter is not finishing it.
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
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ServerUnreachable } from '@app/api';
import { useNow } from '@app/clock';
import { useBackStep } from '@app/view-history';
import { dropHeld, holdNext, manga } from './manga-api';
import { NEEDS } from './device-text';
import { Icon } from './Icons';
import { chapterText } from './judge';
import { ReaderSettings } from './ReaderSettings';
import { rememberedFormat, rememberedMargins, rememberedPairing, rememberFormat, rememberMargins, rememberPairing, useReaderPrefs, type ChapterPairing, type ReaderMode } from './reader-prefs';
import { apartPages, asBookPages, chooseFirstAlone, contentKind, learnMargins, seamsDecide, stackedPages, type MarginSide, fitsTwo, formatFromTags, leanFromTags, pairPages, typicalAspect, type PageInfo } from './page-layout';
import { usePageInfo } from './page-analysis';
import { reachedTheEnd } from './chapter-nav';
import { glideStep, releaseVelocity, STOP_SPEED, type DragSample } from './glide';
import { magnetTarget, reachFor, SETTLED_PX, type MagnetSpot } from './magnet';
import { settlePlan, settleTarget } from './settle';
import { useTakeScreen } from './take-screen';
import { useFarPages } from './far-pages';

const IN_FLIGHT = 3;
/**
 * Chapters kept on screen above the one being read, when carrying on into the
 * next: the one just finished, to look back at, and no more. It was two, and
 * a phone holding three chapters of tall strips is a phone killing the page
 * (see `far-pages.ts`, which is the other half of keeping that from happening).
 */
/** A chapter carried above this far from the screen lets go of its pictures and keeps their space. */
const REST_SCREENS = 4;
/** And takes them back this near. */
const WAKE_SCREENS = 2;
/** Under this many screens tall, a chapter is short enough to fetch the next one ahead from its start. */
const SHORT_SCREENS = 4;
/** No pages, the same array every render. */
const NO_URLS: (string | null)[] = [];

/** A finished chapter left on screen above the next, when carrying on — see "Carrying on". */
/**
 * A chapter carried on from, above the one being read. Kept for the whole
 * session, its space and all (2026-11-12): taking chapters off the top moved
 * what you were reading, and Safari has nothing that puts it back. One far from
 * the screen is `resting`: its pictures and their bytes let go, each page a
 * blank of the size it was (`shapes`, width over height), until you scroll back
 * near it and its pages (`paths`) are asked for again.
 */
type Carried = {
  id: string;
  number: number;
  urls: (string | null)[];
  paths: string[];
  shapes: (number | null)[];
  resting?: boolean;
};

/** A page that has arrived and been drawn. */
const loaded = (k: Element) => {
  // A page cut out of a taller image is a box with the picture inside it (`cropped`).
  const img = k instanceof HTMLImageElement ? k : k.querySelector('img');
  return !!img && img.complete && img.naturalHeight > 0;
};
/** How long the reader waits before giving the pages that failed a second go. */
const SECOND_GO_MS = 3_000;

/**
 * A page still not here after this says so, rather than sitting as a bare
 * number. Page 11 of a Thunder Scans chapter sat as "11" for over two minutes
 * while the server tried and failed to get it, and that looked exactly like a
 * page on its way.
 */
const SLOW_NOTICE_MS = 10_000;

/**
 * A page that took this long to fail is a site that is slow, not one that
 * refused. The server has already tried it twice by then (see `page-fetch.ts`),
 * so the second go is skipped and the button, with the offer of another
 * source, comes straight away instead of another minute and a half later.
 */
const GAVE_UP_SLOWLY_MS = 40_000;

/** Another source's copy of this chapter, from `/elsewhere`. */
export type ElsewhereChapter = { sourceName: string; lang: string | null; mangaId: string; chapterId: string; chapterName: string };

/** The line across the screen that counts as "where you are" — just under the top. */
const READ_LINE = 8;

/** How often scrolling is turned into a place, at most. */
const MEASURE_MS = 300;
/** How long the screen has to be still before pages mode's pull (`magnet.ts`) acts: past a wheel's notches and a flick's last frames. */
const MAGNET_WAIT_MS = 160;

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
  onLeftAtEnd,
  lastLabel,
  resume = null,
  onPosition,
  backLabel = 'Chapters',
  onGo,
  onSkip,
  skipTo = null,
  hasPrevious = false,
  hasNext = false,
  nextNumber = null,
  nextId = null,
  ahead = null,
  onElsewhere,
  tags,
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
  /**
   * Leaving from the end of the chapter — Back, the swipe, or closing to pick
   * another from the list — which is finishing it, recorded without moving on.
   * Absent where there is nothing to record into (a preview).
   */
  onLeftAtEnd?: (chapterNumber: number) => void;
  /**
   * What the end button says when there is no next chapter. The offline shelf
   * only knows what is saved on the device, so its last chapter is the last one
   * *here* rather than the last one there is — and must not claim otherwise.
   */
  lastLabel?: string;
  /** Where to start, when continuing: a page and how far down it. */
  resume?: { page: number; offset: number } | null;
  /** Told where you are as you scroll — see `usePositionSaver`, which decides how often to save it. */
  onPosition?: (place: { page: number; offset: number; pages: number }) => void;
  /** Where Back goes, named: the chapter list, or a series' details page. */
  backLabel?: string;
  /** Open the chapter before or after this one, by number, without marking anything read. */
  onGo?: (direction: -1 | 1) => void;
  /**
   * Go to the next *whole* chapter instead, passing over the point chapters.
   *
   * `finishing` mirrors the arrow's own rule: from the last page this is
   * finishing and the chapters passed over are marked read with it, because
   * skipping them is the claim that this chapter already contained them. From
   * partway through it only moves, since skipping is not finishing.
   */
  onSkip?: (finishing: boolean) => void;
  /** The number it would go to, shown on the control. Null when there is nothing to skip. */
  skipTo?: number | null;
  /** Whether there is a chapter that way, for the arrows' disabled state. */
  hasPrevious?: boolean;
  hasNext?: boolean;
  /** The number Next would open, so a jump over missing chapters can be questioned. */
  nextNumber?: number | null;
  /**
   * The id of the chapter Next and finishing open, the copy the screen shows,
   * so the reader can fetch it onto this device while this one is read (see
   * `holdNext`). Absent where that is not worth it: a preview, and the offline
   * shelf, whose chapters are on the device already.
   */
  nextId?: string | null;
  /**
   * Open this chapter's copy on another source, offered when a page will not
   * come. Absent where there is no followed series to read it under.
   */
  onElsewhere?: (copy: ElsewhereChapter) => void;
  /**
   * Reading ahead, what is ready after this chapter — "next 3 saved ✓",
   * "saving 13 · 40%". Shown under the chapter's number, so whether the next
   * press will open at once or wait is visible before it is pressed.
   */
  ahead?: string | null;
  /**
   * The series' tags, where the screen opening the reader knows them: what
   * switching by itself asks first (`formatFromTags`, and `leanFromTags`
   * where they only lean), before the pictures.
   */
  tags?: string[];
}) {
  /*
   * Back closes the reader and puts you back on the chapter list.
   *
   * Mounted for the whole reading session rather than per chapter: the arrows
   * change `chapter` without remounting this component, so reading three in a
   * row is still one step and back returns to the list rather than walking
   * through the chapters you just read.
   *
   * It is here rather than at each of the three places a reader opens from —
   * the chapter list, a series' details, and the offline shelf — because all
   * three hand it an `onClose` and none of them should have to know this
   * exists. `close` is what the ✕ and the end-of-chapter button call now, so
   * leaving by hand and leaving by back are the same route.
   */
  // `consumeOnUnmount`: the reader covers the whole app, so nothing can
  // navigate away from it — every unmount is a close, including the one that
  // happens when Next runs out of chapters. See the note in `view-history.ts`.
  /*
   * Leaving from the end of a chapter is finishing it. Next was the only way a
   * chapter counted, so reading to the end, going back to the list and tapping
   * the next one by hand recorded nothing — the same lost chapter by another
   * door. Asked fresh at the moment of leaving, like Next is.
   */
  const leave = () => {
    // Measured before closing, while the strip is still there to measure.
    const finished = onLeftAtEnd !== undefined && finishedNow();
    /*
     * Closed first, then recorded — and the order matters. Closing saves the
     * place you left; recording the read then clears it, both on the server
     * (the read is the later of the two) and on the page the host draws. The
     * other way round, the close put the place back afterwards and the button
     * offered to "continue" the chapter just finished.
     */
    onClose();
    if (finished) onLeftAtEnd!(chapter.number);
  };
  const close = useBackStep(leave, { consumeOnUnmount: true });

  /**
   * Whether going to the next chapter is all right, asking first when it would
   * jump over whole chapters this source does not have.
   *
   * Next goes by chapter number, so a source with a hole in it — or one that
   * numbers a chapter wrongly — sends it as far as the next number it has. A
   * friend's reader went from about chapter 9 to about 126 that way with one
   * press, and nothing said so until the story made no sense. A gap of a whole
   * chapter or more is worth one question; 9 → 9.5 → 10 is not.
   */
  const nextIsOk = (): boolean => {
    if (nextNumber === null || Math.floor(nextNumber) <= Math.floor(chapter.number) + 1) return true;
    const missing = Math.floor(nextNumber) - Math.floor(chapter.number) - 1;
    return window.confirm(
      `The next chapter on this source is ${nextNumber} — ${missing} chapter${missing === 1 ? '' : 's'} after ${chapter.number} ` +
        `${missing === 1 ? 'is' : 'are'} missing or numbered oddly here. Go to ${nextNumber} anyway?\n\n` +
        `(Cancel, then ⋯ → Other sources on the chapter list, to find one that has them.)`
    );
  };
  const [rawUrls, setUrls] = useState<(string | null)[]>([]);
  /**
   * The source's own page paths, kept so one page can be asked for again.
   *
   * A ref rather than state: nothing renders from it, and it must be readable
   * by a retry handler that was created on an earlier render.
   */
  const paths = useRef<string[]>([]);
  /**
   * Pages that were asked for and did not come.
   *
   * Distinct from "not here yet", which is what an empty slot used to mean for
   * both — so a page that had failed looked exactly like one still on its way,
   * and the only way out was to leave the chapter and open it again. Reported
   * as wanting a way to refresh images that are not loading.
   */
  const [failed, setFailed] = useState<Set<number>>(new Set());
  /** The ones being fetched again right now, so the button cannot be pressed twice. */
  const [retrying, setRetrying] = useState<Set<number>>(new Set());
  /** Asked for more than `SLOW_NOTICE_MS` ago and still not here. */
  const [slow, setSlow] = useState<Set<number>>(new Set());
  /**
   * Starts the clock on one request for a page; the function it returns stops
   * it. Past `SLOW_NOTICE_MS` the slot says the page is slow.
   */
  const watchSlow = (index: number) => {
    const timer = setTimeout(() => setSlow((had) => new Set(had).add(index)), SLOW_NOTICE_MS);
    return () => {
      clearTimeout(timer);
      setSlow((had) => {
        if (!had.has(index)) return had;
        const next = new Set(had);
        next.delete(index);
        return next;
      });
    };
  };
  /** Looking for this chapter on another source, and what was found. */
  const [elsewhere, setElsewhere] = useState<
    | null
    | { state: 'looking' }
    | { state: 'found'; options: ElsewhereChapter[]; searched: number }
    | { state: 'failed'; message: string }
  >(null);
  const findElsewhere = async () => {
    if (!seriesId) return;
    setElsewhere({ state: 'looking' });
    try {
      const { options, searched } = await manga.reader.elsewhere(seriesId, chapter.number);
      setElsewhere({ state: 'found', options, searched });
    } catch (error) {
      setElsewhere({ state: 'failed', message: error instanceof Error ? error.message : 'could not look' });
    }
  };
  const [rawTotal, setTotal] = useState<number | null>(null);
  /**
   * Which chapter `rawUrls` and `rawTotal` are about (2026-11-11).
   *
   * They are cleared by the loader's effect, which runs after the render in
   * which the chapter changed, so for that one render they still held the
   * last chapter's pages and the new chapter's strip drew them: in *Endless*,
   * every page of the chapter just finished put on screen a second time, as
   * new pictures, below the first copy and at the moment the next chapter
   * starts. Reported as the start of chapter 82 looking squished, on the
   * series whose pages had twice killed the page on an iPhone at exactly this
   * moment. Read through `urls` and `total`, which are empty until the loader
   * has started on this chapter.
   */
  const [owner, setOwner] = useState(chapter.id);
  const urls = owner === chapter.id ? rawUrls : NO_URLS;
  const total = owner === chapter.id ? rawTotal : null;
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
  useTakeScreen();

  /** The page crossing the read line — what the counter says. */
  const [page, setPage] = useState(resume?.page ?? 0);
  /**
   * Whether this chapter has been read to its end — see `reachedTheEnd`, which
   * is what Next asks now instead of the counter. Latched: scrolling back up
   * to look at a panel again does not un-finish it.
   */
  const [atEnd, setAtEnd] = useState(false);
  /** The same, readable from handlers made on an earlier render. */
  const atEndRef = useRef(false);
  const top = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  /** Whether pages mode is showing, and its sheets: read by handlers made on earlier renders. */
  const pagesRef = useRef(false);
  const sheetsRef = useRef<number[][] | null>(null);
  /**
   * Every page's element, in page order. In pages mode they sit inside sheets,
   * so this is not the strip's children; and a finished chapter left above
   * (carrying on) is outside the strip, so it is never counted.
   */
  const pageEls = (): HTMLElement[] => (strip.current ? [...strip.current.querySelectorAll<HTMLElement>('[data-page]')] : []);
  /**
   * Where the screen sits with a sheet in the middle of it, which is what pages
   * mode snaps to: the page before and the page after show above and below.
   */
  const centred = (sheet: Element): number => {
    const box = sheet.getBoundingClientRect();
    return window.scrollY + box.top - (window.innerHeight - box.height) / 2;
  };
  /** Where on the document a place is. In pages mode, its sheet in the middle of the screen. */
  const placeY = (index: number, offset: number): number | null => {
    const els = pageEls();
    if (els.length === 0) return null;
    const el = els[Math.max(0, Math.min(index, els.length - 1))];
    const sheet = pagesRef.current ? (el.closest('.manga-sheet') as HTMLElement | null) : null;
    // The start of a chapter is its first sheet, the group's notice where there is one above the first page.
    const opening = index === 0 && offset === 0 ? strip.current?.querySelector<HTMLElement>(':scope > .manga-sheet-credits') : null;
    if (opening && sheet && opening.compareDocumentPosition(sheet) & Node.DOCUMENT_POSITION_FOLLOWING) return Math.max(0, centred(opening));
    if (sheet) return centred(sheet);
    return window.scrollY + el.getBoundingClientRect().top + offset * el.offsetHeight - READ_LINE;
  };
  /** Whether a page is on the last sheet, in pages mode: that sheet on screen is the end. */
  const onLastSheet = (index: number): boolean => {
    const sheets = sheetsRef.current;
    return pagesRef.current && sheets !== null && sheets.length > 0 && sheets[sheets.length - 1].includes(index);
  };
  /** The last place measured, put back when the layout changes under it (sheets re-paired, the mode switched). */
  const lastPlace = useRef<{ page: number; offset: number; chapter?: string } | null>(null);
  /** For callbacks made on an earlier render: the chapter being read now. */
  const chapterIdRef = useRef(chapter.id);
  chapterIdRef.current = chapter.id;
  /** A page turn's landing, still to come; a chapter change cancels it. */
  const landing = useRef<ReturnType<typeof setTimeout> | null>(null);

  /*
   * Carrying on: in scroll mode, with it switched on, the next chapter opens
   * below the end of this one rather than in its place, and this one stays
   * above it. See "Carrying on" at `continueOn`.
   */
  const [carried, setCarried] = useState<Carried[]>([]);
  /** Page URLs that belong to a carried chapter now, so the loader does not revoke them under it. */
  const handedOff = useRef(new Set<string>());
  // Read when this chapter's pages are all in, which can be after the list has reloaded.
  const nextIdRef = useRef(nextId);
  nextIdRef.current = nextId;
  /** Set just before moving on by carrying on, so the chapter change keeps the scroll where it is. */
  const seamless = useRef<number | null>(null);
  /** Carrying on now: marked within the last few seconds, so a mark nothing came of cannot hold things up. */
  const carrying = () => seamless.current !== null && Date.now() - seamless.current < 10_000;
  /**
   * The chapter just finished, and where it sat on screen, so that taking older
   * ones off the top leaves it exactly there. Measured rather than worked out
   * from their heights: Chrome already keeps what you are looking at in place
   * when something above it goes (scroll anchoring), and Safari does not, so
   * scrolling back by the height moved Chrome a whole chapter up.
   */
  /** Pictures of chapters taken off the top, let go once they are off the screen. */
  const dropped = useRef<string[]>([]);
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

  /**
   * Fetch one page again.
   *
   * Per page rather than per chapter, because that is the shape of the
   * failure: a strip of a hundred images over somebody else's CDN loses one
   * here and there, and throwing away ninety-nine good pages to recover one is
   * a poor trade — especially on a phone paying for them twice.
   *
   * The object URL is not revoked on success, for the same reason the loader
   * keeps its own list: the ones this chapter made are released together when
   * it closes, and revoking one still referenced by a rendered `<img>` would
   * blank a page that had just arrived.
   */
  const retryPage = async (index: number) => {
    const path = paths.current[index];
    if (!path || retrying.has(index)) return;
    setRetrying((had) => new Set(had).add(index));
    const done = watchSlow(index);
    try {
      // The same call the loader makes — only the page *list* differs in
      // preview — but fresh: past any saved copy here or on the PC, which may
      // be the very thing that would not draw.
      const url = await manga.reader.page(path, { fresh: true });
      setUrls((current) => {
        const copy = [...current];
        copy[index] = url;
        return copy;
      });
      setFailed((had) => {
        const next = new Set(had);
        next.delete(index);
        return next;
      });
    } catch {
      // Still not coming. It stays marked, so the button stays there.
    } finally {
      done();
      setRetrying((had) => {
        const next = new Set(had);
        next.delete(index);
        return next;
      });
    }
  };

  /**
   * Every page that failed, again — one at a time, in reading order. Offered
   * once more than one has failed, because tapping each gap in turn is the
   * chore a flaky evening on a Cloudflare-fronted source turns into.
   */
  const retryAll = async () => {
    for (const index of [...failed].sort((a, b) => a - b)) await retryPage(index);
  };

  /**
   * The gear's reload: every page not on screen yet, fresh, in reading order;
   * or, when they are all here, every page, for one that arrived but draws
   * wrong. Pages already on screen stay up until their new copy lands.
   */
  const [reloading, setReloading] = useState(false);
  const reloadPages = async () => {
    const missing = paths.current.map((_, i) => i).filter((i) => !urls[i]);
    const which = missing.length > 0 ? missing : paths.current.map((_, i) => i);
    setReloading(true);
    try {
      for (const index of which) await retryPage(index);
    } finally {
      setReloading(false);
    }
  };

  useEffect(() => {
    let alive = true;
    const made: string[] = [];

    (async () => {
      setUrls([]);
      setTotal(null);
      setOwner(chapter.id);
      setProblem(null);
      setSlow(new Set());
      setElsewhere(null);
      // A chapter held ahead that this is not was a guess that missed.
      if (seriesId) dropHeld(seriesId, chapter.id);
      try {
        const list: { pages: string[]; readAhead?: number; pageMargins?: MarginSide | null; saved?: true } = preview
          ? await manga.browse.pages(preview, chapter.id)
          : await manga.reader.pages(seriesId!, chapter.id);
        const { pages } = list;
        if (!alive) return;
        // The PC's word on the series' margins, kept on this device for chapters read away from it.
        if (seriesId && list.pageMargins !== undefined) {
          rememberMargins(seriesId, list.pageMargins);
          setMargins(list.pageMargins);
        }
        setTotal(pages.length);
        setUrls(new Array(pages.length).fill(null));
        paths.current = pages;
        setFailed(new Set());

        let next = 0;
        /** Pages that failed on the first pass, given one more go at the end. */
        const later: number[] = [];
        const show = (index: number, url: string) => {
          made.push(url);
          setUrls((current) => {
            const copy = [...current];
            copy[index] = url;
            return copy;
          });
        };
        const worker = async () => {
          while (alive) {
            const index = next++;
            if (index >= pages.length) return;
            const began = Date.now();
            const done = watchSlow(index);
            try {
              const url = await manga.reader.page(pages[index]);
              if (!alive) {
                URL.revokeObjectURL(url);
                return;
              }
              show(index, url);
            } catch {
              // One page failing must not stop the rest: a strip with a gap is
              // readable, a blank screen is not. Kept for a second go below,
              // unless it took so long to fail that a second go is a minute and
              // a half more of the same.
              if (Date.now() - began >= GAVE_UP_SLOWLY_MS) {
                if (alive) setFailed((had) => new Set(had).add(index));
              } else later.push(index);
            } finally {
              done();
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(IN_FLIGHT, pages.length) }, worker));

        /*
         * Every page of this one is in, so the next is fetched onto this device
         * now, while it is read, rather than when it opens — see `holdNext`.
         * Off with the setting at 0, and not from a chapter saved here, which is
         * read away from the PC as often as not.
         */
        const nextUp = nextIdRef.current;
        holdAllowed.current = Boolean(seriesId && !list.saved && (list.readAhead ?? 1) > 0);
        // In Endless, from halfway through instead (`holdFromHalfway`): the next chapter is not loaded before then.
        if (alive && seriesId && nextUp && holdAllowed.current && !endlessRef.current) void holdNext(seriesId, nextUp);

        /*
         * The second go, once the rest of the chapter is in. Most pages that
         * fail are refused rather than slow — a Cloudflare challenge on the
         * source's image server, which comes and goes — and the server has
         * already asked three times by now, so this waits a little longer and
         * asks again, one page at a time and past any saved copy, before
         * anything is marked. Only what fails this too gets the "tap to try
         * again" button; that used to be every first-pass miss, which on a
         * flaky evening meant tapping the same page several times.
         */
        if (later.length > 0 && alive) {
          await new Promise((r) => setTimeout(r, SECOND_GO_MS));
          for (const index of later.sort((a, b) => a - b)) {
            if (!alive) return;
            const done = watchSlow(index);
            try {
              const url = await manga.reader.page(pages[index], { fresh: true });
              if (!alive) {
                URL.revokeObjectURL(url);
                return;
              }
              show(index, url);
            } catch {
              // Marked now, so the gap says what it is and offers to try again
              // rather than looking like a slow connection.
              if (alive) setFailed((had) => new Set(had).add(index));
            } finally {
              done();
            }
          }
        }
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
      for (const url of made) if (!handedOff.current.has(url)) URL.revokeObjectURL(url);
    };
  }, [seriesId, preview, chapter.id]);

  // Back to the top when the chapter changes, or reading the next one starts you
  // at the bottom of it — unless this chapter is being continued.
  useEffect(() => {
    // Carried on into: the reader stays where it is, below the chapter just finished.
    /*
     * Opened by Next in pages mode, a chapter could start nearly at its end
     * (2026-11-12, reported twice as page 19 of 24). Three ways the last
     * chapter's place could reach this one are closed here: a page turn's
     * landing still to come (cancelled, and any smooth scroll stopped where it
     * is), the layout's put-back using the place measured in the chapter before
     * (`lastPlace` now says which chapter it was in), and a carry-on mark left
     * over (`seamless` is a time, good for a few seconds). And in pages mode a
     * chapter not being returned to is headed for its first sheet, as a jump
     * is, so whatever the snapping does while its pages arrive, that is where
     * it lands.
     */
    const carry = carrying();
    seamless.current = null;
    lastPlace.current = null;
    if (landing.current) {
      clearTimeout(landing.current);
      landing.current = null;
    }
    if (!carry) window.scrollTo({ top: window.scrollY, behavior: 'auto' });
    if (!carry && carried.length > 0) {
      // Any other way to a chapter starts afresh, without the ones above.
      for (const c of carried) for (const u of c.urls) if (u) dropped.current.push(u);
      for (const job of waking.current.values()) job.alive = false;
      waking.current.clear();
      setCarried([]);
    }
    const from = carry ? null : resume;
    returning.current = from;
    setHeading(from ? { page: from.page, why: 'resume' } : null);
    setEagerTo(from ? from.page + 1 : -1);
    setPage(from?.page ?? 0);
    setAtEnd(false);
    atEndRef.current = false;
    setViewing(null);
    heldFor.current = null;
    if (!carry && !resume) top.current?.scrollIntoView({ block: 'start' });
    if (!carry && !resume && pagesRef.current) returning.current = { page: 0, offset: 0 };
    /*
     * Carried on into by Next: go down to where it starts, as a jump to its
     * first page, which waits for the page to be there. Scrolling at once went
     * nowhere: the chapter had no pages yet and so no height, the scroll stopped
     * at the bottom of the one before, and that is where you were left while
     * this one filled in below (2026-11-12, reported as Next booting you back).
     * A touch on the screen meanwhile ends it, as any jump does.
     */
    if (carry && jumpOnCarry.current) {
      returning.current = { page: 0, offset: 0 };
      setHeading({ page: 0, why: 'jump' });
      setEagerTo(0);
    }
    jumpOnCarry.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter.id]);

  /** Scroll to the place being headed for; true once every page up to it has loaded. */
  const returnTo = (): boolean => {
    const target = returning.current;
    const kids = pageEls();
    if (!target || kids.length === 0) return false;
    const at = Math.min(target.page, kids.length - 1);
    const y = placeY(at, target.offset);
    if (y !== null) window.scrollTo(0, Math.max(0, y));
    // A sheet is the screen's height whatever is in it, so nothing arriving above moves it.
    if (pagesRef.current) return true;
    return kids.slice(0, at + 1).every(loaded);
  };

  // Each page landing moves everything below it, so keep going until done.
  useEffect(() => {
    if (!returning.current || total === null) return;
    if (returnTo()) arrived();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urls, total, eagerTo]);

  /** When the screen was last touched, scrolled or typed at: a jump's second look stands down after one. */
  const lastTouch = useRef(0);
  // Touching the screen ends the return: you have taken over.
  useEffect(() => {
    const stop = () => {
      lastTouch.current = performance.now();
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
    /*
     * In pages mode the sheet is brought to the middle (`scrollIntoView`).
     * The place is the target at once, so nothing redrawing meanwhile puts the
     * old one back; and it is looked at again twice, going there once more if
     * something moved it (a wide page arriving above), unless you have touched
     * the screen since. Hops used to come undone on an iPhone because Safari's
     * scroll snapping put you back on the sheet it remembered; there is no
     * snapping now (`magnet.ts`).
     */
    if (pagesRef.current) {
      const sheetOf = () => pageEls()[to]?.closest('.manga-sheet') as HTMLElement | null;
      const sheet = sheetOf();
      if (sheet) {
        lastPlace.current = { page: to, offset: 0, chapter: chapter.id };
        sheet.scrollIntoView({ block: 'center' });
        arrived();
        const touchedAt = lastTouch.current;
        const look = () => {
          if (lastTouch.current !== touchedAt || !pagesRef.current) return;
          const here = sheetOf();
          const all = sheetEls();
          if (here && all[sheetAt()] !== here) here.scrollIntoView({ block: 'center' });
        };
        setTimeout(look, 500);
        setTimeout(look, 1100);
        wake();
        return;
      }
    }
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
    const kids = pageEls();
    if (kids.length === 0) return null;

    /*
     * At the foot of the chapter you are on its last page, whatever the
     * geometry says.
     *
     * The loop below takes the first page crossing the read line, which is
     * right everywhere except the very bottom: a chapter whose **last page is
     * shorter than the screen** leaves the page before it still crossing the
     * line at maximum scroll, so the counter stops one short and can never
     * reach the end. Next then reads as "skipping, not finishing" however far
     * you scrolled, and the chapter is never marked read.
     *
     * Reported as chapters not counting when reading several in a row, which is
     * exactly when it shows: it is deterministic per chapter, so a run of them
     * loses the ones with a short final page and keeps the rest. Measured at
     * 860px with a 120px last page: scrolled fully down, this said page 84 of
     * 86.
     */
    const doc = document.documentElement;
    if (window.innerHeight + window.scrollY >= doc.scrollHeight - 2) {
      return { page: kids.length - 1, offset: 1, pages: kids.length };
    }

    /*
     * In pages mode, the page is the one on the sheet in the middle of the
     * screen (2026-11-12). The line near the top is a strip's question: a sheet
     * is centred with the foot of the one before showing above it, so the line
     * fell on that one, and the counter and the place kept were a page behind
     * (and a re-layout put you back on it). Reported as the bar not hopping.
     */
    if (pagesRef.current) {
      // At the top it is the first page, as at the foot it is the last: a short first sheet cannot be centred.
      if (window.scrollY <= 1) return { page: 0, offset: 0, pages: kids.length };
      const sheets = sheetEls();
      const first = sheets[sheetAt()]?.querySelector<HTMLElement>('[data-page]');
      if (first) return { page: Number(first.dataset.page), offset: 0, pages: kids.length };
    }

    for (let i = 0; i < kids.length; i++) {
      const box = kids[i].getBoundingClientRect();
      if (box.bottom > READ_LINE + 1) {
        const offset = box.height > 0 ? Math.min(1, Math.max(0, (READ_LINE - box.top) / box.height)) : 0;
        return { page: i, offset, pages: kids.length };
      }
    }
    return { page: kids.length - 1, offset: 1, pages: kids.length };
  };

  /**
   * Whether this chapter is finished, asked *now* rather than taken from the
   * last measurement. Next and leaving both ask this at the moment they are
   * pressed: the measurement is throttled and paused while a jump settles, and
   * a press that lands in either gap was a chapter lost — the counter's answer
   * was simply out of date.
   */
  const finishedNow = (): boolean => {
    if (atEndRef.current || endInSight()) return true;
    const here = where();
    return here !== null && (here.page === here.pages - 1 || onLastSheet(here.page));
  };

  /** The geometry `reachedTheEnd` decides from, read off the strip as it is now. */
  const endInSight = (): boolean => {
    const box = strip.current;
    const kids = pageEls();
    if (!box || kids.length === 0) return false;
    const lastEl = kids[kids.length - 1];
    const whole = box.getBoundingClientRect();
    /*
     * In pages mode the end is the last sheet being the one on screen, or the
     * strip's own rule below (2026-11-12, asked for as that rule applying here
     * too): under a tenth of the chapter left and under two and a half screens,
     * which with a sheet to a screen is the last two or so. Pages mode had only
     * the first, so a chapter left from its second-to-last page, or anywhere
     * the counter misjudged, was never marked read: 58 and 61 of one series
     * went that way. Every page has its size before it loads in pages mode
     * (`pageShape`), so nothing waits for them to load.
     */
    const sheet = pagesRef.current ? lastEl.closest('.manga-sheet') : null;
    if (sheet) {
      const last = sheet.getBoundingClientRect();
      if (last.top + last.height / 2 < window.innerHeight * 0.75) return true;
      return reachedTheEnd({ viewportHeight: window.innerHeight, stripTop: whole.top, stripHeight: whole.height, lastPageTop: last.top, allLoaded: true });
    }
    const last = lastEl.getBoundingClientRect();
    return reachedTheEnd({
      viewportHeight: window.innerHeight,
      stripTop: whole.top,
      stripHeight: whole.height,
      lastPageTop: last.top,
      allLoaded: kids.every(loaded),
    });
  };

  useEffect(() => {
    let waiting: ReturnType<typeof setTimeout> | null = null;
    const measure = () => {
      waiting = null;
      if (returning.current) return;
      const place = where();
      if (!place) return;
      const above = behindInView();
      setViewing((had) => (had?.id === above?.id && had?.page === above?.page ? had : above));
      // Scrolled back up into the chapter carried above: that is where you are, not here.
      if (above) return;
      setPage(place.page);
      lastPlace.current = { ...place, chapter: chapterIdRef.current };
      if (place.page === place.pages - 1 || onLastSheet(place.page) || endInSight()) {
        atEndRef.current = true;
        setAtEnd(true);
      }
      report.current?.(place);
      continueRef.current();
      tendRef.current();
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
  /*
   * Changing the page width or the layout moves everything below the top of
   * the screen, so the place is taken before the change and put back after it,
   * in a layout effect, so the jump is never painted.
   */
  const anchor = useRef<{ page: number; offset: number } | null>(null);

  /*
   * ### Scroll or pages
   *
   * Scroll is the strip, as it always was, and the default. Pages is a page to
   * the screen with the screen snapping to each, and two side by side when the
   * screen is wide enough for two (a desktop window, a phone held sideways),
   * paired as the printed book pairs them — see `page-layout.ts`.
   *
   * **Switching by itself** (`autoMode`) reads the first few pages of a series
   * it has not seen and keeps what it found per series (`rememberFormat`), so
   * the next chapter opens the right way at once. Picking a mode by hand while
   * it is on is remembered the same way, for that series.
   */
  const seriesKey = seriesId ?? preview;
  // Remembered, else the tags, else (below) the pictures.
  const [detected, setDetected] = useState(() => rememberedFormat(seriesKey) ?? (prefs.autoMode ? formatFromTags(tags) : null));
  // Tags that only lean (Manga) open it that way while the pictures are asked.
  const leaning = prefs.autoMode && detected === null ? leanFromTags(tags) : null;
  const viewMode: ReaderMode = prefs.autoMode && detected ? detected : (leaning ?? prefs.mode);
  const pagesMode = viewMode === 'pages';
  // Pages far from the screen let go of their pixels — see `far-pages.ts`.
  useFarPages(!pagesMode);

  /*
   * ### Nothing above you moves you (2026-11-11)
   *
   * Reported from an iPhone as "when something loaded, it shot me forwards".
   * Safari has no scroll anchoring: when anything above the screen changes
   * height, everything under it moves and the page being read slides away.
   * Plenty above does change in Endless: a chapter taken off the top, a
   * placeholder giving way to a picture that has no size yet, a picture
   * arriving, a notice going.
   *
   * So the reader does it by hand, the same in every browser
   * (`overflow-anchor: none` while it is open, so Chrome does not do it a
   * second time). What is under the read line is remembered by where it sits
   * in the *document* (its top plus the scroll), which scrolling does not
   * change and a change above it does. On every render, and as each picture
   * finishes loading, if it has moved in the document the window moves by as
   * much. A change below, or to the page being read, leaves it where it is.
   * Not while returning to a saved place, which does its own scrolling, nor in
   * pages mode, which snaps. It replaces a measure that covered only a chapter
   * being taken off the top.
   */
  const still = useRef<{ el: Element; at: number } | null>(null);
  const holdingStill = !pagesMode;
  const takeAnchor = () => {
    still.current = null;
    // Pages are stacked, so their bottoms only grow: the first below the line is found by halving, not by walking a session's thousands.
    const pages = document.querySelectorAll('.manga-reader .manga-strip > img, .manga-reader .manga-strip > .manga-page-waiting, .manga-reader .manga-strip > .manga-page-rest');
    let lo = 0;
    let hi = pages.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pages[mid]!.getBoundingClientRect().bottom > READ_LINE + 1) hi = mid;
      else lo = mid + 1;
    }
    const el = pages[lo];
    if (el) still.current = { el, at: el.getBoundingClientRect().top + window.scrollY };
  };
  const holdStill = () => {
    if (!holdingStill || returning.current) {
      still.current = null;
      return;
    }
    const had = still.current;
    if (had?.el.isConnected) {
      const moved = had.el.getBoundingClientRect().top + window.scrollY - had.at;
      if (Math.abs(moved) > 1) window.scrollBy(0, moved);
    }
    takeAnchor();
  };
  const holdStillRef = useRef(holdStill);
  holdStillRef.current = holdStill;
  useLayoutEffect(() => holdStillRef.current());
  useEffect(() => {
    if (!holdingStill) return;
    const root = document.documentElement;
    root.style.overflowAnchor = 'none';
    let last = 0;
    const onScroll = () => {
      // Often enough to be the page you are on, without measuring every event.
      const now = performance.now();
      if (now - last < 50) return;
      last = now;
      if (!returning.current) takeAnchor();
    };
    const onLoad = (event: Event) => {
      if (event.target instanceof HTMLImageElement && event.target.closest('.manga-reader')) holdStillRef.current();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    // `load` does not bubble, so it is heard on the way down.
    document.addEventListener('load', onLoad, true);
    return () => {
      root.style.overflowAnchor = '';
      window.removeEventListener('scroll', onScroll);
      document.removeEventListener('load', onLoad, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holdingStill]);
  pagesRef.current = pagesMode;
  // Pages mode reads every page, for the pairs; telling what a series is takes the first six.
  const infos = usePageInfo(urls, pagesMode ? urls.length : prefs.autoMode && detected === null && !formatFromTags(tags) ? 6 : 0);
  useEffect(() => {
    if (!prefs.autoMode || detected !== null) return;
    // The tags first: switched on mid-chapter, or tags that arrived after opening.
    const fromTags = formatFromTags(tags);
    if (fromTags) {
      anchor.current = where();
      setDetected(fromTags);
      rememberFormat(seriesKey, fromTags);
      return;
    }
    const ready = infos.slice(0, 6).filter((p): p is PageInfo => p !== null);
    // The first six, or the whole chapter when it is shorter.
    if (ready.length < 3 || ready.length < Math.min(6, urls.length)) return;
    // The pictures win; where they say nothing, the tags' lean.
    const kind = contentKind(ready) ?? leanFromTags(tags);
    if (kind) {
      anchor.current = where();
      setDetected(kind);
      rememberFormat(seriesKey, kind);
    }
  });

  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  /*
   * What the pages say about pairing, worked out once per page read rather
   * than at every redraw (the reader redraws as you scroll): each of these
   * walks every page's edges and rows. A first or last image with a page
   * stacked in it counts as that page (`stackedPages`); the group's own pages
   * are apart (`apartPages`).
   */
  const { stacked, aspects, apart } = useMemo(
    () => ({ stacked: stackedPages(infos), aspects: asBookPages(infos).map((p) => p?.aspect ?? null), apart: apartPages(infos) }),
    [infos]
  );
  const twoUp =
    pagesMode &&
    (prefs.spread === 'two' ||
      // The window decides, not the page size: making pages smaller must not turn two into one.
      (prefs.spread === 'auto' && fitsTwo(viewport.w, viewport.h, typicalAspect(aspects))));
  /**
   * The pairing set by hand for this chapter (`ChapterPairing`), kept on the
   * device. Held with the chapter it is for, and read afresh in the render a
   * chapter changes, so one chapter's fix is never laid over the next.
   */
  const [pairingHeld, setPairingHeld] = useState<{ chapter: string } & ChapterPairing>(() => ({ chapter: chapter.id, ...rememberedPairing(chapter.id) }));
  const pairing: ChapterPairing = pairingHeld.chapter === chapter.id ? pairingHeld : rememberedPairing(chapter.id);
  const setPairing = ({ first, alone }: ChapterPairing) => {
    const next: ChapterPairing = { first, alone: alone && alone.length > 0 ? alone : undefined };
    setPairingHeld({ chapter: chapter.id, ...next });
    rememberPairing(chapter.id, next);
  };
  const alone = pairing.alone ?? [];
  /** Which edge this series keeps plain paper on, where known — see `MarginSide`. */
  const [margins, setMargins] = useState<MarginSide | null>(() => rememberedMargins(seriesKey));
  /** Whether a finger, a mouse drag or the slide after one is moving the page: see where the sheets are laid out. */
  const moving = useRef(false);
  const deferredLayout = useRef(false);
  const shownSheets = useRef<{ chapter: string; count: number; sheets: number[][] } | null>(null);
  const [, setRelayout] = useState(0);
  /*
   * A series learns its side from its first picture drawn across the fold
   * (2026-11-12): that picture says which pages face each other, and the
   * margins of the rest of the chapter then say which edge this series keeps
   * plain, as **Move along one** teaches it. Once every page is read, and only
   * while the series has no side.
   */
  const allRead = pagesMode && infos.length > 0 && infos.every((p) => p !== null);
  useEffect(() => {
    if (!allRead || margins !== null || !seriesId) return;
    const bySeams = seamsDecide(infos, prefs.rightToLeft);
    if (bySeams === null) return;
    const learned = learnMargins(infos, prefs.rightToLeft, bySeams);
    if (!learned) return;
    setMargins(learned);
    rememberMargins(seriesId, learned);
    void manga.reader.setPageMargins(seriesId, learned).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRead, margins, seriesId, chapter.id, prefs.rightToLeft]);
  /*
   * Paired from the first page unless the pictures carried across the gutter
   * say otherwise, or the series' margins do.
   */
  const decided = useMemo(() => (twoUp ? chooseFirstAlone(infos, prefs.rightToLeft, margins) : null), [twoUp, infos, prefs.rightToLeft, margins]);
  const firstAlone = pairing.first ?? decided ?? false;
  const shifted = firstAlone !== (decided ?? false);
  /**
   * **Move along one**, and what it teaches: where this chapter's margins say
   * clearly which pairing is which, the side that makes them agree with the
   * pairing just asked for is kept for the series (on the PC, and here), so
   * its other chapters pair that way without being asked.
   */
  const shiftPairs = () => {
    const wanted = !firstAlone;
    const learned = learnMargins(infos, prefs.rightToLeft, wanted);
    if (learned && learned !== margins && seriesId) {
      setMargins(learned);
      rememberMargins(seriesId, learned);
      void manga.reader.setPageMargins(seriesId, learned).catch(() => {});
      // Asked again with what was learned: kept by hand only if that still does not give the pairing asked for.
      const now = chooseFirstAlone(infos, prefs.rightToLeft, learned) ?? false;
      setPairing({ first: now === wanted ? undefined : wanted });
      return;
    }
    // A whole-chapter move starts the pairing afresh, so pages put on their own by hand go with it.
    setPairing({ first: wanted === (decided ?? false) ? undefined : wanted });
  };
  // A scanlation group's own pages (a notice, credits) are alone, so the book's pages pair as printed; so is a page put on its own by **From here**.
  const paired = pagesMode ? pairPages(aspects, firstAlone, twoUp, apart.map((a, i) => a || alone.includes(i))) : null;
  /*
   * Not under a finger (2026-11-12). The pairing can change as the pages are
   * read one by one in the background (a page set apart, the margins tipping
   * the choice), and a change puts you back on your page: mid-drag that was
   * the page moving by itself under the finger, reported as the pull going on
   * while dragging. So while a finger, a mouse drag or the slide after one is
   * moving the page (`moving`), the pairing on screen is kept, and the new one
   * is laid out once the page has come to rest (`stillAgain`).
   */
  const shownSheet = shownSheets.current;
  const frozen =
    moving.current &&
    !!paired &&
    !!shownSheet &&
    shownSheet.chapter === chapter.id &&
    shownSheet.count === urls.length &&
    shownSheet.sheets.map((s) => s.join('+')).join(',') !== paired.map((s) => s.join('+')).join(',');
  if (frozen) deferredLayout.current = true;
  const sheets = frozen ? shownSheet!.sheets : paired;
  shownSheets.current = sheets ? { chapter: chapter.id, count: urls.length, sheets } : null;
  sheetsRef.current = sheets;
  const layoutSig = sheets ? sheets.map((sheet) => sheet.join('+')).join(',') : 'scroll';
  const sheetNow = sheets?.find((sheet) => sheet.includes(page)) ?? null;
  /*
   * **From here**: a page missing from the scan puts every pair after it one
   * page out (2026-11-12: Reset's chapters 7.2 and 8.1 of *MMO!* each lack a
   * page Thunder's have), and moving the whole chapter along fixes the pairs
   * after it by breaking the ones before. So the page showing is put on its
   * own and the pairing after it moves along by one; pressed on a page put on
   * its own that way, it goes back. Nothing finds the gap by itself: the
   * margins say which side of the book a page was on for two or three pages a
   * chapter, too few to tell where between them a page went missing.
   */
  const sheetIndex = sheets && sheetNow ? sheets.indexOf(sheetNow) : -1;
  const firstBookSheet = sheets ? sheets.findIndex((sheet) => !apart[sheet[0]]) : -1;
  const shiftedHere = !!sheetNow && sheetNow.length === 1 && alone.includes(sheetNow[0]);
  const shiftHere = () => {
    if (!sheetNow) return;
    const at = sheetNow[0];
    if (shiftedHere) setPairing({ ...pairing, alone: alone.filter((n) => n !== at) });
    else if (sheetNow.length === 2) setPairing({ ...pairing, alone: [...alone, at].sort((a, b) => a - b) });
    // A page already alone (the last, a spread): the pairing moves along from the page after it.
    else if (at + 1 < urls.length && !apart[at + 1]) setPairing({ ...pairing, alone: [...alone, at + 1].sort((a, b) => a - b) });
  };

  /** The sheets, in order. */
  const sheetEls = () => (strip.current ? [...strip.current.querySelectorAll<HTMLElement>('.manga-sheet')] : []);
  /** The sheet nearest the middle of the screen. */
  const sheetAt = (): number => {
    const all = sheetEls();
    const off = (el: Element) => {
      const box = el.getBoundingClientRect();
      return Math.abs(box.top + box.height / 2 - window.innerHeight / 2);
    };
    let at = 0;
    all.forEach((el, i) => {
      if (off(el) < off(all[at])) at = i;
    });
    return at;
  };
  /**
   * Go a sheet on or back from `from` (the one on screen, by default); 0 goes
   * back to `from`. Returns where it is going.
   */
  const turnSheet = (direction: 1 | -1 | 0, from = sheetAt(), smooth = false): number | null => {
    const all = sheetEls();
    if (all.length === 0) return null;
    const to = from + direction;
    const end = document.querySelector('.manga-reader-end');
    const top =
      to >= all.length
        ? end
          ? window.scrollY + end.getBoundingClientRect().bottom - window.innerHeight
          : null
        : centred(all[Math.max(0, to)]);
    if (top !== null) window.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
    return top;
  };
  useEffect(() => {
    if (!pagesMode) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, .manga-reader-settings')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Right to left, the next page is to the left.
      const nextKey = prefs.rightToLeft ? 'ArrowLeft' : 'ArrowRight';
      const backKey = prefs.rightToLeft ? 'ArrowRight' : 'ArrowLeft';
      const forward = e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ' || e.key === nextKey;
      const back = e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === backKey;
      if (!forward && !back) return;
      e.preventDefault();
      turnSheet(forward ? 1 : -1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagesMode, prefs.rightToLeft]);

  /** Scroll or pages, picked in the gear. With switching by itself on, kept for this series too. */
  const pickMode = (mode: ReaderMode) => {
    anchor.current = where();
    if (prefs.autoMode) {
      setDetected(mode);
      rememberFormat(seriesKey, mode);
    }
    setPrefs({ mode });
  };

  /*
   * ### Carrying on
   *
   * Scroll mode, with it switched on: once this chapter is read to its end
   * (the same `reachedTheEnd` that makes Next finish it), it is finished as
   * Next would finish it and the next chapter opens **below** it rather than
   * in its place, so the strip simply goes on. The chapter just read stays on
   * screen above, its pictures handed over rather than fetched again, and so
   * does every one before it, keeping its space (see "The chapters above keep
   * their space").
   *
   * It stops, and leaves the ordinary buttons, where Next would ask first: a
   * hole of a whole chapter or more in this source's numbers. And it waits for
   * every page of this chapter, since a page that failed is one to try again
   * before moving on.
   */
  const behind = carried.filter((c) => c.id !== chapter.id);
  const continueOn = () => {
    if (!prefs.infinite || pagesMode || carrying() || !hasNext || !total || problem) return;
    if (nextNumber !== null && Math.floor(nextNumber) > Math.floor(chapter.number) + 1) return;
    if (urls.some((u) => !u) || !endInSight()) return;
    carryOn(true, false);
  };
  /**
   * This chapter goes above and the next one opens below it: by reaching the
   * end (`continueOn`, which stays where you are) or by Next (`jump`, which
   * then takes you down to the next one's start). From partway through, Next
   * only moves, as it always has: `finishing` is false and nothing is marked.
   */
  const jumpOnCarry = useRef(false);
  const carryOn = (finishing: boolean, jump: boolean) => {
    seamless.current = Date.now();
    jumpOnCarry.current = jump;
    for (const u of urls) if (u) handedOff.current.add(u);
    const kept: Carried = { id: chapter.id, number: chapter.number, urls: [...urls], paths: [...paths.current], shapes: [] };
    setCarried([...behind, kept]);
    // Left before every page had come: the rest are fetched into it, so scrolling back finds them.
    if (kept.urls.some((u) => !u) && kept.paths.length > 0) wakeChapter(kept);
    if (finishing) onFinished(chapter.number);
    else onGo!(1);
  };
  /**
   * The arrows in Endless go between the chapters on screen (2026-11-12, asked
   * for as Next scrolling to the next chapter). From a chapter kept above, to
   * the start of the one after it, or before it; from the chapter being read,
   * Next carries on into the next one and goes down to it, and Previous goes up
   * to the one kept above. Past those, they do what they always did.
   */
  const blockInView = () => {
    const blocks = [...document.querySelectorAll<HTMLElement>('.manga-reader [data-chapter-block]')];
    const here = viewing?.id ?? chapter.id;
    return { blocks, at: blocks.findIndex((b) => b.dataset.chapterBlock === here) };
  };
  const scrollToBlock = (block: HTMLElement) => window.scrollTo(0, window.scrollY + block.getBoundingClientRect().top);
  const goNext = (finishing: boolean) => {
    if (prefs.infinite && !pagesMode && !carrying()) {
      const { blocks, at } = blockInView();
      if (at >= 0 && at < blocks.length - 1) return scrollToBlock(blocks[at + 1]!);
      if (!hasNext || !nextIsOk()) return;
      return carryOn(finishing, true);
    }
    if (!nextIsOk()) return;
    if (finishing) onFinished(chapter.number);
    else onGo?.(1);
  };
  /**
   * The gear's Refresh: every chapter kept above goes, and you stay where you
   * are in this one (`holdStill` puts the page back as the space above goes).
   * From a chapter kept above, which is going too, to the start of this one.
   */
  const clearAbove = () => {
    const wasAbove = viewing !== null;
    for (const c of carried) for (const u of c.urls) if (u) dropped.current.push(u);
    for (const job of waking.current.values()) job.alive = false;
    waking.current.clear();
    setCarried([]);
    setViewing(null);
    if (wasAbove) {
      setTimeout(() => {
        if (strip.current) window.scrollTo(0, window.scrollY + strip.current.getBoundingClientRect().top);
      }, 0);
    }
  };
  const goPrevious = () => {
    if (prefs.infinite && !pagesMode && !carrying()) {
      const { blocks, at } = blockInView();
      if (at > 0) return scrollToBlock(blocks[at - 1]!);
    }
    onGo?.(-1);
  };

  /*
   * ### The chapters above keep their space (2026-11-12)
   *
   * Every chapter carried on from stays where it is for the whole session. One
   * more than `REST_SCREENS` screens from the screen rests: each page becomes a
   * blank of exactly the size it was, measured off the page as drawn, and its
   * picture and bytes are let go. Within `WAKE_SCREENS` its pages are asked for
   * again (from this device's saved copy, or the PC's cache) and drawn into the
   * same space, so scrolling back up through a session works and moves nothing.
   * Pictures held follow the screen, not how far you have read.
   *
   * This is what replaced loading and dropping whole chapters either side, tried
   * the same day: every chapter added or taken away above you is a scroll put
   * back by hand, which on an iPhone also stops a flick dead, and it latched onto
   * the wrong chapter once (Next opened a chapter with nothing in it yet, the one
   * before was loaded above it, and the reader held on to that instead).
   */
  const carriedRef = useRef(carried);
  carriedRef.current = carried;
  /** Each waking chapter's fetch, so leaving can stop it. */
  const waking = useRef(new Map<string, { alive: boolean }>());
  const blockOf = (id: string) =>
    [...document.querySelectorAll<HTMLElement>('.manga-reader [data-chapter-block]')].find((el) => el.dataset.chapterBlock === id) ?? null;
  const rest = (c: Carried, block: HTMLElement) => {
    const pages = [...block.querySelectorAll<HTMLElement>(':scope > img, :scope > .manga-page-waiting, :scope > .manga-page-rest')];
    const shapes = pages.map((el) => (el.offsetWidth > 0 && el.offsetHeight > 0 ? el.offsetWidth / el.offsetHeight : null));
    for (const u of c.urls) if (u) dropped.current.push(u);
    setCarried((had) => had.map((x) => (x.id === c.id ? { ...x, resting: true, shapes, urls: x.urls.map(() => null) } : x)));
  };
  const wakeChapter = (c: Carried) => {
    const job = { alive: true };
    waking.current.set(c.id, job);
    setCarried((had) => had.map((x) => (x.id === c.id ? { ...x, resting: false } : x)));
    const todo = c.paths.map((_, i) => i).filter((i) => !c.urls[i]);
    let next = 0;
    const worker = async () => {
      while (job.alive) {
        if (next >= todo.length) return;
        const index = todo[next++]!;
        try {
          const url = await manga.reader.page(c.paths[index]!);
          if (!job.alive) {
            URL.revokeObjectURL(url);
            return;
          }
          handedOff.current.add(url);
          setCarried((had) => had.map((x) => (x.id === c.id ? { ...x, urls: x.urls.map((u, i) => (i === index ? url : u)) } : x)));
        } catch {
          // Left blank, its space kept: it is asked for again the next time it wakes.
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(IN_FLIGHT, todo.length) }, worker)).finally(() => {
      if (waking.current.get(c.id) === job) waking.current.delete(c.id);
    });
  };
  /** Rest what is far, wake what is near, and fetch the next chapter ahead from halfway. */
  const tend = () => {
    const vh = window.innerHeight || 800;
    for (const c of carriedRef.current) {
      if (c.id === chapter.id) continue;
      const block = blockOf(c.id);
      if (!block) continue;
      const box = block.getBoundingClientRect();
      const away = box.bottom < 0 ? -box.bottom / vh : box.top > vh ? (box.top - vh) / vh : 0;
      if (!c.resting && !waking.current.has(c.id) && away > REST_SCREENS) rest(c, block);
      else if (c.resting && away <= WAKE_SCREENS) wakeChapter(c);
    }
    holdFromHalfway();
  };
  /**
   * The next chapter onto this device (`holdNext`), in Endless from halfway
   * through this one, or from the start of one only a few screens long: asked
   * for as the next chapter not loading before then. What the PC fetches and
   * keeps is unchanged.
   */
  const holdAllowed = useRef(false);
  const heldFor = useRef<string | null>(null);
  const holdFromHalfway = () => {
    if (!endlessRef.current || heldFor.current === chapter.id || !holdAllowed.current || !seriesId || !nextIdRef.current) return;
    const box = strip.current?.getBoundingClientRect();
    if (!box || box.height <= 0 || urls.some((u) => !u)) return;
    const vh = window.innerHeight || 800;
    if ((READ_LINE - box.top) / box.height < 0.5 && box.height >= SHORT_SCREENS * vh) return;
    heldFor.current = chapter.id;
    void holdNext(seriesId, nextIdRef.current);
  };
  const tendRef = useRef(tend);
  tendRef.current = tend;
  const endlessRef = useRef(false);
  endlessRef.current = prefs.infinite && !pagesMode;
  /**
   * The chapter carried above, when that is what is under the read line, and
   * the page of it there (2026-11-11). The number at the top and the counter
   * said the new chapter's from the moment it opened below, while you were
   * still reading the end of the old one, and stayed on it if you scrolled
   * back up. Asked of the blocks themselves, which carry their number.
   */
  const behindInView = (): { id: string; number: number; page: number; pages: number } | null => {
    for (const block of document.querySelectorAll<HTMLElement>('.manga-reader .manga-strip-before')) {
      const box = block.getBoundingClientRect();
      if (box.top > READ_LINE || box.bottom <= READ_LINE + 1) continue;
      const pages = [...block.querySelectorAll<HTMLElement>(':scope > img, :scope > .manga-page-waiting, :scope > .manga-page-rest')];
      let page = pages.findIndex((el) => el.getBoundingClientRect().bottom > READ_LINE + 1);
      if (page < 0) page = pages.length - 1;
      return { id: block.dataset.chapterBlock ?? '', number: Number(block.dataset.chapterNumber), page, pages: pages.length };
    }
    return null;
  };
  const [viewing, setViewing] = useState<{ id: string; number: number; page: number; pages: number } | null>(null);

  const continueRef = useRef(continueOn);
  continueRef.current = continueOn;
  // Chapters taken off the top let go of their pictures. Nothing moves meanwhile: see `holdStill`.
  useLayoutEffect(() => {
    for (const u of dropped.current) {
      URL.revokeObjectURL(u);
      handedOff.current.delete(u);
    }
    dropped.current = [];
  }, [carried]);
  useEffect(
    () => () => {
      for (const u of handedOff.current) URL.revokeObjectURL(u);
      for (const job of waking.current.values()) job.alive = false;
      // Closing the reader is not going on to the next chapter.
      dropHeld();
    },
    []
  );

  /*
   * Dragging the page to scroll it, with a mouse.
   *
   * Deliberately `pointerType === 'mouse'` only: a finger already scrolls by
   * dragging, and claiming the same gesture would mean fighting the browser for
   * it and losing momentum, rubber-banding and every other thing touch
   * scrolling does better than this could. Except in pages mode, where the
   * finger is taken over on purpose (see the touch effect beside `settleFrom`):
   * the browser's momentum cannot be told to stop on a page.
   *
   * `drag.current` is a ref and not state because none of it is rendered and a
   * `setState` per `pointermove` would re-render the strip sixty times a
   * second — the same reason `useEdgeDrawer` keeps its position in one.
   */
  const drag = useRef<{
    /** Where the press was, for the slop. */
    y: number;
    /** Where the pointer was at the last move, for the next one's distance. */
    last: number;
    /** Across, in pages mode, where a sideways drag turns the page as a book's would. */
    x: number;
    /** The sheet on screen when the drag began, in pages mode. */
    sheet: number;
    /** The part of a pixel the browser could not scroll by — see `dragMove`. */
    carry: number;
    moved: boolean;
    samples: DragSample[];
  } | null>(null);
  /** Set when a drag ends, so the click it is followed by does not toggle the controls. */
  const dragged = useRef(false);

  /*
   * The slide after letting go, as a phone does it — see `glide.ts`.
   *
   * Driven by `requestAnimationFrame` with a `setTimeout` racing it, whichever
   * comes first: rAF is what makes it smooth, and it does not fire at all in a
   * window that is not drawing, which is the trap this project keeps finding.
   * The timeout is what stops a slide being left half-done in that case.
   */
  const glide = useRef<{
    velocity: number;
    at: number;
    /** Where the slide has got to, exactly — see `frame`. */
    pos: number;
    raf: number;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  const stopGlide = () => {
    const g = glide.current;
    if (!g) return false;
    cancelAnimationFrame(g.raf);
    clearTimeout(g.timer);
    glide.current = null;
    return true;
  };

  /**
   * Once nothing is moving the page any more (no finger down, no drag, no
   * slide, no page turn landing), lay out a pairing that changed meanwhile.
   * Asked after letting go, and again every 120ms until the page is at rest.
   */
  const fingerDown = useRef(false);
  const stillAgain = () => {
    if (fingerDown.current || drag.current || glide.current || landing.current) {
      setTimeout(stillAgain, 120);
      return;
    }
    moving.current = false;
    if (deferredLayout.current) {
      deferredLayout.current = false;
      setRelayout((n) => n + 1);
    }
  };

  const startGlide = (velocity: number) => {
    stopGlide();
    if (Math.abs(velocity) < STOP_SPEED) return;
    // Not for somebody who has asked the system for less motion.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    const frame = () => {
      const g = glide.current;
      if (!g) return;
      cancelAnimationFrame(g.raf);
      clearTimeout(g.timer);
      const now = performance.now();
      const step = glideStep(g.velocity, Math.min(now - g.at, 100));
      /*
       * The position is kept here, to the fraction, and only handed to the
       * browser — never read back from it. The browser keeps a scroll position
       * in whole device pixels, so reading it back each frame threw the fraction
       * away: a slow slide moving 0.4px a frame went nowhere at all, and one
       * moving 1.6px went 1 or 2 by turns. That was the hitch at low speeds.
       *
       * Unless something else moved the page meanwhile — a page loading above,
       * the reader putting your place back — in which case the slide carries on
       * from where the page actually is.
       */
      if (Math.abs(window.scrollY - g.pos) > 2) g.pos = window.scrollY;
      g.pos += step.distance;
      window.scrollTo(0, g.pos);
      const max = document.documentElement.scrollHeight - window.innerHeight;
      // Over when it has slowed to nothing, or run into the top or the bottom.
      const blocked = (step.distance < 0 && window.scrollY <= 0) || (step.distance > 0 && window.scrollY >= max - 1);
      if (Math.abs(step.velocity) < STOP_SPEED || blocked) {
        glide.current = null;
        return;
      }
      g.velocity = step.velocity;
      g.at = now;
      g.raf = requestAnimationFrame(frame);
      g.timer = setTimeout(frame, 34);
    };

    glide.current = {
      velocity,
      at: performance.now(),
      pos: window.scrollY,
      raf: requestAnimationFrame(frame),
      timer: setTimeout(frame, 34),
    };
  };

  /**
   * Pages mode's slide after letting go (`settle.ts`): from the speed it was
   * let go at to rest on the middle of a page, the friction made to fit. In
   * the same `glide` slot as the strip's slide, so everything that stops one
   * (a press, a wheel, a key) stops this, and the pull leaves it alone.
   */
  const settleFrom = (velocity: number) => {
    stopGlide();
    const all = sheetEls();
    if (all.length === 0) return;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const stops = all.map(centred);
    // The end of the chapter, with its Next, is somewhere to stop too.
    const end = document.querySelector('.manga-reader-end');
    if (end) stops.push(window.scrollY + end.getBoundingClientRect().bottom - window.innerHeight);
    const from = window.scrollY;
    const to = settleTarget(stops, from, velocity, max);
    if (to === null || Math.abs(to - from) <= SETTLED_PX) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      window.scrollTo(0, to);
      return;
    }
    const plan = settlePlan(from, to, velocity);
    const started = performance.now();
    const frame = () => {
      const g = glide.current;
      if (!g) return;
      cancelAnimationFrame(g.raf);
      clearTimeout(g.timer);
      const t = performance.now() - started;
      window.scrollTo(0, plan.at(t));
      if (t >= plan.duration) {
        glide.current = null;
        return;
      }
      g.raf = requestAnimationFrame(frame);
      g.timer = setTimeout(frame, 34);
    };
    glide.current = { velocity, at: started, pos: from, raf: requestAnimationFrame(frame), timer: setTimeout(frame, 34) };
  };

  /** The click a finger's drag may be followed by is not a tap on the page. Cleared after, in case none comes. */
  const swallowTap = () => {
    dragged.current = true;
    setTimeout(() => (dragged.current = false), 500);
  };

  /** A sideways drag turns a sheet on or back from `from`, as a book's page does. */
  const turnByDrag = (dx: number, from: number) => {
    const goal = turnSheet((dx > 0) === settings.current.prefs.rightToLeft ? 1 : -1, from, true);
    // Landed by hand if the slide has not got there: a smooth scroll is not run at all in a window that is not drawing.
    if (landing.current) clearTimeout(landing.current);
    landing.current = setTimeout(() => {
      landing.current = null;
      if (goal !== null && Math.abs(window.scrollY - goal) > 2) window.scrollTo(0, goal);
    }, 450);
  };

  /*
   * Pages mode takes the finger's scrolling over, which nothing else here
   * does: the browser's own momentum cannot be told where to stop, and
   * stopping on a page is the whole of what was asked. The page follows the
   * finger, and letting go hands its speed to `settleFrom`. A sideways swipe
   * turns a page. Two fingers, a page zoomed in, or a touch on the controls
   * are left to the browser. Every move is cancelled (non-passive), since iOS
   * scrolls the page natively unless the very first move is.
   */
  useEffect(() => {
    if (!pagesMode) return;
    let t: { x: number; y: number; last: number; carry: number; axis: 'x' | 'y' | null; sheet: number; samples: DragSample[] } | null = null;
    const start = (e: TouchEvent) => {
      t = null;
      if (e.touches.length !== 1) return;
      if ((e.target as HTMLElement | null)?.closest?.('.manga-reader-chrome, .manga-reader-settings, button, a, input, select, textarea')) return;
      if ((window.visualViewport?.scale ?? 1) > 1.01) return;
      const p = e.touches[0];
      t = { x: p.clientX, y: p.clientY, last: p.clientY, carry: 0, axis: null, sheet: sheetAt(), samples: [{ t: e.timeStamp, y: p.clientY }] };
      // Touching stops a slide, as on a phone, and holds the pairing still until the page is at rest again.
      stopGlide();
      fingerDown.current = true;
      moving.current = true;
    };
    const move = (e: TouchEvent) => {
      if (!t) return;
      if (e.touches.length !== 1) {
        t = null;
        return;
      }
      e.preventDefault();
      const p = e.touches[0];
      if (!t.axis) {
        const dx = p.clientX - t.x;
        const dy = p.clientY - t.y;
        if (Math.hypot(dx, dy) < 6) return;
        t.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      }
      if (t.axis === 'y') {
        // By the distance since the last move, keeping the part of a pixel the browser could not take (as `dragMove`).
        const want = t.last - p.clientY + t.carry;
        const before = window.scrollY;
        window.scrollTo(0, before + want);
        t.carry = Math.max(-1, Math.min(1, want - (window.scrollY - before)));
      }
      t.last = p.clientY;
      // When the finger was there, not when this ran: a busy frame would otherwise read as a sudden change of speed.
      const now = e.timeStamp;
      t.samples.push({ t: now, y: p.clientY });
      while (t.samples.length > 2 && now - t.samples[0].t > 200) t.samples.shift();
    };
    const end = (e: TouchEvent) => {
      const g = t;
      if (!g || e.touches.length > 0) return;
      t = null;
      fingerDown.current = false;
      if (!g.axis) {
        // A tap: the click goes through.
        stillAgain();
        return;
      }
      swallowTap();
      const p = e.changedTouches[0];
      if (g.axis === 'x' && e.type === 'touchend' && p && Math.abs(p.clientX - g.x) > 40) turnByDrag(p.clientX - g.x, g.sheet);
      else settleFrom(g.axis === 'y' && e.type === 'touchend' ? releaseVelocity(g.samples, e.timeStamp) : 0);
      stillAgain();
    };
    window.addEventListener('touchstart', start, { passive: true });
    window.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('touchend', end);
    window.addEventListener('touchcancel', end);
    return () => {
      window.removeEventListener('touchstart', start);
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', end);
      window.removeEventListener('touchcancel', end);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagesMode]);

  // A wheel or a key takes over from a slide, as touching the screen does.
  useEffect(() => {
    const stop = () => void stopGlide();
    window.addEventListener('wheel', stop, { passive: true });
    window.addEventListener('keydown', stop);
    return () => {
      window.removeEventListener('wheel', stop);
      window.removeEventListener('keydown', stop);
      stopGlide();
    };
  }, []);

  /**
   * Pages mode's pull, for scrolling this reader does not drive itself (a
   * wheel, the scrollbar): once the screen has stopped (no scroll for
   * `MAGNET_WAIT_MS`, no finger down, no drag or slide or jump under way), a
   * sheet whose middle is near the middle of the screen is slid the rest of
   * the way. See `magnet.ts`. A finger or a mouse drag lands on a page by
   * itself (`settleFrom`), so this finds nothing to do after one.
   */
  useEffect(() => {
    if (!pagesMode) return;
    let touches = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastY = window.scrollY;
    let heading: 1 | -1 | 0 = 0;
    const settle = () => {
      timer = null;
      if (touches > 0 || drag.current || glide.current || returning.current || landing.current) return;
      const all = sheetEls();
      if (all.length === 0) return;
      const screen = window.innerHeight;
      const spots: MagnetSpot[] = all.map((el) => ({ at: centred(el), reach: reachFor(el.getBoundingClientRect().height, screen) }));
      const to = magnetTarget(spots, window.scrollY, document.documentElement.scrollHeight - screen, heading);
      if (to === null) return;
      const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      window.scrollTo({ top: to, behavior: still ? 'auto' : 'smooth' });
      // Finished by hand if the slide has not got there and nobody has touched the screen since: a smooth scroll sometimes does not run at all in a window that is not drawing.
      const touchedAt = lastTouch.current;
      setTimeout(() => {
        if (lastTouch.current === touchedAt && pagesRef.current && touches === 0 && Math.abs(window.scrollY - to) > SETTLED_PX) window.scrollTo(0, to);
      }, 700);
    };
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(settle, MAGNET_WAIT_MS);
    };
    const onScroll = () => {
      const y = window.scrollY;
      if (y !== lastY) heading = y > lastY ? 1 : -1;
      lastY = y;
      soon();
    };
    const onTouch = (e: TouchEvent) => {
      touches = e.touches.length;
      if (touches > 0) {
        if (timer) clearTimeout(timer);
        timer = null;
      } else soon();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    for (const t of ['touchstart', 'touchend', 'touchcancel'] as const) window.addEventListener(t, onTouch, { passive: true });
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('scroll', onScroll);
      for (const t of ['touchstart', 'touchend', 'touchcancel'] as const) window.removeEventListener(t, onTouch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagesMode]);

  const dragStart = (e: React.PointerEvent) => {
    /*
     * Pressing again stops a slide dead, wherever it is pressed — which is how a
     * phone works, and the way to stop at the page you were reaching for. The
     * click that follows is not also a tap on the page, or catching a slide
     * would flash the controls up every time.
     */
    const caught = stopGlide();
    // A finger catching a slide: its click is not a tap either (touch is handled by the effect above).
    if (caught && e.pointerType !== 'mouse') swallowTap();
    if (!prefs.dragToScroll || e.pointerType !== 'mouse' || e.button !== 0) return;
    // Not from the controls: a drag that begins on a button is somebody missing
    // the button, and scrolling the page under them is the wrong apology.
    if ((e.target as HTMLElement).closest('.manga-reader-chrome, button, a, input')) return;
    if (caught) dragged.current = true;
    moving.current = true;
    drag.current = {
      y: e.clientY,
      last: e.clientY,
      x: e.clientX,
      sheet: pagesRef.current ? sheetAt() : 0,
      carry: 0,
      moved: false,
      samples: [{ t: performance.now(), y: e.clientY }],
    };
  };

  const dragMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dy = e.clientY - d.y;
    // A few pixels of slop, so a click with a twitch in it is still a click.
    if (!d.moved && Math.abs(dy) < 4 && Math.abs(e.clientX - d.x) < 4) return;
    if (!d.moved) {
      d.moved = true;
      // Only once it is a drag: taken on pointerdown it would eat every click.
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    /*
     * Up drags the page up, which is how every hand tool works — by the distance
     * since the last move, not to a place worked out at the press.
     *
     * The first version scrolled to "where the page was, less how far you have
     * dragged", and a page loading above undid it. The browser keeps your place
     * when a page above you grows, by scrolling down by as much; the next move
     * then put the page back where the arithmetic said, so it lurched by a whole
     * page's height mid-drag. Moving by the difference leaves the browser's
     * correction alone.
     *
     * `carry` keeps the fraction of a pixel the browser could not scroll by,
     * for the reason the slide keeps its own position: on a scaled screen the
     * pointer moves in fractions and the page in whole pixels.
     */
    const want = d.last - e.clientY + d.carry;
    d.last = e.clientY;
    const before = window.scrollY;
    window.scrollTo(0, before + want);
    d.carry = Math.max(-1, Math.min(1, want - (window.scrollY - before)));
    const now = performance.now();
    d.samples.push({ t: now, y: e.clientY });
    // Only the last stretch is ever read, so the rest is let go.
    while (d.samples.length > 2 && now - d.samples[0].t > 200) d.samples.shift();
  };

  const dragEnd = (e: React.PointerEvent) => {
    const d = drag.current;
    // Kept true if pressing caught a slide, so that click is swallowed too.
    dragged.current = dragged.current || d?.moved === true;
    drag.current = null;
    if (d?.moved && pagesRef.current) {
      /*
       * Pages mode: a sideways drag turns the page, as a book's does
       * (rightwards for on when reading right to left). An up-and-down one
       * slides on from the speed it was let go at and comes to rest on the
       * middle of a page (`settleFrom`), as a finger's does.
       */
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) turnByDrag(dx, d.sheet);
      else settleFrom(e.type === 'pointerup' ? releaseVelocity(d.samples, performance.now()) : 0);
      stillAgain();
      return;
    }
    // Let go mid-drag and it carries on; a cancelled pointer just stops.
    if (d?.moved && e.type === 'pointerup') startGlide(releaseVelocity(d.samples, performance.now()));
    if (d) stillAgain();
  };
  const [shown, setShown] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Not while the next chapter arrives below one carried on from: there is still reading on screen.
  const held = problem !== null || (total === null && behind.length === 0);
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
    // Carrying on is one long read, so a new chapter arriving below does not bring the controls up.
    if (!held && behind.length === 0) wake('open');
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const changePrefs = (change: Partial<typeof prefs>) => {
    if (
      (change.width !== undefined && change.width !== prefs.width) ||
      (change.pagesZoom !== undefined && change.pagesZoom !== prefs.pagesZoom) ||
      (change.rightToLeft !== undefined && change.rightToLeft !== prefs.rightToLeft) ||
      change.autoMode !== undefined
    )
      anchor.current = where();
    setPrefs(change);
  };
  /*
   * The same when the sheets are paired differently (a wide page found, the
   * pairs shifted) or the mode changes: the place is put back after, from the
   * one taken just before when there was one, else the last one measured.
   */
  const firstLayout = useRef(true);
  useLayoutEffect(() => {
    if (firstLayout.current) {
      firstLayout.current = false;
      return;
    }
    if (returning.current) {
      if (returnTo()) arrived();
      return;
    }
    const measured = lastPlace.current?.chapter === undefined || lastPlace.current.chapter === chapter.id ? lastPlace.current : null;
    const place = anchor.current ?? measured;
    anchor.current = null;
    if (!place) return;
    const y = placeY(place.page, place.offset);
    if (y !== null) window.scrollTo(0, Math.max(0, y));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.width, prefs.pagesZoom, layoutSig]);

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
  /*
   * The offer of another source sits in one slot only, the first page that is
   * slow or has failed, so a chapter with three bad pages does not show it
   * three times.
   */
  const troubled = [...failed, ...slow].filter((i) => !urls[i]);
  const firstTroubled = troubled.length > 0 ? Math.min(...troubled) : -1;
  const elsewhereControl = (index: number) => {
    if (index !== firstTroubled || !seriesId || !onElsewhere) return null;
    if (!elsewhere) {
      return (
        <button className="btn" onClick={() => void findElsewhere()}>
          Read this chapter from another source
        </button>
      );
    }
    if (elsewhere.state === 'looking') {
      return <span className="meta">Looking for chapter {chapter.number} on your other sources… this can take a little while.</span>;
    }
    if (elsewhere.state === 'failed') {
      return (
        <>
          <span className="meta">Could not look: {elsewhere.message}</span>
          <button className="btn" onClick={() => void findElsewhere()}>
            Look again
          </button>
        </>
      );
    }
    if (elsewhere.options.length === 0) {
      return (
        <span className="meta">
          {elsewhere.searched === 0
            ? 'None of your other sources has this series under the same name.'
            : `None of the ${elsewhere.searched} other source${elsewhere.searched === 1 ? '' : 's'} with this series lists chapter ${chapter.number}.`}
        </span>
      );
    }
    return (
      <>
        <span className="meta">Chapter {chapter.number} is also on:</span>
        {elsewhere.options.map((o) => (
          <button key={`${o.sourceName}:${o.chapterId}`} className="btn" onClick={() => onElsewhere(o)}>
            {o.sourceName}
          </button>
        ))}
        <span className="meta">Pages are split differently there, so it opens the whole chapter from the top. It still counts as read here.</span>
      </>
    );
  };
  const thumbs = useThumbnails(urls, visible, page, chapter.id);

  const notices = (
    <>
      {problem && <p className="banner">{problem}</p>}
      {total === null && !problem && <p className="empty">Asking the source for this chapter…</p>}
    </>
  );

  /** One page, whatever state it is in. Each carries `data-page`, which is what counts as a page. */
  /*
   * In pages mode a page has its shape before its picture comes (2026-11-12).
   * An `<img>` not loaded yet has no size, and pages load as you come near
   * them, so on a phone most of a chapter's sheets were flat: a hop from the
   * bar worked out where page 15 was over flat pages, everything moved as they
   * filled, and anything past the last one drawn landed on the same page (the
   * end of what had loaded). Reported as Next landing on page 26 of 29 and
   * every hop but page 1 going there too, and reproduced at phone size: sheets
   * 17 to 31 were 0px tall. So each page is the screen's height, at its own
   * width once it has been read (`aspects`) and the chapter's typical shape
   * before, narrowed to fit as a drawn one is: the same box a drawn page has.
   */
  const pageShape = (index: number, half: boolean): React.CSSProperties => {
    const ratio = aspects[index] ?? typicalAspect(aspects);
    return { aspectRatio: String(ratio), width: `min(${half ? 50 : 100}%, calc(var(--fit) * ${ratio}))`, height: 'auto' };
  };
  /*
   * Part of a taller picture, cut out: a box of the part's shape that hides
   * the rest, with the whole picture inside it pinned to the top or the
   * bottom. A box rather than `object-fit` on the `<img>` itself, which was the
   * first version and, on an iPhone, drew the whole picture at its own shape:
   * the last page with the credits under it, the page beside it shrunk to
   * match. A plain box that hides its overflow is drawn the same everywhere.
   */
  const cropped = (url: string, keep: 'top' | 'bottom', box: React.CSSProperties, img: React.ImgHTMLAttributes<HTMLImageElement>, attrs: Record<string, unknown> = {}) => (
    <div {...attrs} className="manga-page-crop" style={box}>
      <img {...img} src={url} draggable={false} decoding="async" style={keep === 'top' ? { top: 0 } : { bottom: 0 }} />
    </div>
  );
  /*
   * The rest of an image with a page stacked in it, on a sheet of its own: the
   * group's notice before the first page, their credits after the last. Kept,
   * not cut off (asked for, 2026-11-12: people want to know who translated a
   * chapter). Not a page: no `data-page`, so the counter, the jumps and the
   * end of the chapter go by the pages as before.
   */
  const creditSheet = (index: number) => {
    const st = stacked[index];
    const url = urls[index];
    const info = infos[index];
    if (!st || !url || !info || st.share > 0.9) return null;
    const ratio = info.aspect / (1 - st.share);
    return (
      <div key={`credits-${index}`} className="manga-sheet manga-sheet-credits">
        {/* The part the page is not: below a page kept at the top, above one kept at the bottom. */}
        {cropped(
          url,
          st.keep === 'top' ? 'bottom' : 'top',
          { aspectRatio: String(ratio), width: `min(100%, calc(var(--fit) * ${ratio}))` },
          { alt: "The scanlation group's notice and credits" }
        )}
      </div>
    );
  };
  const renderPage = (index: number, _at?: number, sheet?: readonly number[]) => {
    const url = urls[index];
    // Pages mode, a page with the group's notice or credits stacked onto it: the page, cut out (`creditSheet` has the rest).
    const st = pagesMode ? stacked[index] : null;
    if (url && st)
      return (
        <Fragment key={index}>
          {cropped(
            url,
            st.keep,
            pageShape(index, (sheet?.length ?? 1) === 2),
            {
              alt: `Page ${index + 1}`,
              loading: index <= eagerTo ? 'eager' : 'lazy',
              onLoad: () => {
                if (returning.current && returnTo()) arrived();
              },
            },
            { 'data-page': index }
          )}
        </Fragment>
      );
    return url ? (
      <img
        key={index}
        data-page={index}
        src={url}
        style={pagesMode ? pageShape(index, (sheet?.length ?? 1) === 2) : undefined}
        alt={`Page ${index + 1}`}
        /*
         * Or the browser drags the picture instead of scrolling.
         *
         * An `<img>` is draggable by default, and that native drag starts
         * on mousedown and swallows everything after it — so pressing on
         * a page and moving gave a ghost of the image on the cursor and no
         * scrolling at all, while pressing on the margin beside it worked.
         * `user-select: none` does not cover this; image dragging is its
         * own mechanism and needs its own refusal.
         *
         * Both halves: the attribute is what Chrome and Firefox read,
         * `-webkit-user-drag` in the stylesheet is what WebKit reads, and
         * the reader is used on an iPhone.
         */
        draggable={false}
        /*
         * Decoded off the main thread. A strip can be 800×15000 — 48MB once
         * decoded — and decoding one as it scrolled into view held up the
         * page for that long, which showed as the drag catching while
         * pages loaded. Async lets the browser draw the frame first and
         * the picture when it is ready.
         */
        decoding="async"
        // Lazy pages above a place being returned or jumped to would load
        // only as they scroll into view, pushing it down afterwards — so up
        // to there they load now, and the move can finish.
        loading={index <= eagerTo ? 'eager' : 'lazy'}
        onLoad={() => {
          if (returning.current && returnTo()) arrived();
        }}
      />
    ) : failed.has(index) ? (
      // One element per page, whatever is inside it: pages are counted by
      // `data-page`, by the counter and by every jump.
      <div key={index} data-page={index} className="manga-page-waiting manga-page-failed">
        <button className="manga-page-retry" onClick={() => void retryPage(index)} disabled={retrying.has(index)}>
          {retrying.has(index) ? `Page ${index + 1} — fetching…` : `Page ${index + 1} did not load — tap to try again`}
        </button>
        {failed.size > 1 && (
          <button className="btn" onClick={() => void retryAll()} disabled={retrying.size > 0}>
            Try all {failed.size} again
          </button>
        )}
        {elsewhereControl(index)}
      </div>
    ) : slow.has(index) ? (
      <div key={index} data-page={index} className="manga-page-waiting manga-page-failed">
        <span>Page {index + 1} is taking a while: the site is slow to send it. Still trying…</span>
        {/*
          Asking again now, past any saved copy, alongside the request
          still waiting: whichever answers first fills the page.
        */}
        <button className="btn" onClick={() => void retryPage(index)} disabled={retrying.has(index)}>
          {retrying.has(index) ? 'Asking again…' : 'Try again now'}
        </button>
        {elsewhereControl(index)}
      </div>
    ) : (
      <div key={index} data-page={index} className="manga-page-waiting">
        {index + 1}
      </div>
    );
  };

  /** What the counter says: a page, or both pages of a sheet of two. */
  const pageLabel = sheetNow && sheetNow.length === 2 ? `${sheetNow[0] + 1}–${sheetNow[1] + 1}` : `${page + 1}`;
  /** Whether Next would finish this chapter: at its end, on its last page, or on its last sheet. */
  const willFinish = atEnd || (total !== null && (page >= total - 1 || (sheetNow?.includes(total - 1) ?? false)));

  // Keep the current page's thumbnail in view — centred, as the old app did.
  const thumbBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = thumbBox.current;
    const current = box?.children[page] as HTMLElement | undefined;
    if (!box || !current || !visible) return;
    box.scrollLeft = current.offsetLeft - box.clientWidth / 2 + current.offsetWidth / 2;
  }, [page, visible, total]);

  return createPortal(
    <div
      className={[
        'manga-reader',
        visible ? '' : 'chrome-off',
        prefs.scrollbar ? '' : 'no-scrollbar',
        prefs.dragToScroll ? 'draggable' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      ref={top}
      onClick={(e) => {
        // The click that ends a drag is not a tap — see `dragEnd`.
        if (dragged.current) {
          dragged.current = false;
          return;
        }
        onTap(e);
      }}
      onPointerDown={dragStart}
      onPointerMove={dragMove}
      onPointerUp={dragEnd}
      onPointerCancel={dragEnd}
    >
      <div
        className="manga-reader-chrome top"
        onPointerDown={touched}
        onKeyDown={touched}
        onFocusCapture={touched}
      >
        <button className="btn subtle manga-reader-back" onClick={close}>
          ‹ {backLabel}
        </button>
        <span className="manga-reader-title" title={chapter.name}>
          {chapterText(viewing?.number ?? chapter.number)}
          {!viewing && total !== null && count < total && (
            <span className="meta">
              {count} of {total} loaded
            </span>
          )}
          {ahead && <span className="meta manga-reader-ahead">{ahead}</span>}
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

      {settingsOpen && visible && (
        <ReaderSettings
          prefs={prefs}
          onChange={changePrefs}
          mode={viewMode}
          onMode={pickMode}
          detected={prefs.autoMode ? detected : null}
          onShift={twoUp ? shiftPairs : undefined}
          onShiftHere={twoUp && sheetIndex > firstBookSheet && firstBookSheet >= 0 ? shiftHere : undefined}
          shiftedHere={shiftedHere}
          twoUp={twoUp}
          shifted={shifted}
          missing={total === null ? 0 : urls.filter((u) => !u).length}
          reloading={reloading}
          onReload={total === null ? undefined : () => void reloadPages()}
          above={behind.length}
          onClearAbove={clearAbove}
        />
      )}

      {/*
        * Dimming is a veil over the pages, below the controls — the screen's
        * own brightness is not something a web app can reach.
        */}
      {prefs.brightness < 1 && (
        <div className="manga-reader-dim" style={{ opacity: 1 - prefs.brightness }} aria-hidden="true" />
      )}

      {behind.length === 0 && notices}

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

      {/*
        * One keyed list, the chapters carried on from and then this one, so the
        * chapter just finished keeps its pictures (the same elements) when it
        * moves from being this one to being above it — a remount would decode
        * every page again, and blank them while it did.
        */}
      {[
        ...behind.map((c) => (
          <div
            key={c.id}
            className="manga-strip manga-strip-before"
            data-chapter-block={c.id}
            data-chapter-number={c.number}
            style={{ '--page-width': `${prefs.width}%` } as React.CSSProperties}
          >
            {/* In the slot the notices take in the chapter being read, so the pages below keep their places and are not drawn again. */}
            {null}
            {c.urls.map((url, index) => {
              const shape = c.shapes[index] ? { aspectRatio: String(c.shapes[index]) } : undefined;
              return url ? (
                <img key={index} src={url} style={shape} alt={`Page ${index + 1}`} draggable={false} decoding="async" />
              ) : shape ? (
                <div key={index} className="manga-page-rest" style={shape} />
              ) : (
                <div key={index} className="manga-page-waiting">
                  {index + 1}
                </div>
              );
            })}
            <p className="meta manga-chapter-break">End of chapter {chapterText(c.number)}</p>
          </div>
        )),
        <div
          key={chapter.id}
          className={`manga-strip${pagesMode ? ' paged' : ''}`}
          ref={strip}
          data-chapter-block={chapter.id}
          style={{ '--page-width': `${prefs.width}%`, '--pages-zoom': prefs.pagesZoom / 100 } as React.CSSProperties}
        >
          {behind.length > 0 && notices}
          {sheets
            ? sheets.flatMap((sheet) => [
                // The group's part of an image with a page in it: above that page's sheet when the page is its bottom, below when its top (`stackedPages`).
                ...sheet.filter((i) => stacked[i]?.keep === 'bottom').map(creditSheet),
                <div
                  key={sheet.join('+')}
                  className={`manga-sheet${sheet.length === 2 ? ' two' : ''}${prefs.rightToLeft ? ' rtl' : ''}`}
                >
                  {sheet.map(renderPage)}
                </div>,
                ...sheet.filter((i) => stacked[i]?.keep === 'top').map(creditSheet),
              ])
            : urls.map((_, index) => renderPage(index))}
        </div>,
      ]}

      {total !== null && (
        <div className="row between manga-reader-end">
          <button className="btn subtle" onClick={close}>
            ‹ {backLabel}
          </button>
          {/*
            * Marking read is a button rather than something inferred from
            * scrolling to the bottom. Scroll detection guesses, and guessing
            * wrong here either loses your place or marks something you skimmed
            * past as finished.
            */}
          {/*
            * On the newest chapter there is no next one, and the button said
            * so only by where it took you. It says it now, in its own colour,
            * so reaching the end of what exists reads as an arrival rather
            * than as the reader dropping you on the list.
            */}
          <button
            className={hasNext ? 'btn primary' : 'btn manga-last-chapter'}
            onClick={() => {
              // In Endless, the same as the arrow: carry on into the next and go down to it.
              if (hasNext) return goNext(true);
              onFinished(chapter.number);
            }}
          >
            {hasNext
              ? preview
                ? 'Next chapter'
                : 'Finished — next chapter'
              : (lastLabel ?? (preview ? 'Last chapter — back' : 'Last chapter finished ✓'))}
          </button>
          {/*
            * The second destination, and only when there is one — see
            * `skipTarget`. It sits beside the ordinary button rather than
            * replacing it, because which is right depends on something only
            * you can see: whether this chapter was a compilation of the point
            * chapters after it, or whether those come next.
            */}
          {onSkip && skipTo !== null && (
            <button
              className="btn subtle"
              onClick={() => onSkip(true)}
              title={preview ? undefined : `Marks everything up to ${skipTo} read`}
            >
              {preview ? `Skip to ${skipTo}` : `Finished — skip to ${skipTo}`}
            </button>
          )}
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
              aria-label="Previous chapter"
              title="Previous chapter"
              disabled={!onGo || (!hasPrevious && behind.length === 0)}
              onClick={goPrevious}
            >
              <Icon.previous />
            </button>
            <span className="manga-reader-count">
              {viewing ? `${viewing.page + 1} / ${viewing.pages}` : `${pageLabel} / ${total}`}
            </span>
            {/*
              * The skip sits *before* Next, and the group is pinned to the
              * right — which is what lets Next never move without reserving
              * anything.
              *
              * It was the other way round, with the skip after Next and always
              * rendered so the room was held open: Next stayed put, and every
              * chapter without a skip showed 48px of reserved nothing at the
              * end of the bar. Reported from the PC after the counter was
              * reported from the phone, which is twice that this one button
              * has pushed the bar around.
              *
              * Right-aligned in a `1fr` track, the group grows *leftwards* into
              * slack the bar already has. So Next is flush right whether or not
              * a skip is there, nothing is reserved, and the counter stays in
              * the middle because the track boundary has not moved.
              */}
            <div className="manga-reader-next">
              {/*
                * Labelled with the number rather than given an icon of its own.
                * "Skip" is meaningless without saying where to, and a second
                * arrow-like glyph beside the first is the one thing guaranteed
                * to be mistaken for it.
                */}
              {onSkip && skipTo !== null && (
                <button
                  className="manga-reader-skip"
                  aria-label={`Skip to chapter ${skipTo}`}
                  title={`Skip to chapter ${skipTo}, past the point chapters`}
                  onClick={() => onSkip(willFinish || finishedNow())}
                >
                  {skipTo}
                </button>
              )}
              {/*
                * At the end this is finishing; from anywhere else, skipping —
                * and it says which, because the difference is whether the
                * chapter is marked read. In the accent once it will finish it,
                * so a Next that would skip a chapter you think you read is
                * visibly the plain one.
                */}
              <button
                className={`manga-reader-arrow${willFinish && !viewing ? ' finishing' : ''}`}
                aria-label={viewing ? 'Next chapter' : willFinish ? 'Finish, and next chapter' : 'Next chapter, without marking this one read'}
                title={viewing ? 'Next chapter' : willFinish ? 'Finished — next chapter' : 'Next chapter (not marked read)'}
                disabled={!onGo || (!hasNext && !viewing)}
                onClick={() => goNext(!viewing && (willFinish || finishedNow()))}
              >
                <Icon.next />
              </button>
            </div>
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
      {!visible && total !== null && <ReaderStatus
          text={
            viewing ? `${chapterText(viewing.number)}  ${viewing.page + 1}/${viewing.pages}` : `${chapterText(chapter.number)}  ${pageLabel}/${total}`
          }
        />}
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
    const blob = await (await fetch(url)).blob();
    const canvas = document.createElement('canvas');
    canvas.width = THUMB_W * 2;
    canvas.height = THUMB_H * 2;
    /*
     * Decoded straight to thumbnail size where the browser can, so a 48MB strip
     * never exists as a bitmap just to be shrunk, and the work happens off the
     * main thread rather than in the middle of somebody dragging the page. A
     * browser without the resize options decodes it whole, as before.
     */
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(blob, { resizeWidth: canvas.width, resizeHeight: canvas.height, resizeQuality: 'low' });
    } catch {
      bitmap = await createImageBitmap(blob);
    }
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const small = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/jpeg', 0.7));
    return small ? URL.createObjectURL(small) : null;
  } catch {
    return null;
  }
}
