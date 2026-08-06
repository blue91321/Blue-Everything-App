/**
 * Exercises the vault API end to end against a throwaway database.
 *
 * The crypto is proven separately by `vault-check`. This proves the parts that
 * sit around it and would fail quietly: a locked vault refusing to answer, the
 * list never carrying passwords, and a wrong password not being distinguishable
 * from a corrupt one.
 *
 *   npm run vault-api -w @everything/server
 */
process.env.DATABASE_URL = 'file:./data/vault-smoke.db';
process.env.AUTH_REQUIRED = 'false';
process.env.LOG_LEVEL = 'error';

import { rmSync } from 'node:fs';

rmSync('./data/vault-smoke.db', { force: true });

const { runMigrations } = await import('../db/migrate.js');
const { buildApp } = await import('../app.js');
const session = await import('../vault/session.js');

await runMigrations();
const app = await buildApp();

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  \x1b[32mPASS\x1b[0m' : '  \x1b[31mFAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const post = (url: string, payload?: unknown) =>
  app.inject({ method: 'POST', url, payload: (payload ?? {}) as object });
const get = (url: string) => app.inject({ method: 'GET', url });

const MASTER = 'a long enough master passphrase';

console.log('\nbefore setup');
const fresh = await get('/api/vault/status');
check('reports itself unconfigured', fresh.json().configured === false);
check('and locked', fresh.json().unlocked === false);
check('items are refused while locked', (await get('/api/vault/items')).statusCode === 423);

console.log('\nsetup');
const created = await post('/api/vault/setup', { masterPassword: MASTER, withRecovery: true });
check('creates the vault', created.statusCode === 201);
const shares = created.json().recoveryShares as { a: string; b: string };
check('returns two recovery shares', Boolean(shares?.a && shares?.b), `${shares?.a?.slice(0, 11)}… / ${shares?.b?.slice(0, 11)}…`);
check('the two shares differ', shares.a !== shares.b);
check('setup leaves it unlocked', (await get('/api/vault/status')).json().unlocked === true);
check('a second setup is refused', (await post('/api/vault/setup', { masterPassword: MASTER })).statusCode === 409);

console.log('\nitems');
const item = await post('/api/vault/items', {
  title: 'Example', username: 'blake', password: 'hunter2',
  url: 'https://example.com', notes: 'secret note', totp: 'JBSWY3DPEHPK3PXP',
});
check('creates an entry', item.statusCode === 201);
const id = item.json().id as string;

const listed = await get('/api/vault/items');
const listBody = JSON.stringify(listed.json());
check('lists it', listed.json().length === 1);
check('the list carries no password', !listBody.includes('hunter2'), 'summaries only');
check('nor the TOTP secret or notes', !listBody.includes('JBSWY3DPEHPK3PXP') && !listBody.includes('secret note'));
check('but does carry the title and username', listBody.includes('Example') && listBody.includes('blake'));

const secret = await get(`/api/vault/items/${id}/secret`);
check('the secret is fetchable on its own', secret.json().password === 'hunter2');
check('with the TOTP and notes', secret.json().totp === 'JBSWY3DPEHPK3PXP' && secret.json().notes === 'secret note');

await app.inject({ method: 'PATCH', url: `/api/vault/items/${id}`, payload: { password: 'rotated' } });
check('updates without losing other fields', (await get(`/api/vault/items/${id}/secret`)).json().password === 'rotated');
check('and keeps the username', (await get('/api/vault/items')).json()[0].username === 'blake');

console.log('\nnothing readable at rest');
{
  const { db } = await import('../db/client.js');
  const { vaultEntries } = await import('../db/schema.js');
  const rows = await db.select().from(vaultEntries);
  const raw = JSON.stringify(rows);
  check('the database row holds no plaintext password', !raw.includes('rotated'));
  check('nor the title', !raw.includes('Example'), 'everything is inside the blob');
  check('nor the URL', !raw.includes('example.com'));
}

console.log('\nlocking');
await post('/api/vault/lock');
check('locks on request', (await get('/api/vault/status')).json().unlocked === false);
check('items are refused once locked', (await get('/api/vault/items')).statusCode === 423);
check('secrets are refused once locked', (await get(`/api/vault/items/${id}/secret`)).statusCode === 423);
check('status still works while locked', (await get('/api/vault/status')).json().configured === true);

console.log('\nunlocking');
check('the wrong password is refused', (await post('/api/vault/unlock', { masterPassword: 'wrong' })).statusCode === 401);
const wrongBody = (await post('/api/vault/unlock', { masterPassword: 'also wrong' })).json();
check('and says nothing about why', !JSON.stringify(wrongBody).match(/salt|key|argon|corrupt/i), wrongBody.error);
session.resetForTests();
check('the right password unlocks', (await post('/api/vault/unlock', { masterPassword: MASTER })).statusCode === 200);
check('and the entry is intact', (await get(`/api/vault/items/${id}/secret`)).json().password === 'rotated');

console.log('\nmatching for the extension');
const matched = await get(`/api/vault/match?url=${encodeURIComponent('https://login.example.com/signin')}`);
check('matches a subdomain of a stored entry', matched.json().length === 1);
const unmatched = await get(`/api/vault/match?url=${encodeURIComponent('https://example.com.evil.test/')}`);
check('does not match a lookalike domain', unmatched.json().length === 0, 'example.com.evil.test');

console.log('\nrecovery');
await post('/api/vault/lock');
const badRecover = await post('/api/vault/recover', {
  shareA: shares.a, shareB: shares.a, newMasterPassword: 'a different long passphrase',
});
check('two copies of one share do not recover', badRecover.statusCode === 401);

const recovered = await post('/api/vault/recover', {
  shareA: shares.a, shareB: shares.b, newMasterPassword: 'a different long passphrase',
});
check('both shares recover the vault', recovered.statusCode === 200);
check('the entry survived recovery', (await get(`/api/vault/items/${id}/secret`)).json().password === 'rotated');

await post('/api/vault/lock');
session.resetForTests();
check(
  'the old master password no longer works',
  (await post('/api/vault/unlock', { masterPassword: MASTER })).statusCode === 401
);
session.resetForTests();
check(
  'the new one does',
  (await post('/api/vault/unlock', { masterPassword: 'a different long passphrase' })).statusCode === 200
);

console.log('\nbrute force');
session.resetForTests();
await post('/api/vault/lock');
for (let i = 0; i < session.MAX_FAILED_UNLOCKS; i++) await post('/api/vault/unlock', { masterPassword: 'nope' });
check('repeated failures trigger a cooldown', (await post('/api/vault/unlock', { masterPassword: 'nope' })).statusCode === 429);

await app.close();
console.log(failures === 0 ? '\n\x1b[32mVault API sound.\x1b[0m\n' : `\n\x1b[31m${failures} failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
