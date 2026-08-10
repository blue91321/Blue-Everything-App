import { useEffect, useRef, useState } from 'react';
import { api, type AppSettings, type Device, type Session } from '../api';
import { Logo, type LogoShape } from '../Logo';
import { useAsync } from '../useAsync';
import { Toggle } from '../controls';
import { clockTime, relative } from '../format';
import {
  checkPushSupport,
  currentSubscription,
  disablePush,
  enablePush,
  pushDiagnostics,
  type PushDiagnostics,
} from '../push';
import {
  ACCENTS,
  ACCENT_LABELS,
  DEFAULT_ACCENT,
  DEFAULT_THEME,
  applyLook,
  resolveTheme,
  type Accent,
  type AppTheme,
} from '../theme';

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

/**
 * Theme and accent.
 *
 * Both are applied optimistically the moment they are clicked, before the save
 * comes back. A colour picker that waits for a round trip to show you the
 * colour is the one interaction where latency is genuinely unacceptable — you
 * are choosing by looking. The server is still the source of truth, and the
 * reload triggered by the save puts it right if the write failed.
 */
function Appearance() {
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
        A square PNG of about 512×512 works best. It is stored on this PC, never uploaded anywhere else.
      </div>
      {error && <div className="banner">{error}</div>}
    </div>
  );
}

/**
 * The Settings tabs.
 *
 * One long scroll was fine when this screen was a theme picker and a quiet-hours
 * switch. It is now appearance, reminders, phone push, sound, four kinds of
 * device, and the switches that decide which parts of the app exist at all —
 * and the thing you came to change was always somewhere in the middle of it.
 *
 * Which tab is open lives in `useState` like every other bit of navigation
 * here: there is no router, and the app has never had a URL for a screen.
 */
