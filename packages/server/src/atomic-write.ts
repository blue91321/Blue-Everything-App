/**
 * Writing a file so that it is either the old one or the new one, never half.
 *
 * Every store this app keeps on disk (the manga library, trips, blueprints,
 * the calendar, each small settings file) is written through here: the bytes
 * go to `<file>.tmp` beside it and are renamed into place. A process dying
 * mid-write leaves the old file whole, where a plain `writeFileSync` would
 * leave a truncated one that reads as empty.
 *
 * **The rename is tried again when Windows refuses it.** Something else
 * holding the file for an instant (OneDrive syncing the folder, a virus
 * scanner) makes the rename fail with EPERM, EBUSY or EACCES. That was first
 * seen in the manga archive, mid-chapter, with the app in a OneDrive folder,
 * and it applies to every file written this way. There were about twenty
 * copies of this code, three of which retried and each differently; this is
 * the one copy.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** What Windows answers while another program holds the file for a moment. */
const HELD = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** Ten more tries, waiting a little longer each time: about 2.7 seconds in all. */
const RETRIES = 10;
const WAIT_STEP_MS = 50;

/** A short synchronous wait. The callers are synchronous, and so is every store's read-change-write. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Write `data` to `path` whole, making the folder if it is not there.
 *
 * Throws what the filesystem threw once the retries are spent, or at once for
 * any other error.
 */
export function writeFileAtomic(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, data);
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temp, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (attempt >= RETRIES || !HELD.has(code)) throw error;
      pause(WAIT_STEP_MS * (attempt + 1));
    }
  }
}
