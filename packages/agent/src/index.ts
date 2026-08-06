/**
 * The Windows agent.
 *
 * One headless Node process: watch what Blake is doing, tell the server, raise
 * a toast when the server says a nudge has earned it. No tray, no window, no
 * Electron — the UI is the PWA in a browser, and this stays a background
 * service that should be easy to forget is running.
 *
 *   npm run agent -w @everything/agent
 */
import {
  VOICE_ENROL_SAMPLES,
  averageVoiceprint,
  cosineSimilarity,
  type AttentionReport,
  type VoiceHeard,
} from '@everything/shared';
import { AttentionMonitor, type AttentionSnapshot, type StoppingPoint } from './attention.js';
import { ServerClient, ServerUnreachable, type VoiceOutcome } from './client.js';
import { agentConfig, assertConfigured } from './config.js';
import { registerExtraGames } from './games.js';
import { showToast } from './notify.js';
import { openUrl, pressKeys } from './actions.js';
import { createOverlay, type Overlay } from './overlay.js';
import { createVoiceListener, type VoiceConfig } from './voice.js';
import { VoskUnavailable } from './vosk.js';

assertConfigured();
registerExtraGames(agentConfig.extraGames);

const client = new ServerClient();
const monitor = new AttentionMonitor();

/** Backoff so a stopped server produces one line of log, not one per tick. */
const BACKOFF_START_MS = 15_000;
const BACKOFF_MAX_MS = 5 * 60_000;
let backoffUntil = 0;
let backoffMs = BACKOFF_START_MS;
let offlineReported = false;

/** Serialises reports so a slow response can't overlap the next tick. */
let inFlight = false;

const clock = () => new Date().toLocaleTimeString('en-US', { hour12: false });

function toReport(snapshot: AttentionSnapshot, stoppingPoint: StoppingPoint | null): AttentionReport {
  return {
    at: snapshot.at.getTime(),
    state: snapshot.state,
    reason: snapshot.reason,
    exe: snapshot.foreground?.exe ?? null,
    title: snapshot.foreground?.title ?? null,
    idleMs: snapshot.idleMs,
    liveGames: snapshot.liveGames,
    windowsDnd: snapshot.windowsDnd,
    audioPlaying: snapshot.audioPlaying,
    stoppingPoint: stoppingPoint ? { quality: stoppingPoint.quality, reason: stoppingPoint.reason } : null,
  };
}

monitor.on('tick', async (snapshot, stoppingPoint) => {
  if (inFlight || Date.now() < backoffUntil) return;
  inFlight = true;

  try {
    const { deliver } = await client.report(toReport(snapshot, stoppingPoint));

    if (offlineReported) {
      console.log(`[${clock()}] server back`);
      offlineReported = false;
    }
    backoffMs = BACKOFF_START_MS;

    for (const nudge of deliver) {
      const suffix = nudge.escalated ? ' (deadline passed)' : '';
      console.log(`[${clock()}] nudge: ${nudge.title}${suffix}`);
      const shown = await showToast({
        title: nudge.title + suffix,
        body: nudge.body ?? stoppingPoint?.reason ?? '',
        tag: nudge.id,
      });
      // Only acknowledge what actually reached the screen; a failed toast
      // should stay in the queue rather than being silently marked as seen.
      if (shown) await client.acknowledge(nudge.id).catch(() => {});
    }
  } catch (error) {
    if (error instanceof ServerUnreachable) {
      if (!offlineReported) {
        console.log(`[${clock()}] server unreachable at ${agentConfig.serverUrl} — retrying quietly`);
        offlineReported = true;
      }
      backoffUntil = Date.now() + backoffMs;
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    } else {
      console.error(`[${clock()}] ${(error as Error).message}`);
      backoffUntil = Date.now() + BACKOFF_MAX_MS;
    }
  } finally {
    inFlight = false;
  }
});

monitor.on('change', (snapshot, from) => {
  console.log(`[${clock()}] ${from} -> ${snapshot.state}  (${snapshot.reason})`);
});

monitor.on('stopping-point', (sp) => {
  console.log(`[${clock()}] stopping point (${sp.quality}): ${sp.reason}`);
});

monitor.on('unknown-fullscreen-app', (exe) => {
  console.log(`[${clock()}] ${exe} held exclusive fullscreen but isn't in games.ts`);
});

/* ------------------------------------------------------------------ */
/* Voice                                                               */
/* ------------------------------------------------------------------ */

