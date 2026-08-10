/**
 * Reading a Google Takeout watch history.
 *
 * This exists because the YouTube API cannot answer the question at all — the
 * watch-history playlist has been an empty placeholder since 2016. A Takeout
 * export is not a workaround for a missing endpoint; it is the only complete
 * record of what you watched, and it goes back further than any API would.
 *
 * **Two-phase, like the vault's CSV import, and for the same reason.** The first
 * call reports what it found and writes nothing, so a file that turns out to be
 * search history rather than watch history is caught before forty thousand rows
 * land in the library. Only `commit: true` writes.
 *
 * Unlike the vault import there is nothing secret in here, so it is allowed to
 * echo titles back. What it must not do is take a long time in the request
 * handler — a year of YouTube is a hundred-megabyte file — so it is parsed once
 * and summarised, never held twice.
 */
import { upsertItems, recordPlays, findItemIds } from './store.js';

/**
 * One entry, as Takeout writes it. Everything is optional in practice even
 * where the export usually has it: removed videos lose `titleUrl`, ads lose
 * `subtitles`, and very old entries lose both.
 */
interface TakeoutEntry {
  header?: string;
  title?: string;
  titleUrl?: string;
  subtitles?: Array<{ name?: string; url?: string }>;
  time?: string;
  /** Present on advertisements, which are not things you chose to watch. */
  details?: Array<{ name?: string }>;
}

export interface ParsedPlay {
  videoId: string;
  title: string;
  channel: string | null;
  watchedAt: number;
}

export interface TakeoutSummary {
  /** Entries in the file, whatever they were. */
  total: number;
  /** Ones that became a play. */
  usable: number;
  skipped: {
    /** Removed or private videos — the entry survives, the link does not. */
    noVideo: number;
    /** "Viewed Ads", which is not watch history in any useful sense. */
    ads: number;
    /** Entries whose timestamp would not parse. */
    noTime: number;
    /** YouTube Music, Search, and anything else that shares the export shape. */
    otherProduct: number;
  };
  /** The window the file covers, so you can see it is the export you meant. */
  earliest: number | null;
  latest: number | null;
  /** A handful of titles, purely so the preview is recognisably your history. */
  sample: string[];
}

/** `https://www.youtube.com/watch?v=dQw4w9WgXcQ` → `dQw4w9WgXcQ`. */
function videoIdFrom(url: string | undefined): string | null {
  if (!url) return null;
  const match = /[?&]v=([A-Za-z0-9_-]{11})/.exec(url);
  return match ? match[1] : null;
}

/**
 * Takeout titles are prefixed with the verb — `Watched Some Video`.
 *
 * Stripped so the library reads the same whether a row came from here or from
 * the API. Localised exports use their own verb, so a missing prefix is left
 * alone rather than guessed at; a title beginning with something unexpected is
 * far better than one with its first word chopped off.
 */
function stripVerb(title: string): string {
  return title.startsWith('Watched ') ? title.slice('Watched '.length) : title;
}

export function parseTakeout(json: string): { plays: ParsedPlay[]; summary: TakeoutSummary } {
  let entries: TakeoutEntry[];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) throw new Error('the top level is not a list of entries');
    entries = parsed as TakeoutEntry[];
  } catch (error) {
    // Named specifically, because the overwhelmingly common mistake is
    // exporting HTML instead of JSON, and "unexpected token <" does not say so.
    throw new Error(
      `that is not a Takeout watch-history.json (${(error as Error).message}). ` +
        'In Takeout, set the YouTube history format to JSON rather than HTML.'
    );
  }

  const plays: ParsedPlay[] = [];
  const skipped = { noVideo: 0, ads: 0, noTime: 0, otherProduct: 0 };
  const sample: string[] = [];
  let earliest: number | null = null;
  let latest: number | null = null;

  for (const entry of entries) {
    // `header` is the product. YouTube Music exports look almost identical and
    // would otherwise be silently merged into the video history.
    if (entry.header && entry.header !== 'YouTube') {
      skipped.otherProduct += 1;
      continue;
    }

    if (entry.details?.some((d) => d.name === 'From Google Ads')) {
      skipped.ads += 1;
      continue;
    }

    const videoId = videoIdFrom(entry.titleUrl);
    if (!videoId) {
      skipped.noVideo += 1;
      continue;
    }

    const watchedAt = entry.time ? Date.parse(entry.time) : Number.NaN;
    if (Number.isNaN(watchedAt)) {
      skipped.noTime += 1;
      continue;
    }

    const title = stripVerb(entry.title ?? 'Untitled');
    plays.push({ videoId, title, channel: entry.subtitles?.[0]?.name ?? null, watchedAt });

    if (earliest === null || watchedAt < earliest) earliest = watchedAt;
    if (latest === null || watchedAt > latest) latest = watchedAt;
    if (sample.length < 5) sample.push(title);
  }

  return {
    plays,
    summary: { total: entries.length, usable: plays.length, skipped, earliest, latest, sample },
  };
}

/**
 * Write a parsed history into the library.
 *
 * The videos themselves are stored with only what the export knows — a title and
 * a channel, no duration, no category. That is deliberate: enriching forty
 * thousand videos through the `videos` endpoint is eight hundred requests and a
 * meaningful chunk of a day's quota, spent mostly on things you watched once in
 * 2019. A later playlist sync fills in the details of anything you actually kept.
 *
 * Videos already known from a playlist sync keep the details they have —
 * `upsertItems` is not called for them at all — so importing a Takeout file
 * cannot downgrade a categorised track to a bare title.
 */
export async function importTakeout(plays: ParsedPlay[]): Promise<{ added: number; videos: number }> {
  if (plays.length === 0) return { added: 0, videos: 0 };

  const byVideo = new Map<string, ParsedPlay>();
  for (const play of plays) if (!byVideo.has(play.videoId)) byVideo.set(play.videoId, play);

  const known = await findItemIds('youtube', [...byVideo.keys()]);
  const missing = [...byVideo.values()].filter((p) => !known.has(p.videoId));

  const newIds = await upsertItems(
    'youtube',
    missing.map((p) => ({
      providerItemId: p.videoId,
      kind: 'video' as const,
      title: p.title,
      creator: p.channel,
      url: `https://www.youtube.com/watch?v=${p.videoId}`,
      // No genres and no category. An uncategorised row is honest; a guess from
      // the title would put half the library in the wrong family.
    }))
  );
  missing.forEach((p, index) => {
    if (newIds[index]) known.set(p.videoId, newIds[index]);
  });

  const rows = plays
    .map((p) => {
      const itemId = known.get(p.videoId);
      return itemId ? { itemId, playedAt: p.watchedAt, source: 'youtube-takeout' as const } : null;
    })
    .filter((r): r is { itemId: string; playedAt: number; source: 'youtube-takeout' } => r !== null);

  const added = await recordPlays(rows);
  return { added, videos: missing.length };
}
