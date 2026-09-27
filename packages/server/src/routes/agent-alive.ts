/**
 * The agent saying it is still here — and with it, its tray icon.
 *
 * Posted every twenty seconds, whatever else the agent is doing, and read by
 * `agent-watch.ts` to decide whether the app should still be running. It writes
 * nothing and announces nothing: an announced change here would reload every
 * open screen three times a minute, which is the polling the event stream exists
 * to replace.
 */
import type { FastifyInstance } from 'fastify';
import { agentCheckedIn } from '../agent-watch.js';

export async function agentAliveRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/agent/alive', { config: { announce: false } }, async () => {
    agentCheckedIn();
    return { ok: true };
  });
}
