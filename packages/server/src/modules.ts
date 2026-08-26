/**
 * Packages installed into `modules/`, as opposed to the features built in.
 *
 * The Packages screen asks two questions of every row, and they are the same
 * two `features.ts` keeps apart for the built-ins: **is it enabled** (a choice,
 * recorded in `modules.json`) and **is it installed** (a fact about the disk,
 * discovered by looking). Collapsing them would make "I switched the weather
 * off" and "the weather folder is gone" the same row with different fixes.
 *
 * ### One folder, which is the whole reason this exists
 *
 * A built-in feature owns up to three folders across three workspaces, so there
 * is no single directory to open, drag a zip into, or delete. A module is
 * defined as exactly one folder under `modules/` — that constraint is what buys
 * the Minecraft-style install, and it is why a module cannot simply be a
 * feature that happens to live elsewhere.
 *
 * ### This runs other people's code
 *
 * A module with a `server` entry is imported into the server process and handed
 * the Fastify instance. There is no sandbox, and this file does not pretend to
 * build one — a package here has the database, the filesystem and the network,
 * exactly like the code that ships in the repo. What it does instead is refuse
 * to *install* anything malformed, keep every path inside the folder it was
 * given, and say plainly on the screen what installing means.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  MODULES_STATE_FILE,
  MODULE_MANIFEST,
  fullPanelId,
  isModuleId,
  validateModuleManifest,
  type ModuleManifest,
  type ModuleProblem,
} from '@everything/shared/modules';
import { readZip, stripCommonPrefix, ZipError } from './zip.js';
import { parseJsonText } from './json.js';
import { featuresFilePath } from './features.js';
import { installedModulesRoot, modulesStateFile, shippedModulesRoot } from './paths.js';

/**
 * The one definition of where packages live, exported rather than re-derived.
 *
 * `routes/features.ts` counted `..` by hand for `features.json`, got it wrong by
 * one, and read *and wrote* the wrong file — self-consistent, and therefore
 * convincing right up until a restart changed nothing. Anything that needs this
 * path imports it.
 */
export const modulesDir = installedModulesRoot;

/**
 * The *other* root: packages that ship with the app.
 *
 * Two roots rather than one, and the reason is git. `modules/` is gitignored
 * deliberately — it holds code downloaded from elsewhere, which is emphatically
 * not ours to commit — so moving a first-party feature into it would delete that
 * feature from the repository. On a repo that is public, silently.
 *
 * So a shipped package lives in `packages/modules/`, which is committed and
 * typechecked with everything else, and is loaded by exactly the same machinery.
 * The difference a person sees is one line on the Packages screen: a shipped
 * package says **Built in** and has no Remove button, because removing it would
 * mean deleting part of your checkout rather than a folder you added.
 */
export const shippedModulesDir = shippedModulesRoot;

/** Which modules are switched on. Beside `features.json`, and the same shape. */
export const modulesStatePath = modulesStateFile;

export interface InstalledModule {
  id: string;
  /** Ships with the app, out of `packages/modules/`. Not removable from here. */
  shipped: boolean;
  /** Null when the folder has no readable manifest — the row still appears. */
  manifest: ModuleManifest | null;
  /** Why the manifest was rejected, so the screen can say rather than hide. */
  problems: ModuleProblem[];
  /** Absolute, for the "show files" button. Never sent to a non-local caller. */
  dir: string;
  /** Total size on disk, so a package that is quietly enormous is visible. */
  bytes: number;
  enabled: boolean;
  /** Loaded into the running process. False until a restart, like a feature. */
  running: boolean;
}

/** What actually loaded this boot, so the screen can tell saved from live. */
const loaded = new Set<string>();

/** Modules whose entry threw on import, kept so the row can show the reason. */
const loadErrors = new Map<string, string>();

