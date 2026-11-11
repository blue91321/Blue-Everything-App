/**
 * Prove the popup's box to type in, without anybody typing.
 *
 *   npm run ask-try -w @everything/agent
 *
 * Puts up a question, clicks its box and types into it by posting the
 * messages a real click and real keys would arrive as, presses Enter, and
 * checks the answer came back and the keyboard went back to the window that
 * had it. Then asks again and lets the time run out, which must answer
 * nothing. Nothing is pressed into any other window.
 *
 * What it cannot prove is a real click taking the keyboard: Windows only lets
 * a window take the foreground after a real input event on it, and a posted
 * message is not one. That needs a click by hand.
 */
import koffi from 'koffi';
import * as popup from '../popup.js';

const user32 = koffi.load('user32.dll');
const FindWindowExW = user32.func('void * __stdcall FindWindowExW(void *parent, void *after, const char16_t *cls, const char16_t *title)');
const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)');
const PostMessageW = user32.func('int __stdcall PostMessageW(void *hwnd, uint32_t msg, uintptr_t wparam, intptr_t lparam)');
const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()');

const WM_LBUTTONDOWN = 0x0201;
const WM_CHAR = 0x0102;

let failures = 0;
const check = (what: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  \x1b[32m✓\x1b[0m' : '  \x1b[31m✗\x1b[0m'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** This process's popup window, not the running agent's, which has the same class. */
function ourWindow(): unknown {
  let at: unknown = null;
  for (;;) {
    at = FindWindowExW(null, at, 'EverythingOverlay', null);
    if (!at) return null;
    const pid = [0];
    GetWindowThreadProcessId(at, pid);
    if (pid[0] === process.pid) return at;
  }
}

popup.startPopups({ log: (m) => console.log(m) });
const front = GetForegroundWindow();

console.log('\nTyping an answer');
const answer = popup.ask({ id: 'one', title: 'Blue Everything test: ignore', placeholder: 'Click to type', accent: '#ff6b6b', forMs: 8000 });
await sleep(300);
const hwnd = ourWindow();
check('the question is on screen', popup.visible() && !!hwnd);
// Inside the box: below the title line, left of the middle.
PostMessageW(hwnd, WM_LBUTTONDOWN, 0, (55 << 16) | 100);
for (const ch of 'Hi there') PostMessageW(hwnd, WM_CHAR, ch.charCodeAt(0), 0);
PostMessageW(hwnd, WM_CHAR, 8, 0); // backspace
PostMessageW(hwnd, WM_CHAR, 13, 0); // Enter
const typed = await Promise.race([answer, sleep(3000).then(() => 'timed out')]);
check('Enter sends what was typed, with a backspace taken off', typed === 'Hi ther', String(typed));
await sleep(200);
check('the popup goes once it is answered', !popup.visible());
const after = GetForegroundWindow();
check('the keyboard is back with the window that had it', koffi.address(after) === koffi.address(front));

console.log('\nNot answered');
const ignored = popup.ask({ id: 'two', title: 'Blue Everything test: ignore', forMs: 1500 });
await sleep(200);
const keysBeforeClick = ourWindow();
// Typed at without being clicked: the box does not have the keyboard, so nothing lands.
for (const ch of 'xyz') PostMessageW(keysBeforeClick, WM_CHAR, ch.charCodeAt(0), 0);
check('running out of time answers nothing', (await ignored) === null);

console.log('\nCovered and back');
const covered = popup.ask({ id: 'three', title: 'Blue Everything test: ignore', forMs: 4000 });
await sleep(200);
popup.show({ title: 'Blue Everything test: something else', forMs: 600 });
check('something else goes over the question', popup.visible());
await sleep(900);
check('and the question comes back when it goes', popup.visible());
popup.cancelAsk('three');
check('taking it away answers nothing', (await covered) === null);
await sleep(100);
check('and takes it off the screen', !popup.visible());

popup.stopPopups();
console.log(failures === 0 ? '\nAll good.\n' : `\n${failures} failed.\n`);
process.exit(failures === 0 ? 0 : 1);
