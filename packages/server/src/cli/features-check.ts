/**
 * Proof that features can actually be switched off and deleted.
 *
 *   npm run features-check -w @everything/server
 *
 * The claim being tested is the one that rots silently: somebody adds an
 * `import` from core into a feature folder, everything still works on the
 * machine where every feature is present, and the app only breaks for the
 * person who took one out. Nothing else in the suite would catch that.
 *
 * Three questions:
 *
 *   1. With everything on, do the feature routes answer?
 *   2. With a feature off, is it unmounted and reported as off?
 *   3. With a feature's folder *deleted*, does the server still boot?
 *
 * (3) is the real one, and it is tested against a genuine copy of `src` with
 * the folder genuinely removed — not a mock loader that throws the right error.
 * The copy sits at `src.featurecheck`, deliberately the same depth as `src`, so
 * every relative path in the tree — the migrations folder, the built PWA, the
 * repo root — still resolves. Nothing in the real tree is ever renamed or
 * deleted, so an interrupted run cannot cost anybody their source.
 */
import { cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, '../..');
const realSrc = resolve(serverRoot, 'src');
const copySrc = resolve(serverRoot, 'src.featurecheck');

/** Marks the probe's one line of output apart from the logger's. */
const RESULT_PREFIX = '##features##';

/* ------------------------------------------------------------------ */
/* Probe mode: build the app once and report what it mounted           */
/* ------------------------------------------------------------------ */

if (process.argv[2] === 'probe') {
  process.env.DATABASE_URL = 'file:./data/features-smoke.db';
  process.env.AUTH_REQUIRED = 'false';
  // 'fatal', not 'silent' — config.ts validates this against a fixed list and
  // exits on anything else, which would look exactly like a boot failure.
  process.env.LOG_LEVEL = 'fatal';

  const { runMigrations } = await import('../db/migrate.js');
  const { buildApp } = await import('../app.js');

  await runMigrations();
  const app = await buildApp();

  const status = async (url: string) => (await app.inject({ method: 'GET', url })).statusCode;
  const session = (await app.inject({ method: 'GET', url: '/api/session' })).json();

  /*
   * Behind a sentinel rather than as bare JSON. Fastify's logger writes pino
   * records — which are themselves JSON objects — to stdout, so "the last line
   * starting with {" would sometimes pick up a log entry instead of the result.
   */
  console.log(
    RESULT_PREFIX +
      JSON.stringify({
        health: await status('/health'),
        vault: await status('/api/vault/status'),
        voice: await status('/api/voice/config'),
        integrations: await status('/api/integrations'),
        habits: await status('/api/habits'),
        notes: await status('/api/notes'),
        features: session.features,
        missing: session.featuresMissing,
      })
  );

  await app.close();
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* Parent mode                                                         */
/* ------------------------------------------------------------------ */

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  \x1b[32mPASS\x1b[0m' : '  \x1b[31mFAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

interface Probe {
  health: number;
  vault: number;
  voice: number;
  integrations: number;
  habits: number;
  notes: number;
  features: string[];
  missing: string[];
}

/** Run the probe in a child process, since features resolve once at import. */
function probe(features: string | undefined, from = realSrc): Probe | null {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', resolve(from, 'cli/features-check.ts'), 'probe'],
    {
      cwd: serverRoot,
      encoding: 'utf8',
      env: { ...process.env, ...(features === undefined ? {} : { FEATURES: features }) },
    }
  );

  const line = (result.stdout ?? '')
    .split('\n')
    .find((l) => l.startsWith(RESULT_PREFIX));

  if (!line) {
    console.log(`\x1b[31m  probe produced no result\x1b[0m\n${result.stderr?.slice(0, 1200)}`);
    return null;
  }
  return JSON.parse(line.slice(RESULT_PREFIX.length)) as Probe;
}

console.log('\neverything on');
const all = probe('vault,voice,push,habits,notes,time');
if (all) {
  check('the server boots', all.health === 200);
  check('the vault answers', all.vault === 200);
  check('voice answers', all.voice === 200);
  check('and the session lists them', all.features.includes('vault') && all.features.includes('voice'));
}

console.log('\nvault switched off');
const noVault = probe('voice,push,habits,notes,time');
if (noVault) {
  check('the server still boots', noVault.health === 200);
  check('the vault is not mounted', noVault.vault === 404);
  check('voice is unaffected', noVault.voice === 200);
  check('and the session does not list it', !noVault.features.includes('vault'));
  check('nor claim it is missing — it was switched off', !noVault.missing.includes('vault'));
}

console.log('\nintegrations, which start off rather than on');
// The only feature whose default is off, so this checks both directions —
// a default-off feature that could not be switched *on* would look identical
// to one that was simply never wired up.
const withIntegrations = probe('integrations,habits,notes,time');
if (withIntegrations) {
  check('it mounts when named', withIntegrations.integrations === 200);
  check('and appears in the session', withIntegrations.features.includes('integrations'));
}
const noIntegrations = probe('vault,voice,push,habits,notes,time');
if (noIntegrations) {
  check('it is not mounted when it is not', noIntegrations.integrations === 404);
  check('and is absent from the session', !noIntegrations.features.includes('integrations'));
  check('nor claimed missing — it was switched off', !noIntegrations.missing.includes('integrations'));
}

console.log('\nvoice switched off');
const noVoice = probe('vault,push,habits,notes,time');
if (noVoice) {
  check('the server still boots', noVoice.health === 200);
  check('voice is not mounted', noVoice.voice === 404);
  check('the vault is unaffected', noVoice.vault === 200);
}

console.log('\nonly the core');
// 'none' rather than '', which would read as "unset" and fall back to defaults.
const core = probe('none');
if (core) {
  check('the server boots with every optional feature off', core.health === 200);
  check('no vault', core.vault === 404);
  check('no voice', core.voice === 404);
  check('no integrations', core.integrations === 404);
  check('no habits', core.habits === 404);
  check('no notes', core.notes === 404);
  check('and it says so', core.features.length === 0);
}

console.log('\nthe vault folder deleted from disk');
try {
  rmSync(copySrc, { recursive: true, force: true });
  cpSync(realSrc, copySrc, { recursive: true });
  rmSync(resolve(copySrc, 'features/vault'), { recursive: true, force: true });

  // Switched *on*, but gone. This is the case that separates "the loader
  // tolerates a missing folder" from "the loader never had to find out".
  const deleted = probe('vault,voice,push,habits,notes,time', copySrc);
  if (deleted) {
    check('the server still boots', deleted.health === 200);
    check('the vault is not mounted', deleted.vault === 404);
    check('voice still works', deleted.voice === 200);
    check('it is reported as missing, not as off', deleted.missing.includes('vault'));
    check('and is absent from the active list', !deleted.features.includes('vault'));
  }
} finally {
  rmSync(copySrc, { recursive: true, force: true });
}

console.log('\nthe integrations folder deleted from disk');
try {
  rmSync(copySrc, { recursive: true, force: true });
  cpSync(realSrc, copySrc, { recursive: true });
  rmSync(resolve(copySrc, 'features/integrations'), { recursive: true, force: true });

  const deleted = probe('integrations,voice,habits,notes,time', copySrc);
  if (deleted) {
    check('the server still boots', deleted.health === 200);
    check('integrations are not mounted', deleted.integrations === 404);
    check('voice still works', deleted.voice === 200);
    check('it is reported as missing, not as off', deleted.missing.includes('integrations'));
    check('and is absent from the active list', !deleted.features.includes('integrations'));
  }
} finally {
  rmSync(copySrc, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? '\n\x1b[32mFeatures are genuinely separable.\x1b[0m'
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
