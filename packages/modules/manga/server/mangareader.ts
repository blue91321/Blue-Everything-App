/**
 * Bringing a library in from Manga Reader (the iOS app), by its iMazing backup.
 *
 * iMazing's "Back Up" on an app writes a `.imazingapp`: a zip of the app's
 * container. Manga Reader keeps its state in three `NSKeyedArchiver` files in
 * `Documents` — `comicBooks.dat` (favourites), `comicHistroy.dat` (everything
 * ever opened; the spelling is the app's) and `comicDownloaded.dat` — each a
 * list of `ComicBookItem`s. `bplist.ts` reads them; this decides what they mean.
 *
 * ### What is brought in, and from which file
 *
 * **Favourites are the library.** History is 2,000-odd series opened once and
 * left, and following every one of those would bury the ones you chose to keep.
 *
 * **Progress comes from history, across every site.** Every favourite is in
 * history too, and only history carries `readedChSet`, the chapters read — the
 * favourite's own set was empty on all 898. And history keeps a record *per
 * site*: on the real backup, one favourite pointed at atsu at chapter 139 while
 * the same series had been read to 140 on mangahere since, a record that
 * existed only in history. So every history record with the same title is
 * joined in: read chapters from all of them, where you are from the most
 * recent, and every site it was read on, newest first, for `matching.ts` to try.
 *
 * **Read means what Manga Reader showed as read**, which is every chapter you
 * opened — including the one you were partway through, which is in the set on
 * every record. So the Continue card offers the chapter after it. A page within
 * that chapter is not brought across: it counts pages of another site's copy,
 * which is the case the reader already declines to guess about.
 *
 * **Chapter names that are not chapter numbers are dropped** — "Notice",
 * "Coming-Soon", "Vol 3_17": 387 of 37,489 on the real backup. `22-1` counts as
 * chapter 22, since it is the first part of it.
 *
 * **One entry per series in the read log**, the chapter you were on and when,
 * rather than a record per chapter with dates nobody kept. That is what History
 * shows, and it is what the old app's History showed too.
 *
 * ### Nothing points at a source yet
 *
 * The backup names a site and a title, never an id anybody else can use — its
 * URLs are Manga Reader's own mirror. So a series arrives unlinked, carrying an
 * `origin` that says where it was read, and `matching.ts` finds it on one of
 * your installed sources afterwards. Until then the old app's newest chapter
 * stands in for the NEW badge, and nothing is checked for new chapters, since
 * an unlinked series with no MangaUpdates id has nothing to ask.
 */
import { readZip, type ZipEntry } from '@everything/server/module-api';
import { unarchive, PlistError } from './bplist.js';
import { chapterValue } from './identity.js';
import { groupKey } from './browse.js';
import { newSeries, type ReadRecord, type Series, type Store } from './library.js';
import type { SeriesStatus } from './identity.js';

export class ImportRefused extends Error {}

/** One series as Manga Reader knew it. */
export type OldSeries = {
  title: string;
  /** The site it was last read on, as the app named it: `mangakakalot`, `mangafire`. */
  site: string;
  /** Every site it was read on, most recently read first. `site` is the first. */
  sites: string[];
  status: SeriesStatus;
  /** The newest chapter the app knew of. */
  latest: string | null;
  readChapters: number[];
  /** The chapter you were on, by name, and when you were last in it. */
  current: string | null;
  lastReadAt: number | null;
  coverUrl: string | null;
};

export type OldLibrary = {
  favourites: OldSeries[];
  /** Opened at some point and never favourited — counted, not brought in. */
  historyOnly: number;
};

/** A backup is a few megabytes; this is room for one with downloads left in it. */
const LIMITS = { maxEntries: 20_000, maxFileBytes: 64 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024 };

/** Only the plainly numbered: `12`, `12.5`, and `22-1` as part of 22. */
function readChapterName(name: string): number | null {
  const trimmed = name.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number.parseFloat(trimmed);
  const part = /^(\d+)-\d+$/.exec(trimmed);
  return part ? Number.parseInt(part[1], 10) : null;
}

function items(entries: ZipEntry[], file: string): Array<Record<string, unknown>> {
  const entry = entries.find((e) => e.name.replace(/\\/g, '/').endsWith(`/Documents/${file}`));
  if (!entry) return [];
  let top: Record<string, unknown>;
  try {
    top = unarchive(entry.bytes);
  } catch (error) {
    throw new ImportRefused(
      `${file} could not be read${error instanceof PlistError ? ` — ${error.message}` : ''}`
    );
  }
  const list = top.comicBooks_Key;
  return Array.isArray(list) ? list.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null) : [];
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** Windows-1252's characters for bytes 0x80–0x9F; the rest of 0x00–0xFF is Latin-1. */
const CP1252: Record<string, number> = {
  '\u20ac': 0x80, '\u201a': 0x82, '\u0192': 0x83, '\u201e': 0x84, '\u2026': 0x85, '\u2020': 0x86,
  '\u2021': 0x87, '\u02c6': 0x88, '\u2030': 0x89, '\u0160': 0x8a, '\u2039': 0x8b, '\u0152': 0x8c,
  '\u017d': 0x8e, '\u2018': 0x91, '\u2019': 0x92, '\u201c': 0x93, '\u201d': 0x94, '\u2022': 0x95,
  '\u2013': 0x96, '\u2014': 0x97, '\u02dc': 0x98, '\u2122': 0x99, '\u0161': 0x9a, '\u203a': 0x9b,
  '\u0153': 0x9c, '\u017e': 0x9e, '\u0178': 0x9f,
};

