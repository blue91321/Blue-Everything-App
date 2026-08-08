import { randomBytes } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { registerDeviceSchema } from '@everything/shared';
import { hashToken } from '../auth.js';
import { db } from '../db/client.js';
import { devices } from '../db/schema.js';
import { activeFeatures, isEnabled, missingFeatures } from '../features.js';
import { VERSION } from '../version.js';

export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Who am I, am I allowed in, and what does this install actually run?
   *
   * The feature list rides along here because this is already the app's first
   * call on load — the PWA needs to know which tabs exist before it draws the
   * drawer, and a second round trip to find out would show the wrong menu for a
   * moment. It is a plain `string[]` because the PWA deliberately does not
   * import `@everything/shared`.
   */
  app.get('/api/session', async (request) => ({
    ok: true,
    local: request.isLocal,
    deviceId: request.deviceId,
    deviceKind: request.deviceKind,
    version: VERSION,
    features: activeFeatures(),
    // Switched on but absent from disk. Named separately so the app can say
    // "the folder is gone" rather than "you turned it off" — different fixes.
    featuresMissing: missingFeatures(),
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

  /**
   * The PWA hands over its Web Push subscription once the user allows it, and
   * posts an empty body to withdraw it.
   *
   * The shape is checked rather than stringified blindly: `JSON.stringify(null)`
   * is the string "null", which would look like a live subscription forever and
   * fail every send.
   */
  app.post('/api/devices/me/push', async (request, reply) => {
    // Storing a subscription nothing will ever send to is inert rather than
    // harmful, but accepting it would let the phone show "notifications on" for
    // a feature this install does not run.
    if (!isEnabled('push')) return reply.code(404).send({ error: 'phone push is switched off on this server' });
    if (!request.deviceId) return reply.code(400).send({ error: 'not running with a paired device' });

    const body = request.body as { endpoint?: unknown } | null;
    const isSubscription = Boolean(body && typeof body === 'object' && typeof body.endpoint === 'string');

    await db
      .update(devices)
      .set({ pushSubscription: isSubscription ? JSON.stringify(body) : null })
      .where(eq(devices.id, request.deviceId));

    return { ok: true, subscribed: isSubscription };
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

  /**
   * Clear out a revoked device for good.
   *
   * **Revoking and deleting are two steps on purpose, and this refuses to be
   * the first one.** Revoking is the thing that matters and is instant; the row
   * that stays behind is the record of it, and it is worth reading before it
   * goes — "phone, revoked, last seen three weeks ago" is how you notice you
   * revoked the wrong one. Letting a single click do both would put an
   * irreversible action where a reversible one belongs.
   *
   * Local-only, like minting. A token taken from the phone can already do
   * nothing here, but the rule is worth keeping uniform: the device list is
   * administered from the machine that owns it.
   */
  app.delete('/api/devices/:id', async (request, reply) => {
    if (!request.isLocal) {
      return reply.code(403).send({ error: 'devices can only be removed from the PC running the server' });
    }

    const { id } = request.params as { id: string };
    const [device] = await db.select().from(devices).where(eq(devices.id, id));
    if (!device) return reply.code(404).send({ error: 'no such device' });

    // Deleting a live device would free its token hash and leave whatever holds
    // it with a 401 and no explanation on this screen — which looks exactly like
    // the server having broken. Revoke it first and the row says so.
    if (!device.revokedAt) {
      return reply.code(409).send({ error: 'revoke it first — only a revoked device can be removed' });
    }

    await db.delete(devices).where(eq(devices.id, id));
    return reply.code(204).send();
  });
}
