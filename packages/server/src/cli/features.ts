/**
 * What this install runs, and how to change it.
 *
 *   npm run features                        # show me
 *   npm run features -- --set voice=off     # write features.json
 *   npm run features -- --set vault=off,voice=off
 *
 * Reports two things separately for each feature, because they fail
 * differently: whether it is switched **on**, and whether it is **installed**.
 * A feature that is on but absent is the interesting case — somebody deleted a
 * folder without telling the config, and the app is quietly smaller than it
 * says it is.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { FEATURE_LIST, isFeatureId, resolveFeatures } from '@everything/shared/features';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const featuresPath = resolve(repoRoot, 'features.json');

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

function readFile(): Record<string, boolean> {
  if (!existsSync(featuresPath)) return {};
  const parsed = JSON.parse(readFileSync(featuresPath, 'utf8')) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(parsed).filter(([, v]) => typeof v === 'boolean')
  ) as Record<string, boolean>;
}

/* ---------------- --set ---------------- */

const setIndex = process.argv.indexOf('--set');
if (setIndex !== -1) {
  const spec = process.argv[setIndex + 1];
  if (!spec) {
    console.error('--set needs something like  voice=off  or  vault=off,voice=on');
    process.exit(1);
  }

  const current = readFile();
  // Start from the resolved set rather than the file, so writing one value does
  // not silently flip everything the file happened not to mention.
  const base = Object.fromEntries(FEATURE_LIST.map((f) => [f.id, resolveFeatures(current).enabled.has(f.id)]));

  for (const pair of spec.split(',')) {
    const [id, value] = pair.split('=').map((s) => s.trim());
    if (!isFeatureId(id)) {
      console.error(`"${id}" is not a feature. Try one of: ${FEATURE_LIST.map((f) => f.id).join(', ')}`);
      process.exit(1);
    }
    if (value !== 'on' && value !== 'off') {
      console.error(`"${id}=${value ?? ''}" — the value has to be on or off`);
      process.exit(1);
    }
    base[id] = value === 'on';
  }

  writeFileSync(featuresPath, `${JSON.stringify(base, null, 2)}\n`, 'utf8');
  console.log(`\nWrote ${featuresPath}`);
  console.log(dim('Restart the server and the agent for it to take effect.\n'));
}

/* ---------------- the report ---------------- */

const file = readFile();
const { enabled, notes } = resolveFeatures(file);

console.log(
  existsSync(featuresPath)
    ? `\nFrom ${dim('features.json')}:\n`
    : `\nNo ${dim('features.json')} — using defaults. Copy ${dim('features.example.json')} to change that.\n`
);

for (const spec of FEATURE_LIST) {
  const on = enabled.has(spec.id);
  // A feature with no folders of its own is never "missing" — there is nothing
  // to delete. Saying "installed" about it would be meaningless either way.
  const present = spec.owns.length === 0 || spec.owns.some((p) => existsSync(resolve(repoRoot, p)));
  const partial =
    spec.owns.length > 0 && present && !spec.owns.every((p) => existsSync(resolve(repoRoot, p)));

  const state = !on ? dim('off') : present ? green('on') : red('on, but not installed');

  console.log(`  ${spec.label.padEnd(20)} ${state}`);
  console.log(`  ${' '.repeat(20)} ${dim(spec.blurb)}`);
  if (spec.cost) console.log(`  ${' '.repeat(20)} ${yellow(`costs: ${spec.cost}`)}`);

  if (on && !present) {
    console.log(`  ${' '.repeat(20)} ${red('its folders are gone — switch it off, or restore them')}`);
  }
  if (partial) {
    console.log(`  ${' '.repeat(20)} ${yellow('some of its folders are missing, not all')}`);
  }
  if (spec.owns.length > 0) {
    console.log(`  ${' '.repeat(20)} ${dim(`${spec.removable ? 'delete' : 'owns'}: ${spec.owns.join('  ')}`)}`);
  }
  if (!spec.removable) {
    console.log(`  ${' '.repeat(20)} ${dim('can be switched off, but not deleted — the Dashboard uses it')}`);
  }
  console.log('');
}

for (const note of notes) console.log(yellow(`  ! ${note}`));

console.log(dim('  npm run features -- --set voice=off      switch something off'));
console.log(dim('  npm run features-check -w @everything/server   prove it still boots without them\n'));
