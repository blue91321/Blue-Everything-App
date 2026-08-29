/**
 * The two things voice does *to* this machine, rather than to the database.
 *
 * ### This is a deliberate change to what the agent is
 *
 * The ground rule was "the agent is read-only about the system: it observes
 * windows and processes; it does not close, kill, or manipulate them." Sending
 * synthetic keystrokes plainly breaks that, and it was your explicit call —
 * but it is worth being honest that this file is the exception, and that it is
 * the most dangerous code in the project. A mis-heard phrase here does not add
 * a wrong row to a table; it presses keys into whatever window has focus.
 *
 * So the blast radius is bounded on every side available:
 *
 *  - only combinations stored as a command can fire; nothing free-form,
 *  - `parseHotkey` is an allow-list of keys and requires a modifier, so a
 *    single stray letter can never be sent,
 *  - only `http:` and `https:` URLs open, so the shell is never handed a
 *    `file:` path or a custom protocol handler,
 *  - a `launch` runs a path the *server* resolved from the games list, which
 *    the agent itself filled in by watching that executable run here — so what
 *    voice can start is bounded by what this machine has already started on its
 *    own, and the stored command holds a name rather than a path,
 *  - the speaker check, when enrolled, still gates everything, and
 *  - the vault remains entirely out of reach of voice.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import koffi from 'koffi';
import { isOpenableUrl, parseHotkey, type MediaAction } from '@everything/shared';
import { isLaunchUrl } from '@everything/shared/games';

const user32 = koffi.load('user32.dll');

/**
 * `keybd_event` rather than `SendInput`.
 *
 * SendInput is the modern call, but it takes a tagged union whose layout has to
 * be laid out by hand through koffi for a gain nobody here can measure.
 * `keybd_event` is deprecated and forwards to exactly the same place.
 */
const keybd_event = user32.func('void __stdcall keybd_event(uint8_t vk, uint8_t scan, uint32_t flags, uintptr_t extra)');

const KEYEVENTF_KEYUP = 0x0002;

/**
 * Virtual-key codes for everything `HOTKEY_KEYS` allows.
 *
 * Exported because `hotkeys.ts` registers the same spellings system-wide, and a
 * second copy of this table is one nobody would think to keep in step.
 */
export const VK: Record<string, number> = {
  ctrl: 0x11, control: 0x11, alt: 0x12, shift: 0x10, win: 0x5b, super: 0x5b, meta: 0x5b,
  space: 0x20, enter: 0x0d, tab: 0x09, escape: 0x1b, backspace: 0x08, delete: 0x2e,
  insert: 0x2d, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  minus: 0xbd, plus: 0xbb, comma: 0xbc, period: 0xbe,
};

for (let i = 0; i < 26; i++) VK[String.fromCharCode(97 + i)] = 0x41 + i; // a-z
for (let i = 0; i < 10; i++) VK[String(i)] = 0x30 + i; // 0-9
for (let i = 1; i <= 12; i++) VK[`f${i}`] = 0x6f + i; // F1-F12

/**
 * The system media keys.
 *
 * Chosen over a `hotkey` command because these are handled by Windows itself
 * and routed to whatever owns playback — the media app does not need to be
 * focused, which is the entire point when the thing playing is behind a game.
 */
const MEDIA_VK: Record<MediaAction, number> = {
  playpause: 0xb3,
  next: 0xb0,
  previous: 0xb1,
  stop: 0xb2,
  volumeup: 0xaf,
  volumedown: 0xae,
  mute: 0xad,
};

/**
 * One press moves Windows' volume by about two percent, which is not what
 * anyone means by "volume up". Five is a step you can actually hear.
 */
const VOLUME_PRESSES = 5;

export class ActionRefused extends Error {}

/** Press a media key. Global — no window needs focus. */
export function pressMediaKey(action: string): void {
  const code = MEDIA_VK[action as MediaAction];
  if (code === undefined) throw new ActionRefused(`"${action}" is not a media control`);

  const presses = action === 'volumeup' || action === 'volumedown' ? VOLUME_PRESSES : 1;
  for (let i = 0; i < presses; i++) {
    keybd_event(code, 0, 0, 0);
    keybd_event(code, 0, KEYEVENTF_KEYUP, 0);
  }
}

