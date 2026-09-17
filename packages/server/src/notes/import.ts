/**
 * Reading somebody else's notes app.
 *
 * ### Two phases, because a wrong guess is expensive
 *
 * The first call reports what it found and writes **nothing**; only `commit`
 * puts rows in the database. That is the shape the vault's password import
 * already uses, for the same reason: a mis-detected layout produces a plausible
 * number of plausible-looking notes, and finding that out afterwards means
 * deleting a thousand rows by hand.
 *
 * ### The format is detected, not chosen
 *
 * A dropdown of fourteen formats asks somebody to know what their own export
 * is, which is exactly the thing they are least sure about — a Bear export and
 * a Joplin export are both "a zip with Markdown in it" from outside. Every
 * detector here is a *positive* test for something that format has and the
 * others do not, and the answer is shown on the preview so a wrong guess is
 * visible before anything is written.
 *
 * ### Everything becomes Markdown
 *
 * Whatever the source, a note arrives as Markdown with tags in the body and a
 * folder path. That is the one shape the rest of the app knows, and converting
 * on the way in means the editor, the search, the graph and the exporters never
 * learn that Evernote exists.
 */
import { htmlToMarkdown, textToMarkdown } from './html.js';
import { readZip, stripCommonPrefix, type ZipEntry } from '../zip.js';
import {
  derivedTitle,
  extractTags,
  normaliseFolder,
  parseCsv,
  parseFrontMatter,
} from '@everything/shared/notes';

export interface ImportedNote {
  title: string;
  /** Markdown, whatever it started as. */
  body: string;
  folder: string;
  tags: string[];
  createdAt?: number;
  updatedAt?: number;
}

export interface ImportPreview {
  format: string;
  formatLabel: string;
  notes: ImportedNote[];
  /** Named rather than counted: "12 skipped" is not something you can act on. */
  skipped: { name: string; why: string }[];
}

/** What the screen offers, and what each one is called when detected. */
export const IMPORT_FORMATS: { id: string; label: string; hint: string }[] = [
  { id: 'obsidian', label: 'Obsidian vault', hint: 'A .zip of the vault folder' },
  { id: 'notion', label: 'Notion', hint: 'Export as Markdown & CSV, then the .zip' },
  { id: 'evernote', label: 'Evernote', hint: 'An .enex file' },
  { id: 'keep', label: 'Google Keep', hint: 'The Takeout .zip, or one .json' },
  { id: 'roam', label: 'Roam Research', hint: 'Export all as JSON' },
  { id: 'logseq', label: 'Logseq', hint: 'A .zip of the graph folder' },
  { id: 'joplin', label: 'Joplin', hint: 'A .jex file, or a Markdown export .zip' },
  { id: 'bear', label: 'Bear', hint: 'A .bearnote or .textbundle' },
  { id: 'standard', label: 'Standard Notes', hint: 'A .txt or .json backup' },
  { id: 'apple', label: 'Apple Notes', hint: 'Notes exported as HTML' },
  { id: 'markdown', label: 'Markdown', hint: '.md, or a .zip of them' },
  { id: 'docx', label: 'Word', hint: 'A .docx file' },
  { id: 'csv', label: 'CSV', hint: 'A title/body table' },
  { id: 'text', label: 'Plain text', hint: 'One .txt per note' },
];

const LABELS = new Map(IMPORT_FORMATS.map((format) => [format.id, format.label]));

/* ------------------------------------------------------------------ */
/* Entry point                                                          */
/* ------------------------------------------------------------------ */

