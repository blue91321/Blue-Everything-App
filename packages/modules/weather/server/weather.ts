/**
 * The forecast, and the one file it lives in.
 *
 * Open-Meteo, because it needs **no API key and no account**. Every other
 * provider worth using wants a registration, and this module would then have
 * arrived as a screen that could only apologise until you had gone and made one
 * — which is exactly the state the integrations module is in by necessity and
 * this one is in by nobody's choice.
 *
 * ### Where the state lives
 *
 * `data/weather.json`, beside the database rather than in it. A package cannot
 * add a table — migrations are a linear journal and the schema is core's
 * whatever is installed — so a file is not a shortcut here, it is the only
 * option. It holds the place, the two settings, and the last reading.
 *
 * Keeping the **last reading** is what makes "manual only" a usable mode rather
 * than a blank screen: you press the button when you want, and what you saw last
 * stays on screen until you do, labelled with its age.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '@everything/server/module-api';

const STORE = join(dataDir, 'weather.json');

/** How often `daily` will go and look. A day, in the plainest sense. */
export const DAILY_MS = 24 * 60 * 60 * 1000;

export type RefreshMode = 'daily' | 'manual';
export type Units = 'c' | 'f';

export interface Place {
  name: string;
  /** What the geocoder called the region and country, for telling two apart. */
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
  /** WMO weather code, already turned into words — see `describe`. */
  code: number;
  label: string;
  glyph: string;
  isDay: boolean;
  /**
   * The next twenty-four hours, sliced at fetch time.
   *
   * Timestamps are kept rather than only the values, because a reading can be
   * days old in manual mode — a bare array of numbers would be drawn as though
   * it started now, which is the one way this graph could actively mislead.
   */
  hours: Array<{
    /** Local ISO, as the service returned it: `2026-08-22T14:00`. */
    time: string;
    temperature: number;
    /** Percent, or null when the service did not say. */
    rain: number | null;
    isDay: boolean;
    label: string;
    glyph: string;
  }>;
  days: Array<{
    date: string;
    high: number;
    low: number;
    /** Percent, or null when the service did not say. */
    rain: number | null;
    label: string;
    glyph: string;
  }>;
}

interface Store {
  mode: RefreshMode;
  units: Units;
  place: Place | null;
  reading: Reading | null;
  /** When the reading was fetched. Null when there has never been one. */
  fetchedAt: number | null;
  /** Why the last attempt failed, kept so the screen can say rather than blank. */
  error: string | null;
}

const EMPTY: Store = { mode: 'daily', units: 'f', place: null, reading: null, fetchedAt: null, error: null };

export function read(): Store {
  if (!existsSync(STORE)) return { ...EMPTY };
  try {
    const raw = readFileSync(STORE, 'utf8');
    // A byte-order mark is stripped for the same reason `json.ts` strips one:
    // this file is plain enough that somebody will eventually edit it in Notepad.
    const parsed = JSON.parse(raw.startsWith('﻿') ? raw.slice(1) : raw) as Partial<Store>;
    return {
      mode: parsed.mode === 'manual' ? 'manual' : 'daily',
      units: parsed.units === 'c' ? 'c' : 'f',
      place: parsed.place ?? null,
      reading: parsed.reading ?? null,
      fetchedAt: typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : null,
      error: typeof parsed.error === 'string' ? parsed.error : null,
    };
  } catch {
    /*
     * Treated as empty rather than thrown. This file is a cache and two
     * settings; refusing to serve the screen over a stray comma would take away
     * the only place you could fix it.
     */
    return { ...EMPTY };
  }
}

