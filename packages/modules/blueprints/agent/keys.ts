/**
 * Pressing keys for a blueprint, and so for a voice command, which is one.
 *
 * Until 2026-10-29 voice had its own file for this (`voice/agent/actions.ts`)
 * and this was the second; voice's commands are blueprints now, so this is the
 * one. A synthetic key goes into whatever window has focus, which is why this
 * is the most careful code in the agent. A blueprint presses keys only because
 * a box says to, started by a hotkey you pressed, a timer you set, or a phrase
 * you said. So:
 *
 *  - only keys stored in a blueprint's "Press keys" box are ever pressed, and
 *    the server asks only from a real run (a test only says what it would do);
 *  - `parseKeys` is an allow-list of key names, the same names `HOTKEY_KEYS`
 *    allows, so nothing outside it can be typed;
 *  - **a bare key is allowed**, because a macro that presses `e` in a game is
 *    the point. Voice's old rule refused one for fear of a misheard phrase;
 *    a phrase now only reaches keys a box you made names;
 *  - every key pressed is released, in reverse order, even if something
 *    fails halfway, so a stuck Ctrl is never left behind;
 *  - a run can be stopped by its hotkey, by Stop on the screen, or by
 *    switching the blueprint off, and a repeat has a ceiling.
 *
 * Deleting the blueprints package takes this file, and its key-pressing, away.
 */
import koffi from 'koffi';
import { VK } from '../../../agent/src/keys.js';
import { MODIFIERS, parseKeys, parseTimeline, runTimeline } from '../web/keys.js';

const user32 = koffi.load('user32.dll');
const winmm = koffi.load('winmm.dll');
const timeBeginPeriod = winmm.func('uint32_t __stdcall timeBeginPeriod(uint32_t ms)');
const timeEndPeriod = winmm.func('uint32_t __stdcall timeEndPeriod(uint32_t ms)');

/**
 * A finer timer while keys are being pressed. Windows wakes a program's
 * timers every 15.6 ms unless it asks otherwise, so a 20 ms gap on a timeline
 * was 31 and a 30 ms hold was 31 (measured: asked for 5 ms, 15.4; with this,
 * 5.1). Asked for only while pressing and given back after, since a 1 ms
 * timer costs a little power, and since Windows 10 it is this process's
 * alone. Counted, so a press inside a timeline does not end it early.
 */
let fine = 0;
async function finely<T>(work: () => Promise<T>): Promise<T> {
  if (fine++ === 0) timeBeginPeriod(1);
  try {
    return await work();
  } finally {
    if (--fine === 0) timeEndPeriod(1);
  }
}

/** `keybd_event`, as voice uses: SendInput's tagged union buys nothing here. */
const keybdEvent = user32.func('void __stdcall keybd_event(uint8_t vk, uint8_t scan, uint32_t flags, uintptr_t extra)');
const mapVirtualKey = user32.func('uint32_t __stdcall MapVirtualKeyW(uint32_t code, uint32_t mapType)');
const getAsyncKeyState = user32.func('int16_t __stdcall GetAsyncKeyState(int vk)');

/** Whether a key is down right now, by its virtual-key code. */
export function isDown(vk: number): boolean {
  return (Number(getAsyncKeyState(vk)) & 0x8000) !== 0;
}

const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;
const MAPVK_VK_TO_VSC = 0;

/**
 * Keys Windows sends with the extended flag: the arrows and the block above
 * them, the Windows key, the number pad's divide. Without it a game reading
 * scan codes sees the number pad's 8 where the up arrow was meant.
 */
const EXTENDED = new Set([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2d, 0x2e, 0x5b, 0x6f]);

/**
 * With the scan code as well as the virtual key, because plenty of games read
 * the keyboard by scan code and ignore a press that carries none.
 */
