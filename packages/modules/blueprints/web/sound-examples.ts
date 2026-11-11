/**
 * Sounds to start from in "Make your own sound", built rather than stored so
 * the numbers that make them are readable. Both are "hello", asked for as
 * something to show how speech can be drawn with lines (2026-11-07):
 *
 * - **Whistled** (`helloFormants`): sine-wave speech. A voice is a buzz shaped
 *   by the mouth, and the shape shows as a few bands where the sound is
 *   strongest, the formants. Three lines following the first three formants
 *   are enough to carry the word, though it sounds like whistling and is
 *   easiest to hear once you know what it says.
 * - **Voiced** (`helloVoiced`): additive synthesis. A line per harmonic of a
 *   speaking pitch (about 100 to 140 Hz, so 100, 200, 300... Hz), each as loud
 *   as the formants at that moment let it be. This is the same as the whistled
 *   one with a pitch under it, so it buzzes like a voice.
 *
 * The "h" is breath, which is noise, and these lines are tones, so it is only
 * the vowel starting quietly. Only types are imported, so `blueprints-check`
 * can build both and check they fit.
 */
import type { SoundLine } from './sound-design.js';

/**
 * "Hello" as a man says it, every few tens of milliseconds: when, the speaking
 * pitch, the first three formants, and how loud. The values are the usual ones
 * for these sounds: /ɛ/ has its formants near 550, 1800 and 2500 Hz, a dark /l/
 * pulls the second down near 1000, and /oʊ/ starts near 500 and 900 and closes
 * towards /u/.
 */
const HELLO: Array<{ t: number; f0: number; f: [number, number, number]; v: number }> = [
  { t: 0, f0: 118, f: [500, 1750, 2500], v: 0.1 }, // h: the vowel's shape, breathed
  { t: 60, f0: 128, f: [550, 1800, 2550], v: 0.6 },
  { t: 150, f0: 140, f: [560, 1750, 2500], v: 1 }, // e
  { t: 200, f0: 136, f: [400, 1150, 2650], v: 0.55 }, // l
  { t: 270, f0: 128, f: [390, 1000, 2650], v: 0.5 },
  { t: 330, f0: 124, f: [500, 950, 2500], v: 1 }, // o
  { t: 450, f0: 114, f: [470, 860, 2450], v: 0.9 },
  { t: 560, f0: 104, f: [410, 770, 2400], v: 0.55 }, // closing towards u
  { t: 650, f0: 98, f: [370, 720, 2400], v: 0 },
];

/** The word at a moment, between the rows above. */
function helloAt(t: number) {
  const i = Math.max(
    0,
    HELLO.findIndex((r, k) => k < HELLO.length - 1 && t >= r.t && t <= HELLO[k + 1]!.t)
  );
  const a = HELLO[i]!;
  const b = HELLO[Math.min(i + 1, HELLO.length - 1)]!;
  const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  const mix = (x: number, y: number) => x + (y - x) * u;
  return { f0: mix(a.f0, b.f0), f: [mix(a.f[0], b.f[0]), mix(a.f[1], b.f[1]), mix(a.f[2], b.f[2])] as const, v: mix(a.v, b.v) };
}

/** Three lines, one per formant, the higher ones quieter as they are in a voice. */
export function helloFormants(): SoundLine[] {
  const weights = [1, 0.55, 0.3];
  return weights.map((gain, k) => ({
    wave: 'sine' as const,
    gain,
    points: HELLO.map((r) => ({ t: r.t, hz: Math.round(r.f[k]!), v: Math.round(r.v * 100) / 100 })),
  }));
}

/**
 * A line per harmonic, its loudness at each moment how near it is to a formant
 * then: each formant is a resonance, a bump of a given width (wider for the
 * higher ones), and a harmonic is as loud as the bumps it sits under. Points
 * every 25 ms, enough for the formants' movement; harmonics up to about 4 kHz,
 * past which a voice has little; one that never gets above a whisper is left
 * out, since it adds a line and nothing to hear.
 */
export function helloVoiced(): SoundLine[] {
  const formantWeight = [1, 0.6, 0.35];
  const width = [90, 110, 170];
  const end = HELLO[HELLO.length - 1]!.t;
  const times = Array.from({ length: Math.floor(end / 25) + 1 }, (_, i) => i * 25);
  const top = Math.floor(3800 / Math.max(...HELLO.map((r) => r.f0)));
  const raw: Array<Array<{ t: number; hz: number; v: number }>> = [];
  let loudest = 0;
  for (let n = 1; n <= top; n++) {
    raw.push(
      times.map((t) => {
        const at = helloAt(t);
        const hz = n * at.f0;
        const shape = at.f.reduce((sum, fk, k) => sum + formantWeight[k]! / (1 + ((hz - fk) / width[k]!) ** 2), 0);
        const v = shape * at.v;
        loudest = Math.max(loudest, v);
        return { t, hz, v };
      })
    );
  }
  return raw
    .map((pts) => pts.map((p) => ({ t: p.t, hz: Math.round(p.hz), v: Math.round((p.v / loudest) * 100) / 100 })))
    .filter((pts) => Math.max(...pts.map((p) => p.v)) >= 0.04)
    .map((points) => ({ wave: 'sine' as const, gain: 1, points }));
}

/** Harmonics of a line, ×2 up to ×n: the same shape at whole-number multiples of its pitch, each quieter by its number, as in a plucked or bowed note. Any that would go past 12 kHz is left out. */
export function harmonicsOf(line: SoundLine, n: number): SoundLine[] {
  const out: SoundLine[] = [];
  for (let k = 2; k <= n; k++) {
    if (line.points.some((p) => p.hz * k > 12_000)) break;
    out.push({ wave: 'sine', gain: Math.round((line.gain / k) * 100) / 100, points: line.points.map((p) => ({ ...p, hz: Math.round(p.hz * k) })) });
  }
  return out;
}