/**
 * The listener is created unconditionally but opens nothing until the server
 * says voice is enabled — which it is not by default. A microphone should be
 * something Blake switched on, not something he finds already running.
 */
/**
 * The window at the cursor.
 *
 * Created lazily and kept: it appears the instant the wake word lands, and
 * creating it per utterance would waste that. If the window cannot be made at
 * all — a session with no desktop, say — voice carries on without it, because a
 * missing overlay is a worse reason to lose the feature than no reason at all.
 */
let overlay: Overlay | null = null;
let overlayFailed = false;
let hideTimer: NodeJS.Timeout | null = null;

function ui(): Overlay | null {
  if (overlay || overlayFailed) return overlay;
  try {
    overlay = createOverlay({
      onChoice: (id) => void chooseCommand(id),
      onDismiss: () => hideOverlay(0),
    });
  } catch (error) {
    overlayFailed = true;
    console.error(`[${clock()}] overlay unavailable: ${(error as Error).message}`);
  }
  return overlay;
}

function hideOverlay(afterMs: number): void {
  if (hideTimer) clearTimeout(hideTimer);
  if (afterMs <= 0) {
    overlay?.hide();
    return;
  }
  hideTimer = setTimeout(() => overlay?.hide(), afterMs);
  hideTimer.unref();
}

/** How long a result stays up. Long enough to read, short enough not to nag. */
const OVERLAY_RESULT_MS = 4000;
/** A question waits longer, because it is waiting on Blake rather than telling him. */
const OVERLAY_ASK_MS = 12_000;

const TONE_FOR: Record<string, 'good' | 'bad' | 'muted'> = {
  'habit-checked': 'good',
  'note-added': 'good',
  opened: 'good',
  'keys-sent': 'good',
  paused: 'muted',
  'captured-as-note': 'muted',
  'no-match': 'bad',
};

function performAction(result: VoiceOutcome): void {
  // Anything that touches *this machine* comes back as an instruction; the
  // server does the database half itself. It has no business assuming it runs
  // on Blake's desk, and one day it won't.
  if (!result.action) return;
  try {
    if (result.action.do === 'open-url') openUrl(result.action.url);
    if (result.action.do === 'press-keys') pressKeys(result.action.keys);
    // A pause needs nothing here: the server has recorded it, and the next
    // long-poll answer reports voice as disabled, which closes the microphone.
  } catch (error) {
    console.error(`[${clock()}] voice action refused: ${(error as Error).message}`);
    ui()?.show({ title: 'Refused', lines: [{ text: (error as Error).message, tone: 'bad' }] });
    hideOverlay(OVERLAY_RESULT_MS);
  }
}

function showResult(result: VoiceOutcome): void {
  console.log(`[${clock()}] voice (${result.outcome}): ${result.say ?? `"${result.text}"`}`);

  if (result.outcome === 'ambiguous' && result.choices?.length) {
    ui()?.show({
      title: 'Which one?',
      lines: [{ text: result.say ?? 'That matches more than one thing.', tone: 'muted' }],
      choices: result.choices,
    });
    hideOverlay(OVERLAY_ASK_MS);
    return;
  }

  ui()?.show({
    title: result.say ?? result.text,
    // Coloured by outcome, so a miss does not look like a success at a glance —
    // which matters most for the ones that changed nothing.
    lines: [{ text: `heard "${result.text}"`, tone: TONE_FOR[result.outcome] ?? 'muted' }],
  });
  hideOverlay(OVERLAY_RESULT_MS);

  // Having just answered, it is still Blake's turn. A pause is the exception:
  // he asked for silence, so carrying on listening would be perverse.
  if (result.outcome !== 'paused') voice.listenAgain();
}

async function chooseCommand(id: string): Promise<void> {
  try {
    const result = await client.runVoiceCommand(id);
    performAction(result);
    showResult(result);
  } catch (error) {
    console.error(`[${clock()}] could not run that: ${(error as Error).message}`);
  }
}

const voice = createVoiceListener((heard) => {
  if (!heard.accepted) {
    const why = heard.reason === 'wrong-speaker' ? "didn't sound like you" : 'no voice sample to check against';
    console.log(`[${clock()}] voice ignored (${why}): "${heard.text}"`);
    ui()?.show({ title: 'Not you', lines: [{ text: why, tone: 'bad' }] });
    hideOverlay(2000);
    return;
  }

  client
    .voiceCommand({ text: heard.text, speakerScore: heard.speakerScore })
    .then((result) => {
      performAction(result);
      showResult(result);
    })
    .catch((error) => console.error(`[${clock()}] voice command failed: ${(error as Error).message}`));
});

