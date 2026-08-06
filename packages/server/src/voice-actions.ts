/**
 * Turning a transcript into something that happens.
 *
 * Split out of the route because this is the part with consequences and the
 * part worth testing on its own: a phrase can now tick off a habit, open a
 * site, press keys in whatever window is focused, or silence the microphone.
 * `npm run voice-check -w @everything/server` covers it.
 *
 * The division of labour is deliberate. Anything that touches *data* happens
 * here, on the server, because the server owns the database. Anything that
 * touches *this machine* — a browser, a keystroke — is returned as an
 * instruction for the agent to carry out, because the server is meant to be
 * movable and has no business assuming it runs on Blake's desk.
 */
import { and, asc, eq } from 'drizzle-orm';
import {
  matchVoiceCommand,
  matchVoiceCommandLoosely,
  parseHotkey,
  remainderAfterPhrase,
  spokenCount,
  type VoiceCandidate,
  type VoiceCommandKind,
} from '@everything/shared';
import { db } from './db/client.js';
import { habitEntries, habits, notes, settings, voiceCommands } from './db/schema.js';
import { periodKeyFor } from './routes/habits.js';
import type { Cadence } from '@everything/shared';

/** Something for the agent to do on the machine Blake is sitting at. */
export type VoiceAction =
  | { do: 'open-url'; url: string }
  | { do: 'press-keys'; keys: string }
  | { do: 'pause'; untilMs: number | null };

export interface VoiceOutcome {
  outcome:
    | 'habit-checked'
    | 'note-added'
    | 'opened'
    | 'keys-sent'
    | 'paused'
    | 'captured-as-note'
    | 'ambiguous'
    | 'no-match';
  text: string;
  /** Human-readable summary, shown in the overlay and the test readout. */
  say?: string;
  action?: VoiceAction;
  /** When more than one command matched equally well, so the agent can ask. */
  choices?: { id: string; label: string }[];
  habitId?: string;
  habitName?: string;
  doneThisPeriod?: number;
  target?: number;
  met?: boolean;
  noteId?: string;
}

export function parsePhrases(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    // A hand-edited database shouldn't take voice down with it.
    return [];
  }
}

export interface LoadedCommand {
  id: string;
  kind: VoiceCommandKind;
  phrases: string[];
  target: string | null;
  pauseMinutes: number | null;
  label: string | null;
}

export async function loadCommands(): Promise<LoadedCommand[]> {
  const rows = await db
    .select()
    .from(voiceCommands)
    .where(eq(voiceCommands.enabled, 1))
    .orderBy(asc(voiceCommands.sortOrder));

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as VoiceCommandKind,
    phrases: parsePhrases(row.phrases),
    target: row.target,
    pauseMinutes: row.pauseMinutes,
    label: row.label,
  }));
}

/** Every word any command can contain — the recogniser's whole vocabulary. */
export function vocabularyFor(commands: LoadedCommand[], wakeWord: string): string[] {
  const words = new Set<string>();
  for (const word of wakeWord.toLowerCase().split(/\s+/)) if (word) words.add(word);

  for (const command of commands) {
    for (const phrase of command.phrases) {
      for (const word of phrase.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
        if (word) words.add(word);
      }
    }
  }

  return [...words].sort();
}

async function describeHabit(habitId: string): Promise<string> {
  const [habit] = await db.select().from(habits).where(eq(habits.id, habitId));
  return habit?.name ?? 'a habit that no longer exists';
}

/**
 * Which command was that, and what should happen?
 *
 * `matchVoiceCommand` picks a single best candidate. When two commands tie on
 * the same phrase the answer is genuinely ambiguous, and guessing would be the
 * worst option — a wrongly fired hotkey is not something Blake would notice was
 * wrong. Those come back as `ambiguous` for the overlay to ask about.
 */
