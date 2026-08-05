import { buildApp } from './app.js';
import { config } from './config.js';
import { runMigrations } from './db/migrate.js';
import { pruneOldSamples } from './routes/attention.js';

await runMigrations();

const app = await buildApp();

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

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
