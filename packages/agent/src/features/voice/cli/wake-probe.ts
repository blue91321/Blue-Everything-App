/**
 * What does the wake recogniser's partial say, block by block?
 *
 *   npm run wake-probe -w @everything/agent
 *   npm run wake-probe -w @everything/agent -- "hey" "hey jarvis" "hey there"
 *
 * Firing on a partial made the wake word instant and immediately raised the
 * opposite question: does the partial ever name the whole phrase before the
 * distinctive half has actually been said? A grammar that knows one phrase has
 * an obvious incentive to guess it.
 *
 * This prints the partial after every 100ms block, which is exactly what
 * `voice.ts` sees, so the answer is observed rather than assumed.
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
const phrases = process.argv.slice(2);
const spoken = phrases.length > 0 ? phrases : ['hey', 'hey there', WAKE, 'okay then'];

const workDir = mkdtempSync(join(tmpdir(), 'everything-wake-'));

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

try {
  console.log(`\nwake word: "${WAKE}"\n`);

  for (const text of spoken) {
    const file = join(workDir, 'probe.wav');
    synthesise(text, file);
    const audio = pcm(file);

    const wake = createRecogniser([WAKE], { withSpeaker: true });
    console.log(`said "${text}"  (${(audio.length / SAMPLE_RATE).toFixed(2)}s)`);

    let woke = false;
    for (let i = 0, block = 0; i < audio.length; i += BLOCK) {
      block++;
      const chunk = audio.subarray(i, Math.min(i + BLOCK, audio.length));
      const level = rms(chunk);
      wake.accept(chunk);
      const partial = wake.partial();
      const hit = partial && matchesWakeWord(partial, WAKE);
      // 0.006 is SPEECH_FLOOR in voice.ts — is this block actually audible?
      const loud = level >= 0.006;
      if (hit && loud && !woke) woke = true;
      console.log(
        `   ${String(block * 100).padStart(5)}ms  rms=${level.toFixed(4)} ${loud ? 'LOUD ' : 'quiet'}` +
          `  partial="${partial}"${hit ? (loud ? '   <-- WAKES' : '   <-- match, but silent: predicted') : ''}`
      );
    }
    console.log(`   => ${woke ? 'WAKES' : 'does not wake'}\n`);
    wake.close();
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(0);
