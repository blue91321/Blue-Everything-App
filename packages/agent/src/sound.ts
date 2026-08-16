/**
 * Playing a tone on this machine.
 *
 * ### The shapes are not here any more
 *
 * `TONES`, the palette, and the WAV encoder moved to `@everything/shared/sound`
 * when the Settings screen gained an audible tone picker. The browser cannot ask
 * this process to play one — the agent has no inbound connection, so a preview
 * would ride the attention heartbeat and land five to fifteen seconds after the
 * click, and would not work at all from the phone. So the server renders the
 * bytes and the browser plays them, which means the shapes have to be somewhere
 * both processes can reach.
 *
 * The gain is not tidiness. **The preview is byte-identical to what you hear
 * here**, because both sides call the same `wav()` over the same table rather
 * than being two implementations that sound nearly the same.
 *
 * What is left in this file is the part that is genuinely about this machine:
 * winmm, a temp file, and which tone each event is currently pointed at.
 *
 * ### PlaySoundW, not PowerShell
 *
 * A toast is rare and can afford a few hundred milliseconds to spawn a process.
 * A sound accompanies the wake word, where a few hundred milliseconds is the
 * entire point missed. `PlaySoundW` out of winmm is the same library `mic.ts`
 * already loads, costs no process, and returns immediately with `SND_ASYNC`.
 *
 * `SND_NOSTOP` is deliberately *not* used: a newer sound should cut off an older
 * one rather than being dropped, because the newest is always the one describing
 * what just happened.
 */
import koffi from 'koffi';
import { writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TONE, SOUND_EVENTS, TONES, wav, type SoundName, type ToneName } from '@everything/shared/sound';

/*
 * Re-exported so the CLIs and the rest of the agent carry on importing `sound.js`
 * for anything to do with sound. A dozen call sites reaching into `shared` for
 * the names and into here for the playing would be the move made visible for no
 * benefit — this module is still the agent's answer to "make a noise".
 */
export { DEFAULT_TONE, SOUND_EVENTS, TONES, TONE_NAMES } from '@everything/shared/sound';
export type { Blip, SoundName, ToneName } from '@everything/shared/sound';

const winmm = koffi.load('winmm.dll');

const PlaySoundW = winmm.func('int __stdcall PlaySoundW(const char16_t *sound, void *module, uint32_t flags)');

const SND_ASYNC = 0x0001;
const SND_FILENAME = 0x00020000;
/** Don't block, and don't complain, if the device is busy or absent. */
const SND_NODEFAULT = 0x0002;

/** What each event is currently set to. Pushed in from settings. */
const chosen: Record<SoundName, ToneName> = { ...DEFAULT_TONE };

/**
 * Point an event at a different tone.
 *
 * Unknown names are ignored rather than throwing: this arrives over HTTP from a
 * settings row, and a tone renamed in a later version must not stop the agent
 * making any noise at all. The default stands until it is recognised.
 */
export function setTones(next: Partial<Record<string, string>>): void {
  for (const event of SOUND_EVENTS) {
    const want = next[event];
    if (want && want in TONES) chosen[event] = want as ToneName;
    else if (want === undefined) chosen[event] = DEFAULT_TONE[event];
  }
}

export function toneFor(event: SoundName): ToneName {
  return chosen[event];
}

/** Written once per process, reused after. */
const files = new Map<ToneName, string>();

function fileFor(tone: ToneName): string {
  const cached = files.get(tone);
  if (cached) return cached;

  const path = join(tmpdir(), `everything-tone-${tone}.wav`);
  // Keyed by *tone*, not by event, so two events set to the same tone share one
  // file — and changing an event's tone is a lookup rather than a rewrite.
  // Rewritten on a fresh process even if it exists, so editing the palette here
  // takes effect on restart rather than being masked by a stale temp file.
  if (!existsSync(path) || !files.has(tone)) writeFileSync(path, wav(TONES[tone]));

  files.set(tone, path);
  return path;
}

let enabled = true;

/** Follows the setting; the agent pushes this on every heartbeat. */
export function setSoundEnabled(on: boolean): void {
  enabled = on;
}

export function soundEnabled(): boolean {
  return enabled;
}

/**
 * Play one, and never let it matter.
 *
 * A machine with no sound card, a locked device, a temp directory that cannot be
 * written — none of those are a reason for a nudge to fail or a voice command to
 * be lost. The sound is the least important thing happening at this moment.
 */
export function playSound(name: SoundName): void {
  if (!enabled) return;
  playTone(chosen[name]);
}

/**
 * Play a tone by name, whatever it is attached to.
 *
 * Separate from `playSound` so the settings screen can preview one without
 * having to pretend an event happened, and so `none` is handled in exactly one
 * place: an empty tone is silence, not a zero-length WAV that clicks.
 */
export function playTone(tone: ToneName): void {
  if (TONES[tone].length === 0) return;
  try {
    PlaySoundW(fileFor(tone), null, SND_ASYNC | SND_FILENAME | SND_NODEFAULT);
  } catch {
    // Deliberately silent, in both senses.
  }
}

/** Used by the CLI to hear them all without waiting for the real events. */
export function soundNames(): SoundName[] {
  return [...SOUND_EVENTS];
}
