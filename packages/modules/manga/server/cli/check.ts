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
import { alreadyRaised, clampReadAhead, isPutAway, MAX_READ_AHEAD, type ReadingPosition, type Store } from '../library.js';
import { KEEP_CHAPTERS, readAheadAt } from '../page-cache.js';
import { beside, reachedTheEnd, skippedBetween, skipTarget } from '../../web/chapter-nav.js';
import { fromLine, toLine } from '../../web/log-csv.js';
import { isWholeImage } from '../../web/image-bytes.js';
import { applyReadMark, placeIsAtEnd, type Readable } from '../read-marks.js';
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
import { explainFailure, findJars, portOf } from '../process.js';
import { BATCH, checkEvery, dueForCheck, pollable, RECENT_SLOTS, RETRY_SLOTS, seriesUrl } from '../releases.js';
import { fromSuwayomiFilter, groupKey, groupMatches, isIndexSource, toSuwayomiChanges } from '../browse.js';
import { thumbPath } from '../present.js';
import { betterTitle, retitleFromSource } from '../titles.js';
import { sorted } from '../../web/shelf.js';
import { fetchPage, pagesInFlight, PageFetchError, sharedPage, SLOW_FAILURE_MS } from '../page-fetch.js';
import { glideDistance, glideStep, MAX_SPEED, releaseVelocity, STOP_SPEED } from '../../web/glide.js';
import { normaliseTags } from '../tags.js';
import { DEFAULT_HIDDEN_TAGS, hasTag, hiddenBy, tagsForLevel } from '../mature.js';
import { extensionUsage } from '../extension-usage.js';
import { chapterFolder, mendManifest, nextInQueue, pickEdition, type ArchiveManifest, type QueueItem } from '../archive.js';
import { mkdirSync as mkdirTmp, mkdtempSync, readdirSync as listTmp, rmSync as rmTmp, writeFileSync as writeTmp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinTmp } from 'node:path';

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
console.log('\nwhen Suwayomi will not start\n');

// Word for word what a PC with Java 17 printed, trying the 2.3 jar.
const java17 =
  'Error: LinkageError occurred while loading main class suwayomi.tachidesk.MainKt\n\tjava.lang.UnsupportedClassVersionError: suwayomi/tachidesk/MainKt has been compiled by a more recent version of the Java Runtime (class file version 65.0), this version of the Java Runtime only recognizes class file versions up to 61.0';
const tooOld = explainFailure(java17, 1);
check('an old Java is named, with the version it is', tooOld.includes('Java 21') && tooOld.includes('Java 17'), tooOld);
check('and the fix is the setup button', tooOld.includes('Set up manga'));
// And what it printed when pointed at the installer instead.
const msi = explainFailure('Error: Invalid or corrupt jarfile C:\\x\\Suwayomi-Server-v2.3.2243-windows-x64.msi', 1);
check('an installer chosen as the jar is called an installer', msi.includes('.msi') && msi.includes('Set up manga'), msi);
check('anything else points at the log', explainFailure('something new', 3).includes('log'));
// Only the app's own folders: the Downloads search is what offered the .msi.
check('jars are looked for inside the app only', findJars().every((p) => !/Downloads/i.test(p)));

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
  archiveFolder: null,
  suwayomiJar: null,
  manageSuwayomi: false,
  suwayomiMode: 'on-demand',
  readLanguages: ['en'],
  releaseTasks: false,
  readAheadChapters: 1,
  shelfShow: 'all',
  shelfSort: 'follow',
  shelfNewFirst: true,
  shelfFavFirst: false,
  releaseNudges: true,
  autoUpdateExtensions: true,
  autoKeepFavourites: false,
  autoKeepMinRating: null,
  shareRatingsWithCopies: false,
  browseSource: null,
  libraries: [],
  glimpses: [],
  ignoredSources: [],
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

{
  // Manage extensions' counts: per source name, summed per extension.
  const sources = [
    { id: '1', name: 'MangaFire (EN)', lang: 'en', pkg: 'mf' },
    { id: '2', name: 'MangaFire (ES)', lang: 'es', pkg: 'mf' },
    { id: '3', name: 'Asura Scans (EN)', lang: 'en', pkg: 'asura' },
  ];
  const usage = extensionUsage(
    [
      { source: { sourceName: 'MangaFire (EN)' }, readLog: [{ chapter: 1, source: 'MangaFire (EN)' }, { chapter: 1, source: 'MangaFire (EN)' }, { chapter: 2, source: 'MangaFire (ES)' }] },
      { source: { sourceName: 'Asura Scans (EN)' }, readLog: [{ chapter: 5, source: 'MangaFire (EN)' }, { chapter: 6, source: null }] },
      { source: null, readLog: [] },
    ],
    [{ source: { sourceName: 'Asura Scans (EN)' }, readLog: [{ chapter: 9, source: 'Asura Scans (EN)' }] }],
    sources
  );
  check('an extension counts the series linked to any of its sources', usage.mf?.series === 1 && usage.asura?.series === 1);
  check('a re-read chapter counts once', usage.mf?.chapters === 3, String(usage.mf?.chapters));
  check('a chapter counts where it was read, not where the series is linked now', usage.asura?.chapters === 1);
  check('a series read but not followed adds chapters, not a series', usage.asura?.series === 1);
  check('an extension lists its sources', usage.mf?.sources.length === 2);
}

