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
import { readableChapter, titleScore, rankMatches } from '../sources.js';
import { uploadedAtMs } from '../suwayomi.js';
import { portOf } from '../process.js';
import { pollable, seriesUrl } from '../releases.js';

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
