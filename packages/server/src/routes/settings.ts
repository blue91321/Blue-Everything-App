import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AWAY_FROM_PC_IDLE_MS, quietReason, updateSettingsSchema } from '@everything/shared';
import { db } from '../db/client.js';
import { settings } from '../db/schema.js';
import { getSettings } from '../nudge-engine.js';
import { getVapidKeys } from '../push.js';
import { currentWindowsDnd } from './attention.js';

async function describe(row: Awaited<ReturnType<typeof getSettings>>) {
  const windowsDnd = currentWindowsDnd();
  // Generated on first read so the phone always has a key to subscribe with.
  const { publicKey } = await getVapidKeys();
  const reason = quietReason(new Date(), {
    quietHoursEnabled: Boolean(row.quietHoursEnabled),
    quietStartMinute: row.quietStartMinute,
    quietEndMinute: row.quietEndMinute,
    followWindowsDnd: Boolean(row.followWindowsDnd),
    dndUntil: row.dndUntil,
    remindersEnabled: Boolean(row.remindersEnabled),
    windowsDnd,
  });

  // The private half must never leave the server.
  const { vapidPrivateKey: _secret, vapidPublicKey: _stored, ...safe } = row;

  return {
    ...safe,
    vapidPublicKey: publicKey,
    windowsDnd,
    quietNow: reason !== null,
    quietReason: reason,
    awayFromPcIdleMinutes: AWAY_FROM_PC_IDLE_MS / 60_000,
  };
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', async () => describe(await getSettings()));

  app.patch('/api/settings', async (request) => {
    const body = updateSettingsSchema.parse(request.body);
    const current = await getSettings();

    // SQLite has no boolean type, so the flags convert on the way in.
    const toInt = (v: boolean | undefined) => (v === undefined ? undefined : v ? 1 : 0);

    const [updated] = await db
      .update(settings)
      .set({
        quietStartMinute: body.quietStartMinute,
        quietEndMinute: body.quietEndMinute,
        dndUntil: body.dndUntil,
        quietHoursEnabled: toInt(body.quietHoursEnabled),
        followWindowsDnd: toInt(body.followWindowsDnd),
        remindersEnabled: toInt(body.remindersEnabled),
        pushEnabled: toInt(body.pushEnabled),
      })
      .where(eq(settings.id, current.id))
      .returning();

    return describe(updated);
  });
}
