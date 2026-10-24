/**
 * Proves the rules of a guest copy (plan A in "Blue Everything for friends"),
 * against a throwaway copy that is deleted afterwards.
 *
 *   npm run instance-check -w @everything/server
 *
 * Two processes, because which copy this is is settled once, when `config.ts`
 * is first imported: this one runs as the guest `zz-check`, and runs itself
 * again as the host (`host` argument) on a throwaway database. Nothing here
 * starts Suwayomi or writes to your data: the host half only mints and checks
 * keys, and the guest half lives in `instances/zz-check/`, removed at the end.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const NAME = 'zz-check';
const here = fileURLToPath(import.meta.url);
const serverRoot = resolve(dirname(here), '../..');
const instancesDir = resolve(serverRoot, '../..', 'instances');
const copyDir = resolve(instancesDir, NAME);
const hostDb = resolve(serverRoot, 'data', 'instance-check-host.db');
const role = process.argv[2] === 'host' || process.argv[2] === 'guest' ? process.argv[2] : 'run';
const asHost = role === 'host';

/**
 * The run: a copy for the host to find, the host's half, the guest's half,
 * and then the clean-up, here, after both have exited. A database is held open
 * until its process ends, and on Windows an open file cannot be removed.
 */
if (role === 'run') {
  const removeAll = () => {
    for (const target of [copyDir, hostDb, `${hostDb}-wal`, `${hostDb}-shm`]) {
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
    if (existsSync(instancesDir) && readdirSync(instancesDir).length === 0) rmSync(instancesDir, { recursive: true });
  };
  removeAll();
  mkdirSync(copyDir, { recursive: true });
  writeFileSync(resolve(copyDir, 'instance.json'), JSON.stringify({ port: 8999 }));
  let failed = false;
  for (const half of ['host', 'guest'] as const) {
    console.log(`\n${half === 'host' ? 'the host' : 'a guest copy'}`);
    const child = spawnSync(process.execPath, ['--import', 'tsx', here, half], { cwd: serverRoot, stdio: 'inherit' });
    if (child.status !== 0) failed = true;
  }
  removeAll();
  console.log(failed ? '\n\x1b[31mSome checks failed.\x1b[0m\n' : '\n\x1b[32mAll checks passed.\x1b[0m\n');
  process.exit(failed ? 1 : 0);
}

if (asHost) {
  process.env.DATABASE_URL = `file:${hostDb}`;
  process.env.EVERYTHING_INSTANCE = '';
} else {
  process.env.EVERYTHING_INSTANCE = NAME;
  // Nothing listens here, so the guest's ask of the host fails as it would
  // with the host stopped.
  process.env.EVERYTHING_HOST_URL = 'http://127.0.0.1:9';
}
process.env.LOG_LEVEL = 'error';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const { runMigrations } = await import('../db/migrate.js');
const { buildApp } = await import('../app.js');
const { client, db } = await import('../db/client.js');
const { devices } = await import('../db/schema.js');
const { hashToken } = await import('../auth.js');
await runMigrations();

/** A device straight into this copy's database, and its token. */
async function device(kind: 'browser' | 'instance', name: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.insert(devices).values({ name, kind, tokenHash: hashToken(token) });
  return token;
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

if (asHost) {
  const { listInstances, mintInstanceKey } = await import('../instances.js');
  const app = await buildApp();

  // Only this check's copy: any real copy in instances/ is left alone, since
  // a key minted here would be in a throwaway database and not work.
  check('the host finds a copy by its instance.json', listInstances().includes(NAME));
  await mintInstanceKey(NAME);
  const keyFile = resolve(copyDir, 'host-key');
  check('the host gives a copy its key', existsSync(keyFile));
  const key = existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : '';

  const tasks = await app.inject({ method: 'GET', url: '/api/tasks', headers: bearer(key) });
  check("a copy's key opens nothing but what copies share", tasks.statusCode === 403, `${tasks.statusCode}`);

  const ask = await app.inject({
    method: 'POST',
    url: '/api/manga/host/requests',
    headers: bearer(key),
    payload: { pkg: 'not a package!', flagged: true },
  });
  // A bad name is refused by the route itself, which proves the key reached it
  // without writing a flag into this checkout's data.
  check("  ...and reaches the host's request route", ask.statusCode === 400 || ask.statusCode === 404, `${ask.statusCode}`);

  const browser = await device('browser', 'instance-check browser');
  const askedByPhone = await app.inject({
    method: 'POST',
    url: '/api/manga/host/requests',
    headers: bearer(browser),
    payload: { pkg: 'eu.kanade.example', flagged: true },
  });
  check('only a copy may file a request', askedByPhone.statusCode === 403 || askedByPhone.statusCode === 404, `${askedByPhone.statusCode}`);

  const rotate = await app.inject({ method: 'POST', url: `/api/instances/${NAME}/key` });
  check('the host gives a new key from this PC', rotate.statusCode === 200, `${rotate.statusCode} ${rotate.body}`);
  const old = await app.inject({ method: 'POST', url: '/api/manga/host/requests', headers: bearer(key), payload: {} });
  check('  ...and the old key stops working', old.statusCode === 401, `${old.statusCode}`);

  const fromPhone = await app.inject({
    method: 'POST',
    url: `/api/instances/${NAME}/key`,
    headers: { ...bearer(browser), host: 'desktop.example.ts.net' },
  });
  check('  ...but not from anywhere else', fromPhone.statusCode === 403, `${fromPhone.statusCode}`);

  // What is kept on the PC: one store, which copies read with their key.
  const keptList = await app.inject({ method: 'GET', url: '/api/manga/host/archive', headers: bearer(readFileSync(keyFile, 'utf8').trim()) });
  check("a copy's key lists what is kept on the PC", keptList.statusCode === 200 && Array.isArray((keptList.json() as { series?: unknown }).series), `${keptList.statusCode}`);
  const keptByPhone = await app.inject({ method: 'GET', url: '/api/manga/host/archive', headers: { ...bearer(browser), host: 'desktop.example.ts.net' } });
  check('  ...and a phone does not, through that door', keptByPhone.statusCode === 403, `${keptByPhone.statusCode}`);
  const badPage = await app.inject({
    method: 'GET',
    url: '/api/manga/host/archive/page?manga=1&p=/etc/passwd',
    headers: bearer(readFileSync(keyFile, 'utf8').trim()),
  });
  check('  ...and a page is only ever a page', badPage.statusCode === 400, `${badPage.statusCode}`);
  // Pages from the shared Suwayomi, which copies fetch through the host so a page is fetched once.
  const hostPageBad = await app.inject({ method: 'GET', url: '/api/manga/host/page?p=/etc/passwd', headers: bearer(readFileSync(keyFile, 'utf8').trim()) });
  check("a copy's page through the host is only ever a page", hostPageBad.statusCode === 400, `${hostPageBad.statusCode}`);
  const hostPageByPhone = await app.inject({ method: 'GET', url: '/api/manga/host/page?p=/api/v1/manga/1/chapter/1/page/0', headers: { ...bearer(browser), host: 'desktop.example.ts.net' } });
  check('  ...and a phone cannot use that door', hostPageByPhone.statusCode === 403, `${hostPageByPhone.statusCode}`);

  // People: managed from any of your devices, not only this PC.
  const people = await app.inject({ method: 'GET', url: '/api/people', headers: { ...bearer(browser), host: 'desktop.example.ts.net' } });
  const listed = (people.json() as { people?: { name: string }[] }).people ?? [];
  check('your phone lists the people', people.statusCode === 200 && listed.some((p) => p.name === NAME), `${people.statusCode}`);
  const newKey = readFileSync(keyFile, 'utf8').trim();
  const byCopy = await app.inject({ method: 'GET', url: '/api/people', headers: bearer(newKey) });
  check("  ...and a copy's key does not", byCopy.statusCode === 403, `${byCopy.statusCode}`);
  // Display names: a copy tells the host what its person is called.
  const named = await app.inject({ method: 'PUT', url: '/api/host/name', headers: bearer(newKey), payload: { name: '  Sam   R ' } });
  check("a copy's key sets its person's name", named.statusCode === 200 && (named.json() as { name?: string }).name === 'Sam R', named.body.slice(0, 80));
  const listedNamed = ((await app.inject({ method: 'GET', url: '/api/people', headers: bearer(browser) })).json() as { people: { name: string; displayName: string | null }[] }).people;
  check('  ...which People shows', listedNamed.find((p) => p.name === NAME)?.displayName === 'Sam R', JSON.stringify(listedNamed));
  const namedByPhone = await app.inject({ method: 'PUT', url: '/api/host/name', headers: { ...bearer(browser), host: 'desktop.example.ts.net' }, payload: { name: 'Mallory' } });
  check('  ...and a phone cannot name a copy', namedByPhone.statusCode === 403, `${namedByPhone.statusCode}`);
  const longName = await app.inject({ method: 'PUT', url: '/api/host/name', headers: bearer(newKey), payload: { name: 'x'.repeat(41) } });
  check('  ...and a name is at most 40 characters', longName.statusCode === 400, `${longName.statusCode}`);
  const badName = await app.inject({ method: 'POST', url: '/api/people', headers: bearer(browser), payload: { name: 'Not A Name!' } });
  check('a person needs a plain name', badName.statusCode === 400, `${badName.statusCode}`);
  const hostSession = await app.inject({ method: 'GET', url: '/api/session', headers: bearer(browser) });
  check('the host says it is the host', (hostSession.json() as { copy?: unknown }).copy === null, hostSession.body.slice(0, 60));
  const hostOnboarding = (hostSession.json() as { onboarding?: { done: boolean } }).onboarding;
  check('  ...and needs no onboarding, having been set up before it', hostOnboarding?.done === true, JSON.stringify(hostOnboarding));
  check('  ...and is called "user" until it says otherwise', (hostSession.json() as { defaultName?: string }).defaultName === 'user', hostSession.body.slice(0, 60));

  const invited = await app.inject({ method: 'POST', url: `/api/people/${NAME}/invite`, headers: bearer(browser) });
  const link = (invited.json() as { url?: string }).url ?? '';
  const code = /#invite=([A-Za-z0-9_-]+)$/.exec(link)?.[1] ?? '';
  check('a sign-in link is made', invited.statusCode === 200 && code.length > 16, link.replace(/invite=.*/, 'invite=…'));
  const stored = readFileSync(resolve(copyDir, 'invites.json'), 'utf8');
  check('  ...and only its hash is written', !stored.includes(code), '');
  // Handed to the guest half, which runs next.
  writeFileSync(resolve(copyDir, 'check-code'), code);

  await app.close();
  client.close();
  process.exit(failures === 0 ? 0 : 1);
}

const paths = await import('../paths.js');
const { config, isGuest } = await import('../config.js');
const inCopy = (p: string) => p.startsWith(copyDir + sep);
check('it knows it is a guest', isGuest);
check('its database is in its folder', config.DATABASE_URL.includes(`${sep}instances${sep}${NAME}${sep}data${sep}`), config.DATABASE_URL);
check('so are its data, logs and settings', [paths.dataDir, paths.logsDir, paths.featuresFile, paths.modulesStateFile].every(inCopy));

const app = await buildApp();

const anonymous = await app.inject({ method: 'GET', url: '/api/session' });
check('a request from this PC with no token is refused', anonymous.statusCode === 401, `${anonymous.statusCode}`);

const token = await device('browser', 'instance-check browser');
const session = await app.inject({ method: 'GET', url: '/api/session', headers: bearer(token) });
check('  ...and one with a token is let in', session.statusCode === 200, `${session.statusCode}`);
check('it says which copy it is', (session.json() as { copy?: unknown }).copy === NAME, session.body.slice(0, 60));

const code = existsSync(resolve(copyDir, 'check-code')) ? readFileSync(resolve(copyDir, 'check-code'), 'utf8') : '';
const redeemed = await app.inject({ method: 'POST', url: '/api/invite/redeem', payload: { code, kind: 'phone', name: 'check phone' } });
const linked = (redeemed.json() as { token?: string }).token ?? '';
check('a sign-in link signs a device in, with no token', redeemed.statusCode === 200 && linked.length > 20, `${redeemed.statusCode}`);
const asLinked = await app.inject({ method: 'GET', url: '/api/session', headers: bearer(linked) });
check('  ...as a device of this copy', asLinked.statusCode === 200, `${asLinked.statusCode}`);
const again = await app.inject({ method: 'POST', url: '/api/invite/redeem', payload: { code } });
check('  ...once', again.statusCode === 410, `${again.statusCode}`);
const guessed = await app.inject({ method: 'POST', url: '/api/invite/redeem', payload: { code: randomBytes(24).toString('base64url') } });
check('a made-up code signs nobody in', guessed.statusCode === 410, `${guessed.statusCode}`);
const people = await app.inject({ method: 'GET', url: '/api/people', headers: bearer(token) });
// Onboarding: a new copy starts it, and a device of the copy finishes it.
const fresh = (session.json() as { onboarding?: { done: boolean; shown: unknown } }).onboarding;
check('a new copy starts with onboarding to do', fresh?.done === false && fresh.shown === null, JSON.stringify(fresh));
const chose = await app.inject({ method: 'PUT', url: '/api/onboarding', headers: bearer(token), payload: { shown: ['manga'], done: true } });
const after = (await app.inject({ method: 'GET', url: '/api/session', headers: bearer(token) })).json() as { onboarding?: { done: boolean; shown: string[] } };
check('"just the manga" is kept, and onboarding is done', chose.statusCode === 200 && after.onboarding?.done === true && after.onboarding.shown.join() === 'manga', JSON.stringify(after.onboarding));
const unnamed = (await app.inject({ method: 'GET', url: '/api/session', headers: bearer(token) })).json() as { displayName?: string | null; defaultName?: string; onboarding?: { preset?: string; known?: unknown } };
check("a copy that skips its name is called what the host named it", unnamed.displayName === null && unnamed.defaultName === process.env.EVERYTHING_INSTANCE, JSON.stringify(unnamed.defaultName));
check('"just the manga" reads as that choice', unnamed.onboarding?.preset === 'manga', JSON.stringify(unnamed.onboarding));
const picked = await app.inject({ method: 'PUT', url: '/api/onboarding', headers: bearer(token), payload: { shown: ['manga', 'notes'], preset: 'custom', known: ['manga', 'notes', 'tasks'] } });
const pickedBack = picked.json() as { preset?: string; known?: string[] };
check('a hand-picked list keeps what was on offer', picked.statusCode === 200 && pickedBack.preset === 'custom' && pickedBack.known?.join() === 'manga,notes,tasks', picked.body.slice(0, 120));
const badPreset = await app.inject({ method: 'PUT', url: '/api/onboarding', headers: bearer(token), payload: { preset: 'some' } });
check('  ...and a choice is only ever one of the three', badPreset.statusCode === 400, `${badPreset.statusCode}`);
await app.inject({ method: 'PUT', url: '/api/onboarding', headers: bearer(token), payload: { shown: ['manga'], preset: 'manga' } });
// Closing the app: keep by default, and a new copy has nothing that needs the background.
const closingNow = (await app.inject({ method: 'GET', url: '/api/closing?side=desktop', headers: bearer(token) })).json() as { mode?: string; keeps?: string[] };
check('closing the app keeps it running unless chosen', closingNow.mode === 'keep', JSON.stringify(closingNow));
check('  ...and a new copy has nothing that needs it, so it would close anyway', closingNow.keeps?.length === 0, JSON.stringify(closingNow.keeps));
const quitting = await app.inject({ method: 'PUT', url: '/api/closing', headers: bearer(token), payload: { mode: 'quit' } });
check('"close everything" is kept', quitting.statusCode === 200 && (quitting.json() as { mode?: string }).mode === 'quit', quitting.body.slice(0, 80));
const oddClose = await app.inject({ method: 'PUT', url: '/api/closing', headers: bearer(token), payload: { mode: 'later' } });
check('  ...and the choice is one of the two', oddClose.statusCode === 400, `${oddClose.statusCode}`);
const myName = await app.inject({ method: 'PUT', url: '/api/profile/name', headers: bearer(token), payload: { name: 'Sam' } });
const withName = (await app.inject({ method: 'GET', url: '/api/session', headers: bearer(token) })).json() as { displayName?: string | null };
check('a copy keeps its display name', myName.statusCode === 200 && withName.displayName === 'Sam', JSON.stringify(withName.displayName));
const odd = await app.inject({ method: 'PUT', url: '/api/onboarding', headers: bearer(token), payload: { shown: ['../../x'] } });
check('  ...and a screen is only ever a screen name', odd.statusCode === 400, `${odd.statusCode}`);

// A hand-off code: what an app just added to the Home Screen types to sign in.
const handoff = await app.inject({ method: 'POST', url: '/api/devices/handoff', headers: bearer(token) });
const typed = (handoff.json() as { code?: string }).code ?? '';
check('a signed-in device makes a short code', handoff.statusCode === 200 && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(typed), typed.replace(/./g, '•'));
const asTyped = await app.inject({ method: 'POST', url: '/api/invite/redeem', payload: { code: ` ${typed.toLowerCase().replace('-', ' ')} ` } });
check('  ...which signs the new one in, typed loosely', asTyped.statusCode === 200, `${asTyped.statusCode}`);
const twice = await app.inject({ method: 'POST', url: '/api/invite/redeem', payload: { code: typed } });
check('  ...once', twice.statusCode === 410, `${twice.statusCode}`);
const nobody = await app.inject({ method: 'POST', url: '/api/devices/handoff' });
check('nobody signed out can make one', nobody.statusCode === 401, `${nobody.statusCode}`);

// The Local collection's rules and rating sharing: off until chosen, and kept.
const rules0 = (await app.inject({ method: 'GET', url: '/api/manga/collection-rules', headers: bearer(token) })).json() as Record<string, unknown>;
check('rating sharing and auto-keep start off', rules0.shareRatingsWithCopies === false && rules0.autoKeepFavourites === false && rules0.autoKeepMinRating === null, JSON.stringify(rules0));
const rules1 = await app.inject({ method: 'PUT', url: '/api/manga/collection-rules', headers: bearer(token), payload: { autoKeepMinRating: 8, autoKeepFavourites: true } });
const after1 = rules1.json() as Record<string, unknown>;
check('  ...and are kept when chosen', after1.autoKeepMinRating === 8 && after1.autoKeepFavourites === true, JSON.stringify(after1));
const badRule = await app.inject({ method: 'PUT', url: '/api/manga/collection-rules', headers: bearer(token), payload: { autoKeepMinRating: 11 } });
check('  ...and a rating is 1 to 10', badRule.statusCode === 400, `${badRule.statusCode}`);
const badRating = await app.inject({ method: 'PUT', url: '/api/manga/anything/rating', headers: bearer(token), payload: { rating: 7.5 } });
check('a rating is a whole number', badRating.statusCode === 400, `${badRating.statusCode}`);

const keptHere = await app.inject({ method: 'GET', url: '/api/manga/kept', headers: bearer(token) });
check("what is kept is the host's, and it says so when the host is down", keptHere.statusCode === 502, `${keptHere.statusCode}`);
const letGo = await app.inject({ method: 'DELETE', url: '/api/manga/anything/archive', headers: bearer(token) });
check('a copy cannot stop keeping a series', letGo.statusCode === 403, `${letGo.statusCode}`);
check('a copy manages no people', people.statusCode === 404, `${people.statusCode}`);

const pair = await app.inject({ method: 'POST', url: '/api/devices', headers: bearer(token), payload: { name: 'x', kind: 'phone' } });
check('local-only routes are closed to everyone', pair.statusCode === 403, `${pair.statusCode}`);

const restart = await app.inject({ method: 'POST', url: '/api/restart', headers: bearer(token) });
check('  ...so it runs nothing on this PC (restart)', restart.statusCode === 403, `${restart.statusCode}`);

const install = await app.inject({ method: 'PUT', url: '/api/manga/extensions/eu.kanade.example', headers: bearer(token), payload: {} });
check('it may not install a source', install.statusCode === 403 && /host/.test(install.body), `${install.statusCode} ${install.body.slice(0, 80)}`);

const ui = await app.inject({ method: 'POST', url: '/api/manga/ui-session', headers: bearer(token) });
check("  ...or open Suwayomi's own interface", ui.statusCode === 403, `${ui.statusCode}`);

const wake = await app.inject({ method: 'POST', url: '/api/manga/host/wake', headers: bearer(token) });
check('it runs no Suwayomi for anybody else', wake.statusCode === 404, `${wake.statusCode}`);

const { suwayomiProcess } = await import('../../../modules/manga/server/process.js');
rmSync(resolve(copyDir, 'host-key'), { force: true });
const keyless = await suwayomiProcess.ensureRunning('host', 'http://127.0.0.1:4567');
check('with no key it says so', keyless.state === 'failed' && /key/.test(keyless.problem), JSON.stringify(keyless));
writeFileSync(resolve(copyDir, 'host-key'), 'not-a-real-key');
const hostDown = await suwayomiProcess.ensureRunning('host', 'http://127.0.0.1:4567');
check("with the host stopped it says so", hostDown.state === 'failed' && /isn't answering/.test(hostDown.problem), JSON.stringify(hostDown));

await app.close();
client.close();

process.exit(failures === 0 ? 0 : 1);
