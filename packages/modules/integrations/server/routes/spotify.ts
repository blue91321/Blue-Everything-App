/**
 * Spotify beyond syncing: Shuffle (`../providers/spotify-shuffle.ts`), its
 * settings and boosts, and the watcher for the desktop app's bug
 * (`../providers/spotify-desktop-bug.ts`).
 *
 * Registering these also resumes a shuffle session saved before a restart and
 * starts the watcher's hourly tick; both stop when the server closes.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { changes } from '@everything/server/module-api';
import { grantedScopes } from '../oauth.js';
import {
  readWeights,
  sessionStatus,
  readShuffleSettings,
  saveShuffleSettings,
  setWeight,
  shuffleSources,
  shuffleOnSpotify,
  songsIn,
  pauseSession,
  resumeSession,
  stopAndPause,
  stopSession,
  QUEUE_AHEAD_MAX,
  QUEUE_AHEAD_MIN,
  SHUFFLE_SCOPES,
} from '../providers/spotify-shuffle.js';
import {
  checkIfDue,
  checkThread,
  readDesktopBug,
  setWatching,
  testDesktopApp,
  THREAD_URL,
} from '../providers/spotify-desktop-bug.js';
import { getAccount } from '../store.js';

export async function spotifyRoutes(app: FastifyInstance): Promise<void> {
  /* ---- an evenly shuffled Spotify playlist ------------------------ */

  /**
   * What the Shuffle card needs: which collections can feed it, and whether
   * the connection carries the permission to control playback.
   *
   * Not local-only, like reading: pressing the button on the phone before
   * putting music on is the point of it, and all it does is start your own music.
   */
  /**
   * Just the three facts the menu's dot and the Home tile need. The full route
   * below carries every song and artist for the card, and the dot was asking
   * it — on every change announced anywhere in the app, from every open screen.
   * About 100 KB a time on a library of a thousand songs, for two booleans.
   */
  app.get('/api/integrations/spotify/status', async () => {
    const account = await getAccount('spotify');
    return {
      connected: Boolean(account?.accessToken),
      canPlay: SHUFFLE_SCOPES.every((s) => grantedScopes(account).includes(s)),
      active: sessionStatus().active,
    };
  });

  app.get('/api/integrations/spotify/shuffle', async () => {
    const account = await getAccount('spotify');
    const sources = account ? await shuffleSources() : [];
    /*
     * The songs and artists you can boost, from every list — a few thousand
     * short rows at most, and the card searches them as you type. An artist's
     * name is read off the song's credit, which lists names in the same order
     * as the ids.
     */
    const songs = await songsIn(sources.map((s) => s.id));
    return {
      connected: Boolean(account?.accessToken),
      canPlay: SHUFFLE_SCOPES.every((s) => grantedScopes(account).includes(s)),
      sources,
      // Artists are counted on the card, from the songs in the ticked lists.
      songs: songs.map((s) => ({ uri: s.uri, title: s.title, artist: s.artist, artistIds: s.artistIds, lists: s.lists })),
      weights: readWeights(),
      session: sessionStatus(),
      settings: readShuffleSettings(),
    };
  });

  /** Stop keeping the queue topped up. What is already queued plays on. */
  app.post('/api/integrations/spotify/shuffle/stop', async (request) => {
    // `pause: true` is the card's Stop; without it the music plays on (voice's
    // "stop topping up", and the card's "Stop adding songs").
    const body = z.object({ pause: z.boolean().default(false) }).parse(request.body ?? {});
    if (body.pause) await stopAndPause();
    else stopSession('stopped from the app');
    return sessionStatus();
  });

  /** How many songs to keep queued ahead while a session runs. */
  /**
   * The Shuffle card's settings, any of them. Shared by every device, so a
   * change on the phone shows on the PC's card at once (the announcement) and
   * is what voice plays with.
   */
  app.put('/api/integrations/spotify/shuffle/settings', async (request) => {
    const body = z
      .object({
        queueAhead: z.number().int().min(QUEUE_AHEAD_MIN).max(QUEUE_AHEAD_MAX).optional(),
        picks: z.array(z.string().min(1)).max(500).nullable().optional(),
        order: z.enum(['shuffle', 'random']).optional(),
        repeatAfter: z.number().int().min(0).max(100_000).optional(),
        recent: z.object({ within: z.number().int().min(0).max(100_000), factor: z.number().min(0).max(1) }).optional(),
        fresh: z.object({ after: z.number().int().min(0).max(100_000), factor: z.number().min(1).max(100) }).optional(),
      })
      .parse(request.body ?? {});
    const part = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    const result = saveShuffleSettings(part);
    changes.emitChange('integrations');
    return result;
  });

  // A session's timer must not hold a closing server open. Paused, not ended:
  // its file stays, and the next start picks it up (`resumeSession`).
  app.addHook('onClose', async () => pauseSession());

  // Picked up a little after boot, once Suwayomi and the sweep have had their moment.
  setTimeout(() => void resumeSession().catch(() => undefined), 5_000).unref?.();

  /* ---- waiting for Spotify to fix its desktop app ------------------ */

  /** What is known about the bug, and the thread being watched — see `spotify-desktop-bug.ts`. */
  app.get('/api/integrations/spotify/desktop-bug', async () => ({ ...readDesktopBug(), threadUrl: THREAD_URL }));

  /** Watch the forum thread, once a day, or stop. Starting looks at once. */
  app.post('/api/integrations/spotify/desktop-bug/watch', async (request) => {
    const { on } = z.object({ on: z.boolean() }).parse(request.body ?? {});
    return { ...(await setWatching(on)), threadUrl: THREAD_URL };
  });

  /** Look at the thread now. */
  app.post('/api/integrations/spotify/desktop-bug/check', async () => ({ ...(await checkThread()), threadUrl: THREAD_URL }));

  /**
   * Send one song to the desktop app and see whether it plays. Only on a press:
   * a pass starts music on the PC, and a fail clears what it had paused.
   */
  app.post('/api/integrations/spotify/desktop-bug/test', async (_request, reply) => {
    try {
      const sources = (await shuffleSources()).filter((s) => s.readable);
      const fallback = (await songsIn(sources.map((s) => s.id)))[0]?.uri ?? null;
      return { ...(await testDesktopApp(fallback)), threadUrl: THREAD_URL };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : 'the test failed' });
    }
  });

  /*
   * The thread is looked at once a day while watching: an hourly tick that asks
   * whether a day has passed, so a restart neither checks again at once nor
   * waits another day. Two requests a day to the forum, none when not watching.
   */
  const bugFirst = setTimeout(() => void checkIfDue().catch(() => undefined), 60_000);

  const bugTick = setInterval(() => void checkIfDue().catch(() => undefined), 60 * 60_000);

  bugFirst.unref();

  bugTick.unref();

  app.addHook('onClose', () => {
    clearTimeout(bugFirst);
    clearInterval(bugTick);
  });

  /** Boost a song or an artist for the random order; 1 is no boost and removes it. */
  app.put('/api/integrations/spotify/weights', async (request) => {
    const body = z
      .object({ kind: z.enum(['song', 'artist']), id: z.string().min(1).max(200), weight: z.number().min(0).max(10) })
      .parse(request.body);
    const weights = setWeight(body.kind, body.id, body.weight);
    changes.emitChange('integrations');
    return weights;
  });

  app.post('/api/integrations/spotify/shuffle', async (request, reply) => {
    const body = z
      .object({
        mode: z.enum(['play', 'queue']).default('play'),
        // Each falls back to the saved settings: voice sends only the mode and
        // the order, and plays from the lists and gap the card has chosen.
        order: z.enum(['shuffle', 'random']).optional(),
        repeatAfter: z.number().int().min(0).max(100_000).optional(),
        collectionIds: z.array(z.string().min(1)).max(500).optional(),
        recent: z.object({ within: z.number().int().min(0).max(100_000), factor: z.number().min(0).max(1) }).optional(),
        fresh: z.object({ after: z.number().int().min(0).max(100_000), factor: z.number().min(1).max(100) }).optional(),
        // Play never cuts the song on off any more; kept so an older card's
        // `false` is still accepted (and ignored).
        keepCurrent: z.boolean().optional(),
        // The kind of device Play was pressed on; absent (voice, an older card) counts as the PC.
        from: z.enum(['phone', 'computer']).optional(),
      })
      .parse(request.body ?? {});
    const saved = readShuffleSettings();
    const order = body.order ?? saved.order;
    try {
      const result = await shuffleOnSpotify(
        body.mode,
        body.collectionIds ?? saved.picks ?? undefined,
        order,
        body.repeatAfter ?? saved.repeatAfter,
        {
          recent: body.recent ?? (saved.recent.within > 0 ? saved.recent : undefined),
          fresh: body.fresh ?? (saved.fresh.after > 0 ? saved.fresh : undefined),
        },
        body.from ?? 'computer'
      );
      changes.emitChange('integrations');
      return result;
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : 'the shuffle failed' });
    }
  });
}
