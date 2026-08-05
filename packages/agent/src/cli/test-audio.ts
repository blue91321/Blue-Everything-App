/**
 * Checks the audio meter, which is what tells "away from the desk" apart from
 * "watching a video". Without it the phone would buzz every time a film ran
 * longer than fifteen minutes.
 *
 *   npm run audio -w @everything/agent
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readAudio, SILENCE_THRESHOLD } from '../audio.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function measure(ms: number): Promise<{ min: number; max: number; distinct: number }> {
  const until = Date.now() + ms;
  const seen = new Set<number>();
  let min = Infinity;
  let max = 0;
  while (Date.now() < until) {
    const { peak } = readAudio();
    seen.add(peak);
    min = Math.min(min, peak);
    max = Math.max(max, peak);
    await sleep(40);
  }
  return { min: min === Infinity ? 0 : min, max, distinct: seen.size };
}

if (!readAudio().available) {
  console.error('FAILED: could not open the audio meter.');
  process.exit(1);
}
console.log('meter opened.\n');

console.log('sampling current output for 3s...');
const now = await measure(3000);
console.log(`  min ${now.min.toFixed(6)}   max ${now.max.toFixed(6)}   distinct readings: ${now.distinct}`);

const playingNow = now.max > SILENCE_THRESHOLD;
console.log(playingNow ? '  -> sound IS playing on this PC right now.' : '  -> this PC is silent.');

// A stuck value would read identically forever and be worse than useless: it
// would either block every push or let them all through.
const live = now.distinct > 1;
console.log(`  -> meter is ${live ? 'live (values change)' : 'SUSPECT (identical every sample)'}`);

let rises = true;
if (!playingNow) {
  const wav = ['C:\\Windows\\Media\\Alarm01.wav', 'C:\\Windows\\Media\\notify.wav'].find(existsSync);
  if (wav) {
    console.log(`\nplaying ${wav} to confirm it rises...`);
    const player = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `$p = New-Object System.Media.SoundPlayer '${wav}'; $p.PlayLooping(); Start-Sleep -Seconds 5; $p.Stop()`],
      { windowsHide: true, stdio: 'ignore' }
    );
    await sleep(700);
    const loud = await measure(3500);
    player.kill();
    rises = loud.max > SILENCE_THRESHOLD;
    console.log(`  peak while playing: ${loud.max.toFixed(6)} -> ${rises ? 'detected' : 'NOT DETECTED'}`);
  }
} else {
  console.log('\nSomething is already playing, so the "rises when sound starts" case is');
  console.log('already demonstrated. Stop all audio and re-run to see the silent case.');
}

const ok = live && rises;
console.log(
  ok
    ? '\nPASS: the meter reflects real output — safe to gate phone pushes on it.'
    : '\nFAIL: do not trust this for away detection.'
);
process.exit(ok ? 0 : 1);