export function readImport(fileName: string, bytes: Buffer): ImportPreview {
  const name = fileName.toLowerCase();
  const skipped: { name: string; why: string }[] = [];

  if (name.endsWith('.enex')) return done('evernote', readEnex(bytes.toString('utf8')), skipped);
  if (name.endsWith('.jex')) return done('joplin', readJoplinArchive(bytes, skipped), skipped);

  if (name.endsWith('.json')) {
    const detected = readJson(bytes.toString('utf8'), skipped);
    if (detected) return done(detected.format, detected.notes, skipped);
    throw new ImportRefused('that JSON is not a notes export this can read');
  }

  if (isZip(bytes)) return readArchive(bytes, skipped);

  const text = bytes.toString('utf8');
  if (name.endsWith('.csv')) return done('csv', readCsvNotes(text), skipped);
  if (name.endsWith('.html') || name.endsWith('.htm')) {
    return done('apple', [noteFromHtml(baseName(fileName), text, '')], skipped);
  }
  if (name.endsWith('.md') || name.endsWith('.markdown')) {
    return done('markdown', [noteFromMarkdown(baseName(fileName), text, '')], skipped);
  }

  /*
   * A `.txt` from Standard Notes is JSON wearing a text extension, which is the
   * one case where the extension is actively misleading — so the contents get a
   * look before falling back to treating it as prose.
   */
  const asJson = text.trimStart().startsWith('{') ? readJson(text, skipped) : null;
  if (asJson) return done(asJson.format, asJson.notes, skipped);

  return done('text', [noteFromText(baseName(fileName), text, '')], skipped);
}

export class ImportRefused extends Error {}

function done(format: string, notes: ImportedNote[], skipped: ImportPreview['skipped']): ImportPreview {
  if (notes.length === 0 && skipped.length === 0) {
    throw new ImportRefused('nothing in that file looked like a note');
  }
  return { format, formatLabel: LABELS.get(format) ?? format, notes, skipped };
}

const isZip = (bytes: Buffer) => bytes.length > 4 && bytes.readUInt32LE(0) === 0x04034b50;
const baseName = (path: string) => path.replace(/\\/g, '/').split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'note';

/* ------------------------------------------------------------------ */
/* Archives                                                             */
/* ------------------------------------------------------------------ */

/**
 * A zip, whose format is decided by what is inside rather than by its name.
 *
 * The order is deliberate: every test below is for something only that format
 * has, and the general "a zip with Markdown in it" case is last because four of
 * the others also match it.
 */
