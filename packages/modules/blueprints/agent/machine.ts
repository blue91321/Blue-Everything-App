/**
 * The rest of what a blueprint does on the PC: open a website, press a media
 * key, start a game. Moved here from `voice/agent/actions.ts` when voice's
 * commands became blueprints (2026-10-29), with the guards they had there:
 *
 *  - **only http and https open**, so the shell is never handed a `file:` path
 *    or somebody's protocol handler;
 *  - **a game is started from what the server resolved off the games list**,
 *    which this agent filled in by watching it run here: a path that is an
 *    existing `.exe`, or a `steam://rungameid/<digits>` address and nothing
 *    else, since `steam://` can also install and uninstall;
 *  - **a media key is not sent when nothing is playing**, so "skip" heard in a
 *    silent room skips nothing you would not notice was skipped. An output
 *    meter that cannot be read is not a yes.
 *
 * **Opened by `ShellExecuteW`, never through `cmd`** (2026-11-11). It was
 * `cmd /c start "" <address>`, and cmd reads `&`, `|`, `<`, `>` and `^` as its
 * own wherever they are not inside quotes. Node quotes an argument only when it
 * has a space in it, and an address never does, so
 * `https://example.com/?a=1&<any command>` passed the http-only check and ran
 * the command after it. A blueprint can arrive as somebody else's picture,
 * where this box reads as "opens websites". `ShellExecuteW` is what `start`
 * calls underneath, with no command line to parse, and what it starts is the
 * shell's rather than a child of the agent, so it outlives it as before.
 */
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import koffi from 'koffi';
import { isOpenableUrl } from '@everything/shared';
import { isLaunchUrl } from '@everything/shared/games';
import { mediaIsPlaying } from '../../../agent/src/audio.js';

const user32 = koffi.load('user32.dll');
const keybdEvent = user32.func('void __stdcall keybd_event(uint8_t vk, uint8_t scan, uint32_t flags, uintptr_t extra)');
const KEYEVENTF_KEYUP = 0x0002;
const shell32 = koffi.load('shell32.dll');
const shellExecute = shell32.func(
  'intptr_t __stdcall ShellExecuteW(void *hwnd, str16 verb, str16 file, str16 parameters, str16 directory, int show)'
);
const SW_SHOWNORMAL = 1;

/** Handled by Windows and routed to whatever owns playback, so nothing needs focus. */
const MEDIA_VK: Record<string, number> = {
  playpause: 0xb3,
  next: 0xb0,
  previous: 0xb1,
  stop: 0xb2,
  volumeup: 0xaf,
  volumedown: 0xae,
  mute: 0xad,
};

/** One press moves the volume about two percent; five is a step you can hear. */
const VOLUME_PRESSES = 5;

/** Opens an address or starts a program as Explorer would. Exported for `blueprints-check`'s probe. */
export function start(target: string, cwd?: string, show = SW_SHOWNORMAL): void {
  // Above 32 is success; anything else is one of the shell's error codes.
  const result = Number(shellExecute(null, 'open', target, null, cwd ?? null, show));
  if (result <= 32) throw new Error(`Windows would not open it (error ${result})`);
}

export function openUrl(url: string): void {
  if (!isOpenableUrl(url)) throw new Error(`refusing to open "${url}": only http and https`);
  start(url);
}

export function pressMediaKey(action: string): void {
  const code = MEDIA_VK[action];
  if (code === undefined) throw new Error(`"${action}" is not a media key`);
  let playing = false;
  try {
    playing = mediaIsPlaying();
  } catch {
    // No sound card, or COM refused: not a yes.
  }
  if (!playing) throw new Error('Nothing is playing, so it was not sent');
  const presses = action === 'volumeup' || action === 'volumedown' ? VOLUME_PRESSES : 1;
  for (let i = 0; i < presses; i++) {
    keybdEvent(code, 0, 0, 0);
    keybdEvent(code, 0, KEYEVENTF_KEYUP, 0);
  }
}

export function launch(target: { path?: string; url?: string; name: string }): void {
  if (target.url) {
    if (!isLaunchUrl(target.url)) throw new Error(`refusing to open "${target.url}": not a game address`);
    start(target.url);
    return;
  }
  const path = target.path ?? '';
  // A refusal, not a tidy-up: a resolved path is absolute and ends in .exe, and
  // anything else means something upstream is not what it claims.
  if (!path.toLowerCase().endsWith('.exe') || !path.includes(String.fromCharCode(92))) {
    throw new Error(`refusing to start "${target.name}": that is not a program path`);
  }
  if (!existsSync(path)) throw new Error(`${target.name} is not where it used to be`);
  // Its own folder as the working directory: plenty of games look beside themselves.
  start(path, dirname(path));
}