{
  // Hidden wins: a series on a hidden shelf and a visible one is put away.
  const shelves = { libraries: [{ id: 'a', name: 'Dropped', hidden: true }, { id: 'b', name: 'Reading' }] };
  check('a series on a hidden shelf is put away', isPutAway(shelves, { libraries: ['a'] }));
  check('hidden wins over a visible shelf it is also on', isPutAway(shelves, { libraries: ['b', 'a'] }));
  check('a series only on visible shelves is not', !isPutAway(shelves, { libraries: ['b'] }));
  check('nor one on no shelf at all', !isPutAway(shelves, {}));
}

/* ------------------------------------------------------------------ */
console.log('\nwhat a sweep asks about\n');

/*
 * The case this exists for: nine hundred series brought in at once, none ever
 * checked. Ordered purely by `checkedAt` they would all go ahead of the three
 * being read this week, which would then wait a day and a half for a turn.
 */
{
  const DAY = 24 * 60 * 60_000;
  const now = 1_000 * DAY;
  const backlog = Array.from({ length: 40 }, (_, i) => row({ id: `old-${i}`, addedAt: 0, checkedAt: null }));
  const reading = [
    row({ id: 'added', addedAt: now - DAY, checkedAt: now - 60_000 }),
    row({ id: 'logged', addedAt: 0, checkedAt: now - 60_000, readLog: [{ chapter: 3, source: null, mangaId: null, at: now - 2 * DAY }] }),
    row({ id: 'placed', addedAt: 0, checkedAt: now - 60_000 }),
  ];
  const place: ReadingPosition = {
    chapter: 4, chapterId: 'c', chapterName: '4', source: 's', mangaId: 'm', page: 0, offset: 0, pages: 10, at: now - 3 * DAY,
  };
  const big: Store = { ...store, series: [...backlog, ...reading], links: [] };
  const due = dueForCheck(big, now, { placed: place }).map((s) => s.id);
  check('a sweep is still twelve', due.length === 12, String(due.length));
  check(
    "this month's series are asked about ahead of a backlog",
    ['added', 'logged', 'placed'].every((id) => due.includes(id)),
    due.slice(0, 4).join(', ')
  );
  check('a read, a place and a follow all count as this month', due.filter((id) => !id.startsWith('old-')).length === 3);
  check('and the backlog has the rest of the slots', due.filter((id) => id.startsWith('old-')).length === 9);

  // More recent series than slots: the backlog still moves.
  const many = Array.from({ length: 20 }, (_, i) => row({ id: `now-${i}`, addedAt: now - DAY, checkedAt: now - 60_000 }));
  const crowded = dueForCheck({ ...store, series: [...backlog, ...many], links: [] }, now, {}).map((s) => s.id);
  check(
    `this month's take ${RECENT_SLOTS} slots, not all of them`,
    crowded.filter((id) => id.startsWith('now-')).length === RECENT_SLOTS
  );

  // Nothing old waiting: every slot goes to this month's.
  const onlyNew = dueForCheck({ ...store, series: many, links: [] }, now, {});
  check('unused slots are not wasted', onlyNew.length === 12, String(onlyNew.length));

  const spaced = (id: string, active: number, checked: number) => row({ id, addedAt: active, checkedAt: checked });
  const quiet = dueForCheck(
    {
      ...store,
      links: [],
      series: [
        spaced('ancient-checked-2h', 0, now - 2 * 60 * 60_000),
        spaced('ancient-checked-25h', 0, now - 25 * 60 * 60_000),
        spaced('spring-checked-2h', now - 60 * DAY, now - 2 * 60 * 60_000),
        spaced('spring-checked-7h', now - 60 * DAY, now - 7 * 60 * 60_000),
      ],
    },
    now,
    {}
  ).map((s) => s.id);
  check('untouched for a year: once a day, not every sweep', !quiet.includes('ancient-checked-2h') && quiet.includes('ancient-checked-25h'), quiet.join(', '));
  check('read this year: every six hours', !quiet.includes('spring-checked-2h') && quiet.includes('spring-checked-7h'));

  // Suwayomi stopped: what nothing can answer for must not take the slots of what MangaUpdates can.
  const unaskable = Array.from({ length: 20 }, (_, i) => row({ id: `stuck-${i}`, addedAt: now - DAY, checkedAt: null }));
  const answerable = Array.from({ length: 5 }, (_, i) => row({ id: `mu-${i}`, addedAt: 0, checkedAt: null }));
  const whileDown = dueForCheck(
    { ...store, series: [...unaskable, ...answerable], links: [] },
    now,
    {},
    12,
    (s) => s.id.startsWith('mu-')
  ).map((s) => s.id);
  check(
    'with the source down, series nothing can answer for are left out before the slots are shared',
    whileDown.length === 5 && whileDown.every((id) => id.startsWith('mu-')),
    whileDown.join(', ')
  );
}

/* ------------------------------------------------------------------ */
console.log('\ntags\n');

