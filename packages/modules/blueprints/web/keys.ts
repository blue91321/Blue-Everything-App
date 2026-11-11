/**
 * Key combinations, as blueprints write them: `ctrl+alt+m`, `space`, `e`.
 *
 * **No imports**, so the screen (which may not import `@everything/shared`),
 * the server and the agent half read one rule. The key names are the ones
 * `HOTKEY_KEYS` in `shared` allows, so the agent's virtual-key table has a
 * code for every one; `blueprints-check` asserts the two lists agree.
 *
 * Two rules, for two different risks:
 *
 *   - **A hotkey that starts a blueprint needs a modifier.** It is registered
 *     system-wide, so a bare `f5` or `e` would take that key from every other
 *     program on the PC. The rule voice's shortcuts follow.
 *   - **Keys a blueprint presses do not.** Voice refuses a bare letter because
 *     a misheard phrase could send one; a blueprint presses what you wired it
 *     to, from a hotkey you pressed or a timer you set, and a macro that
 *     presses `e` in a game is the whole point.
 */

export const MODIFIERS = ['ctrl', 'alt', 'shift', 'win'] as const;

export const KEY_NAMES = [
  ...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''),
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
  'space', 'enter', 'tab', 'escape', 'backspace', 'delete', 'insert', 'home', 'end',
  'pageup', 'pagedown', 'up', 'down', 'left', 'right',
  'minus', 'plus', 'comma', 'period',
  'numpad0', 'numpad1', 'numpad2', 'numpad3', 'numpad4',
  'numpad5', 'numpad6', 'numpad7', 'numpad8', 'numpad9',
  'numpadplus', 'numpadminus', 'numpadmultiply', 'numpaddivide', 'numpaddecimal',
] as const;

/**
 * Mouse buttons, which only a *watched* hotkey can be: Windows cannot register
 * one as a hotkey, and nothing here presses one. Numbered as games number
 * them: mouse1 the left, mouse2 the right, mouse3 the middle (the wheel),
 * mouse4 the side button nearer you ("back"), mouse5 the other.
 */
export const MOUSE_BUTTONS = ['mouse1', 'mouse2', 'mouse3', 'mouse4', 'mouse5'] as const;

/**
 * Other spellings people type, folded to the one above. Windows' own names for
 * the buttons were the spelling until 2026-11-06, so a blueprint saved with
 * `xbutton1` reads as mouse4.
 */
const ALIASES: Record<string, string> = {
  control: 'ctrl', super: 'win', meta: 'win', cmd: 'win', esc: 'escape', return: 'enter',
  lbutton: 'mouse1', rbutton: 'mouse2', mbutton: 'mouse3', xbutton1: 'mouse4', xbutton2: 'mouse5',
  leftclick: 'mouse1', rightclick: 'mouse2', middleclick: 'mouse3',
};

export interface Keys {
  modifiers: string[];
  key: string;
}

/**
 * `"Ctrl + Alt + M"` to its parts, or null. Modifiers come out in one order,
 * so two spellings of a combination compare equal.
 */
export function parseKeys(value: string, needModifier = false, mouse = false): Keys | null {
  const parts = value
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ALIASES[p] ?? p);
  if (parts.length === 0) return null;
  const key = parts[parts.length - 1]!;
  const mods = parts.slice(0, -1);
  const known = (KEY_NAMES as readonly string[]).includes(key) || (mouse && (MOUSE_BUTTONS as readonly string[]).includes(key));
  if (!known) return null;
  if (mods.some((m) => !(MODIFIERS as readonly string[]).includes(m))) return null;
  if (new Set(mods).size !== mods.length) return null;
  if (needModifier && mods.length === 0) return null;
  return { modifiers: MODIFIERS.filter((m) => mods.includes(m)), key };
}

/** The one spelling of a combination: `ctrl+alt+m`. Empty if it is not one. */
export function normalKeys(value: string, needModifier = false, mouse = false): string {
  const parsed = parseKeys(value, needModifier, mouse);
  return parsed ? [...parsed.modifiers, parsed.key].join('+') : '';
}

/** The parts of a browser `KeyboardEvent` this reads, named so no DOM type is needed. */
export interface KeyEventLike {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

const NAMED: Record<string, string> = {
  Space: 'space', Enter: 'enter', Tab: 'tab', Escape: 'escape',
  Backspace: 'backspace', Delete: 'delete', Insert: 'insert',
  Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Minus: 'minus', Equal: 'plus', Comma: 'comma', Period: 'period',
  NumpadAdd: 'numpadplus', NumpadSubtract: 'numpadminus',
  NumpadMultiply: 'numpadmultiply', NumpadDivide: 'numpaddivide',
  NumpadDecimal: 'numpaddecimal',
};

/**
 * A key pressed in the browser, in this spelling, or null while only a
 * modifier is down (somebody still reaching for the second key).
 *
 * Reads `event.code`, the physical key, rather than `event.key`, what it
 * produces: the number pad's `5` and the digit row's are different keys to
 * Windows and the same character to `key`. The voice screen's recorder reads
 * it the same way, for the same reason.
 */
export function keysFromEvent(event: KeyEventLike): string | null {
  const code = event.code;
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3).toLowerCase();
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-2])$/.test(code)) key = code.toLowerCase();
  else if (/^Numpad[0-9]$/.test(code)) key = code.toLowerCase();
  else key = NAMED[code] ?? null;
  if (!key) return null;
  const mods: string[] = [];
  if (event.ctrlKey) mods.push('ctrl');
  if (event.altKey) mods.push('alt');
  if (event.shiftKey) mods.push('shift');
  if (event.metaKey) mods.push('win');
  return [...mods, key].join('+');
}


