import { buildApp } from './app.js';
import { AGENT_GONE_MS, watchForAgent } from './agent-watch.js';
import { config, isGuest } from './config.js';
import { runMigrations } from './db/migrate.js';
import { giveCopiesTheirKeys, startCopies, writeOwnPid } from './instances.js';
import { phoneOnlyDelivery, pruneOldSamples } from './routes/attention.js';

await runMigrations();

const app = await buildApp();

// The host hands each guest copy in `instances/` its key — see `instances.ts`.
await giveCopiesTheirKeys((line) => app.log.info(line));

/*
 * A promise that fails with nobody waiting on it — a timer's `void doThing()`
 * in some package — ends a Node process by default, and only `server.err.log`
 * would say why, which `start.ps1` empties on the next start. One stray
 * rejection is not worth the whole app, so it is written to the server log
 * and the server carries on. A thrown exception still ends it, as it should.
 */
process.on('unhandledRejection', (reason) => {
  app.log.error({ err: reason }, 'a promise failed with nothing handling it — logged, and the server kept running');
});

// Attention history is the only table that grows on its own. Pruning at boot
// and daily keeps it bounded without a cron job or a second process.
const prune = async () => {
  const removed = await pruneOldSamples();
  if (removed > 0) app.log.info(`pruned ${removed} attention samples past retention`);
};
await prune();
setInterval(prune, 24 * 60 * 60_000).unref();

try {
  await app.listen({ host: config.HOST, port: config.PORT });
  app.log.info(`database: ${config.DATABASE_URL}`);
  app.log.info(config.AUTH_REQUIRED ? 'auth: required' : 'auth: DISABLED — local testing only');
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

// A guest copy says where it is, so the host can stop it; the host starts the
// people's copies that were running, in the background. See `instances.ts`.
// Removed on exit; a copy stopped hard leaves it, which the next start overwrites.
process.on('exit', writeOwnPid());
void startCopies((line) => app.log.warn(line));
// A friend's copy has no agent on this PC, so it delivers to their phone itself.
if (isGuest) phoneOnlyDelivery();

// The tray icon is the app on this PC: when its agent goes, so does the server,
// and `app.close()` runs the hooks that take Suwayomi down with it.
if (config.EXIT_WITHOUT_AGENT) {
  watchForAgent(async () => {
    app.log.warn(`no word from the agent for ${AGENT_GONE_MS / 1000}s — its tray icon is gone, so the app is closing`);
    // Exits either way. A close that hangs would leave exactly what this exists
    // to prevent — a process running with no icon — so it is given a bound.
    const closed = await Promise.race([
      app.close().then(() => true),
      new Promise<boolean>((done) => setTimeout(() => done(false), 15_000)),
    ]);
    if (!closed) app.log.error('closing took longer than 15s — exiting anyway');
    process.exit(0);
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
