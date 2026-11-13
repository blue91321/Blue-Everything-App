/**
 * Every name a series goes by, for finding it on other sources (2026-11-12).
 *
 * Sources list a series under different names: Atsumaru calls one *MMO! Jiyuu
 * ni Game wo Kouryaku Shitara Ningen Banare Shitemashita*, and Thunder Scans
 * (who translate it), MangaHub and MangaDex's English entry call it *MMO!
 * Playing the Game Freely Led to Superhuman Abilities*. Searching only the name
 * the library knows found none of those three, and 3 of 912 series here had any
 * other name stored. So the other names are asked of MangaDex, whose record
 * carries a series' English and romanised titles together, and kept on this PC
 * for a month (`data/manga-names.json`, by `titleKey`): one request per series
 * a month at most, and only when something goes looking for a source.
 *
 * Only names in Latin script are kept for searching: the sources here search
 * in English, and a Japanese or Korean title sent to them finds nothing or
 * finds noise. Every search and every match in this package that is about
 * "is this the same series" goes through `namesFor`: the comparison screen,
 * reading a chapter from another source, Find sources, Switch sources and the
 * switch after two days of failures.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from '@everything/server/module-api';
import { namesOnMangaDex, type NamedRecord } from './mangadex.js';
import { titleKey } from './titles.js';

const FILE = join(dataDir, 'manga-names.json');
/** How long a lookup is kept. Names change rarely; a new English licence title is the usual reason. */
export const NAMES_FRESH_MS = 30 * 24 * 60 * 60 * 1000;
/** How long a failed lookup waits before asking again. */
export const NAMES_RETRY_MS = 24 * 60 * 60 * 1000;
/** How many of the names a search asks every source for: each is a search of every source. */
export const SEARCH_NAMES = 3;

type Entry = { names: string[]; at: number; failed?: boolean };

/** A name in a script the sources here can search (no kana, kanji, hangul, Cyrillic, Thai, Arabic or Hebrew). */
export const isLatin = (name: string): boolean =>
  !/[Ѐ-ӿ֐-ۿ฀-๿ᄀ-ᇿ぀-ヿ㐀-鿿가-힯豈-﫿ｦ-ﾟ]/.test(name);

/** Names in order with each spelling once, by `titleKey`; blanks dropped. */
export function uniqueNames(names: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw?.trim();
    const key = name ? titleKey(name) : '';
    if (!name || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * From MangaDex's answers, the names of the one that is this series: the
 * record one of whose names is a name already known (by `titleKey`). Strict for
 * the import's reason: a near miss is another series' names, and searching by
 * those finds that series. English first, then the rest, Latin script only.
 */
export function namesFromRecords(known: readonly string[], records: readonly NamedRecord[]): string[] {
  const keys = new Set(known.map(titleKey).filter(Boolean));
  const record = records.find((r) => r.names.some((n) => keys.has(titleKey(n))));
  if (!record) return [];
  return uniqueNames([record.english, ...record.names]).filter(isLatin);
}

/** What a search asks every source for: the known name first, then the others, Latin script, up to `SEARCH_NAMES`. */
export function searchQueries(names: readonly string[]): string[] {
  return uniqueNames(names)
    .filter(isLatin)
    .slice(0, SEARCH_NAMES);
}

let cache: Record<string, Entry> | null = null;
const asking = new Map<string, Promise<string[]>>();

function load(): Record<string, Entry> {
  if (cache) return cache;
  try {
    const raw = readFileSync(FILE, 'utf8').replace(/^﻿/, '');
    cache = JSON.parse(raw) as Record<string, Entry>;
  } catch {
    // Missing or unreadable: a cache, so it starts again rather than refusing.
    cache = {};
  }
  return cache;
}

function save(): void {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache ?? {}));
    renameSync(tmp, FILE);
  } catch {
    // Known for this run only.
  }
}

/**
 * Every name the series goes by: its own title, the names given (old names,
 * the source's title), then MangaDex's for it. Asked of MangaDex at most once a
 * month per series (once a day after a failure), the same lookup shared by
 * whoever asks at once. Never throws: without MangaDex, the names known.
 */
export async function namesFor(title: string, known: ReadonlyArray<string | null | undefined> = [], now = Date.now()): Promise<string[]> {
  const own = uniqueNames([title, ...known]);
  const key = titleKey(title);
  if (!key) return own;
  const entry = load()[key];
  const fresh = entry && now - entry.at < (entry.failed ? NAMES_RETRY_MS : NAMES_FRESH_MS);
  let found: string[];
  if (fresh) {
    found = entry.names;
  } else {
    let job = asking.get(key);
    if (!job) {
      job = (async () => {
        try {
          const names = namesFromRecords(own, await namesOnMangaDex(title));
          load()[key] = { names, at: Date.now() };
          return names;
        } catch {
          load()[key] = { names: entry?.names ?? [], at: Date.now(), failed: true };
          return entry?.names ?? [];
        } finally {
          save();
          asking.delete(key);
        }
      })();
      asking.set(key, job);
    }
    found = await job;
  }
  return uniqueNames([...own, ...found]);
}

/** The `titleKey`s of every name, for "is this result the same series". */
export const nameKeys = (names: readonly string[]): Set<string> => new Set(names.map(titleKey).filter(Boolean));
