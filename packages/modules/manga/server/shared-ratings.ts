/**
 * Ratings shared between the copies on this PC (plan A): each copy that
 * switched sharing on hands the host its ratings, and every copy reads the
 * others' back, by Suwayomi id, which every copy means the same thing by.
 *
 * **Off unless chosen**, per copy (`Store.shareRatingsWithCopies`): what you
 * thought of something is yours. Turning it off takes your ratings out, so
 * "off" means nobody sees them, not "nobody new". The host's own entry is
 * `you` on the host and shown to guests as "the host".
 *
 * Kept on the host, in `data/manga-shared-ratings.json`, the only writer; a
 * guest sends its whole set, so there is nothing to merge and nothing that can
 * drift: the set on disk is whatever that copy last said.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, writeFileAtomic } from '@everything/server/module-api';

const FILE = join(dataDir, 'manga-shared-ratings.json');

export type SharedRatings = Record<string, { at: number; ratings: Record<string, { rating: number; title: string }> }>;

export function readShared(): SharedRatings {
  if (!existsSync(FILE)) return {};
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')) as SharedRatings;
  } catch {
    return {};
  }
}

/** One copy's whole set, replacing what it said before. An empty set takes it out. */
export function setShared(copy: string, ratings: Record<string, { rating: number; title: string }>): void {
  const all = readShared();
  if (Object.keys(ratings).length === 0) delete all[copy];
  else all[copy] = { at: Date.now(), ratings };
  writeFileAtomic(FILE, JSON.stringify(all));
}

/** Everyone else's rating of one series, by who rated it. */
export function othersRatings(mangaId: string, except: string): Array<{ who: string; rating: number }> {
  return Object.entries(readShared())
    .filter(([who]) => who !== except)
    .flatMap(([who, entry]) => (entry.ratings[mangaId] ? [{ who, rating: entry.ratings[mangaId]!.rating }] : []));
}
