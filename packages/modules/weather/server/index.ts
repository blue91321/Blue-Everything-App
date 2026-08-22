/**
 * The weather, on two settings and a button.
 *
 * ### "Once a day" is a staleness window, not a timer
 *
 * The obvious reading of *fetch once a day* is a `setInterval` at 24 hours, and
 * this deliberately does not have one. The rule this project applies to anything
 * on a timer is to check it against the numbers, and a timer here loses on every
 * one of them:
 *
 *   - it fetches on a machine nobody is looking at, which is most of the day;
 *   - it needs a handle, an `unref`, and an `onClose`, or `smoke` and
 *     `features-check` hang on an app that will not shut down;
 *   - and it still would not guarantee fresh data when you *do* look, because
 *     the reading could be twenty-three hours old.
 *
 * So `GET /api/weather` refreshes anything older than a day as a side effect of
 * being read — the same arrangement the friends list and the live streams use.
 * Opening the tab five times costs one fetch; never opening it costs none. The
 * observable behaviour is "about once a day", which is what was asked for, and
 * the cost when nothing is on screen is zero rather than one request a day
 * forever.
 *
 * **Manual mode never does this.** `isDue` returns false outright, because a
 * setting called "only when I press the button" has to mean it.
 *
 * ### The button is always there
 *
 * In both modes, and that is the point of it. In `manual` it is the only way to
 * fetch; in `daily` it is how you get a reading *now* rather than whenever the
 * window happens to lapse. A control that appeared and disappeared with a
 * setting would be one more thing to work out.
 */
import type { FastifyInstance } from 'fastify';
import { findPlaces, isDue, read, refresh, write, WeatherError, type Place } from './weather.js';

/** Everything the screen needs, in one shape both the tab and the panel read. */
function present(store: ReturnType<typeof read>) {
  return {
    mode: store.mode,
    units: store.units,
    place: store.place,
    reading: store.reading,
    fetchedAt: store.fetchedAt,
    error: store.error,
    /**
     * Whether a `daily` install would fetch on the next read.
     *
     * Sent so the screen can say "it will update when you next open this"
     * instead of leaving you to work out what the mode implies.
     */
    due: isDue(store),
  };
}

export async function routes(app: FastifyInstance): Promise<void> {
  /**
   * The current reading, refreshed if it is a day old and the mode allows it.
   *
   * Not local-only: the weather is your data and the phone should see it, the
   * same call the habit pictures make. Nothing here touches this machine.
   */
  app.get('/api/weather', async () => {
    const store = read();
    if (isDue(store)) return present(await refresh());
    return present(store);
  });

  /**
   * Go and look now.
   *
   * Answers with the result rather than `{ ok: true }`, so the button updates
   * the screen from its own response instead of pressing and then waiting for a
   * second request to notice — a fetch is about a second, and two round trips
   * would make it feel like two.
   */
  app.post('/api/weather/refresh', async (_request, reply) => {
    const store = read();
    if (!store.place) return reply.code(400).send({ error: 'set a place first' });
    return present(await refresh());
  });

  /** Places matching what you typed, so nobody has to know their coordinates. */
  app.get('/api/weather/search', async (request, reply) => {
    const { q } = request.query as { q?: string };
    if (!q || q.trim().length < 2) return { places: [] };

    try {
      return { places: await findPlaces(q.trim()) };
    } catch (error) {
      if (error instanceof WeatherError) return reply.code(502).send({ error: error.message });
      throw error;
    }
  });

  /**
   * Choose a place, and fetch straight away.
   *
   * The fetch is not optional politeness: picking a place and being shown
   * nothing is indistinguishable from having picked the wrong one, and in
   * `manual` mode there would be no automatic fetch to rescue it — you would
   * have to press the button to find out whether the thing you just did worked.
   */
  app.put('/api/weather/place', async (request, reply) => {
    const body = request.body as Partial<Place> | null;
    if (
      !body ||
      typeof body.name !== 'string' ||
      typeof body.latitude !== 'number' ||
      typeof body.longitude !== 'number' ||
      !Number.isFinite(body.latitude) ||
      !Number.isFinite(body.longitude) ||
      Math.abs(body.latitude) > 90 ||
      Math.abs(body.longitude) > 180
    ) {
      return reply.code(400).send({ error: 'that is not a place' });
    }

    const store = read();
    write({
      ...store,
      place: {
        name: body.name.slice(0, 80),
        detail: typeof body.detail === 'string' ? body.detail.slice(0, 120) : '',
        latitude: body.latitude,
        longitude: body.longitude,
        timezone: typeof body.timezone === 'string' && body.timezone ? body.timezone.slice(0, 60) : 'auto',
      },
      // The old place's reading is not the new place's weather, and leaving it
      // on screen under a new name would be the most confusing thing available.
      reading: null,
      fetchedAt: null,
      error: null,
    });

    return present(await refresh());
  });

  /**
   * The two settings.
   *
   * Changing the units re-fetches, because the reading is stored already
   * converted — Open-Meteo does the conversion and there is no sense keeping a
   * second copy of the arithmetic here to avoid one request.
   */
  app.patch('/api/weather', async (request, reply) => {
    const body = request.body as { mode?: unknown; units?: unknown } | null;
    const store = read();

    const mode = body?.mode === undefined ? store.mode : body.mode;
    if (mode !== 'daily' && mode !== 'manual') return reply.code(400).send({ error: 'mode must be daily or manual' });

    const units = body?.units === undefined ? store.units : body.units;
    if (units !== 'c' && units !== 'f') return reply.code(400).send({ error: 'units must be c or f' });

    const unitsChanged = units !== store.units;
    write({ ...store, mode, units });

    if (unitsChanged && store.place) return present(await refresh());
    /*
     * Switching to `daily` does not fetch here. The next read will, if it is
     * due — and doing it now would mean the setting sometimes costs a request
     * and sometimes does not, which is a worse thing to explain than "it
     * updates when you look".
     */
    return present(read());
  });
}