/* ---- Timelines ------------------------------------------------------ */

/**
 * One key on a "Press keys" timeline: down at `at`, up at `until`, both in
 * milliseconds from the moment the box runs. A tap is a short bar; a held key
 * is a long one, and a key held while another is tapped (Ctrl over E) is two
 * bars that overlap. Drawn and dragged on the box's timeline editor, and
 * played by the agent on its own, so the gaps are the PC's timing rather than
 * a round trip's.
 *
 * `ifUp`: only if you are not already holding it. The Warframe slide holds W
 * for you unless you are holding it yourself, and then it leaves W alone at
 * both ends, so your own W is not let go under you.
 *
 * And when it is skipped, the wait it would have started is skipped too: the
 * next key goes down straight away and everything after moves up with it, as
 * the script's `Sleep 20` after `w down` only happened when W was pressed.
 * `keepGap` keeps the timeline to the clock instead.
 *
 * `keys` is a key or a combination, or a modifier on its own (a bar of Ctrl).
 * It may be empty while a new row is being set up; such a row is not played.
 */
export interface TimelineBar {
  keys: string;
  at: number;
  until: number;
  ifUp?: boolean;
  keepGap?: boolean;
}

export const TIMELINE_LIMITS = { bars: 24, totalMs: 10_000, shortestMs: 1 } as const;

/** A key a bar holds: a combination, or a modifier alone, which `normalKeys` does not take. */
export function barKeys(value: string): string {
  const word = value.trim().toLowerCase();
  const name = ALIASES[word] ?? word;
  return (MODIFIERS as readonly string[]).includes(name) ? name : normalKeys(word);
}

/**
 * A timeline from what was stored or sent (a JSON array, or the array itself),
 * made safe to keep: times whole, in order and inside the limit, keys spelled
 * one way, at most 24 rows. Anything unreadable is an empty timeline.
 */
export function parseTimeline(raw: unknown): TimelineBar[] {
  let list: unknown = raw;
  if (typeof raw === 'string') {
    try {
      list = raw.trim() ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const out: TimelineBar[] = [];
  for (const item of list.slice(0, TIMELINE_LIMITS.bars)) {
    if (!item || typeof item !== 'object') continue;
    const bar = item as Partial<TimelineBar>;
    const clamp = (n: unknown) => Math.max(0, Math.min(TIMELINE_LIMITS.totalMs, Math.round(Number(n) || 0)));
    const at = Math.min(clamp(bar.at), TIMELINE_LIMITS.totalMs - TIMELINE_LIMITS.shortestMs);
    const until = Math.max(at + TIMELINE_LIMITS.shortestMs, clamp(bar.until));
    const keys = typeof bar.keys === 'string' ? barKeys(bar.keys) : '';
    out.push(bar.ifUp ? { keys, at, until, ifUp: true, ...(bar.keepGap ? { keepGap: true } : {}) } : { keys, at, until });
  }
  return out;
}

/**
 * How much sooner the rest starts when this row is skipped: the time to the
 * next key going down after it. Zero when nothing presses after it, or when
 * the row keeps to the clock. Shown under the row; played by `runTimeline`.
 */
export function soonerIfSkipped(bars: TimelineBar[], i: number): number {
  const bar = bars[i];
  if (!bar?.ifUp || bar.keepGap) return 0;
  const next = bars.filter((b, j) => j !== i && b.keys && b.at > bar.at).reduce((t, b) => Math.min(t, b.at), Infinity);
  return Number.isFinite(next) ? next - bar.at : 0;
}

/** What playing a timeline needs from the PC, so the order and timing can be tested with a fake. */
export interface TimelineIO {
  /** Whether these keys are all held right now. */
  held(keys: string): boolean;
  press(keys: string, down: boolean): void;
  /** Resolves once this many ms have passed since the timeline started. */
  at(ms: number): Promise<void>;
}

/**
 * Play a timeline: each row down at its `at` and up at its `until`, timed
 * from the start rather than after the step before, so a late moment does not
 * push every later one back. At one moment a let-go comes before a press, so
 * a key ending where the next bar of it starts is pressed again, not lost. A
 * row skipped because you hold its keys is left alone at both ends, and moves
 * what follows up by `soonerIfSkipped`.
 */
export async function runTimeline(raw: unknown, io: TimelineIO): Promise<void> {
  const bars = playable(parseTimeline(raw));
  const moments = bars
    .flatMap((b, i) => [
      { t: b.at, i, down: true },
      { t: b.until, i, down: false },
    ])
    .sort((a, b) => a.t - b.t || Number(a.down) - Number(b.down));
  const pressed = new Set<number>();
  let sooner = 0;
  for (const m of moments) {
    await io.at(Math.max(0, m.t - sooner));
    const bar = bars[m.i]!;
    if (m.down) {
      if (bar.ifUp && io.held(bar.keys)) {
        sooner += soonerIfSkipped(bars, m.i);
        continue;
      }
      io.press(bar.keys, true);
      pressed.add(m.i);
    } else if (pressed.delete(m.i)) {
      io.press(bar.keys, false);
    }
  }
}

/** The rows that will actually be played: ones with a key. */
export const playable = (bars: TimelineBar[]) => bars.filter((b) => b.keys);

/** How long a timeline takes, from the first press to the last let-go. */
export const timelineLength = (bars: TimelineBar[]) => bars.reduce((end, b) => Math.max(end, b.until), 0);
