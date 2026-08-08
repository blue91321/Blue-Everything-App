/**
 * Voice commands, as one removable piece.
 *
 * This is only the server half — phrase matching, the agent's long-poll, and
 * the command routes. The listening half lives in
 * `packages/agent/src/features/voice/`, and the models it needs live inside
 * that folder. Both are removed independently; the agent copes with a server
 * that has no voice routes, and the server copes with an agent that never asks.
 *
 * As with the vault, migration-created tables (`voice_commands`) stay behind.
 */
export { voiceRoutes as routes } from './routes.js';