{
  // As sources really write them: Colorist's own list had "Manwha" in it.
  const tags = normaliseTags(['Manwha', 'action', 'Action', ' Drama ', 'sci fi', 'SLICE OF LIFE', 42, '', 'Martial Art']);
  check('one spelling per tag, whatever case it came in', tags.filter((t) => t === 'Action').length === 1, tags.join(', '));
  check('the spellings sources get wrong are put right', tags.includes('Manhwa') && tags.includes('Sci-Fi') && tags.includes('Martial Arts'));
  check('shouting and whispering are capitalised', tags.includes('Slice of Life') && tags.includes('Drama'));
  const defaults = [...DEFAULT_HIDDEN_TAGS];
  check('Ecchi, Mature and Adult come first, in that order', defaults.join(',') === 'Ecchi,Mature,Adult');
  check(
    'adult genres are caught however a source writes them',
    ['Ecchi', 'Adult (18+)', 'Smut', 'Mature', 'R-18', 'hentai'].every((g) => hiddenBy([g], defaults) !== null)
  );
  check('and ordinary ones are not', hiddenBy(['Action', 'Drama', 'Romance', 'Martial Arts', 'Adventure', 'Manhwa'], defaults) === null);
  // MangaFire tags Jujutsu Kaisen "Mature" for its violence.
  check('Mature off keeps what is only tagged Mature', hiddenBy(['Action', 'Mature'], ['Ecchi', 'Adult']) === null);
  check('and each is its own switch', hiddenBy(['Ecchi'], ['Adult']) === null && hiddenBy(['Smut'], ['Adult']) === 'Adult');
  check('BL covers its other names', ["Boys' Love", 'Yaoi', 'Shounen Ai', 'BL'].every((g) => hasTag([g], 'BL')));
  check('GL covers its other names', ["Girls' Love", 'Yuri', 'Shoujo Ai'].every((g) => hasTag([g], 'gl')));
  check('BL does not catch a word with those letters in it', !hasTag(['Bloody', 'Public Life'], 'BL'));
  check('any other tag matches as written, ignoring case and hyphens', hasTag(['Slice-of-Life'], 'slice of life') && hasTag(['romance'], 'Romance'));
  check('and only that tag', !hasTag(['Romantic Comedy'], 'Romance'));
  check('a hidden title says which tag hid it', hiddenBy(['Action', 'Romance'], ['Ecchi', 'Romance']) === 'Romance');
  check('an older screen still gets the three it meant', tagsForLevel('mature').length === 3 && tagsForLevel('adult').join() === 'Ecchi,Adult');
  check('and anything that is not a tag is dropped', tags.every((t) => typeof t === 'string' && t.length > 0), String(tags.length));
}

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
/* ------------------------------------------------------------------ */
console.log('\nreading ahead\n');

check('one chapter by default', clampReadAhead(undefined) === 1);
check('zero is kept, not read as missing', clampReadAhead(0) === 0, 'off has to mean off');
check('three is allowed', clampReadAhead(3) === 3);
// A hand-edited manga.json is why this is clamped rather than trusted: a 50
// here would be fifty chapters of somebody else's bandwidth from one tap.
check('above the cap is brought down', clampReadAhead(50) === MAX_READ_AHEAD);
check('below zero is brought up', clampReadAhead(-4) === 0);
check('a fraction is rounded', clampReadAhead(2.4) === 2);
check('a string is not a number', clampReadAhead('3') === 1);
check('NaN is not a number either', clampReadAhead(Number.NaN) === 1);

/*
 * The ordering rule, which is the part of this that is easy to get wrong and
 * silently costly: a chapter fetched *ahead* of you was never opened, so if it
 * sorted as "now" it would push the chapter in your hands down the list — and
 * at three ahead, the one you are reading would be evicted before three you
 * have not looked at.
 */
{
  /*
   * Opened at `openedAt`; the prefetch runs twenty seconds later, because the
   * current chapter had to finish downloading first. That gap is the whole
   * bug: the first version computed these offsets from `Date.now()` at
   * prefetch time, so they landed *in front of* the chapter being read and the
   * cache ordered itself backwards — no.4, no.3, then what you were reading.
   *
   * The first version of this very check asserted the intended numbers rather
   * than how they are derived, so it passed against the broken code. It calls
   * `readAheadAt` now, which is the thing that was wrong.
   */
  const openedAt = Date.now();
  const whenThePrefetchRan = openedAt + 20_000;
  void whenThePrefetchRan;

  const order = [
    { id: 'reading', at: openedAt },
    { id: 'ahead-1', at: readAheadAt(openedAt, 0) },
    { id: 'ahead-2', at: readAheadAt(openedAt, 1) },
    { id: 'older', at: openedAt - 60_000 },
  ].sort((a, b) => b.at - a.at);

  check(
    'what you are reading stays in front of what was fetched ahead',
    order[0].id === 'reading' && order[1].id === 'ahead-1' && order[2].id === 'ahead-2',
    order.map((e) => e.id).join(' > ')
  );
  check('and older history is still behind both', order[3].id === 'older');
  check(
    'the offset is measured from the open, not from when the prefetch ran',
    readAheadAt(openedAt, 0) < openedAt && readAheadAt(openedAt, 0) < whenThePrefetchRan,
    'twenty seconds of downloading must not promote a guess'
  );
}

