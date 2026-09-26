/**
 * Reading several sources' chapter lists against each other.
 *
 * ### What this is for
 *
 * The reader this replaces had a "related" view: the same title across every
 * source, side by side. It was used to find three things — a source further
 * ahead, one with broken pages, and one listing chapters it does not have. The
 * first is a comparison of numbers; the other two are what this file is for,
 * because a source padding its list looks, on the number alone, like the best
 * one.
 *
 * So no row is judged alone. "Up to 425" means nothing until you know every
 * other source stops at 418 — and then it means *check that before trusting
 * it*.
 *
 * ### Why it lives in the browser, and imports nothing
 *
 * Judgement belongs on the server in this project, and the reason is always the
 * same: a device's clock or state can differ, and the phone and the PC must not
 * disagree. Neither applies here. This is arithmetic over numbers the server
 * sent, and it deliberately compares upload dates *with each other* rather than
 * with `Date.now()`, so a phone five minutes out reaches exactly the verdict the
 * PC does.
 *
 * What the browser buys is that the counts arrive one source at a time, and the
 * verdicts re-form as each lands, without asking the server for anything more.
 *
 * It imports nothing — the arrangement `integrations/web/presence.ts` uses —
 * which is what lets `manga-check` import and test it from the server side.
 *
 * Called `judge.ts` rather than `compare.ts` beside `Compare.tsx`, and that is
 * not taste: on Windows the two names are the same file, and `./Compare`
 * resolved to whichever the compiler met first. TypeScript refused and Rollup
 * failed the build — the kind of thing that works on one machine and breaks on
 * the next.
 */

export type SourceRow = {
  /** Unique within one comparison: source name plus the source's id. */
  key: string;
  sourceName: string;
  /** The source's language code, or null when the adapter does not say. */
  lang: string | null;
  /** Null until counted. */
  latest: number | null;
  distinct: number;
  missing: number;
  missingSample: number[];
  newestUpload: number | null;
  /** False while the count is still in flight — excluded from every verdict. */
  counted: boolean;
};

export type Tone = 'good' | 'warn' | 'bad' | 'info';
export type Flag = { tone: Tone; text: string };

export type Verdict = {
  flags: Record<string, Flag[]>;
  /** One line for the top of the screen, or null before anything is counted. */
  summary: string | null;
};

/**
 * How far past every other source a source can be before it is worth a look.
 *
 * Two is ordinary: release timing, a group that grabbed the raw a day earlier.
 * Beyond that it is either a genuinely faster source or one listing chapters it
 * does not have, and the numbers cannot tell those apart — only the pages can.
 * So the flag asks you to check, rather than accusing anybody.
 */
export const AHEAD_MARGIN = 2;

/**
 * How far behind the freshest source an upload can be before it is stale.
 *
 * Measured against the other sources, never against today: a series on hiatus
 * has every source quiet for a year, and calling all of them stale would be
 * true and useless. What matters is one source falling silent while the others
 * carry on.
 */
export const STALE_BEHIND_MS = 90 * 24 * 60 * 60_000;

/** `418` rather than `418.0`, and `220.5` kept. */
export function chapterText(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

function months(ms: number): string {
  const m = Math.round(ms / (30 * 24 * 60 * 60_000));
  return m <= 1 ? 'a month' : `${m} months`;
}

/**
 * Which rows are a lone leader well clear of the rest *of their own language*.
 *
 * ### Why within a language, which the first version did not do
 *
 * It compared every source with every other, and the real Eleceed numbers broke
 * it on the first run: MangaFire's English source at 418, its Spanish at 408 —
 * so English was a lone leader ten clear, and was flagged as possibly listing
 * chapters it does not have. It is the source the rest of this module had just
 * verified goes to 418.
 *
 * Translations into other languages are usually made *from* the English one,
 * or later from the raws, so they trail it as a matter of course. English being
 * ahead of Spanish is not evidence about English. Two English sources where one
 * is ten ahead of the other is — so that is the comparison made.
 *
 * "Lone" matters too. Two sources on 425 while the rest are on 418 is two
 * sources agreeing, a much stronger claim than one source saying so.
 */
function findOutliers(withChapters: readonly SourceRow[]): Map<SourceRow, number> {
  const byLang = new Map<string, SourceRow[]>();
  for (const r of withChapters) {
    const lang = r.lang ?? '?';
    byLang.set(lang, [...(byLang.get(lang) ?? []), r]);
  }

  const outliers = new Map<SourceRow, number>();
  for (const group of byLang.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => b.latest! - a.latest!);
    const top = sorted[0].latest!;
    const leaders = sorted.filter((r) => r.latest === top);
    const runnerUp = sorted.find((r) => r.latest !== top)?.latest ?? null;
    if (leaders.length === 1 && runnerUp !== null && top - runnerUp > AHEAD_MARGIN) {
      outliers.set(leaders[0], top - runnerUp);
    }
  }
  return outliers;
}

