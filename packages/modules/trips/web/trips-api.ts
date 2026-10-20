/**
 * The trips screen's client, and the few words and times it shows.
 *
 * Times are shown at the airport they belong to, which is how a boarding pass,
 * a departures board and the airline's app all show them: "leaves 8:30" means
 * 8:30 in Denver whether this phone is in Denver yet or not. The zone is the
 * airport's, sent with every flight.
 */
import { apiRequest } from '@app/api';

export interface Airport {
  iata: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  tz: string;
}

export interface Live {
  status: string | null;
  departs: number;
  arrives: number;
  gate: string | null;
  terminal: string | null;
  arrivalGate: string | null;
  arrivalTerminal: string | null;
  baggageBelt: string | null;
  aircraft: string | null;
}

export type LinkState = 'made' | 'deleted' | 'none';

export interface Flight {
  id: string;
  number: string;
  date: string;
  airline: string | null;
  from: Airport;
  to: Airport;
  departs: number;
  arrives: number;
  confirmation: string | null;
  seat: string | null;
  notes: string | null;
  filledBy: 'service' | 'typed';
  live: Live | null;
  checkedAt: number | null;
  checkError: string | null;
  nextCheckAt: number | null;
  international: boolean;
  tasks: { checkIn: LinkState; leave: LinkState };
  route: Array<[number, number]>;
}

export type PlaceKind = 'stay' | 'visit' | 'food' | 'other';

export interface Place {
  id: string;
  name: string;
  address: string | null;
  lat: number;
  lon: number;
  kind: PlaceKind;
  date: string | null;
  notes: string | null;
}

export interface ChecklistItem {
  id: string;
  text: string;
  offsetDays: number | null;
  when: string;
  task: LinkState;
}

export interface Trip {
  id: string;
  name: string;
  start: string | null;
  end: string | null;
  typedStart: string | null;
  typedEnd: string | null;
  notes: string | null;
  flights: Flight[];
  places: Place[];
  checklist: ChecklistItem[];
}

export interface Settings {
  checkInTask: boolean;
  leaveTask: boolean;
  checkInHours: number;
  leaveDomesticMinutes: number;
  leaveInternationalMinutes: number;
  alerts: boolean;
  monthlyBudget: number;
}

export interface TripsState {
  trips: Trip[];
  settings: Settings;
  hasKey: boolean;
  usage: { month: string; used: number; budget: number };
}

export interface FoundPlace {
  name: string;
  address: string;
  lat: number;
  lon: number;
}

export interface NewFlight {
  number: string;
  date: string;
  /** Which leg, when the number flies several that day. */
  leg?: number;
  /** Use the typed airports and times rather than asking the service. */
  manual?: boolean;
  from?: string;
  to?: string;
  departTime?: string;
  arriveTime?: string;
  arriveDate?: string;
  confirmation?: string;
  seat?: string;
}

/** A flight, a choice of legs, or a request for the times. See the route. */
export type AddResult =
  | { flight: Flight }
  | { legs: Array<{ index: number; from: string; to: string; departs: number; tz: string }> }
  | { needsTimes: string };

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

