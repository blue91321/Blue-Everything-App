/**
 * Writing the notebook out, in the shape another app will accept.
 *
 * ### The vault is the one that has to round-trip
 *
 * Markdown files in folders, with front matter carrying what Markdown cannot —
 * the tags and the dates. That is literally what an Obsidian vault is, so the
 * export is not a conversion at all: unzip it into Obsidian and the wiki-links
 * work, because they were Obsidian's syntax the whole time. The importer reads
 * it back into the same folders, which is what makes this a way *out* rather
 * than a lock-in with extra steps.
 *
 * ### Everything else loses something, and says so
 *
 * PDF and Word flatten the links. CSV flattens the formatting. TXT flattens
 * both. Those are the honest costs of those formats rather than gaps to fix,
 * and the screen names them beside each button so the choice is made knowing.
 */
import {
  csvRow,
  noteToText,
  parseBlocks,
  safeFileName,
  stringifyFrontMatter,
} from '@everything/shared/notes';
import { writeZip } from '../zip.js';
import { writeDocx } from './docx.js';
import { writePdf } from './pdf.js';

export interface ExportableNote {
  title: string;
  body: string;
  folder: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ExportResult {
  fileName: string;
  mime: string;
  bytes: Buffer;
}

export const EXPORT_FORMATS: { id: string; label: string; hint: string }[] = [
  { id: 'vault', label: 'Obsidian vault', hint: 'A .zip of Markdown in folders — links and tags intact' },
  { id: 'markdown', label: 'Markdown', hint: 'One .md per note, zipped' },
  { id: 'txt', label: 'Plain text', hint: 'Formatting removed, one .txt per note' },
  { id: 'csv', label: 'CSV', hint: 'A row per note, for a spreadsheet' },
  { id: 'pdf', label: 'PDF', hint: 'To read or send — Latin alphabets only' },
  { id: 'docx', label: 'Word', hint: 'A .docx you can keep editing' },
];

export class ExportRefused extends Error {}

export function exportNotes(format: string, notes: ExportableNote[], stamp = new Date()): ExportResult {
  const day = stamp.toISOString().slice(0, 10);
  const one = notes.length === 1 ? notes[0] : null;

  switch (format) {
    case 'vault':
      return {
        fileName: `notes-${day}.zip`,
        mime: 'application/zip',
        bytes: writeZip(vaultFiles(notes)),
      };

    case 'markdown':
      /*
       * A single note downloads as a file rather than a zip of one. Unzipping
       * an archive to reach one note is a step nobody would choose, and the
       * exporter knows how many it has.
       */
      return one
        ? { fileName: `${safeFileName(one.title)}.md`, mime: 'text/markdown; charset=utf-8', bytes: Buffer.from(markdownFor(one), 'utf8') }
        : { fileName: `notes-${day}.zip`, mime: 'application/zip', bytes: writeZip(vaultFiles(notes)) };

    case 'txt':
      return one
        ? { fileName: `${safeFileName(one.title)}.txt`, mime: 'text/plain; charset=utf-8', bytes: Buffer.from(textFor(one), 'utf8') }
        : {
            fileName: `notes-${day}.zip`,
            mime: 'application/zip',
            bytes: writeZip(uniqueNames(notes, 'txt').map(({ name, note }) => ({ name, bytes: Buffer.from(textFor(note), 'utf8') }))),
          };

    case 'csv':
      return {
        fileName: `notes-${day}.csv`,
        mime: 'text/csv; charset=utf-8',
        bytes: Buffer.from(csvFor(notes), 'utf8'),
      };

    case 'pdf':
      return {
        fileName: one ? `${safeFileName(one.title)}.pdf` : `notes-${day}.pdf`,
        mime: 'application/pdf',
        bytes: writePdf(notes.map((note) => ({ title: note.title, blocks: parseBlocks(note.body) }))),
      };

    case 'docx':
      return {
        fileName: one ? `${safeFileName(one.title)}.docx` : `notes-${day}.docx`,
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: writeDocx(notes.map((note) => ({ title: note.title, blocks: parseBlocks(note.body) }))),
      };

    default:
      throw new ExportRefused(`there is no "${format}" export`);
  }
}

/** A note as the file a vault holds: front matter, then the body unchanged. */
function markdownFor(note: ExportableNote): string {
  const front = stringifyFrontMatter({
    title: note.title,
    tags: note.tags,
    created: new Date(note.createdAt).toISOString(),
    updated: new Date(note.updatedAt).toISOString(),
  });
  return `${front}${note.body}\n`;
}

function textFor(note: ExportableNote): string {
  return `${note.title}\n\n${noteToText(note.body)}\n`;
}

function csvFor(notes: ExportableNote[]): string {
  const rows = [csvRow(['title', 'folder', 'tags', 'created', 'updated', 'body'])];
  for (const note of notes) {
    rows.push(
      csvRow([
        note.title,
        note.folder,
        note.tags.join(', '),
        new Date(note.createdAt).toISOString(),
        new Date(note.updatedAt).toISOString(),
        // The Markdown, not the rendered text: a CSV is a backup as much as a
        // spreadsheet, and this is the column the importer reads back.
        note.body,
      ])
    );
  }
  return `${rows.join('\n')}\n`;
}

function vaultFiles(notes: ExportableNote[]) {
  return uniqueNames(notes, 'md').map(({ name, note }) => ({
    name,
    bytes: Buffer.from(markdownFor(note), 'utf8'),
  }));
}

/**
 * A path per note, with collisions resolved rather than silently overwriting.
 *
 * Two notes called "Meeting" in one folder is completely ordinary, and a zip
 * with the same entry name twice unpacks to whichever came last — so an export
 * would quietly lose one. The suffix is only added where it is needed, so the
 * common case keeps clean filenames.
 */
function uniqueNames(notes: ExportableNote[], ext: string): { name: string; note: ExportableNote }[] {
  const used = new Set<string>();

  return notes.map((note) => {
    const folder = note.folder ? `${note.folder}/` : '';
    const base = safeFileName(note.title);

    let name = `${folder}${base}.${ext}`;
    let n = 2;
    while (used.has(name.toLowerCase())) {
      // Case-insensitively, because Windows and macOS both treat `Meeting.md`
      // and `meeting.md` as one file and the collision would reappear on unzip.
      name = `${folder}${base} ${n}.${ext}`;
      n += 1;
    }

    used.add(name.toLowerCase());
    return { name, note };
  });
}
