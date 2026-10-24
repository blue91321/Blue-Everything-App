/**
 * First run: whether this copy has been through onboarding, and which parts of
 * the app it shows.
 *
 * Onboarding is the PWA's (`Onboarding.tsx`): install to the Home Screen, pick
 * what's on, then notifications and quiet hours, last. This holds the two
 * answers that outlive it, per copy, on the server like the theme, so every
 * device of one person agrees.
 *
 * **"What's on" is what the app shows, not what it loads.** Hiding a part takes
 * it out of the menu, Home and the screen you land on, at once and from a
 * phone. Switching a part off for real (Settings → Packages) unloads it but
 * takes a restart and is the PC's to do, which is the wrong price for
 * somebody's first minute. A part that is hidden still runs, and on a new copy
 * that is nothing: a habit nobody made reminds nobody.
 *
 * A file rather than a settings column: two values, read with the session, and
 * a migration is a step in a journal every copy must take forever.
 */
import { readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { isGuest } from './config.js';
import { configuration, dataDir } from './paths.js';
import { changes } from './events.js';

const FILE = resolve(dataDir, 'onboarding.json');
const PART = /^[a-z0-9][a-z0-9:#-]{0,63}$/;

export type Preset = 'manga' | 'everything' | 'custom';

export interface Onboarding {
  /** Been through it. The host starts as done: it was set up before onboarding existed. */
  done: boolean;
  /** The screens to show, by menu id, or null for all of them. Settings always shows. */
  shown: string[] | null;
  /**
   * Which of the three was picked. "Everything" takes in new screens by itself
   * and "just the manga" means only manga, so only a hand-picked list is asked
   * about a screen an update brings (`NewScreens.tsx`). Read from `shown` for a
   * file written before this.
   */
  preset: Preset;
  /**
   * Every screen there was when the list was last chosen or asked about, so
   * a screen not on it is new. Null until a hand-picked copy first records it.
   */
  known: string[] | null;
}

/** The choice a list reads as, for a file or a request that does not say. */
const presetOf = (shown: string[] | null): Preset =>
  shown === null ? 'everything' : shown.length === 1 && shown[0] === 'manga' ? 'manga' : 'custom';

const isPart = (p: unknown): p is string => typeof p === 'string' && PART.test(p);
const parts = (value: unknown): string[] | null =>
  Array.isArray(value) && value.length <= 64 && value.every(isPart) ? [...new Set(value as string[])] : null;

export function readOnboarding(): Onboarding {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<Onboarding>;
    const shown = Array.isArray(raw.shown) ? raw.shown.filter(isPart) : null;
    const preset: Preset =
      raw.preset === 'manga' || raw.preset === 'everything' || raw.preset === 'custom' ? raw.preset : presetOf(shown);
    return { done: raw.done === true, shown, preset, known: Array.isArray(raw.known) ? raw.known.filter(isPart) : null };
  } catch {
    // A Just Manga install's own copy opens on Manga, the one thing it is for.
    if (!isGuest && configuration === 'just-manga') return { done: true, shown: ['manga'], preset: 'manga', known: null };
    return { done: !isGuest, shown: null, preset: 'everything', known: null };
  }
}

function writeOnboarding(next: Onboarding): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(`${FILE}.tmp`, JSON.stringify(next));
  renameSync(`${FILE}.tmp`, FILE);
}

export async function onboardingRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Finish it, start it again (Settings → General), or choose what shows.
   *
   * From any device of this copy, not only the PC: it is about how this
   * person's app looks, and onboarding happens on their phone.
   */
  app.put('/api/onboarding', async (request, reply) => {
    const body = request.body as { done?: unknown; shown?: unknown; preset?: unknown; known?: unknown } | null;
    const now = readOnboarding();
    if (body?.done !== undefined) {
      if (typeof body.done !== 'boolean') return reply.code(400).send({ error: 'done is true or false' });
      now.done = body.done;
    }
    if (body?.shown !== undefined) {
      const list = body.shown === null ? null : parts(body.shown);
      if (body.shown !== null && list === null) return reply.code(400).send({ error: 'shown is a list of screens, or null for all' });
      now.shown = list;
      // A list sent without its choice: the choice is what the list reads as.
      if (body.preset === undefined) now.preset = presetOf(list);
    }
    if (body?.preset !== undefined) {
      if (body.preset !== 'manga' && body.preset !== 'everything' && body.preset !== 'custom') {
        return reply.code(400).send({ error: 'preset is manga, everything or custom' });
      }
      now.preset = body.preset;
    }
    if (body?.known !== undefined) {
      const list = parts(body.known);
      if (list === null) return reply.code(400).send({ error: 'known is a list of screens' });
      now.known = list;
    }
    writeOnboarding(now);
    changes.emitChange('settings');
    return now;
  });
}
