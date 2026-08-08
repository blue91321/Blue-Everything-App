/**
 * The one popup, shared by everything that has something to say.
 *
 * ### Why this is core and why there is only one
 *
 * The overlay was built for voice and lived inside it, which meant nudges — the
 * thing this whole app exists to deliver — could not use the only surface here
 * that reliably draws **above an exclusive-fullscreen game**. A Windows toast
 * raised the instant a match ends is a toast you may never see, which is a poor
 * result for an engine whose entire job is picking that moment.
 *
 * One instance, because there is one screen and one person looking at it. Two
 * owners would eventually both be visible, or would fight over the hide timer
 * and leave a window up forever. So the lifecycle — lazy creation, the timer,
 * the failure path — lives here once instead of being repeated by every caller.
 *
 * ### Failing to draw is never fatal
 *
 * A session with no desktop has no window station to create a window on, and
 * that is not a reason to stop delivering nudges or listening for commands.
 * Every entry point here degrades to "no popup" and says so once.
 */
import {
  createOverlay,
  forgetAvatar,
  type Avatar,
  type Overlay,
  type OverlayContent,
  type OverlayPlacement,
} from './overlay.js';
import { playSound, type SoundName } from './sound.js';

/** How long a result stays up. Long enough to read, short enough not to nag. */
export const POPUP_RESULT_MS = 4000;
/** A question waits longer, because it is waiting on you rather than telling you. */
export const POPUP_ASK_MS = 12_000;

export interface PopupOptions extends OverlayContent {
  /** How long to leave it up. 0 keeps it there until something replaces it. */
  forMs?: number;
  /** Played as it appears. Omit for silence. */
  sound?: SoundName;
}

let overlay: Overlay | null = null;
let failed = false;
let hideTimer: NodeJS.Timeout | null = null;
let onChoice: (id: string) => void = () => {};
let onDismiss: () => void = () => {};
let log: (message: string) => void = () => {};

/**
 * Create it up front rather than on first use.
 *
 * Cheap — measured at ~3ms — and the alternative is paying it at the exact
 * moment someone is waiting to see whether the wake word worked. `voice-latency`
 * exists to keep that honest.
 */
export function startPopups(handlers: {
  onChoice?: (id: string) => void;
  onDismiss?: () => void;
  log?: (message: string) => void;
}): void {
  onChoice = handlers.onChoice ?? onChoice;
  onDismiss = handlers.onDismiss ?? onDismiss;
  log = handlers.log ?? log;
  ui();
}

function ui(): Overlay | null {
  if (overlay || failed) return overlay;
  try {
    overlay = createOverlay({
      onChoice: (id) => onChoice(id),
      onDismiss: () => hide(0),
    });
  } catch (error) {
    failed = true;
    log(`popups unavailable: ${(error as Error).message}`);
  }
  return overlay;
}

export function show(options: PopupOptions): void {
  const { forMs = POPUP_RESULT_MS, sound, ...content } = options;

  // Before the window, so the sound lands with the appearance rather than after
  // it — the drawing is a millisecond but the ordering is free to get right.
  if (sound) playSound(sound);

  ui()?.show(content);
  hide(forMs);
}

/** `afterMs` of 0 hides immediately; anything else schedules it. */
export function hide(afterMs: number): void {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;

  if (afterMs <= 0) {
    overlay?.hide();
    return;
  }
  hideTimer = setTimeout(() => overlay?.hide(), afterMs);
  hideTimer.unref();
}

export function visible(): boolean {
  return overlay?.visible ?? false;
}

/** Where it appears and what face it wears. Applied on the next `show`. */
export function configure(next: { placement?: OverlayPlacement; avatar?: Avatar }): void {
  ui()?.configure(next);
}

/** Drop a cached image so a replaced avatar file is picked up. */
export { forgetAvatar };

/** What to do when a choice on the popup is clicked. Set by whoever offered it. */
export function onChoiceMade(handler: (id: string) => void): void {
  onChoice = handler;
}

export function onDismissed(handler: () => void): void {
  onDismiss = handler;
}

export function stopPopups(): void {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;
  overlay?.destroy();
  overlay = null;
}
