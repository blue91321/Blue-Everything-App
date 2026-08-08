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

export const SOUNDS = {
  /** It heard the wake word and is listening — rising, "go ahead". */
  wake: [
    { hz: 660, ms: 70 },
    { hz: 880, ms: 90 },
  ],
  /** A command worked — a brief two-note confirmation. */
  ok: [
    { hz: 880, ms: 70 },
    { hz: 1170, ms: 110 },
  ],
  /** Heard, not understood — falling, and quieter, because it is not an alarm. */
  miss: [
    { hz: 520, ms: 80, gain: 0.5 },
    { hz: 390, ms: 130, gain: 0.5 },
  ],
  /** A nudge has arrived. Lower and slower, so it does not sound like an error. */
  nudge: [
    { hz: 587, ms: 110 },
    { hz: 784, ms: 110 },
    { hz: 988, ms: 160 },
  ],
} satisfies Record<string, Blip[]>;

export type SoundName = keyof typeof SOUNDS;

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
const files = new Map<SoundName, string>();

function fileFor(name: SoundName): string {
  const cached = files.get(name);
  if (cached) return cached;

  const path = join(tmpdir(), `everything-${name}.wav`);
  // Rewritten on a fresh process even if it exists, so changing a tone here
  // takes effect on restart rather than being masked by a stale temp file.
  if (!existsSync(path) || !files.has(name)) writeFileSync(path, wav(SOUNDS[name]));

  files.set(name, path);
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
  try {
    PlaySoundW(fileFor(name), null, SND_ASYNC | SND_FILENAME | SND_NODEFAULT);
  } catch {
    // Deliberately silent, in both senses.
  }
}

/** Used by the CLI to hear them all without waiting for the real events. */
export function soundNames(): SoundName[] {
  return Object.keys(SOUNDS) as SoundName[];
}
