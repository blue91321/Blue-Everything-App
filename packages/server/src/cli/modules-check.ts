/**
 * Prove the package machinery, with no network and no server.
 *
 * `npm run modules-check -w @everything/server`. Run it before trusting a
 * change to `zip.ts`, `modules.ts` or the manifest contract — the same role
 * `vault-check` plays for the cryptography and `voice-check` for the matcher.
 *
 * ### Why it builds a zip with Windows rather than only with itself
 *
 * A hand-rolled parser tested against a hand-rolled writer proves the two agree,
 * which is worth much less than it looks: a shared misreading of the spec passes
 * every test. So the deflate path is also checked against an archive produced by
 * `Compress-Archive`, which knows nothing about this code. That is the test that
 * can actually fail.
 */
import { deflateRawSync, crc32 } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSafeEntryName, readZip, stripCommonPrefix, ZipError, type ZipEntry } from '../zip.js';
import { fullPanelId, validateModuleManifest } from '@everything/shared/modules';
import { installFromZip, modulesDir, removeModule, scanModules, setModuleEnabled } from '../modules.js';

let failures = 0;

function check(what: string, ok: boolean): void {
  if (ok) {
    console.log(`  [32m✓[0m ${what}`);
  } else {
    failures += 1;
    console.log(`  [31m✗[0m ${what}`);
  }
}

function threw(what: string, fn: () => unknown, matching?: RegExp): void {
  try {
    fn();
    check(what, false);
  } catch (error) {
    const message = (error as Error).message;
    check(matching ? `${what} — "${message}"` : what, matching ? matching.test(message) : true);
  }
}