function readState(): Record<string, boolean> {
  if (!existsSync(modulesStatePath)) return {};
  try {
    const parsed = parseJsonText(readFileSync(modulesStatePath, 'utf8')) as Record<string, unknown>;
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) if (typeof value === 'boolean') out[key] = value;
    return out;
  } catch {
    /*
     * Unlike `features.json`, a malformed file here is survivable rather than
     * fatal. That file decides how much of the *app* exists, so a stray comma
     * silently meaning "defaults" would switch core parts back on; this one
     * decides which optional extras run, and the worst case of treating it as
     * empty is that a package you installed does not start. Refusing to boot
     * over it would be the larger failure.
     */
    return {};
  }
}

function writeState(state: Record<string, boolean>): void {
  writeFileSync(modulesStatePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/**
 * Resolve a module folder, refusing anything that is not plainly inside.
 *
 * Two independent checks, because this feeds both the loader and `rm -rf`. The
 * id pattern alone would be enough today; the containment check is what keeps
 * it enough if that pattern is ever loosened. This app has already shipped one
 * path traversal by trusting a validated-looking id straight into a path, and
 * the fix there was the same shape: guard in the helper, so a second caller
 * cannot reintroduce it.
 */
function moduleDir(id: string, root: string = modulesDir): string {
  if (!isModuleId(id)) throw new Error(`not a valid package name: ${id}`);

  const dir = resolve(root, id);
  const rel = relative(root, dir);
  if (rel === '' || rel.startsWith('..') || rel.includes(sep) || resolve(root, rel) !== dir) {
    throw new Error(`refusing to touch a path outside the packages folder: ${id}`);
  }
  return dir;
}

/** Bytes on disk, walked rather than guessed. Bounded by the install limits. */
function folderSize(dir: string): number {
  let total = 0;
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) total += statSync(full).size;
    }
  };
  try {
    walk(dir);
  } catch {
    // A folder being read while it is deleted is not worth failing a listing.
  }
  return total;
}

/** Create `modules/` on demand, with a README, so opening it explains itself. */
export function ensureModulesDir(): void {
  if (existsSync(modulesDir)) return;
  mkdirSync(modulesDir, { recursive: true });
  writeFileSync(join(modulesDir, 'README.md'), README, 'utf8');
}

/**
 * Every folder under `modules/`, whether or not it is valid.
 *
 * A folder with a broken manifest is *listed with its problems* rather than
 * skipped. Skipping it would mean dragging in a bad zip and seeing nothing at
 * all happen, which is indistinguishable from the drag not having worked — the
 * single most confusing outcome available here.
 */
