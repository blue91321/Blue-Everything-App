/**
 * Prove the manga module's decisions, without the network.
 *
 *   npm run manga-check -w @everything/server
 *
 * Inside the package, so it stops existing when the package does — the same
 * arrangement the voice and weather CLIs have.
 *
 * Two things here are worth a suite rather than a reading.
 *
 * **The base36 conversion**, because it looks like a bug on sight: a base-36
 * parse of something that reads like a slug. Somebody tidying that away would
 * break every release check in a way that presents as MangaUpdates having no
 * record of any of your series.
 *
 * **`isNewerChapter`**, because both of its wrong answers are bad in different
 * ways. Too eager raises a nudge about a chapter that does not exist; too shy is
 * a feature that silently never fires, which is indistinguishable from it being
 * switched off.
 *
 * Pass `--live` to also ask the real services. Off by default: a suite that
 * needs the internet is a suite that fails on a train.
 */
import {
  muIdFromLink,
  idsFromMangaDex,
  chapterValue,
  isNewerChapter,
  seriesStatus,
  worthPolling,
} from '../identity.js';
import { alreadyRaised, type Store } from '../library.js';
import { totalChaptersFrom } from '../mangaupdates.js';
import {
  readableChapter,
  titleScore,
  rankMatches,
  profileChapters,
  judgePages,
  sourcesToSearch,
} from '../sources.js';
// A browser-half file with no imports, tested from here the way smoke tests
// integrations/web/presence.ts.
import { judgeSources, languageName, orderSources, type SourceRow } from '../../web/judge.js';
import { uploadedAtMs } from '../suwayomi.js';
import { portOf } from '../process.js';
import { pollable, seriesUrl } from '../releases.js';
import { fromSuwayomiFilter, groupKey, groupMatches, isIndexSource, toSuwayomiChanges } from '../browse.js';
import { thumbPath } from '../present.js';

