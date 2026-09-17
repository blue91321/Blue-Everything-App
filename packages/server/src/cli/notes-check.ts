/**
 * The note text model, proved without a database or a browser.
 *
 *   npm run notes-check -w @everything/server
 *
 * This is the layer everything else stands on: the screen, the search index,
 * the PDF and the Word export all read the blocks this produces, so a mistake
 * here is a mistake in four places that look unrelated. It runs in memory for
 * the same reason `voice-check` does — the interesting parts are decisions
 * about text, and a database would only slow down asking about them.
 */
import {
  blocksToText,
  csvRow,
  derivedTitle,
  extractTags,
  extractWikiLinks,
  folderAncestors,
  inlineToText,
  noteKey,
  normaliseFolder,
  noteToText,
  parseBlocks,
  parseCsv,
  parseFrontMatter,
  parseInline,
  safeFileName,
  stringifyFrontMatter,
  type Block,
  type Inline,
} from '@everything/shared/notes';

let failures = 0;

/**
 * Two arguments means "this should be truthy"; three means "this should equal
 * that" — counted by *arity*, never by whether the third is undefined.
 *
 * Written the obvious way, with `expected?: unknown` and an
 * `expected === undefined` test, an assertion that something *is* undefined can
 * never pass however right the code is. A default parameter does not rescue it
 * either: passing `undefined` explicitly is exactly what triggers a default. The
 * count is the only honest signal, and it matters — this is the same shape of
 * vacuous check that let eight assertions in `integrations-check` pass while
 * comparing a string against a boolean.
 */
