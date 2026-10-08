/**
 * Whether a chapter is read, decided from claims that can arrive in any order.
 *
 * A read used to be one request, sent once: the reader finished a chapter, PUT
 * it, and if that request was lost so was the read. Now every device keeps its
 * own log of what it read (`reading-log.ts` in the browser half) and sends it —
 * and sends the recent part of it again later, so a read the server lost is put
 * back. That only works if sending the same claim twice is harmless and an old
 * claim cannot overrule a newer one, which is this file.
 *
 * **Each claim carries when it happened, and the later one wins.** A read at
 * nine is undone by marking it unread at ten, and that unread must not be
 * undone at eleven by the phone re-sending its nine o'clock read. So an unread
 * leaves a tombstone — `unreadAt`, the time it was taken back — and a read
 * older than the tombstone is ignored. A read newer than it is a re-read and
 * counts.
 *
 * No imports but types, so `manga-check` can assert the rule directly — the
 * same property `chapter-nav.ts` and `presence.ts` have.
 */
import type { ReadRecord, SeriesSource } from './library.js';

/** The fields of a followed series or a glimpse that a read touches. */
export type Readable = {
  readChapters: number[];
  readLog: ReadRecord[];
  source: SeriesSource | null;
  unreadAt?: Record<string, number>;
};

/**
 * Apply one claim. Returns whether anything changed, so a batch that changed
 * nothing — which is what a re-send nearly always is — writes nothing and
 * announces nothing.
 */
export function applyReadMark(row: Readable, chapter: number, read: boolean, at: number): boolean {
  const key = String(chapter);
  const tomb = row.unreadAt?.[key];
  const logged = row.readLog.find((r) => r.chapter === chapter);
  const isRead = row.readChapters.includes(chapter);

  if (read) {
    // Taken back after this read happened: the taking back stands.
    if (tomb !== undefined && tomb > at) return false;
    if (isRead && logged) {
      // Already known. A later read is a re-read and moves the record forward;
      // an earlier one is a re-send and changes nothing — the record never
      // moves backwards, or re-sending would rewrite your history.
      if (at <= logged.at) return false;
      logged.at = at;
      logged.source = row.source?.sourceName ?? null;
      logged.mangaId = row.source?.mangaId ?? null;
      return true;
    }
    if (!isRead) {
      row.readChapters = [...row.readChapters, chapter].sort((a, b) => a - b);
    }
    row.readLog = [
      ...row.readLog.filter((r) => r.chapter !== chapter),
      { chapter, source: row.source?.sourceName ?? null, mangaId: row.source?.mangaId ?? null, at },
    ].sort((a, b) => a.chapter - b.chapter);
    if (tomb !== undefined) {
      const { [key]: _gone, ...rest } = row.unreadAt!;
      row.unreadAt = Object.keys(rest).length > 0 ? rest : undefined;
    }
    return true;
  }

  // Read again after this was taken back: the read stands.
  if (logged && logged.at > at) return false;
  let changed = false;
  if (isRead || logged) {
    row.readChapters = row.readChapters.filter((c) => c !== chapter);
    row.readLog = row.readLog.filter((r) => r.chapter !== chapter);
    changed = true;
  }
  if (tomb === undefined || tomb < at) {
    row.unreadAt = { ...(row.unreadAt ?? {}), [key]: at };
    changed = true;
  }
  return changed;
}

/**
 * Whether a saved place sits at the end of its chapter — on its last page, or
 * the one before it.
 *
 * Asked when that place is about to be replaced by one in a *later* chapter,
 * or cleared by finishing one. Either way you have moved on, and a place left
 * at the end of the chapter you moved on from is a chapter read: the reader
 * failed to say so (Back pressed at the end, before leaving counted as
 * finishing; a phone that killed the app before the read went out), and
 * dropping the place was silently dropping the only record that it happened.
 * Chapter 38 of Master Swordsman's Stream went exactly that way.
 *
 * One page of slack, because the place is the page under a line near the
 * *top* of the screen: at the bottom of a chapter whose last page is short,
 * that is still the page before it. A chapter of one or two pages needs its
 * last page outright, or opening it would count.
 */
export function placeIsAtEnd(place: { page: number; pages: number }): boolean {
  if (place.pages <= 2) return place.page >= place.pages - 1;
  return place.page >= place.pages - 2;
}
