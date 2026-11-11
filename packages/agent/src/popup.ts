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
 *
 * ### A question waits its turn and keeps its place (2026-11-04)
 *
 * `ask` puts up a popup with a box to type in, for a blueprint's "Ask me". It
 * is still the one popup, so the two cannot fight: something else shown while
 * a question is up covers it, and the question comes back when that goes, with
 * whatever had been typed; something shown while you are typing waits until
 * you have sent it. Questions asked together are asked one after another.
 */
import {
  createOverlay,
  forgetAvatar,
  type Avatar,
  type Overlay,
  type OverlayContent,
  type OverlayLine,
  type OverlayPlacement,
} from './overlay.js';
import { playSound, type SoundName } from './sound.js';

/** How long a result stays up. Long enough to read, short enough not to nag. */
export const POPUP_RESULT_MS = 4000;
/** A question waits longer, because it is waiting on you rather than telling you. */
export const POPUP_ASK_MS = 12_000;

export interface PopupOptions extends OverlayContent {
  /**
   * How long to leave it up.
   *
   * **0 means "until something replaces it"**, not "hide immediately" — the
   * opposite of what `hide(0)` means, which is exactly the collision that made
   * "Listening…" invisible. Used for states that end when something else
   * happens rather than on a clock.
   */
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
      // The ✕ on a question on screen is not answering it.
      onDismiss: () => (asking && !asking.covered ? finishAsk(null) : hide(0)),
      onSubmit: (text) => finishAsk(text),
      onCancel: () => finishAsk(null),
    });
  } catch (error) {
    failed = true;
    log(`popups unavailable: ${(error as Error).message}`);
  }
  return overlay;
}

export function show(options: PopupOptions): void {
  if (asking) {
    // Typing an answer: this waits until it is sent, rather than snatching the box away.
    if (overlay?.typing) {
      waiting.push(options);
      if (waiting.length > 5) waiting.shift();
      return;
    }
    // Otherwise it goes over the question, which comes back when it hides.
    if (!asking.covered) asking.text = overlay?.inputText() ?? asking.text;
    asking.covered = true;
  }
  showNow(options);
}

function showNow(options: PopupOptions): void {
  showing = options;
  const { forMs = POPUP_RESULT_MS, sound, ...content } = options;

  // Before the window, so the sound lands with the appearance rather than after
  // it — the drawing is a millisecond but the ordering is free to get right.
  if (sound) playSound(sound);

  ui()?.show(content);

  /*
   * Zero means "leave it up", and routing it through `hide` meant the opposite.
   *
   * `hide(0)` is "hide now" — that is what dismissing wants. `show({forMs: 0})`
   * is "stay until something replaces you", which is what "Listening…" needs,
   * because a timer there would take the window away while the microphone is
   * still open. The two met in this one line and the popup was drawn and then
   * hidden in the same frame: the wake sound played, nothing appeared, and the
   * first thing you actually saw was the *result* popup a second or two later.
   * The whole thing read as latency, when the wake had in fact been instant.
   *
   * So the two meanings no longer share a path. Any pending timer is still
   * cleared, or a previous popup's countdown would take this one down early.
   */
  if (forMs > 0) {
    hide(forMs);
  } else {
    clearHideTimer();
  }
}

/** `afterMs` of 0 hides immediately; anything else schedules it. */
export function hide(afterMs: number): void {
  clearHideTimer();

  if (afterMs <= 0) {
    hidden();
    return;
  }
  hideTimer = setTimeout(hidden, afterMs);
  hideTimer.unref();
}

/** It goes: and then what waited for it, or the question it covered, comes back. */
function hidden(): void {
  overlay?.hide();
  showing = null;
  const next = waiting.shift();
  if (next) {
    show(next);
    return;
  }
  if (asking?.covered) showAsk(asking);
}

/* --- Questions ---------------------------------------------------- */

export interface AskOptions {
  /** Says which question an answer or a cancel is about. */
  id: string;
  title: string;
  lines?: OverlayLine[];
  placeholder?: string;
  accent?: string;
  /** How long it waits for an answer before giving up. */
  forMs: number;
  sound?: SoundName;
}

