/**
 * Installing, listing, switching and removing packages.
 *
 * The manifest and the disk work live in `../modules.js`; this is the HTTP
 * skin, and it exists for the same reason `routes/features.ts` does — the PWA
 * cannot import `@everything/shared`, so the facts are handed over as plain
 * JSON.
 *
 * ### Everything that changes anything is local-only
 *
 * Installing a package runs code on the machine the server is on, and removing
 * one deletes a folder from it. That is squarely in the same family as minting
 * a device token, writing `features.json` and setting the app logo: a decision
 * about *this install*, not about your data, and therefore not something the
 * phone on the tailnet gets to make. Reading the list is not restricted —
 * seeing what is installed from the sofa costs nothing.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  ensureModulesDir,
  installFromZip,
  modulesDir,
  openModulesFolder,
  removeModule,
  scanModules,
  setModuleEnabled,
} from '../modules.js';
import { ZipError } from '../zip.js';
import { isModuleId } from '@everything/shared/modules';

/**
 * The largest package this will accept through the browser, and the body limit
 * that enforces it.
 *
 * Set on this route rather than on the whole server. Fastify defaults to 1MB
 * globally, and raising *that* to accept a package would widen the amount of
 * memory any unauthenticated-shaped request can ask the process to buffer, for
 * the sake of one endpoint that is already local-only.
 *
 * Base64 costs a third on top, and the JSON wrapper a little more, so the body
 * allowance is the zip allowance plus half.
 */
const MAX_ZIP_BYTES = 16 * 1024 * 1024;
const MAX_BODY_BYTES = Math.ceil(MAX_ZIP_BYTES * 1.5);

export async function moduleRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/modules', async (request) => {
    const installed = scanModules();

    return {
      /*
       * The folder is only named to a local caller. From the phone it is a path
       * on a machine you are not sitting at, and printing it invites trying to
       * open something that is not there — while a "show me the folder" button
       * that silently does nothing is worse still. The PWA hides both when this
       * is null.
       */
      folder: request.isLocal ? modulesDir : null,
      canInstall: request.isLocal,
      modules: installed.map((mod) => ({
        id: mod.id,
        label: mod.manifest?.label ?? mod.id,
        blurb: mod.manifest?.blurb ?? null,
        version: mod.manifest?.version ?? null,
        author: mod.manifest?.author ?? null,
        notes: mod.manifest?.notes ?? null,
        /** True when it has a server half — i.e. when it runs code. */
        code: Boolean(mod.manifest?.server),
        bytes: mod.bytes,
        enabled: mod.enabled,
        running: mod.running,
        /** Saved but not live yet, exactly as a feature reports it. */
        pendingRestart: mod.enabled !== mod.running,
        problems: mod.problems,
        usable: mod.manifest !== null,
      })),
    };
  });

  /**
   * Install from a zip.
   *
   * Base64 in a JSON body, following the habit picture and the app logo rather
   * than adding a binary content-type parser for one route. The bytes are
   * validated as an archive before a single file is written — see
   * `installFromZip` for why writing first would be worse than useless.
   */
  app.post(
    '/api/modules',
    { bodyLimit: MAX_BODY_BYTES },
    async (request, reply) => {
      if (!request.isLocal) {
        return reply
          .code(403)
          .send({ error: 'packages can only be installed from the PC running the server' });
      }

      const body = z
        .object({
          /** Bare base64, no `data:` prefix — the client strips it. */
          data: z.string().min(1),
          /** Only for the message; nothing is keyed on it. */
          filename: z.string().max(260).optional(),
        })
        .parse(request.body);

      const bytes = Buffer.from(body.data, 'base64');
      if (bytes.length === 0) return reply.code(400).send({ error: 'that file was empty' });
      if (bytes.length > MAX_ZIP_BYTES) {
        return reply
          .code(413)
          .send({ error: `that package is larger than the ${Math.round(MAX_ZIP_BYTES / 1024 / 1024)}MB limit` });
      }

      try {
        const result = installFromZip(bytes);
        return { ok: true, ...result };
      } catch (error) {
        /*
         * A ZipError is a statement about the file somebody just chose, so it
         * is worth repeating verbatim — "no module.json at the root of the
         * archive" is the difference between fixing it and guessing. Anything
         * else is a bug here and gets the generic treatment.
         */
        if (error instanceof ZipError) return reply.code(400).send({ error: error.message });
        request.log.error(error, 'package install failed');
        return reply.code(500).send({ error: 'the package could not be installed' });
      }
    }
  );

  /** Switch one on or off. Takes a restart, like a feature. */
  app.patch('/api/modules/:id', async (request, reply) => {
    if (!request.isLocal) {
      return reply.code(403).send({ error: 'packages can only be changed from the PC running the server' });
    }

    const { id } = request.params as { id: string };
    if (!isModuleId(id)) return reply.code(400).send({ error: `no such package: ${id}` });

    const body = z.object({ enabled: z.boolean() }).parse(request.body);
    const found = scanModules().find((mod) => mod.id === id);
    if (!found) return reply.code(404).send({ error: `no such package: ${id}` });

    /*
     * Refused rather than allowed-and-ignored. A package whose manifest does
     * not parse cannot be loaded, so a toggle reading "on" against it would be
     * a switch that says it did something and did not — the same failure the
     * `EVERYTHING_FEATURES` lock is disabled to avoid.
     */
    if (body.enabled && found.manifest === null) {
      return reply.code(409).send({ error: 'that package has a problem that has to be fixed before it can run' });
    }

    setModuleEnabled(id, body.enabled);
    return { ok: true, id, enabled: body.enabled, pendingRestart: body.enabled !== found.running };
  });

  /** Delete it from disk. The only irreversible thing on the screen. */
  app.delete('/api/modules/:id', async (request, reply) => {
    if (!request.isLocal) {
      return reply.code(403).send({ error: 'packages can only be removed from the PC running the server' });
    }

    const { id } = request.params as { id: string };
    if (!isModuleId(id)) return reply.code(400).send({ error: `no such package: ${id}` });

    try {
      removeModule(id);
      return { ok: true, id };
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  /**
   * Open the folder in the file manager.
   *
   * A POST rather than a GET because it does something, and local-only because
   * a file manager can only usefully open on the machine it is running on.
   */
  app.post('/api/modules/folder', async (request, reply) => {
    if (!request.isLocal) {
      return reply.code(403).send({ error: 'the packages folder can only be opened on the PC running the server' });
    }
    ensureModulesDir();
    openModulesFolder();
    return { ok: true, folder: modulesDir };
  });
}
