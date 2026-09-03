/**
 * Talking to this package's own endpoints.
 *
 * Its own thin client rather than entries on `api` in core, because core must
 * not know a package exists — the same rule that keeps `hidden_providers` an
 * opaque slug and `tasks.source` an unvalidated string. What it borrows from
 * core is `getToken`, since every `/api/` call needs the bearer token and there
 * is no sense keeping a second copy of where it is stored.
 */
import { getToken } from '@app/api';

export type RefreshMode = 'hourly' | 'daily' | 'manual';
export type Units = 'c' | 'f';

export interface Place {
  name: string;
  detail: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

export interface Reading {
  temperature: number;
  feelsLike: number;
  humidity: number;
  windSpeed: number;
  code: number;
  label: string;
  glyph: string;
  isDay: boolean;
  /** The next 24 hours as the server sliced them. Empty on an older reading. */
  hours: Array<{
    time: string;
    temperature: number;
    feelsLike?: number | null;
    rain: number | null;
    isDay: boolean;
    label: string;
    glyph: string;
  }>;
  days: Array<{ date: string; high: number; low: number; rain: number | null; label: string; glyph: string }>;
}

export interface WeatherState {
  mode: RefreshMode;
  units: Units;
  place: Place | null;
  reading: Reading | null;
  /**
   * What it is doing *now*, read forward out of the stored hours.
   *
   * In `daily` mode the fetched reading is a morning temperature still being
   * shown in the afternoon; this is that afternoon's hour out of the same
   * forecast, at no extra request. `forecast` says whether it is an expectation
   * or the measurement the fetch actually took.
   *
   * Optional because the server and the PWA update independently — an older
   * server sends none, and both screens fall back to the reading itself.
   */
  now?: {
    temperature: number;
    /** Null when the stored hour predates the field — say nothing rather than guess. */
    feelsLike: number | null;
    label: string;
    glyph: string;
    isDay: boolean;
    forecast: boolean;
  } | null;
  fetchedAt: number | null;
  error: string | null;
  due: boolean;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      authorization: `Bearer ${getToken()}`,
      ...init.headers,
    },
  });

  if (!response.ok) {
    /*
     * The server's own words when it sent any — core's `errorMessage` makes the
     * same choice, and for the same reason: "the weather service answered 503"
     * is the difference between knowing what happened and seeing a status code.
     */
    let message = `that failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === 'string' && body.error.trim() !== '') message = body.error;
    } catch {
      // Not JSON. The status stands.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export const weather = {
  get: () => call<WeatherState>('/api/weather'),
  /** The manual button. Present in both modes — see the note in the routes. */
  refreshNow: () => call<WeatherState>('/api/weather/refresh', { method: 'POST', body: '{}' }),
  search: (query: string) => call<{ places: Place[] }>(`/api/weather/search?q=${encodeURIComponent(query)}`),
  setPlace: (place: Place) => call<WeatherState>('/api/weather/place', { method: 'PUT', body: JSON.stringify(place) }),
  update: (patch: { mode?: RefreshMode; units?: Units }) =>
    call<WeatherState>('/api/weather', { method: 'PATCH', body: JSON.stringify(patch) }),
};

/** "3 hours ago", or "never". Kept here so the tab and the panel agree. */
export function ageOf(fetchedAt: number | null, now = Date.now()): string {
  if (fetchedAt === null) return 'never';
  const minutes = Math.floor((now - fetchedAt) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** Mon, Tue… from the service's `YYYY-MM-DD`, in the browser's own locale. */
export function dayName(date: string, todayAt = Date.now()): string {
  // Parsed as local rather than UTC: `new Date('2026-08-22')` is midnight UTC,
  // which is the *previous* day for anybody west of Greenwich — so the forecast
  // would be labelled a day early for exactly the person this app is for.
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  const when = new Date(y, m - 1, d);
  const today = new Date(todayAt);
  if (when.toDateString() === today.toDateString()) return 'Today';
  return when.toLocaleDateString(undefined, { weekday: 'short' });
}
