/**
 * Turning a transcript into something that happens.
 *
 * Split out of the route because this is the part with consequences and the
 * part worth testing on its own. `npm run voice-check -w @everything/server`
 * covers it.
 *
 * **What a command does is a blueprint now** (2026-10-29). A *When I say* box
 * holds the phrases and the Do boxes after it do the work, so a spoken command
 * can do anything a blueprint can, and ticking a habit, opening a site,
 * pressing keys, media keys, starting a game, music and notes all moved there.
 * Voice keeps what is about *hearing*: which command a sentence was, "this and
 * that" in one breath, asking when two tie, and the microphone staying open
 * for another. The two packages may not import each other, so the commands
 * come through core's spoken port (`spokenCommands()`), and with Blueprints
 * switched off there are none.
 *
 * **Two commands are still voice's own**: "stop listening" (`pause`) and
 * "never mind" (`cancel`). They act on the microphone itself, mid-sentence,
 * and must work with Blueprints off, so the microphone can always be silenced
 * by voice. Those stay in `voice_commands`; the other kinds left there are the
 * record of what was converted, and are not read.
 */
import { asc, eq, inArray } from 'drizzle-orm';
import {
  ALWAYS_IN_VOCABULARY,
  matchVoiceCommand,
  matchVoiceCommandLoosely,
  spokenVariants,
  remainderAfterPhrase,
  segmentUtterance,
  spokenAmount,
  type VoiceCandidate,
} from '@everything/shared';
import { db, settings, spokenCommands, voiceCommands } from '@everything/server/module-api';

/** Something for the agent to do to the microphone. Everything else is a blueprint's. */
export type VoiceAction =
  | { do: 'pause'; untilMs: number | null }
  /** Drop the sentence in progress. The microphone stays on. */
  | { do: 'cancel' };

