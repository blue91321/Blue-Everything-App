/**
 * Where blueprints are kept: `data/blueprints.json`, since a package cannot add
 * a table. The last runs are a second file beside it, so the log churning does
 * not rewrite what you built.
 *
 * **Folders** (2026-11-03) are kept in the same file, a name each, and a
 * blueprint names the one it is in. They only arrange the list: nothing about
 * a run looks at them.
 *
 * **A damaged file is refused, not read as empty.** Trips' reasoning: these are
 * things you made by hand, and reading a stray comma as "no blueprints" and
 * then saving would replace every one of them. The screen says so instead.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '@everything/server/module-api';
import { cleanGraph, type Blueprint, type Step } from '../web/engine.js';

export const STORE_FILE = join(dataDir, 'blueprints.json');
export const RUNS_FILE = join(dataDir, 'blueprints-runs.json');
/** "Set a variable"'s values, by name, so a count survives the app restarting. */
export const VARIABLES_FILE = join(dataDir, 'blueprints-variables.json');

/** How many runs are kept, across every blueprint. */
export const RUNS_KEPT = 100;

export interface Run {
  id: string;
  blueprint: string;
  at: number;
  /** The event box it started from. */
  from: string;
  /** A test: checks were asked for real, nothing was done. */
  dry: boolean;
  steps: Step[];
  /** Still going: it is inside a Wait or a Repeat. */
  waiting?: boolean;
  /** Started by a hotkey: a person, so not counted by the runaway guard. */
  hand?: boolean;
}

export class StoreError extends Error {}

/** A folder on the list. Blueprints name it by `id`, so renaming it moves nothing. */
export interface Folder {
  id: string;
  name: string;
}

function readJson(file: string): unknown {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8').replace(/^﻿/, '');
  try {
    return JSON.parse(text);
  } catch {
    throw new StoreError(
      `${file} could not be read, so nothing will be saved over it. Fix or move the file, then reload.`
    );
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dataDir, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  for (let tries = 0; ; tries += 1) {
    try {
      renameSync(temp, file);
      return;
    } catch (error) {
      // OneDrive or a scan holding the file for a moment; the archive learned this.
      if (tries >= 20 || !['EPERM', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    }
  }
}

export function readFolders(): Folder[] {
  const parsed = readJson(STORE_FILE) as { folders?: unknown } | null;
  const list = Array.isArray(parsed?.folders) ? parsed.folders : [];
  const seen = new Set<string>();
  return list.flatMap((raw): Folder[] => {
    const f = raw as Partial<Folder>;
    if (typeof f.id !== 'string' || !/^[\w-]{1,40}$/.test(f.id) || seen.has(f.id)) return [];
    seen.add(f.id);
    return [{ id: f.id, name: folderName(f.name) }];
  });
}

/** A folder's name as typed, tidied; blank is "New folder". */
export function folderName(raw: unknown): string {
  return typeof raw === 'string' && raw.trim() ? raw.trim().replace(/\s+/g, ' ').slice(0, 60) : 'New folder';
}

export function readBlueprints(): Blueprint[] {
  const parsed = readJson(STORE_FILE) as { blueprints?: unknown } | null;
  if (!parsed) return [];
  const list = Array.isArray(parsed.blueprints) ? parsed.blueprints : [];
  // A folder that is not there any more puts what named it back at the top.
  const folders = new Set(readFolders().map((f) => f.id));
  return list.flatMap((raw): Blueprint[] => {
    const b = raw as Partial<Blueprint>;
    if (typeof b.id !== 'string') return [];
    return [
      {
        id: b.id,
        name: typeof b.name === 'string' && b.name.trim() ? b.name.slice(0, 80) : 'Untitled',
        enabled: b.enabled === true,
        graph: cleanGraph(b.graph),
        stopped: typeof b.stopped === 'string' ? b.stopped : null,
        folder: typeof b.folder === 'string' && folders.has(b.folder) ? b.folder : null,
        createdAt: Number(b.createdAt) || Date.now(),
        updatedAt: Number(b.updatedAt) || Date.now(),
      },
    ];
  });
}

export function writeBlueprints(list: Blueprint[], folders: Folder[]): void {
  writeJson(STORE_FILE, { blueprints: list, folders });
}

export function readRuns(): Run[] {
  try {
    const parsed = readJson(RUNS_FILE) as { runs?: Run[] } | null;
    return Array.isArray(parsed?.runs) ? parsed.runs : [];
  } catch {
    // The log is a record, not something you made: a damaged one starts again.
    return [];
  }
}

export function writeRuns(runs: Run[]): void {
  writeJson(RUNS_FILE, { runs: runs.slice(-RUNS_KEPT) });
}

/** A variable's name as typed, tidied to what a `{word}` can be: letters, numbers and _. Empty if it cannot be one. */
/** One rule for a variable's name, which the board and the walk use too. */
import { variableName } from '../web/maths.js';
export { variableName };

export function readVariables(): Map<string, number | string> {
  const out = new Map<string, number | string>();
  try {
    const parsed = readJson(VARIABLES_FILE) as { variables?: Record<string, unknown> } | null;
    for (const [key, value] of Object.entries(parsed?.variables ?? {})) {
      const name = variableName(key);
      if (!name) continue;
      if (typeof value === 'number' && Number.isFinite(value)) out.set(name, value);
      else if (typeof value === 'string') out.set(name, value.slice(0, 2000));
    }
  } catch (error) {
    // Values a blueprint set, not something built by hand: a damaged file starts
    // again, and says so once.
    console.warn('[blueprints]', (error as Error).message);
  }
  return out;
}

export function writeVariables(variables: Map<string, number | string>): void {
  writeJson(VARIABLES_FILE, { variables: Object.fromEntries([...variables].sort(([a], [b]) => a.localeCompare(b))) });
}
