/**
 * Just enough of the ZIP format to unpack a downloaded package — and, since the
 * notes exporter, to write one.
 *
 * Hand-rolled and dependency-free, for the same reason `make-icons.mjs` encodes
 * its own PNGs and `sound.ts` writes its own WAV headers: the whole format we
 * need is a couple of structs and one call to `zlib.inflateRawSync`, which is
 * already in Node. A zip library would be a third-party dependency sitting
 * directly in the path of untrusted input, which is the last place this app
 * should be adding code it has not read.
 *
 * ### Reading the central directory rather than the local headers
 *
 * Both describe every entry, and the local header is the tempting one because
 * it sits immediately before the bytes. It is also the one that is allowed to
 * lie: with the streaming bit (flag 3) set — which anything that zipped to a
 * pipe will do — the local header's sizes and CRC are zero and the real values
 * come *after* the data in a descriptor. The central directory is always
 * complete, so it is the only honest source for sizes.
 *
 * ### What this deliberately does not support
 *
 * ZIP64, encryption, and anything but stored/deflate. Each is refused by name
 * rather than mis-parsed: an archive this cannot read must say so, because the
 * alternative is extracting half of one and leaving a broken package on disk.
 */
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** The fixed part of a central-directory header, before the variable-length name. */
const CENTRAL_HEADER_BYTES = 46;
/** The fixed part of a local file header, before the name and extra field. */
const LOCAL_HEADER_BYTES = 30;
/** The fixed part of the end-of-central-directory record, before its comment. */
const EOCD_BYTES = 22;

/** The zip comment is a 16-bit length, so the record starts within this of the end. */
const MAX_COMMENT_BYTES = 0xffff;

/** Sentinel meaning "this value did not fit in 32 bits — read the ZIP64 record". */
const ZIP64_SENTINEL = 0xffffffff;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** Flag bit 0. Encrypted entries need a password this app will never have. */
const FLAG_ENCRYPTED = 0x0001;

export interface ZipEntry {
  /** The path as stored, already checked to be a safe relative path. */
  name: string;
  bytes: Buffer;
}

export interface ZipLimits {
  /** Refuse an archive claiming more entries than this. */
  maxEntries: number;
  /** Refuse a single entry whose unpacked size exceeds this. */
  maxFileBytes: number;
  /** Refuse an archive whose entries add up to more than this. */
  maxTotalBytes: number;
}

/**
 * Deliberately modest, because they bound a decompression bomb.
 *
 * A zip that unpacks to a terabyte is a few hundred bytes on the wire, so the
 * declared size is checked *before* inflating rather than the result measured
 * after. A package that genuinely exceeds these is a package this app should
 * not be installing through a browser upload.
 */
export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 2_000,
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
};

export class ZipError extends Error {}

/**
 * Is this a path we are willing to write, relative to a directory we choose?
 *
 * The attack is "zip slip": an entry named `../../../etc/passwd`, or on Windows
 * one using backslashes, escaping the directory being extracted into. This app
 * has already shipped one path traversal — the habit picture let `..` climb out
 * of `data/` — so the rule here is the same one that fixed it: validate the
 * *shape* at the boundary rather than trusting a later `resolve()` to stay put.
 *
 * Backslashes are treated as separators even though the spec says names use
 * forward slashes, precisely because this runs on Windows: an entry containing
 * one is a single segment by the spec's reading and two by the filesystem's,
 * and the filesystem is the one that creates the file.
 */
export function isSafeEntryName(name: string): boolean {
  if (name.length === 0 || name.length > 512) return false;
  // A null byte truncates the path for anything that later hands it to C.
  if (name.includes('\0')) return false;
  // Absolute in either spelling, or a drive-relative path like `C:x`.
  if (name.startsWith('/') || name.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(name)) return false;

  for (const segment of name.split(/[/\\]/)) {
    if (segment === '..') return false;
    /*
     * A trailing dot or space is stripped by the Win32 layer, so `foo.` and
     * `foo` are the same file — a difference that shows up only as one entry
     * silently overwriting another.
     */
    if (segment !== '' && (segment.endsWith('.') || segment.endsWith(' '))) return false;
  }
  return true;
}

function readUInt32(buf: Buffer, offset: number): number {
  if (offset + 4 > buf.length) throw new ZipError('truncated archive');
  return buf.readUInt32LE(offset);
}

