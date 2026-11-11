/**
 * The app's own source, as files a screen can list, read and write.
 *
 * Everything the Code screen touches goes through here, and the rule that
 * makes it safe is the first function: **only files the repository itself
 * ships are offered.** `git ls-files` says which (tracked, plus new files git
 * would not ignore), and a release zip says the same thing in
 * `release-files.txt`. So `data/`, the database, `.env`, the agent's token and
 * every installed package are never listed, because none of them are in
 * either, and a path not on the list is refused before anything is opened.
 * `SECRET` refuses the worst of them again by name, in case a rule in
 * `.gitignore` ever stops matching; publish-check exists because that has
 * happened twice.
 *
 * **Git is run, which the server otherwise avoids.** It is not a Windows tool
 * and is run the same way on every platform, with its arguments as a list and
 * no shell. Without it (a release zip, or Docker, where there is no checkout
 * to edit), the list comes from `release-files.txt` and "changed since the last
 * commit" is simply not known.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Larger than this is not opened: CLAUDE.md is half of it. */
export const MAX_BYTES = 1_500_000;

/**
 * Never offered, whatever a list says. Anchored where a name means a place in
 * the checkout (`modules/` at the root is installed packages; the shipped ones
 * are `packages/modules/`).
 */
const SECRET =
  /(^|\/)\.env(\.(?!example$)[^/]*)?$|(^|\/)(agent\.config\.json|features\.json|modules\.json|host-key|invites\.json)$|^(modules|instances|logs|backups|runtime|data)\/|(^|\/)(node_modules|data)\/|\.(db|db-journal|db-wal|db-shm|sqlite)$/i;

/** Shown, and not written, with the reason on screen. */
const READ_ONLY: Array<[RegExp, string]> = [
  [
    /^packages\/server\/drizzle\//,
    'A migration that has already run is never run again, so changing it would change nothing. A new one is a new file.',
  ],
  [/(^|\/)package-lock\.json$/, 'npm writes this one itself.'],
];

export function readOnlyReason(path: string): string | null {
  return READ_ONLY.find(([rule]) => rule.test(path))?.[1] ?? null;
}

export function isSecret(path: string): boolean {
  return SECRET.test(path);
}

export type Changed = 'changed' | 'new';

export interface Listing {
  /** Where the list came from; null when there is no list at all. */
  source: 'git' | 'release' | null;
  files: string[];
  changed: Map<string, Changed>;
}

/** The checkout's own list, refreshed at most every few seconds. */
let cache: { at: number; root: string; listing: Listing } | null = null;
const CACHE_MS = 3_000;

export function forgetListing(): void {
  cache = null;
}

export async function listing(root: string): Promise<Listing> {
  if (cache && cache.root === root && Date.now() - cache.at < CACHE_MS) return cache.listing;
  const value = await readListing(root);
  cache = { at: Date.now(), root, listing: value };
  return value;
}

async function readListing(root: string): Promise<Listing> {
  if (existsSync(resolve(root, '.git'))) {
    try {
      const options = { cwd: root, maxBuffer: 32 * 1024 * 1024, windowsHide: true } as const;
      const [files, status] = await Promise.all([
        run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], options),
        run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], options),
      ]);
      return {
        source: 'git',
        // A file deleted but not yet committed is still in the index.
        files: tidy(files.stdout.split('\0')).filter((path) => existsSync(resolve(root, path))),
        changed: parseStatus(status.stdout),
      };
    } catch {
      // git is not installed, or this is not a checkout it can read: fall through.
    }
  }
  const shipped = resolve(root, 'release-files.txt');
  if (existsSync(shipped)) {
    const lines = readFileSync(shipped, 'utf8').replace(/^﻿/, '').split(/\r?\n/);
    return { source: 'release', files: tidy(lines).filter((path) => existsSync(resolve(root, path))), changed: new Map() };
  }
  return { source: null, files: [], changed: new Map() };
}

function tidy(paths: string[]): string[] {
  const out = new Set<string>();
  for (const raw of paths) {
    const path = raw.trim().replace(/\\/g, '/');
    if (path && !isSecret(path)) out.add(path);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/**
 * `git status --porcelain -z`: `XY path`, and a rename or copy carries the old
 * path as the next entry, which is skipped.
 */
export function parseStatus(raw: string): Map<string, Changed> {
  const out = new Map<string, Changed>();
  const entries = raw.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code.includes('R') || code.includes('C')) i += 1;
    if (code.includes('D')) continue;
    out.set(path, code === '??' || code.includes('A') ? 'new' : 'changed');
  }
  return out;
}