export function scanModules(): InstalledModule[] {
  const state = readState();
  const out: InstalledModule[] = [];
  const seen = new Set<string>();

  /*
   * Shipped first, and `seen` is what makes that ordering matter: a downloaded
   * package cannot shadow one that came with the app. Without it, dropping a
   * folder named `push` into `modules/` would silently replace the real push
   * feature with somebody else's code — which is the same class of problem the
   * reserved-id list solves for feature names, one level up.
   */
  for (const root of [shippedModulesDir, modulesDir]) {
    if (!existsSync(root)) continue;
    const shipped = root === shippedModulesDir;

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    if (seen.has(id)) continue;
    seen.add(id);
    const dir = join(root, id);

    if (!isModuleId(id)) {
      out.push({
        id,
        shipped,
        manifest: null,
        problems: [{ field: 'folder', message: 'the folder name is not a valid package name' }],
        dir,
        bytes: folderSize(dir),
        enabled: false,
        running: false,
      });
      continue;
    }

    let manifest: ModuleManifest | null = null;
    let problems: ModuleProblem[] = [];
    const manifestPath = join(dir, MODULE_MANIFEST);

    if (!existsSync(manifestPath)) {
      problems = [{ field: MODULE_MANIFEST, message: 'is missing — every package needs one at its root' }];
    } else {
      try {
        const parsed = parseJsonText(readFileSync(manifestPath, 'utf8'));
        const checked = validateModuleManifest(parsed);
        manifest = checked.manifest;
        problems = checked.problems;
        if (manifest && manifest.id !== id) {
          // The folder name is what everything else keys on, so a manifest
          // disagreeing with it would make the package unfindable by its own id.
          problems = [{ field: 'id', message: `says "${manifest.id}" but the folder is "${id}"` }];
          manifest = null;
        }
      } catch (error) {
        problems = [{ field: MODULE_MANIFEST, message: `is not valid JSON: ${(error as Error).message}` }];
      }
    }

    const loadError = loadErrors.get(id);
    if (loadError) problems = [...problems, { field: 'server', message: loadError }];

    out.push({
      id,
      shipped,
      manifest,
      problems,
      dir,
      bytes: folderSize(dir),
      /*
       * A shipped package defaults **on**, an installed one **off**. That is the
       * same distinction `FeatureSpec.defaultEnabled` already draws and for the
       * same reason: shipping something is this repo deciding it should run,
       * while dropping a zip in a folder is not yet a decision to run it.
       */
      enabled: state[id] ?? shipped,
      running: loaded.has(id),
    });
  }
  }

  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Carry a switch across when a feature becomes a package.
 *
 * A shipped package defaults **on**, which is right for one that has always
 * been a package and wrong for one that used to be a feature you had switched
 * **off**: moving `push` out of the manifest would otherwise turn phone
 * notifications back on for anybody who had deliberately silenced them, with
 * nothing on screen to explain why the phone started buzzing again.
 *
 * So `features.json` is consulted once, for shipped ids it still mentions, and
 * the answer is written into `modules.json`. It runs at boot and writes only
 * what is missing, so it is idempotent and stops doing anything the moment the
 * old key is gone.
 */
function carryOverFromFeatures(app: FastifyInstance): void {
  if (!existsSync(featuresFilePath)) return;

  let old: Record<string, unknown>;
  try {
    old = parseJsonText(readFileSync(featuresFilePath, 'utf8')) as Record<string, unknown>;
  } catch {
    // A malformed features.json is the *server's* problem to report at startup,
    // not something to fail a migration over.
    return;
  }

  const state = readState();
  let changed = false;

  for (const mod of scanModules()) {
    if (!mod.shipped) continue;
    const was = old[mod.id];
    if (typeof was !== 'boolean') continue;
    if (state[mod.id] !== undefined) continue;

    state[mod.id] = was;
    changed = true;
    app.log.info(`package ${mod.id}: carried "${was ? 'on' : 'off'}" over from features.json`);
  }

  if (changed) writeState(state);
}

/**
 * Is this package loaded right now?
 *
 * The package equivalent of `isEnabled`, and it asks the stronger question on
 * purpose: enabled-but-not-yet-restarted is not running, and a route that
 * accepted work on that basis would be promising something nothing can do
 * until the app is restarted.
 */
export function moduleIsRunning(id: string): boolean {
  return loaded.has(id);
}

/**
 * Every package loaded this boot, whether or not it draws anything.
 *
 * Folded into `session.features` alongside the real features, which is what
 * keeps the whole PWA working unchanged after a feature became a package:
 * `featureEnabled('voice')` is asked from inside the habit editor, the drawer
 * filters tabs on it, and the panel picker consults it. Teaching every one of
 * those about a second list would be a wide change to answer a question they
 * are already asking correctly — "is this optional part of the app on".
 */
export function runningModuleIds(): string[] {
  return [...loaded];
}

/** What a running package contributes to the app's own chrome. */
export interface PackageUi {
  id: string;
  label: string;
  tab: { label: string; glyph: string; order: number } | null;
  /** Full ids — `weather:now` — because that is what a settings row stores. */
  panels: { id: string; label: string; hint?: string }[];
}

/**
 * Packages with a browser half, for `/api/session`.
 *
 * **Running, not merely enabled**, so there is one rule on this screen rather
 * than two: switching a package on takes a restart, exactly as a feature does.
 * The browser half alone would not need one — it is fetched at runtime — but a
 * tab that appears immediately while the endpoints behind it wait for a restart
 * is a worse experience than a tab that appears when everything else does.
 */
