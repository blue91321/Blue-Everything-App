/**
 * Which parts of the app this install runs, and switching them on and off.
 *
 * The manifest itself lives in `@everything/shared/features` and is read by the
 * server, the agent and the CLI. This route exists because the PWA is the one
 * package that cannot import it — see CLAUDE.md on keeping zod out of that
 * bundle — so the facts are handed over as plain JSON.
 *
 * ### Why a write here rather than only in the CLI
 *
 * `npm run features -- --set voice=off` has always done exactly this. Having it
 * *only* there meant the answer to "how do I turn the microphone off" was "open
 * a terminal", which is the friction this app removes everywhere else — there
 * are three double-clickable files in the repo root for the same reason.
 *
 * ### It takes a restart, and says so
 *
 * `features.ts` resolves the set **once, at module load**, because half the
 * app's structure depends on it: routes are registered or not, the agent
 * imports a folder or does not. Re-resolving live would mean unregistering
 * Fastify routes at runtime, which is a large and fragile thing to build for a
 * switch flipped twice a year. So the file is written, `pendingRestart` says
 * the running set no longer matches it, and the tray's **Restart** is one
 * click away.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { FEATURE_LIST, isFeatureId, resolveFeatures, type FeatureId } from '@everything/shared/features';
import { config } from '../config.js';
import { activeFeatures, enabledFeatures, featuresFilePath, missingFeatures } from '../features.js';

/**
 * Imported, never re-derived.
 *
 * This file is one directory deeper than `features.ts`, so counting `..` by
 * hand here got it wrong by one — and wrong in the worst way, because reading
 * and writing the same wrong path is self-consistent. The screen reported the
 * change and asked for a restart; the restart would have changed nothing.
 */
const featuresPath = featuresFilePath;

/**
 * What `features.json` says right now, or null if it does not exist.
 *
 * Read per request rather than cached: it is a handful of bytes, it is read
 * when somebody opens a settings tab, and the whole point is to report what is
 * on disk rather than what was on disk at boot.
 */
function readFile(): Record<string, unknown> | null {
  if (!existsSync(featuresPath)) return null;
  try {
    return JSON.parse(readFileSync(featuresPath, 'utf8')) as Record<string, unknown>;
  } catch {
    // A malformed file is reported as absent here rather than thrown: the
    // screen's job is to let you fix it, and refusing to render is the opposite
    // of that. The *server* still refuses to boot on one, which is where it
    // matters.
    return null;
  }
}

/** Booleans only — the `$comment` array in the example file is not a feature. */
function chosenInFile(): Partial<Record<string, boolean>> {
  const raw = readFile() ?? {};
  const out: Partial<Record<string, boolean>> = {};
  for (const [key, value] of Object.entries(raw)) if (typeof value === 'boolean') out[key] = value;
  return out;
}

/**
 * `EVERYTHING_FEATURES` wins over the file, so with it set the switches on the
 * screen would write something that changes nothing. Saying so is the only
 * honest option — a toggle that silently does not apply is worse than one that
 * is disabled with a reason.
 */
function lockedByEnv(): boolean {
  return config.FEATURES.trim().length > 0;
}

export async function featureRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/features', async () => {
    const file = chosenInFile();
    const running = enabledFeatures;
    const missing = new Set(missingFeatures());
    const active = new Set(activeFeatures());

    // What the file *would* produce, so the screen can say a restart is owed
    // rather than making you remember whether you changed something.
    const wanted = resolveFeatures(lockedByEnv() ? undefined : file).enabled;
    const pendingRestart =
      !lockedByEnv() &&
      FEATURE_LIST.some((spec) => wanted.has(spec.id) !== running.has(spec.id));

    return {
      lockedByEnv: lockedByEnv(),
      pendingRestart,
      hasFile: readFile() !== null,
      features: FEATURE_LIST.map((spec) => ({
        id: spec.id,
        label: spec.label,
        blurb: spec.blurb,
        cost: spec.cost ?? null,
        removable: spec.removable,
        defaultEnabled: spec.defaultEnabled,
        /** What the app is running with right now. */
        running: running.has(spec.id),
        /** What it will run with after a restart. */
        wanted: wanted.has(spec.id),
        /** On, but its folders are gone from disk. A different problem. */
        missing: missing.has(spec.id),
        /** On, present, and its routes registered. */
        active: active.has(spec.id),
        owns: spec.owns,
      })),
    };
  });

  /**
   * Switch one on or off.
   *
   * Local only, like every other write that changes this machine rather than
   * the database — minting a device, the avatar, the logo. Which parts of the
   * app run is not something the phone on the tailnet should decide.
   */
  app.patch('/api/features', async (request, reply) => {
    if (!request.isLocal) {
      return reply.code(403).send({ error: 'features can only be changed from the PC running the server' });
    }
    if (lockedByEnv()) {
      return reply.code(409).send({
        error: 'EVERYTHING_FEATURES is set, and it overrides features.json — unset it to use these switches',
      });
    }

    const body = z.object({ id: z.string(), enabled: z.boolean() }).parse(request.body);
    if (!isFeatureId(body.id)) return reply.code(400).send({ error: `no such feature: ${body.id}` });

    /*
     * Merged into whatever is already there rather than written fresh.
     *
     * The example file carries a `$comment` array explaining itself, and anyone
     * who copied it has that text. Rewriting the file from the feature list
     * alone would silently delete it, which is a rude thing to do to a file
     * somebody is expected to hand-edit.
     */
    const existing = readFile() ?? {};
    const next: Record<string, unknown> = { ...existing };
    // Every feature is written, not just the one that changed, so the file is a
    // complete statement rather than a diff against defaults that may move.
    for (const spec of FEATURE_LIST) {
      const current = typeof existing[spec.id] === 'boolean' ? (existing[spec.id] as boolean) : spec.defaultEnabled;
      next[spec.id] = spec.id === body.id ? body.enabled : current;
    }

    writeFileSync(featuresPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');

    const wanted = resolveFeatures(chosenInFile()).enabled;
    return {
      ok: true,
      id: body.id as FeatureId,
      wanted: wanted.has(body.id),
      // Almost always true after a write, but computed rather than assumed —
      // switching something back to what is already running owes no restart.
      pendingRestart: FEATURE_LIST.some((spec) => wanted.has(spec.id) !== enabledFeatures.has(spec.id)),
    };
  });
}
