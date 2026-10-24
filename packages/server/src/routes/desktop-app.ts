/**
 * Blue Everything Desktop, downloaded from the app itself.
 *
 * The desktop client (`scripts/package-desktop.mjs`) is a zip beside each
 * release on GitHub. This serves the same zip from the server, so a friend on
 * another PC gets it from Settings → Devices rather than from a page they have
 * never heard of. Two places it can come from, in order:
 *
 *   1. **Built here**: `dist/release/BlueEverything-Desktop-<version>.zip`,
 *      which `npm run desktop-zip` writes. How a git clone has one before any
 *      release does.
 *   2. **The release on GitHub** for this version, fetched once and kept in the
 *      same place. Asked for only when somebody presses Download.
 *
 * Fetching is the server's own HTTP, not a shell, so it is the same in Docker.
 *
 * **The file goes out through a ticket.** A browser download is a navigation,
 * which sends no bearer token, and the API needs one. So a signed-in device
 * asks for a ticket (`POST /api/desktop-app/ticket`) and the browser then
 * downloads `/download/desktop-app?ticket=…`, outside `/api/` like the icons.
 * A ticket lasts two minutes. Nothing in the zip is private (it is the public
 * release), but an open route would hand 60MB to anything on the tailnet that
 * asked.
 */
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { repoRoot } from '../paths.js';
import { VERSION } from '../version.js';

const RELEASES = 'https://github.com/blue91321/Blue-Everything-App/releases';
const fileName = `BlueEverything-Desktop-${VERSION}.zip`;
const folder = resolve(repoRoot, 'dist', 'release');
const zipPath = resolve(folder, fileName);
const TICKET_MS = 2 * 60_000;

const tickets = new Map<string, number>();

function haveZip(): { bytes: number } | null {
  try {
    return existsSync(zipPath) ? { bytes: statSync(zipPath).size } : null;
  } catch {
    return null;
  }
}

/** This version's zip from its GitHub release, into `dist/release`. One at a time. */
let fetching: Promise<void> | null = null;
function fetchFromRelease(): Promise<void> {
  fetching ??= (async () => {
    const url = `${RELEASES}/download/v${VERSION}/${fileName}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
    if (response.status === 404) {
      throw new Error(`Version ${VERSION} has no desktop app on GitHub yet. It is added to each release from now on.`);
    }
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    // A zip starts PK; anything else is an error page, not something to hand out.
    if (body.length < 1024 || body[0] !== 0x50 || body[1] !== 0x4b) throw new Error('GitHub sent something that is not a zip');
    mkdirSync(folder, { recursive: true });
    await writeFile(`${zipPath}.part`, body);
    renameSync(`${zipPath}.part`, zipPath);
  })().finally(() => {
    fetching = null;
    rmSync(`${zipPath}.part`, { force: true });
  });
  return fetching;
}

export async function desktopAppRoutes(app: FastifyInstance): Promise<void> {
  /** Whether it can be downloaded from here now, and how big it is. */
  app.get('/api/desktop-app', async () => {
    const have = haveZip();
    return { version: VERSION, ready: have !== null, bytes: have?.bytes ?? null, releases: `${RELEASES}/latest` };
  });

  /** A short-lived link for the browser to download it with, fetching it first if need be. */
  app.post('/api/desktop-app/ticket', async (request, reply) => {
    if (request.deviceKind === 'instance') return reply.code(403).send({ error: 'not for a copy' });
    if (!haveZip()) {
      try {
        await fetchFromRelease();
      } catch (error) {
        return reply.code(502).send({ error: error instanceof Error ? error.message : 'could not get it', releases: `${RELEASES}/latest` });
      }
    }
    const now = Date.now();
    for (const [key, until] of tickets) if (until < now) tickets.delete(key);
    const ticket = randomBytes(18).toString('base64url');
    tickets.set(ticket, now + TICKET_MS);
    return { url: `/download/desktop-app?ticket=${ticket}`, bytes: haveZip()?.bytes ?? null };
  });

  app.get('/download/desktop-app', async (request, reply) => {
    const { ticket } = request.query as { ticket?: string };
    const until = ticket ? tickets.get(ticket) : undefined;
    if (!until || until < Date.now()) return reply.code(403).type('text/plain').send('This download link has expired. Press Download in the app again.');
    const have = haveZip();
    if (!have) return reply.code(404).type('text/plain').send('The desktop app is not here any more. Press Download in the app again.');
    return reply
      .header('content-type', 'application/zip')
      .header('content-length', String(have.bytes))
      .header('content-disposition', `attachment; filename="${fileName}"`)
      .send(createReadStream(zipPath));
  });
}