const TABS = [
  { id: 'general', label: 'General', hint: 'Appearance and reminders' },
  { id: 'notifications', label: 'Notifications', hint: 'Sound, quiet hours and the phone' },
  { id: 'devices', label: 'Devices', hint: 'Phones, browsers and the extension' },
  { id: 'packages', label: 'Packages', hint: 'Which parts of the app run' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function Settings({ session, onChanged }: { session: Session; onChanged: () => void }) {
  const [tab, setTab] = useState<TabId>('general');

  return (
    <>
      <div className="tabs" role="tablist" aria-label="Settings sections">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            role="tab"
            className={`tab${tab === entry.id ? ' on' : ''}`}
            aria-selected={tab === entry.id}
            title={entry.hint}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === 'general' && <GeneralTab />}
      {tab === 'notifications' && <NotificationsTab session={session} />}
      {tab === 'devices' && <DevicesTab session={session} onChanged={onChanged} />}
      {tab === 'packages' && <PackagesTab session={session} />}
    </>
  );
}

function GeneralTab() {
  return (
    <>
      <Appearance />
      <section>
        <h2>This app</h2>
        <div className="card">
          <div className="meta">
            Everything here is stored on the PC running the server, so the phone and the desktop always
            agree. Nothing is sent anywhere else.
          </div>
        </div>
      </section>
    </>
  );
}

function NotificationsTab({ session }: { session: Session }) {
  // An older server sends no feature list; absent means everything, not nothing.
  const has = (id: string) => session.features === undefined || session.features.includes(id);

  return (
    <>
      <QuietHours />
      {/* Configures a feature. With push off this would be a subscribe button
          with no key behind it. */}
      {has('push') && <PhoneNudges />}
    </>
  );
}

function DevicesTab({ session, onChanged }: { session: Session; onChanged: () => void }) {
  const devices = useAsync(() => api.devices.list(), [], ['devices']);
  const [adding, setAdding] = useState(false);

  const has = (id: string) => session.features === undefined || session.features.includes(id);

  return (
    <>
      <section>
        <h2>This device</h2>
        <div className="card">
          <div className="title">{session.local ? 'This PC' : 'A connected device'}</div>
          <div className="meta">
            {session.local
              ? 'Running on the machine hosting Blue Everything, so no code is needed here.'
              : 'Connected with a code.'}
          </div>
          {/* Worth showing because the PWA and the server update independently:
              a phone holding a cached bundle against a restarted server is the
              ordinary case, and "which version am I looking at" is the first
              question when something looks wrong. */}
          {session.version && <div className="meta">Version {session.version}</div>}
        </div>
      </section>

      {session.local && (
        <section>
          <div className="row between">
            <h2 style={{ margin: 0 }}>Add your phone</h2>
            <button className="btn" onClick={() => setAdding((v) => !v)}>
              {adding ? 'Close' : 'Show me how'}
            </button>
          </div>
          {adding && <AddDeviceGuide onAdded={devices.reload} />}
        </section>
      )}

      {/* The extension exists to fill vault entries, so it is part of that
          feature rather than a device type of its own. */}
      {session.local && has('vault') && <BrowserExtension onAdded={devices.reload} />}

      <section>
        <h2>Connected devices</h2>
        {devices.loading && <div className="empty">loading…</div>}
        {devices.data?.length === 0 && <div className="empty">No devices connected yet.</div>}
        {devices.data?.map((device) => (
          <DeviceRow
            key={device.id}
            device={device}
            local={session.local}
            onChanged={() => {
              devices.reload();
              onChanged();
            }}
          />
        ))}
      </section>
    </>
  );
}

/**
 * Which parts of the app run at all.
 *
 * Not the same question as any other switch on this screen. Turning quiet hours
 * off changes what the app *does*; turning the vault off means its routes are
 * never registered, its tab never appears, and the agent never loads its code.
 * That is why it needs a restart and says so rather than pretending to be
 * instant — the alternative was unregistering Fastify routes at runtime, which
 * is a large fragile thing to build for a switch flipped twice a year.
 */
function PackagesTab({ session }: { session: Session }) {
  const state = useAsync(() => api.features.get(), [], ['settings']);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const data = state.data;
  if (state.loading) return <div className="empty">loading…</div>;
  if (!data) return <div className="banner">Could not read the feature list.</div>;

  async function toggle(id: string, enabled: boolean) {
    setError('');
    setBusy(id);
    try {
      await api.features.set(id, enabled);
      state.reload();
    } catch {
      setError('That could not be saved. Features can only be changed from the PC running the server.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <h2>Packages</h2>
      <div className="meta" style={{ marginBottom: 12 }}>
        Optional parts of the app. Switching one off unregisters its API routes, hides its tab, and stops
        the agent loading it — you get the memory and the disk back, not just the menu entry.
      </div>

      {data.lockedByEnv && (
        <div className="banner">
          <strong>EVERYTHING_FEATURES is set</strong>, and it overrides <code>features.json</code>. These
          switches would write a file nothing reads, so they are disabled until it is unset.
        </div>
      )}

      {data.pendingRestart && (
        <div className="banner">
          <strong>Restart to apply.</strong> The choices below are saved, but the running app still has the
          old set — features are resolved once when it starts. Right-click the tray icon and choose
          <strong> Restart</strong>.
        </div>
      )}

      {!session.local && (
        <div className="meta" style={{ marginBottom: 10 }}>
          These can only be changed from the PC running the server.
        </div>
      )}

      {error && <div className="banner">{error}</div>}

      {data.features.map((feature) => (
        <div className="card" key={feature.id}>
          <div className="row between">
            <div className="grow">
              <div className="title">
                {feature.label}
                {feature.missing && (
                  <span className="urgent" title="switched on, but its folders are gone from disk">
                    {' '}
                    ⚠ not installed
                  </span>
                )}
                {/* Saved but not yet live — the restart banner explains it once,
                    this says which rows it is about. */}
                {feature.wanted !== feature.running && (
                  <span className="meta"> · {feature.wanted ? 'on' : 'off'} after restart</span>
                )}
              </div>
              <div className="meta" style={{ marginTop: 4 }}>
                {feature.blurb}
              </div>
              {feature.cost && (
                <div className="meta" style={{ marginTop: 4 }}>
                  Costs: {feature.cost}
                </div>
              )}
              {/* The honest boundary: some of these switch off cleanly but
                  cannot be deleted, because the Dashboard renders them inline.
                  Saying so beats a `removable: true` that sends somebody
                  deleting a folder and into a broken build. */}
              <div className="meta" style={{ marginTop: 4 }}>
                {feature.removable
                  ? 'Can also be deleted from disk entirely.'
                  : 'Can be switched off, but not removed — the Dashboard uses it.'}
              </div>
            </div>

            <Toggle
              on={feature.wanted}
              disabled={busy !== null || data.lockedByEnv || !session.local}
              label={`${feature.label} on`}
              onChange={(on) => void toggle(feature.id, on)}
            />
          </div>

          {feature.missing && (
            <div className="meta" style={{ marginTop: 8 }}>
              Its folders have been removed: {feature.owns.join(', ') || 'none listed'}. Switching it off
              stops the app expecting it.
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

/**
 * One paired device, and what can be done to it.
 *
 * Revoked ones stay on the list until they are cleared by hand, because the row
 * *is* the record that it happened — but a list that only ever grows turns into
 * a wall of struck-through names, and there is no way to tell which of four
 * revoked "iPhone" entries is which. So the record can be closed once it has
 * been read.
 *
 * Removing asks first. It is the only irreversible thing on this screen, and it
 * sits one button away from `revoke`, which is not.
 */
function DeviceRow({
  device,
  local,
  onChanged,
}: {
  device: Device;
  local: boolean;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="card">
      <div className="row between">
        <div className="grow">
          <div className={`title${device.revokedAt ? ' struck' : ''}`}>{device.name}</div>
          <div className="meta">
            {device.kind}
            {device.revokedAt
              ? ` · revoked ${relative(device.revokedAt)}`
              : device.lastSeenAt
                ? ` · seen ${relative(device.lastSeenAt)}`
                : ' · never used'}
          </div>
        </div>

        {!device.revokedAt && local && (
          <button className="btn subtle danger" onClick={() => api.devices.revoke(device.id).then(onChanged)}>
            revoke
          </button>
        )}

        {device.revokedAt &&
          local &&
          (confirming ? (
            <>
              <span className="meta">remove for good?</span>
              <button className="btn subtle danger" onClick={() => api.devices.remove(device.id).then(onChanged)}>
                yes
              </button>
              <button className="btn subtle" onClick={() => setConfirming(false)}>
                no
              </button>
            </>
          ) : (
            <button className="btn subtle" onClick={() => setConfirming(true)}>
              remove
            </button>
          ))}
      </div>
    </div>
  );
}

/**
 * Notifications on this device, when you aren't at the PC.
 *
 * Shown everywhere, because the useful place to turn it on is the phone itself
 * — but it explains itself differently depending on whether this device can
 * actually receive them.
 */
function PhoneNudges() {
  const settings = useAsync(() => api.settings.get(), [], ['settings']);
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const support = checkPushSupport();

  useEffect(() => {
    void currentSubscription().then((s) => setSubscribed(Boolean(s)));
  }, []);

  const current = settings.data;
  if (!current) return null;

  async function turnOn() {
    setBusy(true);
    try {
      const result = await enablePush(current!.vapidPublicKey);
      setMessage(result.message);
      setSubscribed(result.ok);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not enable notifications.');
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    try {
      await disablePush();
      setSubscribed(false);
      setMessage('This device will no longer be notified.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Phone nudges</h2>

      <div className="card">
        <div className="row between">
          <div className="grow">
            <div className="title">Send nudges to my phone when I'm away</div>
            <div className="meta">
              Only once the PC has been untouched for {current.awayFromPcIdleMinutes} minutes{' '}
              <strong>and</strong> nothing is playing — so a long film never sets your pocket buzzing.
            </div>
          </div>
          <Toggle
            on={Boolean(current.pushEnabled)}
            disabled={busy}
            label="Send nudges to my phone"
            onChange={async (on) => {
              await api.settings.update({ pushEnabled: on });
              settings.reload();
            }}
          />
        </div>
      </div>

      {/* Absent on a server older than the column. Rendering a switch that
          would be silently dropped is worse than not offering it. */}
      {current.pushDefault !== undefined && (
        <div className="card">
          <div className="row between">
            <div className="grow">
              <div className="title">Push new tasks and habits by default</div>
              <div className="meta">
                What something gets when you haven't said either way. Each task and habit can override
                this in its own editor, and anything left on <em>Default</em> follows this switch —
                including things you made before you changed it.
              </div>
            </div>
            <Toggle
              on={Boolean(current.pushDefault)}
              disabled={busy || !current.pushEnabled}
              label="Push new tasks and habits by default"
              onChange={async (on) => {
                await api.settings.update({ pushDefault: on });
                settings.reload();
              }}
            />
          </div>
          {!current.pushEnabled && (
            <div className="meta" style={{ marginTop: 8 }}>
              Nothing goes to the phone at all while the switch above is off, so this has no effect yet.
            </div>
          )}
        </div>
      )}

      <div className="card">
        <div className="row between">
          <div className="grow">
            <div className="title">Notifications on this device</div>
            <div className="meta">
              {!support.supported
                ? support.reason
                : subscribed
                  ? 'This device is set up to receive them.'
                  : 'Not set up yet.'}
            </div>
            {!support.supported && support.fix && (
              <div className="meta" style={{ marginTop: 6 }}>
                <strong>{support.fix}</strong>
              </div>
            )}
          </div>
          {support.supported && (
            <button className="btn" disabled={busy} onClick={subscribed ? turnOff : turnOn}>
              {busy ? '…' : subscribed ? 'Turn off' : 'Turn on'}
            </button>
          )}
        </div>
        {message && <div className="meta" style={{ marginTop: 8 }}>{message}</div>}

        {/* Shown on the device with the problem, since that's where it can be
            read — describing it back on the PC is no help. */}
        {!support.supported && <Diagnostics />}
      </div>
    </section>
  );
}

function Diagnostics() {
  const [info, setInfo] = useState<PushDiagnostics | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void pushDiagnostics().then(setInfo);
  }, []);

  if (!info) return null;

  const rows: [string, string, boolean][] = [
    ['Address', info.origin, info.secure],
    ['Secure connection', info.secure ? 'yes' : 'no — needs https', info.secure],
    ['Opened from Home Screen', info.installed ? 'yes' : 'no', info.installed],
    ['Service worker', info.hasServiceWorker ? 'available' : 'missing', info.hasServiceWorker],
    ['Push support', info.hasPushManager ? 'available' : 'missing', info.hasPushManager],
    ['Permission', info.permission, info.permission === 'granted'],
  ];

  return (
    <>
      <button className="btn subtle" style={{ marginTop: 8 }} onClick={() => setOpen((v) => !v)}>
        {open ? 'hide details' : 'why not?'}
      </button>
      {open && (
        <div className="diagnostics">
          {rows.map(([label, value, ok]) => (
            <div className="row between" key={label}>
              <span className="meta">{label}</span>
              <span className={ok ? 'meta ok-text' : 'meta urgent'}>{value}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Pairing for the browser extension.
 *
 * Separate from the phone flow because the answer is different: the extension
 * is the only other thing allowed to touch the vault, so its code is worth
 * treating as a distinct decision rather than one more device.
 */
function BrowserExtension({ onAdded }: { onAdded: () => void }) {
  const [issued, setIssued] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function createCode() {
    setError('');
    try {
      const created = await api.devices.create({ name: 'Browser extension', kind: 'extension' });
      setIssued(created.token);
      onAdded();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'could not create a code');
    }
  }

  return (
    <section>
      <h2>Browser extension</h2>
      <div className="card">
        <div className="title">Autofill in this browser</div>
        <div className="meta" style={{ marginTop: 4 }}>
          The extension is the only thing besides this PC that may read the vault. Load it from{' '}
          <code>packages\extension</code> at <code>brave://extensions</code> with developer mode on, then
          paste a code below into it.
        </div>

        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn primary" onClick={createCode}>
            Create code
          </button>
        </div>
        {error && <div className="banner">{error}</div>}
        {issued && (
          <>
            <input readOnly value={issued} onFocus={(e) => e.currentTarget.select()} style={{ marginTop: 8 }} />
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn" onClick={() => navigator.clipboard?.writeText(issued).catch(() => {})}>
                Copy
              </button>
              <span className="meta">Shown once.</span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

const toTimeInput = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

const fromTimeInput = (value: string) => {
  const [h, m] = value.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

const QUIET_EXPLANATION: Record<string, string> = {
  'reminders-off': 'Reminders are switched off entirely.',
  paused: 'Paused by hand.',
  'quiet-hours': 'Inside your quiet hours.',
  'windows-dnd': "Windows Do Not Disturb is on, and you've asked Everything to follow it.",
};

const PAUSE_CHOICES = [
  { hours: 1, label: '1 hour' },
  { hours: 8, label: '8 hours' },
  { hours: 12, label: '12 hours' },
];

/**
 * When reminders are allowed to interrupt at all.
 *
 * Three independent ways to go quiet, because one fixed schedule doesn't suit
 * an irregular one: a clock window, following Windows' own Do Not Disturb (a
 * switch flipped when you actually go to bed), and a manual pause.
 */
function QuietHours() {
  const settings = useAsync(() => api.settings.get(), [], ['settings']);
  const [saving, setSaving] = useState(false);

  const current = settings.data;
  if (!current) return null;

  async function update(payload: Parameters<typeof api.settings.update>[0]) {
    setSaving(true);
    try {
      await api.settings.update(payload);
      settings.reload();
    } finally {
      setSaving(false);
    }
  }

  const pausedUntil = current.dndUntil && current.dndUntil > Date.now() ? current.dndUntil : null;

  return (
    <section>
      <h2>Reminders</h2>

      <div className="card">
        <div className="row between">
          <div className="grow">
            <div className="title">{current.quietNow ? 'Silent right now' : 'Active'}</div>
            <div className="meta">
              {current.quietNow
                ? QUIET_EXPLANATION[current.quietReason ?? ''] ?? 'Something is holding reminders.'
                : 'Still silent during a game, and while you are away from the desk.'}
            </div>
          </div>
          <button className="btn" disabled={saving} onClick={() => update({ remindersEnabled: !current.remindersEnabled })}>
            {current.remindersEnabled ? 'Turn all off' : 'Turn on'}
          </button>
        </div>
      </div>

      {/* Absent on a server older than the column — see AppSettings. */}
      {current.soundEnabled !== undefined && (
        <div className="card">
          <div className="row between">
            <div className="grow">
              <div className="title">Play a sound</div>
              <div className="meta">
                A short tone with each popup — one for a nudge, and for voice, one when it starts
                listening and another when it did or didn't catch you. A nudge that quiet hours are
                holding makes no sound because it never arrives; a voice reply still will, since you
                asked for it.
              </div>
            </div>
            <Toggle
              on={Boolean(current.soundEnabled)}
              disabled={saving}
              label="Play a sound with popups"
              onChange={(on) => update({ soundEnabled: on })}
            />
          </div>
        </div>
      )}

      <div className="card">
        <div className="row between">
          <div className="grow">
            <div className="title">Pause for a while</div>
            <div className="meta">
              {pausedUntil ? `Paused until ${clockTime(pausedUntil)}.` : 'A one-off, for when you turn in early or late.'}
            </div>
          </div>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          {pausedUntil ? (
            <button className="btn primary" disabled={saving} onClick={() => update({ dndUntil: null })}>
              Resume now
            </button>
          ) : (
            PAUSE_CHOICES.map(({ hours, label }) => (
              <button
                key={hours}
                className="btn"
                disabled={saving}
                onClick={() => update({ dndUntil: Date.now() + hours * 60 * 60_000 })}
              >
                {label}
              </button>
            ))
          )}
        </div>
      </div>

      <div className="card">
        <div className="row between">
          <div className="grow">
            <div className="title">Follow Windows Do Not Disturb</div>
            <div className="meta">
              Best if your sleep is irregular — flip Do Not Disturb in Windows whenever you turn in, and
              Everything goes quiet with it.
              {current.followWindowsDnd ? (current.windowsDnd ? ' Windows says it is on now.' : ' Windows says it is off now.') : ''}
            </div>
          </div>
          <Toggle
            on={Boolean(current.followWindowsDnd)}
            disabled={saving}
            label="Follow Windows Do Not Disturb"
            onChange={(on) => update({ followWindowsDnd: on })}
          />
        </div>
      </div>

      <div className="card">
        <div className="row between">
          <div className="grow">
            <div className="title">Quiet hours</div>
            <div className="meta">
              {current.quietHoursEnabled
                ? 'Nothing interrupts between these times, not even a deadline.'
                : 'Off — reminders can arrive at any hour.'}
            </div>
          </div>
          <Toggle
            on={Boolean(current.quietHoursEnabled)}
            disabled={saving}
            label="Quiet hours"
            onChange={(on) => update({ quietHoursEnabled: on })}
          />
        </div>

        {/* Times stay editable while off, so they're ready when it's switched on. */}
        <div className="row" style={{ marginTop: 10, opacity: current.quietHoursEnabled ? 1 : 0.5 }}>
          <input
            type="time"
            value={toTimeInput(current.quietStartMinute)}
            aria-label="Quiet hours start"
            onChange={(e) => update({ quietStartMinute: fromTimeInput(e.target.value) })}
          />
          <span className="meta">to</span>
          <input
            type="time"
            value={toTimeInput(current.quietEndMinute)}
            aria-label="Quiet hours end"
            onChange={(e) => update({ quietEndMinute: fromTimeInput(e.target.value) })}
          />
        </div>
      </div>
    </section>
  );
}

/**
 * Step-by-step for putting Everything on a phone.
 *
 * The address matters more than the code: iOS will only install a web app, and
 * only deliver push notifications, over HTTPS. A plain Tailscale IP loads fine
 * in Safari and then silently fails to install, which is a miserable thing to
 * debug from the sofa — so the guide leads with getting that right.
 */
function AddDeviceGuide({ onAdded }: { onAdded: () => void }) {
  const info = useAsync(() => api.connectInfo(), [], ['devices']);
  const [name, setName] = useState('iPhone');
  const [issued, setIssued] = useState<string | null>(null);
  const [error, setError] = useState('');

  const secure = info.data?.addresses.find((a) => a.secure && a.kind === 'tailscale-https');
  const plainTailscale = info.data?.addresses.find((a) => a.kind === 'tailscale');
  const address = secure ?? plainTailscale ?? info.data?.addresses.find((a) => a.kind === 'lan');

  async function createCode() {
    setError('');
    try {
      const created = await api.devices.create({ name: name.trim() || 'iPhone', kind: 'phone' });
      setIssued(created.token);
      onAdded();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'could not create a code');
    }
  }

  return (
    <div className="card guide">
      <ol>
        <li>
          <strong>Make sure Tailscale is on both devices.</strong>
          <div className="meta">It's what lets your phone reach this PC from anywhere. Free for personal use.</div>
        </li>

        <li>
          <strong>Turn on the secure address.</strong>
          {info.loading && <div className="meta">checking…</div>}
          {!info.loading && secure && (
            <div className="meta ok-text">Already done — your secure address is ready below.</div>
          )}
          {!info.loading && !secure && (
            <>
              <div className="meta">
                iPhones will only install an app, and only show its notifications, over a secure (https)
                address. Run this once on this PC, in PowerShell:
              </div>
              <code className="snippet">tailscale serve --bg {info.data?.port ?? 8787}</code>
              {plainTailscale && (
                <div className="meta">
                  Without it you'd be using <code>{plainTailscale.url}</code>, which loads in Safari but
                  can't be added to the Home Screen.
                </div>
              )}
            </>
          )}
        </li>

        <li>
          <strong>Open this address on your phone.</strong>
          {address ? (
            <>
              <code className="snippet">{secure ? secure.url : address.url}</code>
              <div className="meta">{secure ? secure.label : address.label}</div>
            </>
          ) : (
            <div className="meta">No network address found — is Tailscale running?</div>
          )}
        </li>

        <li>
          <strong>Create a code and paste it there.</strong>
          <div className="row" style={{ marginTop: 8 }}>
            <div className="grow">
              <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Device name" />
            </div>
            <button className="btn primary" onClick={createCode}>
              Create code
            </button>
          </div>
          {error && <div className="banner">{error}</div>}
          {issued && (
            <>
              <input readOnly value={issued} onFocus={(e) => e.currentTarget.select()} style={{ marginTop: 8 }} />
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn" onClick={() => navigator.clipboard?.writeText(issued).catch(() => {})}>
                  Copy
                </button>
                <span className="meta">Shown once — copy it now.</span>
              </div>
            </>
          )}
        </li>

        <li>
          <strong>Add it to your Home Screen.</strong>
          <div className="meta">
            In Safari, tap Share, then "Add to Home Screen". It has to be Safari — other iPhone browsers
            can't install apps. Open it from the Home Screen icon from then on, or notifications won't
            arrive.
          </div>
        </li>
      </ol>
    </div>
  );
}