function readArchive(bytes: Buffer, skipped: ImportPreview['skipped']): ImportPreview {
  /*
   * Raised from the package-install defaults, which bound a *downloaded* zip of
   * code. A decade of notes is genuinely tens of thousands of small files, and
   * the bomb these guard against is still bounded — by the total, which is the
   * number that matters.
   */
  const entries = stripCommonPrefix(
    readZip(bytes, { maxEntries: 50_000, maxFileBytes: 64 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024 })
  );
  const names = entries.map((entry) => entry.name);

  // Word, which is a zip and would otherwise be read as an empty vault.
  if (names.includes('word/document.xml')) {
    const doc = entries.find((entry) => entry.name === 'word/document.xml')!;
    return done('docx', [noteFromDocx('Imported document', doc.bytes.toString('utf8'))], skipped);
  }

  // A Bear textbundle: its manifest plus exactly one Markdown file.
  if (names.some((name) => name === 'info.json') && names.some((name) => /^text\.(markdown|md)$/.test(name))) {
    const text = entries.find((entry) => /^text\.(markdown|md)$/.test(entry.name))!;
    return done('bear', [noteFromMarkdown('Imported note', text.bytes.toString('utf8'), '')], skipped);
  }

  // Keep's Takeout puts one JSON per note under a Keep folder.
  if (names.some((name) => /(^|\/)keep\//i.test(name)) || names.some((name) => name.endsWith('.json') && looksLikeKeep(entries, name))) {
    return done('keep', readKeepArchive(entries, skipped), skipped);
  }

  // Logseq keeps its graph in these two folders, which nothing else does.
  if (names.some((name) => /^(pages|journals)\//.test(name))) {
    return done('logseq', readMarkdownArchive(entries, skipped, { logseq: true }), skipped);
  }

  /*
   * Notion suffixes every file and folder with the page's 32-character id. That
   * is the one thing no other exporter does, and it is what lets a Notion
   * export be told apart from an Obsidian vault.
   */
  if (names.filter((name) => /[ -][0-9a-f]{32}(\.|\/|$)/.test(name)).length >= Math.max(1, names.length * 0.4)) {
    return done('notion', readMarkdownArchive(entries, skipped, { notion: true }), skipped);
  }

  // Joplin's Markdown export writes its metadata into the foot of each file.
  if (entries.some((entry) => entry.name.endsWith('.md') && /\ntype_:\s*\d/.test(entry.bytes.toString('utf8')))) {
    return done('joplin', readMarkdownArchive(entries, skipped, { joplin: true }), skipped);
  }

  if (names.some((name) => /\.(html?|enex)$/i.test(name))) {
    return done('apple', readMarkdownArchive(entries, skipped, {}), skipped);
  }

  return done('obsidian', readMarkdownArchive(entries, skipped, {}), skipped);
}

interface ArchiveOptions {
  notion?: boolean;
  logseq?: boolean;
  joplin?: boolean;
}

/**
 * Every text-ish file in an archive, as a note, keeping the folder structure.
 *
 * This is what makes an Obsidian vault round-trip: a note in `work/2026` comes
 * back into `work/2026`, so exporting it again reproduces the vault rather than
 * a flat pile.
 */
function readMarkdownArchive(
  entries: ZipEntry[],
  skipped: ImportPreview['skipped'],
  options: ArchiveOptions
): ImportedNote[] {
  const notes: ImportedNote[] = [];

  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;

    // Editor droppings and platform noise, skipped silently: naming them would
    // make every macOS export report forty "skipped" files.
    if (/(^|\/)(\.|__MACOSX|Thumbs\.db|desktop\.ini)/i.test(entry.name)) continue;

    const ext = (entry.name.split('.').pop() ?? '').toLowerCase();
    const folder = normaliseFolder(cleanPath(entry.name.split('/').slice(0, -1).join('/'), options));
    const title = cleanPath(baseName(entry.name), options);

    if (ext === 'md' || ext === 'markdown' || ext === 'txt') {
      let text = entry.bytes.toString('utf8');
      if (options.joplin) text = stripJoplinMetadata(text);
      if (options.logseq) text = stripLogseqProperties(text);
      notes.push(
        ext === 'txt'
          ? noteFromText(title, text, folder)
          : noteFromMarkdown(title, text, folder)
      );
      continue;
    }

    if (ext === 'html' || ext === 'htm') {
      notes.push(noteFromHtml(title, entry.bytes.toString('utf8'), folder));
      continue;
    }

    if (ext === 'enex') {
      notes.push(...readEnex(entry.bytes.toString('utf8')).map((note) => ({ ...note, folder })));
      continue;
    }

    if (ext === 'json') {
      const keep = keepNote(entry.bytes.toString('utf8'), folder);
      if (keep) notes.push(keep);
      continue;
    }

    if (ext === 'csv') {
      // Notion writes a CSV per database view, alongside a Markdown file per
      // row — importing both would double every note.
      if (options.notion) continue;
      notes.push(...readCsvNotes(entry.bytes.toString('utf8')).map((note) => ({ ...note, folder })));
      continue;
    }

    /*
     * Attachments. Named rather than silently dropped, because a vault full of
     * images that arrived without them should say so — this imports the text of
     * a notebook, not its binaries.
     */
    if (/^(png|jpe?g|gif|webp|pdf|mp3|mp4|mov|zip|docx?|xlsx?)$/.test(ext)) {
      skipped.push({ name: entry.name, why: 'attachment — the text came through, the file did not' });
      continue;
    }

    skipped.push({ name: entry.name, why: `nothing here reads .${ext || 'that'}` });
  }

  return notes;
}

/** Strip the exporter's own decoration from a path segment. */
function cleanPath(path: string, options: ArchiveOptions): string {
  if (!options.notion) return path;
  // Notion's ` 1a2b3c…` id suffix on every page and folder name.
  return path
    .split('/')
    .map((part) => part.replace(/[ -][0-9a-f]{32}$/i, '').trim())
    .join('/');
}

/**
 * Joplin writes `id:`, `parent_id:`, `type_:` and friends into the foot of every
 * exported note. Left in, every note ends with eight lines of machine data.
 */
function stripJoplinMetadata(text: string): string {
  return text.replace(/\n+(?:^[a-z_]+:\s*.*$\n?){3,}\s*$/im, '\n').trimEnd();
}

/**
 * Logseq's `key:: value` properties, kept as tags where they say something.
 *
 * `tags:: a, b` is the one worth carrying across; the rest are identifiers for
 * a block model this app does not have.
 */
function stripLogseqProperties(text: string): string {
  const tags: string[] = [];
  const body = text.replace(/^[ \t]*([a-zA-Z][\w-]*)::[ \t]*(.*)$/gm, (_whole, key: string, value: string) => {
    if (key.toLowerCase() === 'tags') tags.push(...value.split(',').map((tag) => tag.trim()).filter(Boolean));
    return '';
  });
  const suffix = tags.length > 0 ? `\n\n${tags.map((tag) => `#${tag.replace(/\s+/g, '-')}`).join(' ')}` : '';
  return body.replace(/\n{3,}/g, '\n\n').trim() + suffix;
}

/* ------------------------------------------------------------------ */
/* One note, from each shape of input                                   */
/* ------------------------------------------------------------------ */

function noteFromMarkdown(fallbackTitle: string, text: string, folder: string): ImportedNote {
  const { data, body } = parseFrontMatter(text);

  const frontTags = [data.tags, data.tag, data.keywords]
    .flatMap((value) => (Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\s]+/) : []))
    .map((tag) => String(tag).replace(/^#/, '').trim())
    .filter(Boolean);

  /*
   * A leading `# Heading` becomes the title and is removed from the body.
   * Notion and Joplin both write the title twice — once as the filename and
   * again as the first heading — and importing both leaves every note opening
   * with its own name.
   */
  let content = body;
  let title = typeof data.title === 'string' ? data.title : '';
  const leading = /^\s*#\s+(.+?)\s*(?:\n|$)/.exec(content);
  if (leading && (!title || sameTitle(leading[1], title) || sameTitle(leading[1], fallbackTitle))) {
    title = title || leading[1];
    content = content.slice(leading[0].length);
  }

  return {
    title: (title || fallbackTitle || derivedTitle(content)).trim(),
    body: content.trim(),
    folder,
    tags: [...new Set([...frontTags, ...extractTags(content)])],
    createdAt: asTime(data.created ?? data.created_at ?? data.date),
    updatedAt: asTime(data.updated ?? data.updated_at ?? data.modified),
  };
}

const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function noteFromText(title: string, text: string, folder: string): ImportedNote {
  const body = textToMarkdown(text);
  return { title: title || derivedTitle(body), body, folder, tags: extractTags(body) };
}

function noteFromHtml(title: string, html: string, folder: string): ImportedNote {
  // A page title beats a filename, since an HTML export is usually called
  // something like `Note-3.html`.
  const inner = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const body = htmlToMarkdown(html);
  return {
    title: (inner?.[1] ?? '').trim() || title || derivedTitle(body),
    body,
    folder,
    tags: extractTags(body),
  };
}

/**
 * Word's `document.xml` to Markdown.
 *
 * Paragraph by paragraph, with the outline level restoring headings. Reading it
 * as XML by regex is the same call `html.ts` makes: the input is one
 * application's own output, not arbitrary markup.
 */
function noteFromDocx(title: string, xml: string): ImportedNote {
  const paragraphs = [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)].map((match) => {
    const block = match[1];
    const text = [...block.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
      .map((run) => run[1])
      .join('')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');

    if (!text.trim()) return '';

    const outline = /<w:outlineLvl w:val="(\d+)"/.exec(block);
    if (outline) return `${'#'.repeat(Math.min(6, Number(outline[1]) + 1))} ${text}`;

    // A paragraph that starts with a bullet character was a list in Word; kept
    // as one rather than as a paragraph beginning with a dot.
    if (/^\s*[•☐☒·-]\s+/.test(text)) return `- ${text.replace(/^\s*[•☐☒·-]\s+/, '')}`;

    return text;
  });

  const body = paragraphs.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title: title || derivedTitle(body), body, folder: '', tags: extractTags(body) };
}

