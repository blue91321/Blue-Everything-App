/**
 * Phone push, as one removable piece.
 *
 * Unlike the vault and voice this feature owns no routes — the subscription
 * endpoint is `/api/devices/me/push`, which belongs to devices. What it owns is
 * an *implementation*, so loading it means filling in `push-port.ts` rather
 * than mounting a URL.
 *
 * It is still registered through the same `registerFeature` call as the others,
 * because having one mechanism that sometimes mounts routes is simpler to hold
 * in your head than two mechanisms that each do half the job.
 */
import type { FastifyInstance } from 'fastify';
import { providePush } from '../../push-port.js';
import { getVapidKeys, pushIsOnCooldown, resetPushCooldown, sendPushToPhones } from './push.js';

export async function routes(_app: FastifyInstance): Promise<void> {
  providePush({
    isOnCooldown: pushIsOnCooldown,
    sendToPhones: sendPushToPhones,
    resetCooldown: resetPushCooldown,
    /**
     * Generated on first read so the phone always has a key to subscribe with.
     * Failure returns null rather than throwing: this is called while rendering
     * the settings payload on every page load, and a push problem should not be
     * able to take that screen down.
     */
    vapidPublicKey: async () => {
      try {
        return (await getVapidKeys()).publicKey;
      } catch (error) {
        console.error(`could not produce VAPID keys: ${(error as Error).message}`);
        return null;
      }
    },
  });
}
