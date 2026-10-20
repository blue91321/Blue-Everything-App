/**
 * Asking AeroDataBox about a flight, through RapidAPI.
 *
 * One request answers both questions the package has: what a flight number on
 * a date *is* (where it goes, when), and what it is doing now (delays, gate,
 * status). `GET /flights/number/{number}/{date}`, the date being the departure
 * date at the departure airport, which is the date on a booking.
 *
 * Chosen because it has a free plan you sign up for yourself, needs no card,
 * and answers with the gate and terminal. Its free allowance is counted in
 * units rather than requests and the unit price of a lookup is theirs to set, so
 * this counts *requests* against a budget you choose (`monthlyBudget`) and the
 * screen says to check the plan. Every request goes through `ask`, so nothing
 * can spend the allowance without being counted.
 *
 * The key is sent in headers, never in a URL, and never back to a browser.
 */
import { airportByCode } from './airports.js';
import { parseServiceTime } from './rules.js';
import type { Airport, Live } from './store.js';

const HOST = 'aerodatabox.p.rapidapi.com';

export class FlightServiceError extends Error {
  constructor(
    message: string,
    /** True when asking again later might work; false when the key or the flight is wrong. */
    readonly transient: boolean
  ) {
    super(message);
  }
}

/** One leg as the service describes it. A flight number can fly several legs a day. */
export interface ServiceLeg {
  number: string;
  airline: string | null;
  from: Airport;
  to: Airport;
  /** The timetable's times. */
  departs: number;
  arrives: number;
  live: Live;
}

type Movement = {
  airport?: {
    iata?: string;
    name?: string;
    shortName?: string;
    municipalityName?: string;
    countryCode?: string;
    timeZone?: string;
    location?: { lat?: number; lon?: number };
  };
  scheduledTime?: { utc?: string; local?: string };
  revisedTime?: { utc?: string; local?: string };
  terminal?: string;
  gate?: string;
  baggageBelt?: string;
};

type ServiceFlight = {
  number?: string;
  status?: string;
  airline?: { name?: string };
  aircraft?: { model?: string };
  departure?: Movement;
  arrival?: Movement;
};

async function airportFrom(m: Movement | undefined): Promise<Airport | null> {
  const a = m?.airport;
  const code = (a?.iata ?? '').toUpperCase();
  const lat = a?.location?.lat;
  const lon = a?.location?.lon;
  if (/^[A-Z]{3}$/.test(code) && typeof lat === 'number' && typeof lon === 'number' && a?.timeZone) {
    return {
      iata: code,
      name: a.name ?? a.shortName ?? code,
      city: a.municipalityName ?? '',
      country: a.countryCode ?? '',
      lat,
      lon,
      tz: a.timeZone,
    };
  }
  // Asked without locations to keep the answer small: fill in from the table.
  return /^[A-Z]{3}$/.test(code) ? airportByCode(code).catch(() => null) : null;
}

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The service's flight, as a leg, or null when it lacks what a leg needs. */
export async function toLeg(f: ServiceFlight): Promise<ServiceLeg | null> {
  const from = await airportFrom(f.departure);
  const to = await airportFrom(f.arrival);
  const departs = parseServiceTime(f.departure?.scheduledTime?.utc);
  const arrives = parseServiceTime(f.arrival?.scheduledTime?.utc);
  if (!from || !to || departs === null || arrives === null) return null;
  return {
    number: (f.number ?? '').replace(/\s+/g, '').toUpperCase(),
    airline: text(f.airline?.name),
    from,
    to,
    departs,
    arrives,
    live: {
      status: text(f.status),
      departs: parseServiceTime(f.departure?.revisedTime?.utc) ?? departs,
      arrives: parseServiceTime(f.arrival?.revisedTime?.utc) ?? arrives,
      gate: text(f.departure?.gate),
      terminal: text(f.departure?.terminal),
      arrivalGate: text(f.arrival?.gate),
      arrivalTerminal: text(f.arrival?.terminal),
      baggageBelt: text(f.arrival?.baggageBelt),
      aircraft: text(f.aircraft?.model),
    },
  };
}

/**
 * Every leg flown under this number on this date. One request.
 *
 * An empty list is an answer: the service does not know that flight on that
 * day, which is usually a typo or a date in the wrong year.
 */
export async function lookUp(key: string, number: string, date: string): Promise<ServiceLeg[]> {
  const url = `https://${HOST}/flights/number/${encodeURIComponent(number)}/${date}?withAircraftImage=false&withLocation=false`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': HOST },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new FlightServiceError('the flight service did not answer', true);
  }
  if (response.status === 204 || response.status === 404) return [];
  if (response.status === 401 || response.status === 403) {
    throw new FlightServiceError('the flight service refused the key: check it, and that you are subscribed to AeroDataBox on RapidAPI', false);
  }
  if (response.status === 429) {
    throw new FlightServiceError('the flight service says the plan has run out of lookups for now', true);
  }
  if (!response.ok) throw new FlightServiceError(`the flight service answered ${response.status}`, true);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new FlightServiceError('the flight service sent something that was not a flight', true);
  }
  const list = Array.isArray(body) ? (body as ServiceFlight[]) : [];
  const legs: ServiceLeg[] = [];
  for (const f of list) {
    const leg = await toLeg(f);
    if (leg) legs.push(leg);
  }
  return legs.sort((a, b) => a.departs - b.departs);
}
