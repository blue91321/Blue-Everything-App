/**
 * What happens when the app's window is closed: keep running in the
 * background (the tray icon), or stop. Asked in onboarding on a computer and
 * kept in Settings → General, per copy, in `data/closing.json`.
 *
 * **It closes anyway when nothing needs it.** The background exists for a few
 * things: reminders that pop up, voice, and on the host's PC the server itself,
 * which a phone and friends' copies reach. With none of those on (a friend
 * here only for manga), keeping a process in the tray would be keeping it for
 * nothing, so the window closing ends it whichever was chosen.
 *
 * **What it would stop is said, not inferred.** `keeps` lists, in words, what
 * needs the background right now, for the side asking: `host` for the PC that
 * runs the server, `desktop` for the desktop client on a friend's PC. The
 * setting shows that list live, and the agent puts it in the popup it raises as
 * the window closes, so nobody finds out from a reminder that never came.
 *
 * The agent does the watching and the stopping (it owns the PC); this decides.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, gt, inArray, isNotNull, isNull, ne, or, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from './db/client.js';
import { devices, habits, tasks } from './db/schema.js';
import { isGuest } from './config.js';
import { dataDir } from './paths.js';
import { getSettings } from './nudge-engine.js';
import { runningCopies } from './instances.js';
import { changes } from './events.js';

const FILE = resolve(dataDir, 'closing.json');

export interface Closing {
  /** `keep`: stay in the tray. `quit`: stop with the window. */
  mode: 'keep' | 'quit';
  /** The one-time "still running in the background" popup has been shown. */
  noticeShown: boolean;
}

export function readClosing(): Closing {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<Closing>;
    return { mode: raw.mode === 'quit' ? 'quit' : 'keep', noticeShown: raw.noticeShown === true };
  } catch {
    return { mode: 'keep', noticeShown: false };
  }
}

function writeClosing(next: Closing): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(`${FILE}.tmp`, JSON.stringify(next));
  renameSync(`${FILE}.tmp`, FILE);
}

/** What needs the background right now, for that side, in words. Empty means nothing does. */
export async function keeps(side: 'host' | 'desktop'): Promise<string[]> {
  const out: string[] = [];
  const settings = await getSettings();
  if (settings.voiceEnabled) out.push('voice commands');

  const [habit] = await db
    .select({ id: habits.id })
    .from(habits)
    .where(and(eq(habits.active, 1), or(isNotNull(habits.reminderEveryMinutes), ne(habits.mode, 'target'))))
    .limit(1);
  const [task] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(isNotNull(tasks.dueAt), inArray(tasks.status, ['todo', 'doing'])))
    .limit(1);
  if (habit || task) out.push(side === 'host' ? 'reminders, on this PC and your phone' : 'reminders popping up on this PC');

  if (side === 'host' && !isGuest) {
    const copies = await runningCopies();
    if (copies.length > 0) out.push(`friends' copies (${copies.join(', ')})`);
    // A phone or another device used in the last month reaches the server here.
    const [other] = await db
      .select({ id: devices.id })
      .from(devices)
      .where(
        and(
          isNull(devices.revokedAt),
          inArray(devices.kind, ['phone', 'browser', 'extension']),
          gt(devices.lastSeenAt, Date.now() - 30 * 24 * 60 * 60_000)
        )
      )
      .limit(1);
    if (other) out.push('your phone and other devices reaching it');
  }
  return out;
}

export async function closingRoutes(app: FastifyInstance): Promise<void> {
  /** The choice, and what closing would stop right now. `side` is `host` (the default) or `desktop`. */
  app.get('/api/closing', async (request) => {
    const side = (request.query as { side?: string }).side === 'desktop' ? 'desktop' : 'host';
    return { ...readClosing(), side, keeps: await keeps(side) };
  });

  /** From any device of this copy: how this person's app closes is theirs. */
  app.put('/api/closing', async (request, reply) => {
    const body = request.body as { mode?: unknown; noticeShown?: unknown } | null;
    const now = readClosing();
    if (body?.mode !== undefined) {
      if (body.mode !== 'keep' && body.mode !== 'quit') return reply.code(400).send({ error: 'mode is keep or quit' });
      now.mode = body.mode;
    }
    if (body?.noticeShown !== undefined) {
      if (typeof body.noticeShown !== 'boolean') return reply.code(400).send({ error: 'noticeShown is true or false' });
      now.noticeShown = body.noticeShown;
    }
    writeClosing(now);
    changes.emitChange('settings');
    return now;
  });
}
