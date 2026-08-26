/**
 * Parsing JSON that a person on Windows wrote.
 *
 * `JSON.parse` refuses a byte-order mark. Nothing in the spec allows one, and
 * that would be a fine place to leave it if the files in question were written
 * by machines — but the two this app reads by hand are `features.json` and a
 * package's `module.json`, and both are meant to be edited by a person on a
 * Windows PC.
 *
 * Every obvious tool there produces a BOM. Notepad's "UTF-8" did for years,
 * and Windows PowerShell's `Out-File -Encoding utf8` and `>` still do — found
 * exactly that way, building a test package with `Out-File` and watching the
 * install fail on `Unexpected token '﻿'`, which prints as an invisible
 * character and is about as unhelpful as an error message gets.
 *
 * So the BOM is stripped rather than rejected. It is not laxness about the
 * format: a leading U+FEFF is *encoding* metadata rather than content, and the
 * alternative is an app that refuses a file which every editor on the platform
 * says is valid UTF-8.
 */

/** U+FEFF, as it appears once the bytes have been decoded as UTF-8. */
const BOM = '﻿';

/**
 * `JSON.parse`, tolerant of a leading byte-order mark.
 *
 * Deliberately not tolerant of anything else — no comments, no trailing commas.
 * Those are real syntax errors that a person can see and fix, whereas a BOM is
 * invisible in every editor that writes one.
 */
export function parseJsonText(text: string): unknown {
  return JSON.parse(text.startsWith(BOM) ? text.slice(BOM.length) : text) as unknown;
}
