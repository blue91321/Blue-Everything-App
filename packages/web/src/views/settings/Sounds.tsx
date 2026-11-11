/**
 * Which tone plays for each moment, and hearing one by picking it.
 */
import { useEffect, useState } from 'react';
import { api, type AppSettings } from '../../api';

/**
 * A tone per moment.
 *
 * The names are deliberately duplicated here rather than fetched: the PWA cannot
 * import `@everything/shared` (zod), and an endpoint to serve nine strings that
 * change about once a year would be a round trip and a route for nothing. The
 * agent ignores a name it does not know and falls back to the default, so a list
 * that drifts degrades to "the old sound" rather than to silence.
 *
 * The *sounds* are not duplicated, which is the important half — see `playTone`.
 */
const TONES = ['rise', 'fall', 'chime', 'arrive', 'sink', 'blip', 'knock', 'soft', 'none'];

/**
 * Hear one.
 *
 * A dropdown of nine words is not a choice anybody can make: `knock` and `blip`
 * are not self-describing, and the only way to tell them apart used to be a
 * terminal command. So picking one plays it.
 *
 * **The bytes come from the server, not from Web Audio here.** Synthesising an
 * approximation in the browser would be a second implementation of the tone
 * shapes, and the failure mode is the worst kind: the preview would be subtly
 * not what interrupts you, with nothing to catch the drift. `/sounds/<tone>.wav`
 * is rendered by the same `wav()` over the same table the agent writes its temp
 * file from, so this is byte-for-byte the real thing.
 *
 * It cannot go through the agent, which is the other obvious route: the agent
 * polls rather than listening, so a preview would land five to fifteen seconds
 * after the click — and never at all from the phone, where this setting is
 * equally editable.
 *
 * Elements are kept per tone so clicking down the list does not refetch, and
 * `currentTime = 0` restarts one that is already playing rather than ignoring
 * the second click.
 */
const auditioned = new Map<string, HTMLAudioElement>();

function playTone(tone: string, volume = 100): void {
  // Silence is a real choice, and the server answers 204 for it. Asking anyway
  // would be harmless and would put an empty-source error in the console.
  if (tone === '' || tone === 'none') return;

  // Turned down by the server, in the bytes, as the agent turns them down: an
  // iPhone ignores an audio element's volume, so setting that did nothing there.
  const key = `${tone}?v=${Math.round(volume)}`;
  let audio = auditioned.get(key);
  if (!audio) {
    audio = new Audio(`/sounds/${tone}.wav?v=${Math.round(volume)}`);
    auditioned.set(key, audio);
  }
  audio.currentTime = 0;
  // Autoplay policy rejects this if nothing has been clicked yet, which cannot
  // happen here — but a rejected promise with no handler is an unhandled
  // rejection, and a tone preview is not worth one.
  void audio.play().catch(() => {});
}

const SOUND_MOMENTS: { key: 'soundWake' | 'soundOk' | 'soundMiss' | 'soundNudge'; label: string; hint: string }[] = [
  { key: 'soundNudge', label: 'A nudge arrives', hint: 'the one that interrupts you' },
  { key: 'soundWake', label: 'Voice starts listening', hint: 'after the wake word' },
  { key: 'soundOk', label: 'A command worked', hint: '' },
  { key: 'soundMiss', label: "It didn't catch that", hint: '' },
];

export function SoundTones({
  current,
  saving,
  update,
}: {
  current: AppSettings;
  saving: boolean;
  update: (payload: Parameters<typeof api.settings.update>[0]) => Promise<void>;
}) {
  // A server older than the columns sends none of them, and a picker that
  // writes a field the server drops is worse than no picker.
  if (current.soundWake === undefined) return null;

  return (
    <div style={{ marginTop: 12 }}>
      {current.soundVolume !== undefined && (
        <SoundVolume value={current.soundVolume} tone={current.soundNudge || 'arrive'} saving={saving} onSave={(v) => void update({ soundVolume: v })} />
      )}
      <div className="meta" style={{ marginBottom: 8 }}>
        Which tone each moment gets — picking one plays it. They are generated rather than shipped as
        files, and what you hear here is the same bytes the agent will play.
      </div>

      {SOUND_MOMENTS.map(({ key, label, hint }) => (
        <div className="row between" key={key} style={{ marginTop: 6 }}>
          <div className="grow">
            <span>{label}</span>
            {hint && <span className="meta"> · {hint}</span>}
          </div>
          <select
            value={current[key] || ''}
            disabled={saving}
            aria-label={`Tone for: ${label}`}
            style={{ width: 'auto' }}
            onChange={(e) => {
              // Played before the save, not after. The save is a round trip and
              // this is the one interaction where waiting for one is
              // unacceptable — you are choosing by listening, exactly as the
              // accent swatches apply their colour before the save returns.
              playTone(e.target.value, current.soundVolume ?? 100);
              void update({ [key]: e.target.value } as Parameters<typeof api.settings.update>[0]);
            }}
          >
            {/* Empty rather than the default's name, so this keeps tracking the
                default if it ever changes — the same reason a task's push
                choice has a null. */}
            <option value="">default</option>
            {TONES.map((tone) => (
              <option key={tone} value={tone}>
                {tone === 'none' ? 'silent' : tone}
              </option>
            ))}
          </select>
        </div>
      ))}
    </div>
  );
}

/**
 * How loud the app's tones are. A slider held as a draft while it moves, and
 * saved, with the nudge tone played at the new level, when it is let go: a save
 * per pixel would be a round trip per pixel, and a tone per pixel a buzz.
 */
function SoundVolume({ value, tone, saving, onSave }: { value: number; tone: string; saving: boolean; onSave: (value: number) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onSave(draft);
    playTone(tone, draft);
  };
  return (
    <div className="row between" style={{ marginBottom: 10, gap: 12 }}>
      <span>Volume</span>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={draft}
        disabled={saving}
        aria-label="Volume of the app's tones"
        style={{ flex: 1, padding: 0 }}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
      />
      <span className="meta" style={{ minWidth: '3ch', textAlign: 'right' }}>
        {draft}%
      </span>
    </div>
  );
}