/* ------------------------------------------------------------------ */
/* Evernote                                                             */
/* ------------------------------------------------------------------ */

/**
 * `.enex`, which is XML holding ENML, which is HTML.
 *
 * The bodies arrive in CDATA, so they are pulled out whole and handed to the
 * HTML converter rather than being parsed as XML — a `<div>` inside CDATA is
 * text to an XML parser and markup to a note, and only one of those readings is
 * useful.
 */
function readEnex(xml: string): ImportedNote[] {
  const notes: ImportedNote[] = [];

  for (const match of xml.matchAll(/<note>([\s\S]*?)<\/note>/g)) {
    const block = match[1];
    const title = tagText(block, 'title');
    const content = /<content>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/content>/.exec(block)?.[1] ?? '';
    const tags = [...block.matchAll(/<tag>([\s\S]*?)<\/tag>/g)].map((tag) => decodeXml(tag[1]).trim()).filter(Boolean);

    const body = htmlToMarkdown(content);
    notes.push({
      title: title || derivedTitle(body) || 'Untitled',
      body,
      folder: '',
      // Evernote's tags are free text with spaces; hyphenated so they survive
      // as tags rather than becoming one tag and several loose words.
      tags: [...new Set([...tags.map((tag) => tag.replace(/\s+/g, '-')), ...extractTags(body)])],
      createdAt: asTime(tagText(block, 'created')),
      updatedAt: asTime(tagText(block, 'updated')),
    });
  }

  return notes;
}

