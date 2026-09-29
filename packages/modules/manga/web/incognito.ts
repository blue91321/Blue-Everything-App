/**
 * Reading without it being written down.
 *
 * Asked for beside removing history and marking things unread, and it is the
 * third of the same wish: what you have read is a record, and a record you did
 * not want is harder to be rid of than one never made.
 *
 * ### Per device, like the reader's own settings
 *
 * It is `localStorage`, not a server setting, for the reason `reader-prefs.ts`
 * gives about every value in it: this is a fact about the screen in your hand
 * and the moment you are in, not about the notebook. Switching it on at the
 * PC has no business silencing the phone, and a flag synced between them would
 * be one more thing to remember to turn off somewhere else.
 *
 * ### It stops the writing, not the reading
 *
 * Two things record a chapter: the place you are in, saved as you scroll, and
 * the read mark written when you finish. Both are skipped while this is on.
 * Nothing already saved is touched — turning it on is not a way to erase, and
 * History's ✕ is the thing for that.
 *
 * **What it cannot do is hide a download.** A chapter saved for offline is a
 * file on the device either way, which is the honest boundary and one the
 * switch says out loud rather than leaving to be discovered.
 */
const KEY = 'everything.manga.incognito';

/** Read defensively: a stray value should read as "off", never as "on". */
export function isIncognito(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    // Private mode, or site data blocked. Nothing is being written down there
    // that this would need to stop.
    return false;
  }
}

export function setIncognito(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    // Nothing to do: a browser that will not remember the switch will not
    // remember what it was meant to suppress either.
  }
}
