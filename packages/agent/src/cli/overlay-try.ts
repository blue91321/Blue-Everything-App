/**
 * Show the overlay, without saying anything.
 *
 *   npm run overlay-try -w @everything/agent
 *
 * Same reason `voice-try` exists: the window is the one part that either
 * appears on screen or does not, and finding that out by talking at a
 * microphone is a slow way to debug a CreateWindowEx flag.
 */
import koffi from 'koffi';
import { createOverlay } from '../overlay.js';

/* Asking Windows whether the window is really there, rather than trusting that
 * no exception was thrown. "It did not crash" is not "it appeared". */
const user32 = koffi.load('user32.dll');
const FindWindowW = user32.func('void * __stdcall FindWindowW(const char16_t *cls, const char16_t *title)');
const IsWindowVisible = user32.func('int __stdcall IsWindowVisible(void *hwnd)');
const GetWindowRect = user32.func('int __stdcall GetWindowRect(void *hwnd, _Out_ void *rect)');
const RECT = koffi.struct('TryRect', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });

function describe(label: string): void {
  const hwnd = FindWindowW('EverythingVoiceOverlay', null);
  if (!hwnd) {
    console.log(`  ${label.padEnd(14)} NOT FOUND`);
    return;
  }
  const r = koffi.alloc(RECT, 1);
  GetWindowRect(hwnd, r);
  const box = koffi.decode(r, RECT) as { left: number; top: number; right: number; bottom: number };
  const visible = IsWindowVisible(hwnd) !== 0;
  console.log(
    `  ${label.padEnd(14)} visible: ${String(visible).padEnd(5)} at ${box.left},${box.top}  ${box.right - box.left}x${box.bottom - box.top}`
  );
}

const overlay = createOverlay({
  onChoice: (id) => console.log(`  clicked: ${id}`),
  onDismiss: () => console.log('  dismissed'),
});

console.log('\nShowing at the cursor. Move the mouse somewhere visible.\n');

const steps: { after: number; run: () => void }[] = [
  { after: 0, run: () => overlay.show({ title: 'Listening…', lines: [{ text: 'say something', tone: 'muted' }] }) },
  {
    after: 2500,
    run: () =>
      overlay.show({
        title: 'Drink water',
        lines: [{ text: '7 of 16 today', tone: 'good' }, { text: 'heard "hey jarvis drink water"', tone: 'muted' }],
      }),
  },
  {
    after: 5000,
    run: () =>
      overlay.show({
        title: 'Which one?',
        lines: [{ text: 'That matches more than one thing.', tone: 'muted' }],
        choices: [
          { id: 'a', label: 'Drink water' },
          { id: 'b', label: 'Open my email' },
        ],
      }),
  },
  { after: 11000, run: () => overlay.hide() },
];

for (const step of steps) setTimeout(step.run, step.after);

// Checked a beat after each change, so the window has been placed and painted.
for (const [label, at] of [['listening', 600], ['result', 3100], ['choices', 5600], ['hidden', 11400]] as const) {
  setTimeout(() => describe(label), at);
}

setTimeout(() => {
  overlay.destroy();
  console.log('\nDone. If nothing appeared, the window was not created.\n');
  process.exit(0);
}, 12500);
