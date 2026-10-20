/**
 * Is the voice stack actually installed and working?
 *
 * Same job as `doctor.ts` does for the Win32 layer: tell "nothing was said"
 * apart from "the microphone never opened". Voice fails silently by nature —
 * an always-on listener that isn't listening looks exactly like a quiet room —
 * so there has to be one command that answers it.
 *
 *   npm run voice-setup -w @everything/agent
 *
 * Fetches the models if they are missing, through the same function the agent
 * uses when voice is first switched on, so the two cannot disagree about what
 * "installed" means.
 */
import { listMicrophones, openMicrophone, rms, SAMPLE_RATE } from '../mic.js';
import { createWakeSpotter, missingModels, speakerModelAvailable, toFloat } from '../engine.js';
import { downloadModels, modelsNeeded, removeOldVosk } from '../models.js';
import { voiceModelPaths } from '../voice-paths.js';

const paths = voiceModelPaths();
const ok = (label: string, value: string) => console.log(`  ${label.padEnd(22)}${value}`);

console.log(`\nModels directory: ${paths.root}\n`);

if (modelsNeeded()) {
  console.log('Fetching the speech models (about 100MB, once)…');
  let last = '';
  try {
    await downloadModels((progress) => {
      const line = `  ${progress.what}: ${Math.round((progress.done / progress.total) * 100)}%`;
      if (line !== last) process.stdout.write(`\r${line.padEnd(70)}`);
      last = line;
    });
    console.log('\n');
  } catch (error) {
    console.error(`\n\nFAILED: ${(error as Error).message}\n`);
    process.exit(1);
  }
}

const removed = removeOldVosk();
if (removed.length) console.log(`Removed what Vosk left behind: ${removed.join(', ')}\n`);

const missing = missingModels();
ok('wake word spotter', missing.some((f) => f.startsWith(paths.wake.dir)) ? 'MISSING' : 'found');
ok('command recogniser', missing.some((f) => f.startsWith(paths.command.dir)) ? 'MISSING' : 'found');
ok('speaker model', speakerModelAvailable() ? 'found' : 'missing — "only my voice" will be unavailable');
if (missing.length) {
  console.error(`\nFAILED: still missing ${missing.join(', ')}\n`);
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
console.log('  The default input is used unless one is picked on the Voice screen.');

/* ------------------------------------------------------------------ */

console.log('\nLoading the wake word spotter…');
const started = Date.now();
let spotter;
try {
  spotter = createWakeSpotter(['hey jarvis', 'jarvis']);
} catch (error) {
  console.error(`\nFAILED: ${(error as Error).message}\n`);
  process.exit(1);
}
console.log(`  loaded in ${Date.now() - started}ms`);

/* ------------------------------------------------------------------ */

console.log('\nOpening the microphone for 3 seconds — say "hey jarvis".');

let mic;
try {
  mic = openMicrophone();
} catch (error) {
  console.error(`\nFAILED: ${(error as Error).message}`);
  process.exit(1);
}

let peak = 0;
let blocks = 0;
let spottingMs = 0;
let heard: string | null = null;

const timer = setInterval(() => {
  const samples = mic.read();
  if (samples.length === 0) return;

  blocks++;
  peak = Math.max(peak, rms(samples));

  const before = process.hrtime.bigint();
  const hit = spotter.accept(toFloat(samples));
  spottingMs += Number(process.hrtime.bigint() - before) / 1e6;
  if (hit) heard = hit.phrase;
}, 100);

setTimeout(() => {
  clearInterval(timer);
  mic.close();

  // A live microphone in a quiet room reads a small non-zero level; a dead one
  // reads exactly 0.
  const level =
    peak < 0.0005
      ? '  <- no signal at all; wrong device, or muted'
      : peak < 0.02
        ? '  (room tone — say something to see this rise)'
        : '  (speech)';

  console.log(`\n  blocks captured      ${blocks} (expected ~30 at ${SAMPLE_RATE}Hz)`);
  console.log(`  loudest             ${peak.toFixed(4)}${level}`);
  console.log(`  spotting cost       ${(spottingMs / Math.max(blocks, 1)).toFixed(2)}ms per 100ms block`);
  console.log(`  heard               ${heard ? `"${heard}"` : '(not the wake word — expected unless you said it)'}`);

  const failures = [
    blocks === 0 && 'no audio arrived from the microphone at all',
    blocks > 0 && peak < 0.0005 && 'the microphone is open but returning silence',
  ].filter(Boolean);

  console.log(failures.length ? `\nFAILED: ${failures.join('; ')}\n` : '\nVoice stack healthy.\n');
  process.exit(failures.length ? 1 : 0);
}, 3000);
