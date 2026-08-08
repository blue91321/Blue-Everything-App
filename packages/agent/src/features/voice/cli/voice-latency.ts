/**
 * Where does the time go between speaking and something happening?
 *
 *   npm run voice-latency -w @everything/agent
 *
 * Vosk answers `accept` only when its endpointer decides the speaker has
 * stopped, which is a fixed stretch of silence *after* you finish — and it is
 * paid twice, once to notice the wake word and again to read the command. Two
 * of those back to back is the whole of the "voice feels laggy" complaint.
 *
 * This measures both, against real synthesised speech, and shows what the
 * partial-result shortcuts in `voice.ts` actually buy. Windows' own synthesiser
 * writes the audio, so it needs no microphone and nobody has to sit repeating a
 * phrase at a log.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchesWakeWord } from '@everything/shared';
import { SAMPLE_RATE } from '../mic.js';
import { createRecogniser } from '../vosk.js';

const WAKE = 'hey jarvis';
const COMMAND = 'drink water';
const BLOCK = SAMPLE_RATE / 10;
/** Matches SETTLED_POLLS in voice.ts. */
const SETTLED_POLLS = 3;

const workDir = mkdtempSync(join(tmpdir(), 'everything-latency-'));

function synthesise(text: string, file: string): void {
  const script = `
    Add-Type -AssemblyName System.Speech
    $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(${SAMPLE_RATE}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $s.SetOutputToWaveFile(${JSON.stringify(file)}, $fmt)
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

/** Blocks of digital silence, as the microphone would deliver them once you stop. */
const silence = new Int16Array(BLOCK);

try {
  const wakeFile = join(workDir, 'wake.wav');
  const commandFile = join(workDir, 'command.wav');
  synthesise(WAKE, wakeFile);
  synthesise(`${WAKE} ${COMMAND}`, commandFile);

  const wakeAudio = pcm(wakeFile);
  const sentence = pcm(commandFile);

  console.log(`\nspeech is ${(wakeAudio.length / SAMPLE_RATE).toFixed(2)}s of "${WAKE}"`);
  console.log('every figure below is wall-clock delay the speaker experiences, not CPU\n');

  /* ---- the wake word ---- */

  {
    const wake = createRecogniser([WAKE], { withSpeaker: true });
    let partialAt: number | null = null;
    let block = 0;

    for (let i = 0; i < wakeAudio.length; i += BLOCK) {
      block++;
      wake.accept(wakeAudio.subarray(i, Math.min(i + BLOCK, wakeAudio.length)));
      if (partialAt === null && matchesWakeWord(wake.partial(), WAKE)) partialAt = block;
    }
    const spoken = block;

    let finalAt: number | null = null;
    for (let i = 0; i < 60 && finalAt === null; i++) {
      block++;
      if (wake.accept(silence)) finalAt = block;
    }

    console.log('wake word');
    console.log(`  speech ends at        ${spoken * 100}ms`);
    console.log(
      `  partial names it at   ${partialAt === null ? 'never' : `${partialAt * 100}ms`}` +
        `${partialAt !== null && partialAt <= spoken ? '   <- while still speaking' : ''}`
    );
    console.log(`  endpoint fires at     ${finalAt === null ? 'never (>6s)' : `${finalAt * 100}ms`}`);
    if (partialAt !== null && finalAt !== null) {
      console.log(`  SAVED                 ${(finalAt - partialAt) * 100}ms`);
    }
    wake.close();
  }

  /* ---- the command ---- */

  {
    const command = createRecogniser([`${WAKE} ${COMMAND}`.split(' ').join(' ')]);
    let block = 0;
    let last = '';
    let still = 0;
    let settledAt: number | null = null;

    for (let i = 0; i < sentence.length; i += BLOCK) {
      block++;
      command.accept(sentence.subarray(i, Math.min(i + BLOCK, sentence.length)));
    }
    const spoken = block;

    let finalAt: number | null = null;
    for (let i = 0; i < 60 && finalAt === null; i++) {
      block++;
      if (command.accept(silence)) {
        finalAt = block;
        break;
      }
      const guess = command.partial();
      if (guess && guess === last) {
        still++;
        if (settledAt === null && still >= SETTLED_POLLS) settledAt = block;
      } else {
        last = guess;
        still = 0;
      }
    }

    console.log('\ncommand');
    console.log(`  speech ends at        ${spoken * 100}ms`);
    console.log(`  partial settles at    ${settledAt === null ? 'never' : `${settledAt * 100}ms`}`);
    console.log(`  endpoint fires at     ${finalAt === null ? 'never (>6s)' : `${finalAt * 100}ms`}`);
    if (settledAt !== null && finalAt !== null) {
      console.log(`  SAVED                 ${(finalAt - settledAt) * 100}ms`);
    }
    command.close();
  }

  console.log('');
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