function readUInt16(buf: Buffer, offset: number): number {
  if (offset + 2 > buf.length) throw new ZipError('truncated archive');
  return buf.readUInt16LE(offset);
}

/**
 * Find the end-of-central-directory record.
 *
 * Scanned backwards because it is last and its length is variable — a zip may
 * carry a comment of up to 64KB after it. Scanning forwards for the signature
 * would instead find whatever byte sequence happened to appear inside the
 * compressed data.
 */
function findEocd(buf: Buffer): number {
  const earliest = Math.max(0, buf.length - EOCD_BYTES - MAX_COMMENT_BYTES);
  for (let i = buf.length - EOCD_BYTES; i >= earliest; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new ZipError('not a zip file — no end-of-central-directory record');
}

/**
 * Read every entry, checking each one before any of it is trusted.
 *
 * Returns files only. Directory entries are dropped rather than reported: they
 * carry no content, and the extractor creates whatever parents it needs anyway,
 * so keeping them would only be one more name to validate.
 */
export function readZip(buf: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipEntry[] {
  if (buf.length < EOCD_BYTES) throw new ZipError('not a zip file — too short');

  const eocd = findEocd(buf);
  const entryCount = readUInt16(buf, eocd + 10);
  const centralSize = readUInt32(buf, eocd + 12);
  const centralOffset = readUInt32(buf, eocd + 16);

  if (centralOffset === ZIP64_SENTINEL || centralSize === ZIP64_SENTINEL || entryCount === 0xffff) {
    throw new ZipError('ZIP64 archives are not supported — re-zip it without ZIP64');
  }
  if (entryCount > limits.maxEntries) {
    throw new ZipError(`too many files in the archive (${entryCount}, limit ${limits.maxEntries})`);
  }
  if (centralOffset + centralSize > buf.length) throw new ZipError('truncated archive');

  const entries: ZipEntry[] = [];
  let total = 0;
  let cursor = centralOffset;

  for (let i = 0; i < entryCount; i += 1) {
    if (readUInt32(buf, cursor) !== CENTRAL_SIGNATURE) {
      throw new ZipError('corrupt archive — bad central directory entry');
    }

    const flags = readUInt16(buf, cursor + 8);
    const method = readUInt16(buf, cursor + 10);
    const expectedCrc = readUInt32(buf, cursor + 16);
    const compressedSize = readUInt32(buf, cursor + 20);
    const uncompressedSize = readUInt32(buf, cursor + 24);
    const nameLength = readUInt16(buf, cursor + 28);
    const extraLength = readUInt16(buf, cursor + 30);
    const commentLength = readUInt16(buf, cursor + 32);
    const localOffset = readUInt32(buf, cursor + 42);

    const name = buf
      .subarray(cursor + CENTRAL_HEADER_BYTES, cursor + CENTRAL_HEADER_BYTES + nameLength)
      .toString('utf8');
    cursor += CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength;

    // Directories are recorded with a trailing slash and no content.
    if (name.endsWith('/') || name.endsWith('\\')) continue;

    if (flags & FLAG_ENCRYPTED) {
      throw new ZipError(`"${name}" is encrypted — this cannot install password-protected archives`);
    }
    if (compressedSize === ZIP64_SENTINEL || uncompressedSize === ZIP64_SENTINEL) {
      throw new ZipError('ZIP64 archives are not supported — re-zip it without ZIP64');
    }
    if (!isSafeEntryName(name)) throw new ZipError(`unsafe path in archive: "${name}"`);

    /*
     * Checked against the *declared* size, before inflating, so a decompression
     * bomb is refused rather than expanded and then measured.
     */
    if (uncompressedSize > limits.maxFileBytes) {
      throw new ZipError(`"${name}" unpacks to ${uncompressedSize} bytes, over the ${limits.maxFileBytes} limit`);
    }
    total += uncompressedSize;
    if (total > limits.maxTotalBytes) {
      throw new ZipError(`the archive unpacks to more than the ${limits.maxTotalBytes} byte limit`);
    }

    if (readUInt32(buf, localOffset) !== LOCAL_SIGNATURE) {
      throw new ZipError(`corrupt archive — bad header for "${name}"`);
    }
    /*
     * The local header's own name and extra lengths, not the central copy.
     * They are allowed to differ — the extra field routinely does, since the
     * local and central records carry different optional blocks — and using the
     * central length here would start reading the data at the wrong offset.
     */
    const localNameLength = readUInt16(buf, localOffset + 26);
    const localExtraLength = readUInt16(buf, localOffset + 28);
    const dataStart = localOffset + LOCAL_HEADER_BYTES + localNameLength + localExtraLength;
    if (dataStart + compressedSize > buf.length) throw new ZipError(`truncated data for "${name}"`);

    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    let bytes: Buffer;
    if (method === METHOD_STORED) {
      bytes = Buffer.from(raw);
    } else if (method === METHOD_DEFLATE) {
      try {
        bytes = inflateRawSync(raw, { maxOutputLength: limits.maxFileBytes });
      } catch (error) {
        throw new ZipError(`could not decompress "${name}": ${(error as Error).message}`);
      }
    } else {
      throw new ZipError(`"${name}" uses compression method ${method}, which is not supported`);
    }

    /*
     * The CRC is already in the archive, so checking it is nearly free and
     * turns a half-downloaded zip into a clear message rather than a package
     * that installs and then fails to parse for reasons nobody can see.
     */
    if (crc32(bytes) !== expectedCrc) throw new ZipError(`"${name}" is corrupt — checksum does not match`);

    entries.push({ name, bytes });
  }

  return entries;
}

/**
 * Strip a single wrapping folder, the way an unzip tool offers to.
 *
 * Archives are made both ways — `weather/module.json` and a bare `module.json`
 * at the root — and which one you get depends on whether the author zipped the
 * folder or its contents. Requiring one spelling would reject half of all
 * correctly-built packages for a reason invisible from the outside.
 *
 * Only when *every* entry shares the prefix, so an archive with a real file
 * beside the folder is left exactly as it is rather than quietly losing it.
 */
export function stripCommonPrefix(entries: ZipEntry[]): ZipEntry[] {
  if (entries.length === 0) return entries;

  const first = entries[0]!.name.split('/')[0];
  if (!first) return entries;
  if (!entries.every((entry) => entry.name.startsWith(`${first}/`))) return entries;

  return entries.map((entry) => ({ ...entry, name: entry.name.slice(first.length + 1) }));
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

export interface ZipFile {
  /** Forward slashes, relative. A folder is implied by a name containing one. */
  name: string;
  bytes: Buffer;
}

/**
 * Write a zip, for the notes exporter.
 *
 * Writing is the easy direction and shares the reader's constants, which is the
 * whole reason it lives here: two modules for one format is how the signature
 * for a central directory header ends up written down twice and wrong once.
 *
 * Deflate rather than stored, because a vault is Markdown and Markdown
 * compresses to roughly a fifth — and a zip that is five times larger than it
 * needs to be is a worse download for no gain. An entry that grows under
 * compression, which a JPEG will, is stored instead: the format allows either
 * per entry and the smaller of the two is free to pick.
 *
 * **No ZIP64**, matching the reader. Four gigabytes of notes is not a case to
 * design for, and an archive that silently exceeded it would be one this app
 * could not read back.
 */
export function writeZip(files: ZipFile[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  const { date, time } = dosStamp(new Date());

  for (const file of files) {
    // `split` on a one-character string rather than a regex, so this file
    // carries no backslash escaping to get wrong — the same call
    // `looksLikeGameInstall` makes for the same reason.
    const name = Buffer.from(file.name.split(String.fromCharCode(92)).join('/'), 'utf8');
    const sum = crc32(file.bytes) >>> 0;

    const deflated = deflateRawSync(file.bytes, { level: 6 });
    // Deflate is only used when it actually won. A JPEG deflates to slightly
    // *more* than it started as, and storing it back is one byte of header
    // versus a pointless round trip through zlib on the way out.
    const useDeflate = deflated.length < file.bytes.length;
    const payload = useDeflate ? deflated : file.bytes;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0, which is deflate
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(file.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // no extra field

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(file.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, payload);
    centrals.push(central, name);
    offset += local.length + name.length + payload.length;
  }

  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, eocd]);
}

/**
 * Bit 11 — the names in this archive are UTF-8.
 *
 * Without it a note called "Café" unpacks with a mangled name on any machine
 * whose code page is not the one it was written on, which is most of them.
 */
const FLAG_UTF8 = 0x0800;

/**
 * MS-DOS date and time, which is what the format has stored since 1989.
 *
 * Two seconds of resolution and an epoch of 1980, so anything earlier is
 * clamped rather than wrapping into a date in the future.
 */
function dosStamp(at: Date): { date: number; time: number } {
  const year = Math.max(1980, at.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
  };
}
