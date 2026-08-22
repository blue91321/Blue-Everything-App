/**
 * Restarting the app from inside the app.
 *
 * Switching a package on or off, installing one, deleting one — all of them are
 * resolved once at boot, so all of them owe a restart. Until now the only way to
 * take one was the tray icon, which means the answer to "I just deleted
 * something, now what" was "go and find an icon under the `^` arrow".
 *
 * ### This is meant to work when nothing else does
 *
 * The whole point of the button is the case where a package has broken
 * something: the screen it lives on may be the only working part of the app.
 * So this route is deliberately the least clever thing here —
 *
 *   - **registered in core, before any package loads**, so a package that
 *     throws on import cannot take it down with it;
 *   - it reads no database, no settings and no manifest, so nothing it depends
 *     on can be the thing that is broken;
 *   - it answers *before* the restart happens rather than trying to report the
 *     outcome, because the process it is reporting on is about to be killed.
 *
 * It hands off to `scripts/restart.ps1`, which already exists for the tray and
 * already handles the part that matters: the sequencing has to outlive the
 * process that asked for it, since stopping the server means stopping whoever
 * is running this line.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { repoRoot, restartScript } from '../paths.js';

export async function restartRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Can this install restart itself, and does it owe one?
   *
   * Answered separately from doing it so the button can be *absent* rather than
   * failing when pressed — the same reasoning that disables "Check for updates"
   * with a reason instead of offering one that cannot work.
   */
  app.get('/api/restart', async (request) => ({
    available: request.isLocal && existsSync(restartScript),
    local: request.isLocal,
    /** Named so the screen can tell you what to run if the script is missing. */
    script: request.isLocal ? restartScript : null,
  }));

  app.post('/api/restart', async (request, reply) => {
    if (!request.isLocal) {
      return reply.code(403).send({ error: 'the app can only be restarted from the PC running it' });
    }
    if (!existsSync(restartScript)) {
      return reply.code(500).send({ error: 'scripts/restart.ps1 is missing — use the tray icon instead' });
    }

    /*
     * `cmd /c start /b`, and that form is not optional — it is the one arrangement
     * that satisfies both requirements here, measured when the tray menu shipped
     * doing nothing at all:
     *
     *   spawn('powershell.exe')                  runs, dies with its parent
     *   ...plus detached: true                   never runs at all
     *   cmd /c start /b "" powershell.exe ...    runs, and outlives us
     *
     * The child *must* outlive its parent, because restarting stops this very
     * process. But `detached: true` on Windows means DETACHED_PROCESS, and
     * powershell needs a console host — with none it exits instantly without
     * running a line. `start` has the command processor create the process and
     * cmd then exits, so what runs belongs to nobody and has a console of its own.
     */
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
        '-File',
        restartScript,
      ],
      { cwd: repoRoot, detached: true, stdio: 'ignore', windowsVerbatimArguments: false }
    );
    child.on('error', (error) => app.log.error(error, 'restart failed to launch'));
    child.unref();

    app.log.info('restart requested from the app');

    /*
     * Answered immediately. The restart takes a few seconds and this process is
     * one of the things being stopped, so waiting to confirm would mean the
     * connection dying mid-reply — which the browser reports as a failed request
     * and reads as the button not having worked.
     */
    return { ok: true, restarting: true };
  });
}
