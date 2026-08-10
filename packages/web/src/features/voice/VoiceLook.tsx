import { useRef, useState } from 'react';
import { api, type VoiceSettings, type VoiceStatus } from '../../api';

/**
 * The anchor grid, laid out the way it sits on a screen.
 *
 * Five across rather than three, so a popup can be put somewhere that is not a
 * corner or dead centre — a third of the way down the right-hand edge is a
 * perfectly reasonable place to want it, and used not to be expressible.
 *
 * Duplicated from `OVERLAY_GRID` in @everything/shared rather than imported, for
 * the reason every other constant here is: that package pulls in zod, and this
 * bundle is meant to be almost entirely framework. The server validates the
 * value, and a mismatch would show up immediately as a grid that writes cells
 * the server rejects.
 */
const GRID = 5;

/** Which way this cell pulls, for the arrow on the button. */
function glyphFor(row: number, col: number): string {
  const middle = (GRID + 1) / 2;
  const up = row < middle;
  const down = row > middle;
  const left = col < middle;
  const right = col > middle;

  if (up && left) return '↖';
  if (up && right) return '↗';
  if (down && left) return '↙';
  if (down && right) return '↘';
  if (up) return '↑';
  if (down) return '↓';
  if (left) return '←';
  if (right) return '→';
  return '•';
}

/**
 * Human wording for the label, since "grid-24" is not something to read out.
 *
 * Tables rather than clever banding arithmetic: the first attempt derived these
 * and produced "upper top left" and "lower bottom right", which are not things
 * anybody says. Five words per axis is a shorter thing to read than the rule
 * that would generate them, and it cannot be subtly wrong.
 */
const ROW_WORDS = ['top', 'upper', 'middle', 'lower', 'bottom'];
const COL_WORDS = ['left', 'centre left', 'centre', 'centre right', 'right'];

function describeCell(row: number, col: number): string {
  // Dead centre is just "centre" — "middle centre" says the same thing twice.
  if (row === 3 && col === 3) return 'centre';
  return `${ROW_WORDS[row - 1]} ${COL_WORDS[col - 1]}`;
}

const ANCHORS = Array.from({ length: GRID }, (_, r) =>
  Array.from({ length: GRID }, (_, c) => ({
    value: `grid-${r + 1}${c + 1}`,
    label: glyphFor(r + 1, c + 1),
    describe: describeCell(r + 1, c + 1),
  }))
);

/**
 * The nine original names, mapped onto the cells they always meant.
 *
 * A stored `bottom` has to light up the bottom-middle square rather than
 * nothing at all — the value is still perfectly valid, it just predates the
 * coordinates.
 */
const LEGACY_CELL: Record<string, string> = {
  'top-left': 'grid-11',
  top: 'grid-13',
  'top-right': 'grid-15',
  left: 'grid-31',
  centre: 'grid-33',
  right: 'grid-35',
  'bottom-left': 'grid-51',
  bottom: 'grid-53',
  'bottom-right': 'grid-55',
};

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
  // Whichever square is lit, whether it was saved as a coordinate or as one of
  // the nine original names.
  const selectedCell = LEGACY_CELL[placement] ?? placement;

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
                  className={`anchor${selectedCell === anchor.value ? ' on' : ''}`}
                  aria-label={anchor.describe}
                  title={anchor.describe}
                  aria-pressed={selectedCell === anchor.value}
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