check(
  'three ahead still leaves most of the cache to real history',
  KEEP_CHAPTERS - MAX_READ_AHEAD === 7,
  String(KEEP_CHAPTERS - MAX_READ_AHEAD) + ' of ' + String(KEEP_CHAPTERS) + ' chapters you actually opened'
);

/* ------------------------------------------------------------------ */
console.log('\nthe second way to go next\n');

/*
 * The case this exists for: chapter 2, then point chapters, then 3. Nothing
 * can know whether 2 was a compilation already containing 2.1 and 2.2 or
 * whether those genuinely come next — the numbering carries no signal — so the
 * arrow keeps going to 2.1 and this is the second destination offered beside
 * it.
 */
const withPoints = [{ number: 1 }, { number: 2 }, { number: 2.1 }, { number: 2.2 }, { number: 3 }, { number: 4 }];

check('the arrow still goes to the point chapter', beside(withPoints, 2, 1)?.number === 2.1);
check('and the skip goes past them to 3', skipTarget(withPoints, 2)?.number === 3);
check('from a point chapter it also reaches 3', skipTarget(withPoints, 2.1)?.number === 3);
check('what it passes over is named', JSON.stringify(skippedBetween(withPoints, 2, 3)) === '[2.1,2.2]');

/*
 * Offered only when it does something different. A control on every chapter
 * that did the same as the arrow beside it is one nobody could learn.
 */
const plain = [{ number: 1 }, { number: 2 }, { number: 3 }];
check('nothing is offered when the next chapter is already whole', skipTarget(plain, 2) === undefined);
check('nor on the last chapter', skipTarget(withPoints, 4) === undefined);

const trailing = [{ number: 2 }, { number: 2.1 }, { number: 2.2 }];
check('nor when there is no whole chapter left to reach', skipTarget(trailing, 2) === undefined);
{
  // A hole after the point chapters: 2.1, then 8. Skipping is to the next whole chapter only.
  const holed = [2, 2.1, 8, 9].map((number) => ({ number }));
  check('no skip from 2.1 to 8', skipTarget(holed, 2.1) === undefined);
  check('nor from 2 to 8', skipTarget(holed, 2) === undefined);
}

/*
 * Sources list the same chapter twice — MangaFire carries two editions of most
 * of them — and the duplicates must cost nothing in either direction.
 */
const doubled = [{ number: 2 }, { number: 2 }, { number: 2.1 }, { number: 2.1 }, { number: 3 }, { number: 3 }];
check('a duplicate edition does not stop the arrow', beside(doubled, 2, 1)?.number === 2.1);
check('nor the skip', skipTarget(doubled, 2)?.number === 3);
check(
  'and a doubled point chapter is marked read once, not twice',
  JSON.stringify(skippedBetween(doubled, 2, 3)) === '[2.1]'
);

check('backwards still works', beside(withPoints, 2.1, -1)?.number === 2);

/* ------------------------------------------------------------------ */
console.log('\na check that failed is asked again sooner\n');

{
  const now = Date.now();
  const DAY = 24 * 60 * 60_000;
  const HOUR = 60 * 60_000;
  const ago = (days: number) => now - days * DAY;

  /*
   * A timeout is usually nothing — Suwayomi busy, a site slow — but the row
   * says "source not answering" until something asks again and succeeds, and
   * for a series you have not opened in a year that is its daily slot behind a
   * queue of hundreds. Measured on a real library: five of eight broken rows
   * were timeouts, the oldest two days old, with nothing wrong by then.
   */
  check('untouched for a year, last check fine: once a day', checkEvery(ago(400), now, false) === DAY);
  check('the same one after a failure: within the hour', checkEvery(ago(400), now, true) === HOUR);
  check('read this year, fine: every six hours', checkEvery(ago(100), now, false) === 6 * HOUR);
  check('read this year, failed: within the hour', checkEvery(ago(100), now, true) === HOUR);

  /*
   * Never *less* often because it failed. A series read this month is already
   * asked every sweep, and an hour would be a step backwards — which is what
   * taking the retry interval rather than the smaller of the two would do.
   */
  check('read this month: every sweep, failed or not', checkEvery(ago(5), now, true) === 0);

  /*
   * Eligibility was not enough. On a real library the timed-out rows had 216 to
   * 451 series queued ahead of them, all equally due, and the back half of
   * twelve slots clears about eight an hour — so a row 451 deep waited more
   * than two days, which is how long "source not answering" sat on a series
   * with nothing wrong with it.
   */
  const old = (n: number, error: string | null) =>
    row({
      id: `stale-${n}-${error ?? 'ok'}`,
      addedAt: ago(400),
      checkedAt: ago(2),
      error,
      source: { adapter: 'suwayomi', mangaId: String(n), title: 't', sourceName: 'S' },
      muId: 1,
    });

  const haystack = {
    ...store,
    series: [...Array.from({ length: 40 }, (_, i) => old(i, null)), old(900, 'Suwayomi did not answer in time')],
  };
  const picked = dueForCheck(haystack, now, {});
  check(
    'a failed row is picked despite forty queued ahead of it',
    picked.some((p) => p.error !== null),
    `${picked.length} picked`
  );
  check('and it is near the front, not the back', picked.findIndex((p) => p.error !== null) < RETRY_SLOTS);

  // Bounded: a library where everything is broken must not spend the whole
  // sweep on it, or nothing you are reading is ever asked about again.
  const allBroken = {
    ...store,
    series: Array.from({ length: 40 }, (_, i) => old(i, 'Suwayomi did not answer in time')),
  };
  check(
    'but never more than its share of the batch',
    dueForCheck(allBroken, now, {}).length <= BATCH,
    `${dueForCheck(allBroken, now, {}).length} of ${BATCH}`
  );
}