function tagText(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? decodeXml(match[1]).trim() : '';
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_w, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

/* ------------------------------------------------------------------ */
/* JSON exports                                                         */
/* ------------------------------------------------------------------ */

/** Roam, Keep, Standard Notes and Joplin's RAW all arrive as JSON. */
function readJson(text: string, skipped: ImportPreview['skipped']): { format: string; notes: ImportedNote[] } | null {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return null;
  }

  // Standard Notes: an envelope of items, most of which are not notes.
  if (isRecord(data) && Array.isArray(data.items)) {
    const notes: ImportedNote[] = [];
    for (const item of data.items) {
      if (!isRecord(item) || item.content_type !== 'Note') continue;
      const content = isRecord(item.content) ? item.content : {};
      const body = textToMarkdown(String(content.text ?? ''));
      notes.push({
        title: String(content.title ?? '') || derivedTitle(body),
        body,
        folder: '',
        tags: extractTags(body),
        createdAt: asTime(item.created_at),
        updatedAt: asTime(item.updated_at),
      });
    }
    if (notes.length > 0) return { format: 'standard', notes };
  }

  // Roam: an array of pages, each a tree of blocks.
  if (Array.isArray(data) && data.some((page) => isRecord(page) && typeof page.title === 'string')) {
    const notes = data
      .filter(isRecord)
      .filter((page) => typeof page.title === 'string')
      .map((page) => {
        const body = roamBlocks(Array.isArray(page.children) ? page.children : [], 0).join('\n');
        return {
          title: String(page.title),
          body,
          folder: '',
          tags: extractTags(body),
          createdAt: asTime(page['create-time']),
          updatedAt: asTime(page['edit-time']),
        };
      });
    if (notes.length > 0) return { format: 'roam', notes };
  }

  // A single Keep note.
  const single = keepNote(text, '');
  if (single) return { format: 'keep', notes: [single] };

  skipped.push({ name: 'the file', why: 'valid JSON, but not a shape this recognises' });
  return null;
}