export function runningPackages(): PackageUi[] {
  return scanModules()
    .filter((mod) => mod.running && mod.manifest?.web)
    .map((mod) => {
      const manifest = mod.manifest!;
      return {
        id: mod.id,
        label: manifest.label,
        tab: manifest.tab
          ? {
              label: manifest.tab.label,
              // The drawer wants a character; a package that offered none gets
              // one rather than a hole where every other tab has a glyph.
              glyph: manifest.tab.glyph ?? '◆',
              order: manifest.tab.order ?? 50,
            }
          : null,
        panels: (manifest.panels ?? []).map((panel) => ({
          id: fullPanelId(mod.id, panel.id),
          label: panel.label,
          ...(panel.hint === undefined ? {} : { hint: panel.hint }),
        })),
      };
    });
}

/**
 * The text of a package's browser entry, or null.
 *
 * Only for a **running** package, which matters more than it looks: it means a
 * package cannot serve script to the page from the moment it lands on disk, but
 * only once it has been switched on deliberately and the app restarted.
 */
export function readWebEntry(id: string): string | null {
  if (!isModuleId(id)) return null;

  const mod = scanModules().find((entry) => entry.id === id);
  if (!mod?.manifest?.web || !mod.running) return null;

  const file = resolve(mod.dir, mod.manifest.web);
  const rel = relative(mod.dir, file);
  // Third check on this path, after the manifest validator and the installer.
  // The file is handed to a browser to execute, so it is the last place to be
  // clever about trusting an earlier check.
  if (rel.startsWith('..') || !existsSync(file)) return null;

  return readFileSync(file, 'utf8');
}

/**
 * Switch one on or off.
 *
 * Off by default on install, unlike a built-in feature. A feature's default is
 * a decision this repo made about code it ships; a module is code that arrived
 * from somewhere else, and running it should be a thing you chose rather than a
 * consequence of dropping a file in a folder.
 */
export function setModuleEnabled(id: string, enabled: boolean): void {
  if (!isModuleId(id)) throw new Error(`not a valid package name: ${id}`);
  const state = readState();
  state[id] = enabled;
  writeState(state);
}

export interface InstallResult {
  id: string;
  label: string;
  version: string;
  /** True when a package of the same id was already there and was replaced. */
  replaced: boolean;
  files: number;
}

/**
 * Unpack a zip into `modules/<id>`.
 *
 * The manifest is read **out of the archive, before anything is written**, so
 * an archive that is not a package leaves nothing behind at all. Writing first
 * and validating after would mean a bad zip both fails *and* litters, and the
 * litter is what the next scan would then report as a broken package.
 */
