/**
 * The seam between the nudge engine and phone push.
 *
 * The engine is core and push is optional, so the engine cannot import it — a
 * deleted `features/push/` would take the whole server down with a
 * module-not-found. It calls through here instead, and the push feature fills
 * this in when it loads.
 *
 * The no-op default is not a stub bolted on for the sake of one: "push is not
 * installed" and "no phone is subscribed" are the same situation, and the
 * engine already handles the latter correctly — nothing is marked delivered,
 * everything stays queued, and it toasts the moment Blake sits down. So the
 * fallback is the behaviour that was already specified, not a new one.
 */
import type { DeliverableNudge } from '@everything/shared';

export interface PushOutcome {
  sent: number;
  failed: number;
  /** Subscriptions the push service told us are dead; cleared automatically. */
  removed: number;
}

export interface PushPort {
  isOnCooldown(now: number): boolean;
  sendToPhones(nudges: DeliverableNudge[], now: number): Promise<PushOutcome>;
  /** `null` when push is unavailable, so the PWA can say so rather than fail. */
  vapidPublicKey(): Promise<string | null>;
  resetCooldown(): void;
}

const NO_PHONES: PushPort = {
  isOnCooldown: () => false,
  sendToPhones: async () => ({ sent: 0, failed: 0, removed: 0 }),
  vapidPublicKey: async () => null,
  resetCooldown: () => {},
};

let port: PushPort = NO_PHONES;

/** Called once by the push feature as it loads. */
export function providePush(implementation: PushPort): void {
  port = implementation;
}

/** Only for tests, which must not inherit an implementation from another case. */
export function resetPushPort(): void {
  port = NO_PHONES;
}

export function phones(): PushPort {
  return port;
}
