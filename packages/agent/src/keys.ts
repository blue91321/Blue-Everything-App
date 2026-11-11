/**
 * Virtual-key codes for everything `HOTKEY_KEYS` allows.
 *
 * Core, and only a table: `hotkeys.ts` registers these spellings system-wide,
 * and `blueprints/agent/keys.ts` sends them. One copy, so the two cannot
 * disagree about which key "minus" is. Nothing here presses anything.
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
for (let i = 0; i < 10; i++) VK[`numpad${i}`] = 0x60 + i; // VK_NUMPAD0-9
// The operator keys, which are their own codes rather than shifted digits.
VK.numpadmultiply = 0x6a;
VK.numpadplus = 0x6b;
VK.numpadminus = 0x6d;
VK.numpaddecimal = 0x6e;
VK.numpaddivide = 0x6f;