export interface VoiceOutcome {
  outcome:
    /** A blueprint ran, and `say` is what it did. */
    | 'ran'
    /** A blueprint was matched and could not do it; `say` says why. */
    | 'failed'
    | 'paused'
    | 'cancelled'
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
   * outcome with its own `say`, and the overlay shows what each one did.
   */
  steps?: VoiceOutcome[];
  /** When more than one command matched equally well, so the agent can ask. */
  choices?: { id: string; label: string }[];
  /** Whether this command lets the microphone stay open afterwards. */
  allowFollowUp?: boolean;
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

/** Voice's own two, which act on the microphone and stay with it. */
export const OWN_KINDS = ['pause', 'cancel'] as const;

export interface LoadedCommand {
  id: string;
  /** `blueprint` is a "When I say" box; the other two are voice's own. */
  kind: 'pause' | 'cancel' | 'blueprint';
  phrases: string[];
  /** For a blueprint, its spoken id in the port. */
  target: string | null;
  pauseMinutes: number | null;
  label: string | null;
  /** Whether the microphone stays open after this fires. */
  allowFollowUp: boolean;
  /** It uses the words said after its phrase, so it is never one half of a chain. */
  takesRest?: boolean;
}

/** A spoken command's id in this list: kept apart from voice's own ids by its prefix. */
const BLUEPRINT = 'bp:';

export async function loadCommands(): Promise<LoadedCommand[]> {
  const rows = await db
    .select()
    .from(voiceCommands)
    .where(inArray(voiceCommands.kind, [...OWN_KINDS]))
    .orderBy(asc(voiceCommands.sortOrder));

  const own: LoadedCommand[] = rows
    .filter((row) => row.enabled)
    .map((row) => ({
      id: row.id,
      kind: row.kind as 'pause' | 'cancel',
      phrases: parsePhrases(row.phrases),
      target: row.target,
      pauseMinutes: row.pauseMinutes,
      label: row.label,
      allowFollowUp: Boolean(row.allowFollowUp),
    }));

  const spoken: LoadedCommand[] = spokenCommands()
    .list()
    .filter((command) => command.enabled && command.phrases.length > 0)
    .map((command) => ({
      id: `${BLUEPRINT}${command.id}`,
      kind: 'blueprint',
      phrases: command.phrases,
      target: command.id,
      pauseMinutes: null,
      label: command.label,
      allowFollowUp: command.allowFollowUp,
      takesRest: command.takesRest,
    }));

  return [...own, ...spoken];
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

  // The counting words, always — `spokenAmount` reads them and the recogniser
  // cannot emit what it was never given.
  for (const word of ALWAYS_IN_VOCABULARY) words.add(word);

  for (const command of commands) {
    for (const phrase of command.phrases) {
      const parts = phrase.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
      for (const word of parts) {
        for (const form of spokenVariants(word)) words.add(form);
      }

      /*
       * The phrase run together as one word, because that is how half of them
       * get said.
       *
       * "never mind" is stored as two words, so the grammar could only ever
       * offer `never` and `mind` separately — and a closed grammar has to map
       * every sound onto something it contains. Said as "nevermind", the decoder
       * cannot answer with the word you actually said and picks whatever is
       * nearest instead, which on this machine was `went`.
       *
       * Adding the joined form is free when it is not a real word: Vosk drops
       * anything missing from the model's lexicon, so "stopgoaway" costs
       * nothing and disappears. When it *is* a word — nevermind, logout,
       * goodnight — the recogniser can finally say what it heard.
       *
       * `matchVoiceCommand` knows to treat it as covering the whole phrase, so
       * the two halves cannot drift.
       */
      if (parts.length > 1) words.add(parts.join(''));
    }
  }

  return [...words].sort();
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
 *  - **Nothing that uses the words after its phrase.** A new note's content is
 *    whatever was said after the trigger, so "note buy milk and eggs" would
 *    file "buy milk" and try to run "eggs" as a command. A note is allowed to
 *    contain the word "and"; that is the point of dictating one.
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
    // A command that uses what was said after its phrase (a new note) needs
    // all of it, so segmenting it would file half a sentence and try to run the
    // rest. Dictating a note that contains "and" is rather the point.
    if (command.takesRest) return null;

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
    // The *segment*, not the whole sentence, so `spokenAmount` reads the number
    // — or the "max" — that belongs to this part: "two waters and one coffee" is
    // 2 then 1, not 2 twice, and "water to max and one coffee" maxes only the
    // first.
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
  if (command.kind === 'pause') return command.pauseMinutes ? `stop listening for ${command.pauseMinutes}m` : 'stop listening';
  if (command.kind === 'cancel') return 'never mind';
  return `"${command.phrases[0] ?? ''}"`;
}

/**
 * Run one resolved command, or with `dry`, only say what it would do. Exported
 * so the overlay can act on a disambiguation and "Try a phrase" can ask.
 */
export async function runCommand(
  command: LoadedCommand,
  text: string,
  phrase: string,
  wakeWord: string,
  dry = false
): Promise<VoiceOutcome> {
  switch (command.kind) {
    case 'blueprint': {
      /*
       * The blueprint gets what only the sentence knows: what was said after
       * the phrase, for `{said}` ("note buy milk" stores "buy milk"), and how
       * many, for "Tick a habit" set to as many as I said. `spokenAmount`, not
       * a count: "to max" is a real thing to say and is not a number you
       * could know, so the habit resolves it.
       */
      const result = await spokenCommands().run(
        command.target ?? '',
        { text, phrase, rest: remainderAfterPhrase(text, phrase, wakeWord), amount: spokenAmount(text) },
        dry
      );
      return { outcome: result.ok ? 'ran' : 'failed', text, say: result.say };
    }

    case 'cancel':
      // Nothing to write: this ends an exchange rather than changing anything.
      // The agent closes the follow-up window and takes the popup away.
      return { outcome: 'cancelled', text, action: { do: 'cancel' }, say: 'Never mind' };

    case 'pause': {
      if (dry) {
        return {
          outcome: 'paused',
          text,
          say: command.pauseMinutes ? `Would stop listening for ${command.pauseMinutes} minutes` : 'Would stop listening until you switch it back on',
        };
      }
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
