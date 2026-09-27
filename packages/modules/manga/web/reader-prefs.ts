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
  /** 40–100. The pages' width as a share of the screen's. */
  width: number;
  /** How long the controls stay up when a chapter opens; null for until you tap. */
  hideOnOpenMs: number | null;
  /** How long they stay up after a tap brings them back; null for until you tap again. */
  hideAfterTapMs: number | null;
}

export const DEFAULT_PREFS: ReaderPrefs = {
  brightness: 1,
  width: 100,
  hideOnOpenMs: 3500,
  hideAfterTapMs: 3500,
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
      hideOnOpenMs: 'hideOnOpenMs' in raw ? aChoice(raw.hideOnOpenMs, DEFAULT_PREFS.hideOnOpenMs) : DEFAULT_PREFS.hideOnOpenMs,
      hideAfterTapMs:
        'hideAfterTapMs' in raw ? aChoice(raw.hideAfterTapMs, DEFAULT_PREFS.hideAfterTapMs) : DEFAULT_PREFS.hideAfterTapMs,
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
