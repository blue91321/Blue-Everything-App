/**
 * Prove the Code screen's rules, with no network and nothing changed in the
 * real checkout.
 *
 *   npm run code-check -w @everything/server
 *
 * The rules worth a suite are the ones that decide what can be read and
 * written: only files the repository ships, never a secret, never a path that
 * climbs out; a save that keeps a file's line ends and byte-order mark, and
 * refuses to write over a change made meanwhile. Saving is tried in a
 * throwaway folder.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from '../../../../server/src/paths.js';
import { diffLines, languageOf, tokenize } from '../../web/highlight.js';
import {
  CodeError,
  encode,
  decode,
  isSecret,
  knownPath,
  listing,
  openFile,
  parseStatus,
  partsOf,
  readOnlyReason,
  saveFile,
  syntaxProblem,
  versionOf,
} from '../files.js';

let failures = 0;
function check(what: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  \x1b[32m✓\x1b[0m' : '  \x1b[31m✗\x1b[0m'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function refused(path: string): Promise<boolean> {
  try {
    await knownPath(repoRoot, path);
    return false;
  } catch (error) {
    return error instanceof CodeError;
  }
}

console.log('\nWhat is offered');
for (const secret of [
  '.env',
  'packages/server/.env',
  'packages/server/.env.local',
  'packages/server/data/everything.db',
  'packages/server/data/manga.json',
  'packages/agent/agent.config.json',
  'features.json',
  'modules.json',
  'modules/someone/server/index.js',
  'instances/sam/instance.json',
  'logs/server.log',
  'backups/x.zip',
  'runtime/node/node.exe',
  'node_modules/zod/package.json',
  'instances/sam/host-key',
]) {
  check(`refuses ${secret}`, isSecret(secret));
}
check('offers .env.example, which is an example', !isSecret('packages/server/.env.example'));
check('offers the shipped packages, whose folder is called modules', !isSecret('packages/modules/manga/server/index.ts'));

const list = await listing(repoRoot);
check('the checkout lists its files', list.files.length > 100, `${list.files.length} from ${list.source}`);
check('every listed file passes the secret rule', list.files.every((f) => !isSecret(f)));
check('the listing includes this file', list.files.includes('packages/modules/code/server/cli/check.ts'));
check('no listed file is in data/', !list.files.some((f) => /(^|\/)data\//.test(f)));
for (const path of ['../outside.txt', 'packages/../../outside.txt', 'C:/Windows/win.ini', '/etc/passwd', '.env', 'packages\\server\\.env', '']) {
  check(`a request for ${JSON.stringify(path)} is refused`, await refused(path));
}
check('a listed file is accepted', (await knownPath(repoRoot, 'package.json')) === 'package.json');
check('a backslash spelling of a listed file is accepted as the same file', (await knownPath(repoRoot, 'packages\\web\\package.json')) === 'packages/web/package.json');
check('migrations are read only', readOnlyReason('packages/server/drizzle/0001_stiff_speedball.sql') !== null);
check('the lockfile is read only', readOnlyReason('package-lock.json') !== null);
check('an ordinary file is not', readOnlyReason('packages/web/src/App.tsx') === null);

console.log('\ngit status');
const status = parseStatus(' M a.ts\0?? new.ts\0A  added.ts\0R  moved.ts\0old.ts\0 D gone.ts\0');
check('a modified file is changed', status.get('a.ts') === 'changed');
check('an untracked file is new', status.get('new.ts') === 'new');
check('an added file is new', status.get('added.ts') === 'new');
check('a rename is the new name, and the old one is not read as a file', status.get('moved.ts') === 'changed' && !status.has('old.ts'));
check('a deleted file is not listed', !status.has('gone.ts'));

console.log('\nReading and writing');
const scratch = mkdtempSync(join(tmpdir(), 'code-check-'));
try {
  const crlf = Buffer.from('one\r\ntwo\r\n');
  writeFileSync(join(scratch, 'crlf.ts'), crlf);
  const opened = openFile(scratch, 'crlf.ts');
  check('a CRLF file opens with plain line ends', opened.text === 'one\ntwo\n');
  const saved = await saveFile(scratch, 'crlf.ts', 'one\ntwo\nthree\n', opened.version);
  check('saving it keeps CRLF', saved.saved && readFileSync(join(scratch, 'crlf.ts'), 'utf8') === 'one\r\ntwo\r\nthree\r\n');

  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}\n')]);
  writeFileSync(join(scratch, 'bom.json'), bom);
  const bomOpened = openFile(scratch, 'bom.json');
  check('a byte-order mark is not shown', bomOpened.text === '{"a":1}\n');
  await saveFile(scratch, 'bom.json', '{"a":2}\n', bomOpened.version);
  check('and is kept on save', readFileSync(join(scratch, 'bom.json')).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));
  check('a PowerShell script always gets one', encode('x.ps1', 'Write-Host "—"', null).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));
  check('a plain file does not', encode('x.ts', 'x', Buffer.from('y'))[0] === 0x78);
  check('decode and encode round-trip a CRLF file', encode('x.ts', decode(crlf), crlf).equals(crlf));

  writeFileSync(join(scratch, 'race.ts'), 'first\n');
  const raced = openFile(scratch, 'race.ts');
  writeFileSync(join(scratch, 'race.ts'), 'changed elsewhere\n');
  const conflict = await saveFile(scratch, 'race.ts', 'mine\n', raced.version);
  check('a file changed since it was opened is not written over', !conflict.saved && readFileSync(join(scratch, 'race.ts'), 'utf8') === 'changed elsewhere\n');
  check('and the answer carries the version on disk, to save over it on purpose', conflict.version === versionOf(Buffer.from('changed elsewhere\n')));

  writeFileSync(join(scratch, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  const picture = openFile(scratch, 'pic.png');
  check('a picture opens as not text', picture.text === null && picture.readOnly !== null);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log('\nWhat would stop a file working');
const missing = await syntaxProblem('x.ts', 'export function a() {\n  return 1;\n');
check('a missing brace is found', missing !== null, missing ? `line ${missing.line}: ${missing.message}` : '');
const tsx = await syntaxProblem('x.tsx', 'export const A = () => <div className="a">hi</div>;\n');
check('a working .tsx is fine', tsx === null, tsx?.message);
check('types are not a syntax problem', (await syntaxProblem('x.ts', 'const a: number = "nope";\n')) === null);
const badJson = await syntaxProblem('x.json', '{\n  "a": 1,\n}\n');
check('a trailing comma in JSON is found', badJson !== null && badJson.line >= 2, badJson ? `line ${badJson.line}` : '');
check('CSS is not checked', (await syntaxProblem('x.css', '.a { color: ')) === null);

console.log('\nColouring');
const samples: Array<[string, string]> = [
  ['a.ts', "import { a } from 'b';\n/* two\nlines */ const x = `t${1}` + 0x1f; // end\nfunction f<T>(y: T) { return <div>{y}</div>; }\n"],
  ['a.css', '.a { color: #fff; --x: 1px; } @media (max-width: 3px) {}\n'],
  ['a.json', '{"a": [1, true, null, "s"]}'],
  ['a.md', '# Head\n\nSome `code` and **bold**, [[link]].\n\n```\nfenced\n```\n'],
  ['a.ps1', "<# block #>\n$x = Get-Item 'a' # note\nif ($x -eq 1) { }\n"],
  ['a.sql', "CREATE TABLE `t` (a integer DEFAULT 'x'); -- c\n"],
  ['a.txt', 'plain'],
];
for (const [path, text] of samples) {
  const tokens = tokenize(text, languageOf(path));
  check(`${path} colours back to exactly its text`, tokens.map(([, part]) => part).join('') === text);
}
const block = tokenize('/* one\ntwo */ x', 'ts');
check('a comment over two lines is one comment', block[0]?.[0] === 'comment' && block[0][1] === '/* one\ntwo */');
const arrow = tokenize('const f = () => 1;', 'ts');
check('an arrow is not drawn as a tag', !arrow.some(([kind, part]) => kind === 'tag' && part.includes('>')));
check('a generic is not drawn as a tag', !tokenize('useState<number>(0)', 'ts').some(([kind]) => kind === 'tag'));
check('an element still is', tokenize('return (<div>', 'tsx').some(([kind, part]) => kind === 'tag' && part === '<div'));

console.log('\nWhat changed');
const diff = diffLines('a\nb\nc\nd\n', 'a\nB\nc\nd\ne\n');
check('a changed line is a removal and an addition', diff.some(([k, t]) => k === 'removed' && t === 'b') && diff.some(([k, t]) => k === 'added' && t === 'B'));
check('an added line is found', diff.some(([k, t]) => k === 'added' && t === 'e'));
check('numbers are the new file’s', diff.find(([k, t]) => k === 'added' && t === 'e')?.[2] === 5);
check('no change is no diff', diffLines('x\ny', 'x\ny').length === 0);

console.log('\nThe map');
const parts = partsOf(repoRoot, list.files);
check('every package has a part', ['packages/web', 'packages/server', 'packages/modules/manga', 'packages/modules/code'].every((f) => parts.some((p) => p.folder === f)));
check('the core parts have plain names', parts.find((p) => p.folder === 'packages/server')?.title === 'The server');
check('each part says what it is', parts.every((p) => p.summary.length > 20), parts.filter((p) => p.summary.length <= 20).map((p) => p.folder).join(', '));

console.log(failures === 0 ? '\nAll good.\n' : `\n${failures} failed.\n`);
process.exit(failures === 0 ? 0 : 1);
