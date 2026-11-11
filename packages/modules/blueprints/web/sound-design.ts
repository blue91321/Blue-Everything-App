/**
 * The sounds a "Play a sound" box can make besides the app's own tones: a click
 * of a few kinds, and a sound of your own, drawn as lines of pitch over time
 * (any number of points, lines overlapping as you like), each repeated as often
 * as asked. A beep and a sweep were kinds of their own until 2026-11-07; a box
 * saved with one is read as a sound of one line (`shapeFromBeep`). Drawn as numbers
 * and written as a WAV by hand, as the app's tones are, so nothing is shipped.
 *
 * One file for both ends: the board's ▶ plays these bytes in the browser and
 * the PC writes the very same bytes to a file and plays that, so what is heard
 * while setting a box up is what the box plays. The noise in a click comes
 * from a fixed seed for the same reason. Its one import is `speech.ts`, which
 * has none, so `blueprints-check`
 * asserts it.
 */

import { speechInputOf, speechLength, speechSamples, type SpeechInput } from './speech.js';

export const SOUND_RATE = 44_100;
/** However many times and however long, no sound runs past this: it is a signal, not music. */
export const MAX_SOUND_MS = 10_000;

export type Wave = 'sine' | 'square' | 'triangle' | 'saw';
export type ClickKind = 'tick' | 'tap' | 'pop' | 'snap' | 'wood';

/**
 * A point on a line: when, in ms from the start, the pitch there and, from
 * 0 to 1, how loud the line is there (1 when absent). Loudness moves straight
 * from point to point, which is what lets a harmonic swell and fade as a voice's
 * do, and is what speech is mostly made of.
 */
export interface SoundPoint {
  t: number;
  hz: number;
  v?: number;
}

/**
 * One line of a drawn sound: its pitch moves from point to point by equal steps
 * of the ear, in its own wave, at its own loudness (0 to 1). Two points at the
 * same moment are a jump.
 */
export interface SoundLine {
  wave: Wave;
  gain: number;
  points: SoundPoint[];
}

/**
 * Sixty-four lines of 128 points: room for a voice of thirty-odd harmonics
 * with a point every 25 ms. It was eight of 32 until asked for harmonics and
 * a spoken "hello" (2026-11-07); eight was only a guess at what a sound needs.
 */
export const SHAPE_LIMITS = { lines: 64, points: 128, ms: 5000 } as const;
const DEFAULT_LINES: SoundLine[] = [{ wave: 'sine', gain: 1, points: [{ t: 0, hz: 880 }, { t: 120, hz: 880 }] }];

export interface SoundDesign {
  kind: 'click' | 'custom' | 'speech';
  /** For text to speech: the words and how to say them. */
  speech?: SpeechInput;
  lines: SoundLine[];
  click: ClickKind;
  /** 0 to 1. */
  volume: number;
  times: number;
  gap: number;
  fade: number;
}

const WAVES: Wave[] = ['sine', 'square', 'triangle', 'saw'];
const CLICKS: ClickKind[] = ['tick', 'tap', 'pop', 'snap', 'wood'];
const clamp = (n: unknown, lo: number, hi: number, fallback: number) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
};

/**
 * A drawn sound as the box keeps it (JSON text), cleaned: at most eight lines
 * of 32 points, each line in time order and at least 5 ms long, pitches 20 Hz
 * to 12 kHz, nothing past five seconds. Text that is not a sound at all reads
 * as the default beep; an empty list of lines is kept, and is silence.
 */
export function parseSoundShape(raw: unknown): SoundLine[] {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      value = null;
    }
  }
  const list = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { lines?: unknown }).lines)
      ? (value as { lines: unknown[] }).lines
      : null;
  if (!list) return DEFAULT_LINES.map((l) => ({ ...l, points: l.points.map((p) => ({ ...p })) }));
  const lines: SoundLine[] = [];
  for (const item of list) {
    if (lines.length >= SHAPE_LIMITS.lines) break;
    if (!item || typeof item !== 'object') continue;
    const line = item as { wave?: unknown; gain?: unknown; points?: unknown };
    const points = (Array.isArray(line.points) ? (line.points as unknown[]) : [])
      .slice(0, SHAPE_LIMITS.points)
      .map((p) =>
        Array.isArray(p)
          ? { t: Number(p[0]), hz: Number(p[1]), v: p[2] }
          : { t: Number((p as SoundPoint | null)?.t), hz: Number((p as SoundPoint | null)?.hz), v: (p as SoundPoint | null)?.v }
      )
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.hz))
      .map((p) => {
        const point: SoundPoint = { t: Math.round(clamp(p.t, 0, SHAPE_LIMITS.ms, 0)), hz: Math.round(clamp(p.hz, 20, 12_000, 880)) };
        const v = Math.round(clamp(p.v, 0, 1, 1) * 100) / 100;
        if (v < 1) point.v = v;
        return point;
      })
      .sort((a, b) => a.t - b.t);
    if (points.length < 2 || points[points.length - 1]!.t - points[0]!.t < 5) continue;
    lines.push({
      wave: WAVES.includes(line.wave as Wave) ? (line.wave as Wave) : 'sine',
      gain: Math.round(clamp(line.gain, 0, 1, 1) * 100) / 100,
      points,
    });
  }
  return lines;
}

