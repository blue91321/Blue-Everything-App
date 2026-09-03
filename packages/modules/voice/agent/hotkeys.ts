/**
 * System-wide key combinations, for the two things the wake word cannot do.
 *
 * The wake word is for when your hands are busy. These are for when they are
 * not, and one of them does something the wake word structurally cannot:
 * **switch voice on**. A microphone that is off cannot hear you ask for it to
 * be turned on, so without a hotkey the only ways back were the tray, a browser
 * tab, or the phone.
 *
 * ### It lives in the voice package, not in core
 *
 * Both hotkeys are about voice, so deleting the package should take them with
 * it. That works because the *module* keeps running while the feature is merely
 * switched off — `voiceEnabled: false` disposes the speech models and closes the
 * microphone, but the agent half is still loaded and still polling, which is how
 * it learns to turn back on. So "the hotkey that enables voice" is served by the
 * same code either way.
 *
 * It also keeps the virtual-key table in one place: `actions.ts` already owns
 * one for sending keystrokes, and a second copy in core would be a table nobody
 * would think to keep in step.
 *
 * ### Registering, and why a window
 *
 * `RegisterHotKey` with a window posts `WM_HOTKEY` to that window, so
 * `DispatchMessageW` routes it to a window procedure like any other message —
 * which means the tray's pump and this one both deliver it, rather than one of
 * them silently swallowing it. Registered with a null window instead, the
 * message goes to the bare *thread* queue, where `DispatchMessageW` has nowhere
 * to send it and drops it on the floor. With three pumps in this process, that
 * is not a theoretical difference: whichever peeked first would eat it.
 *
 * `MOD_NOREPEAT` is not optional. Without it, holding the combination down
 * repeats at the keyboard's autorepeat rate — which for "toggle voice" means
 * flipping it thirty times a second.
 */
import koffi from 'koffi';
import { parseHotkey } from '@everything/shared';
import { VK } from './actions.js';

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

/* Prefixed, because koffi's type registry is process-wide — `win32.ts`,
 * `overlay.ts` and `tray.ts` each own their own names, and a collision throws at
 * import time and takes the agent down before it starts. */
const HotkeyPOINT = koffi.struct('HotkeyPOINT', { x: 'int32_t', y: 'int32_t' });

const HotkeyMSG = koffi.struct('HotkeyMSG', {
  hwnd: 'void *',
  message: 'uint32_t',
  wParam: 'uintptr_t',
  lParam: 'intptr_t',
  time: 'uint32_t',
  pt: HotkeyPOINT,
});

const HotkeyWNDCLASSEXW = koffi.struct('HotkeyWNDCLASSEXW', {
  cbSize: 'uint32_t',
  style: 'uint32_t',
  lpfnWndProc: 'void *',
  cbClsExtra: 'int32_t',
  cbWndExtra: 'int32_t',
  hInstance: 'void *',
  hIcon: 'void *',
  hCursor: 'void *',
  hbrBackground: 'void *',
  lpszMenuName: 'void *',
  lpszClassName: 'const char16_t *',
  hIconSm: 'void *',
});

const WndProcProto = koffi.proto(
  'intptr_t __stdcall HotkeyWndProc(void *hwnd, uint32_t msg, uintptr_t wparam, intptr_t lparam)'
);

const GetModuleHandleW = kernel32.func('void * __stdcall GetModuleHandleW(const char16_t *name)');
const RegisterClassExW = user32.func('uint16_t __stdcall RegisterClassExW(const void *wc)');
const CreateWindowExW = user32.func(
  'void * __stdcall CreateWindowExW(uint32_t exStyle, const char16_t *className, const char16_t *windowName, uint32_t style, int x, int y, int w, int h, void *parent, void *menu, void *instance, void *param)'
);
const DestroyWindow = user32.func('int __stdcall DestroyWindow(void *hwnd)');
const DefWindowProcW = user32.func(
  'intptr_t __stdcall DefWindowProcW(void *hwnd, uint32_t msg, uintptr_t wparam, intptr_t lparam)'
);
const PeekMessageW = user32.func(
  'int __stdcall PeekMessageW(_Out_ void *msg, void *hwnd, uint32_t min, uint32_t max, uint32_t remove)'
);
const TranslateMessage = user32.func('int __stdcall TranslateMessage(const void *msg)');
const DispatchMessageW = user32.func('intptr_t __stdcall DispatchMessageW(const void *msg)');
const RegisterHotKey = user32.func(
  'int __stdcall RegisterHotKey(void *hwnd, int id, uint32_t modifiers, uint32_t vk)'
);
const UnregisterHotKey = user32.func('int __stdcall UnregisterHotKey(void *hwnd, int id)');

const WM_HOTKEY = 0x0312;
const PM_REMOVE = 0x0001;

const MOD_ALT = 0x0001;
const MOD_CONTROL = 0x0002;
const MOD_SHIFT = 0x0004;
const MOD_WIN = 0x0008;
/** Stops the combination repeating while it is held down. */
const MOD_NOREPEAT = 0x4000;

const MODIFIER_BITS: Record<string, number> = {
  ctrl: MOD_CONTROL,
  control: MOD_CONTROL,
  alt: MOD_ALT,
  shift: MOD_SHIFT,
  win: MOD_WIN,
  super: MOD_WIN,
  meta: MOD_WIN,
};

/**
 * Faster than the tray's 250ms, slower than the overlay's 16ms.
 *
 * This is the delay between pressing the key and the tone, so a quarter of a
 * second is enough to feel like the key did not take — while 16ms would be
 * paying 60Hz forever for a key pressed a few times a day.
 */
const PUMP_MS = 60;