function send(vk: number, up: boolean): void {
  const scan = Number(mapVirtualKey(vk, MAPVK_VK_TO_VSC)) & 0xff;
  keybdEvent(vk, scan, (up ? KEYEVENTF_KEYUP : 0) | (EXTENDED.has(vk) ? KEYEVENTF_EXTENDEDKEY : 0), 0);
}

/**
 * Press a key or a combination: modifiers down in order, the key, held for
 * `holdMs`, then all of them up in reverse, which is what the window expects.
 */
function codesOf(keys: string): number[] {
  // A modifier on its own, as a timeline holds one (a bar of Ctrl).
  if ((MODIFIERS as readonly string[]).includes(keys)) return [VK[keys]!];
  const parsed = parseKeys(keys);
  if (!parsed) throw new Error(`"${keys}" is not a key combination`);
  return [...parsed.modifiers, parsed.key].map((name) => {
    const code = VK[name];
    if (code === undefined) throw new Error(`no key code for "${name}"`);
    return code;
  });
}

// Both spellings, so a server older than the rename is still understood.
const MOUSE_VK: Record<string, number> = {
  mouse1: 0x01, mouse2: 0x02, mouse3: 0x04, mouse4: 0x05, mouse5: 0x06,
  lbutton: 0x01, rbutton: 0x02, mbutton: 0x04, xbutton1: 0x05, xbutton2: 0x06,
};

/**
 * Whether a key, a combination or a mouse button is down at this moment, for
 * "Am I holding a key?". Only asks: nothing is pressed.
 */
export function isHeld(keys: string): boolean {
  if ((MODIFIERS as readonly string[]).includes(keys)) return isDown(VK[keys]!);
  const parsed = parseKeys(keys, false, true);
  if (!parsed) throw new Error(`"${keys}" is not a key or mouse button`);
  return [...parsed.modifiers, parsed.key].every((name) => {
    const code = MOUSE_VK[name] ?? VK[name];
    if (code === undefined) throw new Error(`no key code for "${name}"`);
    return isDown(code);
  });
}

const wait = (ms: number): Promise<void> => (ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/**
 * Play a timeline, here, so the gaps between presses are this PC's own timing
 * rather than a round trip's. The order and timing are `runTimeline`'s, which
 * `blueprints-check` drives with a fake keyboard; this hands it the real one.
 * The bars were cleaned by `parseTimeline` on the server and are cleaned again
 * there, since this is what presses.
 *
 * Whatever is still down at the end, or if something fails, is let go in
 * reverse, so a stuck Ctrl is never left behind.
 */
export function playTimeline(raw: unknown): Promise<void> {
  return finely(() => play(raw));
}

async function play(raw: unknown): Promise<void> {
  if (parseTimeline(raw).every((b) => !b.keys)) throw new Error('nothing on the timeline');
  const held: number[] = [];
  const started = Date.now();
  try {
    await runTimeline(raw, {
      held: (keys) => codesOf(keys).every(isDown),
      press(keys, down) {
        const codes = codesOf(keys);
        for (const code of down ? codes : [...codes].reverse()) {
          send(code, !down);
          if (down) held.push(code);
          else {
            const at = held.lastIndexOf(code);
            if (at !== -1) held.splice(at, 1);
          }
        }
      },
      at: (ms) => wait(started + ms - Date.now()),
    });
  } finally {
    for (const code of held.reverse()) send(code, true);
  }
}

export function press(keys: string, holdMs: number): Promise<void> {
  return finely(() => pressNow(keys, holdMs));
}

async function pressNow(keys: string, holdMs: number): Promise<void> {
  const codes = codesOf(keys);
  const down: number[] = [];
  try {
    for (const code of codes) {
      send(code, false);
      down.push(code);
    }
    const hold = Math.max(0, Math.min(5000, holdMs));
    if (hold > 0) await new Promise((resolve) => setTimeout(resolve, hold));
  } finally {
    for (const code of down.reverse()) send(code, true);
  }
}
