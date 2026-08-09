import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { api, clearToken, setToken, type Session } from './api';
import { DRAWER_WIDTH, useEdgeDrawer, useMediaQuery } from './useEdgeDrawer';
import { setEnabledFeatures, webFeatures } from './features';
import {
  applyFavicon,
  applyLook,
  watchSystemTheme,
  DEFAULT_ACCENT,
  DEFAULT_THEME,
  type Accent,
  type AppTheme,
} from './theme';
import { Logo, type LogoShape } from './Logo';
import { onDataChange } from './live';
import { Dashboard } from './views/Dashboard';
import { Tasks } from './views/Tasks';
import { Habits } from './views/Habits';
import { Notes } from './views/Notes';
import { Settings } from './views/Settings';

/**
 * The screens that are always here. Dashboard and Tasks are the nudge engine's
 * own face and cannot be switched off; Habits and Notes can be, which the
 * server reports, but they are not separable folders — the Dashboard renders
 * habits inline.
 *
 * `order` interleaves these with the discovered features in `./features`, so a
 * feature decides where its own tab sits rather than the drawer knowing about
 * every feature that might ever exist.
 */
const CORE_NAV = [
  { id: 'dashboard', label: 'Dashboard', glyph: '◒', order: 10, always: true },
  { id: 'tasks', label: 'Tasks', glyph: '☑', order: 20, always: true },
  { id: 'habits', label: 'Habits', glyph: '↻', order: 30, always: false },
  { id: 'notes', label: 'Notes', glyph: '✎', order: 40, always: false },
  { id: 'settings', label: 'Settings', glyph: '⚙', order: 100, always: true },
];

type NavId = string;