/* ---- reads that arrive twice, late, or out of order ---- */
{
  console.log('\nreading marks');
  const fresh = (): Readable => ({ readChapters: [], readLog: [], source: null });

  // Moving on from a place at the end of a chapter counts it read.
  check('the last page is the end', placeIsAtEnd({ page: 39, pages: 40 }));
  check('so is the page before it (a short last page)', placeIsAtEnd({ page: 38, pages: 40 }));
  check('two pages short is not', !placeIsAtEnd({ page: 37, pages: 40 }));
  check('a two-page chapter needs its last page', !placeIsAtEnd({ page: 0, pages: 2 }) && placeIsAtEnd({ page: 1, pages: 2 }));
  check('a one-page chapter at its only page is the end', placeIsAtEnd({ page: 0, pages: 1 }));

  const a = fresh();
  check('a read is recorded', applyReadMark(a, 5, true, 100) && a.readChapters.includes(5));
  check('the same read again changes nothing', applyReadMark(a, 5, true, 100) === false);
  check('an older re-send changes nothing either', applyReadMark(a, 5, true, 50) === false && a.readLog[0]!.at === 100);
  check('a later read moves the record forward', applyReadMark(a, 5, true, 200) && a.readLog[0]!.at === 200);

  const b = fresh();
  applyReadMark(b, 7, true, 100);
  applyReadMark(b, 7, false, 200);
  check('taking it back removes it', !b.readChapters.includes(7) && b.unreadAt?.['7'] === 200);
  check(
    'and the phone re-sending its older read cannot undo that',
    applyReadMark(b, 7, true, 100) === false && !b.readChapters.includes(7)
  );
  check('but reading it again afterwards does count', applyReadMark(b, 7, true, 300) && b.readChapters.includes(7));
  check('and clears the tombstone', b.unreadAt === undefined);
  check(
    'an unread from before that read is too late to undo it',
    applyReadMark(b, 7, false, 250) === false && b.readChapters.includes(7)
  );

  // The real case: a read lost on the server, put back by the device's log.
  const c = fresh();
  for (const n of [1, 3, 4]) applyReadMark(c, n, true, n * 10);
  for (const n of [1, 2, 3, 4, 5]) applyReadMark(c, n, true, n * 10);
  check('a re-sent log fills the gaps and nothing else', JSON.stringify(c.readChapters) === '[1,2,3,4,5]', JSON.stringify(c.readChapters));
}

/* ---- when Next finishes a chapter ---- */
{
  console.log('\nreaching the end');
  const phone = 800;
  // Thirty 1000px pages; the strip starts at the top of the document.
  const at = (scrollY: number, allLoaded = true) =>
    reachedTheEnd({ viewportHeight: phone, stripTop: -scrollY, stripHeight: 30_000, lastPageTop: 29_000 - scrollY, allLoaded });
  // The case that lost chapters: last page in full view, the one above still
  // at the top of the screen — the counter said 29 of 30.
  check('the last page on screen, the one above still showing: finished', at(28_700));
  check('the opening pages: not finished', !at(0));
  check('halfway: not finished', !at(15_000));
  check('two pages of credits still to come: finished', at(27_200));
  check('three pages still to come: not', !at(26_000));
  // 127 short strips, the shape that caught the first version out: a tenth of
  // this is eleven screens, and finishing there is finishing early.
  const strips = (scrollY: number) =>
    reachedTheEnd({ viewportHeight: phone, stripTop: -scrollY, stripHeight: 94_000, lastPageTop: 93_260 - scrollY, allLoaded: true });
  check('a sliced chapter eleven screens from the end: not finished', !strips(84_400));
  check('two screens from the end: finished', strips(91_400));
  check('pages still loading: never, however it measures', !at(28_700, false));
  // A strip of placeholders is short and entirely on screen at once.
  check(
    'a strip of placeholders does not count as read',
    !reachedTheEnd({ viewportHeight: phone, stripTop: 0, stripHeight: 600, lastPageTop: 580, allLoaded: false })
  );
}

/* ---- the device's reading log, as CSV ---- */
{
  console.log('\nreading log');
  const row = { at: Date.parse('2026-10-03T21:07:33.000Z'), seriesId: 'ed99-x', chapter: 9.2, read: true, sent: false, title: 'Buy 2, get 1 "free" (Official)' };
  const back = fromLine(toLine(row));
  check('a title with a comma and quotes survives', JSON.stringify(back) === JSON.stringify(row), toLine(row));
  check('an unread survives', fromLine(toLine({ ...row, read: false, sent: true }))?.read === false);
  check('a line that is not a row is ignored', fromLine('nonsense') === null && fromLine('') === null);
  check('a title on two lines stays on one', !toLine({ ...row, title: 'a\nb' }).includes('\n'));
}