export function judgeSources(rows: readonly SourceRow[]): Verdict {
  const flags: Record<string, Flag[]> = {};
  const add = (key: string, flag: Flag) => (flags[key] ??= []).push(flag);

  const counted = rows.filter((r) => r.counted);
  if (counted.length === 0) return { flags, summary: null };

  const withChapters = counted.filter((r) => r.latest !== null && r.distinct > 0);
  const empty = counted.filter((r) => !withChapters.includes(r));

  for (const r of empty) add(r.key, { tone: 'bad', text: 'no chapters' });

  if (withChapters.length === 0) {
    return { flags, summary: `None of the ${counted.length} sources checked so far has any chapters of this.` };
  }

  const outliers = findOutliers(withChapters);
  for (const [r, lead] of outliers) {
    add(r.key, {
      tone: 'warn',
      text:
        `${chapterText(lead)} ahead of every other ${r.lang ? r.lang.toUpperCase() + ' ' : ''}source — ` +
        'either genuinely faster, or listing chapters it does not have. Check its newest pages.',
    });
  }

  /*
   * "Furthest" is measured across every language — which source goes furthest
   * is exactly what you came to find out — but never from a number that has just
   * been flagged as possibly not real. Otherwise every other source would be
   * reported as far behind a claim nobody has checked.
   */
  const vouched = withChapters.filter((r) => !outliers.has(r));
  const trusted = vouched.length > 0 ? Math.max(...vouched.map((r) => r.latest!)) : null;
  const best = vouched.filter((r) => r.latest === trusted);

  if (withChapters.length === 1) {
    add(withChapters[0].key, { tone: 'info', text: 'the only source with this, so nothing to compare it against' });
  } else {
    for (const r of best) add(r.key, { tone: 'good', text: 'furthest along' });
  }

  if (trusted !== null) {
    for (const r of vouched) {
      const behind = trusted - r.latest!;
      if (behind > 0) add(r.key, { tone: 'info', text: `${chapterText(behind)} behind` });
    }
  }

  for (const r of withChapters) {
    if (r.missing <= 0) continue;
    const named = r.missingSample.map(chapterText).join(', ');
    const more = r.missing > r.missingSample.length ? '…' : '';
    add(r.key, {
      tone: 'warn',
      text: `missing ${r.missing} chapter${r.missing === 1 ? '' : 's'}${named ? ` (${named}${more})` : ''}`,
    });
  }

  const dated = withChapters.filter((r) => r.newestUpload !== null);
  if (dated.length > 1) {
    const freshest = Math.max(...dated.map((r) => r.newestUpload!));
    for (const r of dated) {
      const gap = freshest - r.newestUpload!;
      if (gap > STALE_BEHIND_MS) {
        add(r.key, { tone: 'warn', text: `last upload ${months(gap)} before the freshest source` });
      }
    }
  }

  const parts: string[] = [];
  if (trusted !== null) {
    const aside = [...outliers.keys()].map((r) => r.sourceName).join(', ');
    const lead = outliers.size > 0 ? `Furthest, setting aside ${aside}` : 'Furthest';
    parts.push(`${lead}: ${best.map((r) => r.sourceName).join(', ')}, up to ${chapterText(trusted)}`);
  }
  for (const [r] of outliers) parts.push(`${r.sourceName} claims ${chapterText(r.latest!)}`);
  if (empty.length > 0) parts.push(`${empty.length} ${empty.length === 1 ? 'has' : 'have'} nothing`);

  return { flags, summary: parts.join(' · ') };
}