export function write(next: Store): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(STORE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

/**
 * WMO weather codes, as words and a glyph.
 *
 * Mapped **on the server** so there is one table rather than one per surface —
 * the tab, the panel and anything later all render what they are given. The
 * glyph is an emoji for the same reason the overlay avatars are: Windows draws
 * them in colour, and a set of weather icons would be binaries in git.
 */
export function describe(code: number, isDay = true): { label: string; glyph: string } {
  const sun = isDay ? '☀️' : '🌙';
  const partly = isDay ? '⛅' : '☁️';

  if (code === 0) return { label: 'Clear', glyph: sun };
  if (code === 1) return { label: 'Mostly clear', glyph: sun };
  if (code === 2) return { label: 'Partly cloudy', glyph: partly };
  if (code === 3) return { label: 'Overcast', glyph: '☁️' };
  if (code === 45 || code === 48) return { label: 'Fog', glyph: '🌫️' };
  if (code >= 51 && code <= 57) return { label: 'Drizzle', glyph: '🌦️' };
  if (code >= 61 && code <= 65) return { label: 'Rain', glyph: '🌧️' };
  if (code === 66 || code === 67) return { label: 'Freezing rain', glyph: '🌧️' };
  if (code >= 71 && code <= 77) return { label: 'Snow', glyph: '🌨️' };
  if (code >= 80 && code <= 82) return { label: 'Showers', glyph: '🌦️' };
  if (code === 85 || code === 86) return { label: 'Snow showers', glyph: '🌨️' };
  if (code === 95) return { label: 'Thunderstorm', glyph: '⛈️' };
  if (code === 96 || code === 99) return { label: 'Thunderstorm with hail', glyph: '⛈️' };
  // Unknown rather than guessed. A wrong label is worse than an honest shrug.
  return { label: `Code ${code}`, glyph: '❓' };
}

/** Anything the service says that is not JSON, or not the shape expected. */
export class WeatherError extends Error {}

async function getJson<T>(url: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
      // Bounded, because this runs inside a request the screen is waiting on.
      signal: AbortSignal.timeout(12_000),
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'the request failed';
    throw new WeatherError(
      /timeout|abort/i.test(message) ? 'the weather service did not answer in time' : `could not reach the weather service (${message})`
    );
  }
  if (!response.ok) throw new WeatherError(`the weather service answered ${response.status}`);
  try {
    return (await response.json()) as T;
  } catch {
    throw new WeatherError('the weather service sent something that was not JSON');
  }
}

interface GeoHit {
  name: string;
  latitude: number;
  longitude: number;
  timezone?: string;
  country?: string;
  admin1?: string;
}

/**
 * Turn a place you can type into coordinates.
 *
 * Asking for latitude and longitude would have been less code and is the wrong
 * trade: nobody knows their own, so the setup step would be "go and look it up
 * somewhere else", which is the friction this app removes everywhere it can.
 */
