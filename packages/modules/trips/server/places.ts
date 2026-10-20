/**
 * Finding a place by name or address, for the map.
 *
 * OpenStreetMap's Nominatim, which needs no account and no key, and asks two
 * things of anybody using it: say who you are in the User-Agent, and no more
 * than one request a second. A browser cannot set a User-Agent, which is why
 * this is asked from the server; the second is a queue, below. A search is run
 * when you press the button, never per keystroke, so the queue is almost never
 * more than one deep.
 */
const SEARCH = 'https://nominatim.openstreetmap.org/search';
const AGENT = 'BlueEverything/0.5 (personal trip planner)';

export interface FoundPlace {
  name: string;
  address: string;
  lat: number;
  lon: number;
}

export class PlaceSearchError extends Error {}

let last = 0;
let queue: Promise<unknown> = Promise.resolve();

/** Runs `fn` no sooner than a second after the last request began. */
function politely<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(async () => {
    const wait = last + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    return fn();
  });
  queue = next.catch(() => undefined);
  return next;
}

export function searchPlaces(query: string): Promise<FoundPlace[]> {
  return politely(async () => {
    const url = `${SEARCH}?format=jsonv2&limit=6&q=${encodeURIComponent(query)}`;
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { 'User-Agent': AGENT, 'Accept-Language': 'en' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new PlaceSearchError('the place search did not answer');
    }
    if (!response.ok) throw new PlaceSearchError(`the place search answered ${response.status}`);
    const rows = (await response.json()) as Array<{ name?: string; display_name?: string; lat?: string; lon?: string }>;
    return rows
      .map((r) => {
        const lat = Number(r.lat);
        const lon = Number(r.lon);
        const address = r.display_name ?? '';
        return {
          name: r.name?.trim() || address.split(',')[0]?.trim() || query,
          address,
          lat,
          lon,
        };
      })
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  });
}
