/**
 * Voice commands: "I drank water" ticks off the drink-water habit.
 *
 * The split that matters is that the agent hears and the server decides. The
 * agent turns sound into a string and posts it; every judgement about what that
 * string meant happens here. Same reason `/api/attention` works the way it
 * does — clients stay dumb, so the phone and the PC can never disagree, and the
 * phrase list never has to be synchronised onto another machine.
 *
 * What the agent *does* get is a vocabulary hint (`/api/voice/config`), used to
 * constrain the recogniser so it hears "drank" rather than "drink" or "rank".
 * That is a recognition aid, not a decision — the matching below is still the
 * only thing that says which habit was meant.
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  VOICE_ENROL_MS,
  VOICE_TEST_MS,
  createVoiceCommandSchema,
  matchVoiceCommand,
  spokenCount,
  voiceAgentReportSchema,
  voiceEnrolSchema,
  voiceCommandSchema,
  voiceHeardSchema,
  voiceTokens,
  type VoiceAgentReport,
  type VoiceCandidate,
  type VoiceHeard,
} from '@everything/shared';
import { db } from '../../db/client.js';
import { notes, settings, voiceCommands } from '../../db/schema.js';
import { getSettings } from '../../nudge-engine.js';
import { changes } from '../../events.js';
import {
  labelFor,
  loadCommands,
  parsePhrases,
  planChain,
  resolveVoiceCommand,
  runCommand,
  phraseWordsFor,
  vocabularyFor,
  type VoiceOutcome,
} from './actions.js';

/** Stored as whole percent so the column stays an integer like every other flag. */
const thresholdFraction = (pct: number): number => pct / 100;

/**
 * Is listening paused right now?
 *
 * `-1` is "until switched back on by hand" and never lapses. Anything else is a
 * deadline. Null is not paused.
 */
function isPaused(until: number | null): boolean {
  if (until === null) return false;
  return until === -1 || until > Date.now();
}

/**
 * What the agent last said about itself, and what it recently heard.
 *
 * In memory, never in the database — exactly like `currentWindowsDnd`. This is
 * live state: "is a microphone open right now" cannot be answered from a log,
 * and writing a row every fifteen seconds for a question nobody asks between
 * visits to the Voice screen would be the polling this app avoids everywhere
 * else. Losing it on restart is correct; the agent re-reports within seconds.
 */
let agentState: (VoiceAgentReport & { at: number }) | null = null;

/** When a listening test stops. The agent reads this on its next report. */
let testUntil = 0;

/** Whether the last test ended because it worked, rather than by running out. */
let succeeded = false;

/**
 * Changes when the uploaded avatar does.
 *
 * The picture lives beside the database, not in it — a settings row read on
 * every page load has no business carrying an image. The agent downloads it
 * once and only again when this moves.
 */
let avatarVersion = Date.now();

/** What Windows can decode, and therefore what is worth accepting. */
const AVATAR_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
};

/**
 * Beside the database, resolved from this file rather than the working
 * directory — Task Scheduler starts the server in System32, and a relative path
 * would quietly write the avatar somewhere nobody would ever look.
 */
const avatarPath = (extension: string): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), '../../data', `avatar.${extension}`);

/**
 * When an enrolment window closes.
 *
 * Enrolment is a mode the *running* agent enters, not a separate program: it
 * already holds the microphone, and a second opener gets MMSYSERR_ALLOCATED
 * rather than a voiceprint.
 */
let enrolUntil = 0;

/**
 * Bumped whenever anything the agent needs to know about changes.
 *
 * The agent long-polls against this rather than asking on a timer. Polling
 * traded latency for request rate and lost both ways: 10 seconds of it was a
 * third of a 30-second test window gone before the microphone was even
 * listening, and it still cost a request every 10 seconds forever.
 */
let voiceVersion = 1;
const voiceChanged = new EventEmitter();
// One listener per waiting agent; the default cap of 10 is a leak warning, not
// a limit, and a restarting agent can briefly overlap.
voiceChanged.setMaxListeners(0);

function bumpVoice(): void {
  voiceVersion++;
  voiceChanged.emit('change');
}

// Settings and habit edits are what change the wake word, the chosen device and
// the phrase vocabulary, and both already announce themselves. Listening here
// rather than calling bumpVoice() from those routes keeps voice's plumbing in
// voice's file.
changes.on('change', (event: { scope: string }) => {
  if (event.scope === 'settings' || event.scope === 'habits' || event.scope === 'all') bumpVoice();
});