/* ---- a saved page is a whole picture, or it is fetched again ---- */
{
  console.log(String.fromCharCode(10) + 'damaged pages');
  const bytes = (...parts: (number[] | string)[]) =>
    Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));
  const pad = (n: number) => new Array<number>(n).fill(0);
  const whole = (b: Uint8Array) => isWholeImage(b.subarray(0, 32), b.subarray(Math.max(0, b.length - 1024)), b.length);

  const jpeg = bytes([0xff, 0xd8, 0xff, 0xe0], pad(200), [0xff, 0xd9]);
  check('a JPEG that ends on its marker is whole', whole(jpeg));
  check('the same JPEG cut off is not', !whole(jpeg.subarray(0, 150)));
  check('a JPEG with padding after the marker is still whole', whole(bytes([0xff, 0xd8, 0xff, 0xe0], pad(200), [0xff, 0xd9], pad(40))));
  const png = bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a], pad(100), 'IEND', [0xae, 0x42, 0x60, 0x82]);
  check('a PNG with its IEND is whole', whole(png));
  check('a PNG without it is not', !whole(png.subarray(0, 90)));
  const webp = (declared: number, length: number) =>
    bytes('RIFF', [declared & 255, (declared >> 8) & 255, 0, 0], 'WEBP', pad(length - 12));
  check('a WebP as long as it says is whole', whole(webp(292, 300)));
  check('a WebP shorter than it says is not', !whole(webp(5000, 300)));
  check('an error page is not a picture', !whole(bytes('<!DOCTYPE html><html><body>502 Bad Gateway</body></html>', pad(20))));
  check('a JSON message is not a picture', !whole(bytes('{"error":"could not fetch the page"}', pad(20))));
  check('nothing at all is not a picture', !whole(new Uint8Array(0)));
}

console.log("\na series takes its source's name, when it is a rename");
{
  // The two real renames in the library this was written against.
  check('a romanised title gives way to an English one',
    betterTitle('Dungeon-eul Geurineun Hwaga', 'The Dungeon Painter') === 'The Dungeon Painter');
  check('an English rename is taken',
    betterTitle('Illusion Hunter from Another World', 'The Delusional Hunter in Another World') ===
      'The Delusional Hunter in Another World');
  // And the 53 that were respellings, by kind.
  check('an apostrophe is not a rename', betterTitle("The Archmage's Restaurant", 'The Archmage’s Restaurant') === null);
  check('a source taking a series down is not a rename', betterTitle('Just Leave Me Be', 'Just Leave Me Be [delete]') === null);
  check('nor is a promo upload', betterTitle('Black Killer Whale Baby', 'Black Killer Whale Baby (Promo)') === null);
  check('nor an author in brackets', betterTitle('All Rounder', 'All Rounder (Kim Dae-hoon)') === null);
  check('nor a year', betterTitle('Black Haze (2025)', 'Black Haze') === null);
  check('nor 「」 for quotation marks',
    betterTitle('The Reincarnated 「Sword Saint」 Wants to Take it Easy', 'The Reincarnated "Sword Saint" Wants to Take It Easy') === null);
  check("nor a source's capitalisation", betterTitle('The Hierarch Can’t Resist His Mistresses', "The Hierarch Can'T Resist His Mistresses") === null);
  // Never towards something harder to read.
  check('never towards the romanisation', betterTitle('The Dungeon Painter', 'Dungeon-eul Geurineun Hwaga') === null);
  check('never towards another script', betterTitle('Solo Leveling', '나 혼자만 레벨업') === null);
  check('but away from one', betterTitle('나 혼자만 레벨업', 'Solo Leveling') === 'Solo Leveling');
  check('a housekeeping tag is not carried into the new name',
    betterTitle('Dungeon-eul Geurineun Hwaga', 'The Dungeon Painter [delete]') === 'The Dungeon Painter');

  const series = { title: 'Dungeon-eul Geurineun Hwaga', source: { title: 'The Dungeon Painter' } } as {
    title: string; altTitles?: string[]; source: { title: string } | null;
  };
  check('renaming says so', retitleFromSource(series));
  check('  ...and keeps the old name to search by', series.title === 'The Dungeon Painter' && series.altTitles?.[0] === 'Dungeon-eul Geurineun Hwaga');
  check('  ...and does nothing the second time', !retitleFromSource(series) && series.altTitles?.length === 1);
}

console.log('\nfavourites and new chapters on top, in four groups');
{
  // Titles sort A–Z within each group, so the groups are what is being tested.
  type Row = Parameters<typeof sorted>[0][number];
  const row = (title: string, favourite: boolean, fresh: boolean) =>
    ({ title, favourite, latestNumber: fresh ? 10 : 5, readUpTo: 5, position: null }) as unknown as Row;
  const list = [
    row('a plain', false, false),
    row('b fav', true, false),
    row('c new', false, true),
    row('d fav new', true, true),
    row('e plain', false, false),
    row('f fav new', true, true),
  ];
  const order = (newFirst: boolean, favFirst: boolean) =>
    sorted(list, 'title', newFirst, favFirst)
      .map((s) => s.title)
      .join(', ');
  check('both: starred and new, new, starred, the rest', order(true, true) === 'd fav new, f fav new, c new, b fav, a plain, e plain', order(true, true));
  check('new only: the star moves nothing', order(true, false) === 'c new, d fav new, f fav new, a plain, b fav, e plain', order(true, false));
  check('favourites only: new moves nothing', order(false, true) === 'b fav, d fav new, f fav new, a plain, c new, e plain', order(false, true));
  check('neither: the order alone', order(false, false) === 'a plain, b fav, c new, d fav new, e plain, f fav new', order(false, false));
}

