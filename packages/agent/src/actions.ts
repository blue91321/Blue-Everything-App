/**
 * The two things voice does *to* this machine, rather than to the database.
 *
 * ### This is a deliberate change to what the agent is
 *
 * The ground rule was "the agent is read-only about the system: it observes
 * windows and processes; it does not close, kill, or manipulate them." Sending
 * synthetic keystrokes plainly breaks that, and it was Blake's explicit call —
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
 *  - the speaker check, when enrolled, still gates everything, and
 *  - the vault remains entirely out of reach of voice.
 */
import { spawn } from 'node:child_process';
import koffi from 'koffi';
import { isOpenableUrl, parseHotkey } from '@everything/shared';

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

/** Virtual-key codes for everything `HOTKEY_KEYS` allows. */
const VK: Record<string, number> = {
  ctrl: 0x11, control: 0x11, alt: 0x12, shift: 0x10, win: 0x5b, super: 0x5b, meta: 0x5b,
  space: 0x20, enter: 0x0d, tab: 0x09, escape: 0x1b, backspace: 0x08, delete: 0x2e,
  insert: 0x2d, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  minus: 0xbd, plus: 0xbb, comma: 0xbc, period: 0xbe,
};

for (let i = 0; i < 26; i++) VK[String.fromCharCode(97 + i)] = 0x41 + i; // a-z
for (let i = 0; i < 10; i++) VK[String(i)] = 0x30 + i; // 0-9
for (let i = 1; i <= 12; i++) VK[`f${i}`] = 0x6f + i; // F1-F12

export class ActionRefused extends Error {}

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
