/**
 * The two orders the Shuffle card can deal, as rules with no imports — so a
 * quick script can check them without a database or Spotify.
 *
 * - **Shuffle**: every song once, in an even random order (`shuffled`).
 * - **Random**: drawn with replacement, so a song can come back — but not
 *   until `repeatAfter` other songs have played — and with weights, so a song
 *   or an artist you boost comes up more often (`randomRun`).
 *
 * Both start from `oneEach`, which is what makes "a song in two playlists"
 * one song.
 */

export type Song = { uri: string; title: string; artistIds: string[] };

/**
 * One key per song, however many times Spotify lists it.
 *
 * The same track id in two playlists is the easy case. The other is one song
 * released twice — on the single and on the album, or a "Remastered 2011" —
 * which Spotify gives two ids. So the key is the title with its decorations
 * taken off (anything in brackets, anything after " - "), case and punctuation
 * set aside, plus the first artist. Two songs that genuinely share a title and
 * a lead artist would be folded together, which for one person's library is a
 * much smaller mistake than playing the same song twice in a row.
 */
export function songKey(song: Song): string {
  const title = song.title
    .toLowerCase()
    .replace(/\s*[([].*?[)\]]/g, '')
    .replace(/\s+-\s+.*$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return `${title}|${song.artistIds[0] ?? ''}`;
}

/** Each song once: the first listing of each key wins. */
export function oneEach(songs: readonly Song[]): Song[] {
  const seen = new Set<string>();
  const out: Song[] = [];
  for (const s of songs) {
    const k = songKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/** A uniform Fisher–Yates over a copy. `rand(n)` answers an integer in [0, n). */
export function shuffled<T>(items: readonly T[], rand: (n: number) => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export type Weights = { songs: Record<string, number>; artists: Record<string, number> };

/**
 * How likely a song is, relative to an unboosted one at 1.
 *
 * Boosts go both ways: above 1 comes up more, below 1 less, and 0 is never.
 * A song's own weight is multiplied by its artists' — but by the strongest
 * boost up and the strongest boost down among them, not every artist's
 * multiplied together, or a duet between two boosted artists would outrank
 * both their solo songs. An artist set to never keeps every song they are on
 * out, duets included, because that is what "never" says.
 */
export function weightOf(song: Song, weights: Weights): number {
  const own = weights.songs[song.uri] ?? 1;
  const ws = song.artistIds.map((a) => weights.artists[a] ?? 1);
  const up = Math.max(1, ...ws);
  const down = Math.min(1, ...ws);
  return Math.max(0, own) * up * down;
}

/**
 * `length` songs drawn at random, each weighted, none repeated within
 * `repeatAfter` of its last play.
 *
 * The gap is capped at one less than the number of songs, or a short list
 * would run out of anything allowed to play. `rand()` answers [0, 1).
 */
export function randomRun(
  songs: readonly Song[],
  weights: Weights,
  length: number,
  repeatAfter: number,
  rand: () => number
): Song[] {
  if (songs.length === 0) return [];
  const gap = Math.max(0, Math.min(Math.floor(repeatAfter), songs.length - 1));
  const w = songs.map((s) => weightOf(s, weights));
  const lastAt = new Map<number, number>();
  const out: Song[] = [];
  for (let slot = 0; slot < length; slot++) {
    let total = 0;
    const allowed: number[] = [];
    for (let i = 0; i < songs.length; i++) {
      const last = lastAt.get(i);
      if (last !== undefined && slot - last <= gap) continue;
      if (w[i]! <= 0) continue;
      allowed.push(i);
      total += w[i]!;
    }
    if (allowed.length === 0) break;
    let pick = rand() * total;
    let chosen = allowed[allowed.length - 1]!;
    for (const i of allowed) {
      pick -= w[i]!;
      if (pick < 0) {
        chosen = i;
        break;
      }
    }
    lastAt.set(chosen, slot);
    out.push(songs[chosen]!);
  }
  return out;
}

/**
 * The next song, one at a time, for as long as asked — so the queue can be
 * topped up indefinitely without the rules drifting between top-ups.
 *
 * `shuffle`: every song once in an even order; when the deck runs out it is
 * reshuffled, and the first song of the new deck is never the one just played.
 * `random`: weighted, with replacement, the gap kept across the whole session
 * rather than restarting with each top-up.
 */
/**
 * Random's two recency settings, both optional.
 *
 * - `recent`: a song played within the last `within` songs is multiplied by
 *   `factor` (below 1 — less likely). Unlike the gap this is a nudge, not a
 *   rule: it can still come up, just less.
 * - `fresh`: a song not played within the last `after` songs — or not at all
 *   — is multiplied by `factor` (above 1), so the ones you have not heard in a
 *   while surface.
 *
 * `history` is what played before the session began, most recent first (the
 * last fifty Spotify remembers), so a new session does not treat the song you
 * heard two minutes ago as unheard.
 */
export type Recency = {
  recent?: { within: number; factor: number };
  fresh?: { after: number; factor: number };
  history?: readonly string[];
};

export function dealer(
  songs: readonly Song[],
  order: 'shuffle' | 'random',
  weights: Weights,
  repeatAfter: number,
  randInt: (n: number) => number,
  rand01: () => number,
  recency: Recency = {}
): (avoid?: ReadonlySet<string>) => Song | null {
  if (songs.length === 0) return () => null;
  if (order === 'shuffle') {
    /*
     * The first deck leaves out what was just heard (`history`), so a shuffle
     * resumed after a restart carries on through the songs not yet played
     * rather than starting the whole list again. Later decks are whole.
     */
    const heard = new Set((recency.history ?? []).slice(0, songs.length - 1));
    let first = true;
    let deck: Song[] = [];
    let last: Song | null = null;
    return (avoid) => {
      if (deck.length === 0) {
        const pool = first ? songs.filter((s) => !heard.has(s.uri)) : songs;
        first = false;
        deck = shuffled(pool.length > 0 ? pool : songs, randInt);
        if (last && deck.length > 1 && deck[deck.length - 1] === last) {
          [deck[0], deck[deck.length - 1]] = [deck[deck.length - 1]!, deck[0]!];
        }
      }
      /*
       * A song already waiting in Spotify's queue is not dealt again: the next
       * card that is not is taken instead, and the skipped one stays in the
       * deck for later. Only when every card left is waiting does one repeat.
       */
      let at = deck.length - 1;
      if (avoid) while (at > 0 && avoid.has(deck[at]!.uri)) at--;
      last = deck.splice(at, 1)[0]!;
      return last;
    };
  }
  const gap = Math.max(0, Math.min(Math.floor(repeatAfter), songs.length - 1));
  const w = songs.map((s) => weightOf(s, weights));
  const lastAt = new Map<number, number>();
  // What played before the session sits at slots -1, -2, … so the gap and the
  // recency settings see it exactly as they will see what plays next.
  const index = new Map(songs.map((s, i) => [s.uri, i]));
  (recency.history ?? []).forEach((uri, k) => {
    const i = index.get(uri);
    if (i !== undefined && !lastAt.has(i)) lastAt.set(i, -(k + 1));
  });
  const { recent, fresh } = recency;
  let slot = 0;
  return (avoid) => {
    let total = 0;
    const allowed: number[] = [];
    const now: number[] = [];
    for (let i = 0; i < songs.length; i++) {
      const at = lastAt.get(i);
      const since = at === undefined ? Infinity : slot - at;
      if (since <= gap) continue;
      // Already waiting in Spotify's queue: it is coming anyway.
      if (avoid?.has(songs[i]!.uri)) continue;
      let weight = w[i]!;
      if (recent && recent.within > 0 && since <= recent.within) weight *= recent.factor;
      if (fresh && fresh.after > 0 && since > fresh.after) weight *= fresh.factor;
      if (weight <= 0) continue;
      allowed.push(i);
      now.push(weight);
      total += weight;
    }
    if (allowed.length === 0) return null;
    let pick = rand01() * total;
    let chosen = allowed[allowed.length - 1]!;
    for (let k = 0; k < allowed.length; k++) {
      pick -= now[k]!;
      if (pick < 0) {
        chosen = allowed[k]!;
        break;
      }
    }
    lastAt.set(chosen, slot);
    slot += 1;
    return songs[chosen]!;
  };
}
