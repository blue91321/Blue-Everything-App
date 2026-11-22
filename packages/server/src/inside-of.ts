/**
 * A path made from something a request named, held inside the folder it
 * belongs in (2026-11-18).
 *
 * Every route that turns part of an address into a file (a copy's name, a
 * habit's id, a log's name) checked it against a pattern of its own first,
 * and each pattern was right. This is the second half, the same everywhere:
 * whatever the pattern let through, the resolved path must still be in the
 * folder, or it is refused. A pattern loosened later, or a route written
 * without one, cannot then reach out of the folder. GitHub's code scanning
 * asked for it in this form, a resolved path tested against its root.
 */
import { resolve, sep } from 'node:path';

export function insideOf(root: string, ...parts: string[]): string {
  const base = resolve(root);
  const path = resolve(base, ...parts);
  if (path !== base && !path.startsWith(base + sep)) {
    throw new Error(`refusing a path outside ${base}`);
  }
  return path;
}
