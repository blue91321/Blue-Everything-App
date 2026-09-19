/**
 * Where chapters actually come from.
 *
 * ### Why this is an interface and not just a Suwayomi client
 *
 * Tachiyomi was nine years old when a publisher's letter closed it in eleven
 * days. Suwayomi runs the same extensions and carries the same exposure. That is
 * not a reason to avoid it — it is a reason for the reader to depend on a shape
 * rather than on a schema, so the day it goes dark is a new file in this folder
 * instead of a rewrite.
 *
 * The interface is deliberately **four methods**, arrived at by asking what the
 * library actually needs rather than what a source could offer:
 *
 *   - `describe()` — is it there, and what is it;
 *   - `search()` — find this series in the source's own catalogue;
 *   - `latestChapter()` — the newest chapter a person can actually open;
 *   - `chapters()` — the list, for the reader that is not built yet.
 *
 * Nothing about pages, downloads, categories or extensions. Those are Suwayomi
 * concepts, and putting them here would make the interface a description of
 * Suwayomi rather than of a source — which is the failure it exists to avoid.
 *
 * ### This is the only part that answers the question the app is really asked
 *
 * MangaUpdates answers "what has been released and logged", and that understates
 * badly for anything read unofficially: *Archmage Curriculum* logged chapter 23
 * while 41 existed and the site being read was on 45. A source is the only thing
 * that can say what is *there*, because it is the thing serving it.
 *
 * So when a series is linked to a source, the source wins for the chapter
 * number. MangaUpdates stays as the fallback for anything unlinked, which is
 * every series until you point it at something.
 */

/** A source's own idea of a series, before it is joined to anything of ours. */
export type SourceMatch = {
  /** Opaque to us. Suwayomi's is a numeric manga id; another adapter's may not be. */
  id: string;
  title: string;
  /** The source that holds it, for when several are installed. */
  sourceName: string;
  /** Where a person would read it, if the adapter knows. */
  url: string | null;
  thumbnailUrl: string | null;
};

export type SourceChapter = {
  id: string;
  /** As the source numbers it. Float, because `220.5` is a real chapter. */
  number: number;
  name: string;
  /** Milliseconds, or null when the source does not say. */
  uploadedAt: number | null;
  scanlator: string | null;
};

/** What a source says about itself, for the screen that asks whether it is working. */
export type SourceHealth = {
  reachable: boolean;
  /** Names of the sources it can search, when it has any installed. */
  sources: string[];
  /** Why not, when `reachable` is false. Shown rather than logged. */
  problem: string | null;
};

export interface SourceAdapter {
  /** Stable id, stored against a series. Never shown to a person. */
  readonly id: string;
  /** What to call it on screen. */
  readonly label: string;

  describe(): Promise<SourceHealth>;
  search(query: string, limit?: number): Promise<SourceMatch[]>;
  /**
   * The newest chapter number available, or null when the source has none.
   *
   * Null is "this source has nothing for that id" and must not be read as zero —
   * the caller falls back to MangaUpdates rather than reporting a series as
   * having no chapters at all.
   */
  latestChapter(mangaId: string): Promise<number | null>;
  chapters(mangaId: string): Promise<SourceChapter[]>;
}

/** Raised by an adapter for anything a person can act on. Anything else is a bug. */
export class SourceError extends Error {}

/**
 * Which chapter number to believe.
 *
 * Both numbers are real and they answer different questions, so this is not a
 * "pick the bigger one" — it is a statement about authority. A source is serving
 * the chapter, so it knows; MangaUpdates is a database of what groups have
 * reported, so it lags. When a series is linked, the source wins even if it is
 * *lower*, because a source that has fallen behind is still telling the truth
 * about what you could open right now.
 */
export function readableChapter(
  fromSource: number | null,
  fromMangaUpdates: string | null
): { chapter: string | null; via: 'source' | 'mangaupdates' | null } {
  if (fromSource !== null && Number.isFinite(fromSource)) {
    // Trailing zeroes off a float: 220 rather than "220", 220.5 kept.
    return { chapter: String(fromSource), via: 'source' };
  }
  if (fromMangaUpdates) return { chapter: fromMangaUpdates, via: 'mangaupdates' };
  return { chapter: null, via: null };
}
