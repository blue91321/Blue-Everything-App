import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';

/**
 * Live updates, so the phone and the desktop don't drift apart.
 *
 * Server-sent events rather than polling: one idle connection per open client
 * costs nothing, whereas polling every 15 seconds would wake the database on a
 * schedule forever whether or not anything changed. Rather than WebSockets,
 * because updates only ever flow one way and this needs no extra dependency.
 */

export type ChangeScope = 'tasks' | 'habits' | 'notes' | 'nudges' | 'settings' | 'devices' | 'time' | 'vault';

interface ChangeEvent {
  scope: ChangeScope | 'all';
  at: number;
}

class ChangeBus extends EventEmitter {
  emitChange(scope: ChangeScope | 'all'): void {
    this.emit('change', { scope, at: Date.now() } satisfies ChangeEvent);
  }
}

export const changes = new ChangeBus();
// One listener per connected client; the default cap of 10 is a leak warning,
// not a limit, and several browser tabs would trip it for no reason.
changes.setMaxListeners(0);

/** Which part of the app a mutating request touched, from its path. */
function scopeForPath(path: string): ChangeScope | 'all' {
  const segment = path.replace(/^\/api\//, '').split(/[/?]/)[0];
  switch (segment) {
    case 'tasks':
    case 'projects':
      return 'tasks';
    case 'habits':
      return 'habits';
    case 'notes':
      return 'notes';
    case 'nudges':
      return 'nudges';
    case 'settings':
      return 'settings';
    case 'devices':
      return 'devices';
    case 'time':
      return 'time';
    case 'vault':
      return 'vault';
    default:
      return 'all';
  }
}

/**
 * Announce every successful mutation, from one hook rather than from each
 * route, so a route added later is covered automatically.
 *
 * MUST be attached to the root instance, not inside a `register`. Fastify
 * encapsulates plugins: a hook added inside one only sees that plugin's own
 * routes, so registering this alongside the SSE route made it fire for
 * `/api/events` and nothing else.
 */
export function registerChangeAnnouncer(app: FastifyInstance): void {
  app.addHook('onResponse', async (request, reply) => {
    if (request.method === 'GET' || !request.url.startsWith('/api/')) return;
    if (reply.statusCode >= 400) return;

    // The agent posts attention every few seconds and it is not, in itself, a
    // data change. Broadcasting it would turn this into polling with extra
    // steps. That route announces its own changes when it actually makes any.
    if (request.url.startsWith('/api/attention')) return;

    // Same reasoning for voice: with an always-on microphone `/api/voice/command`
    // fires on ambient speech, and most of those end in "not for me" — a wrong
    // speaker, or nothing that matched. Announcing all of them would reload
    // every open client whenever the room was noisy. These routes announce
    // themselves, with the right scope, only when they actually wrote something.
    if (request.url.startsWith('/api/voice/')) return;

    changes.emitChange(scopeForPath(request.url));
  });
}

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/events', (request, reply) => {
    // Fastify must not try to manage this response; it stays open.
    reply.hijack();

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Tells any reverse proxy in front of this not to buffer the stream.
      'x-accel-buffering': 'no',
    });
    reply.raw.write(': connected\n\n');

    const onChange = (event: ChangeEvent) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    changes.on('change', onChange);

    // A comment line every 25s keeps sleepy networks from dropping an idle
    // connection, and lets the client notice a dead server promptly.
    const keepAlive = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);

    const cleanup = () => {
      clearInterval(keepAlive);
      changes.off('change', onChange);
    };
    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
  });
}