export async function resolveVoiceCommand(
  text: string,
  commands: LoadedCommand[],
  wakeWord: string
): Promise<VoiceOutcome> {
  const candidates: VoiceCandidate[] = commands
    .filter((command) => command.phrases.length > 0)
    .map((command) => ({ id: command.id, phrases: command.phrases }));

  let match = matchVoiceCommand(text, candidates);

  /*
   * Nothing matched outright — try again allowing the phrase's last word to
   * have been clipped, which is where speech actually gets lost.
   *
   * Only after the strict pass, and only ever to *offer* an answer: if more
   * than one command matches loosely the overlay asks rather than picking, and
   * a single loose match is flagged so it says it guessed. Silently ticking off
   * the wrong habit is the failure worth all this ceremony to avoid.
   */
  if (!match) {
    const loose = matchVoiceCommandLoosely(text, candidates);

    if (loose.length > 1) {
      return {
        outcome: 'ambiguous',
        text,
        say: 'Did you mean one of these?',
        choices: await Promise.all(
          loose.map(async (option) => {
            const command = commands.find((c) => c.id === option.id)!;
            return { id: option.id, label: await labelFor(command) };
          })
        ),
      };
    }

    if (loose.length === 1) match = loose[0];
  }

  if (!match) {
    /*
     * Heard, but not understood — and that is the end of it.
     *
     * This used to become a note. The reasoning then was that a silent drop had
     * no way to recover from, so a junk note beat losing a sentence. The
     * overlay changed that: a miss is now *visible* the moment it happens, so
     * the drop is not silent any more — and clipped speech was filing a steady
     * stream of half-sentences nobody wanted. Notes come from the `note`
     * command now, and only from it.
     */
    return { outcome: 'no-match', text, say: "Didn't catch that" };
  }

  // A tie on the winning phrase means two commands answer to the same words.
  const tied = commands.filter(
    (command) => command.id !== match.id && command.phrases.some((p) => p === match.phrase)
  );
  if (tied.length > 0) {
    const all = [match.id, ...tied.map((t) => t.id)];
    return {
      outcome: 'ambiguous',
      text,
      say: 'That matches more than one thing',
      choices: await Promise.all(
        all.map(async (id) => {
          const command = commands.find((c) => c.id === id)!;
          return { id, label: await labelFor(command) };
        })
      ),
    };
  }

  const command = commands.find((c) => c.id === match.id)!;
  const result = await runCommand(command, text, match.phrase, wakeWord);

  // Say so when the last word was never heard. Wrong data with nothing to
  // prompt going to look for it is the thing to fear here, and this is the
  // prompt — it costs four words on a popup that is already on screen.
  return match.lenient ? { ...result, say: `${result.say ?? ''} (heard "${match.phrase}" partly)`.trim() } : result;
}

export async function labelFor(command: LoadedCommand): Promise<string> {
  if (command.label) return command.label;
  switch (command.kind) {
    case 'habit':
      return await describeHabit(command.target ?? '');
    case 'url':
      return `open ${command.target}`;
    case 'hotkey':
      return `press ${command.target}`;
    case 'note':
      return 'make a note';
    case 'pause':
      return command.pauseMinutes ? `stop listening for ${command.pauseMinutes}m` : 'stop listening';
  }
}

/** Run one resolved command. Exported so the overlay can act on a disambiguation. */
export async function runCommand(
  command: LoadedCommand,
  text: string,
  phrase: string,
  wakeWord: string
): Promise<VoiceOutcome> {
  switch (command.kind) {
    case 'habit': {
      const [habit] = await db.select().from(habits).where(eq(habits.id, command.target ?? ''));
      if (!habit) return { outcome: 'no-match', text, say: 'That habit has been deleted' };

      const count = spokenCount(text);
      const periodKey = periodKeyFor(habit.cadence as Cadence);
      await db.insert(habitEntries).values({ habitId: habit.id, periodKey, count });

      const entries = await db
        .select()
        .from(habitEntries)
        .where(and(eq(habitEntries.habitId, habit.id), eq(habitEntries.periodKey, periodKey)));
      const done = entries.reduce((sum, e) => sum + e.count, 0);

      return {
        outcome: 'habit-checked',
        text,
        habitId: habit.id,
        habitName: habit.name,
        doneThisPeriod: done,
        target: habit.targetPerPeriod,
        met: done >= habit.targetPerPeriod,
        say: `${habit.name} — ${done} of ${habit.targetPerPeriod}`,
      };
    }

    case 'note': {
      // The note is whatever was said *besides* the trigger, so "make a note
      // buy milk" stores "buy milk" rather than the whole sentence.
      const body = remainderAfterPhrase(text, phrase, wakeWord);
      if (!body) return { outcome: 'no-match', text, say: 'I heard the trigger but nothing to write down' };

      const [note] = await db.insert(notes).values({ body }).returning({ id: notes.id });
      return { outcome: 'note-added', text, noteId: note.id, say: `Noted: ${body}` };
    }

    case 'url':
      return {
        outcome: 'opened',
        text,
        action: { do: 'open-url', url: command.target ?? '' },
        say: `Opening ${command.target}`,
      };

    case 'hotkey':
      return {
        outcome: 'keys-sent',
        text,
        action: { do: 'press-keys', keys: command.target ?? '' },
        say: `Pressed ${command.target}`,
      };

    case 'pause': {
      // -1 is "until switched back on by hand", which has to survive a restart
      // and so cannot just be a very large timestamp.
      const untilMs = command.pauseMinutes ? Date.now() + command.pauseMinutes * 60_000 : -1;
      const [current] = await db.select().from(settings).limit(1);
      if (current) await db.update(settings).set({ voicePausedUntil: untilMs }).where(eq(settings.id, current.id));

      return {
        outcome: 'paused',
        text,
        action: { do: 'pause', untilMs: untilMs === -1 ? null : untilMs },
        say: command.pauseMinutes
          ? `Not listening for ${command.pauseMinutes} minutes`
          : 'Not listening until you switch it back on',
      };
    }
  }
}

/** Validates a target the way the schema does, for the CLI checks. */
export function targetIsValid(kind: VoiceCommandKind, target: string | null): boolean {
  if (kind === 'hotkey') return parseHotkey(target ?? '') !== null;
  if (kind === 'habit') return Boolean(target);
  return true;
}