export const trips = {
  get: () => apiRequest<TripsState>('/api/trips'),
  create: (body: { name: string; start?: string | null; end?: string | null }) =>
    apiRequest<Trip>('/api/trips', { method: 'POST', ...json(body) }),
  update: (id: string, body: Partial<{ name: string; start: string | null; end: string | null; notes: string | null }>) =>
    apiRequest<Trip>(`/api/trips/${id}`, { method: 'PATCH', ...json(body) }),
  remove: (id: string) => apiRequest<{ ok: true }>(`/api/trips/${id}`, { method: 'DELETE' }),

  addFlight: (tripId: string, body: NewFlight) =>
    apiRequest<AddResult>(`/api/trips/${tripId}/flights`, { method: 'POST', ...json(body) }),
  editFlight: (tripId: string, flightId: string, body: Partial<{ confirmation: string; seat: string; notes: string }>) =>
    apiRequest<Flight>(`/api/trips/${tripId}/flights/${flightId}`, { method: 'PATCH', ...json(body) }),
  removeFlight: (tripId: string, flightId: string) =>
    apiRequest<{ ok: true }>(`/api/trips/${tripId}/flights/${flightId}`, { method: 'DELETE' }),
  refreshFlight: (tripId: string, flightId: string) =>
    apiRequest<Flight>(`/api/trips/${tripId}/flights/${flightId}/refresh`, { method: 'POST', body: '{}' }),
  airports: (q: string) => apiRequest<{ airports: Airport[] }>(`/api/trips/airports?q=${encodeURIComponent(q)}`),

  searchPlaces: (q: string) => apiRequest<{ places: FoundPlace[] }>(`/api/trips/places/search?q=${encodeURIComponent(q)}`),
  addPlace: (tripId: string, body: FoundPlace & { kind: PlaceKind; date?: string | null }) =>
    apiRequest<Place>(`/api/trips/${tripId}/places`, { method: 'POST', ...json(body) }),
  editPlace: (tripId: string, placeId: string, body: Partial<Pick<Place, 'name' | 'kind' | 'date' | 'notes'>>) =>
    apiRequest<Place>(`/api/trips/${tripId}/places/${placeId}`, { method: 'PATCH', ...json(body) }),
  removePlace: (tripId: string, placeId: string) =>
    apiRequest<{ ok: true }>(`/api/trips/${tripId}/places/${placeId}`, { method: 'DELETE' }),

  addItem: (tripId: string, body: { text: string; offsetDays: number | null }) =>
    apiRequest<{ ok: true }>(`/api/trips/${tripId}/checklist`, { method: 'POST', ...json(body) }),
  removeItem: (tripId: string, itemId: string) =>
    apiRequest<{ ok: true }>(`/api/trips/${tripId}/checklist/${itemId}`, { method: 'DELETE' }),

  settings: (body: Partial<Settings> & { apiKey?: string }) =>
    apiRequest<TripsState>('/api/trips/settings', { method: 'PUT', ...json(body) }),
};

/* ---------------------------------------------------------------- */

/** "8:30 AM" at that airport. */
export function timeAt(at: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(at));
  } catch {
    return new Date(at).toLocaleTimeString();
  }
}

/** "Wed 4 Nov" at that airport. */
export function dayAt(at: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(
      new Date(at)
    );
  } catch {
    return new Date(at).toLocaleDateString();
  }
}

/** "Wed 4 Nov" for a "YYYY-MM-DD", read as that calendar day wherever this device is. */
export function dayOf(date: string | null): string {
  if (!date) return '';
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** "UA123" → "UA 123". */
export function spaced(number: string): string {
  const m = /^([A-Z0-9]{2,3}?)(\d{1,4}[A-Z]?)$/.exec(number);
  return m ? `${m[1]} ${m[2]}` : number;
}

/** "in 3 hours", "in 2 days", "20 minutes ago". */
export function fromNow(at: number, now = Date.now()): string {
  const ms = at - now;
  const ago = ms < 0;
  const m = Math.round(Math.abs(ms) / 60_000);
  let text: string;
  if (m < 1) return 'now';
  if (m < 60) text = `${m} minute${m === 1 ? '' : 's'}`;
  else if (m < 48 * 60) {
    const h = Math.round(m / 60);
    text = `${h} hour${h === 1 ? '' : 's'}`;
  } else {
    const d = Math.round(m / 1440);
    text = `${d} day${d === 1 ? '' : 's'}`;
  }
  return ago ? `${text} ago` : `in ${text}`;
}

const STATUS: Record<string, string> = {
  Unknown: 'no status yet',
  Expected: 'on schedule',
  CheckIn: 'check-in open',
  Boarding: 'boarding',
  GateClosed: 'gate closed',
  Departed: 'departed',
  EnRoute: 'in the air',
  Delayed: 'delayed',
  Approaching: 'landing soon',
  Arrived: 'landed',
  Canceled: 'cancelled',
  CanceledUncertain: 'may be cancelled',
  Diverted: 'diverted',
};

export function statusText(status: string | null | undefined): string | null {
  return status ? (STATUS[status] ?? status) : null;
}

/** Bad news, drawn in the warning colour. */
export function statusIsBad(f: Flight): boolean {
  const s = f.live?.status;
  if (s === 'Canceled' || s === 'CanceledUncertain' || s === 'Diverted' || s === 'Delayed') return true;
  return f.live !== null && f.live.departs - f.departs >= 15 * 60_000;
}

export const KIND_LABEL: Record<PlaceKind, string> = { stay: 'Stay', visit: 'See', food: 'Eat', other: 'Other' };
export const KIND_GLYPH: Record<PlaceKind, string> = { stay: '🛏', visit: '📍', food: '🍴', other: '•' };