/** Lines as the box keeps them: short, since points are pairs. */
export function soundShapeText(lines: SoundLine[]): string {
  return JSON.stringify({ lines: lines.map((l) => ({ wave: l.wave, gain: l.gain, points: l.points.map((p) => (p.v !== undefined && p.v < 1 ? [p.t, p.hz, p.v] : [p.t, p.hz])) })) });
}

/** A beep or a sweep, as a box saved one before 2026-11-07: one line, flat or from one pitch to another. */
export function shapeFromBeep(fields: Record<string, unknown>): SoundLine[] {
  const hz = Math.round(clamp(fields.hz, 20, 12_000, 880));
  const toHz = fields.sound === 'sweep' ? Math.round(clamp(fields.toHz, 20, 12_000, 220)) : hz;
  const ms = Math.round(clamp(fields.ms, 5, 3000, 120));
  const wave = WAVES.includes(fields.wave as Wave) ? (fields.wave as Wave) : 'sine';
  return [{ wave, gain: 1, points: [{ t: 0, hz }, { t: ms, hz: toHz }] }];
}

/** When a drawn sound's last line ends, in ms. */
export function shapeLength(lines: SoundLine[]): number {
  return lines.reduce((end, l) => Math.max(end, l.points[l.points.length - 1]!.t), 0);
}

/** A box's fields as a sound to draw, or null for a tone or a file, which are played as they are. */
export function designOf(fields: Record<string, unknown>): SoundDesign | null {
  const kind = fields.sound;
  if (kind === 'speech') {
    return { kind, lines: [], click: 'tick', volume: clamp(fields.volume, 0, 100, 50) / 100, times: 1, gap: 0, fade: 0, speech: speechInputOf(fields) };
  }
  if (kind !== 'custom' && kind !== 'click' && kind !== 'beep' && kind !== 'sweep') return null;
  return {
    kind: kind === 'click' ? 'click' : 'custom',
    lines: kind === 'beep' || kind === 'sweep' ? shapeFromBeep(fields) : kind === 'custom' ? parseSoundShape(fields.shape) : [],
    click: CLICKS.includes(fields.click as ClickKind) ? (fields.click as ClickKind) : 'tick',
    volume: clamp(fields.volume, 0, 100, 50) / 100,
    times: Math.round(clamp(fields.times, 1, 20, 1)),
    gap: clamp(fields.gap, 0, 2000, 80),
    fade: clamp(fields.fade, 0, 500, 5),
  };
}

/** How long one of a click lasts, in ms. */
const CLICK_MS: Record<ClickKind, number> = { tick: 8, tap: 14, pop: 45, snap: 10, wood: 30 };

/** How long the whole thing plays, repeats and gaps included, in ms. */
export function designLength(d: SoundDesign): number {
  if (d.kind === 'speech') return Math.min(MAX_SOUND_MS, speechLength(d.speech!));
  const one = d.kind === 'click' ? CLICK_MS[d.click] : shapeLength(d.lines);
  if (one <= 0) return 0;
  return Math.min(MAX_SOUND_MS, one * d.times + d.gap * (d.times - 1));
}

