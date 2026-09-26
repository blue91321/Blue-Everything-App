/**
 * Browsing sources: what the Browse tab is built on, with no network in it.
 *
 * ### Search asks every source, and answers by *series*
 *
 * The same title comes back from four sites, and a flat list of results is the
 * same series four times with the one you wanted buried among them. So results
 * are grouped by name — one row per series, carrying every source that has it —
 * which is the view the old reader's "related" link gave, arriving at the point
 * of searching rather than after following.
 *
 * ### The source you browse from comes first
 *
 * You chose it for a reason — usually that it is fast and its pages are clean —
 * so a group it is in outranks one it is not, and inside a group its copy leads:
 * its cover, and the one "Follow" uses. The other sources are still listed,
 * since the comparison screen exists precisely because the first choice is not
 * always the right one.
 *
 * ### Filters belong to one source
 *
 * Every site declares its own — MangaFire has three-way genre switches, Asura a
 * sort order and a status drop-down, MangaDex groups of drop-downs — so there is
 * no filter that means the same thing everywhere. The chosen source's own
 * filters apply to its search, and the screen says so; the filters that apply to
 * every source (language, which sources, hiding what you follow) are the app's.
 *
 * Imports nothing, like `judge.ts`, so `manga-check` can prove all of it.
 */

/**
 * MangaDex and MangaUpdates: databases first, places to read second.
 *
 * Both are where a series is *catalogued* — every title is there, which is why
 * they come back for nearly every search — and neither is usually where it is
 * furthest along. MangaDex carries only what groups upload to it, and is often
 * hundreds of chapters short (Eleceed: 390 with 287 missing, against 419
 * elsewhere). Listed first because "MangaDex" sorts before "MangaFire", they
 * read as the recommendation while being the weakest option.
 *
 * So they go last among equals, and first only when their number says they are
 * genuinely ahead. Matched on the name, since that is what every list here
 * carries; "MangaDex (EN)" and a future "MangaUpdates" both count.
 */
export function isIndexSource(name: string): boolean {
  return /^manga\s?(dex|updates)\b/i.test(name.trim());
}

/** A filter as a source declares it, reduced to what the screen draws. */
export type SourceFilter =
  | { kind: 'checkbox'; name: string; default: boolean }
  | { kind: 'tristate'; name: string; default: TriState }
  | { kind: 'select'; name: string; values: string[]; default: number }
  | { kind: 'sort'; name: string; values: string[]; default: { index: number; ascending: boolean } | null }
  | { kind: 'text'; name: string; default: string }
  | { kind: 'group'; name: string; filters: SourceFilter[] }
  | { kind: 'header'; name: string }
  | { kind: 'separator' };

export type TriState = 'ignore' | 'include' | 'exclude';

/**
 * One change from a filter's default, as the browser sends it.
 *
 * `position` is the filter's index in the source's list and `inner` its index
 * inside a group — positions, because that is how the source identifies them,
 * and names are not unique (MangaFire has four separators and two "Status"es).
 */
export type FilterChange = {
  position: number;
  inner?: number;
  checkbox?: boolean;
  tristate?: TriState;
  select?: number;
  sort?: { index: number; ascending: boolean };
  text?: string;
};

type Raw = Record<string, any>;

/**
 * Suwayomi's filter union into ours.
 *
 * Its field names differ per member — `default` is a boolean on a checkbox, an
 * index on a select, an enum on a tristate — which is why the query aliases
 * each one; this reads the aliases back. Anything unrecognised becomes a
 * separator rather than failing the whole list, because one strange filter in
 * a new extension should not take away the other twenty.
 */
export function fromSuwayomiFilter(raw: Raw): SourceFilter {
  const name = typeof raw.name === 'string' ? raw.name : '';
  switch (raw.__typename) {
    case 'CheckBoxFilter':
      return { kind: 'checkbox', name, default: raw.checkDefault === true };
    case 'TriStateFilter':
      return { kind: 'tristate', name, default: triFrom(raw.triDefault) };
    case 'SelectFilter':
      return {
        kind: 'select',
        name,
        values: Array.isArray(raw.values) ? raw.values.map(String) : [],
        default: Number.isInteger(raw.selectDefault) ? raw.selectDefault : 0,
      };
    case 'SortFilter':
      return {
        kind: 'sort',
        name,
        values: Array.isArray(raw.values) ? raw.values.map(String) : [],
        default:
          raw.sortDefault && Number.isInteger(raw.sortDefault.index)
            ? { index: raw.sortDefault.index, ascending: raw.sortDefault.ascending === true }
            : null,
      };
    case 'TextFilter':
      return { kind: 'text', name, default: typeof raw.textDefault === 'string' ? raw.textDefault : '' };
    case 'GroupFilter':
      return {
        kind: 'group',
        name,
        // One level only: Suwayomi's `groupChange` carries a single inner
        // change, so a group inside a group could be drawn but never set.
        filters: (Array.isArray(raw.filters) ? raw.filters : [])
          .map(fromSuwayomiFilter)
          .filter((f: SourceFilter) => f.kind !== 'group'),
      };
    case 'HeaderFilter':
      return { kind: 'header', name };
    default:
      return { kind: 'separator' };
  }
}

function triFrom(value: unknown): TriState {
  return value === 'INCLUDE' ? 'include' : value === 'EXCLUDE' ? 'exclude' : 'ignore';
}

