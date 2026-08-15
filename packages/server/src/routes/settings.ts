import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AWAY_FROM_PC_IDLE_MS, quietReason, updateSettingsSchema } from '@everything/shared';
import { db } from '../db/client.js';
import { settings } from '../db/schema.js';
import { getSettings } from '../nudge-engine.js';
import { phones } from '../push-port.js';
import { clearIconCache, hasStoredLogo } from './icon.js';
import { currentWindowsDnd } from './attention.js';

/**
 * The hidden-services list, out of the JSON text it is stored as.
 *
 * Exported because the integrations feature does the actual filtering and must
 * read the same column — one place knows that this is JSON, so a hand-rolled
 * second parse cannot disagree about what an empty value means.
 *
 * Anything unparseable reads as "nothing hidden". A corrupt setting must not be
 * able to empty the friends list, which is the failure that would look most
 * like the integration itself having broken.
 */
export function parseHiddenProviders(stored: string): string[] {
  try {
    const parsed: unknown = JSON.parse(stored || '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

async function describe(row: Awaited<ReturnType<typeof getSettings>>) {
  const windowsDnd = currentWindowsDnd();
  // Generated on first read so the phone always has a key to subscribe with.
  // `null` when the push feature is switched off or absent — the screen says so
  // rather than offering a subscribe button that could never work.
  const publicKey = await phones().vapidPublicKey();
  const reason = quietReason(new Date(), {
    quietHoursEnabled: Boolean(row.quietHoursEnabled),
    quietStartMinute: row.quietStartMinute,
    quietEndMinute: row.quietEndMinute,
    followWindowsDnd: Boolean(row.followWindowsDnd),
    dndUntil: row.dndUntil,
    remindersEnabled: Boolean(row.remindersEnabled),
    windowsDnd,
  });

  // The private half must never leave the server. The voiceprint is dropped for
  // a different reason — it isn't secret, it's just 128 floats that no screen
  // has any use for, and the settings payload is fetched on every page load.
  const { vapidPrivateKey: _secret, vapidPublicKey: _stored, voiceprint, ...safe } = row;

  return {
    ...safe,
    vapidPublicKey: publicKey,
    windowsDnd,
    quietNow: reason !== null,
    quietReason: reason,
    awayFromPcIdleMinutes: AWAY_FROM_PC_IDLE_MS / 60_000,
    hasVoiceprint: Boolean(voiceprint),
    // Stored as whole percent; the shared threshold constants are fractions.
    speakerThreshold: row.speakerThreshold / 100,
    hiddenProviders: parseHiddenProviders(row.hiddenProviders),
  };
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', async () => describe(await getSettings()));

  app.patch('/api/settings', async (request, reply) => {
    const body = updateSettingsSchema.parse(request.body);
    const current = await getSettings();

    // SQLite has no boolean type, so the flags convert on the way in.
    const toInt = (v: boolean | undefined) => (v === undefined ? undefined : v ? 1 : 0);

    // Turning this on with nothing enrolled would silently reject every command
    // — the speaker score would be compared against a voiceprint that doesn't
    // exist, and voice would simply stop working with no visible cause.
    if (body.requireKnownSpeaker && !current.voiceprint) {
      return reply.code(400).send({ error: 'enrol your voice first — there is nothing to compare against yet' });
    }

    // Same shape of mistake: `image` with nothing uploaded would silently draw
    // the pause glyph, which looks exactly like the upload having failed.
    if (body.logoShape === 'image' && !hasStoredLogo()) {
      return reply.code(400).send({ error: 'upload a picture first — there is nothing to show yet' });
    }

    const [updated] = await db
      .update(settings)
      .set({
        quietStartMinute: body.quietStartMinute,
        quietEndMinute: body.quietEndMinute,
        dndUntil: body.dndUntil,
        quietHoursEnabled: toInt(body.quietHoursEnabled),
        followWindowsDnd: toInt(body.followWindowsDnd),
        remindersEnabled: toInt(body.remindersEnabled),
        soundEnabled: toInt(body.soundEnabled),
        soundWake: body.soundWake,
        soundOk: body.soundOk,
        soundMiss: body.soundMiss,
        soundNudge: body.soundNudge,
        pushEnabled: toInt(body.pushEnabled),
        pushDefault: toInt(body.pushDefault),
        voiceEnabled: toInt(body.voiceEnabled),
        // Switching voice on clears any pause. "Stop listening until I turn it
        // back on" has to mean the obvious switch, or the only way out of an
        // open-ended pause is an endpoint with no button attached to it — which
        // is exactly how it shipped, and exactly how it stayed stuck.
        ...(body.voiceEnabled === true ? { voicePausedUntil: null } : {}),
        wakeWord: body.wakeWord?.trim().toLowerCase(),
        requireKnownSpeaker: toInt(body.requireKnownSpeaker),
        speakerThreshold:
          body.speakerThreshold === undefined ? undefined : Math.round(body.speakerThreshold * 100),
        voiceInputDevice: body.voiceInputDevice,
        voiceFollowUpSeconds: body.voiceFollowUpSeconds,
        voiceRetrySeconds: body.voiceRetrySeconds,
        overlayPlacement: body.overlayPlacement,
        overlayScreen: body.overlayScreen,
        overlayAvatar: body.overlayAvatar,
        theme: body.theme,
        accentColor: body.accentColor,
        logoShape: body.logoShape,
        // Stored as JSON text, since SQLite has no array type. `describe` reads
        // it back out, so an array is the only shape the API ever speaks.
        hiddenProviders:
          body.hiddenProviders === undefined ? undefined : JSON.stringify(body.hiddenProviders),
      })
      .where(eq(settings.id, current.id))
      .returning();

    // The rendered PNGs are keyed on the accent and the shape, so a change to
    // either makes every cached one wrong.
    if (body.accentColor || body.logoShape) clearIconCache();

    return describe(updated);
  });
}
