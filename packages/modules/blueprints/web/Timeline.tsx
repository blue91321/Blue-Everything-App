/**
 * "Press keys" on a timeline: each key a row, each press a bar from when it
 * goes down to when it comes back up, dragged into place. Asked for in place
 * of typed steps ("hold w 20", "wait 40"), on the model of a controller
 * remapper's timeline, which shows what a macro does at a glance.
 *
 * The box shows a small picture of the timeline and a button; the editor opens
 * over the screen, because a box is 240px wide and a timeline wants the room.
 * It is drawn into `body` and stops its own pointer and key events, or React
 * would carry them up to the board, which pans on a drag and deletes a box on
 * Delete.
 *
 * **Pointer events throughout**, so a finger drags a bar as a mouse does (the
 * board's own lesson). Dragging snaps to 5ms, or to 1ms with Alt held; the
 * numbers under each bar are typed for anything exact, and a focused bar moves
 * with the arrow keys (Shift to stretch it), so none of it needs a mouse.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { barKeys, keysFromEvent, parseTimeline, soonerIfSkipped, TIMELINE_LIMITS, timelineLength, type TimelineBar } from './keys';

const SNAP = 5;
/** What a new row starts as: a short tap, after whatever is already there. */
const NEW_BAR_MS = 30;
/** The spans offered, in ms. The view fits the timeline unless one is picked. */
const SPANS = [100, 250, 500, 1000, 2000, 5000, 10_000];

const MODIFIER_CODES: Record<string, string> = {
  ControlLeft: 'ctrl', ControlRight: 'ctrl', AltLeft: 'alt', AltRight: 'alt',
  ShiftLeft: 'shift', ShiftRight: 'shift', MetaLeft: 'win', MetaRight: 'win',
};

/** The smallest span on offer that shows the whole timeline with a little room after it. */
function fitSpan(bars: TimelineBar[]): number {
  const end = timelineLength(bars);
  return SPANS.find((s) => s >= end * 1.15 + 10) ?? TIMELINE_LIMITS.totalMs;
}

/** Ruler steps that land on round numbers: 10, 20, 50, 100… about eight across. */
function tickStep(span: number): number {
  const rough = span / 8;
  const power = 10 ** Math.floor(Math.log10(rough));
  return [1, 2, 5, 10].map((m) => m * power).find((s) => s >= rough) ?? power * 10;
}

const label = (keys: string) => (keys ? keys.split('+').map((k) => (k.length === 1 ? k.toUpperCase() : k)).join('+') : 'no key yet');

/** The box's part: a small picture of the bars, what they are, and the button that opens the editor. */
export function TimelineField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const bars = useMemo(() => parseTimeline(value), [value]);
  const [open, setOpen] = useState(false);
  const span = Math.max(timelineLength(bars), 1);
  const keyed = bars.filter((b) => b.keys);
  return (
    <div className="bp-field bp-tl-field">
      <span className="bp-field-label">Timeline</span>
      {bars.length > 0 ? (
        <svg className="bp-tl-mini" viewBox={`0 0 100 ${bars.length * 6}`} preserveAspectRatio="none" aria-hidden="true">
          {bars.map((b, i) => (
            <rect key={i} x={(b.at / span) * 100} y={i * 6 + 1} width={Math.max(((b.until - b.at) / span) * 100, 0.8)} height={4} rx={1} />
          ))}
        </svg>
      ) : null}
      <span className="bp-hint">
        {keyed.length ? `${keyed.map((b) => label(b.keys)).join(', ')} · ${timelineLength(keyed)} ms` : 'Nothing on it yet.'}
      </span>
      <button type="button" onClick={() => setOpen(true)}>
        {bars.length ? 'Edit the timeline' : 'Set up the timeline'}
      </button>
      {open && <TimelineEditor bars={bars} onChange={(next) => onChange(JSON.stringify(next))} onClose={() => setOpen(false)} />}
    </div>
  );
}

