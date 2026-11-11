/**
 * How the reader looks and behaves, remembered per device.
 *
 * Per device rather than on the server beside the theme, because every one of
 * these is a fact about the screen in your hand: a page width that suits a
 * 3440px monitor is a postage stamp on a phone, dimming that suits reading in
 * bed is wrong at a desk, and controls that never hide are reasonable with a
 * mouse and in the way under a thumb. The theme is shared because picking a
 * colour on the phone and finding the PC unchanged reads as not having saved;
 * none of these has that property.
 *
 * Read back defensively: storage can be blocked, cleared, or hold a value from
 * an older build, and any of those should give the defaults rather than a
 * reader that will not open.
 */
import { useCallback, useState } from 'react';

export interface ReaderPrefs {
  /** 0.2–1. How bright the pages are drawn; 1 is untouched. */
  brightness: number;
  /** 40–100. The strip's width as a share of the screen's, in scroll mode. */
  width: number;
  /**
   * 40–100. In pages mode, the pages' size as a share of what fits the screen's
   * height. Its own number, because the two mean different things: a strip at
   * 60% of a wide monitor's width is a comfortable column, a page at 60% of the
   * height is a small page.
   */
  pagesZoom: number;
  /** How long the controls stay up when a chapter opens; null for until you tap. */
  hideOnOpenMs: number | null;
  /** How long they stay up after a tap brings them back; null for until you tap again. */
  hideAfterTapMs: number | null;
  /**
   * Show the page's scrollbar while reading.
   *
   * It was hidden outright, on the reasoning that a 15px strip down one side is
   * the last piece of browser left showing and the page counter already says
   * where you are. The counter says where you are; it is not something you can
   * *grab*, and a long chapter is exactly where you want to throw yourself two
   * thirds of the way down. So it is a choice now, and the default is to show
   * it — a scrollbar is what a page normally has, and its absence was the
   * surprise.
   *
   * Per device like the rest of this: a mouse has a scrollbar to drag and a
   * phone has never shown one anyway.
   */
  scrollbar: boolean;
  /**
   * Drag the page with the mouse to scroll it.
   *
   * Desktop only by nature — a finger already scrolls by dragging, and binding
   * this to touch would fight the browser for the same gesture.
   */
  dragToScroll: boolean;
  /**
   * One long strip (`scroll`, the default, for webtoons) or a page at a time
   * (`pages`, for manga printed as a book): a page to the screen, snapping to
   * each, and two side by side when the screen is wide enough for both.
   */
  mode: ReaderMode;
  /**
   * Switch between the two by itself, from what a chapter looks like: tall or
   * continuous slices are a strip, black-and-white pages are a book. Off by
   * default, so the reader only changes when you change it.
   */
  autoMode: boolean;
  /** In scroll mode, carry straight on into the next chapter below the end of this one. */
  infinite: boolean;
  /** In pages mode, read right to left, as Japanese manga is: the first page of a pair on the right. */
  rightToLeft: boolean;
  /**
   * In pages mode: one page at a time (the default), two side by side, or two
   * when the screen has room (`auto`). Stored as `spread`; it was `sideBySide`
   * with `auto` as the default for a day, and every save then wrote `auto`
   * whether chosen or not, so the old key is not read.
   */
  spread: 'auto' | 'one' | 'two';
}

export type ReaderMode = 'scroll' | 'pages';

export const DEFAULT_PREFS: ReaderPrefs = {
  brightness: 1,
  width: 100,
  pagesZoom: 100,
  hideOnOpenMs: 3500,
  hideAfterTapMs: 3500,
  scrollbar: true,
  dragToScroll: true,
  mode: 'scroll',
  autoMode: false,
  infinite: false,
  rightToLeft: true,
  spread: 'one',
};

export const BRIGHTNESS_MIN = 0.2;
export const WIDTH_MIN = 40;

/**
 * Named lengths rather than a slider — the refresh interval's call: these are a
 * handful of real answers, and 4.2 seconds is not a decision anybody makes.
 */
export const HIDE_CHOICES: Array<{ ms: number | null; label: string }> = [
  { ms: 2000, label: '2s' },
  { ms: 3500, label: '3½s' },
  { ms: 5000, label: '5s' },
  { ms: 10000, label: '10s' },
  { ms: null, label: 'Never' },
];

const KEY = 'manga.reader';

const inRange = (v: unknown, lo: number, hi: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

/** A stored length is taken only if it is one on offer, so a stray number cannot leave the controls up for an hour. */
const aChoice = (v: unknown, fallback: number | null) =>
  HIDE_CHOICES.some((c) => c.ms === v) ? (v as number | null) : fallback;

function load(): ReaderPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<keyof ReaderPrefs, unknown>>;
    return {
      brightness: inRange(raw.brightness, BRIGHTNESS_MIN, 1, DEFAULT_PREFS.brightness),
      width: inRange(raw.width, WIDTH_MIN, 100, DEFAULT_PREFS.width),
      pagesZoom: inRange(raw.pagesZoom, WIDTH_MIN, 100, DEFAULT_PREFS.pagesZoom),
      hideOnOpenMs: 'hideOnOpenMs' in raw ? aChoice(raw.hideOnOpenMs, DEFAULT_PREFS.hideOnOpenMs) : DEFAULT_PREFS.hideOnOpenMs,
      hideAfterTapMs:
        'hideAfterTapMs' in raw ? aChoice(raw.hideAfterTapMs, DEFAULT_PREFS.hideAfterTapMs) : DEFAULT_PREFS.hideAfterTapMs,
      // `!== false`, so a stored file from before these existed gets the default.
      scrollbar: raw.scrollbar !== false,
      dragToScroll: raw.dragToScroll !== false,
      mode: raw.mode === 'pages' ? 'pages' : 'scroll',
      autoMode: raw.autoMode === true,
      infinite: raw.infinite === true,
      rightToLeft: raw.rightToLeft !== false,
      spread: raw.spread === 'auto' || raw.spread === 'two' ? raw.spread : 'one',
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function useReaderPrefs(): [ReaderPrefs, (change: Partial<ReaderPrefs>) => void] {
  const [prefs, setPrefs] = useState(load);
  const change = useCallback((patch: Partial<ReaderPrefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Kept for this visit only.
      }
      return next;
    });
  }, []);
  return [prefs, change];
}

/**
 * What each series turned out to be, when the reader is switching by itself:
 * kept so its next chapter opens the right way at once rather than as a strip
 * that then turns into pages. Per device like the rest, and only the last 200.
 */
const FORMATS = 'manga.reader.formats';

function formats(): Record<string, ReaderMode> {
  try {
    const raw = JSON.parse(localStorage.getItem(FORMATS) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, ReaderMode] => e[1] === 'scroll' || e[1] === 'pages'));
  } catch {
    return {};
  }
}

export function rememberedFormat(series: string | undefined): ReaderMode | null {
  return series ? (formats()[series] ?? null) : null;
}

export function rememberFormat(series: string | undefined, mode: ReaderMode): void {
  if (!series) return;
  try {
    const all = formats();
    delete all[series];
    all[series] = mode;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete all[k];
    localStorage.setItem(FORMATS, JSON.stringify(all));
  } catch {
    // Remembered for this visit only.
  }
}