// An EventEmitter with no `error` listener throws on emit, which would take the
// whole agent down because a microphone was unplugged.
voice.on('error', (error: Error) => {
  console.error(`[${clock()}] voice: ${error.message}`);
  if (error instanceof VoskUnavailable) {
    console.error('         voice is off until this is fixed — run: npm run voice-setup -w @everything/agent');
  }
});

voice.on('wake', ({ speakerScore }: { speakerScore: number | null }) => {
  const score = speakerScore === null ? '' : ` (voice match ${(speakerScore * 100).toFixed(0)}%)`;
  console.log(`[${clock()}] listening…${score}`);
  ui()?.show({ title: 'Listening…', lines: [{ text: 'go ahead', tone: 'muted' }] });
  // No auto-hide: the result replaces this, and `missed` covers trailing off.
});

// Woke, but nothing usable followed — take the window away rather than leaving
// "Listening…" on screen for a question that was never asked.
voice.on('missed', () => {
  if (overlay?.visible) {
    ui()?.show({ title: "Didn't catch that", lines: [{ text: 'say it again', tone: 'muted' }] });
    hideOverlay(2000);
  }
});

// During a test the screen is showing what the agent hears, so it is posted the
// moment it happens rather than waiting for the next heartbeat.
voice.on('heard', (event: VoiceHeard) => {
  client.voiceHeard(event).catch(() => {});
});

/* ---------------- enrolment ---------------- */

let enrolSamples: number[][] = [];
let enrolAgreement: number | null = null;

voice.on('enrol-short', ({ frames }: { frames: number }) => {
  console.log(`[${clock()}] enrol: too short to measure (${frames} frames)`);
  ui()?.show({
    title: `Teaching it your voice — ${enrolSamples.length} of ${VOICE_ENROL_SAMPLES}`,
    lines: [{ text: 'that was too short — say it a little slower', tone: 'bad' }],
  });
});

voice.on('enrol-sample', ({ embedding }: { embedding: number[] }) => {
  // Measured against the running mean, so drift shows up while there is still
  // time to start over rather than after the voiceprint is stored.
  enrolAgreement =
    enrolSamples.length > 0 ? cosineSimilarity(embedding, averageVoiceprint(enrolSamples)) : null;
  enrolSamples.push(embedding);

  const count = enrolSamples.length;
  console.log(`[${clock()}] enrol: ${count}/${VOICE_ENROL_SAMPLES}`);

  ui()?.show({
    title: `Teaching it your voice — ${count} of ${VOICE_ENROL_SAMPLES}`,
    lines: [
      { text: count < VOICE_ENROL_SAMPLES ? 'say it again' : 'that is enough — saving', tone: 'muted' },
      ...(enrolAgreement === null
        ? []
        : [{ text: `consistency ${Math.round(enrolAgreement * 100)}%`, tone: enrolAgreement < 0.5 ? 'bad' : 'good' } as const]),
    ],
  });

  if (count < VOICE_ENROL_SAMPLES) return;

  const voiceprint = averageVoiceprint(enrolSamples);
  const spread = enrolSamples.map((sample) => cosineSimilarity(sample, voiceprint));
  const worst = Math.min(...spread);
  enrolSamples = [];

  client
    .enrolVoice(voiceprint, VOICE_ENROL_SAMPLES)
    .then(() => {
      console.log(`[${clock()}] enrol: stored, worst sample ${Math.round(worst * 100)}%`);
      ui()?.show({
        title: 'Voice learned',
        lines:
          worst < 0.5
            ? [{ text: 'those varied a lot — enrol again somewhere quieter', tone: 'bad' }]
            : [{ text: `only your voice will be obeyed now`, tone: 'good' }],
      });
      hideOverlay(5000);
    })
    .catch((error) => {
      console.error(`[${clock()}] enrol failed: ${(error as Error).message}`);
      ui()?.show({ title: 'Could not save', lines: [{ text: (error as Error).message, tone: 'bad' }] });
      hideOverlay(5000);
    });
});

/**
 * Voice state is long-polled, not polled.
 *
 * The agent has no live connection to the server, so it has to ask. Asking on a
 * timer traded latency for request rate and lost both ways: at 10 seconds, a
 * third of a test window was gone before the microphone was listening, and it
 * still cost a request every 10 seconds forever.
 *
 * So the request is held open by the server until something actually changes.
 * Pressing "Test it" now reaches the microphone in milliseconds, and an idle
 * agent makes *fewer* requests than before, not more.
 *
 * The exception is while a test is running, where the screen is showing a live
 * level meter and needs frequent readings rather than a held connection. That
 * is a fast poll, for the forty-five seconds it lasts.
 */
