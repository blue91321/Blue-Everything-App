import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { ServerUnreachable, api, clearToken, setToken, type Session } from './api';
import { DRAWER_WIDTH, useEdgeDrawer, useMediaQuery } from './useEdgeDrawer';
import { setEnabledFeatures, webFeatures } from './features';
import { installedPackages, packageScreen, setInstalledPackages } from './packages';
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
import { Offline } from './Offline';
import { onDataChange } from './live';
import { onNavigate } from './nav';
import { Dashboard } from './views/Dashboard';
import { Tasks } from './views/Tasks';
import { Habits } from './views/Habits';
import { Settings } from './views/Settings';

/*
 * The one core screen that is fetched rather than bundled.
 *
 * Every other view here is a few kilobytes of form controls. Notes carries a
 * Markdown parser, a renderer, a force-directed graph and fourteen importers'
 * worth of transfer UI, and it put **8KB gzipped into the eager bundle** — on a
 * 92KB bundle whose whole argument is that it is almost entirely React. That is
 * the 9.5KB the friends panel nearly cost, arriving by a different door.
 *
 * So it takes the same shape a feature's screen already has: its own chunk, its
 * own Suspense boundary, fetched the first time the tab is opened. A named
 * export needs the `default` shim; `lazy` wants a module with one.
 */
const Notes = lazy(() => import('./views/Notes').then((m) => ({ default: m.Notes })));

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
interface NavItem {
  id: string;
  label: string;
  glyph: string;
  order: number;
  always: boolean;
  /** Sits at the foot of the drawer rather than in the flow of the list. */
  pinned?: boolean;
}

const CORE_NAV: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', glyph: '◒', order: 10, always: true },
  { id: 'tasks', label: 'Tasks', glyph: '☑', order: 20, always: true },
  { id: 'habits', label: 'Habits', glyph: '↻', order: 30, always: false },
  { id: 'notes', label: 'Notes', glyph: '✎', order: 40, always: false },
  // `pinned` puts it at the foot of the drawer rather than merely last in the
  // list — features add tabs above it, and it should stay where it was.
  { id: 'settings', label: 'Settings', glyph: '⚙', order: 100, always: true, pinned: true },
];

type NavId = string;

/**
 * Below this the drawer slides over the content; at or above it, it docks.
 *
 * It was 900 and hard-coded, and 900 answered "is there room for a drawer
 * beside a *task list*" — one column of short lines. A screen with columns of
 * its own is squeezed a long way above that: at 900 with the drawer showing,
 * the content is left about 640px. So the default is 1200 and the number is a
 * setting, because the right answer depends on the monitor and on which screen
 * you actually live in.
 *
 * Used until the real setting arrives, and as the fallback if it never does.
 */
