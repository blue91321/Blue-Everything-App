/**
 * Checks the export reader against the shapes real browsers produce.
 *
 * CSV is where an importer corrupts data quietly: a comma inside a note or a
 * quote inside a password shifts every following column, and the entries that
 * break are exactly the ones you would never think to verify.
 *
 *   npm run import-check -w @everything/server
 */
import { isDuplicate, parseCsv, readExport } from '../vault/import.js';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  \x1b[32mPASS\x1b[0m' : '  \x1b[31mFAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log('\nCSV reading');
check('splits plain rows', parseCsv('a,b\n1,2\n').length === 2);
check('keeps commas inside quotes', parseCsv('a,b\n"one, two",3\n')[1][0] === 'one, two');
check('handles doubled quotes', parseCsv('a\n"he said ""hi"""\n')[1][0] === 'he said "hi"');
check('handles newlines inside a field', parseCsv('a,b\n"line one\nline two",x\n')[1][0] === 'line one\nline two');
check('handles CRLF', parseCsv('a,b\r\n1,2\r\n')[1][1] === '2');
check('strips a BOM from the first header', parseCsv('﻿name,url\nx,y\n')[0][0] === 'name');
check('drops blank lines', parseCsv('a,b\n1,2\n\n\n').length === 2);
check('keeps empty fields in place', parseCsv('a,b,c\n1,,3\n')[1].join('|') === '1||3');

console.log('\nChrome / Brave / Edge');
{
  const csv = [
    'name,url,username,password,note',
    'GitHub,https://github.com/,blake,hunter2,',
    'Bank,https://bank.example/,blake@example.com,"p,a""ss",some note',
    'No password,https://nowhere.example/,someone,,',
  ].join('\n');
  const result = readExport(csv);
  check('detects the format', result.format === 'Chrome, Brave or Edge', result.format);
  check('reads both usable rows', result.entries.length === 2);
  check('skips the row without a password', result.skipped === 1);
  check('survives a comma and a quote in the password', result.entries[1].password === 'p,a"ss', result.entries[1].password);
  check('keeps the note', result.entries[1].notes === 'some note');
  check('keeps the title', result.entries[0].title === 'GitHub');
}

console.log('\nFirefox');
{
  const csv = [
    '"url","username","password","httpRealm","formActionOrigin","guid","timeCreated"',
    '"https://example.org","blake","secret",,"https://example.org","{abc}","1700000000"',
  ].join('\n');
  const result = readExport(csv);
  check('detects the format', result.format === 'Firefox', result.format);
  check('reads the entry', result.entries[0].password === 'secret');
  // Firefox exports carry no title column at all.
  check('falls back to the site name for a title', result.entries[0].title === 'example.org', result.entries[0].title);
}

console.log('\nBitwarden');
{
  const csv = [
    'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp',
    ',,login,Reddit,,,0,https://reddit.com,blake,pw123,JBSWY3DPEHPK3PXP',
  ].join('\n');
  const result = readExport(csv);
  check('detects the format', result.format === 'Bitwarden', result.format);
  check('reads the login', result.entries[0].username === 'blake' && result.entries[0].password === 'pw123');
  check('carries the TOTP secret across', result.entries[0].totp === 'JBSWY3DPEHPK3PXP');
}

console.log('\nunknown layouts');
{
  const result = readExport('Site,User ID,Secret Password\nexample.net,blake,abc123\n');
  check('guesses columns by name', result.entries[0].password === 'abc123', result.format);
  check('and finds the username', result.entries[0].username === 'blake');
}

let refused = false;
try {
  readExport('one,two\nthree,four\n');
} catch {
  refused = true;
}
check('refuses a file with no password column', refused);

let refusedEmpty = false;
try {
  readExport('name,url,username,password\n');
} catch {
  refusedEmpty = true;
}
check('refuses a header-only file', refusedEmpty);

console.log('\nduplicate detection');
const base = { title: '', username: 'blake', password: 'x', url: 'https://example.com/login', notes: '', totp: '' };
check('same host and user is a duplicate', isDuplicate(base, { ...base, url: 'https://www.example.com/' }));
check('different user is not', !isDuplicate(base, { ...base, username: 'someone-else' }));
check('different host is not', !isDuplicate(base, { ...base, url: 'https://other.example/' }));
check('case in the username is ignored', isDuplicate(base, { ...base, username: 'BLAKE' }));

console.log(failures === 0 ? '\n\x1b[32mImport reader sound.\x1b[0m\n' : `\n\x1b[31m${failures} failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
