/**
 * Trips: flights, places on a map, and a checklist, each feeding the to-do list.
 *
 * A trip is a name, optional dates and three lists. Its first and last days are
 * typed or worked out from its flights (`tripSpan`), and the checklist's dates
 * hang off the first day, so adding the outbound flight is what gives "pack the
 * charger, 1 day before" its date.
 *
 * Adding a flight is a number and a date. With a key, one lookup fills in the
 * airports and times; without one, or when the service does not know the
 * flight, the screen asks for the two airports and two times, which are times
 * *at those airports* and are placed with each airport's own zone.
 *
 * Every write that can change a task goes through `commit`, which syncs the
 * tasks, writes once, re-arms the flight watcher and announces once.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { changes } from '@everything/server/module-api';
import { airportByCode, AirportsUnavailable, searchAirports } from './airports.js';
import { FlightServiceError, lookUp, type ServiceLeg } from './flights.js';
import { refreshDue, schedule, stop, watchable } from './live.js';
import { PlaceSearchError, searchPlaces } from './places.js';
import { greatCircle, localDate, nextCheckAt, normaliseFlightNumber, offsetText, zonedToUtc } from './rules.js';
import {
  cleanSettings,
  monthKey,
  newId,
  read,
  StoreUnreadable,
  tripSpan,
  usedThisMonth,
  write,
  type ChecklistItem,
  type Flight,
  type Place,
  type Store,
  type Trip,
} from './store.js';
import { dropTasks, emptyLink, isInternational, linksOf, syncTasks } from './tasks.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = new Set<Place['kind']>(['stay', 'visit', 'food', 'other']);

type Body = Record<string, unknown> | null;
const str = (v: unknown, max = 200): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
const dateOrNull = (v: unknown): string | null | undefined =>
  v === null || v === '' ? null : typeof v === 'string' && DATE.test(v) ? v : undefined;

class Refused extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof Refused) return reply.code(error.status).send({ error: error.message });
  if (error instanceof StoreUnreadable) return reply.code(500).send({ error: error.message });
  if (error instanceof AirportsUnavailable) return reply.code(502).send({ error: error.message });
  if (error instanceof FlightServiceError) return reply.code(502).send({ error: error.message });
  if (error instanceof PlaceSearchError) return reply.code(502).send({ error: error.message });
  throw error;
}

/** Sync the tasks, write once, re-arm the watcher, and tell every screen. */
async function commit(store: Store): Promise<void> {
  const tasksChanged = await syncTasks(store);
  write(store);
  schedule();
  if (tasksChanged) changes.emitChange('tasks');
  changes.emitChange('all');
}

function tripOf(store: Store, id: string): Trip {
  const trip = store.trips.find((t) => t.id === id);
  if (!trip) throw new Refused('no such trip', 404);
  return trip;
}

/* ---------------------------------------------------------------- */
/* What the screen is sent                                            */
/* ---------------------------------------------------------------- */

const linkState = (l: { made: boolean; id: string | null }) => (l.id ? 'made' : l.made ? 'deleted' : 'none');

function presentFlight(f: Flight) {
  const next = nextCheckAt(watchable(f));
  return {
    id: f.id,
    number: f.number,
    date: f.date,
    airline: f.airline,
    from: f.from,
    to: f.to,
    departs: f.departs,
    arrives: f.arrives,
    confirmation: f.confirmation,
    seat: f.seat,
    notes: f.notes,
    filledBy: f.filledBy,
    live: f.live,
    checkedAt: f.checkedAt,
    checkError: f.checkError,
    nextCheckAt: next,
    international: isInternational(f),
    tasks: { checkIn: linkState(f.tasks.checkIn), leave: linkState(f.tasks.leave) },
    route: greatCircle([f.from.lat, f.from.lon], [f.to.lat, f.to.lon], 48),
  };
}

