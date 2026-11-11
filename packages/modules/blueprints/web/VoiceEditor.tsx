/**
 * Text to speech on a "Play a sound" box: what it will say, on the box, and an
 * editor for how it says it, asked for as "a separate UI that is better suited
 * to editing the voice" after a drawn "hello" proved too fiddly (2026-11-07).
 *
 * The editor shows the words as their sounds, a block each, as long as the
 * sound lasts, with the pitch line over them:
 *
 * - **The pitch line**, dots joined: drag one up or down (and along), click
 *   empty space to add one, right click to take one away. "Higher at the end"
 *   is the last dot dragged up. Until you touch it, it is the automatic line
 *   (`autoPitch` in `speech.ts`), which falls for a statement and rises for a
 *   question.
 * - **The sounds**, below: click one to pick it, drag its right edge to make it
 *   longer or shorter, Delete to take it out. Every sound there is, grouped,
 *   with a word that has it in, is underneath: a click plays it and adds it
 *   after the one picked (or swaps it, if you choose). They can be typed too,
 *   as `HH AX L OW1`.
 *
 * Kept on the box as `voiceEdit`, for the words it was made for; change the
 * words and the edit stops applying, and the box says so. Times are shown at
 * 100% speed, as they are kept.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { wavOf, SOUND_RATE } from './sound-design';
import { normalText, parseVoiceEdit, phonemeSpec, PHONEMES, planSpeech, speechSamples, VOICES, voiceEditText, type SaidSound, type SoundGroup, type VoiceEdit } from './speech';

type Fields = Record<string, string | number>;

const W = 720;
const LEFT = 56;
const RIGHT = 18;
const PLOT_W = W - LEFT - RIGHT;
const PITCH_TOP = 14;
const PITCH_H = 150;
const WAVE_TOP = PITCH_TOP + PITCH_H + 16;
const WAVE_H = 50;
const STRIP_TOP = WAVE_TOP + WAVE_H + 12;
const STRIP_H = 46;
const TICKS_Y = STRIP_TOP + STRIP_H + 16;
const H = TICKS_Y + 8;
const LO_HZ = 50;
const HI_HZ = 600;
const DRAW_RATE = 16_000;
const GROUPS: SoundGroup[] = ['Vowels', 'Two-part vowels', 'Hums and glides', 'Hisses', 'Pops', 'Breath and pauses'];
const GROUP_CLASS: Record<SoundGroup, string> = {
  Vowels: 'vowel',
  'Two-part vowels': 'vowel',
  'Hums and glides': 'hum',
  Hisses: 'hiss',
  Pops: 'pop',
  'Breath and pauses': 'breath',
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const yOfHz = (hz: number) => PITCH_TOP + (1 - Math.log(clamp(hz, LO_HZ, HI_HZ) / LO_HZ) / Math.log(HI_HZ / LO_HZ)) * PITCH_H;
const hzOfY = (y: number) => LO_HZ * (HI_HZ / LO_HZ) ** (1 - clamp((y - PITCH_TOP) / PITCH_H, 0, 1));
const soundsText = (sounds: SaidSound[]) => sounds.map((s) => s.p + (s.stress ? '1' : '')).join(' ');

/** What a box will say, as fields: the box's words, voice and speed with the edit given. */
const inputOf = (fields: Fields, edit: VoiceEdit, speed?: number) => ({
  say: String(fields.say ?? ''),
  voice: String(fields.voice ?? 'man'),
  speed: speed ?? Number(fields.speed ?? 100),
  edit,
});

/** Plays samples in this browser, one at a time; the volume is in the samples, since an iPhone ignores an audio element's own. */
let playing: HTMLAudioElement | null = null;
function playSamples(samples: Float32Array, volume: number) {
  try {
    playing?.pause();
    if (playing?.src.startsWith('blob:')) URL.revokeObjectURL(playing.src);
    for (let i = 0; i < samples.length; i++) samples[i] = samples[i]! * volume;
    playing = new Audio(URL.createObjectURL(new Blob([wavOf(samples, SOUND_RATE) as BlobPart], { type: 'audio/wav' })));
    void playing.play().catch(() => undefined);
  } catch {
    // No audio here.
  }
}

