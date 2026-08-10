/**
 * How often does the wake word fire on speech that was not addressed to it?
 *
 *   npm run wake-falsing -w @everything/agent
 *
 * The wake recogniser runs a grammar of two or three words plus `[unk]`, so
 * every sound in the room has to be mapped onto one of them. A *partial* is the
 * decoder's current best guess and is revisable; the endpointed result is what
 * it settles on once `[unk]` has had a fair chance to win.
 *
 * This feeds ordinary conversation past both and counts the difference, which
 * is the number that decides whether firing early is affordable.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchesWakeWord } from '@everything/shared';
import { rms, SAMPLE_RATE } from '../mic.js';
import { createRecogniser } from '../vosk.js';

const WAKE = process.env.WAKE_WORD || 'hey jarvis';
const BLOCK = SAMPLE_RATE / 10;
const SPEECH_FLOOR = 0.006;

/** Nothing here is addressed to the app. None of it should wake anything. */
const CHATTER = [
  'i was going to say the same thing about it',
  'yeah but have you seen how much they charge for that',
  'can you pass me the other one please',
  'harvest festival is on the weekend i think',
  'javier said he would call back later today',
  'i have no idea where it went honestly',
  'she was driving us all a bit mad about it',
  'just give us a minute and we can sort it out',
  'that is not what i meant at all',
  'they always do this at the end of the month',
];

const workDir = mkdtempSync(join(tmpdir(), 'everything-falsing-'));

function synthesise(text: string, file: string, rate = 1): void {
  const script = `
    Add-Type -AssemblyName System.Speech
    $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(${SAMPLE_RATE}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $s.SetOutputToWaveFile(${JSON.stringify(file)}, $fmt)
    $s.Rate = ${rate}
    $s.Speak(${JSON.stringify(text)})
    $s.Dispose()
  `;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`speech synthesis failed: ${result.stderr?.toString().trim()}`);
}

function pcm(file: string): Int16Array {
  const buffer = readFileSync(file);
  const body = buffer.subarray(44);
  return new Int16Array(body.buffer, body.byteOffset, Math.floor(body.byteLength / 2));
}

const HANGOVER_MS = 700;

interface Outcome {
  /** The rule that was tried and rejected: fire on a partial while audible. */
  partial: boolean;
  /** What ships: the gate, the hangover, and a flush at the boundary. */
  live: boolean;
}

/**
 * Mirrors `poll()` in voice.ts — the gate, the hangover, and the flush at the
 * utterance boundary.
 *
 * Kept faithful on purpose. A probe that reimplements the rule loosely
 * measures a system nobody is running, which is worse than not measuring.
 */
function run(audio: Int16Array): Outcome {
  const wake = createRecogniser([WAKE], { withSpeaker: true });
  const out: Outcome = { partial: false, live: false };

  let at = 0;
  let lastLoudAt = 0;
  let fedAnything = false;

  const feed = (chunk: Int16Array): void => {
    at += 100;
    const level = rms(chunk);
    if (level >= SPEECH_FLOOR) lastLoudAt = at;

    // The gate. Quiet for longer than the hangover is an utterance boundary.
    if (at - lastLoudAt > HANGOVER_MS) {
      if (fedAnything) {
        const settled = wake.flush();
        if (settled.text && matchesWakeWord(settled.text, WAKE)) out.live = true;
        else wake.reset();
        fedAnything = false;
      }
      return;
    }

    fedAnything = true;
    const finished = wake.accept(chunk);
    if (finished?.text && matchesWakeWord(finished.text, WAKE)) out.live = true;

    // The rejected rule, measured alongside for comparison only.
    if (!out.partial && level >= SPEECH_FLOOR) {
      const guess = wake.partial();
      if (guess && matchesWakeWord(guess, WAKE)) out.partial = true;
    }
  };

  for (let i = 0; i < audio.length; i += BLOCK) feed(audio.subarray(i, Math.min(i + BLOCK, audio.length)));

  // Long enough for the boundary to be reached and the flush to happen.
  const quiet = new Int16Array(BLOCK);
  for (let i = 0; i < 12; i++) feed(quiet);

  wake.close();
  return out;
}

try {
  console.log(`\nwake word: "${WAKE}"`);
  console.log('none of the following is addressed to the app\n');

  let partialFalse = 0;
  let finalFalse = 0;

  for (const line of CHATTER) {
    const file = join(workDir, 'c.wav');
    synthesise(line, file);
    const outcome = run(pcm(file));
    if (outcome.partial) partialFalse++;
    if (outcome.live) finalFalse++;

    const mark = outcome.live ? 'WOKE' : '  . ';
    console.log(
      `  ${mark}  partial-rule=${outcome.partial ? 'FIRED' : '-----'}  live=${outcome.live ? 'FIRED' : '-----'}  "${line}"`
    );
  }

  console.log(`\n  false wakes on a partial : ${partialFalse} / ${CHATTER.length}`);
  console.log(`  false wakes when settled : ${finalFalse} / ${CHATTER.length}`);

  console.log('\nand the real thing must still work:\n');
  for (const [label, rate] of [['normal', 1], ['fast', 3]] as const) {
    const file = join(workDir, 'w.wav');
    synthesise(WAKE, file, rate);
    const outcome = run(pcm(file));
    console.log(
      `  "${WAKE}" (${label})  partial-rule=${outcome.partial ? 'fires' : 'MISSES'}  live=${outcome.live ? 'fires' : 'MISSES'}`
    );
  }
  console.log('');
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
