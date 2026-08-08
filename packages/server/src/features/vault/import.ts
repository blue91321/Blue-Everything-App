/**
 * Importing a password export.
 *
 * The file this parses is the single most dangerous thing that will ever touch
 * this app: every password the browser holds, in plaintext. It is therefore
 * handled entirely in memory — never written to disk, never logged, never
 * echoed back in a response — and the UI tells Blake to delete the file
 * afterwards, which is the part that actually matters.
 */
import type { VaultItemInput } from '@everything/shared';

/**
 * A correct-enough CSV reader.
 *
 * Password exports routinely contain commas inside notes, quotes inside
 * passwords, and newlines inside both, so splitting on commas would quietly
 * corrupt exactly the entries that are hardest to notice are wrong.
 */
export function parseCsv(text: string): string[][] {
  // Excel and several exporters prepend a BOM, which would otherwise become
  // part of the first header name and break every column lookup.
  const input = text.replace(/^﻿/, '');

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        // "" inside a quoted field is a literal quote.
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\r') {
      // Swallow; the \n that follows ends the row.
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  // Whatever is left when the text runs out is a final row, unless it's empty.
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

interface Mapping {
  title?: string;
  url?: string;
  username?: string;
  password?: string;
  notes?: string;
  totp?: string;
}

interface Format {
  name: string;
  matches: (headers: string[]) => boolean;
  mapping: Mapping;
}

/**
 * Ordered most specific first — Bitwarden's columns would otherwise be caught
 * by the looser generic checks below it.
 */
const FORMATS: Format[] = [
  {
    name: 'Bitwarden',
    matches: (h) => h.includes('login_username') && h.includes('login_password'),
    mapping: { title: 'name', url: 'login_uri', username: 'login_username', password: 'login_password', notes: 'notes', totp: 'login_totp' },
  },
  {
    name: 'Firefox',
    matches: (h) => h.includes('url') && h.includes('password') && (h.includes('httprealm') || h.includes('formactionorigin')),
    mapping: { url: 'url', username: 'username', password: 'password' },
  },
  {
    name: 'Chrome, Brave or Edge',
    matches: (h) => h.includes('name') && h.includes('url') && h.includes('username') && h.includes('password'),
    mapping: { title: 'name', url: 'url', username: 'username', password: 'password', notes: 'note' },
  },
  {
    name: 'Safari',
    matches: (h) => h.includes('title') && h.includes('url') && h.includes('password'),
    mapping: { title: 'title', url: 'url', username: 'username', password: 'password', notes: 'notes', totp: 'otpauth' },
  },
  {
    name: 'KeePass',
    matches: (h) => h.includes('account') && h.includes('login name') && h.includes('password'),
    mapping: { title: 'account', url: 'web site', username: 'login name', password: 'password', notes: 'comments' },
  },
];

/** Last resort: find columns by what their names contain. */
function guessMapping(headers: string[]): Mapping | null {
  const find = (...needles: string[]) =>
    headers.find((header) => needles.some((needle) => header.includes(needle)));

  const password = find('password', 'pass');
  if (!password) return null;

  return {
    password,
    username: find('username', 'user', 'login', 'email'),
    url: find('url', 'uri', 'site', 'website', 'host'),
    title: find('name', 'title', 'account'),
    notes: find('note', 'comment'),
  };
}

export interface ImportPreview {
  format: string;
  entries: VaultItemInput[];
  /** Rows that had no password, or no usable columns at all. */
  skipped: number;
}

const EMPTY: VaultItemInput = { title: '', username: '', password: '', url: '', notes: '', totp: '' };

/** Fall back to the site name when the export has no title column. */
function titleFromUrl(url: string): string {
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).hostname.replace(/^www\./, '');
  } catch {
    return url || 'Untitled';
  }
}

export function readExport(csv: string): ImportPreview {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new Error('that file has no rows in it');

  const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ''));
  const format = FORMATS.find((candidate) => candidate.matches(headers));
  const mapping = format?.mapping ?? guessMapping(headers);

  if (!mapping) {
    throw new Error('could not find a password column — is this a password export?');
  }

  const column = (name: string | undefined): number => (name ? headers.indexOf(name) : -1);
  const indexes = {
    title: column(mapping.title),
    url: column(mapping.url),
    username: column(mapping.username),
    password: column(mapping.password),
    notes: column(mapping.notes),
    totp: column(mapping.totp),
  };

  const entries: VaultItemInput[] = [];
  let skipped = 0;

  for (const row of rows.slice(1)) {
    const cell = (index: number) => (index >= 0 ? (row[index] ?? '').trim() : '');
    const password = cell(indexes.password);

    // A row with no password is a browser "never save" marker or a note-only
    // record; importing it would create a useless entry.
    if (!password) {
      skipped++;
      continue;
    }

    const url = cell(indexes.url);
    entries.push({
      ...EMPTY,
      title: cell(indexes.title) || titleFromUrl(url),
      url,
      username: cell(indexes.username),
      password,
      notes: cell(indexes.notes),
      totp: cell(indexes.totp),
    });
  }

  return { format: format?.name ?? 'unrecognised layout', entries, skipped };
}

/** Same site and same username — almost certainly the same login. */
export function isDuplicate(a: VaultItemInput, b: VaultItemInput): boolean {
  const host = (value: string) => {
    try {
      return new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return value.trim().toLowerCase();
    }
  };
  return host(a.url) === host(b.url) && a.username.trim().toLowerCase() === b.username.trim().toLowerCase();
}
