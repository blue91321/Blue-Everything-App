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
 * movable and has no business assuming it runs on your desk.
 */
import { and, asc, eq } from 'drizzle-orm';
import {
  ALWAYS_IN_VOCABULARY,
  MEDIA_LABEL,
  matchVoiceCommand,
  matchVoiceCommandLoosely,
  spokenVariants,
  parseHotkey,
  remainderAfterPhrase,
  segmentUtterance,
  spokenCount,
  type MediaAction,
  type VoiceCandidate,
  type VoiceCommandKind,
} from '@everything/shared';
import { db } from '../../db/client.js';
import { habitEntries, habits, notes, settings, voiceCommands } from '../../db/schema.js';
import { periodKeyFor } from '../../routes/habits.js';
import type { Cadence } from '@everything/shared';

/** Something for the agent to do on the machine you are sitting at. */
export type VoiceAction =
  | { do: 'open-url'; url: string }
  | { do: 'press-keys'; keys: string }
  /** A system media key. The agent refuses it when nothing is playing. */
  | { do: 'media'; action: string }
  | { do: 'pause'; untilMs: number | null }
  /** Drop the sentence in progress. The microphone stays on. */
  | { do: 'cancel' };

export interface VoiceOutcome {
  outcome:
    | 'habit-checked'
    | 'note-added'
    | 'opened'
    | 'keys-sent'
    | 'media-sent'
    | 'paused'
    | 'cancelled'
    | 'captured-as-note'
    | 'ambiguous'
    /** Several commands in one sentence, joined by "and". See `steps`. */
    | 'chained'
    | 'no-match';
  text: string;
  /** Human-readable summary, shown in the overlay and the test readout. */
  say?: string;
  action?: VoiceAction;
  /**
   * The parts of a `chained` outcome, in the order they were said and run.
   *
   * A list rather than a flattened set of fields because each part is a whole
   * outcome — its own `say`, its own action, its own habit tally — and the
   * overlay wants to show what each one did. Absent on every other outcome.
   */
  steps?: VoiceOutcome[];
  /** When more than one command matched equally well, so the agent can ask. */
  choices?: { id: string; label: string }[];
  /** Whether this command lets the microphone stay open afterwards. */
  allowFollowUp?: boolean;
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
  /** Whether the microphone stays open after this fires. */
  allowFollowUp: boolean;
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
    allowFollowUp: Boolean(row.allowFollowUp),
  }));
}