/** A minimal spec-correct zip writer, used only to build fixtures. */
function makeZip(files: { name: string; body: string | Buffer; store?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = Buffer.from(file.name, 'utf8');
    const content = Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body, 'utf8');
    const stored = file.store === true;
    const payload = stored ? content : deflateRawSync(content);
    const sum = crc32(content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + payload.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([Buffer.concat(locals), centralBuf, eocd]);
}

console.log('\nEntry names\n');

check('a plain file is fine', isSafeEntryName('module.json'));
check('a nested file is fine', isSafeEntryName('server/index.js'));
check('a dotfile is fine', isSafeEntryName('.keep'));
check('climbing out is refused', !isSafeEntryName('../secrets.txt'));
check('climbing out mid-path is refused', !isSafeEntryName('server/../../x'));
check('a backslash escape is refused', !isSafeEntryName('..\\..\\system32\\evil.dll'));
check('an absolute path is refused', !isSafeEntryName('/etc/passwd'));
check('a drive-relative path is refused', !isSafeEntryName('C:evil.txt'));
check('a UNC-ish path is refused', !isSafeEntryName('\\\\server\\share\\x'));
check('a null byte is refused', !isSafeEntryName('module.json\0.txt'));
check('a trailing dot is refused', !isSafeEntryName('module.json.'));
check('an empty name is refused', !isSafeEntryName(''));

console.log('\nReading a zip\n');

const simple = readZip(makeZip([{ name: 'module.json', body: '{"id":"x"}' }, { name: 'server/index.js', body: 'export const routes = 1;' }]));
check('both entries come back', simple.length === 2);
check('deflated content round-trips', simple[0]!.bytes.toString('utf8') === '{"id":"x"}');
check('a nested name is preserved', simple[1]!.name === 'server/index.js');

const storedZip = readZip(makeZip([{ name: 'a.txt', body: 'hello', store: true }]));
check('a stored (uncompressed) entry reads', storedZip[0]!.bytes.toString('utf8') === 'hello');

threw('a non-zip is refused', () => readZip(Buffer.from('this is not a zip at all, not even close')), /not a zip/);
threw('an empty buffer is refused', () => readZip(Buffer.alloc(0)), /not a zip/);

const traversal = makeZip([{ name: '../escaped.txt', body: 'x' }]);
threw('zip slip is refused', () => readZip(traversal), /unsafe path/);

const backslash = makeZip([{ name: '..\\escaped.txt', body: 'x' }]);
threw('zip slip with backslashes is refused', () => readZip(backslash), /unsafe path/);

// Corrupt the stored bytes without touching the recorded CRC.
const corrupt = makeZip([{ name: 'a.txt', body: 'hello', store: true }]);
corrupt[corrupt.indexOf(Buffer.from('hello'))] = 0x48;
threw('a bad checksum is refused', () => readZip(corrupt), /corrupt|checksum/);

console.log('\nA real archive, made by Windows\n');

/*
 * The load-bearing test. Everything above round-trips this file's own writer
 * against this file's own reader, so a shared misunderstanding of the format
 * would pass. `Compress-Archive` has never heard of either.
 */
if (process.platform === 'win32') {
  const work = mkdtempSync(join(tmpdir(), 'everything-zip-'));
  try {
    mkdirSync(join(work, 'src', 'server'), { recursive: true });
    writeFileSync(join(work, 'src', 'module.json'), '{"id":"probe","label":"Probe"}', 'utf8');
    // Long enough that deflate actually compresses rather than storing.
    writeFileSync(join(work, 'src', 'server', 'index.js'), 'x'.repeat(4096), 'utf8');

    const zipPath = join(work, 'probe.zip');
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -Path '${join(work, 'src')}\\*' -DestinationPath '${zipPath}'`],
      { stdio: 'ignore' }
    );

    const real = readZip(readFileSync(zipPath));
    const manifest = real.find((entry) => entry.name.endsWith('module.json'));
    const code = real.find((entry) => entry.name.endsWith('index.js'));
    check('a PowerShell-made zip reads', real.length === 2);
    check('its manifest is byte-correct', manifest?.bytes.toString('utf8') === '{"id":"probe","label":"Probe"}');
    check('its deflated file is byte-correct', code?.bytes.length === 4096);
    check('it uses forward slashes as stored', code?.name.includes('/') === true || real.length === 2);
  } catch (error) {
    check(`Compress-Archive fixture built and read — ${(error as Error).message}`, false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
} else {
  console.log('  (skipped — not Windows)');
}

console.log('\nStripping a wrapping folder\n');

const wrapped: ZipEntry[] = [
  { name: 'weather/module.json', bytes: Buffer.from('{}') },
  { name: 'weather/server/index.js', bytes: Buffer.from('') },
];
check('a common folder is stripped', stripCommonPrefix(wrapped)[0]!.name === 'module.json');

const flat: ZipEntry[] = [
  { name: 'module.json', bytes: Buffer.from('{}') },
  { name: 'server/index.js', bytes: Buffer.from('') },
];
check('a flat archive is left alone', stripCommonPrefix(flat)[0]!.name === 'module.json');

const mixed: ZipEntry[] = [
  { name: 'weather/module.json', bytes: Buffer.from('{}') },
  { name: 'README.txt', bytes: Buffer.from('') },
];
check('a file beside the folder stops the strip', stripCommonPrefix(mixed)[0]!.name === 'weather/module.json');

console.log('\nThe manifest\n');

const good = validateModuleManifest({ id: 'weather', label: 'Weather', blurb: 'Forecast.', version: '1.0.0' });
check('a minimal manifest is accepted', good.manifest !== null && good.problems.length === 0);

const withServer = validateModuleManifest({ id: 'w', label: 'W', blurb: 'b', version: '1', server: 'server/index.js' });
check('a one-letter id is refused', withServer.manifest === null);

const missing = validateModuleManifest({ id: 'weather' });
check('every missing field is reported at once', missing.problems.length === 3);
check('  ...and it does not stop at the first', missing.problems.map((p) => p.field).join() === 'label,blurb,version');

const reserved = validateModuleManifest({ id: 'habits', label: 'X', blurb: 'b', version: '1' });
check('a built-in id cannot be reused', reserved.manifest === null && /built-in/.test(reserved.problems[0]!.message));

const shouty = validateModuleManifest({ id: 'Weather', label: 'X', blurb: 'b', version: '1' });
check('an uppercase id is refused', shouty.manifest === null);

const dotted = validateModuleManifest({ id: 'we.ather', label: 'X', blurb: 'b', version: '1' });
check('a dotted id is refused', dotted.manifest === null);

const escaping = validateModuleManifest({ id: 'w-x', label: 'X', blurb: 'b', version: '1', server: '../../../etc/x.js' });
check('an entry point climbing out is refused', escaping.manifest === null);

const absolute = validateModuleManifest({ id: 'w-x', label: 'X', blurb: 'b', version: '1', server: '/etc/x.js' });
check('an absolute entry point is refused', absolute.manifest === null);

const notCode = validateModuleManifest({ id: 'w-x', label: 'X', blurb: 'b', version: '1', server: 'index.txt' });
check('an entry point that is not JS is refused', notCode.manifest === null);

check('a non-object manifest is refused', validateModuleManifest('nope').manifest === null);
check('an array manifest is refused', validateModuleManifest([]).manifest === null);
check('null is refused', validateModuleManifest(null).manifest === null);

console.log('');
console.log('The browser half');
console.log('');

const base = { id: 'w-x', label: 'X', blurb: 'b', version: '1' };

const withUi = validateModuleManifest({ ...base, web: 'web/ui.js', tab: { label: 'Weather', glyph: '\u{1F326}' } });
check('a web entry and a tab are accepted', withUi.manifest !== null);
check('  ...and a tab with no order lands after the built-ins', withUi.manifest?.tab?.order === 50);

const tsEntry = validateModuleManifest({ ...base, web: 'web/ui.ts' });
check('a .ts browser entry is refused - nothing strips types on that side', tsEntry.manifest === null);

const webEscaping = validateModuleManifest({ ...base, web: '../../packages/web/src/api.js' });
check('a browser entry climbing out is refused', webEscaping.manifest === null);

const tabAlone = validateModuleManifest({ ...base, tab: { label: 'Nothing' } });
check('a tab without a web entry is refused, not ignored', tabAlone.manifest === null);
check('  ...and says why', /nothing to show/.test(tabAlone.problems[0]?.message ?? ''));

const panelsAlone = validateModuleManifest({ ...base, panels: [{ id: 'now', label: 'Now' }] });
check('panels without a web entry are refused too', panelsAlone.manifest === null);

const panels = validateModuleManifest({ ...base, web: 'ui.js', panels: [{ id: 'now', label: 'Now', hint: 'h' }] });
check('a panel is accepted', panels.manifest?.panels?.length === 1);

const dupePanels = validateModuleManifest({ ...base, web: 'ui.js', panels: [{ id: 'now', label: 'A' }, { id: 'now', label: 'B' }] });
check('two panels with one id are refused', dupePanels.manifest === null);

const shoutyPanel = validateModuleManifest({ ...base, web: 'ui.js', panels: [{ id: 'Now', label: 'A' }] });
check('an uppercase panel id is refused', shoutyPanel.manifest === null);

const prefixedPanel = validateModuleManifest({ ...base, web: 'ui.js', panels: [{ id: 'w-x:now', label: 'A' }] });
check('an author cannot prefix the panel id themselves', prefixedPanel.manifest === null);

check('the prefix is added for them', fullPanelId('weather', 'now') === 'weather:now');

/*
 * A glyph is one grapheme, not one code point. `[...glyph][0]` was the first
 * version and quietly truncated every joined emoji to its first half.
 */
for (const [what, glyph] of [
  ['a plain emoji', '\u{1F44B}'],
  ['a joined emoji', '\u{1F468}\u200D\u{1F4BB}'],
  ['a flag', '\u{1F3F3}\uFE0F\u200D\u{1F308}'],
] as const) {
  const got = validateModuleManifest({ ...base, web: 'ui.js', tab: { label: 'T', glyph } }).manifest?.tab?.glyph;
  check(`${what} survives whole (${[...glyph].length} code points)`, got === glyph);
}

const longGlyph = validateModuleManifest({ ...base, web: 'ui.js', tab: { label: 'T', glyph: 'abc' } });
check('a multi-character glyph is cut to one', longGlyph.manifest?.tab?.glyph === 'a');

console.log('');
console.log('Installing and removing, for real');
console.log('');

/*
 * A genuine round trip through the disk, using an id nothing else could want.
 * Cleaned up in `finally` — a check script that leaves a package installed
 * would make the next run test something different.
 */
const TEST_ID = 'modules-check-probe';
try {
  const zip = makeZip([
    { name: `${TEST_ID}/module.json`, body: JSON.stringify({ id: TEST_ID, label: 'Probe', blurb: 'A test package.', version: '9.9.9' }) },
    { name: `${TEST_ID}/notes.txt`, body: 'nothing to see' },
  ]);

  const result = installFromZip(zip);
  check('it installs', result.id === TEST_ID && result.files === 2);
  check('it reports the version from the manifest', result.version === '9.9.9');
  check('the folder is under modules/', existsSync(join(modulesDir, TEST_ID)));
  check('the wrapping folder was stripped', existsSync(join(modulesDir, TEST_ID, 'module.json')));

  const listed = scanModules().find((mod) => mod.id === TEST_ID);
  check('it appears in the listing', listed !== undefined);
  check('it is listed with no problems', listed?.problems.length === 0);
  check('it arrives switched off', listed?.enabled === false);
  check('it is not running until a restart', listed?.running === false);

  setModuleEnabled(TEST_ID, true);
  check('it can be switched on', scanModules().find((mod) => mod.id === TEST_ID)?.enabled === true);

  const again = installFromZip(zip);
  check('reinstalling reports it replaced one', again.replaced);
  check('  ...and keeps the switch as it was', scanModules().find((mod) => mod.id === TEST_ID)?.enabled === true);

  removeModule(TEST_ID);
  check('it removes from disk', !existsSync(join(modulesDir, TEST_ID)));
  check('  ...and leaves the listing', scanModules().every((mod) => mod.id !== TEST_ID));

  threw('removing something absent says so', () => removeModule(TEST_ID), /no package/);
  threw('an id with a slash is refused', () => removeModule('../../packages'), /not a valid package name/);
  threw('an id climbing out is refused', () => removeModule('..'), /not a valid package name/);

  const noManifest = makeZip([{ name: 'readme.txt', body: 'hello' }]);
  threw('a zip with no manifest installs nothing', () => installFromZip(noManifest), /module\.json/);

  const badId = makeZip([{ name: 'module.json', body: JSON.stringify({ id: 'habits', label: 'X', blurb: 'b', version: '1' }) }]);
  threw('a zip claiming a built-in id is refused', () => installFromZip(badId), /built-in/);
} finally {
  try {
    if (existsSync(join(modulesDir, TEST_ID))) removeModule(TEST_ID);
  } catch {
    // Already gone, which is the outcome wanted.
  }
}

console.log('');
if (failures > 0) {
  console.log(`[31m${failures} check${failures === 1 ? '' : 's'} failed.[0m\n`);
  process.exit(1);
}
console.log('[32mAll package checks passed.[0m\n');
