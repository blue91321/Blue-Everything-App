/**
 * Apple's binary property lists, and the archived objects inside them.
 *
 * An iOS app's saved state is very often a `bplist00` file written by
 * `NSKeyedArchiver` — Manga Reader keeps its whole library that way. Reading it
 * is two small formats stacked: the binary plist (a table of typed objects with
 * an offset table and a 32-byte trailer), and the archiver's object graph laid
 * out inside it (`$objects`, with `UID` references between them).
 *
 * Hand-rolled, like `zip.ts` and the PNG and WAV writers: the formats are
 * short, fully documented, and a library would be third-party code sitting in
 * the path of a file somebody hands the app. Everything is bounds-checked, and
 * a reference cycle is refused rather than followed — both formats allow one
 * and a hostile file would use it.
 */

export class PlistError extends Error {}

/** A reference into an archive's `$objects` — the archiver's pointer. */
export class Uid {
  constructor(readonly index: number) {}
}

export type PlistValue =
  | null
  | boolean
  | number
  | string
  | Date
  | Uint8Array
  | Uid
  | PlistValue[]
  | { [key: string]: PlistValue };

/** Seconds from the Unix epoch to Apple's, 2001-01-01. */
const APPLE_EPOCH_S = 978_307_200;

/** Far more than any real app's state, and far less than a file could claim. */
const MAX_OBJECTS = 2_000_000;

export function readBinaryPlist(buf: Buffer): PlistValue {
  if (buf.length < 40 || buf.toString('latin1', 0, 8) !== 'bplist00') {
    throw new PlistError('not a binary property list');
  }
  const trailer = buf.length - 32;
  const offsetSize = buf[trailer + 6];
  const refSize = buf[trailer + 7];
  const count = Number(buf.readBigUInt64BE(trailer + 8));
  const top = Number(buf.readBigUInt64BE(trailer + 16));
  const tableAt = Number(buf.readBigUInt64BE(trailer + 24));
  if (
    offsetSize < 1 || offsetSize > 8 || refSize < 1 || refSize > 8 ||
    count < 1 || count > MAX_OBJECTS || top >= count ||
    tableAt < 8 || tableAt + count * offsetSize > trailer
  ) {
    throw new PlistError('the property list trailer does not describe this file');
  }

  const uint = (at: number, size: number): number => {
    if (at + size > buf.length) throw new PlistError('read past the end of the file');
    let n = 0;
    for (let i = 0; i < size; i++) n = n * 256 + buf[at + i];
    return n;
  };

  const offsets = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    const at = uint(tableAt + i * offsetSize, offsetSize);
    if (at < 8 || at >= tableAt) throw new PlistError('an object offset points outside the object area');
    offsets[i] = at;
  }

  const done = new Map<number, PlistValue>();
  const inProgress = new Set<number>();

  /** A marker's length: its low nibble, or an integer object after it when that is 0xF. */
  const lengthAt = (at: number): { length: number; start: number } => {
    const info = buf[at] & 0x0f;
    if (info !== 0x0f) return { length: info, start: at + 1 };
    const marker = buf[at + 1];
    if (marker >> 4 !== 0x1) throw new PlistError('a length is not an integer');
    const size = 1 << (marker & 0x0f);
    return { length: uint(at + 2, size), start: at + 2 + size };
  };

  const object = (index: number): PlistValue => {
    if (index < 0 || index >= count) throw new PlistError('a reference points to no object');
    const cached = done.get(index);
    if (cached !== undefined) return cached;
    if (inProgress.has(index)) throw new PlistError('the property list refers to itself');
    inProgress.add(index);

    const at = offsets[index];
    const marker = buf[at];
    const type = marker >> 4;
    const info = marker & 0x0f;
    let value: PlistValue;

    switch (type) {
      case 0x0:
        if (info === 0x8) value = false;
        else if (info === 0x9) value = true;
        else value = null;
        break;
      case 0x1: {
        const size = 1 << info;
        if (size > 8) throw new PlistError('integers wider than 64 bits are not supported');
        if (at + 1 + size > buf.length) throw new PlistError('read past the end of the file');
        // 8-byte integers are signed; smaller ones are not.
        value = size === 8 ? Number(buf.readBigInt64BE(at + 1)) : uint(at + 1, size);
        break;
      }
      case 0x2: {
        const size = 1 << info;
        if (size === 4) value = buf.readFloatBE(at + 1);
        else if (size === 8) value = buf.readDoubleBE(at + 1);
        else throw new PlistError('a real of an unknown width');
        break;
      }
      case 0x3:
        value = new Date((buf.readDoubleBE(at + 1) + APPLE_EPOCH_S) * 1000);
        break;
      case 0x4: {
        const { length, start } = lengthAt(at);
        if (start + length > buf.length) throw new PlistError('data runs past the end of the file');
        value = new Uint8Array(buf.subarray(start, start + length));
        break;
      }
      case 0x5: {
        const { length, start } = lengthAt(at);
        if (start + length > buf.length) throw new PlistError('a string runs past the end of the file');
        value = buf.toString('latin1', start, start + length);
        break;
      }
      case 0x6: {
        const { length, start } = lengthAt(at);
        if (start + length * 2 > buf.length) throw new PlistError('a string runs past the end of the file');
        // UTF-16, big-endian; Node only decodes the little-endian kind.
        const swapped = Buffer.from(buf.subarray(start, start + length * 2));
        swapped.swap16();
        value = swapped.toString('utf16le');
        break;
      }
      case 0x8:
        value = new Uid(uint(at + 1, info + 1));
        break;
      case 0xa:
      case 0xc: {
        // Arrays and sets alike: the difference does not survive into JSON.
        const { length, start } = lengthAt(at);
        const list: PlistValue[] = [];
        for (let i = 0; i < length; i++) list.push(object(uint(start + i * refSize, refSize)));
        value = list;
        break;
      }
      case 0xd: {
        const { length, start } = lengthAt(at);
        const dict: { [key: string]: PlistValue } = {};
        for (let i = 0; i < length; i++) {
          const key = object(uint(start + i * refSize, refSize));
          if (typeof key !== 'string') throw new PlistError('a dictionary key is not a string');
          dict[key] = object(uint(start + (length + i) * refSize, refSize));
        }
        value = dict;
        break;
      }
      default:
        throw new PlistError(`an object of unknown type 0x${type.toString(16)}`);
    }

    inProgress.delete(index);
    done.set(index, value);
    return value;
  };

  return object(top);
}

