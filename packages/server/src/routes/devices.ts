import { randomBytes } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { registerDeviceSchema } from '@everything/shared';
import { hashToken } from '../auth.js';
import { db } from '../db/client.js';
import { devices } from '../db/schema.js';

export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  /** Who am I, and am I allowed in? The app's first call on load. */
  app.get('/api/session', async (request) => ({
    ok: true,
    local: request.isLocal,
    deviceId: request.deviceId,
    deviceKind: request.deviceKind,
  }));

  /**
   * Mint a token for a new device — the phone, usually.
   *
   * Restricted to callers on this machine, which keeps the property that
   * mattered when this was CLI-only: a token stolen from the phone still can't
   * be used to mint more. It just moves the trusted step from a terminal to a
   * browser on the same PC.
   */
  app.post('/api/devices', async (request, reply) => {
    if (!request.isLocal) {
      return reply.code(403).send({ error: 'devices can only be added from the PC running the server' });
    }

    const body = registerDeviceSchema.parse(request.body);
    const token = randomBytes(32).toString('base64url');
    const [device] = await db
      .insert(devices)
      .values({ name: body.name, kind: body.kind, tokenHash: hashToken(token) })
      .returning({ id: devices.id, name: devices.name, kind: devices.kind });

    // The only time the token is ever returned. Nothing stores the plaintext.
    return reply.code(201).send({ ...device, token });
  });

  /** Never returns `tokenHash`. */
  app.get('/api/devices', async () =>
    db
      .select({
        id: devices.id,
        name: devices.name,
        kind: devices.kind,
        lastSeenAt: devices.lastSeenAt,
        revokedAt: devices.revokedAt,
        createdAt: devices.createdAt,
        hasPush: devices.pushSubscription,
      })
      .from(devices)
      .orderBy(desc(devices.createdAt))
  );

  app.get('/api/devices/me', async (request, reply) => {
    if (!request.deviceId) return reply.code(404).send({ error: 'not running with a paired device' });
    const [device] = await db.select().from(devices).where(eq(devices.id, request.deviceId));
    if (!device) return reply.code(404).send({ error: 'no such device' });
    const { tokenHash: _omit, ...safe } = device;
    return safe;
  });

  /** The PWA hands over its Web Push subscription once the user allows it. */
  app.post('/api/devices/me/push', async (request, reply) => {
    if (!request.deviceId) return reply.code(400).send({ error: 'not running with a paired device' });
    await db
      .update(devices)
      .set({ pushSubscription: JSON.stringify(request.body) })
      .where(eq(devices.id, request.deviceId));
    return { ok: true };
  });

  app.post('/api/devices/:id/revoke', async (request, reply) => {
    const { id } = request.params as { id: string };
    const [updated] = await db
      .update(devices)
      .set({ revokedAt: Date.now() })
      .where(eq(devices.id, id))
      .returning({ id: devices.id, name: devices.name, revokedAt: devices.revokedAt });
    return updated ?? reply.code(404).send({ error: 'no such device' });
  });
}