console.log('\na mouse drag slides on after letting go');
{
  // Pulling up 200px over 100ms, sampled every 10ms: scrolling down at 2px/ms.
  const pull = Array.from({ length: 11 }, (_, i) => ({ t: 1000 + i * 10, y: 500 - i * 20 }));
  const v = releaseVelocity(pull, 1105);
  check('a drag up throws the page down, at the speed of its last stretch', Math.abs(v - 2) < 0.01, `${v.toFixed(3)}px/ms`);
  check('a drag down throws it up', releaseVelocity(pull.map((s) => ({ ...s, y: 1000 - s.y })), 1105) < 0);
  check('held still before letting go, it stays put', releaseVelocity(pull, 1100 + 61) === 0);
  // Fast, then slowing to a crawl before release: it is the crawl that counts.
  const slowing = [...pull, ...Array.from({ length: 10 }, (_, i) => ({ t: 1110 + i * 10, y: 300 - i }))];
  check('only the end of the drag decides the speed', Math.abs(releaseVelocity(slowing, 1200)) < 0.2, releaseVelocity(slowing, 1200).toFixed(3));
  check('a wild flick is capped', releaseVelocity([{ t: 0, y: 1000 }, { t: 10, y: 0 }], 10) === MAX_SPEED);
  check('a single sample is not a speed', releaseVelocity([{ t: 0, y: 5 }], 0) === 0);

  check('a 2px/ms flick carries about a thousand pixels', Math.abs(glideDistance(2) - 1000) < 5, `${glideDistance(2).toFixed(0)}px`);
  // The same slide in 60 frames a second and in 20 must end in the same place.
  const run = (dt: number) => {
    let velocity = 2;
    let travelled = 0;
    for (let t = 0; t < 3000; t += dt) {
      const step = glideStep(velocity, dt);
      travelled += step.distance;
      velocity = step.velocity;
    }
    return travelled;
  };
  check('it slides as far at 20 frames a second as at 60', Math.abs(run(1000 / 60) - run(50)) < 1, `${run(1000 / 60).toFixed(1)} vs ${run(50).toFixed(1)}`);
  check('and slows rather than stopping dead', glideStep(2, 16).velocity > 1.9 && glideStep(2, 16).velocity < 2);

  /*
   * A slow slide on a screen that keeps scroll in whole pixels. Reading the
   * position back each frame rounds the fraction away — the hitch at low speeds:
   * steps of 1 and 2 by turns, then stuck. Keeping it exactly and handing over
   * only the result moves the page as far as the slide says.
   */
  const slow = (readBack: boolean, snap: (n: number) => number = Math.round) => {
    let velocity = 0.15;
    let exact = 0;
    let shown = 0;
    let stuck = 0;
    while (Math.abs(velocity) >= STOP_SPEED) {
      const step = glideStep(velocity, 1000 / 60);
      velocity = step.velocity;
      exact = (readBack ? shown : exact) + step.distance;
      const next = snap(exact);
      if (next === shown) stuck += 1;
      shown = next;
    }
    return { shown, stuck };
  };
  const kept = slow(false);
  const lost = slow(true);
  // A browser that truncates rather than rounds: the old way moved 1px a frame
  // where it should have moved 1.6, and fell far short.
  const truncated = slow(true, Math.floor);
  const truncatedKept = slow(false, Math.floor);
  check('a slow slide goes as far as it should, kept to the fraction', Math.abs(kept.shown - (glideDistance(0.15) - glideDistance(STOP_SPEED))) <= 1, `${kept.shown}px`);
  check('  ...and never sits still mid-slide', kept.stuck === 0, `${kept.stuck} frames`);
  check('  ...where reading the position back fell short', lost.shown < kept.shown, `${lost.shown}px`);
  check('  ...and far short where the browser truncates', truncated.shown < truncatedKept.shown * 0.8, `${truncated.shown}px against ${truncatedKept.shown}px`);
}

console.log('\na page that times out is given up on sooner');
{
  // A fake clock and a fake fetch: each attempt "takes" the time given, and fails.
  const run = async (takes: number, status = 500) => {
    let clock = 0;
    let calls = 0;
    const get = (async () => {
      calls += 1;
      clock += takes;
      return new Response('timeout', { status });
    }) as unknown as typeof fetch;
    try {
      await fetchPage('http://test/page', { now: () => clock, get });
      return { calls, status: 200 };
    } catch (error) {
      return { calls, status: error instanceof PageFetchError ? error.status : null };
    }
  };
  const slowRun = await run(SLOW_FAILURE_MS + 10_000);
  check('two slow failures end it, not three', slowRun.calls === 2, `${slowRun.calls} tries`);
  check('and it says it timed out (504)', slowRun.status === 504, String(slowRun.status));
  const quick = await run(200);
  check('a quick refusal still gets all three tries', quick.calls === 3, `${quick.calls} tries`);
  check('and is not called a timeout', quick.status === 500, String(quick.status));
  const missing = await run(200, 404);
  check('a 404 is not retried at all', missing.calls === 1, `${missing.calls} tries`);
}

