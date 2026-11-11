/**
 * Watched hotkeys: keys and mouse buttons a blueprint starts from while you
 * play a game, and which the game still gets.
 *
 * A registered hotkey (`hotkeys.ts`) takes its keys from every program, needs
 * a modifier, and cannot be a mouse button. A macro for a game wants the
 * opposite of all three: a bare side button, or the left button you are firing
 * with, seen and let through. AutoHotkey does that with a low-level input hook.
 * This does not, deliberately: a hook makes every key and click on the PC wait
 * for this process, and this process is Node polling its message queue, so a
 * busy moment here would lag the mouse in every program.
 *
 * So it asks Windows whether those few keys are down, 100 times a second, and
 * only while the server lists something to watch. The server lists a watched
 * key only while its game is being played, so with Warframe closed this does
 * nothing at all. A click lasts far longer than 10ms, so none is missed.
 *
 * A press counts only with that game's window in front, asked at the moment
 * of the press (the script's `IsWarframeActive`), because the server's list
 * follows the game a heartbeat late. A let-go is said only for a press that
 * was said.
 */
import { VK } from '../../../agent/src/keys.js';
import { getForegroundWindow } from '../../../agent/src/win32.js';
import { parseKeys } from '../web/keys.js';
import { isDown } from './keys.js';

/** Mouse buttons by virtual-key code. Only watched: nothing here presses one. */
// Both spellings, so a server older than the rename is still understood.
const MOUSE_VK: Record<string, number> = {
  mouse1: 0x01, mouse2: 0x02, mouse3: 0x04, mouse4: 0x05, mouse5: 0x06,
  lbutton: 0x01, rbutton: 0x02, mbutton: 0x04, xbutton1: 0x05, xbutton2: 0x06,
};

const EVERY_MS = 10;

export interface Watched {
  keys: string;
  game: string;
}

interface Entry extends Watched {
  codes: number[];
  down: boolean;
  said: boolean;
}

export function createWatcher(report: (keys: string, up: boolean) => void): {
  apply(list: Watched[]): void;
  stop(): void;
} {
  let entries: Entry[] = [];
  let timer: NodeJS.Timeout | null = null;

  const look = () => {
    for (const entry of entries) {
      const down = entry.codes.every(isDown);
      if (down === entry.down) continue;
      entry.down = down;
      if (down) {
        const front = getForegroundWindow();
        if (front?.exe !== entry.game) continue;
        entry.said = true;
        report(entry.keys, false);
      } else if (entry.said) {
        entry.said = false;
        report(entry.keys, true);
      }
    }
  };

  return {
    apply(list) {
      // Anything let go of because it stopped being watched is said as let go,
      // so a "while I hold it" run does not carry on after the game closes.
      for (const old of entries) if (old.said) report(old.keys, true);
      entries = [];
      for (const item of list) {
        const parsed = parseKeys(item.keys, false, true);
        if (!parsed) continue;
        const codes = [...parsed.modifiers, parsed.key].map((name) => MOUSE_VK[name] ?? VK[name]);
        if (codes.some((c) => c === undefined)) continue;
        // Down already counts as down: a button held as the game comes up is
        // not a press, or every alt-tab back while firing would be one.
        entries.push({ keys: item.keys, game: item.game.toLowerCase(), codes: codes as number[], down: (codes as number[]).every(isDown), said: false });
      }
      if (entries.length && !timer) {
        timer = setInterval(look, EVERY_MS);
      } else if (!entries.length && timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      entries = [];
    },
  };
}