/**
 * What `NSKeyedArchiver` wrote, as plain values: dictionaries for archived
 * objects (with their class name under `$class`), arrays for arrays and sets,
 * strings, numbers, dates. Returns the archive's `$top`.
 */
export function unarchive(buf: Buffer): { [key: string]: unknown } {
  const root = readBinaryPlist(buf);
  if (!isDict(root) || root.$archiver !== 'NSKeyedArchiver' || !Array.isArray(root.$objects) || !isDict(root.$top)) {
    throw new PlistError('not an archived object graph');
  }
  const objects = root.$objects;
  const done = new Map<number, unknown>();
  const inProgress = new Set<number>();

  const resolve = (value: PlistValue): unknown => (value instanceof Uid ? follow(value.index) : value);

  const follow = (index: number): unknown => {
    if (index < 0 || index >= objects.length) throw new PlistError('an archive reference points to no object');
    if (done.has(index)) return done.get(index);
    if (inProgress.has(index)) throw new PlistError('the archive refers to itself');
    inProgress.add(index);

    const raw = objects[index];
    let value: unknown;
    if (raw === '$null') value = null;
    else if (isDict(raw)) {
      if (Array.isArray(raw['NS.keys']) && Array.isArray(raw['NS.objects'])) {
        const out: { [key: string]: unknown } = {};
        raw['NS.keys'].forEach((k, i) => {
          out[String(resolve(k))] = resolve((raw['NS.objects'] as PlistValue[])[i]);
        });
        value = out;
      } else if (Array.isArray(raw['NS.objects'])) {
        value = raw['NS.objects'].map(resolve);
      } else if (typeof raw['NS.string'] === 'string') {
        value = raw['NS.string'];
      } else if (typeof raw['NS.time'] === 'number') {
        value = new Date((raw['NS.time'] + APPLE_EPOCH_S) * 1000);
      } else {
        const out: { [key: string]: unknown } = {};
        for (const [key, field] of Object.entries(raw)) {
          if (key === '$class') {
            const cls = resolve(field as PlistValue);
            out.$class = isDict(cls as PlistValue) ? (cls as { $classname?: unknown }).$classname : null;
          } else {
            out[key] = resolve(field);
          }
        }
        value = out;
      }
    } else {
      value = raw;
    }

    inProgress.delete(index);
    done.set(index, value);
    return value;
  };

  const out: { [key: string]: unknown } = {};
  for (const [key, value] of Object.entries(root.$top)) out[key] = resolve(value);
  return out;
}

function isDict(value: PlistValue | undefined): value is { [key: string]: PlistValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date) &&
    !(value instanceof Uint8Array) && !(value instanceof Uid);
}
