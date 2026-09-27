/**
 * The sentences about saving for offline that depend on which device you hold.
 *
 * Downloads live in *this* browser, so what can happen to them is a fact about
 * the device: iOS clears a web app's storage when the phone runs short of
 * space, a computer's browser practically never does, and on the PC that runs
 * the server "offline" can only mean the app is not running — so "it needs the
 * PC" is nonsense said to the PC.
 *
 * Kept together so the Downloads tab, the chapter list, the reader and the
 * offline shelf cannot word the same fact four ways. The device tests are
 * core's (`@app/device`), which the offline banner and push already use.
 */
import { isAndroid, isInstalled, isIOS, isMobile, onServersMachine } from '@app/device';

/**
 * What to call the device: an iPad or an Android tablet is not a phone. An iPad
 * asking for the desktop site says Mac, which is why it is "not an iPhone".
 */
function gadget(): string {
  if (isIOS()) return /iPhone|iPod/.test(navigator.userAgent) ? 'phone' : 'iPad';
  return /Mobile/.test(navigator.userAgent) ? 'phone' : 'tablet';
}

/** On the server's own PC, being offline means the app's server has stopped. */
const onThePc = onServersMachine();

/** What anything not saved here is waiting for: "…so it needs the PC." */
export const NEEDS = onThePc ? 'needs the app running' : 'needs the PC';

/** When saving works: "Save chapters while the PC is reachable." */
export const WHILE_REACHABLE = onThePc ? 'while the app is running' : 'while the PC is reachable';

/** Where reading done offline is headed: "…not yet on the PC." */
export const NOT_YET_SENT = onThePc ? 'not yet saved by the app' : 'not yet on the PC';

/** A sync that could not reach it. */
export const COULD_NOT_SEND = onThePc
  ? 'The app is not running — they will be saved on their own once it is.'
  : 'The PC could not be reached — it will send on its own once it can.';

/**
 * Whether these survive, which is the part that genuinely differs.
 *
 * `persisted` is the browser's own answer to `navigator.storage.persisted()`:
 * when it has promised to keep them, that is said instead, because it is true
 * on every device.
 */
export function keepingNote(persisted: boolean | null): string {
  const progress = onThePc
    ? ' Your reading progress is kept by the app, not with these.'
    : ' Your reading progress lives on the PC either way.';

  if (isIOS()) {
    if (persisted) return `iOS has agreed to keep these even when the ${gadget()} is short of space.${progress}`;
    // Safari's week-long limit applies to a site opened in a tab; a Home Screen
    // app is exempt, so it is only said where it applies.
    const tab = isInstalled()
      ? ''
      : ' Opened in a Safari tab rather than from the Home Screen icon, they are also cleared after about a week without a visit.';
    return `iOS may clear these if the ${gadget()} runs very low on space.${tab}${progress}`;
  }

  if (isAndroid()) {
    return persisted
      ? `The browser has agreed to keep these even when the ${gadget()} is short of space.${progress}`
      : `Android may clear these if the ${gadget()} runs very low on space.${progress}`;
  }

  // A computer: its browser keeps site data until you clear it, and evicts it
  // itself only when the disk is nearly full.
  return persisted
    ? `The browser has agreed to keep these until you remove them.${progress}`
    : `These stay until you remove them here or clear this browser's data for the site — it only clears them itself if the disk is nearly full.${progress}`;
}

/** While downloads run: what stops them, which is a phone putting the app away. */
export function keepOpenNote(): string {
  if (isIOS()) return 'Keep the app open and on screen until these finish — iOS pauses a web app the moment it leaves the screen.';
  if (isMobile()) return 'Keep the app open until these finish — Android may pause a web app once it is in the background.';
  return 'Keep this window open until these finish.';
}
