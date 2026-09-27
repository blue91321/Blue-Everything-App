/**
 * What kind of device this page is open on, for the sentences that are only
 * true of one kind.
 *
 * "iOS may clear these if the phone runs low on space" is a real warning on an
 * iPhone and nonsense on the PC. Three places in core asked these questions
 * with their own copies of the tests — the offline banner, the offline screen
 * and push — so they live here once, and a fix to one (an iPad reporting itself
 * as a Mac) reaches every caller.
 *
 * **None of this is a security decision.** What a device may *do* is decided
 * by the server (`session.local`, the loopback gate). This only decides what to
 * *say*, where a wrong guess costs one sentence that does not apply.
 */

/** Open on the PC that runs the server, by its loopback address. */
export function onServersMachine(): boolean {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname);
}

/**
 * An iPhone or iPad. An iPad asks for the desktop site by default and then
 * calls itself a Mac, so a "Mac" with a touch screen is taken as one — no Mac
 * has a touch screen.
 */
export function isIOS(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent))
  );
}

export function isAndroid(): boolean {
  return /Android/.test(navigator.userAgent);
}

/** A phone or tablet, as opposed to a computer with a keyboard. */
export function isMobile(): boolean {
  return isIOS() || isAndroid();
}

/** Opened from its Home Screen icon — or installed as an app on a PC — rather than in a browser tab. */
export function isInstalled(): boolean {
  return (
    (navigator as { standalone?: boolean }).standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches
  );
}
