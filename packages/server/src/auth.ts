/**
 * Single-user auth: this machine is trusted, everything else needs a token.
 *
 * There are no accounts and no login flow, because there is exactly one person.
 * What this protects against is everything *else* on the tailnet — a tailnet is
 * a private network, not a trusted one, and the moment this server moves to a
 * VPS the distinction stops being academic.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { eq, isNull, and } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from './db/client.js';
import { devices } from './db/schema.js';
import { config } from './config.js';

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

declare module 'fastify' {
  interface FastifyRequest {
    deviceId: string | null;
    deviceKind: string | null;
    /** True when the caller is a browser on this very machine. */
    isLocal: boolean;
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Is this request from a browser or process on this same PC?
 *
 * Deliberately reads the raw socket address, never `request.ip`, because
 * `request.ip` honours X-Forwarded-For when trustProxy is on — and a header
 * anyone can set must never grant trust.
 *
 * The Origin check is what stops a malicious web page from quietly POSTing to
 * http://127.0.0.1:8787 in the background while Blake reads it. Such a request
 * carries `Origin: https://evil.example`, which will not match this server's
 * own host, so it is refused. That also covers DNS rebinding, where the
 * attacker's name resolves to 127.0.0.1 but the Origin still gives it away.
 */
export function isTrustedLocal(request: FastifyRequest): boolean {
  // Behind a reverse proxy every request arrives from loopback, so the whole
  // signal is meaningless and local trust has to be off.
  if (config.TRUST_PROXY) return false;

  const address = request.socket.remoteAddress ?? '';
  if (!LOOPBACK.has(address)) return false;

  // Browsers send this on cross-site requests; if it's there, believe it.
  const site = request.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false;

  const origin = request.headers.origin;
  if (!origin) return true; // curl, the agent, a same-origin navigation

  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  request.deviceId = null;
  request.deviceKind = null;
  request.isLocal = false;

  // Only the API is protected. The PWA's shell — HTML, JS, icons — has to load
  // before there's anywhere to type a token, and it carries no data of its own;
  // everything it displays comes from an authenticated /api call.
  if (!request.url.startsWith('/api/')) return;
  if (!config.AUTH_REQUIRED) {
    request.isLocal = true;
    return;
  }

  const header = request.headers.authorization;

  if (!header?.startsWith('Bearer ')) {
    // No token offered. On this machine that's fine — requiring Blake to paste
    // a token into a browser on the same PC that's running the server protects
    // nothing and is the single biggest piece of friction in the app.
    if (isTrustedLocal(request)) {
      request.isLocal = true;
      request.deviceKind = 'local';
      return;
    }
    return reply.code(401).send({ error: 'missing bearer token' });
  }

  const presented = hashToken(header.slice('Bearer '.length).trim());
  const candidates = await db.select().from(devices).where(isNull(devices.revokedAt));
  const device = candidates.find((d) => constantTimeEquals(d.tokenHash, presented));

  if (!device) {
    return reply.code(401).send({ error: 'unknown or revoked device' });
  }

  request.deviceId = device.id;
  request.deviceKind = device.kind;
  request.isLocal = isTrustedLocal(request);

  // Fire-and-forget: a failed heartbeat write must never fail the request.
  db.update(devices)
    .set({ lastSeenAt: Date.now() })
    .where(and(eq(devices.id, device.id)))
    .catch(() => {});
}
