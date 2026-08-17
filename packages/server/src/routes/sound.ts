/**
 * The notification tones, as playable bytes.
 *
 * This exists so the tone picker on the Settings screen can be *heard*. It was a
 * dropdown of nine words — `knock`, `blip`, `soft` — and the only way to find
 * out what any of them sounded like was `npm run sound-try -w @everything/agent
 * -- --tones`, which is the friction the three double-clickable files in the
 * repo root exist to remove.
 *
 * **The browser cannot ask the agent to play one.** The agent holds no inbound
 * connection; it polls. A preview routed through the attention heartbeat would
 * arrive five to fifteen seconds after the click, which is not a preview, and
 * from the phone it would never arrive at all — while the setting is equally
 * editable there. So the bytes come from here and the browser plays them.
 *
 * **Unauthenticated, and outside `/api/`**, exactly like `/icon/<size>.png`.
 * `auth.ts` protects that prefix, and an `<audio>` element fetching a URL sends
 * no bearer token — under `/api/` this would 401 in a way that only shows up as
 * silence. Nothing is exposed by it: a tone is a sine wave computed from nine
 * numbers, with no more of your data in it than the app's icon has.
 *
 * The rendering is `wav()` from `@everything/shared/sound` — the same function
 * over the same table the agent writes its temp file from — so what you audition
 * here is byte-for-byte what will actually interrupt you.
 */
import type { FastifyInstance } from 'fastify';
import { TONES, isToneName, wav } from '@everything/shared/sound';

export async function soundRoutes(app: FastifyInstance): Promise<void> {
  app.get('/sounds/:file', async (request, reply) => {
    const { file } = request.params as { file: string };
    const tone = file.replace(/\.wav$/i, '');

    if (!isToneName(tone)) return reply.code(404).send({ error: 'no such tone' });

    /*
     * `none` is silence, and silence is not a zero-length WAV — that is a file
     * every browser is entitled to treat as broken, and the console error it
     * produces would be the only feedback from choosing "silent". 204 says the
     * request was fine and there is nothing to play, which is exactly true.
     */
    if (TONES[tone].length === 0) return reply.code(204).send();

    return reply
      .type('audio/wav')
      /*
       * These change only when the palette in `shared/src/sound.ts` is edited,
       * which is a code change and therefore a new deploy. An hour is long
       * enough that clicking through the list does not refetch, and short enough
       * that nobody is left auditioning a tone that no longer exists.
       */
      .header('cache-control', 'public, max-age=3600')
      .send(Buffer.from(wav(TONES[tone])));
  });
}
