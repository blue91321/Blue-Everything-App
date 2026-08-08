/**
 * Prove the recognisers work, without saying anything.
 *
 *   npm run voice-try -w @everything/agent
 *   npm run voice-try -w @everything/agent -- "i drank two waters"
 *
 * `voice-setup` answers "is the stack installed and is the microphone live".
 * This answers the next question — *does it actually recognise anything* —
 * which otherwise needs a person in the chair repeating a phrase at a log.
 *
 * Windows' own speech synthesiser writes the test audio, so this needs nothing
 * downloaded and no microphone. Synthetic speech is not a substitute for real
 * speech (it is cleaner, and it is not Blake's voice, so it proves nothing
 * about the speaker check) but it exercises every other link in the chain:
 * grammar construction, the 100ms block feed, `[unk]` handling, and the
 * transcript the server would receive.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchVoiceCommand, matchesWakeWord, spokenCount, type VoiceCandidate } from '@everything/shared';
import { ServerClient } from '../../../client.js';
import { SAMPLE_RATE } from '../mic.js';
import { createRecogniser } from '../vosk.js';

const workDir = mkdtempSync(join(tmpdir(), 'everything-voice-'));

/** Windows TTS straight to a 16kHz mono WAV — the format the models want. */
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
  // Canonical WAV from the synthesiser: 44-byte header, then raw samples.
  const body = buffer.subarray(44);
  return new Int16Array(body.buffer, body.byteOffset, Math.floor(body.byteLength / 2));
}

/** Feed in 100ms blocks, exactly as the live listener does. */
function recognise(samples: Int16Array, grammar: string[], withSpeaker = false) {
  const recogniser = createRecogniser(grammar, { withSpeaker });
  const block = SAMPLE_RATE / 10;

  let finished: ReturnType<typeof recogniser.accept> = null;
  for (let i = 0; i < samples.length && !finished; i += block) {
    finished = recogniser.accept(samples.subarray(i, Math.min(i + block, samples.length)));
  }

  const result = finished ?? recogniser.flush();
  recogniser.close();
  return result;
}

function say(text: string): Int16Array {
  const file = join(workDir, `${Buffer.from(text).toString('hex').slice(0, 16)}.wav`);
  synthesise(text, file);
  return pcm(file);
}

try {
  const client = new ServerClient();
  const config = await client.voiceConfig();
  const habits = await client.habits();

  const candidates: VoiceCandidate[] = habits
    .filter((habit) => habit.active && habit.voicePhrases.length > 0)
    .map((habit) => ({ id: habit.id, phrases: habit.voicePhrases }));

  console.log(`\nWake word:  "${config.wakeWord}"`);
  console.log(`Vocabulary: ${config.vocabulary.join(' ') || '(nothing — no habit has a phrase)'}\n`);

  /* The wake word, and something that isn't it. */
  console.log('Wake recogniser');
  const wake = recognise(say(config.wakeWord), [config.wakeWord], true);
  console.log(`  said the wake word        -> "${wake.text}"`);
  console.log(
    `  speaker embedding         -> ${wake.speaker ? `${wake.speaker.length} dimensions over ${wake.speakerFrames} frames` : 'NONE — is the speaker model installed?'}`
  );

  const decoy = recognise(say('the quarterly report is due on friday'), [config.wakeWord], true);
  console.log(`  said something unrelated  -> "${decoy.text}" ${decoy.text ? '<- SHOULD BE EMPTY' : '(correctly ignored)'}`);

  /* The command. */
  const phrase = process.argv[2] ?? candidates[0]?.phrases[0] ?? null;
  if (!phrase) {
    console.log('\nNo habit has a voice phrase yet, so there is no command to try.');
    console.log('Add one on the Habits screen, then run this again.\n');
  } else {
    console.log('\nCommand recogniser');
    const grammar = config.vocabulary.length > 0 ? [config.vocabulary.join(' ')] : [config.wakeWord];
    const heard = recognise(say(phrase), grammar);
    console.log(`  said "${phrase}"`);
    console.log(`  heard                     -> "${heard.text}"`);

    const match = matchVoiceCommand(heard.text, candidates);
    const habit = habits.find((h) => h.id === match?.id);
    console.log(
      `  would                     -> ${habit ? `tick off "${habit.name}" ${spokenCount(heard.text)}x (matched "${match!.phrase}")` : 'MATCH NOTHING'}`
    );

    const failed = [
      !matchesWakeWord(wake.text, config.wakeWord) && 'the wake word was not recognised',
      !wake.speaker && 'no speaker embedding was produced',
      decoy.text && 'unrelated speech triggered the wake word',
      !habit && 'the command matched no habit',
    ].filter(Boolean);

    console.log(failed.length ? `\nFAILED: ${failed.join('; ')}\n` : '\nThe whole chain works.\n');
    process.exitCode = failed.length ? 1 : 0;
  }
} catch (error) {
  console.error(`\nFAILED: ${(error as Error).message}\n`);
  process.exitCode = 1;
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
