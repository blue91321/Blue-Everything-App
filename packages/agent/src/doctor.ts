/**
 * Sanity check for the Win32 layer. If the sensor ever goes quiet, run this
 * first to tell "nothing is happening" apart from "a syscall is failing".
 *
 *   npm run doctor -w @everything/agent
 */
import { getForegroundWindow, getIdleMs, getNotificationState, listProcessNames, notificationStateName } from './win32.js';
import { GAME_PROCESSES, LAUNCHER_PROCESSES } from './games.js';
import { audioRecentlyPlaying } from './audio.js';
import { AWAY_FROM_PC_IDLE_MS, isAwayFromPc } from '@everything/shared';

const processes = listProcessNames();
const foreground = getForegroundWindow();

console.log('processes visible:  ', processes.size);
console.log('foreground window:  ', foreground ? `${foreground.exe} (pid ${foreground.pid})` : 'FAILED');
console.log('  title:            ', foreground?.title || '(none)');
console.log('  exe path:         ', foreground?.exePath || 'FAILED');
console.log('  fullscreen:       ', foreground?.isFullScreen);
const idleMs = getIdleMs();
console.log('idle:               ', `${Math.round(idleMs / 1000)}s`);
console.log('notification state: ', notificationStateName(getNotificationState()));

const audio = audioRecentlyPlaying();
console.log('audio meter:        ', audio.available ? `peak ${audio.peak.toFixed(4)}` : 'UNAVAILABLE');
console.log('sound recently:     ', audio.playing ? 'yes' : 'no');
console.log(
  'away from the PC:   ',
  isAwayFromPc({ idleMs, audioPlaying: audio.playing })
    ? 'yes — phone nudges would be allowed'
    : `no — needs ${AWAY_FROM_PC_IDLE_MS / 60_000}m idle and silence`
);

const games = [...GAME_PROCESSES].filter((p) => processes.has(p));
const launchers = [...LAUNCHER_PROCESSES].filter((p) => processes.has(p));
console.log('games running:      ', games.length ? games.join(', ') : '(none)');
console.log('launchers running:  ', launchers.length ? launchers.join(', ') : '(none)');

const failures = [
  processes.size < 10 && 'process enumeration returned almost nothing',
  !foreground && 'could not read the foreground window',
  foreground && !foreground.exePath && 'could not resolve the foreground exe path',
].filter(Boolean);

console.log(failures.length ? `\nFAILED: ${failures.join('; ')}` : '\nAll Win32 calls healthy.');
