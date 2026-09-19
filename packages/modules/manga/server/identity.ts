/**
 * One series, four services, and the arithmetic that joins them.
 *
 * ### MangaDex is the spine, and that is the whole reason this is cheap
 *
 * The obvious way to join a series across trackers is to compare titles, and it
 * is the thing to avoid: aggregators spell the same work as romaji, as English,
 * as an abbreviation, and split sequels into separate entries that the trackers
 * keep as one. Matching on that is the friend-linking problem again, and it
 * fails in the same direction — a wrong match writes your progress onto
 * somebody else's manga, on a profile other people can see.
 *
 * MangaDex answers it outright. Every manga record carries a `links` object with
 * the other services' ids already in it:
 *
 * ```json
 * "links": { "mal": "642", "al": "30642", "mu": "cql4c43", "kt": "1456" }
 * ```
 *
 * So a series is matched to MangaDex **once** and every other integration
 * becomes a lookup. That is why the library keys on those ids rather than on a
 * title, and why adding a series is a search against MangaDex rather than
 * against whichever source you happen to read it on.
 *
 * ### `mu` is base36 and MangaUpdates' API is not
 *
 * MangaUpdates moved from base36 ids to numeric ones and MangaDex still stores
 * the old spelling, so `cql4c43` has to become `27728982867` before their API
 * will answer. Verified against the live services: that id returns *VINLAND
 * SAGA*, 220 chapters, at the canonical URL that contains `cql4c43` again.
 *
 * It is one `parseInt(x, 36)` and it is written down here rather than inline
 * because it looks like a bug on sight — a base-36 parse of something that
 * reads like a slug — and the next person to see it should find the reason
 * beside it rather than delete it.
 */

/** Everything a series is known by, with null meaning "that service has no entry". */
export type SeriesIds = {
  mangadexId: string | null;
  malId: number | null;
  anilistId: number | null;
  /** Numeric, already converted. Never the base36 spelling MangaDex stores. */
  muId: number | null;
};

/** What MangaDex publishes about where else a series lives. Every key is optional. */
export type MangaDexLinks = Record<string, string | undefined>;

/**
 * MangaUpdates' base36 id as the number their API wants.
 *
 * Returns null rather than `NaN` for anything that is not a clean base36 word,
 * because a `NaN` reaching a URL produces a 404 that reads as the series having
 * been removed rather than as us having sent nonsense.
 */
export function muIdFromLink(link: string | undefined | null): number | null {
  if (!link) return null;
  const word = link.trim().toLowerCase();
  if (!/^[0-9a-z]{1,13}$/.test(word)) return null;
  const n = Number.parseInt(word, 36);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** A positive integer out of a string field, or null. Trackers send ids as strings. */
function numericId(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Pull every id we care about out of a MangaDex manga record's `links`. */
export function idsFromMangaDex(mangadexId: string, links: MangaDexLinks | null | undefined): SeriesIds {
  const l = links ?? {};
  return {
    mangadexId,
    malId: numericId(l.mal),
    anilistId: numericId(l.al),
    muId: muIdFromLink(l.mu),
  };
}

/**
 * Chapter numbers are strings, and comparing them as numbers is the only way.
 *
 * They are kept as text because `220.5` is a real chapter and so is `220.1`, and
 * because some series number by part (`12-2`) — throwing that away to store a
 * float would make the screen say something the source never said. But *is this
 * newer than what I last saw* is a numeric question, so the two live side by
 * side: the string for display, this for the comparison.
 *
 * Anything unparseable returns null and is treated as "cannot tell", which the
 * caller must read as **not new**. Guessing in the other direction would raise a
 * nudge about a chapter that may not exist, and a reminder you cannot act on is
 * worse than a late one.
 */
export function chapterValue(chapter: string | null | undefined): number | null {
  if (!chapter) return null;
  /*
   * Three patterns, tried in order, and the order is the whole of it.
   *
   * The tempting single pattern makes the volume prefix optional —
   * `/^v?\d*\s*c?\.?\s*(\d+)/` — and it is wrong in a way that passes a casual
   * reading: with no `v` present, `\d*` is greedy and eats the chapter number,
   * then backtracks one digit to satisfy the capture. So `220` parses as **0**
   * and `219` as **9**, which makes 219 look newer than 220. Caught by the
   * suite; it would have presented as nudges about chapters that had already
   * been out for months.
   *
   * So a volume prefix is only skipped when there is actually a `v` there.
   */
  const m =
    // "v12 c34", "v12c34", "v12, c34"
    /^\s*v\s*\d+(?:\.\d+)?\s*[,;]?\s*c?\.?\s*(\d+(?:\.\d+)?)/i.exec(chapter) ??
    // "220", "c.220", "c 220", ".5"
    /^\s*c?\.?\s*(\d+(?:\.\d+)?)/i.exec(chapter) ??
    // Anything else with a number in it, which is better than nothing.
    /(\d+(?:\.\d+)?)/.exec(chapter);
  if (!m) return null;
  const n = Number.parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Is `latest` a chapter we have not seen?
 *
 * False whenever either side cannot be read as a number — see above. False also
 * when they are equal, which is the ordinary case on every poll after the first
 * and is why this is asked before anything is written.
 */
export function isNewerChapter(latest: string | null | undefined, seen: string | null | undefined): boolean {
  const a = chapterValue(latest);
  if (a === null) return false;
  const b = chapterValue(seen);
  // Nothing seen yet is not news. Adding a series to the library should not
  // immediately raise a nudge about the chapter that was already out when you
  // added it — that is the "already handed in when we first looked" case the
  // coursework sync writes a link for and no task.
  if (b === null) return false;
  return a > b;
}

/** MangaDex publishes exactly these four, and anything else is a bug upstream. */
export type SeriesStatus = 'ongoing' | 'completed' | 'hiatus' | 'cancelled' | 'unknown';

export function seriesStatus(raw: string | null | undefined): SeriesStatus {
  switch ((raw ?? '').toLowerCase()) {
    case 'ongoing':
      return 'ongoing';
    case 'completed':
      return 'completed';
    case 'hiatus':
      return 'hiatus';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

/**
 * Is this series worth asking about again?
 *
 * A finished work never gains a chapter, so polling it forever is a request a
 * day for an answer that cannot change — and on a real library that is most of
 * the rows. Cancelled is the same claim. `hiatus` is deliberately *kept* in the
 * rotation: a hiatus ending is exactly the news somebody wants, and it is the
 * one status where the interesting event is the status changing.
 */
export function worthPolling(status: SeriesStatus): boolean {
  return status !== 'completed' && status !== 'cancelled';
}
