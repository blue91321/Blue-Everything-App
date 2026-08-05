/**
 * Live readout of the attention monitor. Run it, then go play a game and come
 * back — every state change and stopping point is printed with a timestamp.
 *
 *   npm run sensor
 */
import { AttentionMonitor, type AttentionSnapshot } from './attention.js';

const clock = (d: Date) => d.toLocaleTimeString('en-US', { hour12: false });
const badge: Record<string, string> = {
  free: '\x1b[32mFREE    \x1b[0m',
  'in-game': '\x1b[31mIN-GAME \x1b[0m',
  focused: '\x1b[33mFOCUSED \x1b[0m',
  away: '\x1b[90mAWAY    \x1b[0m',
};

const monitor = new AttentionMonitor({ pollMs: 2000 });

const describe = (s: AttentionSnapshot) =>
  `${badge[s.state]} ${s.reason}` +
  (s.foreground ? `\n           foreground: ${s.foreground.exe} — "${s.foreground.title.slice(0, 60)}"` : '') +
  `\n           idle ${Math.round(s.idleMs / 1000)}s`;

monitor.on('change', (snapshot, from) => {
  console.log(`\n[${clock(snapshot.at)}] ${from} -> ${snapshot.state}`);
  console.log(`           ${describe(snapshot)}`);
});

monitor.on('stopping-point', (sp) => {
  const colour = sp.quality === 'prime' ? '\x1b[1;92m' : '\x1b[92m';
  console.log(`${colour}  >> STOPPING POINT (${sp.quality}): ${sp.reason} — nudges would fire now\x1b[0m`);
});

monitor.on('unknown-fullscreen-app', (exe) => {
  console.log(`\x1b[36m  ?? ${exe} held exclusive fullscreen but isn't in games.ts — consider adding it\x1b[0m`);
});

monitor.start();

const first = monitor.current;
if (first) {
  console.log('Attention sensor running. Ctrl+C to stop.\n');
  console.log(`[${clock(first.at)}] initial state`);
  console.log(`           ${describe(first)}`);
  console.log(`           live games: ${first.liveGames.length ? first.liveGames.join(', ') : '(none)'}`);
} else {
  console.log('Could not read the foreground window — is this running on Windows?');
}

const shutdown = () => {
  monitor.stop();
  console.log('\nstopped.');
  process.exit(0);
};

process.on('SIGINT', shutdown);

// `npm run sensor -- --seconds 30` for a bounded run instead of Ctrl+C.
const secondsFlag = process.argv.indexOf('--seconds');
if (secondsFlag !== -1) {
  const seconds = Number(process.argv[secondsFlag + 1]);
  if (Number.isFinite(seconds)) setTimeout(shutdown, seconds * 1000);
}
