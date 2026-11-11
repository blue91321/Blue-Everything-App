/**
 * Switching between Everything and Just Manga from inside the app
 * (Settings → Packages), both ways (2026-11-03).
 *
 * The two are the release's two downloads (`package-release.mjs --config`):
 * Just Manga is the reader on its own, every package but manga and push left
 * out. What switching means depends on what this install is:
 *
 * - **A release install** switches by downloading the other one:
 *   `update.ps1 -Configuration`, which backs up your data, installs the
 *   newest release of that kind over this one (removing what it does not
 *   ship) and starts the app again. Launched exactly as Update now is, since
 *   it stops this server.
 * - **A git clone** has every package in the checkout and no download to
 *   swap, and deleting folders from a checkout is git's business, not this
 *   screen's. So it switches the other packages *off*, the level that keeps
 *   the folder, records which were on so switching back turns exactly those
 *   on again, writes `configuration.json`, and restarts.
 *
 * Local-only, like every change to what this install runs, and never on a
 * friend's copy, which runs this checkout and is not its to change.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { isGuest } from '../config.js';
import { scanModules, setModuleEnabled } from '../modules.js';
import { configuration, dataDir, repoRoot, restartScript, updateScript } from '../paths.js';

/**
 * What Just Manga keeps. The same list as `JUST_MANGA_KEEPS` in
 * `scripts/package-release.mjs`, which runs under plain node and cannot import
 * this; `modules-check` holds the two to each other.
 */
export const JUST_MANGA_PACKAGES = ['manga', 'push'] as const;

type Configuration = 'everything' | 'just-manga';

const configFile = resolve(repoRoot, 'configuration.json');
/** On a clone: the packages that were on when it switched to Just Manga. */
const beforeFile = () => resolve(dataDir, 'configuration-before.json');
const isGit = () => existsSync(resolve(repoRoot, '.git'));

/** Run a script so it outlives this server, as Restart and Update do: see `restart.ts` for why this form. */
function launch(script: string, args: string[], log: string): void {
  mkdirSync(resolve(repoRoot, 'logs'), { recursive: true });
  const logFile = resolve(repoRoot, 'logs', log);
  const quoted = [script, ...args].map((a, i) => (i === 0 || /\s|'/.test(a) ? `'${a.replace(/'/g, "''")}'` : a));
  const child = spawn(
    'cmd.exe',
    ['/c', 'start', '/b', '', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `& ${quoted.join(' ')} *>> '${logFile.replace(/'/g, "''")}'`],
    { cwd: repoRoot, detached: true, stdio: 'ignore' }
  );
  child.unref();
}

/** The shipped packages Just Manga leaves out, as this checkout has them. */
function leftOut() {
  return scanModules().filter((m) => m.shipped && !(JUST_MANGA_PACKAGES as readonly string[]).includes(m.id));
}

export async function configurationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/configuration', async (request) => {
    const kind = isGit() ? 'git' : 'release';
    const script = kind === 'git' ? restartScript : updateScript;
    return {
      configuration,
      kind,
      /** Whether this device can switch it from here, and why not when not. */
      canSwitch: !isGuest && request.isLocal && existsSync(script),
      why: isGuest
        ? 'a copy for a friend runs the host’s install and cannot change it'
        : !request.isLocal
          ? 'switched from the PC running the app'
          : !existsSync(script)
            ? `scripts/${kind === 'git' ? 'restart' : 'update'}.ps1 is missing`
            : null,
      /** What Just Manga switches off on a clone, by name, so the screen can say. */
      leftOut: leftOut().map((m) => m.manifest?.label ?? m.id),
    };
  });

  app.post('/api/configuration', { config: { announce: false } }, async (request, reply) => {
    if (isGuest) return reply.code(403).send({ error: 'a copy for a friend cannot change the host’s install' });
    if (!request.isLocal) return reply.code(403).send({ error: 'switched from the PC running the app' });
    const body = (request.body ?? {}) as { to?: unknown; confirmed?: unknown };
    const to = body.to;
    if (to !== 'everything' && to !== 'just-manga') return reply.code(400).send({ error: 'to is everything or just-manga' });
    // The name typed on the screen, as the last of its three confirmations: a
    // request without it, from an older screen or anywhere else, switches nothing.
    const phrase = to === 'everything' ? 'EVERYTHING' : 'JUST MANGA';
    if (body.confirmed !== phrase) return reply.code(400).send({ error: `type ${phrase} to confirm the switch` });
    if (to === configuration) return reply.code(400).send({ error: `this install is already ${to === 'everything' ? 'Everything' : 'Just Manga'}` });

    if (!isGit()) {
      if (!existsSync(updateScript)) return reply.code(500).send({ error: 'scripts/update.ps1 is missing' });
      launch(updateScript, ['-Configuration', to], 'update.log');
      app.log.info(`switching to ${to} from the app`);
      return { ok: true, how: 'download', log: 'update.log' };
    }

    if (!existsSync(restartScript)) return reply.code(500).send({ error: 'scripts/restart.ps1 is missing' });
    if (to === 'just-manga') {
      const others = leftOut();
      writeFileSync(beforeFile(), JSON.stringify({ on: others.filter((m) => m.enabled).map((m) => m.id) }, null, 2) + '\n');
      for (const m of others) setModuleEnabled(m.id, false);
      for (const id of JUST_MANGA_PACKAGES) setModuleEnabled(id, true);
      writeFileSync(configFile, JSON.stringify({ configuration: 'just-manga' }, null, 2) + '\n');
    } else {
      let on: string[] | null = null;
      try {
        const raw = JSON.parse(readFileSync(beforeFile(), 'utf8')) as { on?: unknown };
        if (Array.isArray(raw.on)) on = raw.on.filter((x): x is string => typeof x === 'string');
      } catch {
        // Switched by hand, or the record is gone: what ships turned on is on.
      }
      for (const m of leftOut()) {
        setModuleEnabled(m.id, on ? on.includes(m.id) : m.manifest?.startsOff !== true);
      }
      rmSync(configFile, { force: true });
      rmSync(beforeFile(), { force: true });
    }
    launch(restartScript, [], 'restart.log');
    app.log.info(`switched to ${to} from the app; restarting`);
    return { ok: true, how: 'restart' };
  });
}
