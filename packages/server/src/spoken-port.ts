/**
 * The seam between voice and whatever answers what was said.
 *
 * Voice hears a sentence and decides which command it was: the matching, the
 * chaining of "this and that", asking when two commands tie, keeping the
 * microphone open for another. **What a command does is a blueprint's job**
 * (2026-10-29): a *When I say* box leads to ordinary Do boxes, so a spoken
 * command can do anything a blueprint can, and there is one place to build
 * them. Voice and blueprints are separate packages and neither may import the
 * other, so they meet here, in core, which names neither: blueprints provides
 * the commands when it loads, and voice asks for them.
 *
 * The default is no commands at all, which is the honest answer with the
 * blueprints package switched off or deleted. Voice still has its own two that
 * act on the microphone itself ("stop listening", "never mind"), so it can
 * always be silenced by voice.
 *
 * Also what the Habits screen asks "which phrases tick this habit?", so the
 * habit editor can list them without knowing blueprints exist.
 */

export interface SpokenCommand {
  /** Opaque to everyone but its provider. */
  id: string;
  phrases: string[];
  /** For "did you mean": the blueprint's name. */
  label: string;
  /** Whether the microphone may stay open for another command afterwards. */
  allowFollowUp: boolean;
  /**
   * It uses the words said after its phrase (a new note from "note buy milk
   * and eggs"), so it is never split as one half of a chain.
   */
  takesRest: boolean;
  /** Switched off: listed for the screens, never matched. */
  enabled: boolean;
  /** Habits it ticks, for the habit editor. */
  habits: string[];
  /** Where it is edited: a screen id and the `focus` that opens it there. */
  edit: { screen: string; focus: string };
}

export interface SpokenHeard {
  /** The sentence, or the part of a chain that matched this command. */
  text: string;
  /** The stored phrase it matched. */
  phrase: string;
  /** What was said after the phrase, for `{said}`. */
  rest: string;
  /** "two waters" is 2, "to max" is `'max'`, nothing said is 1. */
  amount: number | 'max';
}

export interface SpokenResult {
  ok: boolean;
  /** One line for the popup: what was done, or why it was not. */
  say: string;
}

export interface SpokenCommands {
  list(): SpokenCommand[];
  /** Do it, or with `dry`, only say what it would do. */
  run(id: string, heard: SpokenHeard, dry?: boolean): Promise<SpokenResult>;
  /**
   * A new spoken command, for "New voice command" on the Voice screen, or one
   * that ticks a habit already, from the habit editor.
   */
  create(preset?: { habit?: string; name?: string }): Promise<{ edit: { screen: string; focus: string } }>;
}

const NONE: SpokenCommands = {
  list: () => [],
  run: async () => ({ ok: false, say: 'Blueprints are switched off, so nothing answers that' }),
  create: async () => {
    throw new Error('Voice commands are blueprints, and the Blueprints package is switched off.');
  },
};

let port: SpokenCommands = NONE;
const listeners = new Set<() => void>();

/** Called once by the blueprints package as it loads. */
export function provideSpokenCommands(implementation: SpokenCommands): void {
  port = implementation;
  spokenChanged();
}

export function spokenCommands(): SpokenCommands {
  return port;
}

/** Whether anything provides commands, so a screen can say why there are none. */
export function spokenProvided(): boolean {
  return port !== NONE;
}

/** The provider says its commands changed, so voice can tell the agent. */
export function spokenChanged(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A listener's mistake must not stop the next one hearing.
    }
  }
}

export function onSpokenChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Only for tests. */
export function resetSpokenPort(): void {
  port = NONE;
}