function TimelineEditor({ bars, onChange, onClose }: { bars: TimelineBar[]; onChange: (bars: TimelineBar[]) => void; onClose: () => void }) {
  const [picked, setPicked] = useState<number | null>(null);
  const [recording, setRecording] = useState<number | null>(bars.length === 0 ? 0 : null);
  const span = picked ?? fitSpan(bars);
  const dialog = useRef<HTMLDivElement>(null);

  // A first row to fill in, so an empty timeline opens on something to do.
  useEffect(() => {
    if (bars.length === 0) onChange([{ keys: '', at: 0, until: NEW_BAR_MS }]);
  }, []);

  useEffect(() => {
    dialog.current?.focus();
  }, []);

  const set = (i: number, patch: Partial<TimelineBar>) => onChange(bars.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const remove = (i: number) => onChange(bars.filter((_, j) => j !== i));
  const add = () => {
    if (bars.length >= TIMELINE_LIMITS.bars) return;
    const at = Math.min(timelineLength(bars), TIMELINE_LIMITS.totalMs - NEW_BAR_MS);
    onChange([...bars, { keys: '', at, until: at + NEW_BAR_MS }]);
    setRecording(bars.length);
  };

  const step = tickStep(span);
  const ticks = Array.from({ length: Math.floor(span / step) + 1 }, (_, i) => i * step);

  return createPortal(
    <div
      className="bp-tl-overlay"
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape' && recording === null) onClose();
      }}
    >
      <div className="bp-tl card" role="dialog" aria-modal="true" aria-labelledby="bp-tl-title" tabIndex={-1} ref={dialog}>
        <div className="bp-tl-top">
          <h3 id="bp-tl-title">Timeline</h3>
          <label className="bp-tl-span">
            <span className="meta">Show</span>
            <select value={picked ?? ''} onChange={(e) => setPicked(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Fit ({fitSpan(bars)} ms)</option>
              {SPANS.map((s) => (
                <option key={s} value={s}>
                  {s >= 1000 ? `${s / 1000} s` : `${s} ms`}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="primary" onClick={onClose}>
            Done
          </button>
        </div>
        <p className="meta bp-tl-help">
          Each row is a key. Its bar starts when the key goes down and ends when it comes back up, counted from the moment
          the box runs. Drag a bar to move it and its ends to change how long it is held; hold Alt for single milliseconds.
        </p>

        <div className="bp-tl-grid">
          <div className="bp-tl-ruler-row">
            <span />
            <div className="bp-tl-ruler" aria-hidden="true">
              {ticks.map((t) => (
                <span key={t} className="bp-tl-tick" style={{ left: `${(t / span) * 100}%` }}>
                  {t}
                </span>
              ))}
            </div>
            <span />
          </div>
          {bars.map((bar, i) => (
            <Row
              key={i}
              bar={bar}
              span={span}
              recording={recording === i}
              gap={soonerIfSkipped(bars.map((b, j) => (j === i ? { ...b, keepGap: undefined } : b)), i)}
              onRecord={(on) => setRecording(on ? i : null)}
              onChange={(patch) => set(i, patch)}
              onRemove={() => remove(i)}
            />
          ))}
        </div>

        <div className="bp-tl-bottom">
          <button type="button" onClick={add} disabled={bars.length >= TIMELINE_LIMITS.bars}>
            ＋ Add a key
          </button>
          <span className="meta">
            {bars.filter((b) => b.keys).length
              ? `Takes ${timelineLength(bars.filter((b) => b.keys))} ms. Anything still held at the end is let go.`
              : 'Add a key to start.'}
          </span>
        </div>
      </div>
    </div>,
    document.body
  );
}

function Row({
  bar,
  span,
  recording,
  gap,
  onRecord,
  onChange,
  onRemove,
}: {
  bar: TimelineBar;
  span: number;
  recording: boolean;
  /** How much sooner the rest would start if this row were skipped and closed its gap. */
  gap: number;
  onRecord: (on: boolean) => void;
  onChange: (patch: Partial<TimelineBar>) => void;
  onRemove: () => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ what: 'move' | 'start' | 'end'; x: number; at: number; until: number } | null>(null);

  const msPerPx = () => span / Math.max(track.current?.clientWidth ?? 1, 1);
  const snap = (ms: number, fine: boolean) => (fine ? Math.round(ms) : Math.round(ms / SNAP) * SNAP);
  const place = (at: number, until: number) => {
    const max = TIMELINE_LIMITS.totalMs;
    const a = Math.max(0, Math.min(at, max - 1));
    onChange({ at: a, until: Math.max(a + 1, Math.min(until, max)) });
  };

  const down = (what: 'move' | 'start' | 'end') => (e: ReactPointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { what, x: e.clientX, at: bar.at, until: bar.until };
  };
  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const shift = snap((e.clientX - d.x) * msPerPx(), e.altKey);
    if (d.what === 'move') {
      const length = d.until - d.at;
      const at = Math.max(0, Math.min(d.at + shift, TIMELINE_LIMITS.totalMs - length));
      place(at, at + length);
    } else if (d.what === 'start') {
      place(Math.min(d.at + shift, d.until - 1), d.until);
    } else {
      place(d.at, Math.max(d.until + shift, d.at + 1));
    }
  };
  const up = () => {
    drag.current = null;
  };

  // The arrows move a focused bar; with Shift they stretch or shrink its end.
  const onKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const by = (e.key === 'ArrowLeft' ? -1 : 1) * (e.altKey ? 1 : SNAP);
    if (e.shiftKey) place(bar.at, Math.max(bar.until + by, bar.at + 1));
    else {
      const length = bar.until - bar.at;
      const at = Math.max(0, Math.min(bar.at + by, TIMELINE_LIMITS.totalMs - length));
      place(at, at + length);
    }
  };

  const left = (bar.at / span) * 100;
  const width = ((bar.until - bar.at) / span) * 100;
  const beyond = bar.until > span;

  return (
    <div className="bp-tl-row">
      <div className="bp-tl-key">
        <KeyPicker value={bar.keys} recording={recording} onRecord={onRecord} onChange={(keys) => onChange({ keys })} />
        <label className="bp-tl-ifup">
          <input type="checkbox" checked={Boolean(bar.ifUp)} onChange={(e) => onChange({ ifUp: e.target.checked || undefined })} />
          <span>Only if I'm not holding it</span>
        </label>
        {bar.ifUp && gap > 0 && (
          <label className="bp-tl-ifup bp-tl-gap">
            <input type="checkbox" checked={!bar.keepGap} onChange={(e) => onChange({ keepGap: e.target.checked ? undefined : true })} />
            <span>If I am, start the rest {gap} ms sooner</span>
          </label>
        )}
      </div>
      <div className="bp-tl-lane">
        <div className="bp-tl-track" ref={track}>
          <div
            className={`bp-tl-bar${bar.keys ? '' : ' empty'}${beyond ? ' beyond' : ''}`}
            style={{ left: `${left}%`, width: `${Math.max(width, 0.5)}%` }}
            role="slider"
            tabIndex={0}
            aria-label={`${label(bar.keys)}: down at ${bar.at} ms, up at ${bar.until} ms`}
            aria-valuemin={0}
            aria-valuemax={TIMELINE_LIMITS.totalMs}
            aria-valuenow={bar.at}
            onPointerDown={down('move')}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            onKeyDown={onKey}
          >
            <span className="bp-tl-handle start" onPointerDown={down('start')} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
            <span className="bp-tl-bar-label">{label(bar.keys)}</span>
            <span className="bp-tl-handle end" onPointerDown={down('end')} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
          </div>
        </div>
        <div className="bp-tl-times">
          <MsBox label="Down at" value={bar.at} onCommit={(at) => place(at, Math.max(bar.until, at + 1))} />
          <MsBox label="Up at" value={bar.until} onCommit={(until) => place(bar.at, Math.max(until, bar.at + 1))} />
          <span className="meta">held {bar.until - bar.at} ms</span>
          {beyond && <span className="meta">runs past what is shown</span>}
        </div>
      </div>
      <button type="button" className="bp-tl-remove" onClick={onRemove} aria-label={`Remove ${label(bar.keys)}`}>
        ✕
      </button>
    </div>
  );
}

/** A number of milliseconds, typed, kept as text until Enter or leaving the box. */
function MsBox({ label: name, value, onCommit }: { label: string; value: number; onCommit: (ms: number) => void }) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(String(value));
  }, [value]);
  const commit = () => {
    const n = Math.round(Number(text));
    if (Number.isFinite(n) && text.trim() !== '') onCommit(n);
    else setText(String(value));
  };
  return (
    <label className="bp-tl-ms">
      <span className="meta">{name}</span>
      <input
        inputMode="numeric"
        value={text}
        onFocus={() => (focused.current = true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        aria-label={`${name} (ms)`}
      />
      <span className="meta">ms</span>
    </label>
  );
}

/**
 * A key for a row, typed or recorded. Unlike a hotkey, a modifier on its own
 * is a key here (a bar of Ctrl held over a tap of E), so pressing Ctrl and
 * letting go records "ctrl".
 */
function KeyPicker({
  value,
  recording,
  onRecord,
  onChange,
}: {
  value: string;
  recording: boolean;
  onRecord: (on: boolean) => void;
  onChange: (keys: string) => void;
}) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);

  useEffect(() => {
    if (!recording) return;
    let lone: string | null = null;
    const onDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.code === 'Escape' && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
        onRecord(false);
        return;
      }
      const mod = MODIFIER_CODES[event.code];
      if (mod) {
        lone = mod;
        return;
      }
      lone = null;
      const keys = keysFromEvent(event);
      if (!keys) return;
      onChange(barKeys(keys));
      onRecord(false);
    };
    const onUp = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (lone && MODIFIER_CODES[event.code] === lone) {
        onChange(lone);
        onRecord(false);
      }
    };
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    return () => {
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
    };
  }, [recording]);

  const valid = text.trim() === '' || barKeys(text) !== '';
  return (
    <span className="bp-keys">
      <input
        value={recording ? '' : text}
        placeholder={recording ? 'press it…' : 'e, ctrl, shift+2'}
        disabled={recording}
        onFocus={() => (focused.current = true)}
        onChange={(e) => {
          setText(e.target.value);
          const keys = barKeys(e.target.value);
          if (keys || e.target.value.trim() === '') onChange(keys);
        }}
        onBlur={() => {
          focused.current = false;
          setText(barKeys(text) || value);
        }}
        aria-label="Key"
        aria-invalid={!valid}
      />
      <button type="button" className={recording ? 'primary' : ''} onClick={() => onRecord(!recording)}>
        {recording ? 'Cancel' : 'Record'}
      </button>
    </span>
  );
}