/** Wait for something to change, or give up so status stays reasonably fresh. */
function waitForVoiceChange(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      voiceChanged.off('change', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    voiceChanged.on('change', finish);
  });
}

/** Recent test events, newest last. Bounded — this is a live view, not history. */
interface HeardEvent extends VoiceHeard {
  at: number;
  /** What it would have ticked off, had this not been a test. */
  wouldMatch: { habitName: string | null; phrase: string } | null;
}
const heard: HeardEvent[] = [];
const HEARD_LIMIT = 40;

/**
 * How long before the agent counts as gone.
 *
 * Comfortably more than its report interval, so an ordinary slow tick doesn't
 * flicker the screen into saying the agent is down when it is fine.
 */
const AGENT_STALE_MS = 45_000;

/**
 * Tell the open clients what a spoken command actually changed.
 *
 * Only what *wrote* something. An ambiguous or unmatched utterance changed
 * nothing, and with an always-on microphone those are the common case —
 * broadcasting them would reload every client on room noise.
 *
 * Recursive for `chained`, whose steps are ordinary outcomes and can be any mix
 * of them. Written as one function rather than three copies because the chain
 * added a third caller, and the copy that gets forgotten is always the one that
 * leaves the phone showing a habit as undone after you said you'd done it.
 */
function announce(result: VoiceOutcome): void {
  for (const step of result.steps ?? []) announce(step);

  if (result.outcome === 'habit-checked') changes.emitChange('habits');
  if (result.outcome === 'note-added' || result.outcome === 'captured-as-note') changes.emitChange('notes');
  if (result.outcome === 'paused') {
    changes.emitChange('settings');
    bumpVoice();
  }
}