interface Asking extends AskOptions {
  resolve: (answer: string | null) => void;
  text: string;
  /** Something else is on screen over it. */
  covered: boolean;
  timer: NodeJS.Timeout | null;
}

let asking: Asking | null = null;
const asks: Asking[] = [];
/** Popups that came while an answer was being typed, shown once it is sent. */
const waiting: PopupOptions[] = [];

/**
 * Ask something with a box to type in. Resolves with what was typed, or null
 * when it was given up on (Escape, the ✕, the time running out, `cancelAsk`).
 * The box does not take the keyboard until it is clicked.
 */
export function ask(options: AskOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const entry: Asking = { ...options, resolve, text: '', covered: false, timer: null };
    entry.timer = setTimeout(() => finishAsk(null, entry), Math.max(1000, options.forMs));
    entry.timer.unref();
    if (asking) {
      asks.push(entry);
      return;
    }
    asking = entry;
    if (visible() && showing) {
      // Something is on screen already: the question waits under it, and comes up when it goes.
      entry.covered = true;
      return;
    }
    if (entry.sound) playSound(entry.sound);
    showAsk(entry);
  });
}

function showAsk(entry: Asking): void {
  entry.covered = false;
  clearHideTimer();
  showing = null;
  ui()?.show({
    title: entry.title,
    lines: entry.lines,
    accent: entry.accent,
    input: { placeholder: entry.placeholder, text: entry.text },
  });
}

/** Take a question away unanswered: the blueprint that asked it was stopped. */
export function cancelAsk(id: string): void {
  const entry = asking?.id === id ? asking : asks.find((a) => a.id === id);
  if (entry) finishAsk(null, entry);
}

function finishAsk(answer: string | null, entry: Asking | null = asking): void {
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  const queued = asks.indexOf(entry);
  if (queued !== -1) {
    asks.splice(queued, 1);
    entry.resolve(answer);
    return;
  }
  if (entry !== asking) return;
  asking = null;
  const wasShowing = !entry.covered;
  entry.resolve(answer);
  const next = asks.shift();
  if (next) {
    asking = next;
    // Straight on to the next question, or under whatever covered this one.
    if (wasShowing) {
      if (next.sound) playSound(next.sound);
      showAsk(next);
    } else next.covered = true;
    return;
  }
  // The question was what was on screen: it goes, and anything that waited for it comes.
  if (wasShowing) hidden();
}

function clearHideTimer(): void {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;
}

export function visible(): boolean {
  return overlay?.visible ?? false;
}

/** What is on screen now, so `say` can add to it rather than replace it. */
let showing: PopupOptions | null = null;

/**
 * Add a line to the exchange already on screen, growing the window.
 *
 * An exchange is a conversation — you say something, it answers, and with
 * follow-ups on you say something else without the wake word. Replacing the
 * contents each time threw away the half you were checking: the reply appeared
 * where your own words had been, so there was no way to see *what it heard*
 * next to *what it did* about it.
 *
 * Falls back to `show` when nothing is up, so a caller never has to ask which
 * of the two it wants. A new wake word calls `show` and starts a fresh one —
 * that is the reset, and it is deliberate rather than a timer.
 */
export function say(line: OverlayLine, options: { sound?: SoundName; forMs?: number } = {}): void {
  if (!showing || !visible()) {
    show({ title: line.from === 'you' ? 'Heard' : 'Blue Everything', lines: [line], ...options });
    return;
  }

  showing = {
    ...showing,
    lines: [...(showing.lines ?? []), line],
    // A choice belonged to the turn that offered it; carrying it down the
    // transcript would leave a dead button under an answered question.
    choices: undefined,
    ...options,
  };
  show(showing);
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

export function stopPopups(): void {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;
  for (const entry of [...asks, ...(asking ? [asking] : [])]) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(null);
  }
  asks.length = 0;
  asking = null;
  overlay?.destroy();
  overlay = null;
}