const DEFAULT_DRAWER_BREAKPOINT = 1200;

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  /** The last session check failed because nothing answered, not because of a 401. */
  const [unreachable, setUnreachable] = useState(false);
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
   * The row a screen should open for editing when it arrives, from the
   * right-click menu.
   *
   * Held here because `App` is the only thing that can change the view, and
   * cleared by the screen once it has acted — see `onFocused`. Keeping it until
   * then rather than clearing on the same tick matters: the target screen has to
   * load its list before it can find the row, so the request has to survive a
   * render or two.
   */
  const [focus, setFocus] = useState<string | null>(null);
  /** Text for the destination's search box — see `NavRequest.search`. */
  const [search, setSearch] = useState<string | null>(null);
  /**
   * The mark, held here so the drawer can draw it.
   *
   * Kept in state rather than read from the settings call each render because
   * the drawer is on screen before any authenticated call returns; the default
   * is the same one the stylesheet and the server fall back to, so the worst
   * case is the right shape arriving a moment later rather than a gap.
   */
  const [logo, setLogo] = useState<{ shape: LogoShape; version: number }>({ shape: 'pause', version: 0 });

  /**
   * The two drawer settings, held here because the shell is what reads them.
   *
   * Defaults until the fetch lands, so the first paint has a drawer in the
   * right place rather than one that jumps once settings arrive.
   */
  const [drawerPrefs, setDrawerPrefs] = useState({
    breakpoint: DEFAULT_DRAWER_BREAKPOINT,
    docked: true,
  });

  /** Is there room to dock it? */
  const wide = useMediaQuery(`(min-width: ${drawerPrefs.breakpoint}px)`);

  /**
   * Collapsed by hand, on a screen wide enough to dock.
   *
   * Session state rather than a write back to the setting: collapsing the menu
   * to read something is a thing you do for a minute, and persisting it would
   * turn a temporary choice into a permanent one. The *setting* says how the
   * app opens; this says what you have done since.
   */
  const [collapsed, setCollapsed] = useState(false);

  /*
   * Follow the stored default when it changes, without stomping a live toggle.
   *
   * The effect must not simply write `docked` on every settings change, or any
   * unrelated save — a habit ticked off on the phone announces itself down the
   * same SSE stream — would snap the menu back open under your hands. Only an
   * actual change to *this* preference re-applies it.
   */
  const appliedDock = useRef<boolean | null>(null);
  useEffect(() => {
    if (appliedDock.current === drawerPrefs.docked) return;
    appliedDock.current = drawerPrefs.docked;
    setCollapsed(!drawerPrefs.docked);
  }, [drawerPrefs.docked]);

  /** Docked open beside the content, as opposed to overlaying or hidden. */
  const isDesktop = wide && !collapsed;
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
      setUnreachable(false);
    } catch (error) {
      sessionRef.current = null;
      setSession(null);
      /*
       * Which kind of failure this was decides which screen you get.
       *
       * Both end with no session, and both used to show the pairing form — so
       * "the server is not running" was reported as "this device is not
       * paired", which sends you looking for a token that was never the
       * problem. The shell is cached by the service worker, so being here with
       * nothing listening is an ordinary situation rather than an odd one.
       */
      setUnreachable(error instanceof ServerUnreachable);
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
        setDrawerPrefs({
          breakpoint: settings.drawerBreakpoint ?? DEFAULT_DRAWER_BREAKPOINT,
          // `!== 0`, not `=== true`: the row returns 0 or 1. See `api.ts`.
          docked: (settings.drawerDocked ?? 1) !== 0,
        });
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

  /**
   * "Take me to that thing" — the right-click menu's half of the navigation.
   *
   * **Above the early returns**, with every other hook, because the three below
   * it are not: React counts hooks per render, and a `useEffect` after
   * `if (checking) return …` is called on some renders and not others. It was
   * written down here first and it took the app down with error #310 on the
   * pairing screen, which is exactly the render where the returns fire.
   *
   * A ref rather than dependencies: `nav`, `isDesktop` and the drawer are all
   * recomputed every render, so depending on them would tear the subscription
   * down and rebuild it constantly. Fed further down, where they exist.
   */
  const latest = useRef<{
    nav: NavItem[];
    isDesktop: boolean;
    setDrawerOpen: (open: boolean) => void;
  }>({ nav: [], isDesktop: true, setDrawerOpen: () => {} });

  useEffect(
    () =>
      onNavigate(({ view: wanted, focus: wantedFocus, search: wantedSearch }) => {
        const { nav: items, isDesktop: wide, setDrawerOpen } = latest.current;
        // An unknown view is ignored rather than switched to: the caller is a
        // menu item, and a typo should leave you where you are rather than on a
        // blank screen.
        if (!items.some((item) => item.id === wanted)) return;
        setView(wanted as NavId);
        setFocus(wantedFocus ?? null);
        setSearch(wantedSearch ?? null);
        if (!wide) setDrawerOpen(false);
      }),
    []
  );

  /*
   * Stable, so the effect in the target screen does not re-run on every render
   * of this one while a focus request is outstanding.
   */
  const clearFocus = useCallback(() => {
    setFocus(null);
    setSearch(null);
  }, []);

  if (checking) {
    return (
      <div className="pair">
        <p>Connecting…</p>
      </div>
    );
  }
  if (!session && unreachable) return <Offline onBack={() => setUnreachable(false)} />;
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
  /*
   * Published the same way and at the same moment, for the same reason: the
   * drawer and the panel picker are built during this render, and a package
   * list arriving a round trip later would draw the menu twice.
   */
  setInstalledPackages(session.packages, { version: session.version ?? '', local: session.local });

  // Widened to NavItem so a discovered feature and a core screen are the same
  // shape here; features never pin, but the drawer should not have to care.
  const nav: NavItem[] = [
    ...CORE_NAV.filter((item) => item.always || isOn(item.id)),
    ...webFeatures.filter((f) => isOn(f.id)).map((f) => ({ ...f, always: false })),
    /*
     * Installed packages sit in the same list, sorted by the same `order`, so a
     * package chooses where its tab goes exactly as a built-in feature does.
     * The server only lists the ones actually running, so there is no filter to
     * apply here — being switched off means never reaching this list at all.
     */
    ...installedPackages()
      .filter((pkg) => pkg.tab !== null)
      .map((pkg) => ({
        id: `package:${pkg.id}`,
        label: pkg.tab!.label,
        glyph: pkg.tab!.glyph,
        order: pkg.tab!.order,
        always: false,
      })),
  ].sort((a, b) => a.order - b.order);

  // Whatever was open may have just been switched off from another device —
  // the SSE stream reloads every client, so this can change under a live page.
  const current = nav.find((n) => n.id === view) ?? nav[0];
  const feature = webFeatures.find((f) => f.id === current.id);
  /*
   * Namespaced so a package can never take over a core tab by choosing the id
   * `settings`. The prefix is added here rather than by the server, because it
   * is a fact about this app's navigation rather than about the package.
   */
  const packageId = current.id.startsWith('package:') ? current.id.slice('package:'.length) : null;

  const shown = isDesktop || drawer.open || drawer.dragX !== null;
  const offset = drawer.dragX ?? (drawer.open ? DRAWER_WIDTH : 0);

  // While a finger is down the drawer tracks it exactly, so transitions are
  // suppressed — animating toward a position that changes every frame is what
  // makes a drag feel laggy.
  // Not a hook: the ref is created above, with the others, and only fed here
  // where the values it carries actually exist.
  latest.current = { nav, isDesktop, setDrawerOpen: drawer.setOpen };

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

  /*
   * Nothing else in the app navigates itself, so this is the whole of the port.
   * An unknown view is ignored rather than switched to: the caller is a menu
   * item and a typo there should leave you where you are, not on a blank screen.
   */
  return (
    <div className={isDesktop ? 'shell desktop' : 'shell'}>
      <aside className="drawer" style={drawerStyle} aria-hidden={!shown && !isDesktop}>
        <div className="drawer-head">
          <Logo shape={logo.shape} size={26} version={logo.version} />
          <span>Blue Everything</span>
        </div>
        <nav>
          {nav.map(({ id, label, glyph, pinned }) => (
            <button
              key={id}
              className={pinned ? 'pinned' : undefined}
              aria-current={current.id === id}
              onClick={() => go(id)}
            >
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
          {/*
            One button, at every width, which is the change. It used to appear
            only below the breakpoint, so on a wide screen the menu was
            permanent furniture — 260px of navigation you cannot put away while
            reading something that wants the room.

            It does two different things because there are two different states
            to leave: docked, where the content is offset and collapsing gives
            that width back, and undocked, where the drawer overlays and this
            opens it. Both are "show or hide the menu", which is why it is one
            control rather than two that would need explaining apart.
          */}
          <button
            className="menu"
            onClick={() => (wide ? setCollapsed((was) => !was) : drawer.toggle())}
            aria-label={isDesktop ? 'Hide menu' : 'Show menu'}
            aria-expanded={isDesktop || drawer.open}
          >
            ☰
          </button>
          <h1>{current.label}</h1>
        </header>

        {current.id === 'dashboard' && <Dashboard />}
        {current.id === 'tasks' && <Tasks focus={focus} onFocused={clearFocus} />}
        {current.id === 'habits' && <Habits focus={focus} onFocused={clearFocus} />}
        {current.id === 'notes' && (
          <Suspense fallback={<div className="empty">loading…</div>}>
            <Notes session={session} />
          </Suspense>
        )}
        {current.id === 'settings' && (
          <Settings session={session} onChanged={checkSession} focus={focus} onFocused={clearFocus} />
        )}

        {/*
          Each feature is its own chunk, fetched the first time its tab is
          opened. The fallback is deliberately plain: on this network the chunk
          arrives in a few milliseconds, and a spinner that flashes is worse
          than a line of text that does not.
        */}
        {feature && (
          <Suspense fallback={<div className="empty">loading…</div>}>
            <feature.View local={session.local} search={search} onFocused={clearFocus} />
          </Suspense>
        )}

        {/*
          A package's screen, fetched the first time its tab is opened — same
          shape as a feature's, one level more indirect. `key` matters: without
          it, switching between two package tabs would reuse the component
          instance and show the previous package's state under the new name.
        */}
        {packageId && (
          <Suspense fallback={<div className="empty">loading…</div>}>
            {(() => {
              const Screen = packageScreen(packageId);
              return <Screen key={packageId} local={session.local} search={search} onFocused={clearFocus} />;
            })()}
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
