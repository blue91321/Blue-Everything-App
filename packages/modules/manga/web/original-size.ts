/**
 * A page's size as it was before the PC made a smaller copy of it (2026-11-12).
 *
 * Pages mode tells a scanlation group's notice from the book's pages by its
 * size (`apartPages` in `page-layout.ts`), and Automatic sends each page at
 * whatever size the connection allows at that moment: one chapter of *Isekai Ni
 * Kitakedo* came to a phone as 44 pages as they were, 34 recompressed and 10
 * shrunk to 900 pixels wide, and the ten were set apart as though they were
 * notices, alone in the middle of the chapter. So the server says the size it
 * shrank from (`x-original-size`), and this keeps it with the picture: by the
 * blob it arrived as, then by the object URL the reader is handed.
 *
 * No imports, so the reading of a page can use it without the downloads.
 */
export type Size = [number, number];

const byBlob = new WeakMap<Blob, Size>();
/** By object URL; bounded, since a URL is revoked and never asked about again. */
const byUrl = new Map<string, Size>();
const KEPT = 2000;

/** The header's `1025x1457`, or null. */
export function readOriginalSize(header: string | null | undefined): Size | null {
  const m = /^(\d+)x(\d+)$/.exec(header?.trim() ?? '');
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? [w, h] : null;
}

/** Remember the size a picture was shrunk from, where it was. */
export function noteOriginal(blob: Blob, size: Size | null): Blob {
  if (size) byBlob.set(blob, size);
  return blob;
}

export function blobOriginal(blob: Blob): Size | null {
  return byBlob.get(blob) ?? null;
}

/** `URL.createObjectURL`, keeping the size the picture was shrunk from with the URL. */
export function objectUrlFor(blob: Blob): string {
  const url = URL.createObjectURL(blob);
  const size = byBlob.get(blob);
  if (size) {
    byUrl.set(url, size);
    if (byUrl.size > KEPT) byUrl.delete(byUrl.keys().next().value!);
  }
  return url;
}

/** The size the picture at this URL was shrunk from, or null when it is as it was (or not known). */
export function originalSizeOf(url: string): Size | null {
  return byUrl.get(url) ?? null;
}

/** The header a saved copy keeps the size under, so a chapter saved shrunk still pairs by its pages' real size. */
export function originalHeader(blob: Blob): Record<string, string> {
  const size = byBlob.get(blob);
  return size ? { 'x-original-size': `${size[0]}x${size[1]}` } : {};
}
