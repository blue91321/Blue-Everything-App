/**
 * Web push to the phone.
 *
 * Only ever used when Blake is genuinely away from the PC — see `isAwayFromPc`.
 * A toast on a screen he's sitting at is better than a buzz in his pocket, and
 * getting both would be worse than either.
 */
import webpush, { type PushSubscription } from 'web-push';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { DeliverableNudge } from '@everything/shared';
import { config } from './config.js';
import { db } from './db/client.js';
import { devices, settings } from './db/schema.js';
import { getSettings } from './nudge-engine.js';

/**
 * VAPID's `sub` is a contact for the push service, not a destination.
 *
 * It still has to look real: Apple refuses `localhost` with `403 BadJwtToken`,
 * and does so identically for every send, so the failure looks like "push
 * doesn't work" rather than "one claim is malformed". Validated in config.ts.
 */
const VAPID_SUBJECT = config.VAPID_SUBJECT;

/**
 * The keypair, created once and then reused forever.
 *
 * Regenerating it would silently invalidate every existing subscription, so it
 * is written back to the database the first time and never touched again.
 */
export async function getVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const current = await getSettings();
  if (current.vapidPublicKey && current.vapidPrivateKey) {
    return { publicKey: current.vapidPublicKey, privateKey: current.vapidPrivateKey };
  }

  const generated = webpush.generateVAPIDKeys();
  await db
    .update(settings)
    .set({ vapidPublicKey: generated.publicKey, vapidPrivateKey: generated.privateKey })
    .where(eq(settings.id, current.id));

  return generated;
}

export interface PushOutcome {
  sent: number;
  failed: number;
  /** Subscriptions the push service told us are dead; cleared automatically. */
  removed: number;
}

/**
 * How long between phone notifications, however much has piled up.
 *
 * Stepping away for an afternoon should not mean a pocketful of buzzes on the
 * way back to the desk.
 */
export const PUSH_COOLDOWN_MS = 10 * 60_000;

let lastPushAt = 0;

export function pushIsOnCooldown(now = Date.now()): boolean {
  return now - lastPushAt < PUSH_COOLDOWN_MS;
}

/** Several waiting nudges become one notification, not one each. */
function summarise(nudges: DeliverableNudge[]): { title: string; body: string } {
  if (nudges.length === 1) {
    return { title: nudges[0].title, body: nudges[0].body ?? 'Waiting for you.' };
  }

  const [first, second, ...rest] = nudges;
  const named = [first.title, second?.title].filter(Boolean).join(' · ');
  return {
    title: `${nudges.length} things waiting`,
    body: rest.length > 0 ? `${named} and ${rest.length} more` : named,
  };
}

export async function sendPushToPhones(nudges: DeliverableNudge[], now = Date.now()): Promise<PushOutcome> {
  const outcome: PushOutcome = { sent: 0, failed: 0, removed: 0 };
  if (nudges.length === 0) return outcome;

  const prefs = await getSettings();
  if (!prefs.pushEnabled) return outcome;

  const subscribed = await db
    .select()
    .from(devices)
    .where(and(isNotNull(devices.pushSubscription), isNull(devices.revokedAt)));

  if (subscribed.length === 0) return outcome;

  const keys = await getVapidKeys();
  webpush.setVapidDetails(VAPID_SUBJECT, keys.publicKey, keys.privateKey);

  const payload = JSON.stringify({ ...summarise(nudges), tag: 'everything-nudge', at: now });

  for (const device of subscribed) {
    let subscription: PushSubscription;
    try {
      subscription = JSON.parse(device.pushSubscription!) as PushSubscription;
    } catch {
      outcome.failed++;
      continue;
    }

    try {
      await webpush.sendNotification(subscription, payload, { TTL: 15 * 60 });
      outcome.sent++;
    } catch (error) {
      const { statusCode, body, message } = error as { statusCode?: number; body?: string; message?: string };

      // 404/410 mean the browser threw the subscription away — reinstalled the
      // app, cleared data. Keeping it would fail forever.
      if (statusCode === 404 || statusCode === 410) {
        await db.update(devices).set({ pushSubscription: null }).where(eq(devices.id, device.id));
        outcome.removed++;
      } else {
        // Never silent. Swallowing these made a malformed VAPID claim look like
        // "push just doesn't work", which took a live phone to diagnose.
        console.error(
          `push to ${device.name} failed: ${statusCode ?? '?'} ${String(body ?? message ?? '').trim()}`
        );
        outcome.failed++;
      }
    }
  }

  if (outcome.sent > 0) lastPushAt = now;
  return outcome;
}

/** Only for tests, which must not inherit a cooldown from an earlier check. */
export function resetPushCooldown(): void {
  lastPushAt = 0;
}
