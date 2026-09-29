/**
 * Saving your place in a chapter as you read it.
 *
 * At most once every few seconds while you scroll, and immediately when you
 * stop reading — close the chapter, switch apps, lock the phone. The interval
 * is what keeps this from being a request per scroll event; the flush on
 * leaving is what makes the saved place the one you actually left, rather than
 * wherever you were a few seconds before.
 *
 * The leaving flush uses `keepalive`, which lets a request outlive the page
 * that made it. iOS suspends a backgrounded PWA almost at once, and an ordinary
 * fetch started as it goes is simply dropped — the exact moment this exists
 * for. `sendBeacon` would be the usual tool and cannot carry the bearer token.
 */
import { useEffect, useRef } from 'react';
import { isIncognito } from './incognito';
import { getToken } from '@app/api';
import { enqueue } from './sync-queue';

const EVERY_MS = 4_000;

export type Place = {
  chapter: number;
  chapterId: string;
  chapterName: string;
  page: number;
  offset: number;
  pages: number;
};

export function usePositionSaver(seriesId: string | null) {
  /** The place, and when you were there — which is what the server keeps the newest of. */
  const pending = useRef<(Place & { at: number }) | null>(null);
  const lastSent = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const send = (leaving = false) => {
    // Reading with nothing written down — see `incognito.ts`. Checked here
    // rather than at each caller, because this is the one door every saved
    // place goes through.
    if (isIncognito()) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const place = pending.current;
    if (!place || !seriesId) return;
    pending.current = null;
    lastSent.current = Date.now();
    void fetch(`/api/manga/${seriesId}/position`, {
      method: 'PUT',
      keepalive: leaving,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken()}` },
      body: JSON.stringify(place),
    }).catch(() => {
      /*
       * No connection — reading a downloaded chapter on the train. Queued with
       * the time you were there, and sent when the server is back; the server
       * keeps it only if nothing newer arrived meanwhile.
       */
      const { at, ...where } = place;
      enqueue({ kind: 'position', seriesId, place: where, at });
    });
  };

  useEffect(() => {
    const leave = () => {
      if (document.visibilityState === 'hidden') send(true);
    };
    const hide = () => send(true);
    document.addEventListener('visibilitychange', leave);
    window.addEventListener('pagehide', hide);
    return () => {
      document.removeEventListener('visibilitychange', leave);
      window.removeEventListener('pagehide', hide);
      send(true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesId]);

  return {
    /** Note where you are; sent when the interval allows. */
    note(place: Place) {
      pending.current = { ...place, at: Date.now() };
      const wait = lastSent.current + EVERY_MS - Date.now();
      if (wait <= 0) send();
      else if (!timer.current) timer.current = setTimeout(() => send(), wait);
    },
    /** Send what is waiting now — closing a chapter. */
    flush() {
      send(true);
    },
  };
}
