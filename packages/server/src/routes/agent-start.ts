/**
 * Starting the Windows agent from inside the app.
 *
 * The Voice screen used to say *"Nothing is listening. Start it with Blue
 * Everything.cmd."* — which is accurate, and is exactly the friction the three
 * double-clickable files in the repo root exist to remove. An app that can tell
 * you a thing is not running can start it.
 *
 * ### Why this is not `/api/restart`
 *
 * Restarting stops the server too, and the server is demonstrably fine — you
 * are reading its response. Taking it down to fix the other half would drop
 * every open browser onto the offline screen to solve a problem none of them
 * had.
 *
 * ### Why it hands off to `start.ps1` rather than spawning node itself
 *
 * That script already knows the entry path, the working directory that lets
 * `--import tsx` resolve, and the log files — and its `-AgentOnly` switch exists
 * for precisely this case, because the ordinary path short-circuits on the
 * server's port already being open. A second recipe here would be a second
 * thing to keep true.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { repoRoot, startScript } from '../paths.js';

export async function agentStartRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Can this install start the agent?
   *
   * Asked separately from doing it, so the button can be absent with a reason
   * rather than failing when pressed — the same call `/api/restart` makes.
   */
  app.get('/api/agent/start', async (request) => ({
    available: request.isLocal && existsSync(startScript),
    local: request.isLocal,
    script: request.isLocal ? startScript : null,
  }));

  app.post('/api/agent/start', async (request, reply) => {
    if (!request.isLocal) {
      return reply.code(403).send({ error: 'the agent can only be started from the PC it runs on' });
    }
    if (!existsSync(startScript)) {
      return reply.code(500).send({ error: 'scripts/start.ps1 is missing — use Blue Everything.cmd instead' });
    }

    /*
     * `cmd /c start /b`, for the reason the tray menu, the restart button and
     * the game launcher all learned: `spawn('powershell.exe')` dies with its
     * parent, and `detached: true` on Windows means DETACHED_PROCESS, which
     * leaves powershell with no console host and it exits without running a
     * line. Only this form both runs and outlives us.
     *
     * This one does not strictly need to outlive us — the server is not being
     * stopped — but writing it the other way would be one more spawn recipe in
     * this repo that differs from the three that work.
     */
    mkdirSync(resolve(repoRoot, 'logs'), { recursive: true });
    const logFile = resolve(repoRoot, 'logs/agent-start.log');
    const quoted = (path: string) => path.replace(/'/g, "''");

    const child = spawn(
      'cmd.exe',
      [
        '/c', 'start', '/b', '',
        'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        `& '${quoted(startScript)}' -AgentOnly *>> '${quoted(logFile)}'`,
      ],
      { cwd: repoRoot, detached: true, stdio: 'ignore' }
    );
    child.on('error', (error) => app.log.error(error, 'starting the agent failed to launch'));
    child.unref();

    app.log.info('agent start requested from the app');

    /*
     * Answered now rather than waiting. The agent takes a few seconds to load
     * and its first heartbeat is what actually proves it is up — which the
     * screen is already polling for, so waiting here would only delay the reply
     * that lets it start looking.
     */
    return { ok: true, starting: true };
  });
}
