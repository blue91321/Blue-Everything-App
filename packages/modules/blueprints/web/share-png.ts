/**
 * A blueprint inside a PNG: the picture is the board, and the blueprint itself
 * rides in an `iTXt` chunk, which every image viewer ignores and every PNG may
 * carry. So the file is something to look at before it is opened, posted
 * anywhere an image goes, and opened back into the app as the blueprint it
 * shows. The idea is the one games use to share builds as screenshots.
 *
 * This file is the bytes only, no drawing and no DOM, so `blueprints-check`
 * asserts it: writing a chunk with its CRC, finding it again, and refusing
 * what is not one of ours.
 */

/** The chunk's keyword: what marks a PNG as carrying a blueprint. */
export const KEYWORD = 'BlueEverythingBlueprint';
export const FORMAT = 'blue-everything-blueprint';
/** Bigger than any real blueprint by far, and small enough to refuse a file that is something else. */
export const MAX_FILE = 20 * 1024 * 1024;
export const MAX_TEXT = 2 * 1024 * 1024;

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export interface Shared {
  name: string;
  graph: { nodes: unknown[]; wires: unknown[] };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const ascii = (s: string) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && SIGNATURE.every((b, i) => bytes[i] === b);
}

/** The chunks of a PNG, in order, with where each starts. */
function chunks(bytes: Uint8Array): Array<{ type: string; at: number; data: Uint8Array; whole: boolean }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Array<{ type: string; at: number; data: Uint8Array; whole: boolean }> = [];
  let at = 8;
  while (at + 12 <= bytes.length) {
    const length = view.getUint32(at);
    if (at + 12 + length > bytes.length) break;
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const whole = crc32(bytes.subarray(at + 4, at + 8 + length)) === view.getUint32(at + 8 + length);
    out.push({ type, at, data: bytes.subarray(at + 8, at + 8 + length), whole });
    at += 12 + length;
    if (type === 'IEND') break;
  }
  return out;
}

/** The PNG with the blueprint written into it, just before its end. */
export function withBlueprint(png: Uint8Array, shared: Shared): Uint8Array {
  if (!isPng(png)) throw new Error('That is not a PNG.');
  const end = chunks(png).find((c) => c.type === 'IEND');
  if (!end) throw new Error('That PNG has no end.');
  const text = new TextEncoder().encode(JSON.stringify({ format: FORMAT, version: 1, name: shared.name, graph: shared.graph }));
  // iTXt: keyword, 0, not compressed, method 0, no language, 0, no translated keyword, 0, then UTF-8.
  const data = new Uint8Array([...ascii(KEYWORD), 0, 0, 0, 0, 0, ...text]);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(ascii('iTXt'), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, end.at));
  out.set(chunk, end.at);
  out.set(png.subarray(end.at), end.at + chunk.length);
  return out;
}

/**
 * The blueprint a PNG carries, or an error in words: not a PNG, a picture with
 * no blueprint in it, or one damaged on the way. What comes back is only shaped
 * like a blueprint; the server cleans it, box by box, as it cleans anything.
 */
export function blueprintIn(bytes: Uint8Array): Shared {
  if (bytes.length > MAX_FILE) throw new Error('That file is far too big to be a shared blueprint.');
  if (!isPng(bytes)) throw new Error('That is not a PNG. A shared blueprint is a .png made by Share.');
  for (const c of chunks(bytes)) {
    if (c.type !== 'iTXt') continue;
    const zero = c.data.indexOf(0);
    if (zero < 0 || String.fromCharCode(...c.data.subarray(0, zero)) !== KEYWORD) continue;
    // Past the keyword: compression flag and method, then the language and translated keyword, each ending in 0.
    if (!c.whole) throw new Error('The blueprint in that picture is damaged.');
    if (c.data[zero + 1] !== 0) throw new Error('That blueprint was packed in a way this cannot read.');
    let at = zero + 3;
    for (let k = 0; k < 2; k++) {
      const next = c.data.indexOf(0, at);
      if (next < 0) throw new Error('The blueprint in that picture is damaged.');
      at = next + 1;
    }
    const text = c.data.subarray(at);
    if (text.length > MAX_TEXT) throw new Error('The blueprint in that picture is too big.');
    return sharedFrom(text, 'The blueprint in that picture is damaged.');
  }
  throw new Error('That picture has no blueprint in it. A shared blueprint is a .png made by Share.');
}

/** A blueprint from the JSON a picture or a code carries, checked for its shape only. */
function sharedFrom(text: Uint8Array, damaged: string): Shared {
  let parsed: { format?: unknown; name?: unknown; graph?: { nodes?: unknown; wires?: unknown } };
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(text));
  } catch {
    throw new Error(damaged);
  }
  if (parsed.format !== FORMAT || !parsed.graph || !Array.isArray(parsed.graph.nodes) || !Array.isArray(parsed.graph.wires)) {
    throw new Error(damaged);
  }
  const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim().slice(0, 80) : 'Shared blueprint';
  return { name, graph: { nodes: parsed.graph.nodes, wires: parsed.graph.wires } };
}

/* ---- As text, for the clipboard ------------------------------------------- */

/**
 * A blueprint as a line of text: its name, so it reads as what it is when
 * pasted into a chat, then `BEBP1.` and the blueprint deflated and in
 * base64url. Text because a browser re-encodes a picture put on the clipboard
 * and drops its chunks, so the picture alone would not carry the blueprint.
 * `BEBP0.` is the same uncompressed, for a browser that cannot deflate.
 */
export async function toCode(shared: Shared): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify({ format: FORMAT, version: 1, name: shared.name, graph: shared.graph }));
  const packed = await squeeze(json, 'deflate');
  const tag = packed ? 'BEBP1' : 'BEBP0';
  return `Blue Everything blueprint "${shared.name.replace(/"/g, "'")}": ${tag}.${base64url(packed ?? json)}`;
}

/** The blueprint in a pasted piece of text, wherever the code sits in it. */
export async function fromCode(text: string): Promise<Shared> {
  const found = /BEBP([01])\.([A-Za-z0-9_-]+)/.exec(text);
  if (!found) throw new Error('That is not a shared blueprint. Copy one with Copy on a blueprint first.');
  if (found[2]!.length > MAX_TEXT * 2) throw new Error('That blueprint is too big.');
  const damaged = 'That blueprint code is damaged: it may have been cut short when it was sent.';
  let bytes: Uint8Array;
  try {
    bytes = unbase64url(found[2]!);
  } catch {
    throw new Error(damaged);
  }
  if (found[1] === '1') {
    const opened = await squeeze(bytes, 'inflate').catch(() => null);
    if (!opened) throw new Error(damaged);
    bytes = opened;
  }
  if (bytes.length > MAX_TEXT) throw new Error('That blueprint is too big.');
  return sharedFrom(bytes, damaged);
}

/** Deflate or inflate with the browser's own streams; null where it has none. */
async function squeeze(bytes: Uint8Array, way: 'deflate' | 'inflate'): Promise<Uint8Array | null> {
  const Stream = way === 'deflate' ? globalThis.CompressionStream : globalThis.DecompressionStream;
  if (!Stream) {
    if (way === 'inflate') throw new Error('This browser cannot open that blueprint code.');
    return null;
  }
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new Stream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unbase64url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