export function installFromZip(buf: Buffer): InstallResult {
  ensureModulesDir();

  const entries = stripCommonPrefix(readZip(buf));
  if (entries.length === 0) throw new ZipError('the archive is empty');

  const manifestEntry = entries.find((entry) => entry.name === MODULE_MANIFEST);
  if (!manifestEntry) {
    throw new ZipError(
      `no ${MODULE_MANIFEST} at the root of the archive — this does not look like a Blue Everything package`
    );
  }

  let parsed: unknown;
  try {
    parsed = parseJsonText(manifestEntry.bytes.toString('utf8'));
  } catch (error) {
    throw new ZipError(`${MODULE_MANIFEST} is not valid JSON: ${(error as Error).message}`);
  }

  const { manifest, problems } = validateModuleManifest(parsed);
  if (!manifest) {
    throw new ZipError(`${MODULE_MANIFEST} is not usable — ${problems.map((p) => `${p.field} ${p.message}`).join('; ')}`);
  }

  const target = moduleDir(manifest.id);
  const replaced = existsSync(target);

  /*
   * Replacing removes the old folder first rather than merging over it. A merge
   * leaves files the new version does not have — an entry point that has since
   * been renamed, a stale asset — and "it still behaves like the old one after
   * updating" is a genuinely awful thing to debug.
   */
  if (replaced) rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  for (const entry of entries) {
    /*
     * Belt and braces: `readZip` already refused unsafe names, and the write
     * still confirms the resolved path is under the target. The zip reader's
     * check is about the archive; this one is about the filesystem, and they
     * are only the same check while both are correct.
     */
    const full = resolve(target, entry.name);
    const rel = relative(target, full);
    if (rel.startsWith('..') || resolve(target, rel) !== full) {
      rmSync(target, { recursive: true, force: true });
      throw new ZipError(`unsafe path in archive: "${entry.name}"`);
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, entry.bytes);
  }

  /*
   * Mark the folder as ESM, unless the package said otherwise itself.
   *
   * Node decides whether a `.js` file is a module or a script from the nearest
   * `package.json` going *up* the tree — and the nearest one above `modules/`
   * is this repo's root, which has no `type`. So a package written the obvious
   * way, with `export function routes(app)` in `server/index.js`, is loaded as
   * CommonJS and dies on its own first line.
   *
   * Found by installing exactly that package: the failure is
   * `Cannot require() ES Module … in a cycle`, which names neither the package
   * nor the real problem and would send an author looking at their own code.
   * The whole app is ESM, so this makes a package behave the way the app around
   * it does rather than imposing a convention.
   *
   * Never overwritten: an author who shipped a `package.json` has said what they
   * meant, including if they meant CommonJS.
   */
  const packageJson = resolve(target, 'package.json');
  if (!existsSync(packageJson)) {
    writeFileSync(packageJson, `${JSON.stringify({ type: 'module' }, null, 2)}\n`, 'utf8');
  }

  /*
   * Installed switched off. See `setModuleEnabled` — running code that arrived
   * from outside should be a decision, and the row appearing with its toggle
   * off is where that decision gets made.
   */
  const state = readState();
  if (state[manifest.id] === undefined) {
    state[manifest.id] = false;
    writeState(state);
  }

  return {
    id: manifest.id,
    label: manifest.label,
    version: manifest.version,
    replaced,
    files: entries.length,
  };
}

/**
 * Delete a package from disk, and forget its switch.
 *
 * **Shipped packages can be deleted too**, and that is a deliberate reversal.
 * The first version refused, on the reasoning that the folder is part of your
 * checkout — but "deleted: the folder is gone, and the app boots and says not
 * installed" has been one of this project's three documented levels from the
 * start, and `features-check` already proves every one of these survives it.
 * Refusing here would have made the Packages screen the one place that could
 * not do what the rest of the app promises.
 *
 * What it costs is stated on the row rather than prevented: a shipped package
 * comes back with `git checkout`, and an installed one needs the zip again.
 */
export function removeModule(id: string): void {
  const found = scanModules().find((mod) => mod.id === id);
  const dir = moduleDir(id, found?.shipped ? shippedModulesDir : modulesDir);
  if (!existsSync(dir)) throw new Error(`no package called "${id}" is installed`);

  rmSync(dir, { recursive: true, force: true });

  const state = readState();
  delete state[id];
  writeState(state);
}

/**
 * Open `modules/` in the file manager.
 *
 * This is the one place the server touches the shell, and it is worth saying
 * why it is not the agent's job like a hotkey or a browser launch. Those act on
 * *whatever machine you are sitting at*; this opens a folder that belongs to the
 * server's own filesystem, so routing it through the agent would open the wrong
 * machine's folder the day the server moves. It is local-only at the route, and
 * the path is a constant rather than anything a caller supplies.
 *
 * Detached and unref'd so a file manager left open does not hold the server
 * process alive — and `explorer.exe` in particular returns a non-zero exit code
 * on success, so nothing here reads one.
 */
export function openModulesFolder(): void {
  ensureModulesDir();

  const command =
    process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';

  const child = spawn(command, [modulesDir], { detached: true, stdio: 'ignore' });
  child.on('error', () => {
    // Nothing to do and nobody to tell — the route has already answered. A file
    // manager that will not open is not a reason to fail the request.
  });
  child.unref();
}

