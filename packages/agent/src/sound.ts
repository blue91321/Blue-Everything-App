/**
 * Short sounds, generated rather than shipped.
 *
 * ### No audio files in the repo
 *
 * The same reasoning that has the app icons drawn by `make-icons.mjs` instead of
 * checked in: a WAV header is 44 bytes of arithmetic and a sine wave is one line,
 * so a handful of binaries in git would buy nothing and cost review. The tones
 * are written to the temp directory the first time they are asked for and reused
 * from there.
 *
 * ### PlaySoundW, not PowerShell
 *
 * `notify.ts` spawns PowerShell for toasts and is right to — a toast is rare and
 * a few hundred milliseconds does not matter. A sound is the opposite: it
 * accompanies the wake word, so a few hundred milliseconds is the entire point
 * missed. `PlaySoundW` out of winmm is the same library `mic.ts` already loads,
 * costs no process, and returns immediately with `SND_ASYNC`.
 *
 * `SND_NOSTOP` is deliberately *not* used: a newer sound should cut off an older
 * one rather than being dropped, because the newest is always the one describing
 * what just happened.
 */
import koffi from 'koffi';
import { writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const winmm = koffi.load('winmm.dll');

const PlaySoundW = winmm.func('int __stdcall PlaySoundW(const char16_t *sound, void *module, uint32_t flags)');

const SND_ASYNC = 0x0001;
const SND_FILENAME = 0x00020000;
/** Don't block, and don't complain, if the device is busy or absent. */
const SND_NODEFAULT = 0x0002;

const RATE = 22_050;

/**
 * One tone, or a short sequence of them.
 *
 * Deliberately plain: two or three sine blips with a quick fade. Anything more
 * elaborate would need a real sound designer and a real file, and this is a
 * notification, not a game.
 */
interface Blip {
  /** Hz. */
  hz: number;
  /** Milliseconds. */
  ms: number;
  /** 0-1, before the envelope. */
  gain?: number;
}

/**
 * The palette, keyed by the name stored in settings.
 *
 * A named list rather than a synth editor with sliders for frequency and
 * duration. The thing anybody actually wants from "customise the tones" is for
 * the wake sound to be distinguishable from the nudge sound and for neither to
 * be irritating — that is a choice between a dozen options, not a design task.
 * Twelve arrays of numbers is also the whole implementation, where a tone
 * editor would need a UI, a storage format and a way to preview an unsaved one.
 */
export const TONES = {
  none: [],
  rise: [
    { hz: 660, ms: 70 },
    { hz: 880, ms: 90 },
  ],
  fall: [
    { hz: 880, ms: 70 },
    { hz: 660, ms: 90 },
  ],
  chime: [
    { hz: 880, ms: 70 },
    { hz: 1170, ms: 110 },
  ],
  /** Three notes climbing — reads as "something arrived" rather than "done". */
  arrive: [
    { hz: 587, ms: 110 },
    { hz: 784, ms: 110 },
    { hz: 988, ms: 160 },
  ],
  /** Deliberately quieter: a miss is information, not an alarm. */
  sink: [
    { hz: 520, ms: 80, gain: 0.5 },
    { hz: 390, ms: 130, gain: 0.5 },
  ],
  blip: [{ hz: 990, ms: 60 }],
  knock: [
    { hz: 300, ms: 55, gain: 0.6 },
    { hz: 300, ms: 55, gain: 0.6 },
  ],
  /** Low and short, for anyone who finds the rest too bright. */
  soft: [{ hz: 440, ms: 120, gain: 0.4 }],
} satisfies Record<string, Blip[]>;

export type ToneName = keyof typeof TONES;

export const TONE_NAMES = Object.keys(TONES) as ToneName[];

/**
 * The moments worth a sound, and which tone each gets unless you say otherwise.
 *
 * The *event* is fixed — these are the four things that happen — while the tone
 * is a preference. Keeping them apart is what lets the picker be a list of
 * tones rather than four separate half-settings, and what stops a renamed tone
 * breaking the code that plays it.
 */
export const SOUND_EVENTS = ['wake', 'ok', 'miss', 'nudge'] as const;
export type SoundName = (typeof SOUND_EVENTS)[number];

export const DEFAULT_TONE: Record<SoundName, ToneName> = {
  /** It heard the wake word and is listening — rising, "go ahead". */
  wake: 'rise',
  /** A command worked — a brief two-note confirmation. */
  ok: 'chime',
  /** Heard, not understood — falling, and quieter, because it is not an alarm. */
  miss: 'sink',
  /** A nudge arrived. Slower, so it does not sound like an error. */
  nudge: 'arrive',
};

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

/**
 * A 16-bit mono PCM WAV, by hand.
 *
 * The envelope is not decoration. A sine cut off mid-cycle produces a click,
 * which on a short blip is most of what you hear — so each tone fades in and out
 * over a few milliseconds, and that is the difference between a note and a tick.
 */
function wav(blips: Blip[]): Buffer {
  const samples: number[] = [];

  for (const blip of blips) {
    const count = Math.round((RATE * blip.ms) / 1000);
    const fade = Math.min(Math.round(RATE * 0.004), Math.floor(count / 2));

    for (let i = 0; i < count; i++) {
      const envelope = Math.min(1, i / fade, (count - i) / fade);
      const value = Math.sin((2 * Math.PI * blip.hz * i) / RATE) * (blip.gain ?? 0.7) * envelope;
      samples.push(Math.round(value * 32767));
    }
  }

  const body = Buffer.alloc(samples.length * 2);
  samples.forEach((value, i) => body.writeInt16LE(value, i * 2));

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + body.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28); // bytes per second
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(body.length, 40);

  return Buffer.concat([header, body]);
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
