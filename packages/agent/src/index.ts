/**
 * The Windows agent.
 *
 * One headless Node process: watch what you are doing, tell the server, raise
 * a toast when the server says a nudge has earned it. No tray, no window, no
 * Electron — the UI is the PWA in a browser, and this stays a background
 * service that should be easy to forget is running.
 *
 *   npm run agent -w @everything/agent
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { AttentionReport } from '@everything/shared';
import { AttentionMonitor, type AttentionSnapshot, type StoppingPoint } from './attention.js';
import { ServerClient, ServerUnreachable } from './client.js';
import { agentConfig, assertConfigured } from './config.js';
import { registerExtraGames } from './games.js';
import { showToast } from './notify.js';

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
let voice: { stop(): void } | null = null;

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
    // Closes the microphone, stops the long-poll and destroys the overlay. Null
    // when voice is not installed, which is the ordinary case for anyone who
    // does not want a microphone open.
    voice?.stop();
    console.log('\nagent stopped.');
    process.exit(0);
  });
}
