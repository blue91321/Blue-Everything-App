/**
 * System-wide key combinations, for the two things the wake word cannot do.
 *
 * The wake word is for when your hands are busy. These are for when they are
 * not, and one of them does something the wake word structurally cannot:
 * **switch voice on**. A microphone that is off cannot hear you ask for it to
 * be turned on, so without a hotkey the only ways back were the tray, a browser
 * tab, or the phone.
 *
 * ### The two keys live in the voice package; registering them is core's
 *
 * Both hotkeys are about voice, so deleting the package should take them with
 * it. That works because the *module* keeps running while the feature is merely
 * switched off — `voiceEnabled: false` disposes the speech models and closes the
 * microphone, but the agent half is still loaded and still polling, which is how
 * it learns to turn back on.
 *
 * The registering itself (a message window, `RegisterHotKey`, the pump) moved
 * to `agent/src/hotkeys.ts` when blueprints wanted hotkeys too: two copies of
 * it would define the same koffi structs twice, which throws at import time.
 * This file is the voice-shaped face on it.
 */
import { createHotkeys as createSystemHotkeys, HotkeysUnavailable } from '../../../agent/src/hotkeys.js';

export { HotkeysUnavailable };

export type HotkeyAction = 'toggle' | 'listen';

export interface HotkeyBinding {
  action: HotkeyAction;
  /** As typed, e.g. `ctrl+alt+v`. */
  combo: string;
}

export interface Hotkeys {
  /** Replace every registration with this set. */
  apply(bindings: HotkeyBinding[]): void;
  /** What could not be registered, and why. */
  problems(): string[];
  destroy(): void;
}

export function createHotkeys(onPress: (action: HotkeyAction) => void): Hotkeys {
  const keys = createSystemHotkeys('EverythingVoiceHotkeys', (id) => onPress(id as HotkeyAction));
  return {
    apply: (bindings) => keys.apply(bindings.map((b) => ({ id: b.action, combo: b.combo }))),
    problems: () => keys.problems(),
    destroy: () => keys.destroy(),
  };
}
