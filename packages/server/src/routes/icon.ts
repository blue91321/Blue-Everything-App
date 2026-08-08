/**
 * The app mark, as the outside world sees it.
 *
 * Everything here is **unauthenticated**, and deliberately so: the manifest and
 * the icons are fetched by the browser itself — by the iOS home-screen
 * installer, by the Windows taskbar, by the tab strip — none of which will ever
 * send our bearer token. That is the same reasoning that already keeps the PWA
 * shell open: these carry no data beyond a colour and a shape.
 *
 * They live outside `/api/` because that prefix is exactly what `auth.ts` uses
 * to decide what is protected. Putting them under it would have made the app
 * un-installable on the phone in a way that only shows up on the phone.
 *
 * The *writes* — uploading a picture — are under `/api/` and local-only, like
 * every other write that reaches this machine rather than the database.
 */
import { readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_ACCENT,
  DEFAULT_LOGO_SHAPE,
  type AccentColor,
  type LogoShape,
} from '@everything/shared';
import { db } from '../db/client.js';
import { settings } from '../db/schema.js';
import { getSettings } from '../nudge-engine.js';
import { changes } from '../events.js';
import { drawIcon } from '../icon.js';

/** The sizes anything actually asks for. Anything else is refused. */
const ALLOWED_SIZES = [16, 32, 48, 64, 128, 180, 192, 256, 512];

const LOGO_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const CONTENT_TYPE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/**
 * Beside the database, not in it. Resolved from this file rather than the
 * working directory — Task Scheduler starts the server in System32, where a
 * relative path would quietly write the logo somewhere nobody would look.
 */
const logoPath = (extension: string): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), '../../data', `logo.${extension}`);

/** Whether a picture has been uploaded. Exported for the settings guard. */
export function hasStoredLogo(): boolean {
  return storedLogo() !== null;
}

function storedLogo(): { path: string; extension: string } | null {
  for (const extension of Object.values(LOGO_TYPES)) {
    const path = logoPath(extension);
    if (existsSync(path)) return { path, extension };
  }
  return null;
}

/**
 * A small in-process cache.
 *
 * Rasterising 512px is a few milliseconds, but a cold PWA load asks for several
 * sizes at once and the browser re-asks on every hard refresh. Keyed on the
 * settings that affect the output, so changing either one is a miss rather than
 * something needing manual invalidation.
 */
const cache = new Map<string, Buffer>();

