/**
 * What the agent reports about the person at the PC, how good a moment it is
 * to interrupt, and when they count as away from it.
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Attention                                                           */
/* ------------------------------------------------------------------ */

export const attentionStates = ['free', 'in-game', 'focused', 'away'] as const;
export const attentionStateSchema = z.enum(attentionStates);
export type AttentionState = z.infer<typeof attentionStateSchema>;

export const stoppingQualities = ['decent', 'prime'] as const;
export const stoppingQualitySchema = z.enum(stoppingQualities);
export type StoppingQuality = z.infer<typeof stoppingQualitySchema>;

/**
 * How good a moment a nudge insists on before it will interrupt.
 * `any` fires during ordinary desktop use; `prime` waits for a match to end
 * or for you to come back to the desk.
 */
export const nudgeQualities = ['any', 'decent', 'prime'] as const;
export const nudgeQualitySchema = z.enum(nudgeQualities);
export type NudgeQuality = z.infer<typeof nudgeQualitySchema>;

/** Ordered so a `prime` moment also satisfies anything that asked for less. */
export const qualityRank: Record<NudgeQuality, number> = { any: 0, decent: 1, prime: 2 };

export const attentionReportSchema = z.object({
  at: z.number().int().optional(),
  state: attentionStateSchema,
  reason: z.string().max(300),
  exe: z.string().max(260).nullish(),
  title: z.string().max(500).nullish(),
  idleMs: z.number().int().nonnegative().default(0),
  liveGames: z.array(z.string().max(260)).default([]),
  /**
   * The executable holding exclusive fullscreen, if any.
   *
   * Reported whether or not it is a known game, because that is exactly how an
   * unknown one gets onto the list — it used to be written to the agent's
   * console and nowhere else, which is no use to anybody looking at a screen.
   */
  fullscreenApp: z.string().max(260).nullish(),
  /**
   * Where each live game actually lives on disk, keyed by executable.
   *
   * The name recognises a game; the path is what lets the screen open its folder
   * or start it. Recorded when first seen rather than asked for later, because
   * the only moment this is cheaply knowable is while the process is running.
   */
  gamePaths: z.record(z.string(), z.string().max(500)).default({}),
  /*
   * Optional rather than defaulted-and-required for the reason every field
   * added to this payload has been: an older agent sends none, and its whole
   * report must not be refused over a field that postdates it.
   */
  gameUrls: z.record(z.string(), z.string().max(300)).default({}),
  /** Windows' own Do Not Disturb / quiet time is switched on right now. */
  windowsDnd: z.boolean().default(false),
  /** Something has played sound recently — a video, a stream, a call. */
  audioPlaying: z.boolean().default(false),
  /** Present only on the poll where a transition actually happened. */
  stoppingPoint: z
    .object({ quality: stoppingQualitySchema, reason: z.string().max(300) })
    .nullish(),
});
export type AttentionReport = z.infer<typeof attentionReportSchema>;

/* ------------------------------------------------------------------ */
/* Away from the PC                                                    */
/* ------------------------------------------------------------------ */

/** No keyboard or mouse for this long before the phone is even considered. */
export const AWAY_FROM_PC_IDLE_MS = 15 * 60_000;

/**
 * Has you actually left, as opposed to sitting still?
 *
 * Idle time alone can't tell the difference: watching a two-hour film looks
 * exactly like an empty chair to the keyboard. Sound is what separates them, so
 * a push only goes out when the machine has been untouched *and* silent.
 *
 * Deliberately conservative — a missed phone nudge is a small loss, while a
 * phone buzzing in your pocket while you're sat watching something is exactly the
 * badly-timed interruption this whole app exists to prevent.
 */
export function isAwayFromPc(input: { idleMs: number; audioPlaying?: boolean }): boolean {
  return input.idleMs >= AWAY_FROM_PC_IDLE_MS && !input.audioPlaying;
}

/**
 * Does this particular thing get to buzz your pocket?
 *
 * Three states collapsed to two, in one place so the sweep, the API and the
 * settings screen cannot disagree about what an unset value means.
 *
 * The point of the null is that it keeps *tracking* the default. Stamping every
 * task with the default at creation would look identical on the day it was
 * made and diverge silently forever after: changing your mind about the default
 * would leave everything already on the list answering the old question, and
 * nothing on screen to say why.
 *
 * Deliberately not consulted for whether push happens *at all* — `pushEnabled`
 * is that switch, and it outranks this. A task saying "yes, push me" on an
 * install with the phone switched off means nothing, and should.
 */
export function resolvePush(own: boolean | number | null | undefined, fallback: boolean): boolean {
  if (own === null || own === undefined) return fallback;
  return Boolean(own);
}