/**
 * Import every enabled module's server entry.
 *
 * Mirrors `registerFeature`, including the part that matters most: a module
 * that is switched on but whose folder has gone is *reported*, not fatal. The
 * difference is the import itself — a feature is a static `() => import(...)`
 * so bundlers and the type-checker can see it, while a module's path is only
 * known at runtime, so this is a genuine dynamic import of a file URL. That
 * works here because the server runs through `tsx` rather than a bundle.
 */
export async function registerModules(app: FastifyInstance): Promise<void> {
  carryOverFromFeatures(app);

  for (const mod of scanModules()) {
    if (!mod.enabled) continue;

    if (!mod.manifest) {
      app.log.warn(`package ${mod.id}: on, but its manifest is not usable — skipped`);
      continue;
    }
    if (!mod.manifest.server) {
      app.log.info(`package ${mod.id}: on (no server half)`);
      loaded.add(mod.id);
      continue;
    }

    const entry = resolve(mod.dir, mod.manifest.server);
    const rel = relative(mod.dir, entry);
    if (rel.startsWith('..')) {
      loadErrors.set(mod.id, 'its entry point points outside the package folder');
      app.log.error(`package ${mod.id}: entry escapes the module folder — refused`);
      continue;
    }
    if (!existsSync(entry)) {
      loadErrors.set(mod.id, `entry point ${mod.manifest.server} does not exist`);
      app.log.warn(`package ${mod.id}: on, but ${mod.manifest.server} is missing`);
      continue;
    }

    try {
      const loadedModule = (await import(pathToFileURL(entry).href)) as {
        routes?: (app: FastifyInstance) => Promise<void>;
      };
      if (typeof loadedModule.routes === 'function') await app.register(loadedModule.routes);
      loaded.add(mod.id);
      loadErrors.delete(mod.id);
      app.log.info(`package ${mod.id}: on`);
    } catch (error) {
      /*
       * Caught rather than thrown, and this is the opposite call from
       * `registerFeature` — which rethrows anything that is not a missing
       * module, because a broken feature is a bug in this repo and should stop
       * the app. A broken *module* is somebody else's bug, and taking the whole
       * app down over it would mean a bad third-party package could stop you
       * reaching the screen that uninstalls it.
       */
      const message = (error as Error).message;
      loadErrors.set(mod.id, message);
      app.log.error(`package ${mod.id}: failed to load — ${message}`);
    }
  }
}

const README = `# Packages

Drop a package in here — either a folder, or a \`.zip\` you downloaded and
unzipped. One folder per package, and the folder name must match the \`id\` in
its \`module.json\`.

    modules/
      weather/
        module.json
        server/index.js

The app also installs zips for you: **Settings → Packages → Add a package**, or
drag the zip onto that screen. That route checks the archive before writing
anything, which dropping a folder in here by hand does not.

## module.json

    {
      "id": "weather",
      "label": "Weather",
      "blurb": "Local forecast on the Dashboard.",
      "version": "1.0.0",
      "author": "you",
      "server": "server/index.js"
    }

\`id\`, \`label\`, \`blurb\` and \`version\` are required. \`server\` is optional
and names a file exporting \`routes(app)\`, which is given the Fastify instance.

Your code is loaded as an ES module. Installing through the app writes a
\`package.json\` with \`{"type":"module"}\` if your package has none, because
Node otherwise reads a \`.js\` file here as CommonJS and it fails on its first
\`export\`. Adding the folder **by hand** does not get that, so either include
that \`package.json\` yourself or name the entry \`.mjs\`, which is always a
module.

## What installing means

A package with a \`server\` entry is **ordinary code running inside the app**,
with the same access to your database and this machine as the app itself. There
is no sandbox. Install packages you would be willing to run as a program.

New packages are switched **off** until you turn them on, and switching one on
or off takes a restart — the same as the built-in features.
`;