const RUN = new RegExp(`[\\u0080-\\u00ff${Object.keys(CP1252).join('')}]+`, 'gu');
const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Undo UTF-8 read as Windows-1252: "Assassinâ€™s" back to "Assassin’s".
 *
 * Manga Reader stored 60 of the real backup's titles this way — the damage is in
 * its own file, not in this reader — and a garbled title is not only ugly: it
 * is what gets searched for, so none of them could ever be found on a source.
 *
 * Repaired a run at a time, and only where the bytes are valid UTF-8, so a
 * title correctly containing "é" is left alone, and a title damaged past
 * recovery keeps what it has rather than losing more.
 */
export function repairMojibake(value: string): string {
  return value.replace(RUN, (run) => {
    const bytes: number[] = [];
    for (const ch of run) {
      const code = ch.codePointAt(0)!;
      const b = CP1252[ch] ?? (code <= 0xff ? code : -1);
      if (b < 0) return run;
      bytes.push(b);
    }
    try {
      return utf8.decode(Uint8Array.from(bytes));
    } catch {
      return run;
    }
  });
}
const when = (value: unknown): number | null => (value instanceof Date && Number.isFinite(value.getTime()) ? value.getTime() : null);

const repaired = (record: Record<string, unknown>) =>
  typeof record.comicName === 'string' ? { ...record, comicName: repairMojibake(record.comicName) } : record;