/**
 * Roam's blocks to nested bullets.
 *
 * An outliner flattens imperfectly and that is inherent: every line in Roam is
 * a block with an id, and this app's notes are documents. Nesting becomes
 * indentation, which is the part that carries the meaning; block references
 * `((uid))` are left as written rather than resolved, since the thing they
 * point at is a line rather than a note.
 */
function roamBlocks(children: unknown[], depth: number): string[] {
  const out: string[] = [];
  for (const child of children) {
    if (!isRecord(child)) continue;
    const text = String(child.string ?? '').trim();
    if (text) out.push(`${'  '.repeat(depth)}- ${text}`);
    if (Array.isArray(child.children)) out.push(...roamBlocks(child.children, depth + (text ? 1 : 0)));
  }
  return out;
}

function looksLikeKeep(entries: ZipEntry[], name: string): boolean {
  const entry = entries.find((candidate) => candidate.name === name);
  if (!entry) return false;
  try {
    const data = JSON.parse(entry.bytes.toString('utf8'));
    return isRecord(data) && ('textContent' in data || 'listContent' in data);
  } catch {
    return false;
  }
}

function readKeepArchive(entries: ZipEntry[], skipped: ImportPreview['skipped']): ImportedNote[] {
  const notes: ImportedNote[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue;
    const note = keepNote(entry.bytes.toString('utf8'), '');
    if (note) notes.push(note);
  }
  if (notes.length === 0) skipped.push({ name: 'the archive', why: 'no Keep notes found inside it' });
  return notes;
}

/** One Keep note, which is either text or a checklist. */
function keepNote(text: string, folder: string): ImportedNote | null {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  if (!('textContent' in data) && !('listContent' in data)) return null;

  // A Keep checklist is a list of items with a ticked flag, which is exactly a
  // Markdown task list — the one import here that gains structure rather than
  // losing it.
  const list = Array.isArray(data.listContent)
    ? data.listContent
        .filter(isRecord)
        .map((item) => `- [${item.isChecked ? 'x' : ' '}] ${String(item.text ?? '')}`)
        .join('\n')
    : '';

  const body = list || textToMarkdown(String(data.textContent ?? ''));
  const labels = Array.isArray(data.labels)
    ? data.labels.filter(isRecord).map((label) => String(label.name ?? '').replace(/\s+/g, '-')).filter(Boolean)
    : [];

  return {
    title: String(data.title ?? '') || derivedTitle(body),
    body,
    // Keep has no folders, so its archive state is the nearest thing to one.
    folder: folder || (data.isArchived ? 'Archive' : ''),
    tags: [...new Set([...labels, ...extractTags(body)])],
    createdAt: asTime(data.createdTimestampUsec),
    updatedAt: asTime(data.userEditedTimestampUsec),
  };
}

/* ------------------------------------------------------------------ */
/* Joplin's .jex, which is a tar                                        */
/* ------------------------------------------------------------------ */

/**
 * A tar reader, for Joplin's default export.
 *
 * Tar is 512-byte headers and 512-byte blocks and nothing else, which is why
 * writing one here is cheaper than refusing the format Joplin exports by
 * default. Only the fields this needs are read: the name, the size, and whether
 * the entry is a file.
 */