/**
 * Press a combination into whatever window is focused.
 *
 * Modifiers go down in order and come up in reverse, which is what the
 * receiving window expects — releasing Ctrl before the letter would deliver a
 * bare keystroke to anything watching for one.
 */
export function pressKeys(combo: string): void {
  const hotkey = parseHotkey(combo);
  if (!hotkey) throw new ActionRefused(`"${combo}" is not a key combination this will send`);

  const codes = [...hotkey.modifiers, hotkey.key].map((name) => {
    const code = VK[name];
    if (code === undefined) throw new ActionRefused(`no virtual-key code for "${name}"`);
    return code;
  });

  for (const code of codes) keybd_event(code, 0, 0, 0);
  for (const code of [...codes].reverse()) keybd_event(code, 0, KEYEVENTF_KEYUP, 0);
}

/**
 * Open a URL in the default browser.
 *
 * `shell: false` and the URL passed as its own argument, so nothing in it is
 * ever parsed as a command. The empty string before it is `start`'s title
 * argument — without it, a URL in quotes is taken as the window title and
 * nothing opens, which is a memorably silly way to lose an afternoon.
 */
export function openUrl(url: string): void {
  if (!isOpenableUrl(url)) throw new ActionRefused(`refusing to open "${url}" — only http and https`);
  spawn('cmd.exe', ['/c', 'start', '', url], { windowsHide: true, stdio: 'ignore', detached: true }).unref();
}

/**
 * Start a program that the games list already knows about.
 *
 * The path arrives resolved, because only the server can read the row it comes
 * from — but this end checks it too, since these are two different claims and
 * they are the same check only while both are right. The server's is about the
 * list; this one is about the disk, and the disk is what is about to be handed
 * to the shell.
 *
 * `cmd /c start` rather than spawning it directly, for the reason the tray
 * menu, the restart button and the Run button all learned: the child has to
 * outlive the agent, and `detached` alone on Windows means DETACHED_PROCESS,
 * which leaves a program with no console host. The working directory is the
 * game's own folder, because plenty of them look for files beside themselves.
 */
export function launchProgram(target: { path?: string; url?: string }, name: string): void {
  /*
   * A `steam://` address, when the games list has one.
   *
   * **This is the one place the shell is handed a protocol other than http.**
   * `openUrl` refuses everything but http and https precisely so a registered
   * handler is never invoked with an argument we did not write — and a Steam
   * game genuinely cannot be started any other way, since running its
   * executable answers "start warframe from launcher" and quits.
   *
   * So the exception is a *shape* rather than a scheme: `isLaunchUrl` allows
   * `steam://rungameid/<digits>` and nothing else — no query, no fragment, no
   * second segment. `steam://` can install, uninstall and open pages in its own
   * browser, and the digits are what keep this to "start the game I named".
   */
  if (target.url) {
    if (!isLaunchUrl(target.url)) {
      throw new ActionRefused(`refusing to open "${target.url}" — not a game address`);
    }
    spawn('cmd.exe', ['/c', 'start', '', target.url], {
      windowsHide: true,
      stdio: 'ignore',
      detached: true,
    }).unref();
    return;
  }

  const path = target.path ?? '';
  // Not a normalisation — a refusal. A resolved path is absolute and ends in
  // `.exe`, and anything else means something upstream is not what it claims.
  if (!path || !path.toLowerCase().endsWith('.exe') || !path.includes(String.fromCharCode(92))) {
    throw new ActionRefused(`refusing to start "${name}" — that is not a program path`);
  }
  if (!existsSync(path)) throw new ActionRefused(`${name} is not where it used to be`);

  spawn('cmd.exe', ['/c', 'start', '', path], {
    cwd: dirname(path),
    windowsHide: true,
    stdio: 'ignore',
    detached: true,
  }).unref();
}