export async function iconRoutes(app: FastifyInstance): Promise<void> {
  /**
   * `/icon/192.png`, and the rest.
   *
   * A `?v=` query is ignored here on purpose — it exists only to change the URL
   * so caches let go. The answer depends on the settings, never on the query.
   */
  app.get('/icon/:size.png', async (request, reply) => {
    const { size: raw } = request.params as { size: string };
    const size = Number(raw);
    if (!ALLOWED_SIZES.includes(size)) {
      return reply.code(404).send({ error: `no icon at ${raw}px` });
    }

    const row = await getSettings();
    const shape = (row.logoShape ?? DEFAULT_LOGO_SHAPE) as LogoShape;
    const accent = (row.accentColor ?? DEFAULT_ACCENT) as AccentColor;

    /*
     * An uploaded picture is served as-is rather than rescaled.
     *
     * Rescaling would mean decoding JPEG and WebP, which is the image library
     * this whole file exists to avoid. Browsers scale images perfectly well,
     * and the icon is being handed to something that was going to scale it
     * anyway.
     */
    if (shape === 'image') {
      const stored = storedLogo();
      if (stored) {
        const bytes = await readFile(stored.path);
        return reply
          .header('content-type', CONTENT_TYPE[stored.extension])
          .header('cache-control', 'public, max-age=31536000, immutable')
          .send(bytes);
      }
      // Set to `image` with the file since deleted. Falling through to the
      // default mark beats a broken-image icon on the home screen.
    }

    const drawable = (shape === 'image' ? DEFAULT_LOGO_SHAPE : shape) as Exclude<LogoShape, 'image'>;
    const fullBleed = (request.query as { bleed?: string }).bleed === '1';
    const key = `${size}:${drawable}:${accent}:${fullBleed}`;

    let png = cache.get(key);
    if (!png) {
      png = drawIcon(size, { shape: drawable, accent, fullBleed });
      cache.set(key, png);
    }

    return reply
      .header('content-type', 'image/png')
      // Immutable is safe because the URL carries `?v=` whenever the answer
      // could have changed; without the version the browser would be right to
      // keep the old one forever.
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(png);
  });

  /**
   * The web app manifest, generated rather than static.
   *
   * It has to be generated because the icon URLs carry the version — a manifest
   * pointing at a fixed `/icon-192.png` would leave every installed copy
   * showing the mark that was current when it was installed.
   */
  app.get('/manifest.webmanifest', async (_request, reply) => {
    const row = await getSettings();
    const version = `${row.accentColor}-${row.logoShape}-${row.logoVersion}`;
    const icon = (size: number, extra = '') => `/icon/${size}.png?v=${version}${extra}`;

    return reply.header('content-type', 'application/manifest+json').send({
      name: 'Blue Everything',
      short_name: 'Blue Everything',
      description: 'Tasks, habits and nudges that wait for a good moment.',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#14161c',
      theme_color: '#14161c',
      orientation: 'portrait',
      icons: [
        { src: icon(192), sizes: '192x192', type: 'image/png' },
        { src: icon(512), sizes: '512x512', type: 'image/png' },
        // Android crops maskable icons to whatever shape the launcher uses, so
        // this one is drawn square to the edges rather than pre-rounded.
        { src: icon(512, '&bleed=1'), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    });
  });

  /**
   * What the app needs to draw the mark itself, without a token.
   *
   * The Settings screen and the drawer both want to know the current shape
   * before the settings call returns, and this is cheap enough to be answered
   * from the shell.
   */
  app.get('/icon/info', async () => {
    const row = await getSettings();
    return {
      shape: row.logoShape ?? DEFAULT_LOGO_SHAPE,
      accent: row.accentColor ?? DEFAULT_ACCENT,
      version: row.logoVersion ?? 0,
      hasImage: storedLogo() !== null,
    };
  });

  /** Upload a picture to use as the mark. */
  app.put('/api/logo', async (request, reply) => {
    if (!request.isLocal) {
      return reply.code(403).send({ error: 'the logo can only be set from the PC running the server' });
    }

    const body = z
      .object({
        /** Bare base64, no data: prefix — the client strips it. */
        data: z.string().min(1).max(4 * 1024 * 1024),
        type: z.string().max(100),
      })
      .parse(request.body);

    const extension = LOGO_TYPES[body.type];
    if (!extension) return reply.code(400).send({ error: 'needs to be a PNG, JPEG, GIF or WebP' });

    const bytes = Buffer.from(body.data, 'base64');
    if (bytes.length === 0) return reply.code(400).send({ error: 'that file was empty' });

    // One logo at a time: the old one goes, so switching PNG to JPEG does not
    // leave the previous file behind to be picked up by `storedLogo` later.
    for (const old of Object.values(LOGO_TYPES)) {
      await rm(logoPath(old), { force: true }).catch(() => {});
    }
    await writeFile(logoPath(extension), bytes);

    const current = await getSettings();
    await db
      .update(settings)
      .set({ logoShape: 'image', logoVersion: (current.logoVersion ?? 0) + 1 })
      .where(eq(settings.id, current.id));

    cache.clear();
    changes.emitChange('settings');
    return { ok: true, bytes: bytes.length, shape: 'image' };
  });

  /** Remove it, falling back to the pause glyph. */
  app.delete('/api/logo', async (request, reply) => {
    if (!request.isLocal) {
      return reply.code(403).send({ error: 'the logo can only be changed from the PC running the server' });
    }

    for (const old of Object.values(LOGO_TYPES)) {
      await rm(logoPath(old), { force: true }).catch(() => {});
    }

    const current = await getSettings();
    await db
      .update(settings)
      .set({
        // Only reset the shape if it was pointing at the file — somebody who
        // uploaded a picture, then switched to a triangle, then deleted the
        // picture should still have a triangle.
        ...(current.logoShape === 'image' ? { logoShape: DEFAULT_LOGO_SHAPE } : {}),
        logoVersion: (current.logoVersion ?? 0) + 1,
      })
      .where(eq(settings.id, current.id));

    cache.clear();
    changes.emitChange('settings');
    return { ok: true };
  });

}

/**
 * Dropped whenever the accent or the shape changes.
 *
 * Called by the settings route rather than watched for here: the cache is keyed
 * on the settings, so a stale entry is only reachable if something wrote them,
 * and the writer is the one place that knows it happened.
 */
export function clearIconCache(): void {
  cache.clear();
}