function presentTrip(t: Trip) {
  const span = tripSpan(t, localDate);
  return {
    id: t.id,
    name: t.name,
    start: span.start,
    end: span.end,
    typedStart: t.start,
    typedEnd: t.end,
    notes: t.notes,
    flights: [...t.flights].sort((a, b) => a.departs - b.departs).map(presentFlight),
    places: t.places,
    checklist: t.checklist.map((c) => ({
      id: c.id,
      text: c.text,
      offsetDays: c.offsetDays,
      when: offsetText(c.offsetDays),
      task: linkState(c.task),
    })),
  };
}

function present(store: Store) {
  const trips = store.trips.map(presentTrip).sort((a, b) => (a.start ?? '9999').localeCompare(b.start ?? '9999'));
  return {
    trips,
    settings: store.settings,
    hasKey: store.apiKey !== null,
    usage: { month: monthKey(), used: usedThisMonth(store), budget: store.settings.monthlyBudget },
  };
}

/* ---------------------------------------------------------------- */
/* Adding a flight                                                    */
/* ---------------------------------------------------------------- */

function flightFromLeg(leg: ServiceLeg, number: string, date: string): Flight {
  return {
    id: newId(),
    number,
    date,
    airline: leg.airline,
    from: leg.from,
    to: leg.to,
    departs: leg.departs,
    arrives: leg.arrives,
    confirmation: null,
    seat: null,
    notes: null,
    filledBy: 'service',
    live: leg.live,
    checkedAt: Date.now(),
    checkError: null,
    tasks: { checkIn: emptyLink(), leave: emptyLink() },
  };
}

async function typedFlight(body: Body, number: string, date: string): Promise<Flight> {
  const fromCode = str(body?.from, 3);
  const toCode = str(body?.to, 3);
  const departTime = str(body?.departTime, 5);
  const arriveTime = str(body?.arriveTime, 5);
  if (!fromCode || !toCode || !departTime || !arriveTime) {
    throw new Refused('give both airports and both times');
  }
  const from = await airportByCode(fromCode);
  const to = await airportByCode(toCode);
  if (!from) throw new Refused(`no airport with the code ${fromCode.toUpperCase()}`);
  if (!to) throw new Refused(`no airport with the code ${toCode.toUpperCase()}`);
  const departs = zonedToUtc(date, departTime, from.tz);
  const arriveDate = dateOrNull(body?.arriveDate) ?? date;
  let arrives = zonedToUtc(arriveDate, arriveTime, to.tz);
  if (departs === null || arrives === null) throw new Refused('times are written like 08:30');
  // Landing "before" it left, with no arrival date given, is an overnight flight.
  if (arrives <= departs && !body?.arriveDate) arrives += 24 * 3_600_000;
  if (arrives <= departs) throw new Refused('it lands before it leaves');
  return {
    id: newId(),
    number,
    date,
    airline: str(body?.airline, 80),
    from,
    to,
    departs,
    arrives,
    confirmation: null,
    seat: null,
    notes: null,
    filledBy: 'typed',
    live: null,
    checkedAt: null,
    checkError: null,
    tasks: { checkIn: emptyLink(), leave: emptyLink() },
  };
}

function editFlightDetails(f: Flight, body: Body): void {
  if (body && 'confirmation' in body) f.confirmation = str(body.confirmation, 40);
  if (body && 'seat' in body) f.seat = str(body.seat, 12);
  if (body && 'notes' in body) f.notes = str(body.notes, 1000);
}

/* ---------------------------------------------------------------- */

