/**
 * Proves linked servers (`peers.ts`, and the manga package's `routes/peers.ts`)
 * with two real servers on this PC, each with its own throwaway database and
 * data folder, deleted afterwards.
 *
 *   npm run peer-check -w @everything/server
 *
 * Two server processes, because which server this is is settled once, when
 * `config.ts` is first imported. With no Tailscale between them they are
 * `http://127.0.0.1:<port>`, which only `PEERS_ALLOW_LOOPBACK` (set here and
 * nowhere else) lets a link use. Everything this process asks of them as their
 * owner is trusted as local, as the PC's own browser is; what one server asks
 * of the other carries the key it was given, and is held to `/api/peer/`.
 *
 * Server A is seeded with one kept series of two small pictures, so B can read
 * and copy it. Nothing starts Suwayomi or touches your data.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const serverRoot = resolve(dirname(here), '../..');
const work = resolve(serverRoot, 'data', 'peer-check');
const role = process.argv[2];

/* ---- a server, run by the check ---- */

if (role === 'serve') {
  const name = process.argv[3]!;
  const port = Number(process.argv[4]);
  process.env.DATABASE_URL = `file:${resolve(work, `${name}.db`)}`;
  process.env.DATA_DIR = resolve(work, `${name}-data`);
  process.env.PORT = String(port);
  process.env.PEERS_ALLOW_LOOPBACK = 'true';
  process.env.EVERYTHING_INSTANCE = '';
  process.env.LOG_LEVEL = 'error';
  const { runMigrations } = await import('../db/migrate.js');
  const { buildApp } = await import('../app.js');
  await runMigrations();
  const app = await buildApp();
  await app.listen({ host: '127.0.0.1', port });
  console.log('ready');
  process.stdin.resume();
  process.stdin.on('end', () => void app.close().then(() => process.exit(0)));
} else {
  await run();
}

