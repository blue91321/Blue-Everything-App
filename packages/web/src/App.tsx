import { useCallback, useEffect, useState } from 'react';
import { api, clearToken, setToken, type Session } from './api';
import { DRAWER_WIDTH, useEdgeDrawer, useMediaQuery } from './useEdgeDrawer';
import { Dashboard } from './views/Dashboard';
import { Tasks } from './views/Tasks';
import { Habits } from './views/Habits';
import { Notes } from './views/Notes';
import { Vault } from './views/Vault';
import { Settings } from './views/Settings';

const NAV = [
  { id: 'dashboard', label: 'Dashboard', glyph: '◒' },
  { id: 'tasks', label: 'Tasks', glyph: '☑' },
  { id: 'habits', label: 'Habits', glyph: '↻' },
  { id: 'notes', label: 'Notes', glyph: '✎' },
  { id: 'vault', label: 'Vault', glyph: '🔒' },
  { id: 'settings', label: 'Settings', glyph: '⚙' },
] as const;

type NavId = (typeof NAV)[number]['id'];

/** Below this the drawer slides over the content; above it, it's always there. */
const DESKTOP_QUERY = '(min-width: 900px)';

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const [view, setView] = useState<NavId>('dashboard');

  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const drawer = useEdgeDrawer(!isDesktop);

  const checkSession = useCallback(async () => {
    setChecking(true);
    try {
      setSession(await api.session());
    } catch {
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
      setSession(null);
    };
    window.addEventListener('everything:unauthorized', onUnauthorized);
    return () => window.removeEventListener('everything:unauthorized', onUnauthorized);
  }, []);

  if (checking) {
    return (
      <div className="pair">
        <p>Connecting…</p>
      </div>
    );
  }
  if (!session) return <Pairing onPaired={checkSession} />;

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
        <div className="drawer-head">Everything</div>
        <nav>
          {NAV.map(({ id, label, glyph }) => (
            <button key={id} aria-current={view === id} onClick={() => go(id)}>
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
          <h1>{NAV.find((n) => n.id === view)!.label}</h1>
        </header>

        {view === 'dashboard' && <Dashboard />}
        {view === 'tasks' && <Tasks />}
        {view === 'habits' && <Habits />}
        {view === 'notes' && <Notes />}
        {view === 'vault' && <Vault />}
        {view === 'settings' && <Settings session={session} onChanged={checkSession} />}
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