export async function voiceRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Everything the agent needs to listen. Polled rarely — the wake word only
   * changes when you change it — so it carries the voiceprint inline rather
   * than making the agent fetch it separately.
   */
  app.get('/api/voice/config', async () => {
    const row = await getSettings();
    const commands = await loadCommands();

    // The union of every word in every phrase, plus the wake word. Handed to
    // the recogniser as its entire vocabulary: a small closed grammar is both
    // far more accurate and far cheaper than open-ended transcription, which is
    // what makes an always-on microphone affordable at all.
    const words = vocabularyFor(commands, row.wakeWord);
    // Checked against the model separately from the grammar: the grammar now
    // carries generated inflections, and warning that "waters" is unknown would
    // bury the one warning that matters under noise nobody typed.
    const literal = phraseWordsFor(commands, row.wakeWord);

    return {
      enabled: Boolean(row.voiceEnabled),
      wakeWord: row.wakeWord,
      requireKnownSpeaker: Boolean(row.requireKnownSpeaker),
      speakerThreshold: thresholdFraction(row.speakerThreshold),
      voiceprint: row.voiceprint ? (JSON.parse(row.voiceprint) as number[]) : null,
      vocabulary: words,
      checkWords: literal,
      /**
       * Changes whenever anything above does. The agent compares this instead
       * of diffing the payload, so rebuilding the recognisers — which reloads a
       * grammar, and is not free — only happens when something actually moved.
       *
       * Hashes the words rather than counting them. Renaming a phrase from
       * "drink water" to "sip water" leaves the count identical, and a counted
       * version would have left the agent listening for the old vocabulary
       * until something unrelated happened to bump it.
       */
      version: createHash('sha256').update(`${row.wakeWord}\n${words.join(' ')}`).digest('hex').slice(0, 16),
    };
  });

  /**
   * The agent's voice heartbeat: it says what it's doing, and gets told what to
   * do in the same round trip.
   *
   * Deliberately one endpoint rather than a status POST plus a config GET. The
   * agent has no live connection to the server, so everything it learns it
   * learns by asking — folding the answer into the report it was already
   * sending keeps that at one request instead of two.
   */
  app.post('/api/voice/agent', async (request) => {
    const body = voiceAgentReportSchema.parse(request.body);
    agentState = { ...body, at: Date.now() };

    // Hold the request open until something the agent cares about changes, so
    // pressing "Test it" reaches the microphone in milliseconds rather than on
    // the next tick of a timer. Costs nothing while idle — an open connection
    // is not a busy one — and replaces a request every 10s with one every 20s.
    if (body.waitMs && body.since === voiceVersion) {
      await waitForVoiceChange(Math.min(body.waitMs, 25_000));
      // The agent may have been told to stop while it was parked here.
      if (agentState) agentState.at = Date.now();
    }

    const row = await getSettings();
    const testing = testUntil > Date.now();

    return {
      version: voiceVersion,
      // A pause is not the same as being switched off: the setting stays on, so
      // the screen still says "listening" is what you asked for, while the
      // microphone is genuinely closed until the pause lapses.
      enabled: Boolean(row.voiceEnabled) && !isPaused(row.voicePausedUntil),
      pausedUntil: row.voicePausedUntil,
      wakeWord: row.wakeWord,
      requireKnownSpeaker: Boolean(row.requireKnownSpeaker),
      speakerThreshold: thresholdFraction(row.speakerThreshold),
      voiceprint: row.voiceprint ? (JSON.parse(row.voiceprint) as number[]) : null,
      inputDevice: row.voiceInputDevice,
      /** 0 means the microphone closes as soon as a command is done. */
      followUpMs: row.voiceFollowUpSeconds * 1000,
      /** After a miss rather than a hit — see DEFAULT_VOICE_RETRY_SECONDS. */
      retryMs: row.voiceRetrySeconds * 1000,
      overlayPlacement: row.overlayPlacement,
      overlayScreen: row.overlayScreen,
      overlayAvatar: row.overlayAvatar,
      /** Bumped when the picture changes, so the agent redownloads only then. */
      avatarVersion: row.overlayAvatar === 'file' ? avatarVersion : 0,
      /** Non-zero means "report what you hear, and don't act on it". */
      testUntil: testing ? testUntil : 0,
      /** Non-zero means "collect wake-word samples instead of obeying them". */
      enrolUntil: enrolUntil > Date.now() ? enrolUntil : 0,
    };
  });

  /** What the Voice screen shows. Polled while that screen is open. */
  app.get('/api/voice/status', async () => {
    const row = await getSettings();
    const fresh = agentState !== null && Date.now() - agentState.at < AGENT_STALE_MS;
    const testing = testUntil > Date.now();

    return {
      /** The setting. Whether anything is *actually* listening is `listening`. */
      enabled: Boolean(row.voiceEnabled),
      paused: isPaused(row.voicePausedUntil),
      /** -1 means until switched back on by hand; a timestamp means until then. */
      pausedUntil: row.voicePausedUntil,
      agentRunning: fresh,
      listening: fresh ? agentState!.listening : false,
      device: fresh ? (agentState!.device ?? null) : null,
      devices: fresh ? agentState!.devices : [],
      error: fresh ? (agentState!.error ?? null) : null,
      peak: fresh ? agentState!.peak : 0,
      lastReportAt: agentState?.at ?? null,
      selectedDevice: row.voiceInputDevice,
      followUpSeconds: row.voiceFollowUpSeconds,
      retrySeconds: row.voiceRetrySeconds,
      overlayPlacement: row.overlayPlacement,
      overlayScreen: row.overlayScreen,
      overlayAvatar: row.overlayAvatar,
      screens: fresh ? (agentState!.screens ?? []) : [],
      testing,
      testUntil: testing ? testUntil : 0,
      /** The last test ended because a command matched, not because it expired. */
      testSucceeded: succeeded,
      enrolling: enrolUntil > Date.now(),
      enrolUntil: enrolUntil > Date.now() ? enrolUntil : 0,
      /** Words no phrase can ever be heard saying — see voiceAgentReportSchema. */
      unknownWords: fresh ? (agentState!.unknownWords ?? []) : [],
      enrolSamples: fresh ? (agentState!.enrolSamples ?? 0) : 0,
      enrolAgreement: fresh ? (agentState!.enrolAgreement ?? null) : null,
      heard: testing || heard.length > 0 ? heard.slice(-HEARD_LIMIT) : [],
    };
  });

  /** Arm a listening test. Nothing it hears during one is acted on. */
  app.post('/api/voice/test-listen', async () => {
    testUntil = Date.now() + VOICE_TEST_MS;
    heard.length = 0;
    succeeded = false;
    bumpVoice();
    return { testUntil };
  });

  app.post('/api/voice/test-listen/stop', async () => {
    testUntil = 0;
    bumpVoice();
    return { ok: true };
  });

  /**
   * Something heard during a test. Recorded for the screen, never acted on.
   *
   * Refuses outside a test window, so there is no path by which a "just show
   * me" report could become a habit tick.
   */
  app.post('/api/voice/heard', async (request, reply) => {
    if (testUntil <= Date.now()) return reply.code(409).send({ error: 'no test is running' });

    const body = voiceHeardSchema.parse(request.body);
    const commands = await loadCommands();
    const candidates: VoiceCandidate[] = commands
      .filter((command) => command.phrases.length > 0)
      .map((command) => ({ id: command.id, phrases: command.phrases }));

    const match = body.text ? matchVoiceCommand(body.text, candidates) : null;
    const matched = match ? commands.find((c) => c.id === match.id) : undefined;
    const wouldMatch = match && matched
      ? { habitName: await labelFor(matched), phrase: match.phrase }
      : null;

    heard.push({ ...body, at: Date.now(), wouldMatch });
    if (heard.length > HEARD_LIMIT) heard.splice(0, heard.length - HEARD_LIMIT);

    /*
     * A test that has proved the thing it set out to prove is over.
     *
     * Running the full window regardless meant standing there talking to a
     * microphone that had already answered the question, and every further
     * sentence added noise to the readout. Only a *matched* command ends it —
     * one that matched nothing is exactly the case worth another go.
     */
    if (body.kind === 'command' && wouldMatch) {
      testUntil = 0;
      succeeded = true;
      bumpVoice();
    }

    return { ok: true, wouldMatch };
  });

  /**
   * Something was said. Work out what it meant and do it.
   *
   * Always 200 with an outcome rather than 4xx on no match: "I didn't catch
   * that" is a normal result of listening to a room, not a client error, and
   * the agent's log is far more readable when a miss looks like a miss.
   */
  app.post('/api/voice/command', async (request) => {
    const body = voiceCommandSchema.parse(request.body);
    const row = await getSettings();

    if (!row.voiceEnabled) return { outcome: 'disabled' as const, text: body.text };

    // The speaker check is enforced here as well as in the agent. The agent
    // does it to avoid a pointless round trip; the server does it because it is
    // the only side that cannot be bypassed by a stale or edited agent config.
    if (row.requireKnownSpeaker && row.voiceprint) {
      const score = body.speakerScore ?? -1;
      if (score < thresholdFraction(row.speakerThreshold)) {
        return { outcome: 'wrong-speaker' as const, text: body.text, speakerScore: body.speakerScore ?? null };
      }
    }

    const result = await resolveVoiceCommand(body.text, await loadCommands(), row.wakeWord);
    announce(result);
    return result;
  });

  /** Act on a disambiguation the overlay resolved. */
  app.post('/api/voice/command/:id/run', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { text = '' } = (request.body ?? {}) as { text?: string };
    const row = await getSettings();

    const command = (await loadCommands()).find((c) => c.id === id);
    if (!command) return reply.code(404).send({ error: 'no such command' });

    const result = { ...(await runCommand(command, text, command.phrases[0] ?? '', row.wakeWord)), allowFollowUp: command.allowFollowUp };
    announce(result);
    return result;
  });

  /* ---------------- what can I say ---------------- */

  app.get('/api/voice/commands', async () => {
    const rows = await db.select().from(voiceCommands).orderBy(asc(voiceCommands.sortOrder));
    return Promise.all(
      rows.map(async (row) => ({
        ...row,
        phrases: parsePhrases(row.phrases),
        enabled: Boolean(row.enabled),
        allowFollowUp: Boolean(row.allowFollowUp),
        label: await labelFor({
          id: row.id,
          kind: row.kind as never,
          phrases: parsePhrases(row.phrases),
          target: row.target,
          pauseMinutes: row.pauseMinutes,
          label: row.label,
          allowFollowUp: Boolean(row.allowFollowUp),
        }),
      }))
    );
  });

  app.post('/api/voice/commands', async (request, reply) => {
    const body = createVoiceCommandSchema.parse(request.body);
    const existing = await db.select({ sortOrder: voiceCommands.sortOrder }).from(voiceCommands);
    const nextOrder = existing.reduce((max, c) => Math.max(max, c.sortOrder), 0) + 1;

    const [created] = await db
      .insert(voiceCommands)
      .values({
        kind: body.kind,
        phrases: JSON.stringify(body.phrases.map((p) => p.trim().toLowerCase())),
        target: body.target ?? null,
        pauseMinutes: body.pauseMinutes ?? null,
        label: body.label ?? null,
        allowFollowUp: body.allowFollowUp ? 1 : 0,
        enabled: body.enabled ? 1 : 0,
        sortOrder: body.sortOrder ?? nextOrder,
      })
      .returning();

    bumpVoice();
    return reply.code(201).send({ ...created, phrases: parsePhrases(created.phrases) });
  });

  app.patch('/api/voice/commands/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = createVoiceCommandSchema.parse(request.body);

    const [updated] = await db
      .update(voiceCommands)
      .set({
        kind: body.kind,
        phrases: JSON.stringify(body.phrases.map((p) => p.trim().toLowerCase())),
        target: body.target ?? null,
        pauseMinutes: body.pauseMinutes ?? null,
        label: body.label ?? null,
        allowFollowUp: body.allowFollowUp ? 1 : 0,
        enabled: body.enabled ? 1 : 0,
      })
      .where(eq(voiceCommands.id, id))
      .returning();

    if (!updated) return reply.code(404).send({ error: 'no such command' });
    bumpVoice();
    return { ...updated, phrases: parsePhrases(updated.phrases) };
  });

  app.delete('/api/voice/commands/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await db.delete(voiceCommands).where(eq(voiceCommands.id, id));
    bumpVoice();
    return reply.code(204).send();
  });

  /**
   * The avatar picture, uploaded from the Voice screen.
   *
   * Stored beside the database as one file rather than in a column: it is
   * binary, it is read by a different process, and the settings row is fetched
   * on every page load. Local-only, like every other write that reaches this
   * machine rather than the database.
   */
  app.put('/api/voice/avatar', async (request, reply) => {
    if (!request.isLocal) {
      return reply.code(403).send({ error: 'the avatar can only be set from the PC running the server' });
    }

    const body = z
      .object({
        /** Bare base64, no data: prefix — the client strips it. */
        data: z.string().min(1).max(4 * 1024 * 1024),
        type: z.string().max(100),
      })
      .parse(request.body);

    const extension = AVATAR_TYPES[body.type];
    if (!extension) {
      return reply.code(400).send({ error: 'needs to be a PNG, JPEG, GIF or BMP' });
    }

    const bytes = Buffer.from(body.data, 'base64');
    if (bytes.length === 0) return reply.code(400).send({ error: 'that file was empty' });

    // One avatar at a time: the old one goes, so a switch from PNG to JPEG does
    // not leave the previous file behind forever.
    for (const old of Object.values(AVATAR_TYPES)) {
      await rm(avatarPath(old), { force: true }).catch(() => {});
    }
    await writeFile(avatarPath(extension), bytes);

    const current = await getSettings();
    await db.update(settings).set({ overlayAvatar: 'file' }).where(eq(settings.id, current.id));

    avatarVersion = Date.now();
    changes.emitChange('settings');
    bumpVoice();
    return { ok: true, bytes: bytes.length, version: avatarVersion };
  });

  /** Serve it back — to the agent, which draws it, and to the settings screen. */
  app.get('/api/voice/avatar', async (_request, reply) => {
    for (const [type, extension] of Object.entries(AVATAR_TYPES)) {
      const path = avatarPath(extension);
      if (!existsSync(path)) continue;
      return reply.type(type).send(await readFile(path));
    }
    return reply.code(404).send({ error: 'no avatar has been uploaded' });
  });

  /** Resume after a "stop listening". The only way back from an open-ended one. */
  app.post('/api/voice/resume', async () => {
    const current = await getSettings();
    await db.update(settings).set({ voicePausedUntil: null }).where(eq(settings.id, current.id));
    changes.emitChange('settings');
    bumpVoice();
    return { ok: true };
  });

  /**
   * Start collecting. Local-only for the same reason storing is: enrolment
   * decides whose voice the machine obeys, and the microphone is on this PC.
   */
  app.post('/api/voice/enrol/start', async (request, reply) => {
    if (!request.isLocal) {
      return reply.code(403).send({ error: 'voice enrolment only works from the PC running the server' });
    }
    const row = await getSettings();
    if (!row.voiceEnabled) return reply.code(409).send({ error: 'switch voice on first — enrolment uses its microphone' });
    if (isPaused(row.voicePausedUntil)) return reply.code(409).send({ error: 'listening is paused' });

    enrolUntil = Date.now() + VOICE_ENROL_MS;
    bumpVoice();
    return { enrolUntil };
  });

  app.post('/api/voice/enrol/stop', async () => {
    enrolUntil = 0;
    bumpVoice();
    return { ok: true };
  });

  /**
   * Store the enrolled voiceprint.
   *
   * Local-only, like adding a device. Enrolment is what decides whose voice the
   * machine will obey, so it should not be reachable from a phone on the
   * tailnet — and the recording it comes from happens on this PC anyway.
   */
  app.post('/api/voice/enrol', async (request, reply) => {
    if (!request.isLocal) {
      return reply.code(403).send({ error: 'voice enrolment only works from the PC running the server' });
    }

    const body = voiceEnrolSchema.parse(request.body);
    const current = await getSettings();

    await db
      .update(settings)
      .set({
        voiceprint: JSON.stringify(body.voiceprint),
        voiceprintSamples: body.samples,
        // Enrolling *is* the request to be the only accepted speaker — there is
        // no other reason to do it. Making you then find a switch would just be
        // a second step with one sensible answer.
        requireKnownSpeaker: 1,
      })
      .where(eq(settings.id, current.id));

    // Collected what it came for, so the window closes rather than running on.
    enrolUntil = 0;
    bumpVoice();
    changes.emitChange('settings');
    return { ok: true, samples: body.samples, dimensions: body.voiceprint.length };
  });

  /** Forget the enrolled voice. Leaves `requireKnownSpeaker` alone on purpose —
   *  see the settings route, which refuses to have it on with nothing enrolled. */
  app.delete('/api/voice/enrol', async (request, reply) => {
    if (!request.isLocal) {
      return reply.code(403).send({ error: 'voice enrolment only works from the PC running the server' });
    }

    const current = await getSettings();
    await db
      .update(settings)
      .set({ voiceprint: null, voiceprintSamples: 0, requireKnownSpeaker: 0 })
      .where(eq(settings.id, current.id));

    changes.emitChange('settings');
    return { ok: true };
  });

  /**
   * What would this sentence do? Nothing is written.
   *
   * Exists because the failure everyone hits is a phrase that reads fine and
   * never matches, and the alternative way to find that out is saying it at the
   * microphone repeatedly and watching a log.
   */
  app.post('/api/voice/test', async (request) => {
    const body = voiceCommandSchema.parse(request.body);
    const commands = await loadCommands();
    const candidates: VoiceCandidate[] = commands
      .filter((command) => command.phrases.length > 0)
      .map((command) => ({ id: command.id, phrases: command.phrases }));

    // Asked first, exactly as the real path does — "drink water and skip this
    // track" matches "drink water" as a whole sentence, so reporting the single
    // match would describe half of what would actually happen.
    const chain = planChain(body.text, commands, candidates, (await getSettings()).wakeWord);
    if (chain) {
      return {
        heard: body.text,
        tokens: voiceTokens(body.text),
        count: spokenCount(body.text),
        match: null,
        chain: await Promise.all(
          chain.map(async (step) => ({
            phrase: step.phrase,
            kind: step.command.kind,
            habitName: await labelFor(step.command),
            // Per segment, because that is how the real path counts them.
            count: spokenCount(step.segment),
          }))
        ),
      };
    }

    const match = matchVoiceCommand(body.text, candidates);
    const matched = match ? commands.find((c) => c.id === match.id) : undefined;
    return {
      heard: body.text,
      tokens: voiceTokens(body.text),
      count: spokenCount(body.text),
      match: match && matched ? { ...match, habitName: await labelFor(matched), kind: matched.kind } : null,
      chain: null,
    };
  });

  /** Recent voice-created notes, so a run of misses is visible somewhere. */
  app.get('/api/voice/misses', async () => {
    return db
      .select()
      .from(notes)
      .where(eq(notes.title, 'Heard, but not understood'))
      .orderBy(desc(notes.createdAt))
      .limit(20);
  });
}