/** On the box: what it will say, as sounds, and the button to the editor. */
export function VoiceField({ fields, onFields, onHear }: { fields: Fields; onFields: (patch: Fields) => void; onHear: (fields: Fields) => void }) {
  const [open, setOpen] = useState(false);
  const edit = parseVoiceEdit(fields.voiceEdit);
  const plan = useMemo(() => planSpeech(inputOf(fields, edit)), [fields.say, fields.voice, fields.speed, fields.voiceEdit]);
  const stale = (edit.sounds || edit.pitch) && edit.for !== normalText(String(fields.say ?? ''));
  const shown = soundsText(plan.sounds);
  return (
    <div className="bp-field bp-shape-field">
      <span className="bp-field-label">How it says it</span>
      <span className="bp-hint bp-voice-sounds">
        {shown ? `${shown.length > 60 ? `${shown.slice(0, 60)}…` : shown} · ${(plan.total / 1000).toFixed(1)} s` : 'Nothing to say yet'}
      </span>
      {(plan.edited.sounds || plan.edited.pitch) && (
        <span className="bp-hint">Changed in the voice editor: {[plan.edited.sounds && 'the sounds', plan.edited.pitch && 'the pitch'].filter(Boolean).join(' and ')}.</span>
      )}
      {stale && (
        <span className="bp-note warn">
          The changes made in the voice editor were for "{edit.for}", so with these words they are not used.{' '}
          <button type="button" onClick={() => onFields({ voiceEdit: '' })}>
            Forget them
          </button>
        </span>
      )}
      <button type="button" onClick={() => setOpen(true)} disabled={!String(fields.say ?? '').trim()}>
        Edit the voice
      </button>
      {open && <VoiceEditor fields={fields} onFields={onFields} onHear={onHear} onClose={() => setOpen(false)} />}
    </div>
  );
}

type Snapshot = { sounds: SaidSound[] | null; pitch: Array<[number, number]> | null };
type Grab =
  | { kind: 'pitch'; id: number; index: number; before: Snapshot; moved: boolean }
  | { kind: 'length'; id: number; index: number; before: Snapshot; fromX: number; fromMs: number; moved: boolean };

