/**
 * The live listener, driven by synthesised speech instead of a microphone.
 *
 *   npm run voice-listen -w @everything/agent
 *
 * `voice-try` proves the models; this proves the *listener* — the gate, the
 * spotter firing mid-sentence, the command model loading on the first wake
 * while the audio waits for it, the tone that waits for a pause, the window
 * that times out, and what reaches the server. Each scenario is played through
 * a stand-in microphone at real speed, one 100ms block per poll, so the timings
 * are the ones a person would get.
 *
 * Nothing is sent anywhere: `post` is captured here.
 */
import { VOICE_COMMAND_TIMEOUT_MS, VOICEPRINT_DIMENSIONS } from '@everything/shared';
import type { Microphone } from '../mic.js';
import { createVoiceListener, type VoiceConfig, type VoiceHeard } from '../voice.js';
import { BLOCK, cleanUp, say } from './speech-test.js';

const silence = (ms: number) => new Int16Array((BLOCK * ms) / 100);

function join(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

interface Run {
  posts: VoiceHeard[];
  events: Array<{ at: number; name: string }>;
}

async function play(name: string, audio: Int16Array, tailMs: number): Promise<Run> {
  let at = 0;
  const mic: Microphone = {
    read() {
      const block = audio.subarray(at, at + BLOCK);
      at += BLOCK;
      return block.length === BLOCK ? block : new Int16Array(BLOCK);
    },
    close() {},
  };

  const run: Run = { posts: [], events: [] };
  const started = Date.now();
  const listener = createVoiceListener((heard) => run.posts.push(heard), { microphone: () => mic });
  for (const event of ['wake', 'listening', 'missed', 'sleep', 'command-ready']) {
    listener.on(event, () => run.events.push({ at: Date.now() - started, name: event }));
  }
  listener.on('error', (error: Error) => run.events.push({ at: Date.now() - started, name: `error: ${error.message}` }));

  const config: VoiceConfig = {
    enabled: true,
    wakeWord: 'hey jarvis',
    requireKnownSpeaker: false,
    speakerThreshold: 0.55,
    voiceprint: null,
    vocabulary: [],
    version: name,
  };
  listener.configure(config);

  const audioMs = (audio.length / BLOCK) * 100;
  await new Promise((done) => setTimeout(done, audioMs + tailMs));
  listener.stop();

  console.log(`\n${name}`);
  for (const event of run.events) console.log(`  ${String(event.at).padStart(5)}ms  ${event.name}`);
  for (const post of run.posts) console.log(`         -> posted "${post.text}"`);
  return run;
}

const failures: string[] = [];
const expect = (ok: boolean, what: string) => {
  if (!ok) failures.push(what);
};

try {
  const wake = say('hey jarvis');
  const command = say('i drank two waters');

  // First, so it pays the model load: the command arrives while it is loading.
  const paused = await play('wake, a pause, then the command', join(silence(300), wake, silence(1200), command), 3000);
  expect(paused.posts[0]?.text === 'i drank two waters', 'the paused command was not delivered as said');
  expect(paused.events.some((e) => e.name === 'listening'), 'no tone after a paused wake word');

  const together = await play('wake and command in one breath', join(silence(300), say('hey jarvis i drank two waters')), 3000);
  expect(together.posts[0]?.text === 'i drank two waters', 'the run-together command was not delivered as said');
  expect(!together.events.some((e) => e.name === 'listening'), 'a tone played over a run-together sentence');

  const chatter = await play('ordinary conversation', join(silence(300), say('harvest festival is on the weekend, where did harley go')), 2000);
  expect(chatter.posts.length === 0 && !chatter.events.some((e) => e.name === 'wake'), 'conversation woke it');

  const nothing = await play('wake, then nothing', join(silence(300), wake), VOICE_COMMAND_TIMEOUT_MS + 3000);
  expect(nothing.events.some((e) => e.name === 'missed') && nothing.posts.length === 0, 'silence after the wake word was not a miss');

  console.log(failures.length ? `\nFAILED: ${failures.join('; ')}\n` : `\nThe listener behaves. (voiceprints are ${VOICEPRINT_DIMENSIONS}-dimensional)\n`);
  process.exitCode = failures.length ? 1 : 0;
} finally {
  cleanUp();
}