/** koffi wants UTF-16 for the `W` calls; a plain string is marshalled as one. */
const wide = (value: string): string => value;

export type HotkeyAction = 'toggle' | 'listen';

/** Ids are ours to choose, and only have to be unique within this window. */
const IDS: Record<HotkeyAction, number> = { toggle: 1, listen: 2 };

export interface HotkeyBinding {
  action: HotkeyAction;
  /** As typed, e.g. `ctrl+alt+v`. */
  combo: string;
}

export interface Hotkeys {
  /**
   * Replace every registration with this set.
   *
   * Whole-set rather than add/remove, for the reason the habit reorder is a
   * whole-list write: the settings arrive as a complete picture on every poll,
   * and diffing them here would be a second model of the same thing.
   */
  apply(bindings: HotkeyBinding[]): void;
  /**
   * What could not be registered, and why — nearly always because another
   * program already owns the combination.
   *
   * Reported rather than logged, because a hotkey that silently does nothing is
   * indistinguishable from one that was never saved, and the fix (pick a
   * different combination) is not guessable from silence.
   */
  problems(): string[];
  destroy(): void;
}

export class HotkeysUnavailable extends Error {}

/**
 * Start listening for system-wide key combinations.
 *
 * Throws rather than returning null, so the caller decides whether it matters.
 * It does not: a session with no desktop is not a reason to stop watching for
 * stopping points, which is the same call `createTray` makes.
 */
export function createHotkeys(onPress: (action: HotkeyAction) => void): Hotkeys {
  const instance = GetModuleHandleW(null);
  const className = 'EverythingVoiceHotkeys';

  let destroyed = false;
  let registered: HotkeyBinding[] = [];
  let failures: string[] = [];

  const onMessage = (hwnd: unknown, msg: number, wparam: number, lparam: number): number => {
    if (msg === WM_HOTKEY) {
      const action = (Object.keys(IDS) as HotkeyAction[]).find((key) => IDS[key] === Number(wparam));
      if (action) {
        /*
         * The handler runs on the pump's tick, which is this thread — the same
         * property that makes the tray's callback safe. Nothing is ever invoked
         * from a thread V8 has not heard of.
         */
        try {
          onPress(action);
        } catch {
          // A throwing handler must not take the message pump down with it: the
          // other hotkey would stop working too, including the one that turns
          // voice off.
        }
      }
      return 0;
    }
    return Number(DefWindowProcW(hwnd, msg, wparam, lparam));
  };

  // Held in a variable so it cannot be collected while Windows still holds the
  // pointer. A callback outliving its JS reference is a hard crash.
  const wndProc = koffi.register(onMessage, koffi.pointer(WndProcProto));

  const wc = koffi.alloc(HotkeyWNDCLASSEXW, 1);
  koffi.encode(wc, HotkeyWNDCLASSEXW, {
    cbSize: koffi.sizeof(HotkeyWNDCLASSEXW),
    style: 0,
    lpfnWndProc: wndProc,
    cbClsExtra: 0,
    cbWndExtra: 0,
    hInstance: instance,
    hIcon: null,
    hCursor: null,
    hbrBackground: null,
    lpszMenuName: null,
    lpszClassName: wide(className),
    hIconSm: null,
  });
  RegisterClassExW(wc);

  const hwnd = CreateWindowExW(0, wide(className), wide('Blue Everything voice'), 0, 0, 0, 0, 0, null, null, instance, null);
  if (!hwnd) {
    koffi.unregister(wndProc);
    throw new HotkeysUnavailable('could not create the hotkey window');
  }

  const msg = koffi.alloc(HotkeyMSG, 1);

  function pump(): void {
    if (destroyed) return;
    // Bounded, so a flood can never starve the event loop this shares.
    for (let i = 0; i < 32; i++) {
      if (!PeekMessageW(msg, null, 0, 0, PM_REMOVE)) break;
      TranslateMessage(msg);
      DispatchMessageW(msg);
    }
  }

  const timer = setInterval(pump, PUMP_MS);
  timer.unref();

  function clear(): void {
    for (const binding of registered) UnregisterHotKey(hwnd, IDS[binding.action]);
    registered = [];
  }

  return {
    apply(bindings: HotkeyBinding[]): void {
      if (destroyed) return;

      const wanted = bindings.filter((b) => b.combo.trim() !== '');
      const same =
        wanted.length === registered.length &&
        wanted.every((b, i) => registered[i].action === b.action && registered[i].combo === b.combo);
      // The config arrives on every poll and nearly always says the same thing.
      // Re-registering regardless would unregister and re-register a live hotkey
      // several times a minute, which is a window in which it does not work.
      if (same) return;

      clear();
      failures = [];

      for (const binding of wanted) {
        const parsed = parseHotkey(binding.combo);
        if (!parsed) {
          failures.push(`${binding.combo} is not a key combination`);
          continue;
        }

        const vk = VK[parsed.key];
        if (vk === undefined) {
          failures.push(`${binding.combo} uses a key this cannot register`);
          continue;
        }

        let modifiers = MOD_NOREPEAT;
        for (const name of parsed.modifiers) modifiers |= MODIFIER_BITS[name] ?? 0;

        if (RegisterHotKey(hwnd, IDS[binding.action], modifiers, vk)) {
          registered.push(binding);
        } else {
          /*
           * Almost always "another program already has it". Windows does not say
           * which, and there is no way to ask, so the message says what to do
           * rather than pretending to diagnose it.
           */
          failures.push(`${binding.combo} is already taken by another program — try a different combination`);
        }
      }
    },

    problems: () => [...failures],

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      clearInterval(timer);
      clear();
      DestroyWindow(hwnd);
      koffi.unregister(wndProc);
    },
  };
}
