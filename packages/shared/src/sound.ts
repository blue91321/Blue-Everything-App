/**
 * The notification tones: what they are, and how they turn into a WAV.
 *
 * ### Why this is in `shared` rather than in the agent that plays them
 *
 * It started in `packages/agent/src/sound.ts`, which was the right home while
 * the agent was the only thing that could make a noise. Then the Settings screen
 * gained a tone picker, and a picker you cannot hear is a list of nine words —
 * `knock` and `blip` are not self-describing, and the only way to choose between
 * them was a terminal command.
 *
 * The browser cannot ask the agent to play one: the agent has no inbound
 * connection, so a preview would ride the attention heartbeat and arrive five to
 * fifteen seconds after the click. That is not a preview, it is a delayed
 * surprise. And it would not work from the phone at all, where the setting is
 * equally editable.
 *
 * So the *server* renders the WAV and serves it, and the browser plays it. Which
 * means the shapes have to live somewhere both the server and the agent can
 * reach — here. **The preview is therefore byte-identical to what you will
 * actually hear**, because both sides call the same `wav()` over the same table,
 * rather than being a second implementation that sounds nearly the same. This
 * project already fails a build over `ACCENT_HEX` drifting from `styles.css`;
 * a hand-rolled Web Audio approximation in the PWA would be the same mistake
 * with no check under it.
 *
 * The PWA still does not import this package — it fetches `/sounds/<tone>.wav`
 * as bytes, exactly as it fetches its icons.
 *
 * ### No audio files in the repo
 *
 * The same reasoning that has the app icons drawn by `make-icons.mjs` rather
 * than checked in: a WAV header is 44 bytes of arithmetic and a sine is one
 * line, so binaries in git would buy nothing.
 */

/** Sample rate. Low on purpose — these are blips, not music. */
export const TONE_SAMPLE_RATE = 22_050;

/**
 * One tone, or a short sequence of them.
 *
 * Deliberately plain: two or three sine blips with a quick fade. Anything more
 * elaborate would need a real sound designer and a real file, and this is a
 * notification, not a game.
 */
export interface Blip {
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
 * Nine arrays of numbers is also the whole implementation, where a tone editor
 * would need a UI, a storage format and a way to preview an unsaved one.
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

export function isToneName(value: string): value is ToneName {
  return value in TONES;
}

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

/**
 * A 16-bit mono PCM WAV, by hand.
 *
 * The envelope is not decoration. A sine cut off mid-cycle produces a click,
 * which on a short blip is most of what you hear — so each tone fades in and out
 * over a few milliseconds, and that is the difference between a note and a tick.
 *
 * Returns `Uint8Array` rather than `Buffer`: this file is imported by the server
 * and the agent, both of which are Node, but nothing here needs Node to be true
 * and a `Buffer` in the signature would make it so.
 */
export function wav(blips: readonly Blip[]): Uint8Array {
  const rate = TONE_SAMPLE_RATE;
  const samples: number[] = [];

  for (const blip of blips) {
    const count = Math.round((rate * blip.ms) / 1000);
    const fade = Math.min(Math.round(rate * 0.004), Math.floor(count / 2));

    for (let i = 0; i < count; i++) {
      const envelope = Math.min(1, i / fade, (count - i) / fade);
      const value = Math.sin((2 * Math.PI * blip.hz * i) / rate) * (blip.gain ?? 0.7) * envelope;
      samples.push(Math.round(value * 32767));
    }
  }

  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // bytes per second
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  samples.forEach((value, i) => view.setInt16(44 + i * 2, value, true));

  return bytes;
}