console.log('\na page already being fetched is shared');
{
  // A whole JPEG, held back until let go, counting how often it is asked for.
  const page = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array<number>(200).fill(0), 0xff, 0xd9]);
  let asked = 0;
  let letGo: () => void = () => {};
  const held = new Promise<void>((resolve) => (letGo = resolve));
  const get = (async () => {
    asked += 1;
    await held;
    return new Response(page, { headers: { 'content-type': 'image/jpeg' } });
  }) as unknown as typeof fetch;
  const url = 'http://test/api/v1/manga/1/chapter/2/page/0';
  const three = [sharedPage(url, { get }), sharedPage(url, { get }), sharedPage(url, { get })];
  check('three readers asking at once cause one fetch', asked === 1, `${asked} fetches`);
  const tryAgain = sharedPage(url, { get, share: false });
  check('  ...but "try again" asks again beside it', asked === 2, `${asked} fetches`);
  letGo();
  const got = await Promise.all([...three, tryAgain]);
  check('  ...and all of them get the page', got.every((g) => g.body.length === page.length), got.map((g) => g.body.length).join());
  check('  ...and nothing is held once it has come', pagesInFlight() === 0, `${pagesInFlight()} still in flight`);
  await sharedPage(url, { get });
  check('a later ask fetches again: it shares, it does not cache', asked === 3, `${asked} fetches`);
}

console.log('\nkeeping a series keeps one edition of each chapter');
{
  check('2.1 is "Chapter 0002.1", not a float remainder', chapterFolder(2.1) === 'Chapter 0002.1', chapterFolder(2.1));
  check('a whole number has no point', chapterFolder(12) === 'Chapter 0012', chapterFolder(12));

  const pick = pickEdition([
    { id: 'a', number: 1, name: 'Ch. 1', uploadedAt: 100 },
    { id: 'b', number: 1, name: 'Chapter 1', uploadedAt: 200 },
  ]);
  check('the newer upload is kept', pick.id === 'b', pick.id);
  check('with no dates, the first listed', pickEdition([{ id: 'x', number: 1, name: '' }, { id: 'y', number: 1, name: '' }]).id === 'x');

  // Two editions wrote one folder: b second, over a's 001 and 002.
  const dir = mkdtempSync(joinTmp(tmpdir(), 'manga-editions-'));
  try {
    const folder = 'Chapter 0001';
    mkdirTmp(joinTmp(dir, folder));
    const bytes = (n: number) => Buffer.alloc(n, 1);
    writeTmp(joinTmp(dir, folder, '001.jpg'), bytes(30)); // b's
    writeTmp(joinTmp(dir, folder, '002.jpg'), bytes(31)); // b's
    writeTmp(joinTmp(dir, folder, '003.jpg'), bytes(12)); // a's, never overwritten
    const page = (file: string, n: number, chapter: number) => ({ path: `/api/v1/manga/9/chapter/${chapter}/page/${file}`, file, type: 'image/jpeg', bytes: n });
    const manifest: ArchiveManifest = {
      seriesId: 's',
      title: 'T',
      source: null,
      startedAt: 0,
      updatedAt: 0,
      chapters: [
        { number: 1, name: 'Ch. 1', chapterId: 'a', folder, pages: [page('001.jpg', 10, 1), page('002.jpg', 11, 1), page('003.jpg', 12, 1)], expected: 3, done: true, error: null, at: 1 },
        { number: 1, name: 'Chapter 1', chapterId: 'b', folder, pages: [page('001.jpg', 30, 2), page('002.jpg', 31, 2)], expected: 2, done: true, error: null, at: 2 },
        { number: 2, name: 'Ch. 2', chapterId: 'c', folder: 'Chapter 0002', pages: [], expected: null, done: false, error: null, at: 0 },
      ],
    };
    const result = mendManifest(dir, manifest);
    const one = manifest.chapters.find((c) => c.number === 1)!;
    check('the whole edition is kept', one.chapterId === 'b' && one.done, one.chapterId);
    check('the other is remembered as the same chapter', one.sameAs?.join() === 'a', String(one.sameAs));
    check('one entry per number', manifest.chapters.length === 2, String(manifest.chapters.length));
    check('only the dropped edition\'s own leftover is deleted', listTmp(joinTmp(dir, folder)).sort().join() === '001.jpg,002.jpg', listTmp(joinTmp(dir, folder)).join());
    check('and nothing whole is fetched again', result.refetch.length === 0 && result.freed === 12, JSON.stringify(result));
    check('a mended manifest is left alone the next time', mendManifest(dir, manifest).dropped.length === 0);
  } finally {
    rmTmp(dir, { recursive: true, force: true });
  }

  const item = (seriesId: string, chapterId: string): QueueItem => ({ seriesId, chapterId, number: 1, name: '', tries: 0, error: null });
  const queue = [item('old', '1'), item('old', '2'), item('new', '9')];
  check('a series never served goes first', nextInQueue(queue, new Map([['old', 5]]))?.chapterId === '9');
  check('then the one served longest ago', nextInQueue(queue, new Map([['old', 5], ['new', 9]]))?.chapterId === '1');
}

process.exit(failures === 0 ? 0 : 1);