export async function routes(app: FastifyInstance): Promise<void> {
  const localOnly = (request: { isLocal: boolean }) => {
    if (!request.isLocal) throw new Refused('the flight service key can only be changed from the PC running the server', 403);
  };

  // Arm the watcher for whatever is already in the file, and let it go with the app.
  schedule();
  app.addHook('onClose', async () => stop());

  /**
   * Every trip. Reading this also starts a look at any flight that is due one,
   * in the background, so a phone opened after the PC slept is not shown a gate
   * from hours ago while the timer catches up. The look announces when it lands.
   */
  app.get('/api/trips', async (_request, reply) => {
    try {
      const store = read();
      void refreshDue().catch(() => false);
      return present(store);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/trips', async (request, reply) => {
    try {
      const body = request.body as Body;
      const name = str(body?.name, 120);
      if (!name) throw new Refused('a trip needs a name');
      const store = read();
      const trip: Trip = {
        id: newId(),
        name,
        start: dateOrNull(body?.start) ?? null,
        end: dateOrNull(body?.end) ?? null,
        notes: str(body?.notes, 4000),
        flights: [],
        places: [],
        checklist: [],
        createdAt: Date.now(),
      };
      store.trips.push(trip);
      await commit(store);
      return presentTrip(trip);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.patch('/api/trips/:id', async (request, reply) => {
    try {
      const body = request.body as Body;
      const store = read();
      const trip = tripOf(store, (request.params as { id: string }).id);
      if (body && 'name' in body) {
        const name = str(body.name, 120);
        if (!name) throw new Refused('a trip needs a name');
        trip.name = name;
      }
      for (const key of ['start', 'end'] as const) {
        if (!body || !(key in body)) continue;
        const v = dateOrNull(body[key]);
        if (v === undefined) throw new Refused(`${key} is a date like 2026-11-04, or empty`);
        trip[key] = v;
      }
      if (body && 'notes' in body) trip.notes = str(body.notes, 4000);
      await commit(store);
      return presentTrip(trip);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete('/api/trips/:id', async (request, reply) => {
    try {
      const store = read();
      const trip = tripOf(store, (request.params as { id: string }).id);
      const dropped = await dropTasks(linksOf(trip));
      store.trips = store.trips.filter((t) => t.id !== trip.id);
      write(store);
      schedule();
      if (dropped) changes.emitChange('tasks');
      changes.emitChange('all');
      return { ok: true };
    } catch (error) {
      return fail(reply, error);
    }
  });

  /* ---- flights ---------------------------------------------------- */

  /**
   * Add a flight by number and date.
   *
   * With a key and no typed times, the service is asked once. Two answers are
   * not a flight and not a failure either, and come back as ordinary replies so
   * the screen can act on them: `legs` when the number flies several legs that
   * day (send one back as `leg`), and `needsTimes` when the service cannot say
   * (it does not know the flight, the budget is spent, or it is down), which is
   * the screen's cue to ask for the airports and times. Without a key, or with
   * `manual`, the typed airports and times are used.
   */
  app.post('/api/trips/:id/flights', async (request, reply) => {
    try {
      const body = request.body as Body;
      const number = normaliseFlightNumber(String(body?.number ?? ''));
      if (!number) throw new Refused('a flight number looks like UA 123');
      const date = typeof body?.date === 'string' && DATE.test(body.date) ? body.date : null;
      if (!date) throw new Refused('the date the flight leaves, like 2026-11-04');

      const store = read();
      const tripId = tripOf(store, (request.params as { id: string }).id).id;
      let flight: Flight;
      if (store.apiKey && !body?.manual) {
        if (usedThisMonth(store) >= store.settings.monthlyBudget) {
          return { needsTimes: `This month's ${store.settings.monthlyBudget} lookups are used up, so type the times.` };
        }
        let legs: ServiceLeg[];
        try {
          legs = await lookUp(store.apiKey, number, date);
        } catch (error) {
          if (error instanceof FlightServiceError) return { needsTimes: `Could not look it up (${error.message}), so type the times.` };
          throw error;
        } finally {
          const fresh = read();
          fresh.usage = { month: monthKey(), calls: usedThisMonth(fresh) + 1 };
          write(fresh);
        }
        if (legs.length === 0) {
          return { needsTimes: `The flight service has no ${number} on ${date}. Check the number and the date, or type the times.` };
        }
        const pick = typeof body?.leg === 'number' ? legs[body.leg] : legs.length === 1 ? legs[0] : undefined;
        if (!pick) {
          return { legs: legs.map((l, i) => ({ index: i, from: l.from.iata, to: l.to.iata, departs: l.departs, tz: l.from.tz })) };
        }
        flight = flightFromLeg(pick, number, date);
      } else {
        flight = await typedFlight(body, number, date);
      }
      editFlightDetails(flight, body);

      // Re-read: the lookup held the store across a request.
      const fresh = read();
      tripOf(fresh, tripId).flights.push(flight);
      await commit(fresh);
      return { flight: presentFlight(flight) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.patch('/api/trips/:id/flights/:flightId', async (request, reply) => {
    try {
      const { id, flightId } = request.params as { id: string; flightId: string };
      const store = read();
      const flight = tripOf(store, id).flights.find((f) => f.id === flightId);
      if (!flight) throw new Refused('no such flight', 404);
      editFlightDetails(flight, request.body as Body);
      await commit(store);
      return presentFlight(flight);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete('/api/trips/:id/flights/:flightId', async (request, reply) => {
    try {
      const { id, flightId } = request.params as { id: string; flightId: string };
      const store = read();
      const trip = tripOf(store, id);
      const flight = trip.flights.find((f) => f.id === flightId);
      if (!flight) throw new Refused('no such flight', 404);
      const dropped = await dropTasks(linksOf(flight));
      trip.flights = trip.flights.filter((f) => f.id !== flightId);
      await commit(store);
      if (dropped) changes.emitChange('tasks');
      return { ok: true };
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** Ask about one flight now, whatever the schedule says. Counted like any lookup. */
  app.post('/api/trips/:id/flights/:flightId/refresh', async (request, reply) => {
    try {
      const { id, flightId } = request.params as { id: string; flightId: string };
      const store = read();
      if (!store.apiKey) throw new Refused('live status needs a flight service key');
      if (!tripOf(store, id).flights.some((f) => f.id === flightId)) throw new Refused('no such flight', 404);
      await refreshDue(flightId);
      schedule();
      const flight = tripOf(read(), id).flights.find((f) => f.id === flightId)!;
      return presentFlight(flight);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/trips/airports', async (request, reply) => {
    try {
      const { q } = request.query as { q?: string };
      return { airports: await searchAirports(q ?? '') };
    } catch (error) {
      return fail(reply, error);
    }
  });

  /* ---- places ----------------------------------------------------- */

  app.get('/api/trips/places/search', async (request, reply) => {
    try {
      const { q } = request.query as { q?: string };
      if (!q || q.trim().length < 2) return { places: [] };
      return { places: await searchPlaces(q.trim()) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  function placeFields(body: Body, into: Partial<Place>): void {
    if (body && 'name' in body) {
      const name = str(body.name, 160);
      if (!name) throw new Refused('a place needs a name');
      into.name = name;
    }
    if (body && 'address' in body) into.address = str(body.address, 400);
    if (body && 'kind' in body) {
      if (!KINDS.has(body.kind as Place['kind'])) throw new Refused('kind is stay, visit, food or other');
      into.kind = body.kind as Place['kind'];
    }
    if (body && 'date' in body) {
      const d = dateOrNull(body.date);
      if (d === undefined) throw new Refused('a date like 2026-11-04, or empty');
      into.date = d;
    }
    if (body && 'notes' in body) into.notes = str(body.notes, 2000);
  }

  app.post('/api/trips/:id/places', async (request, reply) => {
    try {
      const body = request.body as Body;
      const lat = Number(body?.lat);
      const lon = Number(body?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        throw new Refused('a place needs a position: search for it first');
      }
      const place: Place = { id: newId(), name: '', address: null, lat, lon, kind: 'visit', date: null, notes: null };
      placeFields(body, place);
      if (!place.name) throw new Refused('a place needs a name');
      const store = read();
      tripOf(store, (request.params as { id: string }).id).places.push(place);
      await commit(store);
      return place;
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.patch('/api/trips/:id/places/:placeId', async (request, reply) => {
    try {
      const { id, placeId } = request.params as { id: string; placeId: string };
      const store = read();
      const place = tripOf(store, id).places.find((p) => p.id === placeId);
      if (!place) throw new Refused('no such place', 404);
      placeFields(request.body as Body, place);
      await commit(store);
      return place;
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete('/api/trips/:id/places/:placeId', async (request, reply) => {
    try {
      const { id, placeId } = request.params as { id: string; placeId: string };
      const store = read();
      const trip = tripOf(store, id);
      trip.places = trip.places.filter((p) => p.id !== placeId);
      await commit(store);
      return { ok: true };
    } catch (error) {
      return fail(reply, error);
    }
  });

  /* ---- checklist -------------------------------------------------- */

  const offsetFrom = (v: unknown): number | null | undefined =>
    v === null ? null : typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= 365 ? v : undefined;

  app.post('/api/trips/:id/checklist', async (request, reply) => {
    try {
      const body = request.body as Body;
      const text = str(body?.text, 200);
      if (!text) throw new Refused('say what it is');
      const offsetDays = offsetFrom(body?.offsetDays ?? null);
      if (offsetDays === undefined) throw new Refused('days from the first day, as a whole number, or none');
      const item: ChecklistItem = { id: newId(), text, offsetDays, task: emptyLink() };
      const store = read();
      tripOf(store, (request.params as { id: string }).id).checklist.push(item);
      await commit(store);
      return { ok: true };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.patch('/api/trips/:id/checklist/:itemId', async (request, reply) => {
    try {
      const { id, itemId } = request.params as { id: string; itemId: string };
      const body = request.body as Body;
      const store = read();
      const item = tripOf(store, id).checklist.find((c) => c.id === itemId);
      if (!item) throw new Refused('no such item', 404);
      if (body && 'text' in body) {
        const text = str(body.text, 200);
        if (!text) throw new Refused('say what it is');
        item.text = text;
      }
      if (body && 'offsetDays' in body) {
        const offsetDays = offsetFrom(body.offsetDays);
        if (offsetDays === undefined) throw new Refused('days from the first day, as a whole number, or none');
        item.offsetDays = offsetDays;
      }
      await commit(store);
      return { ok: true };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete('/api/trips/:id/checklist/:itemId', async (request, reply) => {
    try {
      const { id, itemId } = request.params as { id: string; itemId: string };
      const store = read();
      const trip = tripOf(store, id);
      const item = trip.checklist.find((c) => c.id === itemId);
      if (!item) throw new Refused('no such item', 404);
      const dropped = await dropTasks(linksOf(item));
      trip.checklist = trip.checklist.filter((c) => c.id !== itemId);
      await commit(store);
      if (dropped) changes.emitChange('tasks');
      return { ok: true };
    } catch (error) {
      return fail(reply, error);
    }
  });

  /* ---- settings --------------------------------------------------- */

  /**
   * The reminders, the budget, and the key.
   *
   * The key is local-only, like every credential in the integrations package:
   * it is a secret that spends somebody's allowance, and it is set once. The
   * rest is editable from the phone. A key is never sent back: the screen is
   * told only whether one is set.
   */
  app.put('/api/trips/settings', async (request, reply) => {
    try {
      const body = request.body as Body;
      const store = read();
      if (body && 'apiKey' in body) {
        localOnly(request);
        store.apiKey = str(body.apiKey, 200);
      }
      const { apiKey: _ignored, ...rest } = body ?? {};
      void _ignored;
      store.settings = cleanSettings({ ...store.settings, ...(rest as object) });
      await commit(store);
      return present(store);
    } catch (error) {
      return fail(reply, error);
    }
  });
}
