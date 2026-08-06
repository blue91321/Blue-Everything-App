/**
 * Teach the agent what Blake sounds like, from a terminal.
 *
 *   npm run voice-enrol -w @everything/agent
 *
 * The button on the Voice screen is the main way in now. This drives the same
 * path rather than a second one: it asks the server to open an enrolment
 * window, and the *running agent* collects the samples on the microphone it
 * already holds. It used to open the microphone itself, which could not work
 * while voice was switched on — a second opener gets MMSYSERR_ALLOCATED, so the
 * command failed exactly when someone was most likely to run it.
 *
 * ### Why the wake word and not free speech
 *
 * Enrolling on a fixed phrase means the enrolled vectors and the vectors
 * compared against them at runtime come from the same words, spoken the same
 * way, at the same distance from the same microphone. That removes most of the
 * variance the model would otherwise have to see through, and is the difference
 * between a threshold that separates cleanly and one set so loose it lets the
 * television through.
 *
 * ### What this is and is not
 *
 * A filter against the room: the TV, a video, someone else talking. Not a
 * security control — a recording of his voice passes it, and it guards habit
 * ticks rather than anything that matters. The vault is out of reach of voice
 * entirely.
 */
import { VOICE_ENROL_SAMPLES } from '@everything/shared';
import { ServerClient } from '../client.js';

const client = new ServerClient();

const status = await client.voiceStatus().catch((error: Error) => {
  console.error(`\nCould not reach the server: ${error.message}\n`);
  process.exit(1);
});

if (!status.agentRunning) {
  console.error('\nThe agent is not running — it is the thing that holds the microphone.');
  console.error('Start it with Everything App.cmd, then try again.\n');
  process.exit(1);
}

if (!status.enabled) {
  console.error('\nVoice is switched off. Turn it on under Voice, then try again.\n');
  process.exit(1);
}

const config = await client.voiceConfig();
console.log(`\nSay "${config.wakeWord}" clearly, ${VOICE_ENROL_SAMPLES} times.`);
console.log('Leave a beat between each one. Speak the way you actually will —');
console.log('sitting where you sit, at the volume you use.\n');

await client.startEnrol();

let last = -1;
const started = Date.now();

const timer = setInterval(async () => {
  let now;
  try {
    now = await client.voiceStatus();
  } catch {
    return;
  }

  if (now.enrolSamples !== last) {
    last = now.enrolSamples;
    const agreement = now.enrolAgreement === null ? '' : `  (consistency ${Math.round(now.enrolAgreement * 100)}%)`;
    if (last > 0) console.log(`  ${last}/${VOICE_ENROL_SAMPLES}${agreement}`);
  }

  if (!now.enrolling) {
    clearInterval(timer);
    // The window closes either because a voiceprint was stored or because it
    // ran out; `hasVoiceprint` is what tells those apart.
    const settings = await client.voiceStatus();
    console.log(
      settings.enrolSamples === 0 && last >= VOICE_ENROL_SAMPLES
        ? '\nStored. Turn on "only respond to my voice" under Voice.\n'
        : '\nEnrolment finished. Check the Voice screen for whether it stored.\n'
    );
    process.exit(0);
  }

  if (Date.now() - started > 100_000) {
    clearInterval(timer);
    await client.stopEnrol().catch(() => {});
    console.error('\nGave up waiting. Nothing was stored.\n');
    process.exit(1);
  }
}, 500);