/**
 * The browser's changes, checked against the filters they claim to change, as
 * Suwayomi's `FilterChangeInput`.
 *
 * Checked rather than forwarded. The positions arrive from the browser, and a
 * change aimed at the wrong kind of filter — a text value at a checkbox — is
 * refused by Suwayomi with a message about its own internals. Anything that
 * does not fit is dropped, and the count of what was dropped comes back so the
 * screen can say a filter did not apply rather than pretend it did.
 */
export function toSuwayomiChanges(
  filters: readonly SourceFilter[],
  changes: readonly FilterChange[]
): { input: Raw[]; dropped: number } {
  const input: Raw[] = [];
  let dropped = 0;

  for (const change of changes) {
    const outer = filters[change.position];
    const target = change.inner === undefined ? outer : outer?.kind === 'group' ? outer.filters[change.inner] : undefined;
    const value = target ? valueFor(target, change) : null;
    if (!target || !value) {
      dropped += 1;
      continue;
    }
    input.push(
      change.inner === undefined
        ? { position: change.position, ...value }
        : { position: change.position, groupChange: { position: change.inner, ...value } }
    );
  }
  return { input, dropped };
}

function valueFor(filter: SourceFilter, change: FilterChange): Raw | null {
  switch (filter.kind) {
    case 'checkbox':
      return typeof change.checkbox === 'boolean' ? { checkBoxState: change.checkbox } : null;
    case 'tristate':
      return change.tristate === 'ignore' || change.tristate === 'include' || change.tristate === 'exclude'
        ? { triState: change.tristate.toUpperCase() }
        : null;
    case 'select':
      return Number.isInteger(change.select) && change.select! >= 0 && change.select! < filter.values.length
        ? { selectState: change.select }
        : null;
    case 'sort':
      return change.sort &&
        Number.isInteger(change.sort.index) &&
        change.sort.index >= 0 &&
        change.sort.index < filter.values.length
        ? { sortState: { index: change.sort.index, ascending: change.sort.ascending === true } }
        : null;
    case 'text':
      return typeof change.text === 'string' ? { textState: change.text.slice(0, 200) } : null;
    default:
      return null;
  }
}

/**
 * The name a series is grouped under.
 *
 * Case, punctuation and accents are folded, and a bracketed aside is dropped —
 * sites write "Solo Leveling (Official)" and "Solo Leveling [Colored]" for the
 * same series. A subtitle after a colon is **kept**: "Solo Leveling: Ragnarok"
 * is a different series, and folding it in would put a sequel's chapter count
 * in the same row as the original's.
 */
export function groupKey(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export type GroupEntry = {
  id: string;
  title: string;
  sourceId?: string;
  sourceName: string;
  lang: string | null;
  score?: number;
};

export type MatchGroup<T extends GroupEntry> = {
  key: string;
  /** The leading entry's title, as that source spells it. */
  title: string;
  /** Best title score of any entry. */
  score: number;
  /** Whether the source you browse from is among them. */
  preferred: boolean;
  /** The preferred source's copy first, then best-matching, then as found. */
  entries: T[];
};

/**
 * At or above this, a title answers the search — it is the words typed, starts
 * with them, or contains them. See `titleScore`.
 */
export const GOOD_MATCH = 60;

/**
 * Results grouped by series, the chosen source first.
 *
 * Ranked by: whether the title answers the search at all; then whether the
 * chosen source has it; then how well; then how many sources carry it, since a
 * series on five sites is more likely the one meant than a namesake on one.
 * Ties keep the order results arrived in, which is each source's own ranking.
 *
 * **The first key is what stops "prefer" meaning "only".** It was the chosen
 * source first outright, and searching "solo leveling" with MangaFire chosen
 * put "Solo DPS!" — one shared word — above an exact title from every other
 * site, because MangaFire had it. Preferring a source is a tie-break between
 * answers, not a reason to rank a non-answer above one.
 */
export function groupMatches<T extends GroupEntry>(
  matches: readonly T[],
  preferredSourceId: string | null
): MatchGroup<T>[] {
  const groups = new Map<string, { entries: Array<{ m: T; at: number }>; first: number }>();
  matches.forEach((m, at) => {
    const key = groupKey(m.title) || `:${m.sourceName}:${m.id}`;
    const g = groups.get(key) ?? { entries: [], first: at };
    g.entries.push({ m, at });
    groups.set(key, g);
  });

  const isPreferred = (m: T) => preferredSourceId !== null && m.sourceId === preferredSourceId;

  return [...groups]
    .map(([key, g]) => {
      const entries = [...g.entries]
        .sort(
          (a, b) =>
            Number(isPreferred(b.m)) - Number(isPreferred(a.m)) ||
            (b.m.score ?? 0) - (a.m.score ?? 0) ||
            Number(isIndexSource(a.m.sourceName)) - Number(isIndexSource(b.m.sourceName)) ||
            a.at - b.at
        )
        .map((e) => e.m);
      return {
        group: {
          key,
          title: entries[0].title,
          score: Math.max(...entries.map((e) => e.score ?? 0)),
          preferred: entries.some(isPreferred),
          entries,
        },
        first: g.first,
      };
    })
    .sort(
      (a, b) =>
        Number(b.group.score >= GOOD_MATCH) - Number(a.group.score >= GOOD_MATCH) ||
        Number(b.group.preferred) - Number(a.group.preferred) ||
        b.group.score - a.group.score ||
        b.group.entries.length - a.group.entries.length ||
        a.first - b.first
    )
    .map((x) => x.group);
}
