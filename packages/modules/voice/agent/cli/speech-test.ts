/**
 * What the voice CLIs share: Windows' speech synthesiser writing test audio,
 * and the two models fed it the way the live listener feeds them.
 *
 * Synthetic speech is not a substitute for real speech — it is cleaner, and it
 * is not your voice — but it exercises every other link in the chain with no
 * microphone and nobody in the chair.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rms, SAMPLE_RATE } from '../mic.js';
import { createCommandRecogniser, createWakeSpotter, toFloat, type WakeHit } from '../engine.js';

export const BLOCK = SAMPLE_RATE / 10;
const SPEECH_FLOOR = 0.006;
const HANGOVER_MS = 700;

const workDir = mkdtempSync(join(tmpdir(), 'everything-voice-'));
let counter = 0;

export function cleanUp(): void {
  rmSync(workDir, { recursive: true, force: true });
}

/** Windows TTS straight to 16kHz mono — the format the models want. */
export function say(text: string, rate = 1): Int16Array {
  const file = join(workDir, `${counter++}.wav`);
  const script = `
    Add-Type -AssemblyName System.Speech
    $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(${SAMPLE_RATE}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $s.SetOutputToWaveFile(${JSON.stringify(file)}, $fmt)
    $s.Rate = ${rate}
    $s.Speak(${JSON.stringify(text)})
    $s.Dispose()
  `;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  if (result.status !== 0) throw new Error(`speech synthesis failed: ${result.stderr?.toString().trim()}`);

  // Canonical WAV from the synthesiser: 44-byte header, then raw samples.
  const body = readFileSync(file).subarray(44);
  return new Int16Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength - (body.byteLength % 2)));
}

/**
 * The spotter over this audio, behind the same gate and hangover `poll()` uses.
 *
 * Kept faithful on purpose: a probe that reimplements the rule loosely measures
 * a system nobody is running.
 */
export function spot(audio: Int16Array, phrases: string[]): Array<WakeHit & { atMs: number }> {
  const spotter = createWakeSpotter(phrases);
  const hits: Array<WakeHit & { atMs: number }> = [];
  let at = 0;
  let lastLoudAt = -Infinity;

  const feed = (block: Int16Array): void => {
    at += 100;
    if (rms(block) >= SPEECH_FLOOR) lastLoudAt = at;
    if (at - lastLoudAt > HANGOVER_MS) {
      spotter.restart();
      return;
    }
    const hit = spotter.accept(toFloat(block));
    if (hit) hits.push({ ...hit, atMs: at });
  };

  for (let i = 0; i < audio.length; i += BLOCK) feed(audio.subarray(i, Math.min(i + BLOCK, audio.length)));
  for (let i = 0; i < 12; i++) feed(new Int16Array(BLOCK));
  return hits;
}

/** What the command recogniser writes for this audio, and how long it took. */
export async function transcribe(audio: Int16Array): Promise<{ text: string; loadMs: number; ms: number }> {
  let loadMs = 0;
  const finals: string[] = [];
  const recogniser = createCommandRecogniser({
    final: (text) => {
      if (text) finals.push(text);
    },
    error: (message) => {
      throw new Error(message);
    },
    ready: (ms) => {
      loadMs = ms;
    },
  });

  const started = Date.now();
  for (let i = 0; i < audio.length; i += BLOCK) recogniser.feed(toFloat(audio.subarray(i, Math.min(i + BLOCK, audio.length))));
  // Enough trailing silence for the endpoint to fire.
  for (let i = 0; i < 30; i++) recogniser.feed(new Float32Array(BLOCK));

  while (!recogniser.ready || Date.now() - started < 300) await new Promise((done) => setTimeout(done, 50));
  // The worker answers in order; give it a moment past the last block.
  const deadline = Date.now() + 5000;
  while (finals.length === 0 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));

  recogniser.close();
  return { text: finals.join(' '), loadMs, ms: Date.now() - started };
}
