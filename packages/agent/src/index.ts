/**
 * The Windows agent.
 *
 * One headless Node process: watch what you are doing, tell the server, and
 * raise the popup when the server says a nudge has earned it. No window and no
 * Electron — the UI is the PWA in a browser, and this stays a background
 * service that should be easy to forget is running.
 *
 * It raised Windows toasts once. Every one spawned PowerShell, because there is
 * no WinRT binding here — a process and a few hundred milliseconds for the half
 * of the notification you were *less* likely to look at. See the nudge loop.
 *
 * It does now put an icon in the notification area, which the header here used
 * to rule out. That line meant "not Electron, which wants 150-250MB to draw
 * one"; `Shell_NotifyIconW` wants four calls and a struct. See `tray.ts`. Being
 * easy to forget is running turned out to be a virtue only up to the point
 * where you want to stop it.
 *
 *   npm run agent -w @everything/agent
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { isAwayFromPc, type AttentionReport } from '@everything/shared';
import { AttentionMonitor, type AttentionSnapshot, type StoppingPoint } from './attention.js';
import { ServerClient, ServerUnreachable } from './client.js';
import { agentConfig, assertConfigured } from './config.js';
import { registerExtraGames } from './games.js';
import * as popup from './popup.js';
import { setSoundEnabled, setTones } from './sound.js';
import { createTray, runAppScript, type Tray } from './tray.js';

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

/**
 * How long a nudge's popup stays up.
 *
 * Longer than a voice result, which answers a question you just asked and can
 * go as soon as it is read. A nudge arrives unprompted, so it has to survive
 * you looking up a moment after it appeared.
 */
