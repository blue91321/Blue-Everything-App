/**
 * What version is actually running.
 *
 * Read from `package.json` at boot rather than written into a constant here,
 * because a hand-maintained second copy is one `npm version` away from being a
 * lie — and a version number you cannot trust is worse than none, since it is
 * consulted precisely when something is confusing.
 *
 * All five packages move together and always have: they are one app, released
 * as one thing, and independent numbers would imply a cadence that does not
 * exist. So this one number describes the whole install.
 *
 * Resolved from this file's own location, never the working directory — Task
 * Scheduler starts the server in C:\Windows\System32.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

function read(): string {
  try {
    const path = resolve(dirname(fileURLToPath(import.meta.url)), '../package.json');
    return (JSON.parse(readFileSync(path, 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    // Running from a bundle that did not ship package.json. Saying so is more
    // honest than inventing a number.
    return 'unknown';
  }
}

export const VERSION = read();