async function run(): Promise<void> {
  const A = 18931;
  const B = 18932;
  const a = `http://127.0.0.1:${A}`;
  const b = `http://127.0.0.1:${B}`;
  let failures = 0;
  const check = (label: string, ok: boolean, detail = '') => {
    if (!ok) failures += 1;
    console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  };

  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  seedArchive(resolve(work, 'a-data', 'manga-archive'));
  // Each has a name, so each side's screen can say who the other is.
  for (const [who, name] of [['a', 'Ann'], ['b', 'Ben']] as const) {
    mkdirSync(resolve(work, `${who}-data`), { recursive: true });
    writeFileSync(resolve(work, `${who}-data`, 'profile.json'), JSON.stringify({ name }));
  }

  const children: ChildProcess[] = [];
  const start = (name: string, port: number) =>
    new Promise<void>((ready, fail) => {
      const child = spawn(process.execPath, ['--import', 'tsx', here, 'serve', name, String(port)], { cwd: serverRoot, stdio: ['pipe', 'pipe', 'inherit'] });
      children.push(child);
      child.stdout!.on('data', (d: Buffer) => d.toString().includes('ready') && ready());
      child.on('exit', (code) => fail(new Error(`server ${name} exited ${code}`)));
    });

  try {
    await Promise.all([start('a', A), start('b', B)]);

    type Json = Record<string, unknown> & { error?: string };
    const ask = async (base: string, path: string, init: { method?: string; body?: unknown; token?: string } = {}) => {
      const response = await fetch(`${base}${path}`, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers: {
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      const type = response.headers.get('content-type') ?? '';
      const body = type.includes('json') ? ((await response.json()) as Json) : ({ bytes: (await response.arrayBuffer()).byteLength } as Json);
      return { status: response.status, body, type };
    };

    console.log('\nlinking');
    const code = await ask(a, '/api/peers/code', { body: {} });
    check('A makes a link code', code.status === 200 && typeof code.body.link === 'string', JSON.stringify(code.body).slice(0, 120));
    const link = String(code.body.link);
    check('the code is A’s address and a secret', link.startsWith(`${a}/#link=`));

    const bad = await ask(b, '/api/peers', { body: { link: `${a}/#link=${'x'.repeat(32)}` } });
    check('a made-up code is refused, and nothing is linked', bad.status === 502 && ((await ask(b, '/api/peers')).body.links as unknown[]).length === 0, `${bad.status}`);

    const linked = await ask(b, '/api/peers', { body: { link } });
    check('B links with A’s code', linked.status === 200 && linked.body.name === 'Ann', JSON.stringify(linked.body).slice(0, 160));
    const again = await ask(a, '/api/peer/link', { body: { code: link.slice(link.indexOf('#link=') + 6), url: 'http://127.0.0.1:18999', key: 'k'.repeat(40) } });
    check('the code works once', again.status === 410, `${again.status}`);

    const onA = await ask(a, '/api/peers');
    const aLinks = onA.body.links as Array<{ id: string; name: string; share: Record<string, boolean>; theirs: { share: Record<string, boolean> } | null }>;
    check('A has the link too, named Ben', aLinks.length === 1 && aLinks[0]!.name === 'Ben');
    const onB = await ask(b, '/api/peers');
    const bLinks = onB.body.links as Array<{ id: string; theirs: { share: Record<string, boolean> } | null }>;
    check('B knows what A shares: collection, copying, catalogue; not ratings', bLinks[0]?.theirs?.share.collection === true && bLinks[0]?.theirs?.share.ratings === false);
    check('A was given no key in what the screen shows', !JSON.stringify(onA.body).includes('"key"'));

    console.log('\nwhat a linked server’s key reaches');
    // The key A holds for B is in A's data; read it the way A's server does.
    const keyForB = readKeyOf(work, 'a');
    for (const path of ['/api/tasks', '/api/settings', '/api/peers', '/api/manga', '/api/manga/peers', '/%61pi/tasks', '/api/peer/../tasks']) {
      const r = await ask(b, path, { token: keyForB });
      check(`refused: ${path}`, r.status === 403 || r.status === 404 || r.status === 401, `${r.status}`);
    }
    const hello = await ask(b, '/api/peer/hello', { token: keyForB });
    check('it reaches /api/peer/hello', hello.status === 200 && hello.body.name === 'Ben', `${hello.status}`);
    const noKey = await ask(b, '/api/peer/hello');
    check('without a linked server’s key it answers nothing, even to this PC', noKey.status === 403, `${noKey.status}`);
    const wrongLink = await ask(a, '/api/peer/link', { body: { code: 'y'.repeat(30), url: b, key: 'k'.repeat(40) } });
    check('a guessed code at the link route is refused', wrongLink.status === 410, `${wrongLink.status}`);
    const httpsOnly = await ask(a, '/api/peer/link', { body: { code: 'y'.repeat(30), url: 'https://evil.example', key: 'k'.repeat(40) } });
    check('a non-Tailscale address is refused', httpsOnly.status === 400, `${httpsOnly.status}`);

    console.log('\nreading A’s collection from B');
    const bId = bLinks[0]!.id;
    const peers = await ask(b, '/api/manga/peers');
    check('B lists A as sharing its collection', (peers.body.peers as Array<{ collection: boolean }>)[0]?.collection === true, JSON.stringify(peers.body).slice(0, 160));
    const coll = await ask(b, `/api/manga/peers/${bId}/collection`);
    const series = (coll.body.series ?? []) as Array<{ mangaId: string; title: string; complete: number }>;
    check('A’s two kept series come through', series.length === 2 && series[0]!.title === 'Peer Check Series' && series[0]!.complete === 1, JSON.stringify(coll.body).slice(0, 200));
    check('who it was kept for stays on A', !JSON.stringify(coll.body).includes('keptFor'));
    const chapters = await ask(b, `/api/manga/peers/${bId}/series/990000777`);
    const ch = (chapters.body.chapters ?? []) as Array<{ id: string; number: number }>;
    check('its whole chapter is listed, the half-kept one is not', ch.length === 1 && ch[0]!.number === 1, JSON.stringify(chapters.body).slice(0, 200));
    const pages = await ask(b, `/api/manga/peers/${bId}/series/990000777/chapters/990000777001/pages`);
    const list = (pages.body.pages ?? []) as string[];
    check('two pages, as B’s own addresses', list.length === 2 && list.every((p) => p.startsWith(`/api/manga/peers/${bId}/page?`)), JSON.stringify(pages.body).slice(0, 200));
    const page = await ask(b, list[0] ?? '/');
    check('a page comes through as a picture', page.status === 200 && page.type.startsWith('image/png'), `${page.status} ${page.type}`);
    const broken = await ask(b, list[1] ?? '/');
    check('a cut-off page is refused, not passed on', broken.status === 502, `${broken.status}`);

    console.log('\nwhat A chooses');
    const aId = aLinks[0]!.id;
    await ask(a, `/api/peers/${aId}`, { method: 'PATCH', body: { share: { copy: false } } });
    // B is told to ask again; it does at its next look.
    await new Promise((done) => setTimeout(done, 300));
    const refused = await ask(b, `/api/manga/peers/${bId}/series/990000777/copy`, { body: {} });
    check('with copying off, B cannot copy', refused.status === 403, `${refused.status} ${refused.body.error ?? ''}`);
    const direct = await ask(a, '/api/peer/manga/collection/pages?manga=990000777&chapter=990000777001&purpose=copy', { token: readKeyOf(work, 'b') });
    check('and A refuses a copy asked of it directly', direct.status === 403, `${direct.status}`);
    const stillReads = await ask(b, list[0] ?? '/');
    check('reading still works', stillReads.status === 200);
    await ask(a, `/api/peers/${aId}`, { method: 'PATCH', body: { share: { copy: true, ratings: true } } });
    await new Promise((done) => setTimeout(done, 300));

    console.log('\ncopying');
    const copied = await ask(b, `/api/manga/peers/${bId}/series/990000777/copy`, { body: {} });
    check('B starts a copy of A’s series', copied.status === 200 && copied.body.queued === 1, JSON.stringify(copied.body));
    let copies: Array<{ seriesId: string; complete: number; chapters: number }> = [];
    for (let i = 0; i < 40; i++) {
      copies = ((await ask(b, '/api/manga/copies')).body.copies ?? []) as typeof copies;
      if (copies[0]?.complete === 1) break;
      await new Promise((done) => setTimeout(done, 250));
    }
    // The second page is cut off, so the chapter is never whole: the worker keeps the one page and says so.
    const copy = copies[0];
    check('the copy is listed under B’s Local collection', copy !== undefined && copy.seriesId.startsWith('peer-'), JSON.stringify(copies));
    const detail = copy ? await ask(b, `/api/manga/copies/${copy.seriesId}`) : null;
    check('a chapter with a page that would not come is not passed off as copied', copy?.complete === 0 && (detail?.body.waiting as number) >= 0, JSON.stringify(detail?.body ?? {}).slice(0, 200));
    const kept = await ask(b, '/api/manga/kept');
    check('and is not mistaken for one of B’s own kept series', ((kept.body.results ?? []) as unknown[]).length === 0, JSON.stringify(kept.body).slice(0, 120));

    const whole = await ask(b, `/api/manga/peers/${bId}/series/990000778/copy`, { body: {} });
    check('a series whose pages are whole is copied', whole.status === 200 && whole.body.queued === 1, JSON.stringify(whole.body));
    let done: { seriesId: string; complete: number } | undefined;
    for (let i = 0; i < 60; i++) {
      done = (((await ask(b, '/api/manga/copies')).body.copies ?? []) as Array<{ seriesId: string; complete: number }>).find((c) => c.seriesId.endsWith('990000778'));
      if (done?.complete === 1) break;
      await new Promise((ok) => setTimeout(ok, 250));
    }
    check('its chapter is all here', done?.complete === 1, JSON.stringify(done));
    const copyPages = await ask(b, `/api/manga/copies/${done?.seriesId}/chapters/990000778001/pages`);
    const copyList = (copyPages.body.pages ?? []) as string[];
    const fromDisk = await ask(b, copyList[1] ?? '/');
    check('and reads from B’s own disk', copyList.length === 2 && fromDisk.status === 200 && fromDisk.type.startsWith('image/png'), `${copyList.length} ${fromDisk.status}`);

    console.log('\nthe catalogue and ratings');
    const catalogue = await ask(a, '/api/peer/manga/catalogue', { token: readKeyOf(work, 'b') });
    const copiesOut = (catalogue.body.copies ?? []) as Array<{ s: string; t: string; p: { latest: number } }>;
    check('A shares its catalogue’s counts, by source id and name', catalogue.status === 200 && copiesOut.length === 1 && copiesOut[0]!.s === '123456' && copiesOut[0]!.t === 'Peer Check Series', JSON.stringify(catalogue.body).slice(0, 200));
    check('with no Suwayomi id in it', !JSON.stringify(catalogue.body).includes('555'));
    const ratings = await ask(a, '/api/peer/manga/ratings', { token: readKeyOf(work, 'b') });
    check('ratings, now shared, answer', ratings.status === 200 && Array.isArray(ratings.body.ratings), `${ratings.status}`);
    await ask(a, `/api/peers/${aId}`, { method: 'PATCH', body: { share: { catalogue: false, ratings: false } } });
    const offCat = await ask(a, '/api/peer/manga/catalogue', { token: readKeyOf(work, 'b') });
    const offRat = await ask(a, '/api/peer/manga/ratings', { token: readKeyOf(work, 'b') });
    check('switched off, neither answers', offCat.status === 403 && offRat.status === 403, `${offCat.status} ${offRat.status}`);

    console.log('\nunlinking');
    const gone = await ask(b, `/api/peers/${bId}`, { method: 'DELETE' });
    check('B unlinks, and A is told', gone.status === 200 && gone.body.told === true, JSON.stringify(gone.body));
    check('A no longer has the link', ((await ask(a, '/api/peers')).body.links as unknown[]).length === 0);
    const after = await ask(b, '/api/peer/hello', { token: keyForB });
    check('the key A held for B is refused now', after.status === 401, `${after.status}`);
  } catch (error) {
    failures += 1;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    for (const child of children) {
      child.removeAllListeners('exit');
      child.stdin?.end();
    }
    await Promise.all(children.map((c) => new Promise((done) => (c.exitCode !== null ? done(null) : c.on('exit', done)))));
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
  console.log(failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n` : '\n\x1b[32mAll checks passed.\x1b[0m\n');
  process.exit(failures ? 1 : 0);
}

/** The key one server holds for the other, as its own `peers.json` keeps it. */
function readKeyOf(dir: string, who: 'a' | 'b'): string {
  return (JSON.parse(readFileSync(resolve(dir, `${who}-data`, 'peers.json'), 'utf8')) as { links: Array<{ key: string }> }).links[0]!.key;
}

/**
 * One kept series on A: chapter 1 whole, of two pages (the second cut off, so
 * the reading side's check is seen to refuse it), and chapter 2 half kept.
 */
function seedArchive(root: string): void {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const cut = png.subarray(0, png.length - 12);
  const folder = 'Peer Check Series (kept-99)';
  mkdirSync(resolve(root, folder, 'Chapter 0001'), { recursive: true });
  writeFileSync(resolve(root, folder, 'Chapter 0001', '001.png'), png);
  writeFileSync(resolve(root, folder, 'Chapter 0001', '002.png'), cut);
  const page = (n: number, bytes: number, manga = '990000777') => ({ path: `/api/v1/manga/${manga}/chapter/1/page/${n}`, file: `00${n + 1}.png`, type: 'image/png', bytes });
  const now = Date.now();
  const wholeFolder = 'Whole Series (kept-99)';
  mkdirSync(resolve(root, wholeFolder, 'Chapter 0001'), { recursive: true });
  writeFileSync(resolve(root, wholeFolder, 'Chapter 0001', '001.png'), png);
  writeFileSync(resolve(root, wholeFolder, 'Chapter 0001', '002.png'), png);
  writeFileSync(
    resolve(root, wholeFolder, 'series.json'),
    JSON.stringify({
      seriesId: 'kept-990000778',
      title: 'Whole Series',
      source: { adapter: 'suwayomi', mangaId: '990000778', sourceName: 'Check source', title: 'Whole Series' },
      startedAt: now,
      updatedAt: now,
      chapters: [
        { number: 1, name: 'Chapter 1', chapterId: '990000778001', folder: 'Chapter 0001', pages: [page(0, png.length, '990000778'), page(1, png.length, '990000778')], expected: 2, done: true, error: null, at: now },
      ],
    })
  );
  writeFileSync(
    resolve(root, 'index.json'),
    JSON.stringify({
      series: [
        { seriesId: 'kept-990000777', folder, title: 'Peer Check Series', addedAt: now, mangaId: '990000777', keptFor: ['you'] },
        { seriesId: 'kept-990000778', folder: wholeFolder, title: 'Whole Series', addedAt: now, mangaId: '990000778', keptFor: ['you'] },
      ],
      queue: [],
    })
  );
  // A catalogue of one counted copy, on a source of id 123456, by Suwayomi's id 555.
  const catalogue = resolve(root, '..', 'manga-catalogue');
  mkdirSync(catalogue, { recursive: true });
  writeFileSync(resolve(catalogue, 'source-123456.json'), JSON.stringify({ titles: { '555': 'Peer Check Series' }, found: [], seen: [] }));
  writeFileSync(
    resolve(catalogue, 'index.json'),
    JSON.stringify({
      v: 1,
      sources: { '123456': { name: 'Check source', lang: 'en', supportsLatest: false, mapped: false, mappedAt: null, crawl: null, why: null, latestAt: null } },
      counts: { '555': { p: { entries: 12, distinct: 12, first: 1, latest: 12, missing: 0, newestUpload: null }, at: now } },
      searched: {},
      told: {},
      tried: {},
      settings: { nudge: false, background: false, automatic: false },
      seededAt: null,
    })
  );
  writeFileSync(
    resolve(root, folder, 'series.json'),
    JSON.stringify({
      seriesId: 'kept-990000777',
      title: 'Peer Check Series',
      source: { adapter: 'suwayomi', mangaId: '990000777', sourceName: 'Check source', title: 'Peer Check Series' },
      startedAt: now,
      updatedAt: now,
      chapters: [
        { number: 1, name: 'Chapter 1', chapterId: '990000777001', folder: 'Chapter 0001', pages: [page(0, png.length), page(1, cut.length)], expected: 2, done: true, error: null, at: now },
        { number: 2, name: 'Chapter 2', chapterId: '990000777002', folder: 'Chapter 0002', pages: [], expected: 3, done: false, error: null, at: now },
      ],
    })
  );
}
