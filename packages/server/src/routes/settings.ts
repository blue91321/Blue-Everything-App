import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { quietReason, updateSettingsSchema } from '@everything/shared';
import { db } from '../db/client.js';
import { settings } from '../db/schema.js';
import { getSettings } from '../nudge-engine.js';
import { currentWindowsDnd } from './attention.js';

async function describe(row: Awaited<ReturnType<typeof getSettings>>) {
  const windowsDnd = currentWindowsDnd();
  const reason = quietReason(new Date(), {
    quietHoursEnabled: Boolean(row.quietHoursEnabled),
    quietStartMinute: row.quietStartMinute,
    quietEndMinute: row.quietEndMinute,
    followWindowsDnd: Boolean(row.followWindowsDnd),
    dndUntil: row.dndUntil,
    remindersEnabled: Boolean(row.remindersEnabled),
    windowsDnd,
  });

  return { ...row, windowsDnd, quietNow: reason !== null, quietReason: reason };
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
      })
      .where(eq(settings.id, current.id))
      .returning();

    return describe(updated);
  });
}