let failures = 0;
function check(what: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  \x1b[32m✓\x1b[0m' : '  \x1b[31m✗\x1b[0m'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

/* ------------------------------------------------------------------ */
console.log('\nthe id that joins the services\n');

// The real one, taken from MangaDex's record for Vinland Saga and confirmed
// against MangaUpdates. If this number changes, the chain is broken.
check('cql4c43 becomes 27728982867', muIdFromLink('cql4c43') === 27728982867);
check('and back again for the URL', seriesUrl(27728982867).includes('/cql4c43/'));
check('case is folded', muIdFromLink('CQL4C43') === 27728982867);
check('padding is ignored', muIdFromLink('  cql4c43  ') === 27728982867);

check('nothing is null, not NaN', muIdFromLink(null) === null);
check('empty is null', muIdFromLink('') === null);
// A NaN reaching a URL produces a 404 that reads as the series having been
// removed rather than as us having sent nonsense.
check('punctuation is refused', muIdFromLink('cql-4c43') === null);
check('a full URL is refused', muIdFromLink('https://www.mangaupdates.com/series/cql4c43/') === null);

/* ------------------------------------------------------------------ */
console.log('\nreading MangaDex links\n');

const REAL_LINKS = {
  al: '30642',
  ap: 'vinland-saga',
  kt: '1456',
  mu: 'cql4c43',
  mal: '642',
  raw: 'https://pocket.shonenmagazine.com/episode/10834108156664007671',
};

const ids = idsFromMangaDex('abc-123', REAL_LINKS);
check('MyAnimeList id', ids.malId === 642);
check('AniList id', ids.anilistId === 30642);
check('MangaUpdates id, converted', ids.muId === 27728982867);
check('MangaDex id is kept', ids.mangadexId === 'abc-123');

// A doujin or a one-shot routinely has almost nothing. It must still be
// addable — it simply cannot be watched, which the screen says out loud.
const sparse = idsFromMangaDex('xyz', { raw: 'https://twitter.com/i/status/1' });
check('a record with no links gives all nulls', sparse.malId === null && sparse.muId === null);
check('and is therefore not trackable', sparse.muId === null);
check('missing links object at all', idsFromMangaDex('xyz', null).muId === null);

/* ------------------------------------------------------------------ */
console.log('\nwhat counts as a chapter number\n');

check('a plain number', chapterValue('220') === 220);
// Kept as text precisely because these exist.
check('a point-five chapter', chapterValue('220.5') === 220.5);
check('a volume prefix is skipped', chapterValue('v12 c34') === 34);
check('the c. spelling', chapterValue('c.220') === 220);
check('a part number takes the first', chapterValue('12-2') === 12);
check('nothing is null', chapterValue(null) === null);
check('words are null', chapterValue('Oneshot') === null);

/* ------------------------------------------------------------------ */
console.log('\nis this news\n');

check('221 after 220', isNewerChapter('221', '220'));
check('220.5 after 220', isNewerChapter('220.5', '220'));
check('220 after 220 is not', !isNewerChapter('220', '220'));
check('219 after 220 is not', !isNewerChapter('219', '220'));

/*
 * The first sight of a series is not news, and this is the case that matters
 * most. Adding a series should not immediately raise a nudge about the chapter
 * that was already out when you added it — exactly the "already handed in when
 * we first looked" rule the coursework sync follows.
 */
check('nothing seen yet is not news', !isNewerChapter('220', null));

/*
 * Unreadable is *not* news, deliberately. The other reading — treat it as new
 * because it might be — raises a reminder about a chapter nobody can point to,
 * and a nudge you cannot act on is worse than a late one.
 */
check('an unreadable latest is not news', !isNewerChapter('Oneshot', '220'));
check('an unreadable stored value is not news', !isNewerChapter('221', 'Oneshot'));

/* ------------------------------------------------------------------ */
console.log('\nwhat is still worth asking about\n');

check('ongoing', worthPolling(seriesStatus('ongoing')));
// A hiatus ending is exactly the news somebody wants, and it is the one status
// where the interesting event is the status changing.
check('hiatus, because it may come back', worthPolling(seriesStatus('hiatus')));
check('unknown, because we cannot rule it out', worthPolling(seriesStatus('unknown')));
check('completed is not', !worthPolling(seriesStatus('completed')));
check('cancelled is not', !worthPolling(seriesStatus('cancelled')));
check('an unrecognised status reads as unknown', seriesStatus('something-else') === 'unknown');
check('a missing status reads as unknown', seriesStatus(null) === 'unknown');

/* ------------------------------------------------------------------ */
console.log('\nhow many chapters exist\n');

/*
 * The bug this section exists for.
 *
 * `latest_chapter` is the newest release MangaUpdates has *logged*, not the
 * newest chapter that exists. *Archmage Curriculum* read "chapter 23" — a LINE
 * Webtoon release from 2026-09-12 — while its status said 41 chapters and an
 * aggregator was carrying 45. Vinland Saga agreed with reality only because it
 * is finished, which is exactly how the mistake survived the first check.
 */
check('41 Chapters (Ongoing) -> 41', totalChaptersFrom('41 Chapters (Ongoing)') === 41);
check('singular is read too', totalChaptersFrom('1 Chapter (Ongoing)') === 1);
// A volume count is not a chapter count, and multiplying would invent a number
// nobody published.
check('29 Volumes (Complete) -> null', totalChaptersFrom('29 Volumes (Complete)') === null);
check(
  'a mixed status takes the chapters',
  totalChaptersFrom('5 Volumes (Ongoing)\n41 Chapters (Ongoing)') === 41
);
check('words alone -> null', totalChaptersFrom('Ongoing') === null);
check('nothing -> null', totalChaptersFrom(null) === null);
check('a non-string -> null', totalChaptersFrom(41) === null);

/* ------------------------------------------------------------------ */
console.log('\nwhich number to believe\n');

/*
 * A source is serving the chapter, so it knows; MangaUpdates is a database of
 * what groups have reported, so it lags. When a series is linked the source
 * wins — *even if it is lower*, because a source that has fallen behind is
 * still telling the truth about what you could open right now.
 */
check('a linked source wins', readableChapter(45, '23').chapter === '45');
check('  ...and says which it was', readableChapter(45, '23').via === 'source');
check('even when it is lower', readableChapter(12, '23').chapter === '12');
check('unlinked falls back to MangaUpdates', readableChapter(null, '23').chapter === '23');
check('  ...and says which it was', readableChapter(null, '23').via === 'mangaupdates');
check('neither, and no claim is made', readableChapter(null, null).via === null);
// Zero is a real chapter number on a few series and must not read as "nothing".
check('chapter zero is a number, not nothing', readableChapter(0, '23').chapter === '0');
check('a point-five survives the round trip', readableChapter(220.5, null).chapter === '220.5');

/* ------------------------------------------------------------------ */
console.log('\nSuwayomi timestamps\n');

/*
 * `uploadDate` is a `LongString` — epoch milliseconds as *text* — because
 * GraphQL's `Int` is 32-bit and a millisecond timestamp overflows it. Parsing it
 * is required rather than defensive.
 */
check('text milliseconds are parsed', uploadedAtMs('1789769064000') === 1789769064000);
check('a number is taken as it is', uploadedAtMs(1789769064000) === 1789769064000);
check('zero is their "no date", not 1970', uploadedAtMs('0') === null);
check('nothing is null', uploadedAtMs(null) === null);
check('nonsense is null', uploadedAtMs('soon') === null);

/* ------------------------------------------------------------------ */
console.log('\nranking what a source found\n');

/*
 * The bug this replaced: results were sorted by source name then alphabetically
 * by title, so searching "Eleceed" put it *eleventh*, between "Douka Watashi
 * Yori" and "Junji Ito Masterpiece", once per installed MangaFire language. The
 * sources rank their own results perfectly well; the merge threw that away.
 */
check('an exact title wins', titleScore('eleceed', 'Eleceed') === 100);
check('case and punctuation do not matter', titleScore('ELECEED!', 'eleceed') === 100);
check('a prefix beats a substring', titleScore('vinland', 'Vinland Saga') > titleScore('saga', 'Vinland Saga'));
// The noise this is meant to sink: a source asked for "eleceed" returning an
// artbook that shares no word with it.
check('an unrelated title scores nothing', titleScore('eleceed', 'Selected Pandemonium Artbook') === 0);
check('a partial word match scores between', (() => {
  const s = titleScore('archmage curriculum', 'Archmage Transcending Through Regression');
  return s > 0 && s < 60;
})());

const found = rankMatches('eleceed', [
  { title: 'Ao no Miburo', sourceName: 'MangaFire (EN)' },
  { title: 'Selected Pandemonium Artbook', sourceName: 'MangaFire (EN)' },
  { title: 'Eleceed', sourceName: 'MangaFire (ES-419)' },
  { title: 'Eleceed', sourceName: 'MangaFire (EN)' },
  { title: 'Junji Ito Masterpieces', sourceName: 'MangaFire (EN)' },
]);
check('the thing you searched for is first', found[0].title === 'Eleceed', found.map((f) => f.title)[0]);
// Both languages of the same title sit together rather than the whole list
// repeating once per language, which is what made it unreadable.
check('its other language is second', found[1].title === 'Eleceed');
check('the noise sinks', found.at(-1)!.title.startsWith('Selected') || found.at(-1)!.title.startsWith('Junji'));
// Stable, which was the point of the sort it replaced.
check(
  'the same query ranks the same way twice',
  JSON.stringify(rankMatches('eleceed', found)) === JSON.stringify(rankMatches('eleceed', found))
);

/* ------------------------------------------------------------------ */
console.log('\nreading the shape of a chapter list\n');

const ch = (number: number, uploadedAt: number | null = null, id = String(number)) => ({
  id,
  number,
  name: `Chapter ${number}`,
  uploadedAt,
  scanlator: null,
});

const whole = profileChapters([ch(1), ch(2), ch(3), ch(4)]);
check('a complete list has no gaps', whole.missing === 0 && whole.latest === 4 && whole.first === 1);
check('the newest chapter keeps its id, so its pages can be checked', whole.latestChapterId === '4');

const gappy = profileChapters([ch(1), ch(2), ch(6), ch(7)]);
check('chapters skipped are counted', gappy.missing === 3, String(gappy.missing));
check('and named', gappy.missingSample.join(',') === '3,4,5');

// Duplicates across scanlation groups — MangaFire's English Eleceed listed 862
// rows for 418 chapters. That is not a fault, and it is why neither raw number
// is shown as how far a source goes.
const dupes = profileChapters([ch(1, null, 'a'), ch(1, null, 'b'), ch(2, null, 'c'), ch(2, null, 'd')]);
check('duplicate rows are not extra chapters', dupes.entries === 4 && dupes.distinct === 2 && dupes.missing === 0);

check('a point-five is not a gap', profileChapters([ch(1), ch(1.5), ch(2)]).missing === 0);

// A site that picked the series up at chapter 300 is not three hundred chapters
// short — that is its catalogue, not a hole in it.
const late = profileChapters([ch(300), ch(301), ch(302)]);
check('gaps are counted from where the source starts, not from 1', late.missing === 0 && late.first === 300);

check('nothing at all is an honest empty profile', profileChapters([]).latest === null && profileChapters([]).distinct === 0);
check('a nonsense number is ignored', profileChapters([ch(Number.NaN), ch(3)]).latest === 3);
// Walking a hundred thousand integers would be the one slow thing here, and a
// number that absurd is already flagged by the consensus check.
check('an absurd range is not walked', profileChapters([ch(1), ch(99999)]).missing === 0);
check('the newest upload is found', profileChapters([ch(1, 100), ch(2, 300), ch(3, 200)]).newestUpload === 300);

/* ------------------------------------------------------------------ */
console.log('\nwhether pages are real\n');

const img = (bytes: number) => ({ ok: true, bytes, contentType: 'image/webp' });

check('ordinary pages are fine', judgePages(11, [img(215_000), img(90_000), img(44_000)]).state === 'fine');
check('no pages at all is broken', judgePages(0, []).state === 'broken');
check('a page that will not load is broken', judgePages(11, [img(90_000), { ok: false, bytes: 0, contentType: null }]).state === 'broken');
// A CDN serving its error page where the image should be — the commonest form
// "corrupted" takes, and one a byte count alone would miss.
check(
  'html where an image should be is broken',
  judgePages(11, [img(90_000), { ok: true, bytes: 40_000, contentType: 'text/html; charset=utf-8' }]).state === 'broken'
);
// Certain faults are `broken`; things that are *often* wrong are only
// `suspicious`, because a genuinely short chapter exists.
check('a single page is suspicious, not broken', judgePages(1, [img(120_000)]).state === 'suspicious');
check('a tiny page is suspicious', judgePages(11, [img(90_000), img(800)]).state === 'suspicious');
check('and says why', (judgePages(11, [img(800)]).problem ?? '').includes('placeholder'));

/* ------------------------------------------------------------------ */
console.log('\njudging sources against each other\n');

const src = (sourceName: string, latest: number | null, extra: Partial<SourceRow> = {}): SourceRow => ({
  key: sourceName,
  sourceName,
  lang: 'en',
  latest,
  distinct: latest === null ? 0 : latest,
  missing: 0,
  missingSample: [],
  newestUpload: null,
  counted: true,
  ...extra,
});
const tones = (v: ReturnType<typeof judgeSources>, key: string) => (v.flags[key] ?? []).map((f) => f.tone);
const says = (v: ReturnType<typeof judgeSources>, key: string, text: string) =>
  (v.flags[key] ?? []).some((f) => f.text.includes(text));

// The real numbers from Eleceed on MangaFire's languages.
const eleceed = judgeSources([
  src('MangaFire (EN)', 418, { lang: 'en' }),
  src('MangaFire (ES-419)', 408, { lang: 'es-419' }),
  src('MangaFire (ES)', null, { lang: 'es' }),
  src('MangaFire (FR)', 375, { lang: 'fr' }),
  src('MangaFire (PT-BR)', 401, { lang: 'pt-BR' }),
]);
/*
 * The case that broke the first version. Compared across languages, English was
 * a lone leader ten clear of Spanish and was flagged as possibly padding — the
 * very source already verified to reach 418. Translations trail the English they
 * are made from; that is not evidence about English.
 */
check('a translation trailing English does not make English suspect', !says(eleceed, 'MangaFire (EN)', 'Check'));
check('the furthest source is named', tones(eleceed, 'MangaFire (EN)').includes('good'));
check('the others say how far behind', says(eleceed, 'MangaFire (ES-419)', '10 behind'));
check('an empty source is ruled out', tones(eleceed, 'MangaFire (ES)').includes('bad'));
check('the summary leads with the answer', (eleceed.summary ?? '').startsWith('Furthest: MangaFire (EN), up to 418'), eleceed.summary ?? '');

/*
 * The case the old reader's view was really for. A source "on 425" while every
 * other one stops at 418 looks like the best source by its number alone — and
 * is either genuinely faster or padding its list. Only its pages can say which,
 * so it is flagged for checking rather than crowned.
 */
const padded = judgeSources([src('Sketchy', 425), src('MangaFire (EN)', 418), src('Asura', 417)]);
check('a lone source far ahead is not called the best', !tones(padded, 'Sketchy').includes('good'));
check('it is flagged for checking', says(padded, 'Sketchy', 'Check its newest pages'));
check('the others are measured from the runner-up, not the claim', !says(padded, 'MangaFire (EN)', 'behind'));
check('and the runner-up is behind by 1, not 8', says(padded, 'Asura', '1 behind'));
check('the summary names the claim separately', (padded.summary ?? '').includes('Sketchy claims 425'), padded.summary ?? '');

// Two sources agreeing is a much stronger claim than one saying so.
const agreed = judgeSources([src('A', 425), src('B', 425), src('C', 418)]);
check('two sources ahead together are not an outlier', tones(agreed, 'A').includes('good') && tones(agreed, 'B').includes('good'));

check('a small lead is ordinary release timing', !says(judgeSources([src('A', 420), src('B', 418)]), 'A', 'Check'));

// Within a language the check still bites, whatever the other languages do.
const mixed = judgeSources([
  src('Sketchy', 430, { lang: 'en' }),
  src('Honest', 418, { lang: 'en' }),
  src('Spanish', 390, { lang: 'es' }),
]);
check('an English outlier is caught among English sources', says(mixed, 'Sketchy', 'ahead of every other EN source'));
check('and the Spanish source is measured from the honest one', says(mixed, 'Spanish', '28 behind'));

/*
 * A source serving every language must not escape the check by being in a
 * language group of its own — Manhwa18.cc registers one beside its English
 * source. It is compared with the language it is actually serving you in.
 */
const everyLanguage = judgeSources([
  src('Aggregator (ALL)', 430, { lang: 'all' }),
  src('MangaFire (EN)', 419, { lang: 'en' }),
  src('Webtoons (EN)', 418, { lang: 'en' }),
]);
check('an every-language source padding its list is still caught', says(everyLanguage, 'Aggregator (ALL)', 'Check'));
// …and does not get flagged just for leading a trailing translation.
const allVsSpanish = judgeSources([
  src('Aggregator (ALL)', 419, { lang: 'all' }),
  src('MangaFire (EN)', 419, { lang: 'en' }),
  src('MangaFire (ES)', 408, { lang: 'es' }),
]);
check('nor is it measured against a translation', !says(allVsSpanish, 'Aggregator (ALL)', 'Check'));

// The real English Eleceed numbers, as counted today.
const realEleceed = judgeSources([
  src('MangaDex (EN)', 390, { missing: 287, missingSample: [23, 24, 25, 26, 27], distinct: 103 }),
  src('MangaFire (EN)', 419, { distinct: 460 }),
  src('Manhwa18.cc (ALL)', 419, { lang: 'all' }),
  src('Manhwa18.cc (EN)', 419),
  src('Webtoons.com (EN)', 404),
]);
check('three sources agreeing on 419 are all furthest', ['MangaFire (EN)', 'Manhwa18.cc (ALL)', 'Manhwa18.cc (EN)'].every((k) => tones(realEleceed, k).includes('good')));
check('the incomplete one is named as incomplete', says(realEleceed, 'MangaDex (EN)', 'missing 287 chapters'));
check('the official one is simply behind', says(realEleceed, 'Webtoons.com (EN)', '15 behind'));

const alone = judgeSources([src('Only', 50), src('Empty', null)]);
check('a single source with chapters says there is nothing to compare', says(alone, 'Only', 'only source'));

const holes = judgeSources([src('A', 50, { missing: 3, missingSample: [12, 13, 14] }), src('B', 50)]);
check('gaps are reported with their numbers', says(holes, 'A', 'missing 3 chapters (12, 13, 14)'));

const DAY = 24 * 60 * 60_000;
const stale = judgeSources([src('Fresh', 50, { newestUpload: 400 * DAY }), src('Quiet', 49, { newestUpload: 100 * DAY })]);
check('a source gone quiet while others carry on is stale', says(stale, 'Quiet', 'before the freshest'));
// Compared with each other, never with today — so a series on hiatus, with every
// source quiet for a year, is not reported as stale everywhere.
const hiatus = judgeSources([src('A', 50, { newestUpload: 10 * DAY }), src('B', 50, { newestUpload: 12 * DAY })]);
check('everyone quiet together is not stale', !says(hiatus, 'A', 'freshest') && !says(hiatus, 'B', 'freshest'));

check(
  'rows still counting take no part',
  judgeSources([src('A', 900), src('B', 50, { counted: false, latest: null })]).summary?.includes('up to 900') === true
);
check('nothing counted yet has no verdict', judgeSources([src('A', null, { counted: false })]).summary === null);

/* ------------------------------------------------------------------ */
console.log('\nbrowsing: one row per series\n');

check('case and punctuation fold', groupKey('Solo Leveling!') === groupKey('solo leveling'));
check('a bracketed aside folds', groupKey('Solo Leveling (Official)') === groupKey('Solo Leveling [Colored]'));
check('accents fold', groupKey('Pokémon Adventures') === groupKey('Pokemon Adventures'));
// A sequel is a different series, and folding it in would mix two chapter counts.
check('a subtitle does not', groupKey('Solo Leveling: Ragnarok') !== groupKey('Solo Leveling'));

const m = (title: string, sourceId: string, score: number, id = title + sourceId) => ({
  id,
  title,
  sourceId,
  sourceName: `S${sourceId}`,
  lang: 'en',
  score,
});
const grouped = groupMatches(
  [
    m('Solo Leveling', '1', 100),
    m('Solo Leveling: Ragnarok', '2', 80),
    m('SOLO LEVELING (Official)', '2', 100),
    m('Solo Leveling: Ragnarok', '3', 80),
    m('Solo Leveling', '3', 100),
  ],
  '2'
);
check('the same series from three sources is one row', grouped.length === 2, grouped.map((g) => g.title).join(' / '));
check('the chosen source leads its row', grouped[0].entries[0].sourceId === '2' && grouped[0].title === 'SOLO LEVELING (Official)');
check('every source is still listed', grouped[0].entries.length === 3);
check('a row the chosen source is in comes first', grouped[0].preferred && grouped[1].preferred);
const notChosen = groupMatches([m('Other', '1', 100), m('Mine', '2', 60)], '2');
check('it outranks a better title match from elsewhere', notChosen[0].title === 'Mine');
// The real case: "solo leveling" with MangaFire chosen put "Solo DPS!" above an
// exact title from every other site. Preferring is a tie-break between answers.
const nonAnswer = groupMatches([m('Solo DPS!', '2', 25), m('Solo Leveling', '1', 100)], '2');
check('but not a title that does not answer the search', nonAnswer[0].title === 'Solo Leveling', nonAnswer.map((g) => g.title).join(' / '));
const noneChosen = groupMatches([m('Weak', '1', 60), m('Strong', '1', 100), m('Strong', '3', 100)], null);
check('with no choice, the best match leads', noneChosen[0].title === 'Strong');
check('and more sources beat fewer on a tie', groupMatches([m('A', '1', 100), m('B', '1', 100), m('B', '3', 100)], null)[0].title === 'B');

console.log('\nbrowsing: filters\n');

// Real shapes, from MangaFire's and MangaDex's own filter lists.
const filters = [
  fromSuwayomiFilter({ __typename: 'GroupFilter', name: 'Genres', filters: [
    { __typename: 'TriStateFilter', name: 'Action', triDefault: 'IGNORE' },
    { __typename: 'TriStateFilter', name: 'Comedy', triDefault: 'IGNORE' },
  ] }),
  fromSuwayomiFilter({ __typename: 'SeparatorFilter', name: '' }),
  fromSuwayomiFilter({ __typename: 'SelectFilter', name: 'Sort by', selectDefault: 1, values: ['Latest', 'Best match'] }),
  fromSuwayomiFilter({ __typename: 'TextFilter', name: 'Minimum chapters', textDefault: '' }),
  fromSuwayomiFilter({ __typename: 'SortFilter', name: 'Sort', values: ['A-Z', 'Follows'], sortDefault: { index: 1, ascending: false } }),
  fromSuwayomiFilter({ __typename: 'CheckBoxFilter', name: 'Has chapters', checkDefault: false }),
  fromSuwayomiFilter({ __typename: 'SomethingNew', name: '?' }),
];
check('each kind is read', filters.map((f) => f.kind).join(',') === 'group,separator,select,text,sort,checkbox,separator');
check('a default is read from its alias', filters[2].kind === 'select' && filters[2].default === 1);
check('a group keeps what is inside', filters[0].kind === 'group' && filters[0].filters.length === 2);

const sent = toSuwayomiChanges(filters, [
  { position: 0, inner: 1, tristate: 'include' },
  { position: 0, inner: 0, tristate: 'exclude' },
  { position: 2, select: 0 },
  { position: 3, text: '20' },
  { position: 4, sort: { index: 0, ascending: true } },
  { position: 5, checkbox: true },
]);
check('every valid change is sent', sent.input.length === 6 && sent.dropped === 0);
check('a change inside a group rides groupChange', JSON.stringify(sent.input[0]) === '{"position":0,"groupChange":{"position":1,"triState":"INCLUDE"}}');
check('two changes in one group are two entries', sent.input[1].groupChange?.position === 0);
check('a select sends its index', sent.input[2].selectState === 0);

const refused = toSuwayomiChanges(filters, [
  { position: 3, checkbox: true }, // a checkbox value at a text box
  { position: 2, select: 9 }, // past the end of the list
  { position: 1, text: 'x' }, // a separator
  { position: 99, checkbox: true }, // nothing there
  { position: 0, inner: 7, tristate: 'include' }, // nothing inside at 7
]);
check('changes that do not fit are dropped, and counted', refused.input.length === 0 && refused.dropped === 5);

console.log('\nbrowsing: covers\n');

// The cover proxy's guard. Anything it lets through, the server will fetch.
check('a Suwayomi thumbnail is served', thumbPath('/api/v1/manga/12/thumbnail') === '/api/manga/thumb?p=%2Fapi%2Fv1%2Fmanga%2F12%2Fthumbnail');
check('with its host and cache-buster taken off', thumbPath('http://127.0.0.1:4567/api/v1/manga/12/thumbnail?v=3') === thumbPath('/api/v1/manga/12/thumbnail'));
check('a page is not a cover', thumbPath('/api/v1/manga/12/chapter/1/page/0') === null);
check('a climb out is refused', thumbPath('/api/v1/manga/12/../../settings') === null);
check('an outside address is refused', thumbPath('https://example.com/cover.jpg') === null);
check('nothing is nothing', thumbPath(null) === null);

/* ------------------------------------------------------------------ */
console.log('\ncatalogues go first only when they are ahead\n');

check('MangaDex is a catalogue', isIndexSource('MangaDex (EN)') && isIndexSource('mangadex'));
check('so is MangaUpdates', isIndexSource('MangaUpdates') && isIndexSource('Manga Updates'));
check('MangaFire is not', !isIndexSource('MangaFire (EN)'));
check('nor is a name that merely contains it', !isIndexSource('NotMangaDex Mirror'));

// The reason: "MangaDex" sorts before "MangaFire", so an equal title put it first.
const tied = rankMatches('eleceed', [
  { title: 'Eleceed', sourceName: 'MangaDex (EN)' },
  { title: 'Eleceed', sourceName: 'MangaFire (EN)' },
]);
check('an equal match on a reading site ranks above a catalogue', tied[0].sourceName === 'MangaFire (EN)');
const better = rankMatches('eleceed', [
  { title: 'Eleceed', sourceName: 'MangaDex (EN)' },
  { title: 'Eleceed (Official)', sourceName: 'MangaFire (EN)' },
]);
check('but a better match still wins, wherever it is', better[0].sourceName === 'MangaDex (EN)');
const rowOrder = groupMatches([m('Eleceed', '9', 100, 'a'), m('Eleceed', '1', 100, 'b')].map((x, i) => ({ ...x, sourceName: i === 0 ? 'MangaDex (EN)' : 'MangaFire (EN)' })), null);
check('inside a search row, the catalogue copy is not the lead', rowOrder[0].entries[0].sourceName === 'MangaFire (EN)');

// The comparison screen, with the real Eleceed numbers: MangaDex was listed first
// at 390 against three sources at 419.
const eleceedRows = [
  src('MangaDex (EN)', 390, { missing: 287, missingSample: [23, 24, 25, 26, 27], distinct: 103 }),
  src('MangaFire (EN)', 419),
  src('Manhwa18.cc (EN)', 419),
  src('Webtoons.com (EN)', 404),
  src('Empty', null),
];
const ordered = orderSources(eleceedRows, judgeSources(eleceedRows)).map((r) => r.sourceName);
check('furthest first', ordered[0] === 'MangaFire (EN)' && ordered[1] === 'Manhwa18.cc (EN)', ordered.join(', '));
check('MangaDex where its number puts it', ordered.indexOf('MangaDex (EN)') === 3, ordered.join(', '));
check('nothing at all last', ordered[4] === 'Empty');

const dexTied = [src('MangaDex (EN)', 419), src('MangaFire (EN)', 419)];
check('level with another source, it is not first', orderSources(dexTied, judgeSources(dexTied))[0].sourceName === 'MangaFire (EN)');

const dexAhead = [src('MangaDex (EN)', 421), src('MangaFire (EN)', 419), src('Asura', 419)];
check('genuinely ahead, it is first', orderSources(dexAhead, judgeSources(dexAhead))[0].sourceName === 'MangaDex (EN)');

// Far ahead is a claim waiting on your review, and a catalogue does not lead on a claim.
const dexClaims = [src('MangaDex (EN)', 450), src('MangaFire (EN)', 419), src('Asura', 418)];
const claimVerdict = judgeSources(dexClaims);
check('far ahead is flagged for review', 'MangaDex (EN)' in claimVerdict.awaiting);
check('and does not lead until you say it is real', orderSources(dexClaims, claimVerdict)[0].sourceName === 'MangaFire (EN)');
const dexConfirmed = [src('MangaDex (EN)', 450, { review: { verdict: 'real', upTo: 450 } }), src('MangaFire (EN)', 419), src('Asura', 418)];
check('once you do, it leads', orderSources(dexConfirmed, judgeSources(dexConfirmed))[0].sourceName === 'MangaDex (EN)');

// Any other source keeps its place by its claim, flagged — Archmage today:
// MangaFire's 46 is right, and burying it under Webtoons' 25 would be wrong.
const archmageRows = [src('Webtoons.com (EN)', 25), src('MangaFire (EN)', 46)];
check('a reading site ahead is not held back by the rule', orderSources(archmageRows, judgeSources(archmageRows))[0].sourceName === 'MangaFire (EN)');

const pending = [src('MangaDex (EN)', null, { counted: false }), src('Slow', null, { counted: false }), src('MangaFire (EN)', 419)];
check('rows still counting wait below the counted ones', orderSources(pending, judgeSources(pending))[0].sourceName === 'MangaFire (EN)');
check('and a catalogue waits behind them', orderSources(pending, judgeSources(pending))[1].sourceName === 'Slow');

/* ------------------------------------------------------------------ */
console.log('\nyour verdict on a flag\n');

/*
 * The case that made this necessary: Archmage Curriculum today. MangaFire has 46,
 * which is right; Webtoons has the official release at 25, which trails the
 * scanlations as a matter of course. Two sources cannot say which is wrong, so
 * the flag asks — and until answered, it asks.
 */
const archmage = [src('MangaFire (EN)', 46), src('Webtoons.com (EN)', 25)];
const asked = judgeSources(archmage);
check('an unanswered lead is offered for review', 'MangaFire (EN)' in asked.awaiting);
check('and the laggard is not', !('Webtoons.com (EN)' in asked.awaiting));
check('at the chapter it claims', asked.awaiting['MangaFire (EN)'] === 46);

const real = { verdict: 'real' as const, upTo: 46 };
const answered = judgeSources([src('MangaFire (EN)', 46, { review: real }), src('Webtoons.com (EN)', 25)]);
check('confirmed, it is no longer flagged', !says(answered, 'MangaFire (EN)', 'Check'));
check('nor offered again', answered.awaiting['MangaFire (EN)'] === undefined);
check('it is furthest along', tones(answered, 'MangaFire (EN)').includes('good') && says(answered, 'MangaFire (EN)', 'furthest'));
check('and says you checked', says(answered, 'MangaFire (EN)', 'you checked'));
check('the other is measured from it', says(answered, 'Webtoons.com (EN)', '21 behind'));
check('the summary names it plainly', (answered.summary ?? '').startsWith('Furthest: MangaFire (EN), up to 46'), answered.summary ?? '');

// A verdict covers the claim you looked at, and nothing past it.
check('a chapter more is ordinary', !says(judgeSources([src('MangaFire (EN)', 47, { review: real }), src('Webtoons.com (EN)', 25)]), 'MangaFire (EN)', 'Check'));
const jumped = judgeSources([src('MangaFire (EN)', 60, { review: real }), src('Webtoons.com (EN)', 25)]);
check('a big jump past it is a new claim', jumped.awaiting['MangaFire (EN)'] === 60);
check('measured from what you confirmed, not from the laggard', says(jumped, 'MangaFire (EN)', '14 past the 46 you confirmed'));
// A source that later lists fewer is still covered — taking chapters down is not a new claim.
check('fewer than confirmed is still confirmed', says(judgeSources([src('MangaFire (EN)', 44, { review: real }), src('W', 25)]), 'MangaFire (EN)', 'you checked'));

const fake = { verdict: 'fake' as const, upTo: 46 };
const rejectedClaim = judgeSources([src('Sketchy', 46, { review: fake }), src('Honest', 25), src('Other', 24)]);
check('marked not real, it is ruled out', tones(rejectedClaim, 'Sketchy').includes('bad'));
check('never furthest', !tones(rejectedClaim, 'Sketchy').includes('good'));
check('the honest source leads instead', tones(rejectedClaim, 'Honest').includes('good'));
check('and nobody is measured against the fake claim', !says(rejectedClaim, 'Other', '22 behind') && says(rejectedClaim, 'Other', '1 behind'));
check('the summary says so', (rejectedClaim.summary ?? '').includes('Sketchy marked not real'), rejectedClaim.summary ?? '');
// Taking the padding down ends the verdict: the list is judged afresh.
check('a source that drops its fake chapters is judged again', !tones(judgeSources([src('Sketchy', 25, { review: fake }), src('Honest', 25)]), 'Sketchy').includes('bad'));

/* ------------------------------------------------------------------ */
console.log('\nwhich sources a search asks\n');

/*
 * The install that forced this: MangaDex registers a source per language, so 82
 * sources across 63 languages, 7 of them English — and a comparison of Eleceed
 * came back as twenty empty MangaDex languages while MangaFire's English source,
 * the one that reaches 418, fell off the end of the list.
 */
const installed = [
  { name: 'MangaFire (EN)', lang: 'en' },
  { name: 'Asura Scans (EN)', lang: 'en' },
  { name: 'MangaDex (AF)', lang: 'af' },
  { name: 'MangaDex (AZ)', lang: 'az' },
  { name: 'MangaFire (PT-BR)', lang: 'pt-BR' },
  { name: 'Comick', lang: 'all' },
  { name: 'Local source', lang: 'localsourcelang' },
];
const english = sourcesToSearch(installed, ['en']);
check(
  'only the languages you read are asked',
  english.searched.map((s) => s.name).join(', ') === 'MangaFire (EN), Asura Scans (EN), Comick, Local source',
  english.searched.map((s) => s.name).join(', ')
);
// Reported, so the screen can say how many were left out rather than a short
// list reading as those sources not having the series.
check('and the rest are counted, not silently dropped', english.skipped === 3);
check('a multi-language source is never filtered out', english.searched.some((s) => s.lang === 'all'));
check('nor are your own files', english.searched.some((s) => s.lang === 'localsourcelang'));
check('codes match whatever their case', sourcesToSearch(installed, ['PT-br']).searched.some((s) => s.name === 'MangaFire (PT-BR)'));
check('null asks every source', sourcesToSearch(installed, null).searched.length === installed.length);
// An empty choice would otherwise search nothing and find nothing — which reads
// as every source lacking the series.
check('an empty choice asks every source rather than none', sourcesToSearch(installed, []).searched.length === installed.length);

check('a code becomes its name', languageName('en') === 'English', languageName('en'));
check('a regional code keeps its region', languageName('es-419').includes('Spanish'), languageName('es-419'));
check('the non-languages read as what they are', languageName('localsourcelang') === 'Your own files');
// An unrecognised tag throws inside Intl rather than returning undefined.
check('a tag Intl cannot read falls back to the code', languageName('not a tag!') === 'NOT A TAG!');

/* ------------------------------------------------------------------ */
console.log('\nfinding the port to stop\n');

/*
 * Load-bearing for the kill path. An adopted Suwayomi is found by the port it
 * listens on, because a force-killed restart leaves this process no handle to
 * it — and that fallback is the only thing that can stop an orphan at all.
 * Getting the port wrong means looking up the wrong process, or none.
 */
check('an explicit port', portOf('http://127.0.0.1:4567') === 4567);
check('a different one', portOf('http://127.0.0.1:8080') === 8080);
check('http defaults to 80', portOf('http://example.test') === 80);
check('https defaults to 443', portOf('https://example.test') === 443);
// Never NaN, which would be handed to a process lookup.
check("nonsense falls back to Suwayomi's own", portOf('not a url') === 4567);
check('empty falls back too', portOf('') === 4567);

/* ------------------------------------------------------------------ */
console.log('\nthe rotation\n');

const row = (over: Partial<Store['series'][number]>): Store['series'][number] => ({
  id: 'x',
  title: 'X',
  coverUrl: null,
  mangadexId: 'm',
  malId: null,
  anilistId: null,
  muId: 1,
  status: 'ongoing',
  latestChapter: null,
  totalChapters: null,
  source: null,
  sourceChapter: null,
  sourceCheckedAt: null,
  readChapters: [],
  reviews: [],
  readLog: [],
  checkedAt: null,
  error: null,
  addedAt: 0,
  ...over,
});

const store: Store = {
  suwayomiUrl: null,
  suwayomiJar: null,
  manageSuwayomi: false,
  suwayomiMode: 'on-demand',
  readLanguages: ['en'],
  releaseTasks: false,
  browseSource: null,
  series: [
    row({ id: 'recent', checkedAt: 1_000 }),
    row({ id: 'stale', checkedAt: 10 }),
    row({ id: 'fresh-add', checkedAt: null }),
    row({ id: 'done', status: 'completed', checkedAt: 5 }),
    row({ id: 'untrackable', muId: null, checkedAt: 5 }),
  ],
  links: [{ seriesId: 'recent', chapter: '12', taskId: 't', raisedAt: 0 }],
};

const order = pollable(store).map((s) => s.id);
check('a finished series leaves the rotation', !order.includes('done'), order.join(', '));
check('so does one with no MangaUpdates id', !order.includes('untrackable'));
// Ordering by `checkedAt` makes the rotation fall out of the data rather than
// needing a cursor, and a just-added series has null, so it goes first — which
// is right, since it is the one being watched.
check('a newly added series is asked about first', order[0] === 'fresh-add', order.join(' → '));
check('then the one asked about longest ago', order[1] === 'stale');
check('and the recently checked one last', order.at(-1) === 'recent');

check('a raised chapter is remembered', alreadyRaised(store, 'recent', '12'));
check('a different chapter is not', !alreadyRaised(store, 'recent', '13'));
check('nor the same chapter of another series', !alreadyRaised(store, 'stale', '12'));

/* ------------------------------------------------------------------ */
if (process.argv.includes('--live')) {
  console.log('\nagainst the real services\n');
  const { search } = await import('../mangadex.js');
  const { readSeries } = await import('../mangaupdates.js');

  try {
    const results = await search('vinland saga', 5);
    const hit = results.find((r) => r.malId === 642);
    check('MangaDex finds it', Boolean(hit), hit ? hit.title : 'no match');
    check('and hands over every other id', Boolean(hit?.muId && hit?.anilistId), JSON.stringify(hit?.muId));

    if (hit?.muId) {
      const reading = await readSeries(hit.muId);
      check('MangaUpdates answers to the converted id', reading.title !== null, reading.title ?? '');
      check('with a chapter number', reading.latestChapter !== null, reading.latestChapter ?? '');
      // The whole chain, end to end: a title typed by a person becomes a number
      // from one service used as a key into another.
      check('a finished series reports itself finished', reading.completed);
    }
  } catch (error) {
    check('live check', false, error instanceof Error ? error.message : String(error));
  }
}

console.log(
  failures === 0 ? '\n\x1b[32mall good\x1b[0m\n' : `\n\x1b[31m${failures} failed\x1b[0m\n`
);
process.exit(failures === 0 ? 0 : 1);
