/**
 * Closing the app's window: stay in the tray, or stop.
 *
 * The decision is the server's (`closing.ts` there): what this person chose,
 * and what needs the background right now. This half notices the window go and
 * acts on the answer, because only the agent can see windows and stop things on
 * this PC.
 *
 * **Which window.** The launcher writes the handle of every app window it
 * opens to `logs\app-windows.txt` (`Save-AppWindows` in `app-id.ps1`). When one
 * of those has been seen open and none is open any more, the app was closed. A
 * window opened some other way (a tab, a bookmark) is the browser's, and
 * closing it is not closing the app.
 *
 * **A three-second check**, and it earns its place against the attention
 * loop's numbers: it reads a file of a few lines and asks Windows whether a
 * handful of handles are still windows, microseconds a time, and it is what
 * makes "close everything" happen when the window closes rather than up to
 * half a minute later.
 *
 * **No popup.** It was asked for without one: what closing does is said where
 * it is chosen, in Settings and onboarding, with what it would stop.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import koffi from 'koffi';
import type { ServerClient } from './client.js';

const user32 = koffi.load('user32.dll');
const IsWindow = user32.func('int __stdcall IsWindow(intptr_t hwnd)');
const IsWindowVisible = user32.func('int __stdcall IsWindowVisible(intptr_t hwnd)');

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const windowsFile = resolve(repoRoot, 'logs', 'app-windows.txt');
const CHECK_MS = 3000;
/** Long enough to open it again if closing was a slip. */
const QUIT_AFTER_MS = 5000;

function openAppWindows(): number {
  let lines: string[];
  try {
    lines = readFileSync(windowsFile, 'utf8').split(/\r?\n/);
  } catch {
    return 0;
  }
  let open = 0;
  for (const line of lines) {
    const handle = Number(line.trim());
    if (!Number.isSafeInteger(handle) || handle === 0) continue;
    if (IsWindow(handle) && IsWindowVisible(handle)) open += 1;
  }
  return open;
}

export function watchClosing(options: {
  client: ServerClient;
  /** `desktop` on the desktop client, `host` on the PC that runs the server. */
  side: 'host' | 'desktop';
  /** Stop: this agent, and on the host the server and everything with it. */
  quit: () => void;
  log: (message: string) => void;
}): void {
  let wasOpen = false;
  let deciding = false;

  const decide = async (): Promise<void> => {
    const answer = await options.client.closing(options.side);
    const nothingNeeds = answer.keeps.length === 0;
    if (answer.mode !== 'quit' && !nothingNeeds) return; // Staying, in the tray.

    // A moment's grace: opening it again straight away is changing your mind.
    setTimeout(() => {
      if (openAppWindows() > 0) {
        wasOpen = true;
        return;
      }
      options.log(`the app window closed; stopping (${nothingNeeds ? 'nothing needs it' : 'chosen'})`);
      options.quit();
    }, QUIT_AFTER_MS);
  };

  setInterval(() => {
    if (deciding) return;
    if (openAppWindows() > 0) {
      wasOpen = true;
      return;
    }
    if (!wasOpen) return;
    wasOpen = false;
    deciding = true;
    decide()
      .catch((error: Error) => options.log(`could not decide what closing means: ${error.message}`))
      .finally(() => {
        deciding = false;
      });
  }, CHECK_MS).unref();
}