function check(what: string, actual: unknown, ...expected: unknown[]): void {
  const ok =
    expected.length === 0 ? Boolean(actual) : JSON.stringify(actual) === JSON.stringify(expected[0]);
  if (!ok) failures++;
  const detail = ok ? '' : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected[0])}`;
  console.log(`  ${ok ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${what}${detail}`);
}

/* ------------------------------------------------------------------ */

console.log('\nlink targets, matched the way people retype them');

check('the same note however it is capitalised', noteKey('Reading List'), noteKey('reading list'));
check('trailing punctuation is not part of the name', noteKey('Reading List!'), 'reading list');
check('runs of spaces collapse', noteKey('reading    list'), 'reading list');
// `C++` and `C` have to stay different notes, so inner punctuation is kept.
check('inner punctuation is kept', noteKey('C++') !== noteKey('C'), true);

/* ------------------------------------------------------------------ */

console.log('\nwiki-links');

const links = extractWikiLinks('see [[Reading List]] and [[projects/Home|the house]] and [[Notes#Later]]');
check('all three are found', links.length, 3);
check('a plain one', links[0], { target: 'Reading List', anchor: '', label: 'Reading List' });
check('a piped one keeps both halves', links[1], {
  target: 'projects/Home',
  anchor: '',
  label: 'the house',
});
check('an anchor survives', links[2], { target: 'Notes', anchor: '#Later', label: 'Notes' });

check('an empty link is not a link', extractWikiLinks('[[]] and [[  ]]').length, 0);
/*
 * An unclosed bracket must not run to the end of the note. Written greedily it
 * swallows everything after it as one enormous target, and the symptom is a
 * backlinks panel naming a note whose title is half your file.
 */
check('an unclosed bracket does not eat the note', extractWikiLinks('[[open and then\nmore text').length, 0);
check('the same link twice is counted twice', extractWikiLinks('[[a]] then [[a]]').length, 2);

/* ------------------------------------------------------------------ */

console.log('\ntags, and the four things that are not tags');

check('a plain tag', extractTags('buy milk #shopping'), ['shopping']);
check('nested tags stay whole', extractTags('#work/urgent'), ['work/urgent']);
check('several, deduplicated', extractTags('#a #b #a').sort(), ['a', 'b']);
check('one at the very start of the note', extractTags('#first thing'), ['first']);

// Each of these was going to be a bug.
check('a heading is not a tag', extractTags('# Shopping\nbuy milk'), []);
check('  ...even indented', extractTags('   ## Later'), []);
check('a fragment inside a word is not a tag', extractTags('see foo#bar'), []);
check('an issue number is not a tag', extractTags('fixes #123'), []);
check('a shell comment in a fence is not a tag', extractTags('```sh\n# install\nnpm i #dev\n```'), []);
check('  ...nor in an inline code span', extractTags('run `git commit -m #wip`'), []);
check('a tag after a fence still counts', extractTags('```\n# no\n```\nreal #yes'), ['yes']);

/* ------------------------------------------------------------------ */

console.log('\nfolders');

check('the root is the empty string, never null', normaliseFolder(null), '');
check('slashes are tidied', normaliseFolder('/a//b/'), 'a/b');
check('backslashes are folders too', normaliseFolder('a\\b'), 'a/b');
/*
 * `..` is dropped rather than resolved: this value becomes a zip entry name on
 * export, and the reader's own guard exists because the same trick coming the
 * other way writes outside the folder.
 */
check('a climbing segment is dropped', normaliseFolder('a/../../etc'), 'a/etc');
check('ancestors, for the tree', folderAncestors('a/b/c'), ['a', 'a/b', 'a/b/c']);
check('the root has no ancestors', folderAncestors(''), []);

console.log('\nfilenames Windows will actually accept');
check('illegal characters go', safeFileName('a/b:c?d'), 'a b c d');
check('a trailing dot goes', safeFileName('Notes...'), 'Notes');
check('a reserved device name is escaped', safeFileName('CON'), 'CON_');
check('  ...case-insensitively', safeFileName('nul'), 'nul_');
check('an empty title falls back', safeFileName('   '), 'note');
check('a very long title is cut', safeFileName('x'.repeat(400)).length, 120);

/* ------------------------------------------------------------------ */

console.log('\nfront matter');

const fm = parseFrontMatter('---\ntitle: Hello\ntags: [a, b]\naliases:\n  - one\n  - two\n---\n\nbody here');
check('a scalar', fm.data.title, 'Hello');
check('an inline list', fm.data.tags, ['a', 'b']);
check('a block list', fm.data.aliases, ['one', 'two']);
check('the body starts after it', fm.body, 'body here');

check('no front matter leaves the text alone', parseFrontMatter('# Hi').body, '# Hi');
/*
 * A `---` that is not front matter is a horizontal rule, and eating it would
 * silently remove the first section of somebody's note.
 */
check('a rule partway down is not front matter', parseFrontMatter('text\n\n---\n\nmore').data, {});

const roundTrip = parseFrontMatter(stringifyFrontMatter({ title: 'A: B', tags: ['x'] }) + 'body');
check('a colon in a value survives the round trip', roundTrip.data.title, 'A: B');
check('  ...and so does the list', roundTrip.data.tags, ['x']);
check('nothing to write means no block at all', stringifyFrontMatter({ title: '' }), '');

/* ------------------------------------------------------------------ */

console.log('\ninline Markdown');

const kinds = (text: string) => parseInline(text).map((node) => node.kind);

check('bold', kinds('a **b** c'), ['text', 'strong', 'text']);
check('italic', kinds('a *b* c'), ['text', 'em', 'text']);
check('strikethrough', kinds('a ~~b~~ c'), ['text', 'strike', 'text']);
check('a link', kinds('[x](https://e.com)'), ['link']);
check('an image', kinds('![alt](/p.png)'), ['image']);
check('an autolink', kinds('<https://e.com>'), ['link']);

/*
 * The emphasis rule everybody's Markdown gets wrong once, and notes about code
 * are full of underscores.
 */
check('snake_case is not emphasis', inlineToText(parseInline('snake_case_name')), 'snake_case_name');
check('  ...and comes back as one text node', kinds('snake_case_name'), ['text']);
check('_underscores_ at a word boundary still work', kinds('_hi_'), ['em']);

check('code is literal inside', inlineToText(parseInline('`a **b** c`')), 'a **b** c');
check('  ...and is one node', kinds('`a **b** c`'), ['code']);
check('a backslash escapes a delimiter', inlineToText(parseInline('\\*not bold\\*')), '*not bold*');
check('an image beats a link', kinds('![a](/b.png)'), ['image']);

check('a wiki-link is its own node', kinds('see [[Other]]'), ['text', 'wiki']);
check('an embed is a link rather than half an embed', kinds('![[Other]]'), ['wiki']);
check('a tag mid-sentence', kinds('buy milk #shopping'), ['text', 'tag']);
check('a fragment is not a tag', kinds('foo#bar'), ['text']);

/* ------------------------------------------------------------------ */

console.log('\nblocks');

const one = (markdown: string): Block => parseBlocks(markdown)[0];

check('a heading knows its level', one('### Three'), { kind: 'heading', level: 3, children: [{ kind: 'text', text: 'Three' }] });
check('a rule', one('---').kind, 'rule');
check('a quote holds blocks', one('> quoted').kind, 'quote');

const fenced = one('```js\nconst a = 1;\n```') as Extract<Block, { kind: 'code' }>;
check('a fence keeps its language', fenced.language, 'js');
check('  ...and its contents verbatim', fenced.text, 'const a = 1;');
/*
 * An unterminated fence runs to the end rather than being abandoned, which is
 * what every editor shows while you are still typing it.
 */
check('an unterminated fence still parses', (one('```\nstill code') as Extract<Block, { kind: 'code' }>).text, 'still code');

const list = one('- one\n- two\n  - nested') as Extract<Block, { kind: 'list' }>;
check('a bullet list', list.items.length, 3);
check('  ...with depth rather than nesting', list.items.map((item) => item.depth), [0, 0, 1]);
check('an ordered list is marked as one', (one('1. a\n2. b') as Extract<Block, { kind: 'list' }>).ordered, true);

const tasks = one('- [ ] todo\n- [x] done') as Extract<Block, { kind: 'list' }>;
check('checkboxes are read', tasks.items.map((item) => item.checked), [false, true]);
check('  ...and the box is not left in the text', inlineToText(tasks.items[1].children), 'done');
check('a plain bullet has no box', list.items[0].checked, null);

const table = one('| a | b |\n| --- | --- |\n| 1 | 2 |') as Extract<Block, { kind: 'table' }>;
check('a table header', table.header.map(inlineToText), ['a', 'b']);
check('  ...and its rows', table.rows.map((row) => row.map(inlineToText)), [['1', '2']]);
check('a paragraph of pipes is not a table', one('a | b').kind, 'paragraph');

check('a wrapped bullet stays one item', (one('- one\n  continued') as Extract<Block, { kind: 'list' }>).items.length, 1);

/*
 * The loop must consume a line it cannot classify, or a note containing one
 * hangs the process rather than rendering oddly.
 */
const weird = parseBlocks('|||\n\n> ok');
check('an unclassifiable line is still consumed', weird.length >= 1, true);

/* ------------------------------------------------------------------ */

console.log('\nplain text, which is what search reads');

check(
  'a heading loses its hashes',
  noteToText('# Shopping\n\nbuy milk'),
  'Shopping\nbuy milk'
);
check('a bullet keeps its shape', noteToText('- one\n- two'), '• one\n• two');
check('a table is tab-separated rather than pipes', noteToText('| a | b |\n| - | - |\n| 1 | 2 |'), 'a\tb\n1\t2');
check('code survives verbatim', noteToText('```\nx = 1\n```'), 'x = 1');
check('a wiki-link reads as its label', noteToText('see [[Home|the house]]'), 'see the house');

console.log('\nthe line a note is known by');
check('the first real line', derivedTitle('\n\n  Buy milk\nand eggs'), 'Buy milk');
check('a heading without its hash', derivedTitle('# Shopping\nbuy milk'), 'Shopping');
check('an empty note has none', derivedTitle('   \n  '), '');
check('a long first line is cut', derivedTitle('x'.repeat(200)).endsWith('…'), true);

/* ------------------------------------------------------------------ */

console.log('\nCSV, which is where a split(",") corrupts the rows hardest to notice');

check('a quoted comma stays in its field', parseCsv('a,"b,c",d')[0], ['a', 'b,c', 'd']);
check('a doubled quote is one quote', parseCsv('"say ""hi"""')[0], ['say "hi"']);
check('a newline inside a field', parseCsv('"one\ntwo",x')[0], ['one\ntwo', 'x']);
check('CRLF rows', parseCsv('a,b\r\nc,d').length, 2);
check('a byte-order mark is stripped', parseCsv('﻿a,b')[0][0], 'a');
check('blank rows are dropped', parseCsv('a,b\n\n\nc,d').length, 2);

check('writing quotes what it has to', csvRow(['a', 'b,c']), 'a,"b,c"');
check('  ...and doubles an embedded quote', csvRow(['say "hi"']), '"say ""hi"""');
check('  ...and leaves the simple case alone', csvRow(['a', 'b']), 'a,b');

const csvTrip = parseCsv([csvRow(['title', 'body']), csvRow(['A, B', 'line\nbreak "quoted"'])].join('\n'));
check('a round trip survives all three hazards', csvTrip[1], ['A, B', 'line\nbreak "quoted"']);

/* ------------------------------------------------------------------ */


/* ================================================================== */
/* Reading other people's notes apps                                   */
/* ================================================================== */

const { readImport } = await import('../notes/import.js');
const { htmlToMarkdown } = await import('../notes/html.js');
const { writeZip } = await import('../zip.js');
const { writeDocx } = await import('../notes/docx.js');
const { writePdf } = await import('../notes/pdf.js');

const utf8 = (text: string) => Buffer.from(text, 'utf8');
const zipOf = (files: Record<string, string>) =>
  writeZip(Object.entries(files).map(([name, text]) => ({ name, bytes: utf8(text) })));

console.log('\nHTML, which is what Evernote and Apple Notes are underneath');

check('a heading', htmlToMarkdown('<h2>Title</h2>'), '## Title');
check('bold and italic', htmlToMarkdown('<p><b>a</b> and <i>b</i></p>'), '**a** and *b*');
check('a list', htmlToMarkdown('<ul><li>one</li><li>two</li></ul>'), '- one\n- two');
check('a numbered list counts up', htmlToMarkdown('<ol><li>a</li><li>b</li><li>c</li></ol>'), '1. a\n2. b\n3. c');
check('a link', htmlToMarkdown('<a href="https://e.com">site</a>'), '[site](https://e.com)');
check('a bare URL is not doubled', htmlToMarkdown('<a href="https://e.com">https://e.com</a>'), 'https://e.com');
check('an image', htmlToMarkdown('<img src="/a.png" alt="cat">'), '![cat](/a.png)');
check('entities are decoded', htmlToMarkdown('<p>a &amp; b &mdash; c &#65;</p>'), 'a & b \u2014 c A');
check('a checked Evernote box', htmlToMarkdown('<en-todo checked="true"/>done'), '[x] done');
check('an unchecked one', htmlToMarkdown('<en-todo/>todo'), '[ ] todo');
check('a table becomes pipes', htmlToMarkdown('<table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table>'),
  '| a | b |\n| --- | --- |\n| 1 | 2 |');

/*
 * The one thing this must never do. A note is Markdown by the time it is
 * stored, so markup somebody else exported arrives inert rather than as
 * something a renderer has to be trusted to refuse later.
 */
check('a script tag is dropped entirely', htmlToMarkdown('<p>ok</p><script>alert(1)</script>'), 'ok');
check('  ...and no tag survives anywhere', /<[a-z]/i.test(htmlToMarkdown('<div onclick="x"><p>hi</p></div>')), false);

/* ------------------------------------------------------------------ */

console.log('\nObsidian, which is the one that has to round-trip');

const vault = readImport('vault.zip', zipOf({
  'Reading list.md': '---\ntags: [books, later]\n---\n\nSee [[Home]] for the shelf. #shopping',
  'work/2026/Standup.md': '# Standup\n\nTalked about [[Reading list]].',
  '.obsidian/app.json': '{}',
  'attachments/photo.png': 'not really a png',
}));

check('detected as a vault', vault.format, 'obsidian');
check('both notes, and neither the config', vault.notes.length, 2);
check('a nested folder survives', vault.notes.find((n) => n.title === 'Standup')?.folder, 'work/2026');
check('front-matter tags are kept', vault.notes[0].tags.includes('books'), true);
check('  ...alongside ones in the body', vault.notes[0].tags.includes('shopping'), true);
/*
 * Notion and Joplin both write the title twice — as the filename and again as
 * the first heading — and importing both leaves every note opening with its own
 * name.
 */
check('a leading heading is not repeated in the body', vault.notes.find((n) => n.title === 'Standup')?.body.startsWith('Talked'), true);
check('an attachment is named rather than dropped silently', vault.skipped.some((s) => s.name.includes('photo.png')), true);
check('a dotfolder is skipped without comment', vault.skipped.some((s) => s.name.includes('.obsidian')), false);

/* ------------------------------------------------------------------ */

console.log('\nNotion, told apart by the id it stamps on everything');

const notion = readImport('export.zip', zipOf({
  'Projects 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d/Roadmap 0f1e2d3c4b5a69788796a5b4c3d2e1f0.md':
    '# Roadmap\n\nShip it.',
  'Tasks 9f8e7d6c5b4a39281706a5b4c3d2e1f0.csv': 'Name,Status\nA,Done\n',
}));

check('detected as Notion', notion.format, 'notion');
check('the id is stripped from the title', notion.notes[0].title, 'Roadmap');
check('  ...and from the folder', notion.notes[0].folder, 'Projects');
/*
 * Notion writes a CSV per database *and* a Markdown file per row. Importing
 * both doubles every note.
 */
check('the database CSV is not imported twice', notion.notes.length, 1);

/* ------------------------------------------------------------------ */

console.log('\nEvernote');

const enex = readImport('notes.enex', utf8(
  '<?xml version="1.0"?><en-export>' +
  '<note><title>Recipe</title><content><![CDATA[<en-note><div>Mix <b>flour</b></div>' +
  '<ul><li>eggs</li></ul></en-note>]]></content>' +
  '<created>20260101T120000Z</created><tag>food</tag><tag>to try</tag></note>' +
  '<note><title>Second</title><content><![CDATA[<en-note>Plain</en-note>]]></content></note>' +
  '</en-export>'
));

check('detected as Evernote', enex.format, 'evernote');
check('both notes', enex.notes.length, 2);
check('the ENML became Markdown', enex.notes[0].body.includes('**flour**'), true);
check('  ...including its list', enex.notes[0].body.includes('- eggs'), true);
// A tag with a space would otherwise become one tag and a loose word.
check('a spaced tag is hyphenated', enex.notes[0].tags.includes('to-try'), true);
check('the compact timestamp is read', new Date(enex.notes[0].createdAt!).getUTCFullYear(), 2026);

/* ------------------------------------------------------------------ */

console.log('\nGoogle Keep');

const keepJson = JSON.stringify({
  title: 'Shopping',
  listContent: [{ text: 'milk', isChecked: true }, { text: 'eggs', isChecked: false }],
  labels: [{ name: 'to buy' }],
  isArchived: true,
  userEditedTimestampUsec: 1767225600000000,
});

const keep = readImport('Takeout.zip', zipOf({ 'Takeout/Keep/Shopping.json': keepJson }));
check('detected as Keep', keep.format, 'keep');
// The one import that gains structure rather than losing it.
check('a checklist becomes a task list', keep.notes[0].body, '- [x] milk\n- [ ] eggs');
check('a label becomes a tag', keep.notes[0].tags.includes('to-buy'), true);
check('archived is the nearest thing Keep has to a folder', keep.notes[0].folder, 'Archive');
check('microseconds are read as a real date', new Date(keep.notes[0].updatedAt!).getUTCFullYear(), 2026);
check('a single Keep file works too', readImport('note.json', utf8(keepJson)).format, 'keep');

/* ------------------------------------------------------------------ */

console.log('\nRoam and Logseq, which are outlines rather than documents');

const roam = readImport('roam.json', utf8(JSON.stringify([
  { title: 'Ideas', children: [{ string: 'one', children: [{ string: 'nested' }] }, { string: 'two' }] },
])));

check('detected as Roam', roam.format, 'roam');
check('nesting becomes indentation', roam.notes[0].body, '- one\n  - nested\n- two');

const logseq = readImport('graph.zip', zipOf({
  'pages/Home.md': 'title:: Home\ntags:: project, active\n\n- a bullet',
  'journals/2026_01_01.md': '- did things',
}));
check('detected as Logseq', logseq.format, 'logseq');
check('both pages and journals', logseq.notes.length, 2);
const home = logseq.notes.find((n) => n.title === 'Home')!;
check('`tags::` becomes real tags', home.tags.sort(), ['active', 'project']);
check('  ...and the property lines are gone', home.body.includes('::'), false);

/* ------------------------------------------------------------------ */

console.log('\nJoplin, Bear and Standard Notes');

// A .jex is a tar, so the fixture has to be one.
function tar(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = utf8(text);
    const header = Buffer.alloc(512);
    header.write(name, 0, 'utf8');
    header.write('0000644\0', 100);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('0', 156);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const joplin = readImport('notebook.jex', tar({
  'abc123.md': 'My note\n\nThe body.\n\nid: abc123\nparent_id: def\ntype_: 1\n',
}));
check('a .jex is read as a tar', joplin.format, 'joplin');
check('the first line is the title', joplin.notes[0].title, 'My note');
// Left in, every Joplin note ends with eight lines of machine data.
check('the metadata footer is stripped', joplin.notes[0].body, 'The body.');

const bear = readImport('note.bearnote', zipOf({
  'info.json': '{"net.shinyfrog.bear":{"version":1}}',
  'text.markdown': '# Bear note\n\nWith #tags',
}));
check('a textbundle is recognised', bear.format, 'bear');
check('  ...and its heading is the title', bear.notes[0].title, 'Bear note');

const standard = readImport('backup.txt', utf8(JSON.stringify({
  items: [
    { content_type: 'Note', content: { title: 'Kept', text: 'Body text' }, created_at: '2026-01-01T00:00:00Z' },
    { content_type: 'Tag', content: { title: 'not a note' } },
  ],
})));
// A Standard Notes backup is JSON wearing a `.txt` extension — the one case
// where the extension actively misleads.
check('a .txt that is really JSON is detected', standard.format, 'standard');
check('only the notes come through', standard.notes.length, 1);
check('  ...with their text', standard.notes[0].body, 'Body text');

/* ------------------------------------------------------------------ */

console.log('\nthe plain formats');

const csv = readImport('notes.csv', utf8('Title,Content,Folder,Tags\nFirst,"A body, with a comma",work,"a, b"\n'));
check('columns are found by name', csv.notes[0].title, 'First');
check('  ...so a quoted comma survives', csv.notes[0].body, 'A body, with a comma');
check('  ...and the folder column is used', csv.notes[0].folder, 'work');
check('  ...and the tags column', csv.notes[0].tags.sort(), ['a', 'b']);

// No recognisable header means the first row is data, not column names.
const headerless = readImport('list.csv', utf8('one thing\nanother thing\n'));
check('a headerless CSV is all data', headerless.notes.length, 2);

const md = readImport('Some note.md', utf8('Just text'));
check('a single Markdown file', md.format, 'markdown');
check('  ...named by its filename', md.notes[0].title, 'Some note');

const txt = readImport('thought.txt', utf8('A thought.\nAnd another.'));
check('a text file', txt.format, 'text');

const apple = readImport('Note.html', utf8('<html><head><title>From Apple</title></head><body><p>Hi</p></body></html>'));
check('HTML uses the page title over the filename', apple.notes[0].title, 'From Apple');

/* ------------------------------------------------------------------ */

console.log('\nWord, both directions');

const docx = writeDocx([{ title: 'Round trip', blocks: parseBlocks('# Heading\n\nSome **bold** text.\n\n- a\n- b') }]);
const backFromDocx = readImport('doc.docx', docx);
check('a .docx we wrote reads back', backFromDocx.format, 'docx');
check('  ...keeping its heading', backFromDocx.notes[0].body.includes('# Heading'), true);
check('  ...its text', backFromDocx.notes[0].body.includes('Some bold text.'), true);
check('  ...and its bullets', backFromDocx.notes[0].body.includes('- a'), true);

/*
 * A docx is a zip, so without a positive test for `word/document.xml` it would
 * be read as an Obsidian vault containing no notes at all.
 */
check('a .docx is not mistaken for a vault', backFromDocx.format !== 'obsidian', true);

console.log('\nPDF');
const pdf = writePdf([{ title: 'A note', blocks: parseBlocks('# Hi\n\nBody with "curly" quotes and an emoji \u{1f389}.') }]);
const pdfText = pdf.toString('latin1');
check('it is a PDF', pdfText.startsWith('%PDF-'), true);
check('  ...and ends properly', pdfText.trimEnd().endsWith('%%EOF'), true);
check('an emoji degrades to a question mark rather than breaking it', pdfText.includes('?'), true);

/*
 * Every cross-reference offset must land on its object. This is the failure
 * that produces a file rather than an error: no reader will open it, and
 * nothing about the bytes looks wrong.
 */
const xrefAt = Number(/startxref\s+(\d+)/.exec(pdfText)![1]);
const rows = pdfText.slice(xrefAt).split('\n').slice(2);
let badOffsets = 0;
for (let i = 0; i < rows.length; i++) {
  const m = /^(\d{10}) 00000 n/.exec(rows[i]);
  if (!m) break;
  if (!pdfText.slice(Number(m[1])).startsWith(`${i + 1} 0 obj`)) badOffsets++;
}
check('every xref offset lands on its object', badOffsets, 0);

/* ------------------------------------------------------------------ */

console.log('\ntimestamps, whatever unit an exporter chose');

const whenOf = (value: unknown) => {
  const one = readImport('x.json', utf8(JSON.stringify({ textContent: 'x', userEditedTimestampUsec: value })));
  return one.notes[0].updatedAt;
};
check('microseconds', new Date(whenOf(1767225600000000)!).getUTCFullYear(), 2026);
check('milliseconds', new Date(whenOf(1767225600000)!).getUTCFullYear(), 2026);
check('seconds', new Date(whenOf(1767225600)!).getUTCFullYear(), 2026);
// A unit guessed wrong by three orders of magnitude would file a note in 1970
// or in the year 55000, and a date nobody can explain is worse than none.
check('nonsense is dropped rather than dated', whenOf(42), undefined);

console.log(
  failures === 0 ? '\n\x1b[32mThe note text model holds.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`
);
process.exit(failures === 0 ? 0 : 1);
