/**
 * What does one sensor poll actually cost?
 *
 * The agent runs forever on Blake's gaming PC, so "it's only a few
 * milliseconds" needs to be a measurement, not an assumption — especially the
 * full process snapshot, which walks every process on the machine.
 *
 *   npm run bench -w @everything/agent
 */
import { getForegroundWindow, getIdleMs, getNotificationState, listProcessNames, processIsAlive } from './win32.js';
import { audioRecentlyPlaying } from './audio.js';

function time(label: string, iterations: number, fn: () => unknown): number {
  fn(); // warm up, so we don't measure koffi's first-call setup
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  const each = elapsedMs / iterations;
  console.log(`  ${label.padEnd(34)} ${each.toFixed(3)} ms/call`);
  return each;
}

console.log(`\nprocesses on this machine: ${listProcessNames().size}\n`);

const foreground = time('getForegroundWindow()', 200, getForegroundWindow);
const idle = time('getIdleMs()', 200, getIdleMs);
const notify = time('getNotificationState()', 200, getNotificationState);

const somePid = process.pid;
const alive = time('processIsAlive(pid)', 200, () => processIsAlive(somePid));
const audio = time('audioRecentlyPlaying()', 200, audioRecentlyPlaying);
const snapshot = time('listProcessNames()  [expensive]', 50, listProcessNames);

const cheap = foreground + idle + notify + alive + audio;
const full = cheap + snapshot;

console.log(`\n  cheap poll  ${cheap.toFixed(3)} ms`);
console.log(`  full poll   ${full.toFixed(3)} ms   (${(snapshot / full * 100).toFixed(0)}% is the process snapshot)`);

const duty = (ms: number, intervalMs: number) => ((ms / intervalMs) * 100).toFixed(4);
console.log('\nsustained CPU of one core:');
console.log(`  full poll every 2s     ${duty(full, 2000)}%   <- the naive version`);
console.log(`  full poll every 10s    ${duty(full, 10_000)}%`);
console.log(`  cheap poll every 5s    ${duty(cheap, 5000)}%   <- in-game ticks`);
console.log(`  cheap poll every 15s   ${duty(cheap, 15_000)}%  <- idle desktop ticks\n`);
