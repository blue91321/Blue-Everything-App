/**
 * Checking for a newer release, and installing it, from inside the app.
 *
 * The check asks GitHub's "latest release" for the repository (`UPDATE_URL`),
 * and only when the button is pressed — nothing here runs on a timer, so a PC
 * left alone never asks. The answer is compared with the version this server
 * is running.
 *
 * Installing hands off to `scripts/update.ps1`, the same script behind
 * `Update Blue Everything.cmd`, which backs your data up, stops the app,
 * updates it and starts it again. Launched exactly as the Restart button
 * launches `restart.ps1` — see `restart.ts` for why `cmd /c start /b` is the
 * only form that both runs and outlives this process — and for the same
 * reason answers before doing anything: this server is one of the things being
 * stopped.
 *
 * Registered in core beside Restart, before any package loads, so a package
 * that broke something cannot also take away the way to update past it.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { repoRoot, updateScript } from '../paths.js';
import { VERSION } from '../version.js';

type Release = { tag_name?: string; name?: string; body?: string; html_url?: string; published_at?: string };

/** `0.4.10` is newer than `0.4.9`, which comparing strings gets wrong. */
export function isNewer(latest: string, current: string): boolean {
  const parts = (v: string) => v.replace(/^v/, '').split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(latest);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

export async function updateRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/updates/check', { config: { announce: false } }, async (request, reply) => {
    const url = config.UPDATE_URL.trim();
    if (!url) return reply.code(400).send({ error: 'no update source is set up' });

    let release: Release;
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'blue-everything' },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 404) {
        return { current: VERSION, latest: null, newer: false, note: 'no release has been published yet' };
      }
      if (!response.ok) return reply.code(502).send({ error: `the update source answered ${response.status}` });
      release = (await response.json()) as Release;
    } catch {
      return reply.code(502).send({ error: 'could not reach the update source' });
    }

    const latest = (release.tag_name ?? '').replace(/^v/, '') || null;
    return {
      current: VERSION,
      latest,
      newer: latest !== null && isNewer(latest, VERSION),
      name: release.name ?? null,
      // The changelog section, trimmed: this is a card, not the release page.
      notes: (release.body ?? '').slice(0, 1500) || null,
      url: release.html_url ?? null,
      publishedAt: release.published_at ?? null,
      /** Whether this machine can install it from here. */
      canApply: request.isLocal && existsSync(updateScript),
      kind: existsSync(resolve(repoRoot, '.git')) ? 'git' : 'release',
    };
  });

  /**
   * The app's own logs, by name: the end of one in the app, or the whole of it
   * in Notepad on the PC. So a message naming a log can be a button rather than
   * a path to go and find. Only a bare `name.log` inside `logs/` — the name is
   * checked against a pattern, never joined as given.
   */
  const logFile = (name: string) => (/^[a-z][a-z-]*\.log$/.test(name) ? resolve(repoRoot, 'logs', name) : null);

  app.get('/api/logs/:name', async (request, reply) => {
    const file = logFile((request.params as { name: string }).name);
    if (!file) return reply.code(400).send({ error: 'not a log' });
    if (!existsSync(file)) return { lines: [] };
    return { lines: readFileSync(file, 'utf8').split(/\r?\n/).slice(-80) };
  });

  app.post('/api/logs/:name/open', { config: { announce: false } }, async (request, reply) => {
    if (!request.isLocal) return reply.code(403).send({ error: 'logs open on the PC running the app' });
    const file = logFile((request.params as { name: string }).name);
    if (!file) return reply.code(400).send({ error: 'not a log' });
    if (!existsSync(file)) return reply.code(404).send({ error: 'that log has not been written yet' });
    spawn('notepad.exe', [file], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  });

  app.post('/api/updates/apply', { config: { announce: false } }, async (request, reply) => {
    if (!request.isLocal) {
      return reply.code(403).send({ error: 'the app can only be updated from the PC running it' });
    }
    if (!existsSync(updateScript)) {
      return reply.code(500).send({ error: 'scripts/update.ps1 is missing — download the new release by hand' });
    }
    mkdirSync(resolve(repoRoot, 'logs'), { recursive: true });
    const logFile = resolve(repoRoot, 'logs/update.log');
    const child = spawn(
      'cmd.exe',
      [
        '/c',
        'start',
        '/b',
        '',
        'powershell.exe',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `& '${updateScript.replace(/'/g, "''")}' *>> '${logFile.replace(/'/g, "''")}'`,
      ],
      { cwd: repoRoot, detached: true, stdio: 'ignore', windowsVerbatimArguments: false }
    );
    child.on('error', (error) => app.log.error(error, 'update failed to launch'));
    child.unref();
    app.log.info('update requested from the app');
    return { ok: true, updating: true, log: logFile };
  });
}
