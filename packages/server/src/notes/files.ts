/**
 * Pictures and files pasted into a note.
 *
 * The bytes live in `data/notes/` beside the database rather than inside it,
 * the same call the habit pictures and the app logo make: a notes list is
 * fetched on every page load and has no business carrying a JPEG.
 *
 * ### Behind auth, like the habit pictures and unlike the icons
 *
 * The app icons and the notification tones sit outside `/api/` because they are
 * fetched by machinery that will never send a bearer token — the iOS installer,
 * an `<audio>` element. These are things you pasted into your own notes,
 * personal in the way the rest of the database is, so they stay behind the
 * token and the browser fetches the bytes and wraps them in an object URL.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from '../paths.js';

/** Where the files go. Created on demand, like every other folder under `data/`. */
export const notesDir = join(dataDir, 'notes');

/**
 * What may be stored, by extension and by what it is served as.
 *
 * **An allow-list, not a deny-list**, and the type served is this table's
 * rather than whatever the upload claimed. A file is fetched from the same
 * origin as the app, so a `.svg` served as `image/svg+xml` is a script running
 * with the app's token in reach — which is why it is not here even though it is
 * an image everybody expects to work. Anything not listed is stored as a
 * download rather than refused, since losing an attachment is worse than not
 * previewing one.
 */
const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  csv: 'text/plain; charset=utf-8',
  json: 'text/plain; charset=utf-8',
};

/** The fallback: downloaded rather than rendered, which is the safe direction. */
const OPAQUE = 'application/octet-stream';

export function mimeForExtension(ext: string): string {
  return TYPES[ext.toLowerCase()] ?? OPAQUE;
}

/** True for the ones a note can show inline rather than link to. */
export function isDisplayable(ext: string): boolean {
  return mimeForExtension(ext).startsWith('image/');
}

/**
 * The extension, reduced to something that cannot become a path.
 *
 * Letters and digits only, and short — this ends up in a filename, and the
 * habit-picture traversal hole is what happens when a caller-supplied string
 * reaches one without being checked. There is no `..` that survives this.
 */
export function safeExtension(name: string, fallback = 'bin'): string {
  const ext = (name.split('.').pop() ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return ext && ext.length <= 8 ? ext : fallback;
}

/**
 * Where one attachment's bytes sit.
 *
 * The id is generated here, never supplied, so the traversal that reached
 * `data/avatar.png` through a habit id cannot be repeated — but the guard is
 * applied anyway, because "the id is ours" is a claim about today's callers.
 */
export function attachmentPath(id: string, ext: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('bad attachment id');
  return join(notesDir, `${id}.${safeExtension(`x.${ext}`)}`);
}

export async function writeAttachment(id: string, ext: string, bytes: Buffer): Promise<void> {
  if (!existsSync(notesDir)) mkdirSync(notesDir, { recursive: true });
  await writeFile(attachmentPath(id, ext), bytes);
}

export async function readAttachment(id: string, ext: string): Promise<Buffer | null> {
  try {
    return await readFile(attachmentPath(id, ext));
  } catch {
    // A row whose file is gone — an interrupted write, or a folder tidied by
    // hand. Answered as missing rather than as a server error.
    return null;
  }
}
