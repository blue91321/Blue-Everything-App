import { useEffect, useRef, useState } from 'react';
import { api, type AppSettings, type Device, type Session } from '../api';
import { Logo, type LogoShape } from '../Logo';
import { useAsync } from '../useAsync';
import { panelChoices } from '../panels';
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

/**
 * Which tab a linkable section lives behind.
 *
 * A table rather than a search of the DOM, because the section is not *in* the
 * DOM until its tab is open — so finding it has to start from knowing where it
 * is. The key is the element's `id`, which is also what the caller passes.
 */
const SECTION_TAB: Record<string, TabId> = {
  'dashboard-panel': 'general',
};

export function Settings({
  session,
  onChanged,
  focus,
  onFocused,
}: {
  session: Session;
  onChanged: () => void;
  /** A section id to open and scroll to — see `SECTION_TAB`. */
  focus?: string | null;
  onFocused?: () => void;
}) {
  const [tab, setTab] = useState<TabId>('general');

  /*
   * Sent here by something that wanted a *particular* setting — the Dashboard
   * panel's "change what's here" button. The tabs made Settings much easier to
   * navigate and made linking into it impossible without this: the section you
   * were pointed at may be behind a tab you are not on, and landing on General
   * while the answer is under Packages is worse than not linking at all.
   */
  useEffect(() => {
    if (!focus) return;
    const home = SECTION_TAB[focus];
    if (!home) return;
    setTab(home);
    /*
     * **Waited for on a timer, not looked for once, and not on a frame.**
     *
     * Two goes at this, both silently doing nothing:
     *
     * A single `requestAnimationFrame` was the first, and the section is behind
     * its tab *and* behind a `useAsync` — so at the next frame it is usually not
     * in the document. Retrying across frames fixed that and still did nothing,
     * because **`requestAnimationFrame` does not fire at all when the page is
     * not compositing** — a hidden tab, a window nobody is showing. `setTimeout`
     * runs regardless, throttled at worst, for exactly the same complexity.
     *
     * Both failures presented identically: the tab switched, because that part
     * is synchronous, and nothing else happened. The half that worked hid the
     * half that did not.
     *
     * Bounded, so a section id that matches nothing gives up rather than
     * retrying for the life of the page.
     */
    let frames = 0;
    let cancelled = false;

    /*
     * **`onFocused` is called at the *end*, not before the wait.**
     *
     * Clearing the request changes `focus`, which re-runs this effect, whose
     * cleanup sets `cancelled` — so announcing "handled" up front cancelled the
     * frame loop it had just started, every time. The tab still switched, since
     * that happens synchronously, which is what made it look like the scroll was
     * the broken part rather than the waiting.
     */
    const done = () => {
      cancelled = true;
      onFocused?.();
    };

    const find = () => {
      if (cancelled) return;
      const element = document.getElementById(focus);
      if (!element) {
        // Giving up still counts as handled, or the request would sit there and
        // fire again the next time this screen mounted.
        if (frames++ < 120) setTimeout(find, 16);
        else done();
        return;
      }
      element.scrollIntoView({ block: 'center', behavior: 'smooth' });
      // A moment of highlight, because "we brought you here" is otherwise
      // indistinguishable from "the tab you opened happened to look like this".
      element.classList.add('flash');
      setTimeout(() => element.classList.remove('flash'), 1400);
      done();
    };
    setTimeout(find, 0);

    return () => {
      cancelled = true;
    };
  }, [focus, onFocused]);

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
      <DashboardPanel />
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

/**
 * What sits beside the Dashboard.
 *
 * The options are discovered, not listed here: `panelChoices()` merges the
 * panels core owns with whatever the installed features declare, so a build with
 * `features/integrations` deleted simply offers one fewer and this file does not
 * change. Same reasoning as the drawer's tabs.
 *
 * Radio buttons rather than a dropdown, unlike the tone picker. There are three
 * of them, each wants a line of explanation about what you would actually see,
 * and a `<select>` has nowhere to put one.
 */
function DashboardPanel() {
  const settings = useAsync(() => api.settings.get(), [], ['settings']);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState('');

  const chosen = settings.data?.dashboardPanel ?? '';
  const choices = panelChoices();

  // A server that predates the column sends nothing, and a picker that writes a
  // field the server drops is worse than no picker at all.
  if (settings.data && settings.data.dashboardPanel === undefined) return null;

  /**
   * One writer for both controls.
   *
   * The panel choice and its scope are two fields of one settings row, and
   * `PATCH /api/settings` takes both — so a second saver would be a second copy
   * of the busy flag, the error handling and the reload.
   */
  const choose = async (id: string, scope?: 'all' | 'favourites') => {
    setSaving(true);
    setProblem('');
    try {
      await api.settings.update({ dashboardPanel: id, ...(scope ? { livePanelScope: scope } : {}) });
      settings.reload();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section id="dashboard-panel">
      <h2>Beside the Dashboard</h2>
      <div className="card">
        <div className="meta" style={{ marginBottom: 8 }}>
          A second column on a wide screen, for something worth having in the corner of your eye. On a
          phone it sits underneath instead.
        </div>

        <label className="row" style={{ alignItems: 'center', gap: '.5rem', marginTop: 6 }}>
          <input
            type="radio"
            name="dashboard-panel"
            checked={chosen === ''}
            disabled={saving}
            onChange={() => void choose('')}
          />
          <span className="grow">
            Nothing <span className="meta">— one column, as it was</span>
          </span>
        </label>

        {choices.map((panel) => (
          <label key={panel.id} className="row" style={{ alignItems: 'center', gap: '.5rem', marginTop: 6 }}>
            <input
              type="radio"
              name="dashboard-panel"
              checked={chosen === panel.id}
              disabled={saving}
              onChange={() => void choose(panel.id)}
            />
            <span className="grow">
              {panel.label}
              {panel.hint && <span className="meta"> — {panel.hint}</span>}
            </span>
          </label>
        ))}

        {/*
         * The stored choice belongs to a feature that is off, or to a build that
         * no longer has it. Said out loud rather than silently rewritten to
         * "Nothing": the setting is deliberately left alone so switching the
         * feature back on restores what you had, and without this line the
         * Dashboard would just be missing a column for no visible reason.
         */}
        {chosen !== '' && !choices.some((panel) => panel.id === chosen) && (
          <div className="meta" style={{ marginTop: 8 }}>
            The panel you picked (<code>{chosen}</code>) is not available in this build — its feature is
            switched off or has been removed. Your choice is kept, so switching it back on brings the
            panel back.
          </div>
        )}

        {/*
          Only while the live panel is the one chosen. A scope control for a panel
          you are not showing is a setting for nothing — and worse, it invites the
          reading that it governs the Live *tab*, which always shows everybody.
        */}
        {chosen === 'integrations:live' && settings.data?.livePanelScope !== undefined && (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
            <div className="title">Which live channels</div>
            <div className="meta" style={{ marginTop: 4, marginBottom: 8 }}>
              The Connections tab always lists everyone on air; this is only the column on the Dashboard.
              Star a channel there to add it here.
            </div>

            <div className="row wrap" style={{ gap: '.35rem' }}>
              {LIVE_SCOPES.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={(settings.data?.livePanelScope ?? 'all') === option.id ? 'btn primary' : 'btn subtle'}
                  disabled={saving}
                  onClick={() => void choose(chosen, option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {problem && <div className="banner">{problem}</div>}
      </div>
    </section>
  );
}

/**
 * Two choices, so two buttons rather than a range input.
 *
 * A slider is the right control for a number on a continuum — the gauge drain
 * and fill both earn one. This is a pair of named alternatives, where a slider
 * would have two positions, no labels at the stops, and no way to show which is
 * live except by where the handle sat.
 */
const LIVE_SCOPES: { id: 'all' | 'favourites'; label: string }[] = [
  { id: 'all', label: 'Everyone I follow' },
  { id: 'favourites', label: 'Starred only' },
];

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

function playTone(tone: string): void {
  // Silence is a real choice, and the server answers 204 for it. Asking anyway
  // would be harmless and would put an empty-source error in the console.
  if (tone === '' || tone === 'none') return;

  let audio = auditioned.get(tone);
  if (!audio) {
    audio = new Audio(`/sounds/${tone}.wav`);
    auditioned.set(tone, audio);
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

function SoundTones({
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
              playTone(e.target.value);
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

  const updates = data.updates;

  return (
    <section>
      <h2>Packages</h2>
      <div className="meta" style={{ marginBottom: 12 }}>
        Optional parts of the app. Switching one off unregisters its API routes, hides its tab, and stops
        the agent loading it — you get the memory and the disk back, not just the menu entry.
      </div>

      {/* Absent on a server older than per-package versions. */}
      {data.appVersion && (
        <div className="card">
          <div className="row between">
            <div className="grow">
              <div className="title">Blue Everything {data.appVersion}</div>
              <div className="meta" style={{ marginTop: 4 }}>
                {updates?.configured
                  ? `Updates come from ${updates.source}.`
                  : 'Everything below ships with the app, so it is all this version. Packages downloaded separately will show their own.'}
              </div>
              {/* Says why rather than leaving a dead button to be poked at.
                  The same reasoning as the switches being disabled when
                  EVERYTHING_FEATURES overrides them. */}
              {!updates?.configured && (
                <div className="meta" style={{ marginTop: 4 }}>
                  No update source is set up yet — set <code>UPDATE_URL</code> once the download site exists.
                </div>
              )}
            </div>
            <button
              className="btn"
              disabled={!updates?.configured}
              title={updates?.configured ? 'Check the download site for newer versions' : 'No update source configured'}
              onClick={() => setError('Update checking is not wired up yet.')}
            >
              Check for updates
            </button>
          </div>
        </div>
      )}

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
                {/* The version sits on the row rather than in a column of its
                    own: with everything bundled they are all the same number,
                    and a column of identical values reads as noise until one
                    of them genuinely diverges. */}
                {feature.version && (
                  <span className="meta" title={feature.bundled ? 'ships with the app' : 'installed separately'}>
                    {' '}
                    · {feature.version}
                    {feature.bundled ? '' : ' (separate)'}
                  </span>
                )}
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

          {/* Only when there is something to hear. A row of tone pickers above
              a switch that is off is four controls for a thing that cannot
              happen. */}
          {Boolean(current.soundEnabled) && (
            <SoundTones current={current} saving={saving} update={update} />
          )}
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
