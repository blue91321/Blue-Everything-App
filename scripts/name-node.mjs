/**
 * Write a copy of node.exe that says what it is.
 *
 *   node scripts/name-node.mjs <node.exe> <target.exe> "Blue Everything Server"
 *
 * Called by `node-runtime.ps1`, which is the only caller and handles the
 * fallback when this refuses.
 *
 * ### Why a copy of Node needs editing at all
 *
 * The two services were two rows reading `node.exe` in Task Manager, which
 * answers none of the questions anybody asks of that list. Starting them from
 * files named `Blue Everything.exe` and `Blue Everything Server.exe` fixes the
 * **Details** tab, whose Name column is the image name — and does nothing at
 * all for the **Processes** tab, which names a background process by the
 * `FileDescription` in its version resource. Both rows there went on reading
 * "Node.js JavaScript Runtime", which is why the first attempt looked from the
 * outside like nothing had happened.
 *
 * That field lives inside the binary and there is no way to set it from
 * outside, so the binary is what gets edited.
 *
 * ### It is edited in place, and never resized
 *
 * A version resource is a tree of length-prefixed structures whose parents
 * count their children's bytes, so changing a string's length means rewriting
 * every enclosing length, the resource directory entry and the section header.
 * None of that is done here. The new name is **padded with spaces to exactly
 * the length of the old one**, so every length in the file stays true and the
 * only bytes that move are the ones being read. Trailing spaces are invisible
 * in every list that shows this.
 *
 * The cost is a hard limit: a name longer than what Node ships cannot be
 * written, and this refuses rather than truncating to something misleading.
 *
 * ### The signature is removed, not left broken
 *
 * Editing a signed binary leaves it signed *and* failing its own hash, which is
 * the shape of tampering and the thing a scanner is most entitled to dislike.
 * An unsigned binary is merely unsigned — which is what every other file this
 * app ships already is, from the release zip down to the `.cmd` files. So the
 * certificate table is dropped and the data directory entry zeroed, and the
 * result reports `NotSigned` rather than `HashMismatch`.
 *
 * The table is the last thing in the file by construction, which is asserted
 * rather than assumed: anything else means this is not the layout expected and
 * nothing is touched.
 */
import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';

const [source, target, label] = process.argv.slice(2);
if (!source || !target || !label) {
  console.error('usage: name-node.mjs <source.exe> <target.exe> <label>');
  process.exit(2);
}

const fail = (why) => {
  console.error(why);
  process.exit(1);
};

const buf = readFileSync(source);

/* ---- 1. the FileDescription value, found by its key ---- */

// By key rather than by the string Node happens to ship, so this keeps working
// across Node versions without a table of their descriptions to maintain.
const key = Buffer.from('FileDescription\0', 'utf16le');
const keyAt = buf.indexOf(key);
if (keyAt < 0) fail('no FileDescription in the version resource');
if (buf.indexOf(key, keyAt + 1) >= 0) fail('more than one FileDescription — refusing to guess which');

/*
 * struct String { WORD wLength, wValueLength, wType; WCHAR szKey[]; pad; WCHAR Value[]; }
 * wValueLength counts *characters* including the terminating null.
 */
const start = keyAt - 6;
const wLength = buf.readUInt16LE(start);
const chars = buf.readUInt16LE(start + 2);
const valueAt = (start + 6 + key.length + 3) & ~3; // aligned to a DWORD
if (valueAt + chars * 2 !== start + wLength) fail('the version resource is not laid out as expected');

const room = chars - 1; // the null stays
if (label.length > room) fail(`"${label}" is ${label.length} characters and there is room for ${room}`);

buf.write(label.padEnd(room) + '\0', valueAt, chars * 2, 'utf16le');

/* ---- 2. drop the certificate table ---- */

const pe = buf.readUInt32LE(0x3c);
if (buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') fail('not a PE file');
const magic = buf.readUInt16LE(pe + 24);
const dirs = pe + 24 + (magic === 0x20b ? 112 : 96);
const entry = dirs + 4 * 8; // IMAGE_DIRECTORY_ENTRY_SECURITY
const certAt = buf.readUInt32LE(entry);
const certSize = buf.readUInt32LE(entry + 4);

let out = buf;
if (certAt > 0) {
  // Its own offset is a file offset, and it is the tail of the file. If it is
  // anywhere else this is not the layout this was written against.
  if (certAt + certSize !== buf.length) fail('the certificate table is not at the end of the file');
  buf.writeUInt32LE(0, entry);
  buf.writeUInt32LE(0, entry + 4);
  out = buf.subarray(0, certAt);
}

/*
 * Written beside the target and renamed, so an interrupted run cannot leave
 * half a 90MB executable where the launcher expects a whole one.
 */
const temp = `${target}.part`;
try {
  writeFileSync(temp, out);
  renameSync(temp, target);
} catch (error) {
  rmSync(temp, { force: true });
  fail(`could not write ${target}: ${error.message}`);
}
console.log(`${target} — ${label}`);
