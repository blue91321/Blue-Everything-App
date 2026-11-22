/**
 * Linked servers' chapter catalogues and ratings, as this server last fetched
 * them (2026-11-21). See `peers.ts` in the server for the link itself, and
 * `routes/peers.ts` for what is shared.
 *
 * **Their catalogue is counts, keyed by source and name.** Suwayomi's ids are
 * one install's own, so theirs mean nothing here. What two installs do agree
 * on is a source's id (an extension's source id is worked out from its name,
 * language and version, the same everywhere) and a series' name on that source.
 * So a copy they counted is `<source id>|<titleKey(name)>`, and is laid over
 * the copy this server knows by the same source and name (`overlay` in
 * `catalogue.ts`): a count of theirs newer than this one's is used, said to be
 * theirs, and spares this server asking the site again.
 *
 * Fetched at most every six hours per server, from the sweep, and only from a
 * server that shares it. Kept in `data/manga-peer-catalogue.json`, so a restart
 * does not ask again; a server no longer linked, or no longer sharing, is
 * dropped from it.
 *
 * No imports from `catalogue.ts`, which imports this.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, freshPeer, linkedPeers, peerJson, writeFileAtomic } from '@everything/server/module-api';
import { titleKey } from './titles.js';

export interface PeerProfile {
  entries: number;
  distinct: number;
  first: number | null;
  latest: number | null;
  missing: number;
  newestUpload: number | null;
}

/** One copy as a linked server counted it. */
export interface PeerCopy {
  /** Source id, the same on every install. */
  s: string;
  /** The series' name on that source. */
  t: string;
  p: PeerProfile;
  at: number;
}

interface Stored {
  [linkId: string]: { at: number; name: string; sources: Record<string, string>; copies: PeerCopy[] };
}

const FILE = () => join(dataDir, 'manga-peer-catalogue.json');
const EVERY_MS = 6 * 60 * 60_000;
/** A linked server's whole catalogue: generous for tens of thousands of copies, and no more. */
const MAX_BYTES = 16 * 1024 * 1024;

let stored: Stored | null = null;
/** `<source id>|<title key>` → the newest count any linked server has of it. */
let byKey: Map<string, PeerCopy & { via: string; sourceName: string }> | null = null;

function load(): Stored {
  if (stored) return stored;
  try {
    stored = existsSync(FILE()) ? (JSON.parse(readFileSync(FILE(), 'utf8')) as Stored) : {};
  } catch {
    stored = {};
  }
  return stored;
}

function rebuild(): void {
  const map = new Map<string, PeerCopy & { via: string; sourceName: string }>();
  for (const entry of Object.values(load())) {
    for (const c of entry.copies) {
      const key = `${c.s}|${titleKey(c.t)}`;
      const had = map.get(key);
      if (!had || had.at < c.at) map.set(key, { ...c, via: entry.name, sourceName: entry.sources[c.s] ?? c.s });
    }
  }
  byKey = map;
}

/** The newest count a linked server has of this source's copy by this name. */
export function peerCount(sourceId: string, key: string): (PeerCopy & { via: string; sourceName: string }) | null {
  if (!byKey) rebuild();
  return byKey!.get(`${sourceId}|${key}`) ?? null;
}

/** Every linked server's copies of a series by these names, for a source this server knows nothing about. */
export function peerCopiesFor(keys: ReadonlySet<string>): Array<PeerCopy & { via: string; sourceName: string }> {
  if (!byKey) rebuild();
  const out = [];
  for (const [k, c] of byKey!) if (keys.has(k.slice(k.indexOf('|') + 1))) out.push(c);
  return out;
}

const cleanProfile = (v: unknown): PeerProfile | null => {
  const p = v as Partial<Record<keyof PeerProfile, unknown>> | null;
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  if (!p || num(p.distinct) === null || num(p.entries) === null) return null;
  return { entries: num(p.entries)!, distinct: num(p.distinct)!, first: num(p.first), latest: num(p.latest), missing: num(p.missing) ?? 0, newestUpload: num(p.newestUpload) };
};

/**
 * Fetch the catalogues of linked servers that share one and were not fetched
 * in six hours; drop those no longer linked or sharing. From the sweep.
 */