export async function findPlaces(query: string): Promise<Place[]> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=5&language=en&format=json`;
  const body = await getJson<{ results?: GeoHit[] }>(url);

  return (body.results ?? []).map((hit) => ({
    name: hit.name,
    // Region and country, so two places of the same name are told apart — which
    // is most of the reason to show a list rather than take the first hit.
    detail: [hit.admin1, hit.country].filter(Boolean).join(', '),
    latitude: hit.latitude,
    longitude: hit.longitude,
    timezone: hit.timezone ?? 'auto',
  }));
}

export interface Forecast {
  current?: {
    temperature_2m?: number;
    apparent_temperature?: number;
    relative_humidity_2m?: number;
    wind_speed_10m?: number;
    weather_code?: number;
    is_day?: number;
  };
  hourly?: {
    time?: string[];
    temperature_2m?: (number | null)[];
    precipitation_probability?: (number | null)[];
    weather_code?: (number | null)[];
    is_day?: (number | null)[];
  };
  daily?: {
    time?: string[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: (number | null)[];
    weather_code?: number[];
  };
}

/** How many hours the graph shows. A day, so it reads as "the rest of today". */
export const HOURLY_SPAN = 24;

/**
 * The next twenty-four hours, starting from the one we are in.
 *
 * Open-Meteo returns the whole forecast range starting at local midnight, so
 * most of what comes back is already in the past. Which hour is "now" is the
 * only interesting part of this, and it is not a subtraction:
 *
 * The timestamps are **local to the place**, with no offset on them —
 * `2026-08-22T14:00` means two in the afternoon *there*. Parsing that with
 * `new Date()` gets a value in the *server's* zone, so comparing it against
 * `Date.now()` is only correct while the two happen to agree. It would work all
 * year in Philadelphia and be five hours out for a place in London, which is
 * exactly the kind of bug that never shows up on the machine it was written on.
 *
 * So the current hour is found by asking `Intl` what time it is *there*, and
 * matching the string. String matching looks crude next to date arithmetic and
 * is the thing that is actually correct here, because the strings are the
 * authority.
 */
export function sliceHours(
  hourly: Forecast['hourly'],
  timezone: string,
  now = new Date()
): Reading['hours'] {
  const times = hourly?.time ?? [];
  if (times.length === 0) return [];

  let start = 0;
  try {
    /*
     * `sv-SE` because its date format is ISO — a formatter that already emits
     * `2026-08-22 14:00` rather than one whose parts have to be reassembled by
     * hand, which is how the month and day end up swapped.
     */
    const there = new Intl.DateTimeFormat('sv-SE', {
      timeZone: timezone === 'auto' ? undefined : timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
    }).format(now);
    const stamp = `${there.slice(0, 10)}T${there.slice(11, 13)}`;

    const found = times.findIndex((time) => time.startsWith(stamp));
    // Not found means the service sent a range that does not contain now, which
    // should not happen — falling back to the beginning shows real hours with
    // real labels rather than nothing at all.
    if (found >= 0) start = found;
  } catch {
    // An unknown time zone. Same fallback, same reasoning.
  }

  return times.slice(start, start + HOURLY_SPAN).map((time, i) => {
    const at = start + i;
    const isDay = (hourly?.is_day?.[at] ?? 1) !== 0;
    const described = describe(hourly?.weather_code?.[at] ?? -1, isDay);
    return {
      time,
      temperature: Math.round(hourly?.temperature_2m?.[at] ?? 0),
      rain: hourly?.precipitation_probability?.[at] ?? null,
      isDay,
      label: described.label,
      glyph: described.glyph,
    };
  });
}

/** Go and look. The only function here that touches the network for a forecast. */
export async function fetchReading(place: Place, units: Units): Promise<Reading> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
    '&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,is_day' +
    '&hourly=temperature_2m,precipitation_probability,weather_code,is_day' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
    `&timezone=${encodeURIComponent(place.timezone)}&forecast_days=4` +
    `&temperature_unit=${units === 'f' ? 'fahrenheit' : 'celsius'}` +
    `&wind_speed_unit=${units === 'f' ? 'mph' : 'kmh'}`;

  const body = await getJson<Forecast>(url);
  const now = body.current;
  if (!now || typeof now.temperature_2m !== 'number') {
    throw new WeatherError('the weather service sent no current conditions');
  }

  const isDay = now.is_day !== 0;
  const described = describe(now.weather_code ?? -1, isDay);

  const daily = body.daily ?? {};
  const dates = daily.time ?? [];
  const days = dates.slice(0, 4).map((date, i) => {
    // Daylight glyphs for a forecast day: a moon beside tomorrow's high would
    // be nonsense.
    const forecast = describe(daily.weather_code?.[i] ?? -1, true);
    return {
      date,
      high: Math.round(daily.temperature_2m_max?.[i] ?? 0),
      low: Math.round(daily.temperature_2m_min?.[i] ?? 0),
      rain: daily.precipitation_probability_max?.[i] ?? null,
      label: forecast.label,
      glyph: forecast.glyph,
    };
  });

  return {
    hours: sliceHours(body.hourly, place.timezone),
    temperature: Math.round(now.temperature_2m),
    feelsLike: Math.round(now.apparent_temperature ?? now.temperature_2m),
    humidity: Math.round(now.relative_humidity_2m ?? 0),
    windSpeed: Math.round(now.wind_speed_10m ?? 0),
    code: now.weather_code ?? -1,
    label: described.label,
    glyph: described.glyph,
    isDay,
    days,
  };
}

/**
 * Fetch and record, whatever happens.
 *
 * A failure is **stored rather than thrown away**, next to the reading it failed
 * to replace. That is what lets the screen show yesterday's weather *and* say
 * why it is yesterday's — the two together being far more use than either a
 * blank screen or a stale number with nothing admitting it is stale.
 */
export async function refresh(): Promise<Store> {
  const store = read();
  if (!store.place) return store;

  try {
    const reading = await fetchReading(store.place, store.units);
    const next: Store = { ...store, reading, fetchedAt: Date.now(), error: null };
    write(next);
    return next;
  } catch (error) {
    const next: Store = { ...store, error: error instanceof Error ? error.message : 'the fetch failed' };
    write(next);
    return next;
  }
}

/**
 * Is it time to go and look?
 *
 * **Only ever true in `daily` mode.** "Manual" has to mean it or it is not a
 * setting worth having — the same rule the quiet-hours switch follows.
 */
export function isDue(store: Store, now = Date.now()): boolean {
  if (store.mode !== 'daily') return false;
  if (!store.place) return false;
  if (store.fetchedAt === null) return true;
  return now - store.fetchedAt >= DAILY_MS;
}
