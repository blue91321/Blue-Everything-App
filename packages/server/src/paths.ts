/**
 * Where things are, defined once.
 *
 * This file exists because the repo root has now been counted by hand three
 * times and got wrong twice, both in `src/routes/`, which sits one directory
 * deeper than `src/` and so needs one more `..` than the obvious copy-paste:
 *
 *   - `routes/features.ts` read *and wrote* `packages/features.json`. Being
 *     wrong in both directions made it self-consistent and therefore
 *     convincing — the screen reported the change and asked for a restart, and
 *     the restart would have changed nothing at all.
 *   - `routes/restart.ts` looked for `packages/scripts/restart.ps1`, decided the
 *     script was missing, and disabled the button that is meant to be the one
 *     thing that always works.
 *
 * Both were a `../` short of the truth, and both looked entirely reasonable in
 * the file they were written in. So the answer is not to be more careful; it is
 * to have one of these and import it.
 *
 * Anchored to this file's own location rather than the working directory, which
 * is the separate rule that matters just as much: Task Scheduler starts
 * processes in `C:\\Windows\\System32`, where a relative path finds nothing and
 * quietly creates the wrong thing somewhere nobody will look.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';

/** An override if one is set, otherwise the default. */
const or = (override: string, fallback: string): string =>
  override.trim() === '' ? fallback : resolve(override.trim());

/** `packages/server/src` — where this file lives. */
export const serverSrc = dirname(fileURLToPath(import.meta.url));

/** The checkout root: up out of `src`, `server` and `packages`. */
export const repoRoot = resolve(serverSrc, '../../..');

/** Beside the database, holding pictures and the like. */
export const dataDir = resolve(serverSrc, '../data');

/** The per-install feature switches. Hand-editable; see `features.ts`. */
export const featuresFile = resolve(repoRoot, 'features.json');

/** Packages that ship with the app — committed, and loaded like any other. */
export const shippedModulesRoot = or(config.MODULES_SHIPPED, resolve(repoRoot, 'packages/modules'));

/** Packages you installed. Gitignored; see the note in `.gitignore`. */
export const installedModulesRoot = or(config.MODULES_INSTALLED, resolve(repoRoot, 'modules'));

/** Which installed packages are switched on. */
export const modulesStateFile = or(config.MODULES_STATE, resolve(repoRoot, 'modules.json'));

/** What the tray's Restart runs, and what the in-app button runs too. */
export const restartScript = resolve(repoRoot, 'scripts/restart.ps1');

/**
 * The one script that knows how to launch the agent.
 *
 * Named here rather than spelled out at the call site for the reason this file
 * exists at all: the repo root has been counted by hand three times in this
 * project and disabled a button every time.
 */
export const startScript = resolve(repoRoot, 'scripts/start.ps1');