function readJoplinArchive(bytes: Buffer, skipped: ImportPreview['skipped']): ImportedNote[] {
  const notes: ImportedNote[] = [];
  let offset = 0;

  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    // Two consecutive zero blocks end the archive; one empty name is enough to
    // stop, since nothing after it is a header.
    if (!name) break;

    const sizeField = header.subarray(124, 136).toString('ascii').replace(/[\0 ]/g, '');
    const size = parseInt(sizeField, 8) || 0;
    const type = String.fromCharCode(header[156]);

    offset += 512;
    if (type === '0' || type === '\0') {
      const content = bytes.subarray(offset, offset + size);
      // Joplin names everything by id; the note's own title is its first line.
      const text = stripJoplinMetadata(content.toString('utf8'));
      if (/\n/.test(text) || text.trim()) {
        const [first, ...rest] = text.split('\n');
        const body = rest.join('\n').trim();
        // Only notes carry a body; folders and tags export as stubs.
        if (body || first.trim()) {
          notes.push({
            title: first.trim() || derivedTitle(body),
            body,
            folder: '',
            tags: extractTags(body),
          });
        }
      }
    }
    // Blocks are padded to a multiple of 512.
    offset += Math.ceil(size / 512) * 512;
  }

  if (notes.length === 0) skipped.push({ name: 'the archive', why: 'no notes found inside the .jex' });
  return notes;
}

/* ------------------------------------------------------------------ */
/* CSV                                                                  */
/* ------------------------------------------------------------------ */

/**
 * A table of notes, with the columns found by name rather than by position.
 *
 * Every app that exports CSV names its columns differently and orders them
 * differently, and a positional reader silently files bodies as titles the
 * first time somebody's export has an id column in front.
 */
function readCsvNotes(text: string): ImportedNote[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];

  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  const find = (...names: string[]) => header.findIndex((cell) => names.includes(cell));

  const titleAt = find('title', 'name', 'subject', 'heading');
  const bodyAt = find('body', 'content', 'text', 'note', 'notes', 'description');
  const folderAt = find('folder', 'notebook', 'path', 'category', 'section');
  const tagsAt = find('tags', 'tag', 'labels', 'keywords');

  /*
   * No recognisable header means the first row is data. Two columns is
   * title-then-body, one is a body per row — which is what a list of thoughts
   * pasted out of a spreadsheet looks like.
   */
  if (titleAt === -1 && bodyAt === -1) {
    return rows.map((cells) => {
      const body = textToMarkdown(cells.length > 1 ? cells.slice(1).join('\n\n') : cells[0] ?? '');
      return {
        title: cells.length > 1 ? cells[0] : derivedTitle(body),
        body,
        folder: '',
        tags: extractTags(body),
      };
    });
  }

  return rows.slice(1).map((cells) => {
    const body = textToMarkdown(cells[bodyAt] ?? '');
    return {
      title: (cells[titleAt] ?? '').trim() || derivedTitle(body),
      body,
      folder: normaliseFolder(cells[folderAt] ?? ''),
      tags: [
        ...new Set([
          ...(cells[tagsAt] ?? '').split(/[,;|]/).map((tag) => tag.trim().replace(/^#/, '')).filter(Boolean),
          ...extractTags(body),
        ]),
      ],
    };
  });
}

/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whatever an exporter calls a timestamp, as milliseconds.
 *
 * Seconds, milliseconds, microseconds and ISO strings all turn up — Keep uses
 * microseconds, Evernote uses `20260101T120000Z`, most JSON uses ISO. The
 * magnitudes are far enough apart to tell by size, and anything that lands
 * outside a plausible range is dropped rather than producing a note written in
 * 1970 or 55000.
 */
function asTime(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;

  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e15 ? value / 1000 : value > 1e12 ? value : value * 1000;
    return plausible(ms);
  }

  const text = String(value).trim();
  if (!text) return undefined;

  if (/^\d+$/.test(text)) return asTime(Number(text));

  // Evernote's compact form, which `Date.parse` does not accept.
  const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(text);
  if (compact) {
    const [, y, mo, d, h, mi, s] = compact;
    return plausible(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  }

  return plausible(Date.parse(text));
}

function plausible(ms: number): number | undefined {
  // 1990 to a century out: wide enough for anybody's oldest note, narrow enough
  // to catch a unit that was guessed wrong by three orders of magnitude.
  return Number.isFinite(ms) && ms > 631_152_000_000 && ms < Date.now() + 3.2e12 ? Math.round(ms) : undefined;
}
