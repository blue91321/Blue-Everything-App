import { EventEmitter } from 'node:events';
import type { AttentionState, StoppingQuality } from '@everything/shared';

/**
 * Things that happened, said once, for whatever wants to act on them.
 *
 * `changes` (events.ts) says *which part* of the app moved, so every screen can
 * refetch; it cannot say what moved, and a blueprint has to know "this task was
 * finished", not "something under tasks changed". So the few moments worth
 * acting on are announced here as well, with what they were about.
 *
 * It is a port in the sense `push-port.ts` is: core says what happened and does
 * not know who is listening, so a package can act on a finished match without
 * core learning the package exists. With nobody listening an emit is a lookup
 * in an empty table, which is why the busiest route in the app can afford one.
 *
 * Emitted **after** the write, so a listener reading the database finds what
 * was just done. Listeners run synchronously from `emit`; anything slow must
 * hand itself off, which the blueprints package does by queueing.
 */
export interface Happenings {
  /**
   * What you are doing changed, or a stopping point arrived. Only on a change:
   * the heartbeat arrives every few seconds and nearly always says the same.
   */
  attention: {
    state: AttentionState;
    previous: AttentionState | null;
    away: boolean;
    previousAway: boolean | null;
    stoppingPoint: { quality: StoppingQuality; reason: string } | null;
    /** The game in front, or the one that just ended on a stopping point. */
    game: string | null;
    /** Every game running, by exe, in front or not. */
    games: string[];
  };
  'habit-done': { habitId: string; name: string };
  'task-added': { taskId: string; title: string };
  /** Only on the change to done, not on every save of a done task. */
  'task-done': { taskId: string; title: string };
}

class HappeningBus extends EventEmitter {
  say<K extends keyof Happenings>(kind: K, what: Happenings[K]): void {
    try {
      this.emit(kind, what);
    } catch (error) {
      // A listener's mistake must not fail the request that did the thing.
      console.warn(`[happenings] a listener for ${kind} failed:`, (error as Error).message);
    }
  }

  hear<K extends keyof Happenings>(kind: K, listener: (what: Happenings[K]) => void): () => void {
    this.on(kind, listener);
    return () => this.off(kind, listener);
  }
}

export const happenings = new HappeningBus();
happenings.setMaxListeners(0);