/** Below this the drawer slides over the content; above it, it's always there. */
const DESKTOP_QUERY = '(min-width: 900px)';

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  /**
   * The same value, readable without making `checkSession` depend on it.
   *
   * A `useCallback` that closed over `session` would get a new identity on every
   * session change, and it is the dependency of the mount effect — so the app
   * would re-check itself in a loop.
   */
  const sessionRef = useRef<Session | null>(null);
  const [view, setView] = useState<NavId>('dashboard');
  /**
   * The mark, held here so the drawer can draw it.
   *
   * Kept in state rather than read from the settings call each render because
   * the drawer is on screen before any authenticated call returns; the default
   * is the same one the stylesheet and the server fall back to, so the worst
   * case is the right shape arriving a moment later rather than a gap.
   */
  const [logo, setLogo] = useState<{ shape: LogoShape; version: number }>({ shape: 'pause', version: 0 });

  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const drawer = useEdgeDrawer(!isDesktop);

  /**
   * Re-check who we are, **without taking the app off the screen**.
   *
   * `checking` renders a "Connecting…" card *instead of* the whole shell, so
   * setting it on every re-check unmounted every screen and rebuilt it — which
   * is a scroll position lost, a form field blanked, and a visible flash. It
   * looked exactly like a page reload, and got reported as one.
   *
   * A first check has nothing to show and must block. A later one is a refresh
   * of something already on screen: the answer almost never changes, and when
   * it does the shell re-renders in place with the new tabs.
   */
  const checkSession = useCallback(async () => {
    setChecking((wasChecking) => wasChecking || sessionRef.current === null);
    try {
      const next = await api.session();
      sessionRef.current = next;
      setSession(next);
    } catch {
      sessionRef.current = null;
      setSession(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  useEffect(() => {
    const onUnauthorized = () => {
      clearToken();
      sessionRef.current = null;
      setSession(null);
    };
    window.addEventListener('everything:unauthorized', onUnauthorized);
    return () => window.removeEventListener('everything:unauthorized', onUnauthorized);
  }, []);

  /*
   * Pull the stored look down once the session exists.
   *
   * Separate from the inline script in index.html, which applies a *cached*
   * answer instantly. This is the authoritative one, and it also updates that
   * cache — so changing the accent on the phone shows up on the PC on its next
   * load rather than never.
   *
   * Re-run on every server change via `onDataChange` — the same SSE stream
   * every list already listens to — so saving the accent on the phone repaints
   * the PC without a refresh, and without this needing its own transport.
   */
  useEffect(() => {
    if (!session) return;

    let cancelled = false;
    const load = async () => {
      try {
        const settings = await api.settings.get();
        if (cancelled) return;
        const theme = (settings.theme ?? DEFAULT_THEME) as AppTheme;
        const accent = (settings.accentColor ?? DEFAULT_ACCENT) as Accent;
        const shape = (settings.logoShape ?? 'pause') as LogoShape;
        const version = settings.logoVersion ?? 0;

        applyLook(theme, accent);
        watchSystemTheme(theme, accent);
        setLogo({ shape, version });
        // The tab icon is a real file, so it needs a URL that changes when the
        // mark does — the accent and the shape are both part of the answer.
        applyFavicon(`${accent}-${shape}-${version}`);
      } catch {
        // A failed settings fetch must not blank the app; the cached look from
        // index.html is already on screen and is almost certainly still right.
      }
    };

    void load();
    const unsubscribe = onDataChange(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [session]);

  if (checking) {
    return (
      <div className="pair">
        <p>Connecting…</p>
      </div>
    );
  }
  if (!session) return <Pairing onPaired={checkSession} />;

  /*
   * A tab appears only when both halves agree it exists: the server has the
   * feature switched on *and* this build contains its screen. They are updated
   * independently — the PWA is rebuilt from source, the server reads
   * features.json — so either can be ahead of the other, and showing a tab on
   * one side's say-so alone is how you get a menu item that 404s or throws.
   *
   * An older server that predates all this sends no `features` at all, so an
   * absent list means "everything", not "nothing".
   */
  const enabled = session.features;
  const isOn = (id: string) => enabled === undefined || enabled.includes(id);

  // Published before anything renders, for the screens too deep to be given it
  // as a prop — see the note in ./features.
  setEnabledFeatures(enabled);

  const nav = [
    ...CORE_NAV.filter((item) => item.always || isOn(item.id)),
    ...webFeatures.filter((f) => isOn(f.id)),
  ].sort((a, b) => a.order - b.order);

  // Whatever was open may have just been switched off from another device —
  // the SSE stream reloads every client, so this can change under a live page.
  const current = nav.find((n) => n.id === view) ?? nav[0];
  const feature = webFeatures.find((f) => f.id === current.id);

  const shown = isDesktop || drawer.open || drawer.dragX !== null;
  const offset = drawer.dragX ?? (drawer.open ? DRAWER_WIDTH : 0);

  // While a finger is down the drawer tracks it exactly, so transitions are
  // suppressed — animating toward a position that changes every frame is what
  // makes a drag feel laggy.
  const drawerStyle = isDesktop
    ? undefined
    : {
        transform: `translateX(${offset - DRAWER_WIDTH}px)`,
        transition: drawer.dragX === null ? undefined : 'none',
      };

  function go(id: NavId) {
    setView(id);
    if (!isDesktop) drawer.setOpen(false);
  }

  return (
    <div className={isDesktop ? 'shell desktop' : 'shell'}>
      <aside className="drawer" style={drawerStyle} aria-hidden={!shown && !isDesktop}>
        <div className="drawer-head">
          <Logo shape={logo.shape} size={26} version={logo.version} />
          <span>Blue Everything</span>
        </div>
        <nav>
          {nav.map(({ id, label, glyph }) => (
            <button key={id} aria-current={current.id === id} onClick={() => go(id)}>
              <span className="glyph" aria-hidden="true">
                {glyph}
              </span>
              {label}
            </button>
          ))}
        </nav>
        <div className="drawer-foot">{session.local ? 'This PC' : 'Connected device'}</div>
      </aside>

      {!isDesktop && (
        <div
          className="backdrop"
          hidden={!shown}
          style={{ opacity: (offset / DRAWER_WIDTH) * 0.6, transition: drawer.dragX === null ? undefined : 'none' }}
          onClick={() => drawer.setOpen(false)}
        />
      )}

      <div className="app">
        <header className="top">
          {!isDesktop && (
            <button className="menu" onClick={drawer.toggle} aria-label="Open menu" aria-expanded={drawer.open}>
              ☰
            </button>
          )}
          <h1>{current.label}</h1>
        </header>

        {current.id === 'dashboard' && <Dashboard />}
        {current.id === 'tasks' && <Tasks />}
        {current.id === 'habits' && <Habits />}
        {current.id === 'notes' && <Notes />}
        {current.id === 'settings' && <Settings session={session} onChanged={checkSession} />}

        {/*
          Each feature is its own chunk, fetched the first time its tab is
          opened. The fallback is deliberately plain: on this network the chunk
          arrives in a few milliseconds, and a spinner that flashes is worse
          than a line of text that does not.
        */}
        {feature && (
          <Suspense fallback={<div className="empty">loading…</div>}>
            <feature.View local={session.local} />
          </Suspense>
        )}
      </div>
    </div>
  );
}

/**
 * Only ever seen on a device that isn't the server's own PC — normally the
 * phone. The token is created in the app on the PC, under Settings.
 */
function Pairing({ onPaired }: { onPaired: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setToken(value);

    try {
      await api.session();
      onPaired();
    } catch {
      clearToken();
      setError('That code was not accepted.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="pair" onSubmit={submit}>
      <h1>Connect this device</h1>
      <p>
        On the PC running Everything, open the app, go to <strong>Settings</strong>, and choose{' '}
        <strong>Add a device</strong>. Paste the code it gives you.
      </p>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="paste the code"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      {error && <div className="banner">{error}</div>}
      <p style={{ marginTop: 16 }}>
        <button className="btn primary" type="submit" disabled={!value.trim() || busy}>
          {busy ? 'checking…' : 'Connect'}
        </button>
      </p>
    </form>
  );
}
