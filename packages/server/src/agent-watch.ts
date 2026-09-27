/**
 * On the PC, the app is live exactly while its tray icon is there.
 *
 * The icon belongs to the agent, so the icon going means the agent has gone —
 * stopped, crashed, killed — and a server carrying on without it is an app
 * running with nothing on screen admitting it. So when the agent stops checking
 * in, the server closes itself, and its `onClose` hooks take Suwayomi with it.
 *
 * **Only when `start.ps1` asks for it** (`EXIT_WITHOUT_AGENT`). The server is
 * built to run without an agent — on a VPS, in a container, under `npm run dev`,
 * inside `smoke` — and those must not stop themselves ninety seconds in.
 *
 * ### The signal is its own check-in, not the attention heartbeat
 *
 * The heartbeat looked like the obvious signal and is the wrong one: after an
 * ordinary server error the agent deliberately goes quiet for five minutes
 * (`BACKOFF_MAX_MS`), and this would read that as the icon being gone. The
 * agent posts `/api/agent/alive` every twenty seconds regardless of anything
 * else, which writes nothing and announces nothing. The heartbeat still counts
 * too, so an agent from before the check-in existed keeps a newer server up.
 *
 * ### Sleep is not absence
 *
 * Neither process runs while the PC sleeps, so on waking the last check-in is
 * hours old and the agent has not yet had its first tick. A watch tick that
 * arrives far later than it was due is the machine having been suspended, and
 * the agent is owed a fresh window rather than being declared gone the instant
 * the PC wakes.
 */

/** How long without a word from the agent before the icon counts as gone. */
export const AGENT_GONE_MS = 90_000;

/** How often the server looks. */
const CHECK_MS = 15_000;

let lastAgentAt = Date.now();

/** The agent said something — its check-in, or its heartbeat. */
export function agentCheckedIn(): void {
  lastAgentAt = Date.now();
}

/**
 * Call `onGone` once the agent has been silent for `AGENT_GONE_MS`. The window
 * starts at boot, so an agent that never comes up counts as gone too: an icon
 * that never appeared is still an icon that is not there.
 */
export function watchForAgent(onGone: () => void): () => void {
  lastAgentAt = Date.now();
  let lastTick = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    // Woken from sleep — see the note at the top.
    if (now - lastTick > CHECK_MS * 3) lastAgentAt = now;
    lastTick = now;
    if (now - lastAgentAt > AGENT_GONE_MS) {
      clearInterval(timer);
      onGone();
    }
  }, CHECK_MS);
  // The listening socket keeps the process alive; this must not be what does.
  timer.unref();
  return () => clearInterval(timer);
}