/** A fixed-seed noise source, so a click sounds the same every time and everywhere. */
function noise(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

/** One wave's value at a point in its cycle, -1 to 1 (the edged ones kept down): what the graph draws. */
export function waveAt(wave: Wave, phase: number): number {
  return shape(wave, phase);
}

function shape(wave: Wave, phase: number): number {
  const t = phase / (2 * Math.PI);
  const frac = t - Math.floor(t);
  switch (wave) {
    case 'sine':
      return Math.sin(phase);
    // The edged shapes are much louder to the ear at the same peak, so they are kept down.
    case 'square':
      return (frac < 0.5 ? 1 : -1) * 0.45;
    case 'triangle':
      return (frac < 0.5 ? 4 * frac - 1 : 3 - 4 * frac) * 0.9;
    case 'saw':
      return (2 * frac - 1) * 0.5;
  }
}

/**
 * One line, added into `out` where it falls: between two points the pitch moves
 * by equal steps of the ear (exponentially) and the loudness in a straight
 * line, and the phase is carried across the points, so a bend is smooth and
 * only a jump changes the pitch at once. Worked segment by segment, the pitch
 * multiplied by a fixed step each sample rather than raised to a power: with
 * sixty-four lines that is most of the cost of drawing the sound.
 */
function addLine(line: SoundLine, fadeMs: number, rate: number, out: Float32Array): void {
  const p = line.points;
  const start = Math.round((rate * p[0]!.t) / 1000);
  const end = Math.min(out.length, Math.round((rate * p[p.length - 1]!.t) / 1000));
  const n = end - start;
  if (n <= 0) return;
  // A fade of at least a millisecond: a sound cut off mid-wave clicks.
  const fade = Math.min(Math.round((rate * Math.max(fadeMs, 1)) / 1000), Math.floor(n / 2));
  const turn = (2 * Math.PI) / rate;
  let phase = 0;
  for (let s = 0; s < p.length - 1; s++) {
    const a = p[s]!;
    const b = p[s + 1]!;
    const i0 = Math.max(start, Math.round((rate * a.t) / 1000));
    const i1 = Math.min(end, Math.round((rate * b.t) / 1000));
    const len = i1 - i0;
    if (len <= 0) continue;
    const step = (b.hz / a.hz) ** (1 / len);
    const va = a.v ?? 1;
    const dv = ((b.v ?? 1) - va) / len;
    let f = a.hz;
    for (let k = 0; k < len; k++) {
      const i = i0 + k;
      phase += turn * f;
      f *= step;
      const j = i - start;
      const env = fade > 0 ? Math.min(1, j / fade, (n - 1 - j) / fade) : 1;
      out[i] = out[i]! + shape(line.wave, phase) * env * (va + dv * k) * line.gain;
    }
  }
}

/**
 * Every line of a drawn sound, mixed. Lines that overlap add up, and if they
 * would go past full the whole is turned down to fit, so one line alone plays
 * exactly as loud as it did and a chord never clips.
 */
function drawn(d: SoundDesign, rate: number): Float32Array {
  const out = new Float32Array(Math.round((rate * shapeLength(d.lines)) / 1000));
  for (const line of d.lines) addLine(line, d.fade, rate, out);
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 1) for (let i = 0; i < out.length; i++) out[i] = out[i]! / peak;
  return out;
}

/** One click, by kind: each a short decaying burst, of noise or of a pitch. */
function click(kind: ClickKind, rate: number): Float32Array {
  const n = Math.round((rate * CLICK_MS[kind]) / 1000);
  const out = new Float32Array(n);
  const rnd = noise(0x5eed + kind.length);
  let prev = 0;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let v = 0;
    if (kind === 'tick') v = Math.sin(2 * Math.PI * 3200 * t) * Math.exp(-t / 0.0012);
    else if (kind === 'tap') v = rnd() * Math.exp(-t / 0.0022) * 0.9;
    else if (kind === 'snap') {
      // Noise with its low end taken off: a sharp, dry snap.
      const r = rnd();
      v = (r - prev) * 0.55 * Math.exp(-t / 0.0009);
      prev = r;
    } else if (kind === 'pop') {
      phase += (2 * Math.PI * (120 + 380 * Math.exp(-t / 0.006))) / rate;
      v = Math.sin(phase) * Math.exp(-t / 0.009);
    } else {
      // Wood: a hollow knock, a pitch with a little noise in the strike.
      v = (Math.sin(2 * Math.PI * 950 * t) * 0.8 + rnd() * 0.25 * Math.exp(-t / 0.001)) * Math.exp(-t / 0.005);
    }
    // In over a few samples, so the start itself is not a second click.
    out[i] = v * Math.min(1, i / 8);
  }
  return out;
}

/** The whole sound, as samples from -1 to 1. */
export function designSamples(d: SoundDesign, rate = SOUND_RATE): Float32Array {
  if (d.kind === 'speech') {
    const said = speechSamples(d.speech!, rate);
    for (let i = 0; i < said.length; i++) said[i] = said[i]! * d.volume;
    return said;
  }
  const one = d.kind === 'click' ? click(d.click, rate) : drawn(d, rate);
  if (one.length === 0) return one;
  const gap = Math.round((rate * d.gap) / 1000);
  const total = Math.min(Math.round((rate * MAX_SOUND_MS) / 1000), one.length * d.times + gap * (d.times - 1));
  const out = new Float32Array(total);
  for (let k = 0; k < d.times; k++) {
    const at = k * (one.length + gap);
    for (let i = 0; i < one.length && at + i < total; i++) out[at + i] = one[i]! * d.volume;
  }
  return out;
}

/** A 16-bit mono PCM WAV. */
export function wavOf(samples: Float32Array, rate = SOUND_RATE): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((v, i) => view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, v)) * 32767), true));
  return bytes;
}

/** The bytes a box plays, or null for a tone or a file. */
export function designWav(fields: Record<string, unknown>): Uint8Array | null {
  const d = designOf(fields);
  return d ? wavOf(designSamples(d)) : null;
}

/**
 * A .wav or .mp3 on the PC, as the box may name one: a full path on one of its
 * own drives. Never a network path, since playing `\\somewhere\x.mp3` would
 * have Windows sign in to that machine to fetch it.
 */
export function localSoundPath(raw: unknown): string | null {
  const path = String(raw ?? '').trim().replace(/^"(.*)"$/, '$1');
  if (!/^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}/.test(path) || !/\.(wav|mp3)$/i.test(path) || path.length > 400) return null;
  // MCI reads the path inside quotes; one in the path would end it early.
  if (path.includes('"')) return null;
  return path;
}