/** The literal words of every phrase, plus the wake word. What to check exists. */
export function phraseWordsFor(commands: LoadedCommand[], wakeWord: string): string[] {
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

/**
 * The recogniser's whole vocabulary — phrase words *and their inflections*.
 *
 * The literal words alone are not enough: a grammar can only emit what it
 * contains, so a stored "drink water" left the recogniser unable to say
 * "drank" and it substituted whatever was nearest. See `spokenVariants`.
 *
 * The wake word is left unexpanded. It is a name, and "jarvises" would only
 * widen the one grammar that most needs to stay narrow.
 */
export function vocabularyFor(commands: LoadedCommand[], wakeWord: string): string[] {
  const words = new Set<string>();
  for (const word of wakeWord.toLowerCase().split(/\s+/)) if (word) words.add(word);

  // The counting words, always — `spokenCount` reads them and the recogniser
  // cannot emit what it was never given.
  for (const word of ALWAYS_IN_VOCABULARY) words.add(word);

  for (const command of commands) {
    for (const phrase of command.phrases) {
      for (const word of phrase.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
        for (const form of spokenVariants(word)) words.add(form);
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
 * worst option — a wrongly fired hotkey is not something you would notice was
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

  // Tried before the single-command path, and it has to be — "I drank water and
  // took my meds" matches "drink water" perfectly as a whole sentence, so
  // resolving first and splitting on failure would never chain anything.
  const chain = await resolveChain(text, commands, candidates, wakeWord);
  if (chain) return chain;


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
  const result = { ...(await runCommand(command, text, match.phrase, wakeWord)), allowFollowUp: command.allowFollowUp };

  // Say so when the last word was never heard. Wrong data with nothing to
  // prompt going to look for it is the thing to fear here, and this is the
  // prompt — it costs four words on a popup that is already on screen.
  return match.lenient ? { ...result, say: `${result.say ?? ''} (heard "${match.phrase}" partly)`.trim() } : result;
}

/**
 * "Drink water and skip this track" — two commands in one breath.
 *
 * Returns null for anything that is not unambiguously a chain, and null is the
 * common answer: a sentence with no "and" in it, one whose halves do not both
 * match, one that matched only loosely. The caller then resolves the sentence
 * whole, exactly as it did before this existed. **Nothing is run until every
 * segment has resolved**, so a chain never half-fires and leaves you guessing
 * which end of the sentence landed.
 *
 * The rules are deliberately strict, because the cost of being wrong is
 * asymmetric. Failing to chain means saying the second thing again — mildly
 * annoying. Chaining something that was not a chain means firing a command
 * nobody asked for, and with a hotkey in the list that is not something you
 * would notice was wrong.
 *
 *  - **Every segment must match strictly.** No loose matching, no
 *    last-word-clipped allowance: those exist to rescue a sentence that would
 *    otherwise be lost entirely, and here there is a perfectly good fallback.
 *    This is also what keeps a stored phrase containing "and" working — its
 *    halves match nothing on their own, so the split is discarded.
 *  - **No segment may be ambiguous.** Asking about one part of a chain would
 *    mean holding the rest of the sentence somewhere while the popup waits,
 *    which is a lot of machinery for a rare case. Falling back is honest.
 *  - **No `note`.** Its content is whatever was said after the trigger, so
 *    "note buy milk and eggs" would file "buy milk" and try to run "eggs" as a
 *    command. A note is allowed to contain the word "and"; that is the point of
 *    dictating one.
 */
export interface ChainStep {
  command: LoadedCommand;
  /** The stored phrase that matched this segment. */
  phrase: string;
  /** The words this part of the sentence was reduced to. */
  segment: string;
}

/**
 * Decide whether a sentence is a chain, without running any of it.
 *
 * Split out from `resolveChain` so "Try a phrase" on the Voice tab can answer
 * the question the same way the microphone does. It reported only
 * `matchVoiceCommand` before chaining existed, which for "drink water and skip
 * this track" would have said "this ticks off water" — true of the first half
 * and a lie about the sentence. A dry run that disagrees with the real one is
 * worse than no dry run, because it is believed.
 */
export function planChain(
  text: string,
  commands: LoadedCommand[],
  candidates: VoiceCandidate[],
  wakeWord = ''
): ChainStep[] | null {
  // The wake word is passed so it is not mistaken for a half-heard command: it
  // rides on the front of the first segment and belongs to no phrase, which is
  // precisely the shape of the residue this now looks for.
  const segments = segmentUtterance(text, candidates, { wakeWord });
  if (!segments) return null;

  const resolved: ChainStep[] = [];

  for (const { text: segment, match } of segments) {
    // The same tie the single path treats as a question. Here it is a reason to
    // stop rather than to ask: holding the rest of a sentence somewhere while a
    // popup waits is a lot of machinery for a rare case, and falling back to
    // resolving the whole thing is an honest answer.
    const tied = commands.some(
      (command) => command.id !== match.id && command.phrases.some((p) => p === match.phrase)
    );
    if (tied) return null;

    const command = commands.find((c) => c.id === match.id)!;
    // A note's content is whatever was said after its trigger, so segmenting it
    // would file half a sentence and try to run the rest. Dictating a note that
    // contains "and" is rather the point of dictating one.
    if (command.kind === 'note') return null;

    resolved.push({ command, phrase: match.phrase, segment });
  }

  return resolved;
}

async function resolveChain(
  text: string,
  commands: LoadedCommand[],
  candidates: VoiceCandidate[],
  wakeWord: string
): Promise<VoiceOutcome | null> {
  const resolved = planChain(text, commands, candidates, wakeWord);
  if (!resolved) return null;

  const steps: VoiceOutcome[] = [];
  for (const { command, phrase, segment } of resolved) {
    // The *segment*, not the whole sentence, so `spokenCount` reads the number
    // that belongs to this part — "two waters and one coffee" is 2 then 1, not
    // 2 twice.
    steps.push(await runCommand(command, segment, phrase, wakeWord));
  }

  return {
    outcome: 'chained',
    text,
    say: steps.map((step) => step.say ?? '').filter(Boolean).join(' · '),
    steps,
    // Only if every part was happy to keep the microphone open. One command
    // saying "don't linger after me" has to win, or opting out would mean
    // nothing the moment it was said as part of a chain.
    allowFollowUp: resolved.every(({ command }) => command.allowFollowUp),
  };
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
    case 'media':
      return MEDIA_LABEL[(command.target ?? '') as MediaAction] ?? 'media control';
    case 'note':
      return 'make a note';
    case 'pause':
      return command.pauseMinutes ? `stop listening for ${command.pauseMinutes}m` : 'stop listening';
    case 'cancel':
      return 'never mind';
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

    case 'media':
      // Whether it actually fires is the agent's call: only it can see the
      // output meter, and "is anything playing" is the guard on this kind.
      return {
        outcome: 'media-sent',
        text,
        action: { do: 'media', action: command.target ?? '' },
        say: MEDIA_LABEL[(command.target ?? '') as MediaAction] ?? 'Media',
      };

    case 'cancel':
      // Nothing to write: this ends an exchange rather than changing anything.
      // The agent closes the follow-up window and takes the popup away.
      return { outcome: 'cancelled', text, action: { do: 'cancel' }, say: 'Never mind' };

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