export class CodeError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

/** A path from a request, refused unless it is on the list. */
export async function knownPath(root: string, raw: unknown): Promise<string> {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 400) throw new CodeError('that is not a file path');
  const path = raw.replace(/\\/g, '/');
  if (isSecret(path)) throw new CodeError('that file is not shown here', 403);
  const { files } = await listing(root);
  if (!files.includes(path)) throw new CodeError('that file is not part of the app', 404);
  return path;
}

export const versionOf = (bytes: Buffer): string => createHash('sha1').update(bytes).digest('hex');

export interface OpenedFile {
  path: string;
  size: number;
  version: string;
  /** Null when it cannot be shown as text: too large, or not text at all. */
  text: string | null;
  why?: string;
  readOnly: string | null;
}

/** A NUL byte in the first few kilobytes is what git takes to mean "binary". */
const looksBinary = (bytes: Buffer): boolean => bytes.subarray(0, 8000).includes(0);

export function openFile(root: string, path: string): OpenedFile {
  const full = resolve(root, path);
  const size = statSync(full).size;
  if (size > MAX_BYTES) {
    return { path, size, version: '', text: null, why: 'This file is too large to open here.', readOnly: 'too large' };
  }
  const bytes = readFileSync(full);
  if (looksBinary(bytes)) {
    return { path, size, version: versionOf(bytes), text: null, why: 'This is a picture or other file that is not text.', readOnly: 'not text' };
  }
  return { path, size, version: versionOf(bytes), text: decode(bytes), readOnly: readOnlyReason(path) };
}

/** As the screen edits it: no byte-order mark, and `\n` for every line end. */
export function decode(bytes: Buffer): string {
  return bytes.toString('utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
}

/**
 * Back to the file's own conventions. Its line ends are kept, so saving one
 * line of a CRLF file does not rewrite every line of it in git's eyes; its
 * byte-order mark is kept; and every PowerShell script gets one, because
 * Windows PowerShell 5.1 reads a script without it as ANSI and an em dash then
 * stops it parsing (publish-check refuses the same).
 */
export function encode(path: string, text: string, previous: Buffer | null): Buffer {
  let out = text.replace(/\r\n/g, '\n');
  if (previous && previous.includes('\r\n')) out = out.replace(/\n/g, '\r\n');
  const bom = (previous !== null && previous.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) || /\.ps1$/i.test(path);
  return Buffer.concat([bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(out, 'utf8')]);
}

export type Saved = { saved: true; version: string } | { saved: false; conflict: true; version: string };

/**
 * Written only if it is still the version the screen opened, so a change made
 * meanwhile somewhere else (an editor, a `git pull`) is not silently undone.
 * Through a temporary file and a rename, retried a few times: OneDrive holds
 * files for a moment after they change, and a refused rename is how that shows.
 */
export async function saveFile(root: string, path: string, text: string, version: string): Promise<Saved> {
  const full = resolve(root, path);
  const previous = readFileSync(full);
  const current = versionOf(previous);
  if (current !== version) return { saved: false, conflict: true, version: current };
  const bytes = encode(path, text, previous);
  const temp = `${full}.code-save`;
  writeFileSync(temp, bytes);
  await renameWithRetry(temp, full);
  forgetListing();
  return { saved: true, version: versionOf(bytes) };
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  const until = Date.now() + 3_000;
  for (;;) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'EPERM' && code !== 'EBUSY') || Date.now() > until) throw error;
      await new Promise((done) => setTimeout(done, 100));
    }
  }
}

/** What the file was at the last commit, or null for a file git has never had. */
export async function committedText(root: string, path: string): Promise<string | null> {
  if (!existsSync(resolve(root, '.git'))) return null;
  try {
    const { stdout } = await run('git', ['show', `HEAD:${path}`], {
      cwd: root,
      encoding: 'buffer',
      maxBuffer: MAX_BYTES * 2,
      windowsHide: true,
    });
    return decode(stdout as unknown as Buffer);
  } catch {
    return null;
  }
}