function VoiceEditor({ fields, onFields, onHear, onClose }: { fields: Fields; onFields: (patch: Fields) => void; onHear: (fields: Fields) => void; onClose: () => void }) {
  const say = String(fields.say ?? '');
  const forThese = normalText(say);
  const given = parseVoiceEdit(fields.voiceEdit);
  const usable = given.for === forThese;
  // What has been changed: null is "as the words say", for the sounds and for the pitch separately.
  const [sounds, setSounds] = useState<SaidSound[] | null>(usable ? given.sounds : null);
  const [pitch, setPitch] = useState<Array<[number, number]> | null>(usable ? given.pitch : null);
  const [picked, setPicked] = useState<number | null>(null);
  const [pickedPoint, setPickedPoint] = useState<number | null>(null);
  const [swap, setSwap] = useState(false);
  const [typed, setTyped] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const past = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  const [, setHistory] = useState(0);
  const grabbing = useRef<Grab | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => dialog.current?.focus(), []);

  const voice = VOICES[String(fields.voice ?? 'man')] ?? VOICES.man!;
  const robot = fields.voice === 'robot';
  const edit: VoiceEdit = { for: forThese, sounds, pitch };
  // Planned at 100% speed, as edits are kept.
  const plan = planSpeech(inputOf(fields, edit, 100));
  const total = Math.max(plan.total, 100);
  const extent = total * 1.04;
  const xOf = (ms: number) => LEFT + (ms / extent) * PLOT_W;
  const msOf = (x: number) => ((x - LEFT) / PLOT_W) * extent;
  const hzOfSt = (st: number) => voice.hz * 2 ** (st / 12);
  const stOfHz = (hz: number) => Math.round(12 * Math.log2(hz / voice.hz) * 10) / 10;
  const allSounds: SaidSound[] = plan.sounds.map(({ p, ms, stress }) => ({ p, ms, ...(stress ? { stress } : {}) }));
  const points = plan.pitchEdit;

  const samples = useMemo(() => speechSamples(inputOf(fields, edit, 100), DRAW_RATE), [say, fields.voice, JSON.stringify(sounds), JSON.stringify(pitch)]);
  const wavePath = useMemo(() => {
    const per = samples.length / (xOf(total) - LEFT || 1);
    let d = '';
    const mid = WAVE_TOP + WAVE_H / 2;
    for (let px = 0; px < PLOT_W; px++) {
      const a = Math.floor(px * per);
      if (a >= samples.length) break;
      const b = Math.min(samples.length, Math.floor((px + 1) * per));
      let lo = 0;
      let hi = 0;
      for (let i = a; i < b; i++) {
        const v = samples[i]!;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      d += `M${LEFT + px + 0.5} ${(mid - hi * (WAVE_H / 2 - 2)).toFixed(1)}V${(mid - lo * (WAVE_H / 2 - 2) + 0.01).toFixed(1)}`;
    }
    return d;
  }, [samples, extent]);

  /** Writes the edit to the box, remembering what was there for undo, and plays it. */
  const commit = (next: Snapshot, before: Snapshot = { sounds, pitch }, hear = true) => {
    past.current.push(before);
    if (past.current.length > 100) past.current.shift();
    future.current = [];
    setHistory((n) => n + 1);
    setSounds(next.sounds);
    setPitch(next.pitch);
    const text = voiceEditText({ for: forThese, sounds: next.sounds, pitch: next.pitch });
    onFields({ voiceEdit: text });
    if (hear) onHear({ ...fields, voiceEdit: text });
  };
  const restore = (s: Snapshot) => {
    setSounds(s.sounds);
    setPitch(s.pitch);
    setPicked(null);
    setPickedPoint(null);
    onFields({ voiceEdit: voiceEditText({ for: forThese, sounds: s.sounds, pitch: s.pitch }) });
    setHistory((n) => n + 1);
  };
  const undo = () => {
    const s = past.current.pop();
    if (!s) return;
    future.current.push({ sounds, pitch });
    restore(s);
  };
  const redo = () => {
    const s = future.current.pop();
    if (!s) return;
    past.current.push({ sounds, pitch });
    restore(s);
  };

  const at = (e: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };

  /** Plays one sound alone, with a vowel after a consonant so it can be heard. */
  const hearSound = (p: string) => {
    const spec = phonemeSpec(p);
    if (!spec) return;
    const alone: SaidSound[] =
      spec.group === 'Vowels' || spec.group === 'Two-part vowels'
        ? [{ p, ms: spec.ms * 2 }]
        : p === '_'
          ? []
          : [
              { p, ms: spec.ms * 1.3 },
              { p: 'AH', ms: 160 },
            ];
    if (!alone.length) return;
    playSamples(
      speechSamples({ say: '', voice: String(fields.voice ?? 'man'), speed: 100, edit: { for: '', sounds: alone, pitch: null } }, SOUND_RATE),
      Number(fields.volume ?? 50) / 100
    );
  };

  /** The palette: a click plays the sound and adds it after the one picked, or swaps the one picked for it. */
  const putSound = (p: string) => {
    hearSound(p);
    const spec = phonemeSpec(p)!;
    const list = [...allSounds];
    const item: SaidSound = { p, ms: spec.ms };
    let at = list.length;
    if (picked !== null && picked < list.length) {
      if (swap) {
        list[picked] = { ...item, ...(list[picked]!.stress && /^[AEIOU]/.test(p) ? { stress: true } : {}) };
        at = picked;
      } else {
        at = picked + 1;
        list.splice(at, 0, item);
      }
    } else list.push(item);
    setPicked(at);
    commit({ sounds: list, pitch }, undefined, false);
  };

  const removePicked = () => {
    if (picked !== null && allSounds[picked]) {
      const list = allSounds.filter((_, i) => i !== picked);
      setPicked(list.length ? Math.min(picked, list.length - 1) : null);
      commit({ sounds: list, pitch }, undefined, false);
    } else if (pickedPoint !== null && points.length > 2) {
      commit({ sounds, pitch: points.filter((_, i) => i !== pickedPoint) }, undefined, true);
      setPickedPoint(null);
    }
  };

  const toggleStress = () => {
    if (picked === null || !allSounds[picked]) return;
    const list = allSounds.map((s, i) => (i === picked ? { p: s.p, ms: s.ms, ...(s.stress ? {} : { stress: true }) } : s));
    commit({ sounds: list, pitch });
  };

  /** Typed sounds, `HH AX L OW1`: each word a sound, a 1 after a vowel stressing it; a sound already there keeps its length. */
  const takeTyped = () => {
    if (typed === null) return;
    const parts = typed
      .toUpperCase()
      .split(/[\s,]+/)
      .filter(Boolean);
    const list: SaidSound[] = [];
    const unknown: string[] = [];
    parts.forEach((part, i) => {
      const p = part.replace('1', '');
      const spec = phonemeSpec(p);
      if (!spec) {
        unknown.push(part);
        return;
      }
      const old = allSounds[i];
      list.push({ p, ms: old && old.p === p ? old.ms : spec.ms, ...(part.endsWith('1') ? { stress: true } : {}) });
    });
    setTyped(null);
    if (unknown.length) setSaid(`Not a sound here: ${unknown.join(', ')}. The sounds are the names on the buttons below.`);
    else setSaid('');
    if (list.length) commit({ sounds: list, pitch });
  };

  const press = (e: ReactPointerEvent, grab: Grab | null) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    if (!grab) return;
    svg.current?.setPointerCapture(e.pointerId);
    grabbing.current = grab;
  };

  /** Empty space in the pitch lane: a point there, on a line that is yours from then on. */
  const addPoint = (e: ReactPointerEvent) => {
    if (e.button !== 0 || robot) return;
    const p = at(e);
    const ms = clamp(Math.round(msOf(p.x)), 0, Math.round(total));
    const list: Array<[number, number]> = [...points, [ms, stOfHz(hzOfY(p.y))] as [number, number]].sort((a, b) => a[0] - b[0]);
    const index = list.findIndex((q) => q[0] === ms);
    const before = { sounds, pitch };
    setPitch(list);
    setPickedPoint(index);
    setPicked(null);
    press(e, { kind: 'pitch', id: e.pointerId, index, before, moved: true });
  };

  const move = (e: ReactPointerEvent) => {
    const g = grabbing.current;
    if (!g || g.id !== e.pointerId) return;
    g.moved = true;
    const p = at(e);
    if (g.kind === 'pitch') {
      const list = points.map((q) => [...q] as [number, number]);
      const lo = g.index > 0 ? list[g.index - 1]![0] : 0;
      const hi = g.index < list.length - 1 ? list[g.index + 1]![0] : Math.round(total);
      list[g.index] = [Math.round(clamp(msOf(p.x), lo, hi)), clamp(stOfHz(hzOfY(p.y)), -24, 24)];
      setPitch(list);
    } else {
      const ms = Math.round(clamp(g.fromMs + ((p.x - g.fromX) / PLOT_W) * extent, 10, 1000));
      setSounds(allSounds.map((s, i) => (i === g.index ? { ...s, ms } : s)));
    }
  };

  const up = (e: ReactPointerEvent) => {
    const g = grabbing.current;
    if (!g || g.id !== e.pointerId) return;
    grabbing.current = null;
    if (!g.moved) return;
    commit({ sounds, pitch }, g.before);
  };

  // The keys, heard by the window while the editor is open, as the sound editor hears its own.
  const keyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const take = (fn: () => void) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    if (ctrl && k === 'z') take(e.shiftKey ? redo : undo);
    else if (ctrl && k === 'y') take(redo);
    else if (e.key === 'Delete' || e.key === 'Backspace') take(removePicked);
    else if (e.key === 'ArrowLeft' && picked !== null) take(() => setPicked(Math.max(0, picked - 1)));
    else if (e.key === 'ArrowRight' && picked !== null) take(() => setPicked(Math.min(allSounds.length - 1, picked + 1)));
    else if (e.key === ' ' && picked !== null) take(() => hearSound(allSounds[picked]!.p));
  };
  const keys = useRef(keyDown);
  keys.current = keyDown;
  useEffect(() => {
    const heard = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', heard, true);
    return () => window.removeEventListener('keydown', heard, true);
  }, []);

  const tickStep = [10, 20, 50, 100, 200, 250, 500, 1000, 2000].find((s) => extent / s <= 8) ?? 5000;
  const ticks = Array.from({ length: Math.floor(extent / tickStep) + 1 }, (_, i) => i * tickStep);
  const pickedSound = picked !== null ? plan.sounds[picked] : undefined;
  const pickedSpec = pickedSound ? phonemeSpec(pickedSound.p) : undefined;
  // The pitch line as heard: through every point, out to both ends.
  const line = points.map(([ms, st]) => `${xOf(ms)},${yOfHz(hzOfSt(robot ? 0 : st))}`);

  return createPortal(
    <div
      className="bp-tl-overlay"
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="bp-tl bp-shape bp-voice card" role="dialog" aria-modal="true" aria-labelledby="bp-voice-title" tabIndex={-1} ref={dialog}>
        <div className="bp-tl-top">
          <h3 id="bp-voice-title">The voice: "{say.length > 40 ? `${say.slice(0, 40)}…` : say}"</h3>
          <button type="button" onClick={undo} disabled={!past.current.length} title="Undo (Ctrl+Z)">
            ↶ Undo
          </button>
          <button type="button" onClick={redo} disabled={!future.current.length} title="Redo (Ctrl+Y)">
            ↷ Redo
          </button>
          <button type="button" onClick={() => onHear({ ...fields, voiceEdit: voiceEditText(edit) })}>
            ▶ Hear it
          </button>
          <button type="button" className="primary" onClick={onClose}>
            Done
          </button>
        </div>
        <p className="meta">
          {robot
            ? 'The robot voice says everything on one note, so the pitch line does nothing; pick another voice on the box to use it.'
            : 'Drag a dot on the pitch line up or down; click the line’s lane to add a dot, right click one to take it away. Below, click a sound to pick it and drag its right edge to make it longer.'}{' '}
          Times are at 100% speed.
        </p>

        <svg
          ref={svg}
          className="bp-shape-graph bp-voice-graph"
          viewBox={`0 0 ${W} ${H}`}
          role="group"
          aria-label="The pitch and the sounds"
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onContextMenu={(e) => e.preventDefault()}
        >
          {/* Pitch */}
          <rect className="bp-shape-lane hit" x={LEFT} y={PITCH_TOP} width={PLOT_W} height={PITCH_H} onPointerDown={addPoint} />
          {[60, 100, 150, 200, 300, 400].map((hz) => (
            <g key={hz} pointerEvents="none">
              <line className="bp-shape-grid" x1={LEFT} x2={W - RIGHT} y1={yOfHz(hz)} y2={yOfHz(hz)} />
              <text className="bp-shape-axis" x={LEFT - 6} y={yOfHz(hz)} textAnchor="end" dominantBaseline="middle">
                {hz}
              </text>
            </g>
          ))}
          <text className="bp-shape-axis" x={8} y={PITCH_TOP + PITCH_H / 2} dominantBaseline="middle" transform={`rotate(-90 8 ${PITCH_TOP + PITCH_H / 2})`} textAnchor="middle">
            pitch (Hz)
          </text>
          {/* Vowels shaded under the line, since the pitch is heard on them */}
          {plan.sounds.map((s, i) =>
            phonemeSpec(s.p)?.group === 'Vowels' || phonemeSpec(s.p)?.group === 'Two-part vowels' ? (
              <rect key={i} className="bp-voice-vowelband" x={xOf(s.start)} y={PITCH_TOP} width={xOf(s.start + s.ms) - xOf(s.start)} height={PITCH_H} pointerEvents="none" />
            ) : null
          )}
          <polyline className={`bp-voice-pitch${pitch ? '' : ' auto'}`} points={line.join(' ')} pointerEvents="none" />
          {!robot &&
            points.map(([ms, st], i) => (
              <g key={i}>
                <circle className={`bp-voice-dot${pickedPoint === i ? ' picked' : ''}`} cx={xOf(ms)} cy={yOfHz(hzOfSt(st))} r={pickedPoint === i ? 7 : 5.5} pointerEvents="none" />
                <circle
                  className="bp-shape-grip"
                  cx={xOf(ms)}
                  cy={yOfHz(hzOfSt(st))}
                  r={13}
                  onPointerDown={(e) => {
                    setPickedPoint(i);
                    setPicked(null);
                    press(e, { kind: 'pitch', id: e.pointerId, index: i, before: { sounds, pitch }, moved: false });
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (points.length > 2) commit({ sounds, pitch: points.filter((_, j) => j !== i) });
                  }}
                >
                  <title>
                    {Math.round(hzOfSt(st))} Hz at {ms} ms. Drag to move; right click to take away.
                  </title>
                </circle>
              </g>
            ))}

          {/* The sound */}
          <rect className="bp-shape-lane" x={LEFT} y={WAVE_TOP} width={PLOT_W} height={WAVE_H} />
          <path className="bp-shape-wave" d={wavePath} pointerEvents="none" />

          {/* The sounds, a block each */}
          <rect className="bp-shape-lane" x={LEFT} y={STRIP_TOP} width={PLOT_W} height={STRIP_H} onPointerDown={() => setPicked(null)} />
          {plan.sounds.map((s, i) => {
            const spec = phonemeSpec(s.p);
            const x0 = xOf(s.start);
            const w = Math.max(2, xOf(s.start + s.ms) - x0);
            return (
              <g key={i} className={`bp-voice-block ${spec ? GROUP_CLASS[spec.group] : ''}${picked === i ? ' picked' : ''}`}>
                <rect
                  x={x0 + 0.5}
                  y={STRIP_TOP + 3}
                  width={Math.max(1, w - 1)}
                  height={STRIP_H - 6}
                  rx={3}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    setPicked(i);
                    setPickedPoint(null);
                    hearSound(s.p);
                  }}
                >
                  <title>
                    {s.p}
                    {spec ? ` as in ${spec.example}` : ''}, {s.ms} ms{s.stress ? ', stressed' : ''}
                  </title>
                </rect>
                {w > 14 && (
                  <text x={x0 + w / 2} y={STRIP_TOP + STRIP_H / 2} textAnchor="middle" dominantBaseline="middle" pointerEvents="none">
                    {s.p}
                    {s.stress ? 'ˈ' : ''}
                  </text>
                )}
                {/* The right edge: drag to make it longer or shorter */}
                <rect
                  className="bp-voice-edge"
                  x={x0 + w - 5}
                  y={STRIP_TOP}
                  width={10}
                  height={STRIP_H}
                  onPointerDown={(e) => {
                    setPicked(i);
                    press(e, { kind: 'length', id: e.pointerId, index: i, before: { sounds, pitch }, fromX: at(e).x, fromMs: s.ms, moved: false });
                  }}
                />
              </g>
            );
          })}
          {ticks.map((t) => (
            <text key={t} className="bp-shape-axis" x={xOf(t)} y={TICKS_Y} textAnchor="middle" pointerEvents="none">
              {t >= 1000 ? `${t / 1000}s` : `${t}ms`}
            </text>
          ))}
        </svg>

        {said && <p className="bp-note warn">{said}</p>}

        <div className="bp-shape-waves">
          {pickedSound ? (
            <>
              <span className="meta">
                Picked: <strong>{pickedSound.p}</strong>
                {pickedSpec ? ` as in "${pickedSpec.example}"` : ''}, {pickedSound.ms} ms
              </span>
              <button type="button" onClick={() => hearSound(pickedSound.p)}>
                ▶ Hear it alone
              </button>
              {pickedSpec && (pickedSpec.group === 'Vowels' || pickedSpec.group === 'Two-part vowels') && (
                <button type="button" onClick={toggleStress} aria-pressed={Boolean(pickedSound.stress)} className={pickedSound.stress ? 'primary' : ''}>
                  Stressed
                </button>
              )}
              <button type="button" onClick={removePicked}>
                Remove
              </button>
            </>
          ) : (
            <span className="meta">Click a sound in the row above to pick it.</span>
          )}
          <span className="bp-shape-zoom">
            <button type="button" onClick={() => commit({ sounds: null, pitch })} disabled={!sounds}>
              Sounds from the words
            </button>
            <button type="button" onClick={() => commit({ sounds, pitch: null })} disabled={!pitch}>
              Automatic pitch
            </button>
          </span>
        </div>

        <label className="bp-field bp-voice-typed">
          <span className="bp-field-label">The sounds, typed (a 1 after a vowel stresses it)</span>
          <input
            value={typed ?? soundsText(allSounds)}
            onChange={(e) => setTyped(e.target.value)}
            onBlur={takeTyped}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
            }}
            spellCheck={false}
          />
        </label>

        <div className="bp-voice-palette">
          <div className="bp-voice-mode" role="group" aria-label="What a click on a sound does">
            <span className="meta">A click on a sound below plays it and</span>
            <button type="button" className={!swap ? 'primary' : ''} aria-pressed={!swap} onClick={() => setSwap(false)}>
              adds it {picked !== null ? 'after the picked one' : 'at the end'}
            </button>
            <button type="button" className={swap ? 'primary' : ''} aria-pressed={swap} onClick={() => setSwap(true)} disabled={picked === null}>
              swaps the picked one for it
            </button>
          </div>
          {GROUPS.map((group) => (
            <div key={group} className="bp-voice-group">
              <span className="meta">{group}</span>
              <div>
                {PHONEMES.filter((p) => p.group === group).map((p) => (
                  <button key={p.id} type="button" className={`bp-voice-sound ${GROUP_CLASS[group]}`} onClick={() => putSound(p.id)} title={`${p.id} as in "${p.example}"`}>
                    <strong>{p.id === '_' ? 'pause' : p.id}</strong>
                    <span>{p.example}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}