/** Read a `.imazingapp` of Manga Reader into its favourites, with progress from history. */
export function readMangaReaderBackup(buf: Buffer): OldLibrary {
  let entries: ZipEntry[];
  try {
    entries = readZip(buf, LIMITS);
  } catch {
    throw new ImportRefused('that is not an iMazing app backup — it is not a zip file');
  }
  const favourites = items(entries, 'comicBooks.dat').map(repaired);
  if (favourites.length === 0) {
    throw new ImportRefused(
      entries.some((e) => /\/Documents\//.test(e.name))
        ? 'this backup has no Manga Reader favourites in it — is it a backup of a different app?'
        : 'this backup has no app data in it — back up the app in iMazing rather than exporting its files'
    );
  }
  const history = items(entries, 'comicHistroy.dat').concat(items(entries, 'comicHistory.dat')).map(repaired);

  // Every record of a title, on any site — see the note at the top.
  const byTitle = new Map<string, Array<Record<string, unknown>>>();
  for (const record of history) {
    const title = text(record.comicName);
    if (!title) continue;
    const k = groupKey(title);
    byTitle.set(k, [...(byTitle.get(k) ?? []), record]);
  }

  const out: OldSeries[] = [];
  const favouriteTitles = new Set<string>();
  for (const fav of favourites) {
    const title = text(fav.comicName);
    const site = text(fav.website);
    if (!title || !site) continue;
    favouriteTitles.add(groupKey(title));

    const records = [fav, ...(byTitle.get(groupKey(title)) ?? [])].sort(
      (a, b) => (when(b.recordReadedDate) ?? 0) - (when(a.recordReadedDate) ?? 0)
    );
    const newest = records[0];
    const names = records
      .flatMap((r) => (Array.isArray(r.readedChSet) ? r.readedChSet : []))
      .filter((n): n is string => typeof n === 'string');
    const read = [...new Set(names.map(readChapterName).filter((n): n is number => n !== null))].sort((a, b) => a - b);
    const latest =
      records
        .map((r) => text(r.comicRecentUpdate))
        .filter((x): x is string => x !== null)
        .sort((a, b) => (chapterValue(b) ?? -1) - (chapterValue(a) ?? -1))[0] ?? null;
    const sites = [...new Set(records.map((r) => text(r.website)).filter((x): x is string => x !== null))];

    out.push({
      title,
      site: sites[0] ?? site,
      sites: sites.length > 0 ? sites : [site],
      status: fav.kComicItemIsOnGoing === true ? 'ongoing' : fav.kComicItemIsOnGoing === false ? 'completed' : 'unknown',
      latest,
      readChapters: read,
      current: text(newest.recordChapterName),
      lastReadAt: when(newest.recordReadedDate),
      coverUrl: /^https?:\/\//.test(text(fav.comicCoverUrl) ?? '') ? text(fav.comicCoverUrl) : null,
    });
  }

  const historyOnly = new Set(
    history
      .map((h) => text(h.comicName))
      .filter((t): t is string => t !== null)
      .map(groupKey)
      .filter((k) => !favouriteTitles.has(k))
  ).size;
  return { favourites: out, historyOnly };
}

export type ImportScope = 'all' | 'year' | 'quarter';

const SCOPE_MS: Record<Exclude<ImportScope, 'all'>, number> = {
  year: 365 * 24 * 60 * 60_000,
  quarter: 91 * 24 * 60 * 60_000,
};

export function inScope(series: OldSeries, scope: ImportScope, now: number): boolean {
  if (scope === 'all') return true;
  return series.lastReadAt !== null && now - series.lastReadAt <= SCOPE_MS[scope];
}

/**
 * The same series favourited on two sites is one series here: read chapters
 * joined, the site and title taken from the one read most recently.
 */
export function mergeDuplicates(list: OldSeries[]): OldSeries[] {
  const byKey = new Map<string, OldSeries>();
  for (const s of list) {
    const k = groupKey(s.title);
    const had = byKey.get(k);
    if (!had) {
      byKey.set(k, { ...s });
      continue;
    }
    const newer = (s.lastReadAt ?? 0) > (had.lastReadAt ?? 0) ? s : had;
    const latest = [had.latest, s.latest].filter((x): x is string => x !== null)
      .sort((a, b) => (chapterValue(b) ?? -1) - (chapterValue(a) ?? -1))[0] ?? null;
    byKey.set(k, {
      ...newer,
      sites: [...new Set([...newer.sites, ...(newer === s ? had : s).sites])],
      latest,
      readChapters: [...new Set([...had.readChapters, ...s.readChapters])].sort((a, b) => a - b),
      lastReadAt: Math.max(had.lastReadAt ?? 0, s.lastReadAt ?? 0) || null,
      coverUrl: newer.coverUrl ?? had.coverUrl ?? s.coverUrl,
    });
  }
  return [...byKey.values()];
}

/** A series already here that is the same one, by its title or its source's. */
function findSame(store: Store, title: string): Series | undefined {
  const k = groupKey(title);
  return store.series.find((s) => groupKey(s.title) === k || (s.source !== null && groupKey(s.source.title) === k));
}

export type ImportPlan = {
  /** Series that will be added. */
  add: OldSeries[];
  /** Series already followed, which gain the old app's progress. */
  merge: Array<{ old: OldSeries; into: string; title: string }>;
};

export function planImport(store: Store, old: OldSeries[]): ImportPlan {
  const plan: ImportPlan = { add: [], merge: [] };
  for (const s of mergeDuplicates(old)) {
    const same = findSame(store, s.title);
    if (same) plan.merge.push({ old: s, into: same.id, title: same.title });
    else plan.add.push(s);
  }
  return plan;
}

/** How Manga Reader's site shows in History and on a row: "mangakakalot, in Manga Reader". */
export const originLabel = (site: string) => `${site}, in Manga Reader`;

function readRecord(s: OldSeries): ReadRecord | null {
  if (s.lastReadAt === null) return null;
  const chapter = chapterValue(s.current) ?? s.readChapters[s.readChapters.length - 1] ?? null;
  return chapter === null ? null : { chapter, source: originLabel(s.site), mangaId: null, at: s.lastReadAt };
}

/** Apply a plan to the store. Nothing is written to disk here — the caller does that once. */
export function applyImport(store: Store, plan: ImportPlan): { added: number; merged: number } {
  for (const s of plan.add) {
    const series = newSeries({
      mangadexId: null,
      malId: null,
      anilistId: null,
      muId: null,
      title: s.title,
      /*
       * The old app's cover is not kept. The cover route fetches MangaDex art
       * and nothing else, deliberately — it is not an open proxy — and the
       * sites these point at mostly refuse requests from anywhere but their own
       * pages anyway. A linked series takes its source's cover instead.
       */
      coverUrl: null,
      status: s.status,
    });
    // When it was last read rather than today, so "Recently added" and the
    // check rotation both reflect how live a series actually is.
    series.addedAt = s.lastReadAt ?? series.addedAt;
    series.latestChapter = s.latest;
    series.readChapters = s.readChapters;
    const record = readRecord(s);
    series.readLog = record ? [record] : [];
    series.origin = { app: 'Manga Reader', site: s.site, sites: s.sites, title: s.title, latest: s.latest };
    store.series.push(series);
  }

  for (const { old, into } of plan.merge) {
    const series = store.series.find((x) => x.id === into);
    if (!series) continue;
    series.readChapters = [...new Set([...series.readChapters, ...old.readChapters])].sort((a, b) => a - b);
    const record = readRecord(old);
    // Only if it says something the log does not: a later read than any here.
    if (record && !series.readLog.some((r) => r.at >= record.at)) series.readLog.push(record);
  }
  return { added: plan.add.length, merged: plan.merge.length };
}
