/**
 * Every check that needs no hardware and no network, one after another.
 *
 *   npm run checks
 *
 * The one list, so the workflow on every push, the release workflow and a
 * person at a terminal run the same thing. The voice and Win32 checks need a
 * microphone and a desktop, which a CI runner does not have; they are run by
 * hand (see CLAUDE.md, "Running the parts individually").
 *
 * Each suite runs to the end even when an earlier one fails, so one run says
 * everything that is wrong rather than the first thing.
 */
import { spawnSync } from 'node:child_process';

const SERVER = [
  'smoke',
  'manga-check',
  'notes-check',
  'integrations-check',
  'modules-check',
  'vault-check',
  'vault-api',
  'trips-check',
  'import-check',
  'voice-check',
  'weather-check',
];

const runs = [
  ...SERVER.map((name) => ({ name, args: ['run', name, '-w', '@everything/server'] })),
  { name: 'publish-check', args: ['run', 'publish-check'] },
];

const results = [];
for (const { name, args } of runs) {
  console.log(`\n=== ${name} ===\n`);
  const started = Date.now();
  // `shell` because npm is npm.cmd on Windows.
  const { status } = spawnSync('npm', args, { stdio: 'inherit', shell: true });
  results.push({ name, ok: status === 0, seconds: ((Date.now() - started) / 1000).toFixed(1) });
}

console.log('\n=== summary ===\n');
for (const { name, ok, seconds } of results) {
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name.padEnd(20)} ${seconds}s`);
}
const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? '\nAll checks passed.\n' : `\n${failed.length} failed: ${failed.map((r) => r.name).join(', ')}\n`);
process.exit(failed.length === 0 ? 0 : 1);