export async function refreshPeerCatalogues(now = Date.now()): Promise<number> {
  const data = load();
  const links = linkedPeers();
  let changed = false;
  for (const id of Object.keys(data)) {
    if (!links.some((l) => l.id === id)) {
      delete data[id];
      changed = true;
    }
  }
  let fetched = 0;
  for (const link of links) {
    const fresh = await freshPeer(link.id);
    if (!fresh?.theirs?.share.catalogue) {
      if (data[link.id]) {
        delete data[link.id];
        changed = true;
      }
      continue;
    }
    if (data[link.id] && now - data[link.id]!.at < EVERY_MS) continue;
    const got = await peerJson<{ sources?: unknown; copies?: unknown }>(fresh, '/api/peer/manga/catalogue', { maxBytes: MAX_BYTES, timeoutMs: 60_000 });
    if ('error' in got) continue;
    const sources: Record<string, string> = {};
    for (const s of Array.isArray(got.sources) ? got.sources : []) {
      const v = s as { id?: unknown; name?: unknown };
      if (typeof v.id === 'string' && /^\d{1,25}$/.test(v.id) && typeof v.name === 'string') sources[v.id] = v.name.slice(0, 80);
    }
    const copies: PeerCopy[] = [];
    for (const c of Array.isArray(got.copies) ? got.copies : []) {
      const v = c as { s?: unknown; t?: unknown; p?: unknown; at?: unknown };
      const p = cleanProfile(v.p);
      // Nothing from the future: a clock running fast would win every comparison for ever.
      if (typeof v.s !== 'string' || !/^\d{1,25}$/.test(v.s) || typeof v.t !== 'string' || !p || typeof v.at !== 'number' || v.at > now + 60_000) continue;
      copies.push({ s: v.s, t: v.t.slice(0, 300), p, at: v.at });
    }
    data[link.id] = { at: now, name: fresh.name, sources, copies };
    changed = true;
    fetched += 1;
  }
  if (changed) {
    writeFileAtomic(FILE(), JSON.stringify(data));
    rebuild();
  }
  return fetched;
}

/** How many copies each linked server's catalogue gave, for the card. */
export function peerCatalogueSummary(): Array<{ name: string; copies: number; at: number }> {
  return Object.values(load()).map((e) => ({ name: e.name, copies: e.copies.length, at: e.at }));
}

/* ---- ratings ---- */

export interface PeerRating {
  /** Every name the series goes by there, as title keys. */
  keys: string[];
  muId: number | null;
  rating: number;
}

const ratingsCache = new Map<string, { at: number; ratings: PeerRating[] }>();
const RATINGS_EVERY_MS = 60 * 60_000;

/** What linked servers that share ratings gave a series, matched by MangaUpdates id, else by a name. */
export async function peerRatingsOf(muId: number | null, keys: ReadonlySet<string>): Promise<Array<{ who: string; rating: number }>> {
  const out: Array<{ who: string; rating: number }> = [];
  for (const link of linkedPeers()) {
    const fresh = await freshPeer(link.id);
    if (!fresh?.theirs?.share.ratings) continue;
    let cached = ratingsCache.get(link.id);
    if (!cached || Date.now() - cached.at > RATINGS_EVERY_MS) {
      const got = await peerJson<{ ratings?: unknown }>(fresh, '/api/peer/manga/ratings', { timeoutMs: 10_000 });
      const ratings: PeerRating[] = [];
      if (!('error' in got)) {
        for (const r of Array.isArray(got.ratings) ? got.ratings : []) {
          const v = r as { keys?: unknown; muId?: unknown; rating?: unknown };
          if (typeof v.rating !== 'number' || !Number.isInteger(v.rating) || v.rating < 1 || v.rating > 10) continue;
          ratings.push({
            keys: Array.isArray(v.keys) ? v.keys.filter((k): k is string => typeof k === 'string').slice(0, 10) : [],
            muId: typeof v.muId === 'number' && Number.isInteger(v.muId) ? v.muId : null,
            rating: v.rating,
          });
        }
      }
      cached = { at: Date.now(), ratings };
      ratingsCache.set(link.id, cached);
    }
    const match = cached.ratings.find((r) => (muId !== null && r.muId === muId) || r.keys.some((k) => keys.has(k)));
    if (match) out.push({ who: `${fresh.name} (linked)`, rating: match.rating });
  }
  return out;
}
