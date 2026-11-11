/**
 * The gate in front of the wake spotter: what is loud enough to listen to.
 *
 * A silent room must cost nothing, so blocks below the gate's line never reach
 * a model. Two things about where the line sits and what happens when it opens
 * decide whether a quiet voice is heard at all, and both were measured
 * (2026-11-04, Windows' voices over a room's noise, six takes of "hey jarvis"):
 *
 * **It opens with what came just before.** A word starts quietly, so the block
 * that crosses the line is already part-way into "hey", and the spotter, handed
 * only what followed, heard half a wake word. With a fixed line at 0.006 a
 * wake word peaking at 0.012 woke it once in six; fed everything, five. So the
 * last `PREROLL_BLOCKS` quiet blocks are kept and handed over first.
 *
 * **The line follows the room.** A fixed 0.006 was three times one room's noise,
 * and through a headset with noise suppression the room reads 0.0008, so soft
 * speech sat below a line set for somebody else's room. The noise is tracked as
 * the quietest the room has been lately (falling at once, rising slowly, so
 * speech never pulls it up), and the line is `NOISE_MULTIPLE` times that, never
 * below `FLOOR_MIN` and **never above the old 0.006**: a quiet room gets a lower
 * line, and no room gets a stricter one than before.
 *
 * No imports, so the test harness runs the very same rule.
 */

/** The old fixed line, which stays the strictest the gate will be. */
export const FLOOR_MAX = 0.006;
/** Below this a "voice" is mostly the converter's own hiss. */
export const FLOOR_MIN = 0.002;
/** How far above the room's noise counts as something worth listening to. */
export const NOISE_MULTIPLE = 2.5;
/** Keep listening this long after it goes quiet: speech dips between words. */
export const HANGOVER_MS = 700;
/** Half a second of what came before, handed over when the gate opens. */
export const PREROLL_BLOCKS = 5;
/** Per 100ms block, how fast the noise estimate may rise: doubling takes about a minute. */
const NOISE_RISE = 1.0012;

export interface GateStep {
  /** What to feed the spotter now, oldest first: nothing while shut. */
  feed: Int16Array[];
  /** True on the block where it shut, which is the end of an utterance. */
  closed: boolean;
}

export class SpeechGate {
  /** The room's noise as last estimated; starts at the old line's third, the old assumption. */
  noise = FLOOR_MAX / 3;
  private lastLoudAt = -Infinity;
  private open = false;
  private held: Int16Array[] = [];

  /** The level a block must reach to open the gate now. */
  get floor(): number {
    return Math.min(FLOOR_MAX, Math.max(FLOOR_MIN, this.noise * NOISE_MULTIPLE));
  }

  /** Loud enough to count as speech, for anything else that asks (the tone after a wake). */
  loud(level: number): boolean {
    return level >= this.floor;
  }

  step(block: Int16Array, level: number, now: number): GateStep {
    const loud = this.loud(level);
    /*
     * The quietest the room has been lately: down at once, up slowly. It rises
     * on loud blocks too, or a fan that starts up above the line would hold the
     * gate open for good; a minute of talking at most doubles it, and the next
     * pause brings it straight back down.
     */
    if (level < this.noise) this.noise = Math.max(level, 0.0001);
    else this.noise *= NOISE_RISE;
    if (loud) this.lastLoudAt = now;

    if (now - this.lastLoudAt > HANGOVER_MS) {
      const closed = this.open;
      this.open = false;
      this.held.push(block);
      if (this.held.length > PREROLL_BLOCKS) this.held.shift();
      return { feed: [], closed };
    }
    if (!this.open) {
      this.open = true;
      const feed = [...this.held, block];
      this.held = [];
      return { feed, closed: false };
    }
    return { feed: [block], closed: false };
  }
}
