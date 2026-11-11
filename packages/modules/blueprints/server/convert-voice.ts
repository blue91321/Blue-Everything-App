/**
 * Voice commands from before they were blueprints, made into one each, once.
 *
 * Voice used to keep its commands in `voice_commands`: a phrase, a kind (tick a
 * habit, open a site, press keys, a media key, start a game, play music, make
 * a note) and a target. Those are blueprints now (2026-10-29): a *When I say*
 * box joined to the Do box that does the same thing. "Stop listening" and
 * "never mind" are not converted, because they act on the microphone itself
 * and stay voice's own, so it can always be silenced by voice.
 *
 * **Once, recorded in a file of its own** (`data/blueprints-voice.json`, the ids
 * converted), so a converted blueprint deleted afterwards does not come back at
 * the next start. The rows are left where they are, as the record of what
 * there was; voice no longer reads any but its own two kinds.
 *
 * Phrases typed into a habit's own editor are converted too. That box wrote
 * to `habits.voice_phrases`, which voice stopped reading when commands got a
 * table of their own, so phrases added there since had done nothing at all.
 * One already covered by a command for that habit is not made twice.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { asc } from 'drizzle-orm';
import { dataDir, db, games, habits, voiceCommands } from '@everything/server/module-api';
import type { Blueprint } from '../web/engine.js';
import { graphFor, nameFor, newId, type OldCommand } from './rules.js';

const DONE_FILE = join(dataDir, 'blueprints-voice.json');

/** The kinds that become blueprints; the rest are voice's own. */
const CONVERTED = new Set(['habit', 'url', 'hotkey', 'media', 'launch', 'music', 'note']);

function parse(raw: string): string[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string' && p.trim() !== '') : [];
  } catch {
    return [];
  }
}

function doneIds(): Set<string> {
  if (!existsSync(DONE_FILE)) return new Set();
  try {
    const value = JSON.parse(readFileSync(DONE_FILE, 'utf8').replace(/^﻿/, '')) as { converted?: unknown };
    return new Set(Array.isArray(value.converted) ? value.converted.map(String) : []);
  } catch {
    // A damaged record would otherwise make everything again; better to make
    // nothing and say so on the next look than to double every command.
    return new Set(['*']);
  }
}

/**
 * Make what has not been made yet. Returns the new blueprints for the caller to
 * add and save, and `commit` to call once they are saved: the record is written
 * only then, so a save that fails leaves them to be made next time rather than
 * marked done and lost.
 */
export async function convertVoiceCommands(): Promise<{ made: Blueprint[]; commit: () => void }> {
  const done = doneIds();
  if (done.has('*')) return { made: [], commit: () => {} };
  const rows = await db.select().from(voiceCommands).orderBy(asc(voiceCommands.sortOrder));
  const habitRows = await db.select({ id: habits.id, name: habits.name, phrases: habits.voicePhrases }).from(habits);
  const gameRows = await db.select({ exe: games.exe, label: games.label }).from(games);
  const habitName = new Map(habitRows.map((h) => [h.id, h.name]));
  const gameName = new Map(gameRows.map((g) => [g.exe, g.label]));

  const commands: OldCommand[] = rows
    .filter((r) => CONVERTED.has(r.kind))
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      phrases: parse(r.phrases),
      target: r.target,
      label: r.label,
      enabled: Boolean(r.enabled),
      allowFollowUp: Boolean(r.allowFollowUp),
    }));

  // A habit's own phrases, less any a command for it already had.
  for (const habit of habitRows) {
    const covered = new Set(
      commands.filter((c) => c.kind === 'habit' && c.target === habit.id).flatMap((c) => c.phrases.map((p) => p.toLowerCase()))
    );
    const left = parse(habit.phrases).filter((p) => !covered.has(p.toLowerCase()));
    if (left.length) {
      commands.push({ id: `habit:${habit.id}`, kind: 'habit', phrases: left, target: habit.id, label: habit.name, enabled: true, allowFollowUp: true });
    }
  }

  const now = Date.now();
  const made: Blueprint[] = [];
  const converted = [...done];
  for (const command of commands) {
    if (done.has(command.id)) continue;
    converted.push(command.id);
    const graph = graphFor(command);
    if (!graph) continue;
    made.push({
      id: newId(),
      name: nameFor(command, habitName.get(command.target ?? ''), gameName.get((command.target ?? '').toLowerCase())),
      // On if the command was, so voice does on the day this lands what it did
      // the day before.
      enabled: command.enabled,
      graph,
      stopped: null,
      createdAt: now,
      updatedAt: now,
    });
  }
  const fresh = converted.length > done.size;
  return { made, commit: () => fresh && markConverted(converted) };
}

function markConverted(ids: string[]): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(DONE_FILE, `${JSON.stringify({ converted: [...new Set(ids)], at: new Date().toISOString() }, null, 2)}\n`, 'utf8');
}

/** The kinds that become blueprints, for the check. */
export const voiceKindsConverted = CONVERTED;
