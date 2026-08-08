/**
 * Which features this install runs, and which are actually on disk.
 *
 * Two separate questions, deliberately:
 *
 *   - **enabled** is a choice, made in `features.json` (or `EVERYTHING_FEATURES`).
 *   - **installed** is a fact about the filesystem, discovered by trying to
 *     import the thing and catching the module-not-found.
 *
 * Keeping them apart is what lets the app tell "you switched the vault off"
 * from "the vault folder is gone", which want different messages and have
 * different fixes. Collapsing them into one boolean would make a deleted folder
 * look like a settings mistake.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { FEATURES, isFeatureId, resolveFeatures, type FeatureId } from '@everything/shared/features';
import { config } from './config.js';

/**
 * Anchored to this file, never to the working directory — the same rule the
 * database path follows, and for the same reason: Task Scheduler starts
 * processes in C:\Windows\System32, where a relative path finds nothing.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function readFeaturesFile(): Partial<Record<string, boolean>> | undefined {
  const path = resolve(repoRoot, 'features.json');
  if (!existsSync(path)) return undefined;

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const out: Partial<Record<string, boolean>> = {};
    for (const [key, value] of Object.entries(parsed)) {
      // The example file carries a "$comment" array to explain itself. Skipping
      // non-booleans means that stays legal rather than being a parse error.
      if (typeof value === 'boolean') out[key] = value;
    }
    return out;
  } catch (error) {
    // A malformed file must not silently mean "defaults" — that would turn a
    // stray comma into every feature quietly switching back on.
    throw new Error(`features.json is not valid JSON: ${(error as Error).message}`);
  }
}

/**
 * `FEATURES=vault,voice` wins over the file, for containers and for trying
 * something without editing anything. Naming any feature means the list is
 * exhaustive — everything unnamed is off, which is the only reading that makes
 * the variable useful for "just this, please".
 *
 * `FEATURES=none` is core only. It needs its own word because an empty variable
 * cannot be told apart from an unset one: `FEATURES=` reads as "I did not set
 * this" and defers to the file, which is the opposite of what somebody typing
 * it means. A sentinel is uglier than an empty string and unambiguous, which is
 * the better trade for a switch that decides how much of the app exists.
 */
function readFeaturesEnv(): Partial<Record<string, boolean>> | undefined {
  const raw = config.FEATURES.trim();
  if (!raw) return undefined;

  if (raw.toLowerCase() === 'none') {
    return Object.fromEntries(Object.keys(FEATURES).map((id) => [id, false]));
  }

  const named = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const out: Partial<Record<string, boolean>> = {};
  for (const id of Object.keys(FEATURES)) out[id] = false;
  for (const id of named) out[id] = true;
  return out;
}

const resolved = resolveFeatures(readFeaturesEnv() ?? readFeaturesFile());

export const enabledFeatures: Set<FeatureId> = resolved.enabled;
export const featureNotes: string[] = resolved.notes;

export function isEnabled(id: FeatureId): boolean {
  return enabledFeatures.has(id);
}

/** What actually loaded, for `/api/session` and the Settings screen. */
const installed = new Set<FeatureId>();
const missing = new Set<FeatureId>();

export function activeFeatures(): FeatureId[] {
  return [...enabledFeatures].filter((id) => !missing.has(id));
}

export function missingFeatures(): FeatureId[] {
  return [...missing];
}

/**
 * Register a feature's routes, if it is both switched on and present.
 *
 * The `load` callback is a `() => import('./features/x/routes.js')` rather than
 * a path string, because a bare dynamic `import(variable)` defeats every
 * bundler and type-checker there is. Written this way the import is statically
 * visible, and a deleted folder is a runtime miss we can catch — which is
 * exactly the behaviour asked for.
 */
export async function registerFeature(
  app: FastifyInstance,
  id: FeatureId,
  load: () => Promise<{ routes: (app: FastifyInstance) => Promise<void> }>
): Promise<void> {
  if (!isEnabled(id)) {
    app.log.info(`feature ${id}: off`);
    return;
  }

  try {
    const mod = await load();
    await app.register(mod.routes);
    installed.add(id);
    app.log.info(`feature ${id}: on`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Only a missing module means "not installed". Anything else is a real bug
    // inside a feature that *is* present, and swallowing it would turn a typo
    // into a silently absent half of the app.
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      missing.add(id);
      app.log.warn(`feature ${id}: on, but not installed — its folder has been removed`);
      return;
    }
    throw error;
  }
}

/** Turn an id into something a person can read, for logs and error bodies. */
export function featureLabel(id: FeatureId): string {
  return FEATURES[id].label;
}

export { isFeatureId };
