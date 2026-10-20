/**
 * Which name a series goes by once it is linked to a source.
 *
 * A series keeps the title it arrived with — the Manga Reader import's, or
 * MangaDex's — and linking it somewhere used to change only where its chapters
 * came from. So a series found under a different name, through Other sources,
 * went on showing the old one: "Dungeon-eul Geurineun Hwaga" on the shelf for a
 * series you had just linked to a source calling it "The Dungeon Painter".
 *
 * So linking takes the source's name — but only when it is a rename and not a
 * respelling. Measured on the real library before writing this: of 55 linked
 * series whose title differed from their source's, 53 differed by a curly
 * apostrophe, a year, an author in brackets, or the source's own housekeeping
 * ("[delete]", "(Promo)", "Can'T"). Taking those would have been 53 changes for
 * the worse. Two were real renames.
 *
 * **And the new name has to read at least as English as the old.** The point is
 * an English name to read, and a source can just as well list a series under
 * its romanised title or its original script. A rename towards those is
 * refused, so linking to a Korean source never turns "The Dungeon Painter" back
 * into the romanisation.
 *
 * No imports, so `manga-check` asserts it directly.
 */

/** A source's own tags, which say something about its catalogue and nothing about the series. */
const HOUSEKEEPING = /\s*[[(](?:delete|deleted|promo|novel|official|official translation|remake|uncensored|raw|colou?red|webtoon|manhwa|manga)[\])]\s*$/i;

/** What a source writes in place of a title for something it has taken down or re-uploaded. */
export function tidySourceTitle(title: string): string {
  let t = title.trim();
  // Repeated, since "Title (Novel) [delete]" carries two.
  for (let i = 0; i < 3 && HOUSEKEEPING.test(t); i++) t = t.replace(HOUSEKEEPING, '').trim();
  return t;
}

/**
 * The title with everything that varies between sources taken out: case,
 * apostrophes and dashes of every kind, bracketed asides (an author, a year, a
 * "Remake 2022"), and all punctuation. Two titles with the same key are the
 * same name written two ways.
 */
export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[‘’ʼ`´]/g, "'")
    // 「」 are quotation marks, not an aside, so what is inside them stays.
    .replace(/[([{【（][^)\]}】）]*[)\]}】）]/g, ' ')
    .replace(/\b(19|20)\d\d\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Cyrillic, Hebrew, Arabic, Thai, Japanese kana, CJK and Hangul: a script you may not read. */
const NON_LATIN = /[Ѐ-ӿ֐-ۿ฀-๿぀-ヿ㐀-鿿가-힯]/;

/** Words that only an English title has many of. */
const ENGLISH = new Set(
  (
    'the a an of to in on at by for from with and or but my your his her its our their me you he she it we they i ' +
    "i'm i'll i've don't can't won't isn't is are was were be been am not no-one who what when where why how " +
    'this that these those as after before into than then become became becoming returns return reborn ' +
    'reincarnated another world level hero villain lady prince princess king queen duke master'
  ).split(' ')
);

/**
 * Particles and endings that mark a romanised Japanese or Korean title.
 *
 * Deliberately short and of words that are not English: "no" is in it because a
 * romanised title is full of it and an English title rarely has it as a word on
 * its own, "a" is not because both have it.
 */
const ROMANISED = new Set(
  (
    'wa wo ni ga de desu shite suru sareta shita nai kara made mo yo ne ka ' +
    'eul reul neun eun ui ege eseo hago geu nae naneun ' +
    'no'
  ).split(' ')
);

/** How English a title reads: its English words, less twice its romanised particles. */
export function englishScore(title: string): number {
  const words = title.toLowerCase().replace(/[‘’]/g, "'").split(/[^a-z']+/).filter(Boolean);
  let score = 0;
  for (const word of words) {
    if (ENGLISH.has(word)) score += 1;
    else if (ROMANISED.has(word)) score -= 2;
  }
  return score;
}

/**
 * The name to switch to, or null to keep the current one.
 *
 * Null when the two are the same name spelled differently, when the source's
 * name is in a script the current one is not, or when it reads as less English.
 * A tie goes to the source, since you chose it and it is what the chapter list
 * will call the series from now on.
 */
export function betterTitle(current: string, sourceTitle: string): string | null {
  const candidate = tidySourceTitle(sourceTitle);
  if (!candidate || titleKey(candidate) === titleKey(current) || !titleKey(candidate)) return null;

  const candidateForeign = NON_LATIN.test(candidate);
  const currentForeign = NON_LATIN.test(current);
  if (candidateForeign && !currentForeign) return null;
  if (currentForeign && !candidateForeign) return candidate;

  return englishScore(candidate) >= englishScore(current) ? candidate : null;
}

/**
 * Rename a series after its source, keeping the old name beside it.
 *
 * The old name goes into `altTitles` so the Library's title box still finds it
 * — you may well type the name you knew it by — and so nothing is lost. Returns
 * whether anything changed.
 */
export function retitleFromSource(series: {
  title: string;
  altTitles?: string[];
  source: { title: string } | null;
}): boolean {
  if (!series.source) return false;
  const next = betterTitle(series.title, series.source.title);
  if (!next) return false;
  const kept = new Set(series.altTitles ?? []);
  kept.add(series.title);
  kept.delete(next);
  series.altTitles = [...kept];
  series.title = next;
  return true;
}
