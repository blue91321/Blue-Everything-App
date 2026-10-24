/**
 * What a person is called: the name onboarding asks for, shown to everyone
 * else on this PC wherever something of theirs appears. Who asked for a
 * source, who rated a series, who a kept series was kept for.
 *
 * **A label, not an identity.** Everything is still recorded by the copy's own
 * name (`sam`), which never changes; the display name is looked up when it is
 * shown, so changing it renames every place at once and nothing has to be
 * rewritten.
 *
 * **Choosing one is optional.** Until a name is chosen, a friend's copy is
 * called what the host named it when making it (`sam`), and the host is
 * called "user" (`defaultName`).
 *
 * Each copy keeps its own in `data/profile.json`, the host included. A guest
 * also hands it to the host (`PUT /api/host/name`, with its key), which writes
 * it into that copy's `instance.json`: the host reads its own files rather than
 * a copy's, the plan A rule, and in Docker there would be no copy's files to
 * read.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config, isGuest } from './config.js';
import { dataDir } from './paths.js';
import { changes } from './events.js';
import { copyOfDevice, displayNameOf, readHostKey, setDisplayName } from './instances.js';

const FILE = resolve(dataDir, 'profile.json');

/** Trimmed, spaces collapsed, no control characters, 1 to 40 long; otherwise null. */
export function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return name.length >= 1 && name.length <= 40 ? name : null;
}

/** What this copy is called until a name is chosen: the name the host gave it, or "user" for the host. */
export function defaultName(): string {
  return config.EVERYTHING_INSTANCE || 'user';
}

/** This copy's display name, or null until one is chosen. */
export function ownName(): string | null {
  try {
    return cleanName((JSON.parse(readFileSync(FILE, 'utf8')) as { name?: unknown }).name);
  } catch {
    return null;
  }
}

function writeName(name: string | null): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(`${FILE}.tmp`, JSON.stringify({ name }));
  renameSync(`${FILE}.tmp`, FILE);
}

/** A guest's name, handed to the host. Quietly: the host may be restarting. */
async function tellHost(name: string | null): Promise<void> {
  const key = readHostKey();
  if (!key) return;
  try {
    await fetch(`${config.EVERYTHING_HOST_URL.replace(/\/$/, '')}/api/host/name`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Told again at the next start.
  }
}

/**
 * Who someone is, to whoever is asking. Recorded names are `you` for the host
 * and a copy's own name otherwise; `asking` is the same, for the viewer. Your
 * own entry reads "you", the host's reads its display name, and a friend's
 * theirs.
 */
export function nameFor(who: string, asking: string): string {
  if (who === asking) return 'you';
  if (who === 'you') return ownName() ?? defaultName();
  return displayNameOf(who);
}

export async function nameRoutes(app: FastifyInstance): Promise<void> {
  /** A copy telling the host its name. Only a copy's key, for itself. */
  app.put('/api/host/name', async (request, reply) => {
    if (isGuest) return reply.code(404).send({ error: 'only the host keeps names' });
    const copy = await copyOfDevice(request.deviceId);
    if (!copy) return reply.code(403).send({ error: 'only a copy on this PC, for itself' });
    const body = request.body as { name?: unknown } | null;
    const name = body?.name === null ? null : cleanName(body?.name);
    if (name === null && body?.name !== null) return reply.code(400).send({ error: 'a name of 1 to 40 characters' });
    setDisplayName(copy, name);
    changes.emitChange('all');
    return { name };
  });

  // The host may have been away when it was last set, or this copy predates names.
  if (isGuest) setTimeout(() => void tellHost(ownName()), 5_000).unref();

  /** From any device of this copy: it is this person's name, set on their phone. */
  app.put('/api/profile/name', async (request, reply) => {
    const body = request.body as { name?: unknown } | null;
    const name = body?.name === null || body?.name === '' ? null : cleanName(body?.name);
    if (name === null && body?.name !== null && body?.name !== '') {
      return reply.code(400).send({ error: 'a name of 1 to 40 characters' });
    }
    writeName(name);
    if (isGuest) await tellHost(name);
    changes.emitChange('settings');
    return { name };
  });
}
