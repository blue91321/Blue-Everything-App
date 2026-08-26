/**
 * What confidence does the decoder put on the wake word, and does it separate?
 *
 *   npm run wake-confidence -w @everything/agent
 *
 * A closed grammar has to map every sound onto something it contains, so when
 * somebody says a word that is not in it — a dog called Harley — the decoder
 * still answers with the nearest thing it is allowed to say. `[unk]` is meant to
 * absorb those and often does not.
 *
 * The question this answers is whether the decoder *knows*: whether a forced
 * match scores lower than a real one by enough to be worth gating on. If the
 * two overlap, a threshold would only trade false wakes for missed ones and is
 * not worth having.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchesWakeWord } from '@everything/shared';
import { SAMPLE_RATE } from '../mic.js';
import { createRecogniser } from '../vosk.js';

const WAKE = process.env.WAKE_WORD || 'hey jarvis';
const BLOCK = SAMPLE_RATE / 10;

/** Said to the app. These must keep working. */
const REAL = ['hey jarvis', 'jarvis', 'hey jarvis what is the weather', 'jarvis drink water'];

/** Not said to the app. None of these should be heard as the wake word. */
const IMPOSTORS = [
  'harley',
  'harley come here',
  'where did harley go',
  'harvest festival is on the weekend',
  'charlie',
  'jarvis is not here',
  'marcus',
  'harvey',
  'darling',
  'car keys',
];

const workDir = mkdtempSync(join(tmpdir(), 'everything-conf-'));

function synthesise(text: string, file: string, rate = 0): void {
  const script = `
    Add-Type -AssemblyName System.Speech
    $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(${SAMPLE_RATE}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $s.Rate = ${rate}
    $s.SetOutputToWaveFile('${file}', $fmt)
    $s.Speak('${text.replace(/'/g, "''")}')
    $s.Dispose()`;
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' });
}

/** Skips the 44-byte WAV header — the synthesiser writes a plain PCM file. */
function samplesOf(file: string): Int16Array {
  const buf = readFileSync(file);
  return new Int16Array(buf.buffer, buf.byteOffset + 44, Math.floor((buf.length - 44) / 2));
}

interface Heard {
  text: string;
  /** The lowest confidence among the words, which is the one that matters. */
  lowest: number;
  words: string;
}

function listen(samples: Int16Array, grammar: string[]): Heard {
  const rec = createRecogniser(grammar, { withWords: true });
  try {
    /*
     * `accept` returns the utterance the moment Vosk decides the speaker
     * stopped, which for a two-word phrase is well before the audio runs out.
     * Reading only `flush()` at the end therefore found nothing at all — the
     * result had already been handed over and consumed.
     */
    let final = null as ReturnType<typeof rec.flush> | null;
    for (let at = 0; at + BLOCK <= samples.length && !final; at += BLOCK) {
      final = rec.accept(samples.subarray(at, at + BLOCK));
    }
    final = final ?? rec.flush();
    const lowest = final.words.length === 0 ? 0 : Math.min(...final.words.map((w) => w.confidence));
    return {
      text: final.text,
      lowest,
      words: final.words.map((w) => `${w.word}:${w.confidence.toFixed(2)}`).join(' '),
    };
  } finally {
    rec.close();
  }
}

console.log(`\nwake word: "${WAKE}"`);
console.log('does the decoder score a forced match lower than a real one?\n');

const realScores: number[] = [];
const impostorScores: number[] = [];

try {
  for (const [label, lines, keep] of [
    ['SAID TO IT', REAL, realScores],
    ['NOT SAID TO IT', IMPOSTORS, impostorScores],
  ] as const) {
    console.log(`  ${label}`);
    for (const line of lines) {
      const file = join(workDir, `${Buffer.from(line).toString('hex').slice(0, 20)}.wav`);
      synthesise(line, file);
      const heard = listen(samplesOf(file), [WAKE]);
      const matched = matchesWakeWord(heard.text, WAKE);
      if (matched) keep.push(heard.lowest);
      console.log(
        `    ${matched ? 'WAKES' : '  .  '}  conf=${matched ? heard.lowest.toFixed(2) : ' -- '}  "${line}"` +
          (heard.words ? `   [${heard.words}]` : '')
      );
    }
    console.log('');
  }

  const lowestReal = realScores.length ? Math.min(...realScores) : NaN;
  const highestImpostor = impostorScores.length ? Math.max(...impostorScores) : NaN;

  console.log(`  real wakes        : ${realScores.length}/${REAL.length}, lowest confidence ${realScores.length ? lowestReal.toFixed(2) : '—'}`);
  console.log(`  false wakes       : ${impostorScores.length}/${IMPOSTORS.length}${impostorScores.length ? `, highest confidence ${highestImpostor.toFixed(2)}` : ''}`);

  if (impostorScores.length === 0) {
    console.log('\n  Nothing false fired, so this run says nothing about a threshold.');
  } else if (highestImpostor < lowestReal) {
    console.log(`\n  \x1b[32mSeparable.\x1b[0m A threshold between ${highestImpostor.toFixed(2)} and ${lowestReal.toFixed(2)} rejects every false wake here and keeps every real one.`);
  } else {
    console.log('\n  \x1b[33mThey overlap.\x1b[0m A confidence gate alone would trade false wakes for missed ones.');
  }

  /*
   * The other lever, and the one the measurement above says is the only real
   * one: give the decoder somewhere better to put the sound.
   *
   * A grammar of one phrase plus `[unk]` has to answer every noise with one of
   * two things, and `[unk]` is a weak competitor. Adding words that are *not*
   * the wake word gives a near-miss a home of its own, and the decoder takes it
   * because it is a genuinely better acoustic match.
   */
  const DECOYS = ['harley', 'harvest', 'festival', 'charlie', 'harvey', 'marcus', 'darling', 'car keys'];
  console.log('  WITH DECOY WORDS IN THE GRAMMAR');
  let stillFalse = 0;
  for (const line of IMPOSTORS) {
    const file = join(workDir, `d${Buffer.from(line).toString('hex').slice(0, 18)}.wav`);
    synthesise(line, file);
    const heard = listen(samplesOf(file), [WAKE, ...DECOYS]);
    const matched = matchesWakeWord(heard.text, WAKE);
    if (matched) stillFalse += 1;
    console.log(`    ${matched ? 'WAKES' : '  .  '}  "${line}"   heard: "${heard.text}"`);
  }
  console.log('');
  console.log('  AND THE REAL THING MUST STILL WORK');
  let stillReal = 0;
  for (const line of REAL) {
    const file = join(workDir, `r${Buffer.from(line).toString('hex').slice(0, 18)}.wav`);
    synthesise(line, file);
    const heard = listen(samplesOf(file), [WAKE, ...DECOYS]);
    const matched = matchesWakeWord(heard.text, WAKE);
    if (matched) stillReal += 1;
    console.log(`    ${matched ? 'wakes' : 'MISSES'}  "${line}"   heard: "${heard.text}"`);
  }
  console.log('');
  console.log(`  false wakes: ${impostorScores.length}/${IMPOSTORS.length} without decoys -> ${stillFalse}/${IMPOSTORS.length} with`);
  console.log(`  real wakes : ${realScores.length}/${REAL.length} without decoys -> ${stillReal}/${REAL.length} with`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
console.log('');
