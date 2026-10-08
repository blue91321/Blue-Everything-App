/**
 * Which chapter is open in the reader, kept across a reload of the page.
 *
 * The app already lands back on the Manga screen after a reload — the URL names
 * the screen — but the reader is state inside it, so reloading mid-chapter put
 * you on the library. A reload is also the obvious thing to try when pages will
 * not draw, so it now reopens the same chapter at the saved place, and every
 * page is asked for again on the way in.
 *
 * `sessionStorage`, not `localStorage`: this is about the tab in front of you.
 * A chapter left open last week should not spring open the next time the app is
 * started. Read once, when this module loads, so the reader writing "nothing
 * open" during its first render cannot clear it before it is used.
 */
const KEY = 'manga-open-chapter';

export type OpenChapter = { seriesId: string; chapterId: string };

function readStored(): OpenChapter | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<OpenChapter>;
    return typeof v.seriesId === 'string' && typeof v.chapterId === 'string' ? { seriesId: v.seriesId, chapterId: v.chapterId } : null;
  } catch {
    return null;
  }
}

const atLoad = readStored();

/** The chapter that was open when the page was last reloaded. */
export function openAtLoad(): OpenChapter | null {
  return atLoad;
}

export function rememberOpen(v: OpenChapter | null): void {
  try {
    if (v) sessionStorage.setItem(KEY, JSON.stringify(v));
    else sessionStorage.removeItem(KEY);
  } catch {
    // Storage refused: a reload lands on the list, as it always did.
  }
}
