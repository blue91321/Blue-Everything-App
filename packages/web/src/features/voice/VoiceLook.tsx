import { useRef, useState } from 'react';
import { api, type VoiceSettings, type VoiceStatus } from '../../api';

/** The nine anchors, laid out the way they sit on a screen. */
const ANCHORS: { value: string; label: string }[][] = [
  [
    { value: 'top-left', label: '↖' },
    { value: 'top', label: '↑' },
    { value: 'top-right', label: '↗' },
  ],
  [
    { value: 'left', label: '←' },
    { value: 'centre', label: '•' },
    { value: 'right', label: '→' },
  ],
  [
    { value: 'bottom-left', label: '↙' },
    { value: 'bottom', label: '↓' },
    { value: 'bottom-right', label: '↘' },
  ],
];

const AVATARS = ['🤖', '🎧', '🐈', '🦉', '👾', '🫡', '🧠', '⭐'];

/** 2MB before base64, which is far more than a 44px face ever needs. */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/**
 * Where the popup appears, and what face it wears.
 *
 * The screen list comes from the agent rather than the browser: `window.screen`
 * describes the display this tab is on and nothing else, while the agent can
 * enumerate all of them — and it is the process that has to put a window there.
 */
export function VoiceLook({
  settings,
  status,
  saving,
  onChange,
}: {
  settings: VoiceSettings;
  status: VoiceStatus | null;
  saving: boolean;
  onChange: (payload: Parameters<typeof api.settings.update>[0]) => Promise<void>;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const placement = settings.overlayPlacement ?? 'cursor';
  const avatar = settings.overlayAvatar ?? '';
  const screens = status?.screens ?? [];
  const atCursor = placement === 'cursor';

  async function upload(chosen: File) {
    setError('');
    if (chosen.size > MAX_AVATAR_BYTES) {
      setError('that picture is over 2MB — a small one is plenty for a 44px face');
      return;
    }

    setBusy(true);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('could not read that file'));
        // The result is a data: URL; the server wants the base64 payload alone.
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.readAsDataURL(chosen);
      });

      await api.voice.uploadAvatar(data, chosen.type);
      await onChange({});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'could not upload that');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>How the popup looks</h2>

      <div className="card">
        <div className="title">Where it appears</div>
        <div className="meta" style={{ marginTop: 4 }}>
          {atCursor
            ? 'Beside the mouse pointer, wherever that is.'
            : 'Pinned to a corner, so it is always in the same place rather than wherever you last clicked.'}
        </div>

        <div className="row" style={{ marginTop: 10 }}>
          <button
            className={`btn ${atCursor ? 'primary' : ''}`}
            disabled={saving}
            onClick={() => void onChange({ overlayPlacement: 'cursor' })}
          >
            At the cursor
          </button>
          {!atCursor && <span className="meta">or pick a corner below</span>}
        </div>

        <div className="anchors" style={{ marginTop: 10 }}>
          {ANCHORS.map((row, index) => (
            <div className="anchor-row" key={index}>
              {row.map((anchor) => (
                <button
                  key={anchor.value}
                  className={`anchor${placement === anchor.value ? ' on' : ''}`}
                  aria-label={anchor.value.replace('-', ' ')}
                  aria-pressed={placement === anchor.value}
                  disabled={saving}
                  onClick={() => void onChange({ overlayPlacement: anchor.value })}
                >
                  {anchor.label}
                </button>
              ))}
            </div>
          ))}
        </div>

        {/* Only meaningful once it is pinned — at the cursor, the screen is
            wherever the pointer already is. */}
        {!atCursor && (
          <>
            <div className="row" style={{ marginTop: 12 }}>
              <span className="meta">On</span>
              <select
                value={settings.overlayScreen ?? ''}
                disabled={saving || screens.length === 0}
                aria-label="Which screen"
                onChange={(e) => void onChange({ overlayScreen: e.target.value === '' ? null : e.target.value })}
              >
                <option value="">whichever screen my mouse is on</option>
                {screens.map((screen) => (
                  <option key={screen.id} value={screen.id}>
                    {screen.label}
                  </option>
                ))}
              </select>
            </div>
            {screens.length === 0 && (
              <div className="meta" style={{ marginTop: 6 }}>
                The screen list comes from the agent, which is not running.
              </div>
            )}
          </>
        )}
      </div>

      <div className="card">
        <div className="title">Avatar</div>
        <div className="meta" style={{ marginTop: 4 }}>
          Shown on the left of the popup. Pick one, or use a picture of your own.
        </div>

        <div className="row wrap" style={{ marginTop: 10 }}>
          <button
            className={`avatar-choice${avatar === '' ? ' on' : ''}`}
            aria-label="No avatar"
            aria-pressed={avatar === ''}
            disabled={saving}
            onClick={() => void onChange({ overlayAvatar: '' })}
          >
            none
          </button>
          {AVATARS.map((choice) => (
            <button
              key={choice}
              className={`avatar-choice${avatar === choice ? ' on' : ''}`}
              aria-label={`Avatar ${choice}`}
              aria-pressed={avatar === choice}
              disabled={saving}
              onClick={() => void onChange({ overlayAvatar: choice })}
            >
              {choice}
            </button>
          ))}
          {avatar === 'file' && (
            <button className="avatar-choice on" aria-label="Your picture" aria-pressed>
              <img src={`/api/voice/avatar?v=${settings.updatedAt ?? 0}`} alt="" />
            </button>
          )}
        </div>

        <div className="row" style={{ marginTop: 10 }}>
          <input
            ref={file}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/bmp"
            aria-label="Avatar picture"
            style={{ display: 'none' }}
            onChange={(e) => {
              const chosen = e.target.files?.[0];
              if (chosen) void upload(chosen);
              e.target.value = '';
            }}
          />
          <button className="btn" disabled={saving || busy} onClick={() => file.current?.click()}>
            {busy ? 'Uploading…' : 'Use a picture…'}
          </button>
          <span className="meta">PNG, JPEG, GIF or BMP.</span>
        </div>

        {error && <div className="banner">{error}</div>}
      </div>
    </section>
  );
}
