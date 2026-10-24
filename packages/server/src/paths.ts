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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config, instanceRoot } from './config.js';

/** An override if one is set, otherwise the default. */
const or = (override: string, fallback: string): string =>
  override.trim() === '' ? fallback : resolve(override.trim());

/** `packages/server/src` — where this file lives. */
export const serverSrc = dirname(fileURLToPath(import.meta.url));

/** The checkout root: up out of `src`, `server` and `packages`. */
export const repoRoot = resolve(serverSrc, '../../..');

/**
 * Which download this install came from: `everything`, or `just-manga`, the
 * reader with nothing else in the folder (`package-release.mjs --config`).
 * Written into the zip as `configuration.json`, so a git clone, which has
 * none, is everything. Only first-run defaults read it (onboarding opens a
 * Just Manga install on Manga); what runs is still what is on disk.
 */
export const configuration: 'everything' | 'just-manga' = (() => {
  try {
    const raw = JSON.parse(readFileSync(resolve(repoRoot, 'configuration.json'), 'utf8').replace(/^\uFEFF/, '')) as {
      configuration?: unknown;
    };
    return raw.configuration === 'just-manga' ? 'just-manga' : 'everything';
  } catch {
    return 'everything';
  }
})();

/**
 * A guest copy's own folder (`instances/<name>/`), or empty for the host. See
 * `isGuest` in `config.ts`. Everything below that a copy writes is moved into
 * it, so two copies on one PC share no file.
 */
export { instanceRoot };

/** Beside the database, holding pictures and the like. */
export const dataDir = instanceRoot ? resolve(instanceRoot, 'data') : resolve(serverSrc, '../data');

/** Where `start.ps1` writes this copy's logs, and where the app reads them back. */
export const logsDir = instanceRoot ? resolve(instanceRoot, 'logs') : resolve(repoRoot, 'logs');

/** The per-install feature switches. Hand-editable; see `features.ts`. */
export const featuresFile = instanceRoot ? resolve(instanceRoot, 'features.json') : resolve(repoRoot, 'features.json');

/** Packages that ship with the app — committed, and loaded like any other. */
export const shippedModulesRoot = or(config.MODULES_SHIPPED, resolve(repoRoot, 'packages/modules'));

/** Packages you installed. Gitignored; see the note in `.gitignore`. */
export const installedModulesRoot = or(
  config.MODULES_INSTALLED,
  instanceRoot ? resolve(instanceRoot, 'modules') : resolve(repoRoot, 'modules')
);

/** Which installed packages are switched on. */
export const modulesStateFile = or(
  config.MODULES_STATE,
  instanceRoot ? resolve(instanceRoot, 'modules.json') : resolve(repoRoot, 'modules.json')
);

/** What the tray's Restart runs, and what the in-app button runs too. */
export const restartScript = resolve(repoRoot, 'scripts/restart.ps1');

/**
 * Puts the Desktop and Start Menu shortcuts there, and registers `everything:`.
 *
 * The same script `Create Desktop Icon.cmd` runs, named here for the same
 * reason everything else in this file is: it has been counted by hand from a
 * route before and disabled the button every time.
 */
export const shortcutScript = resolve(repoRoot, 'scripts/create-shortcut.ps1');

/** Updates to the newest release, backing your data up first. */
export const updateScript = resolve(repoRoot, 'scripts/update.ps1');

/**
 * The one script that knows how to launch the agent.
 *
 * Named here rather than spelled out at the call site for the reason this file
 * exists at all: the repo root has been counted by hand three times in this
 * project and disabled a button every time.
 */
export const startScript = resolve(repoRoot, 'scripts/start.ps1');
