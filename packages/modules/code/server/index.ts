/**
 * The Code screen's API: the app's own files, to read from any of your
 * devices and to change from the PC running it.
 *
 * ### Reading is yours; writing is this PC's
 *
 * Reading is open to every device paired to the host, the same set the People
 * routes call yours. The files are the public repository's, so nothing here is
 * secret, and `files.ts` lists only what the repository ships.
 *
 * **Saving is local-only**, the rule installing a package follows and for the
 * same reason. A saved file is code this PC runs the next time it restarts, so
 * a device token that can save is a device token that can run anything here.
 * A phone's token is a bearer string on a phone; it may read the code, and may
 * not become a way to run it.
 *
 * **Not on a friend's copy at all.** A copy runs this checkout's code, so
 * changing it would change the host's app; `hostOnly` in the manifest keeps
 * the package from loading on a copy, and the check below is the second line.
 *
 * ### What a save does not do
 *
 * It does not restart anything. Nothing here runs until the app starts again:
 * `start.ps1` rebuilds the screens when their source is newer than the build,
 * and the server and the agent read their source when they start. So the
 * screen says which files are newer than the running app (`startedAt`) and
 * offers core's own Restart.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { isGuest, repoRoot, routePath } from '@everything/server/module-api';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { CodeError, committedText, knownPath, listing, openFile, partsOf, saveFile, syntaxProblem } from './files.js';

/** When this server started, which is when it last read its own source. */
const startedAt = Date.now();

interface Asker {
  isLocal: boolean;
  deviceId: string | null;
  deviceKind: string | null;
}

/** The host's own devices; a copy's key never. See `isOwner` in `instances.ts`. */
const yours = (request: Asker) => !isGuest && (request.isLocal || (request.deviceId !== null && request.deviceKind !== 'instance'));

const failed = (reply: FastifyReply, error: unknown) =>
  error instanceof CodeError
    ? reply.code(error.status).send({ error: error.message })
    : reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });

export async function routes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request, reply) => {
    // The matched route, not the URL as sent: see `routePath`.
    if (!routePath(request).startsWith('/api/code')) return;
    if (!yours(request as unknown as Asker)) {
      return reply.code(403).send({ error: isGuest ? 'the code is the host’s to look at' : 'only your own devices can see the code' });
    }
  });

  app.get('/api/code', async (request) => {
    const list = await listing(repoRoot);
    const files = list.files.map((path) => {
      let size = 0;
      let modified = 0;
      try {
        const stat = statSync(resolve(repoRoot, path));
        size = stat.size;
        modified = stat.mtimeMs;
      } catch {
        // removed between the listing and now; drawn as it was
      }
      return { path, size, modified, changed: list.changed.get(path) ?? null };
    });
    return {
      source: list.source,
      canSave: (request as unknown as Asker).isLocal,
      startedAt,
      files,
      parts: partsOf(repoRoot, list.files),
    };
  });

  app.get('/api/code/file', async (request, reply) => {
    try {
      const path = await knownPath(repoRoot, (request.query as { path?: unknown }).path);
      return openFile(repoRoot, path);
    } catch (error) {
      return failed(reply, error);
    }
  });

  /** What it was at the last commit, for "what did I change" and putting it back. */
  app.get('/api/code/committed', async (request, reply) => {
    try {
      const path = await knownPath(repoRoot, (request.query as { path?: unknown }).path);
      return { text: await committedText(repoRoot, path) };
    } catch (error) {
      return failed(reply, error);
    }
  });

  /**
   * Save. Two outcomes are replies rather than errors, because the screen has
   * to act on them and `apiRequest` keeps only an error's message: the file
   * changed since it was opened (`conflict`), and it no longer parses
   * (`problem`, saved anyway only when `force` says so).
   */
  app.put('/api/code/file', { bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
    if (!(request as unknown as Asker).isLocal) {
      return reply.code(403).send({ error: 'the code can only be changed from the PC running the app' });
    }
    const body = (request.body ?? {}) as { path?: unknown; text?: unknown; version?: unknown; force?: unknown };
    try {
      const path = await knownPath(repoRoot, body.path);
      if (typeof body.text !== 'string' || typeof body.version !== 'string') throw new CodeError('a save needs the text and the version it was opened at');
      const opened = openFile(repoRoot, path);
      if (opened.readOnly) throw new CodeError(opened.why ?? opened.readOnly, 403);
      if (body.force !== true) {
        const problem = await syntaxProblem(path, body.text);
        if (problem) return { saved: false, problem };
      }
      return await saveFile(repoRoot, path, body.text, body.version);
    } catch (error) {
      return failed(reply, error);
    }
  });
}