const VOICE_WAIT_MS = 20_000;
const VOICE_TEST_POLL_MS = 400;

/** Switched off: enough to release the device, nothing to listen for. */
const EMPTY_VOICE_CONFIG: VoiceConfig = {
  enabled: false,
  wakeWord: '',
  requireKnownSpeaker: false,
  speakerThreshold: 1,
  voiceprint: null,
  vocabulary: [],
  version: '',
};

/**
 * Long enough for the listener to have opened the new device, short enough that
 * the screen doesn't look stuck. Several ticks of the 100ms loop.
 */
const VOICE_SETTLE_MS = 600;

/** Backoff while the server is down, so a stopped server isn't a hot loop. */
const VOICE_RETRY_MS = 15_000;

let voiceVersion = 0;
let appliedVoice = '';
let voiceLoopStopped = false;

async function voiceTick(): Promise<number> {
  const status = voice.status();
  // Both modes want a live screen rather than a held connection.
  const busy = Math.max(voice.testingUntil ?? 0, voice.enrolUntil ?? 0) > Date.now();

  const answer = await client.voiceAgentReport({
    listening: status.listening,
    device: status.device,
    devices: status.devices,
    error: status.error,
    peak: status.peak,
    // While testing or enrolling the screen wants live progress, so ask now.
    waitMs: busy ? 0 : VOICE_WAIT_MS,
    since: voiceVersion,
    enrolSamples: enrolSamples.length,
    enrolAgreement,
  });

  voiceVersion = answer.version;

  // The vocabulary is the expensive half of the payload and only changes when a
  // phrase does, so it is fetched only when there is something to listen for.
  // Rebuilding the recognisers is separately guarded by its own `version`.
  if (answer.enabled) {
    voice.configure({ ...(await client.voiceConfig()), ...answer });
  } else {
    voice.configure({ ...EMPTY_VOICE_CONFIG, wakeWord: answer.wakeWord ?? '' });
  }

  /*
   * A report is gathered *before* the config that arrives with it is applied,
   * so a settings change would be visible one round trip late. That reads as
   * "the microphone I just picked didn't take" — the exact doubt this screen
   * was added to remove. When something actually changed, report again once the
   * new device has had a moment to open.
   */
  const signature = `${answer.enabled}:${answer.inputDevice ?? ''}:${answer.wakeWord ?? ''}`;
  const changed = signature !== appliedVoice;
  appliedVoice = signature;

  if (answer.testUntil > Date.now() || (answer.enrolUntil ?? 0) > Date.now()) return VOICE_TEST_POLL_MS;

  // Leaving enrolment with a half-collected set would silently poison the next
  // attempt, which would then average two different sittings together.
  if (enrolSamples.length > 0 && (answer.enrolUntil ?? 0) === 0) {
    enrolSamples = [];
    enrolAgreement = null;
  }

  return changed ? VOICE_SETTLE_MS : 0;
}

/**
 * Self-scheduling rather than an interval: each pass decides when the next one
 * happens, and a held-open request must never overlap the one behind it.
 */
async function voiceLoop(): Promise<void> {
  while (!voiceLoopStopped) {
    let delay = VOICE_RETRY_MS;
    try {
      delay = await voiceTick();
    } catch (error) {
      // Quiet: the attention loop already reports an unreachable server, and
      // voice should not double up on that noise.
      if (!(error instanceof ServerUnreachable)) {
        console.error(`[${clock()}] could not read voice settings: ${(error as Error).message}`);
      }
    }
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay).unref());
  }
}

void voiceLoop();

console.log(`Everything App agent -> ${agentConfig.serverUrl}`);
monitor.start();

/** Cheap visibility that the leanness claims still hold in a long-running process. */
setInterval(() => {
  const { ticks, snapshots, snapshotMsTotal } = monitor.stats;
  const rss = Math.round(process.memoryUsage().rss / 1024 / 1024);
  console.log(
    `[${clock()}] ${ticks} ticks, ${snapshots} process scans (${snapshotMsTotal.toFixed(0)}ms total), rss ${rss}MB`
  );
}, 60 * 60_000).unref();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    monitor.stop();
    voiceLoopStopped = true;
    voice.stop();
    overlay?.destroy();
    console.log('\nagent stopped.');
    process.exit(0);
  });
}