export interface Problem {
  line: number;
  column: number;
  message: string;
}

const LOADERS: Record<string, 'ts' | 'tsx' | 'js' | 'jsx'> = {
  ts: 'ts',
  mts: 'ts',
  cts: 'ts',
  tsx: 'tsx',
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'jsx',
};

/**
 * A mistake that would stop the app starting, found before it is saved.
 *
 * Only *syntax*: a missing brace, an unclosed string. That is the mistake that
 * matters here, because the server runs through tsx and the PWA builds through
 * Vite, and neither checks types — but both stop at a file that does not
 * parse, and a server that will not start is one this screen cannot then be
 * used to repair. esbuild is already installed (tsx runs on it), and parses a
 * file in a few milliseconds. JSON is parsed as JSON.
 */
export async function syntaxProblem(path: string, text: string): Promise<Problem | null> {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  if (extension === 'json' || extension === 'webmanifest') {
    try {
      JSON.parse(text);
      return null;
    } catch (error) {
      const message = (error as Error).message;
      const at = /position (\d+)/.exec(message);
      const offset = at ? Number(at[1]) : 0;
      const before = text.slice(0, offset).split('\n');
      return { line: before.length, column: before.at(-1)!.length + 1, message };
    }
  }
  const loader = LOADERS[extension];
  if (!loader) return null;
  let esbuild: typeof import('esbuild');
  try {
    /*
     * tsx's own esbuild, not the one Vite brought. The server is started with
     * ESBUILD_BINARY_PATH at a labeled link of tsx's binary (so Task Manager
     * says whose it is: see node-runtime.ps1), and esbuild refuses a binary of
     * another version, which Vite's is. Vite's when tsx's cannot be found.
     */
    try {
      esbuild = createRequire(createRequire(import.meta.url).resolve('tsx/package.json'))('esbuild') as typeof import('esbuild');
    } catch {
      esbuild = await import('esbuild');
    }
  } catch {
    return null; // nothing to check with; saved as it is
  }
  try {
    await esbuild.transform(text, { loader, sourcefile: path, logLevel: 'silent', jsx: 'preserve' });
    return null;
  } catch (error) {
    const first = (error as { errors?: Array<{ text: string; location?: { line: number; column: number } | null }> }).errors?.[0];
    if (!first) return { line: 1, column: 1, message: (error as Error).message };
    return { line: first.location?.line ?? 1, column: (first.location?.column ?? 0) + 1, message: first.text };
  }
}

/** The four core folders' READMEs are headed with npm names, which say nothing to most people. */
const PLAIN_NAMES: Record<string, string> = {
  'packages/web': 'The screens (web)',
  'packages/server': 'The server',
  'packages/agent': 'The PC helper (agent)',
  'packages/shared': 'Shared rules (shared)',
};

export interface Part {
  folder: string;
  title: string;
  summary: string;
  readme: string;
}

/**
 * The parts of the app, from their READMEs: the heading and the first
 * paragraph under it. Each package's README says what it is in a sentence or
 * two, which is the map a person new to the code needs before a file tree.
 */
export function partsOf(root: string, files: string[]): Part[] {
  const out: Part[] = [];
  for (const readme of files) {
    const match = /^(packages\/(?:modules\/)?[^/]+)\/README\.md$/.exec(readme);
    if (!match) continue;
    const text = decode(readFileSync(resolve(root, readme)));
    const lines = text.split('\n');
    const title = PLAIN_NAMES[match[1]!] ?? lines.find((line) => line.startsWith('# '))?.slice(2).trim() ?? match[1]!;
    const start = lines.findIndex((line) => line.startsWith('# ')) + 1;
    const paragraph: string[] = [];
    for (const line of lines.slice(start)) {
      if (line.trim() === '') {
        if (paragraph.length) break;
        continue;
      }
      if (/^[|#`]/.test(line)) break;
      paragraph.push(line.trim());
    }
    out.push({ folder: match[1]!, title, summary: paragraph.join(' '), readme });
  }
  // The app's own pieces first, then the packages.
  return out.sort((a, b) => Number(a.folder.includes('/modules/')) - Number(b.folder.includes('/modules/')) || a.title.localeCompare(b.title));
}
