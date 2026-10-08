/**
 * Whether some bytes are a whole picture — not an error page, not empty, and
 * not cut off half way.
 *
 * A saved page is read back with nothing between it and the screen, so one
 * that arrived damaged used to be kept as though it were fine: on the train it
 * drew as a gap, and "tap to try again" asked for the same saved copy and got
 * the same gap, for good. Checking on the way in, and again on the way out, is
 * what turns that into a page that is fetched again instead.
 *
 * Only the start and the end are looked at, because those are where the two
 * failures show. The first bytes say what kind of file it is — an HTML error
 * page or a JSON message is not any of these. The last bytes say whether it
 * finished: a JPEG ends on its end-of-image marker, a PNG on its IEND chunk, a
 * GIF on its trailer, and a WebP or AVIF states its own length up front.
 * Decoding the whole thing would be surer and would cost a full-size decode
 * per page — these strips run to 48MB each decoded — to catch a case the
 * markers already catch.
 *
 * No imports, so the server's page cache and `manga-check` use it too.
 */
export function isWholeImage(head: Uint8Array, tail: Uint8Array, size: number): boolean {
  if (size < 32 || head.length < 16) return false;
  const ascii = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to));
  const tailHas = (bytes: number[]) => {
    for (let i = tail.length - bytes.length; i >= 0; i--) {
      if (bytes.every((b, j) => tail[i + j] === b)) return true;
    }
    return false;
  };

  // JPEG: FF D8 FF, and an FF D9 near the end (some encoders pad after it).
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return tailHas([0xff, 0xd9]);
  // PNG: the signature, and the IEND chunk's name near the end.
  if (head[0] === 0x89 && ascii(1, 4) === 'PNG') return tailHas([0x49, 0x45, 0x4e, 0x44]);
  // GIF: GIF8, ending on the 0x3B trailer.
  if (ascii(0, 4) === 'GIF8') return tailHas([0x3b]);
  // WebP: RIFF, then its own length — the file is at least what it says.
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    const declared = (head[4]! | (head[5]! << 8) | (head[6]! << 16) | (head[7]! << 24)) >>> 0;
    return size >= declared + 8;
  }
  // AVIF and HEIC: an ISO box headed `ftyp`. No cheap end marker, so the type
  // alone is checked — still enough to refuse an error page.
  if (ascii(4, 8) === 'ftyp') return true;
  return false;
}

/** The same question of a `Blob`, reading only the two ends of it. */
export async function blobIsWholeImage(blob: Blob): Promise<boolean> {
  const head = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
  const tail = new Uint8Array(await blob.slice(Math.max(0, blob.size - 1024)).arrayBuffer());
  return isWholeImage(head, tail, blob.size);
}
