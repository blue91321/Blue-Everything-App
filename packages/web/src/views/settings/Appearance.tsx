/**
 * Theme, accent colour and the app's mark (Settings → General).
 */
import { useRef, useState } from 'react';
import { api, type AppSettings } from '../../api';
import { Logo, type LogoShape } from '../../Logo';
import { useAsync } from '../../useAsync';
import {
  ACCENTS,
  ACCENT_LABELS,
  DEFAULT_ACCENT,
  DEFAULT_THEME,
  applyLook,
  resolveTheme,
  type Accent,
  type AppTheme,
} from '../../theme';

/** Duplicated from LOGO_SHAPE_LABELS in `shared` — the PWA cannot import it. */
const LOGO_LABELS: Record<LogoShape, string> = {
  pause: 'Pause',
  circle: 'Circle',
  triangle: 'Triangle',
  square: 'Square',
  image: 'My own picture',
};

const THEME_LABELS: { id: AppTheme; label: string; hint: string }[] = [
  { id: 'dark', label: 'Dark', hint: 'the default' },
  { id: 'light', label: 'Light', hint: '' },
  { id: 'system', label: 'Match Windows', hint: 'follows your OS setting' },
];

export function Appearance() {
  const settings = useAsync(() => api.settings.get(), [], ['settings']);
  const [busy, setBusy] = useState(false);

  const current = settings.data;
  const theme = (current?.theme ?? DEFAULT_THEME) as AppTheme;
  const accent = (current?.accentColor ?? DEFAULT_ACCENT) as Accent;

  async function save(next: { theme?: AppTheme; accentColor?: Accent }) {
    // Paint first, then persist.
    applyLook(next.theme ?? theme, next.accentColor ?? accent);
    setBusy(true);
    try {
      await api.settings.update(next);
      settings.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Appearance</h2>

      <div className="card">
        <div className="title">Theme</div>
        <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          {THEME_LABELS.map(({ id, label, hint }) => (
            <button
              key={id}
              className={theme === id ? 'btn primary' : 'btn'}
              disabled={busy || settings.loading}
              aria-pressed={theme === id}
              onClick={() => void save({ theme: id })}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="meta" style={{ marginTop: 8 }}>
          {THEME_LABELS.find((t) => t.id === theme)?.hint || ' '}
        </div>
      </div>

      <div className="card">
        <div className="title">Accent colour</div>
        <div className="meta" style={{ marginTop: 4 }}>
          Used for buttons, links, the app icon, and anything asking for your attention.
        </div>
        <div className="row" style={{ marginTop: 10, flexWrap: 'wrap', gap: 8 }}>
          {ACCENTS.map((id) => (
            <button
              key={id}
              className="swatch"
              // The swatch paints itself with the same variables the rest of the
              // app uses, scoped by the data attribute — so what you see on the
              // button is literally what applying it will do, rather than a
              // second copy of the palette that can drift.
              data-accent={id}
              // The *resolved* theme, not the stored one: 'system' is not a
              // value the stylesheet knows, so passing it through would leave
              // every swatch on the dark palette while the page around it was
              // light.
              data-theme={resolveTheme(theme)}
              aria-label={ACCENT_LABELS[id]}
              aria-pressed={accent === id}
              title={ACCENT_LABELS[id]}
              disabled={busy || settings.loading}
              onClick={() => void save({ accentColor: id })}
            >
              {accent === id ? '✓' : ''}
            </button>
          ))}
        </div>
      </div>

      <LogoPicker current={current} onChanged={settings.reload} />
    </section>
  );
}

/**
 * The mark: one of four drawn shapes, or a picture.
 *
 * The choices render as the real logo at the real size rather than as a list of
 * words, because "triangle" tells you less than a triangle does — and each one
 * paints from the live `--accent`, so the row doubles as a preview of the
 * colour choice sitting directly above it.
 */
function LogoPicker({ current, onChanged }: { current: AppSettings | undefined; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const shape = (current?.logoShape ?? 'pause') as LogoShape;
  const version = current?.logoVersion ?? 0;
  const hasImage = shape === 'image';

  async function choose(next: LogoShape) {
    setError('');
    setBusy(true);
    try {
      await api.settings.update({ logoShape: next });
      onChanged();
    } catch {
      // The only way this fails is picking `image` with nothing uploaded, which
      // the buttons below already prevent — but a stale screen could still try.
      setError('Upload a picture first.');
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File) {
    setError('');
    setBusy(true);
    try {
      await api.logo.upload(file);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'that upload failed');
    } finally {
      setBusy(false);
      // Cleared so picking the *same* file again still fires a change event.
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function removeImage() {
    setBusy(true);
    try {
      await api.logo.remove();
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="title">App icon</div>
      <div className="meta" style={{ marginTop: 4 }}>
        Used in the tab, on the taskbar, and on your phone's home screen.
      </div>

      <div className="row logo-choices" style={{ marginTop: 12 }}>
        {(['pause', 'circle', 'triangle', 'square'] as const).map((id) => (
          <button
            key={id}
            className="logo-choice"
            aria-pressed={shape === id}
            aria-label={LOGO_LABELS[id]}
            title={LOGO_LABELS[id]}
            disabled={busy}
            onClick={() => void choose(id)}
          >
            <Logo shape={id} size={40} />
          </button>
        ))}

        {/* Only offered once something has been uploaded — a button that can
            only produce an error is not a choice. */}
        {hasImage && (
          <button
            className="logo-choice"
            aria-pressed
            aria-label={LOGO_LABELS.image}
            title={LOGO_LABELS.image}
            disabled={busy}
            onClick={() => void choose('image')}
          >
            <Logo shape="image" size={40} version={version} />
          </button>
        )}
      </div>

      <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
        <button className="btn" disabled={busy} onClick={() => fileInput.current?.click()}>
          {hasImage ? 'Replace picture…' : 'Use my own picture…'}
        </button>
        {hasImage && (
          <button className="btn subtle danger" disabled={busy} onClick={() => void removeImage()}>
            Remove picture
          </button>
        )}
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
      </div>

      <div className="meta" style={{ marginTop: 8 }}>
        A square PNG of about 512×512 works best. It is stored by your Blue Everything, never uploaded anywhere else.
      </div>
      {error && <div className="banner">{error}</div>}
    </div>
  );
}
