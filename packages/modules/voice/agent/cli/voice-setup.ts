/**
 * Is the voice stack actually installed and working?
 *
 * Same job as `doctor.ts` does for the Win32 layer: tell "nothing was said"
 * apart from "the microphone never opened". Voice fails silently by nature —
 * an always-on listener that isn't listening looks exactly like a quiet room —
 * so there has to be one command that answers it.
 *
 *   npm run voice-setup -w @everything/agent
 */
import { existsSync, statSync } from 'node:fs';
import { listMicrophones, openMicrophone, rms, SAMPLE_RATE } from '../mic.js';
import { createRecogniser, speakerModelAvailable, VoskUnavailable } from '../vosk.js';
import { VOICE_DOWNLOADS, voiceModelPaths } from '../voice-paths.js';

const paths = voiceModelPaths();
const ok = (label: string, value: string) => console.log(`  ${label.padEnd(22)}${value}`);

console.log(`\nModels directory: ${paths.root}\n`);

const present = {
  library: existsSync(paths.library),
  speech: existsSync(paths.speechModel) && statSync(paths.speechModel).isDirectory(),
  speaker: speakerModelAvailable(),
};

ok('libvosk.dll', present.library ? 'found' : 'MISSING');
ok('speech model', present.speech ? 'found' : 'MISSING');
ok('speaker model', present.speaker ? 'found' : 'missing — "only my voice" will be unavailable');

if (!present.library || !present.speech) {
  console.log('\nVoice needs three downloads. None of them are in git — they are');
  console.log('third-party binaries, and this repo keeps its own history clean.\n');

  for (const item of VOICE_DOWNLOADS) {
    console.log(`  ${item.what}  (${item.size})`);
    console.log(`    ${item.url}`);
    console.log(`    unpack: ${item.unpackTo}\n`);
  }

  console.log(`Everything goes under ${paths.root}`);
  console.log('Then run this command again.\n');
  process.exit(1);
}

/* ------------------------------------------------------------------ */

console.log('\nMicrophones Windows can see:');
const devices = listMicrophones();
if (devices.length === 0) {
  console.log('  (none — voice cannot work without one)');
} else {
  for (const device of devices) console.log(`  [${device.id}] ${device.name} (${device.channels}ch)`);
}
console.log('  The default input is used; change it in Windows sound settings.');

/* ------------------------------------------------------------------ */

console.log('\nLoading the speech model…');
const started = Date.now();
let recogniser;
try {
  recogniser = createRecogniser(['hey everything'], { withSpeaker: true });
} catch (error) {
  console.error(`\nFAILED: ${(error as Error).message}`);
  if (error instanceof VoskUnavailable) {
    console.error('\nThe files are present but could not be loaded. The usual cause is an');
    console.error('architecture mismatch — this needs the win64 build of vosk.');
  }
  process.exit(1);
}
console.log(`  loaded in ${((Date.now() - started) / 1000).toFixed(1)}s`);

/* ------------------------------------------------------------------ */

console.log('\nOpening the microphone for 3 seconds — say something.');

let mic;
try {
  mic = openMicrophone();
} catch (error) {
  console.error(`\nFAILED: ${(error as Error).message}`);
  process.exit(1);
}

let peak = 0;
let blocks = 0;
let recognitionMs = 0;

const timer = setInterval(() => {
  const samples = mic.read();
  if (samples.length === 0) return;

  blocks++;
  peak = Math.max(peak, rms(samples));

  const before = process.hrtime.bigint();
  recogniser.accept(samples);
  recognitionMs += Number(process.hrtime.bigint() - before) / 1e6;
}, 100);

setTimeout(() => {
  clearInterval(timer);
  const heard = recogniser.flush();
  mic.close();
  recogniser.close();

  // A live microphone in a quiet room reads a small non-zero level; a dead one
  // reads exactly 0. Reporting "is the right mic default?" for anything below
  // speech conflates "nobody spoke" with "wrong device", which sends you to
  // Windows sound settings to fix something that was never broken.
  const level =
    peak < 0.0005
      ? '  <- no signal at all; wrong device, or muted'
      : peak < 0.02
        ? '  (room tone — say something to see this rise)'
        : '  (speech)';

  console.log(`\n  blocks captured      ${blocks} (expected ~30 at ${SAMPLE_RATE}Hz)`);
  console.log(`  loudest             ${peak.toFixed(4)}${level}`);
  console.log(`  recognition cost    ${(recognitionMs / Math.max(blocks, 1)).toFixed(2)}ms per 100ms block`);
  console.log(`  heard               ${heard.text || '(nothing on-grammar — expected unless you said the wake word)'}`);
  console.log(`  speaker embedding   ${heard.speaker ? `${heard.speaker.length} dimensions` : 'none (needs a few seconds of speech)'}`);

  const failures = [
    blocks === 0 && 'no audio arrived from the microphone at all',
    blocks > 0 && peak < 0.0005 && 'the microphone is open but returning silence',
  ].filter(Boolean);

  console.log(failures.length ? `\nFAILED: ${failures.join('; ')}\n` : '\nVoice stack healthy.\n');
  process.exit(failures.length ? 1 : 0);
}, 3000);
