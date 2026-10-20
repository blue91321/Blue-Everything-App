/**
 * Where an airport is, and what time it is there.
 *
 * Without a flight service the times are typed, and "08:30 at DEN" is only an
 * instant once Denver's zone is known; the map needs every airport's position
 * too. So there is a table of airports by IATA code: the MIT-licensed
 * `mwgg/Airports` list, fetched once the first time it is needed and kept as
 * `data/trips-airports.json`, about 600KB once cut down to the ~7,000 airports
 * that have a code. Not committed, for the reason the voice models are not:
 * it is data from somewhere else, and the app fetches it when it needs it.
 *
 * With a flight service the airports come back with each flight, positions and
 * zones included, so this is only ever the fallback, and a failure to fetch it
 * is said plainly rather than guessed around.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '@everything/server/module-api';
import type { Airport } from './store.js';

const SOURCE = 'https://raw.githubusercontent.com/mwgg/Airports/master/airports.json';
const FILE = join(dataDir, 'trips-airports.json');

/** Kept small on disk: code → [name, city, country, lat, lon, tz]. */
type Row = [string, string, string, number, number, string];

let table: Map<string, Row> | null = null;
let loading: Promise<Map<string, Row>> | null = null;

export class AirportsUnavailable extends Error {}

async function download(): Promise<Map<string, Row>> {
  let response: Response;
  try {
    response = await fetch(SOURCE, { signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new AirportsUnavailable('could not download the airport list, so typed times cannot be placed yet. Check the connection and try again.');
  }
  if (!response.ok) throw new AirportsUnavailable(`the airport list answered ${response.status}`);
  const all = (await response.json()) as Record<string, { iata?: string; name?: string; city?: string; country?: string; lat?: number; lon?: number; tz?: string }>;
  const out: Record<string, Row> = {};
  for (const a of Object.values(all)) {
    const code = (a.iata ?? '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code) || typeof a.lat !== 'number' || typeof a.lon !== 'number' || !a.tz) continue;
    out[code] = [a.name ?? code, a.city ?? '', a.country ?? '', a.lat, a.lon, a.tz];
  }
  mkdirSync(dataDir, { recursive: true });
  const temp = `${FILE}.tmp`;
  writeFileSync(temp, JSON.stringify(out), 'utf8');
  renameSync(temp, FILE);
  return new Map(Object.entries(out));
}

async function load(): Promise<Map<string, Row>> {
  if (table) return table;
  if (!loading) {
    loading = (async () => {
      if (existsSync(FILE)) {
        try {
          return new Map(Object.entries(JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, Row>));
        } catch {
          // A damaged copy is a cache: fetch it again.
        }
      }
      return download();
    })()
      .then((t) => (table = t))
      .finally(() => (loading = null));
  }
  return loading;
}

const toAirport = (iata: string, r: Row): Airport => ({
  iata,
  name: r[0],
  city: r[1],
  country: r[2],
  lat: r[3],
  lon: r[4],
  tz: r[5],
});

/** An airport by its three-letter code, or null when there is no such airport. */
export async function airportByCode(code: string): Promise<Airport | null> {
  const iata = code.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(iata)) return null;
  const row = (await load()).get(iata);
  return row ? toAirport(iata, row) : null;
}

/**
 * Airports for what was typed: the code first if it is one, then cities and
 * names that start with it. For the add form, where nobody remembers that
 * Chicago's other airport is MDW.
 */
export async function searchAirports(query: string, limit = 8): Promise<Airport[]> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const t = await load();
  const exact = t.get(q.toUpperCase());
  const out: Airport[] = exact ? [toAirport(q.toUpperCase(), exact)] : [];
  for (const [code, row] of t) {
    if (out.length >= limit) break;
    if (code === q.toUpperCase()) continue;
    if (row[1].toLowerCase().startsWith(q) || row[0].toLowerCase().startsWith(q)) out.push(toAirport(code, row));
  }
  return out;
}