const NUDGE_POPUP_MS = 9000;

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
  /*
   * Release the microphone when the chair is empty.
   *
   * Decided here, from the snapshot the agent already has, using the same
   * `isAwayFromPc` the server uses to decide whether a nudge may go to the
   * phone — one definition of "away", so the two can never disagree about it.
   *
   * Deliberately *above* the in-flight and backoff guards: whether to hold a
   * recording device open must not depend on a round trip, and must keep
   * working while the server is down. An always-on microphone in an empty room
   * is the one state this app should never leave running by accident.
   */
  voice?.setPresent(!isAwayFromPc(snapshot));

  if (inFlight || Date.now() < backoffUntil) return;
  inFlight = true;

  try {
    const { deliver, soundEnabled, tones } = await client.report(toReport(snapshot, stoppingPoint));

    // A server that predates the column sends nothing; on rather than off is the
    // right reading of silence for a setting whose default is on.
    setSoundEnabled(soundEnabled ?? true);
    // Likewise: an absent map leaves every event on its default rather than
    // silencing the app because an older server did not know about tones.
    setTones(tones ?? {});

    if (offlineReported) {
      console.log(`[${clock()}] server back`);
      offlineReported = false;
    }
    backoffMs = BACKOFF_START_MS;

    for (const nudge of deliver) {
      const suffix = nudge.escalated ? ' (deadline passed)' : '';
      const body = nudge.body ?? stoppingPoint?.reason ?? '';
      console.log(`[${clock()}] nudge: ${nudge.title}${suffix}`);

      /*
       * The overlay, and only the overlay.
       *
       * This used to raise a Windows toast as well, on the reasoning that the
       * two fail in opposite ways: the overlay gets *noticed* — it draws above
       * an exclusive-fullscreen game, which is exactly where a nudge lands —
       * while the toast *persists* in the Action Centre afterwards.
       *
       * The toast is gone because of what it costs to raise one. There is no
       * WinRT binding here, so every notification spawned PowerShell: a process,
       * a few hundred milliseconds, and a flash of console at the moment the app
       * is trying to be unobtrusive. Paying that for the half you were less
       * likely to look at was the wrong way round.
       *
       * What is genuinely lost is the Action Centre entry — a nudge you miss is
       * now missed, rather than waiting in a list. The queue still holds it: an
       * undelivered nudge is on the Dashboard either way, which is the place
       * this app already asks you to look.
       */
      popup.show({
        title: nudge.title + suffix,
        lines: body ? [{ text: body, tone: nudge.escalated ? 'bad' : 'muted' }] : [],
        forMs: NUDGE_POPUP_MS,
        sound: 'nudge',
      });

      // The popup cannot fail the way a spawned process could, so there is no
      // longer a "did it actually reach the screen" to gate this on.
      await client.acknowledge(nudge.id).catch(() => {});
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
/* Voice — optional, and loaded only if it is actually here            */
/* ------------------------------------------------------------------ */

/**
 * Everything voice does lives in `./features/voice/`, which can be deleted.
 *
 * Presence is checked before importing rather than by catching the import's
 * failure. Both would work for a missing folder, but `ERR_MODULE_NOT_FOUND` is
 * also what you get when the feature *is* installed and something it depends on
 * is not — koffi, say. Catching the error alone would report a broken
 * installation as an absent one, and send whoever is debugging it looking for a
 * folder that is sitting right there.
 *
 * So: if the folder is gone, say so and carry on. If it is present and fails to
 * load, that is a real error and it is thrown.
 *
 * The import is `await`ed at the top level, which this file can do — it is ESM.
 * The cost is that the attention monitor starts a few milliseconds later, which
 * matters not at all against a 5-second tick.
 */
/**
 * Structurally typed rather than imported from the feature.
 *
 * Core must not import `features/voice`, not even a type: a type-only import is
 * erased at runtime and so would not crash, it would just fail the type check
 * for whoever deleted the folder — silently, until they tried to build. Naming
 * the two methods used here costs a line and keeps the boundary real.
 */
let voice: { stop(): void; setPresent(present: boolean): void } | null = null;

const voiceEntry = resolve(dirname(fileURLToPath(import.meta.url)), 'features/voice/index');
// Both extensions: the agent runs through tsx from source today, but a compiled
// build would leave .js beside it, and this must not start lying then.
const voiceInstalled = existsSync(`${voiceEntry}.ts`) || existsSync(`${voiceEntry}.js`);

if (voiceInstalled) {
  const { startVoice } = await import('./features/voice/index.js');
  voice = startVoice(client, clock);
} else {
  console.log(`[${clock()}] voice is not installed — running without it`);
}

/* ------------------------------------------------------------------ */
/* App integrations — also optional, also deletable                    */
/* ------------------------------------------------------------------ */

/**
 * The friends only this machine can see — the League client's own API.
 *
 * Same presence check as voice, for the same reason: a missing folder and a
 * broken dependency both raise ERR_MODULE_NOT_FOUND, and reporting the second
 * as the first sends somebody looking for a folder that is right there.
 */
let integrations: { stop(): void } | null = null;

const integrationsEntry = resolve(dirname(fileURLToPath(import.meta.url)), 'features/integrations/index');
if (existsSync(`${integrationsEntry}.ts`) || existsSync(`${integrationsEntry}.js`)) {
  const { startIntegrations } = await import('./features/integrations/index.js');
  integrations = startIntegrations(client, (message) => console.log(`[${clock()}] ${message}`));
}

/* ------------------------------------------------------------------ */
/* The notification-area icon                                          */
/* ------------------------------------------------------------------ */

/**
 * Somewhere to find the app.
 *
 * Both services run hidden, so without this the only way to reach them is a
 * `.cmd` file in a folder you have to remember. The icon is the answer to
 * "is it running, and how do I stop it".
 *
 * Failing to create it must never cost the agent. There is no desktop under a
 * service account and no shell in a container, and neither is a reason to stop
 * watching for stopping points — the same call the overlay makes.
 */
/*
 * The popup is started here, before anything can need it.
 *
 * Creating it costs ~3ms, and the alternative is paying that at the exact
 * moment someone is waiting to see whether the wake word worked. It is core
 * rather than part of voice because nudges use it too — see `popup.ts`.
 */
popup.startPopups({ log: (message) => console.log(`[${clock()}] ${message}`) });

let tray: Tray | null = null;
try {
  tray = createTray({
    tooltip: `Blue Everything — ${agentConfig.serverUrl}`,
    // Through `start.ps1 -Open` rather than launching a browser here, so there
    // is one definition of "open the app". The script sees the port is already
    // listening and goes straight to opening the window.
    onOpen: () => runAppScript('start.ps1', ['-Open']),
  });
} catch (error) {
  console.log(`[${clock()}] no tray icon: ${(error as Error).message}`);
}

console.log(`Blue Everything agent -> ${agentConfig.serverUrl}`);
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
    // Taken down explicitly rather than left to the process exiting: the shell
    // does not notice an owner dying until something hovers the icon, so a
    // ghost sits in the tray until then and clicking it does nothing.
    tray?.destroy();
    // Closes the microphone and stops the long-poll. Null when voice is not
    // installed, which is the ordinary case for anyone who does not want a
    // microphone open.
    voice?.stop();
    integrations?.stop();
    popup.stopPopups();
    console.log('\nagent stopped.');
    process.exit(0);
  });
}
