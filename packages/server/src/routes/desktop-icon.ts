/**
 * Putting the app's icon on the Desktop, from inside the app.
 *
 * `Create Desktop Icon.cmd` has always done this, and having that as the *only*
 * way meant the answer to "how do I open this thing tomorrow" was "go back to
 * the folder you unzipped and double-click a different file" — which is exactly
 * the friction the three double-clickable files exist to remove, arriving one
 * level up. Somebody setting this up for the first time is in the app already:
 * that is where the button belongs.
 *
 * ### It waits, unlike Restart and Update
 *
 * Those two answer before they act, because the process they are reporting on
 * is about to be killed and a connection dying mid-reply reads as a button that
 * did not work. Nothing here stops anything. The script takes a second or two,
 * finishes, and has something worth saying — so this waits for it and reports
 * what happened.
 *
 * That matters more than it sounds, because **where the Desktop actually is
 * cannot be assumed**. OneDrive redirects it, and `%USERPROFILE%\\Desktop` is
 * then not the folder you are looking at. The script asks Windows through
 * `GetFolderPath`, which gets it right, and prints the paths it wrote — so the
 * screen can name them rather than saying "done" about a file the person then
 * cannot find.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { repoRoot, shortcutScript } from '../paths.js';

const run = promisify(execFile);

/**
 * Generous, and for one reason: the script builds `assets/everything.ico` first
 * if it is missing, which shells out to the icon generator. That is a one-time
 * cost on a fresh checkout and it is slower than everything else here put
 * together.
 */
const TIMEOUT_MS = 180_000;

export async function desktopIconRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Can this install make one?
   *
   * Asked separately so the button can be *absent*, with the reason on screen,
   * rather than failing when pressed — the same call "Check for updates" and
   * Restart both make. From the phone it genuinely cannot: the Desktop in
   * question is the PC's.
   */
  app.get('/api/desktop-icon', async (request) => ({
    available: request.isLocal && existsSync(shortcutScript),
    local: request.isLocal,
    /** Named, so the screen can say what to run by hand if the script is gone. */
    script: request.isLocal ? shortcutScript : null,
  }));

  app.post('/api/desktop-icon', async (request, reply) => {
    if (!request.isLocal) {
      return reply
        .code(403)
        .send({ error: 'a shortcut can only be made on the PC running the app' });
    }
    if (!existsSync(shortcutScript)) {
      return reply
        .code(500)
        .send({ error: 'scripts/create-shortcut.ps1 is missing — use "Create Desktop Icon.cmd" instead' });
    }

    try {
      /*
       * Waited on, so no `cmd /c start` dance: that form exists for children
       * which must outlive the process launching them, and this one must not —
       * the whole point is to report what it did.
       */
      const { stdout, stderr } = await run(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', shortcutScript],
        { cwd: repoRoot, timeout: TIMEOUT_MS, windowsHide: true }
      );

      /*
       * The script prints one "Created <path>" per shortcut. Reading them back
       * is what lets the screen say where the icon went — which is the question
       * somebody with a OneDrive-redirected Desktop is about to ask.
       */
      const created = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('Created '))
        .map((line) => line.slice('Created '.length));

      if (stderr.trim()) app.log.warn({ stderr: stderr.trim() }, 'desktop icon script wrote to stderr');
      app.log.info({ created }, 'desktop shortcut created from the app');

      return { ok: true, created };
    } catch (cause) {
      /*
       * Reported rather than swallowed. A shortcut that silently fails to
       * appear is indistinguishable from a button that never fired, which is
       * the failure the tray menu shipped with and this project has written
       * down twice already.
       */
      const message = cause instanceof Error ? cause.message : String(cause);
      app.log.error({ err: cause }, 'desktop shortcut failed');
      return reply.code(500).send({ error: message });
    }
  });
}
