/**
 * Applying the stored look to the document.
 *
 * The setting lives on the server so the phone and the PC agree — picking blue
 * on one and finding the other still amber would read as the change not having
 * saved. But the server is a round trip away, and a round trip is long enough
 * to show the wrong colours first, so the last known answer is mirrored into
 * `localStorage` and applied by an inline script in `index.html` before any of
 * this loads.
 *
 * That makes localStorage a *cache*, not the source of truth. It is only ever
 * written from a server response, never from a click.
 */

export type AppTheme = 'dark' | 'light' | 'system';

/** Kept in step with ACCENT_COLORS in `shared` — the PWA cannot import it. */
export const ACCENTS = ['blue', 'amber', 'green', 'teal', 'purple', 'pink', 'red', 'grey'] as const;
export type Accent = (typeof ACCENTS)[number];

export const ACCENT_LABELS: Record<Accent, string> = {
  blue: 'Blue',
  amber: 'Amber',
  green: 'Green',
  teal: 'Teal',
  purple: 'Purple',
  pink: 'Pink',
  red: 'Red',
  grey: 'Grey',
};

export const THEME_KEY = 'everything:theme';
export const ACCENT_KEY = 'everything:accent';

export const DEFAULT_THEME: AppTheme = 'dark';
export const DEFAULT_ACCENT: Accent = 'blue';

/**
 * `system` is resolved here rather than by a CSS media query.
 *
 * The stored setting has three values and CSS only understands two, so leaving
 * it to `prefers-color-scheme` would mean 'dark' and 'system' were
 * indistinguishable in the stylesheet — and an explicit 'dark' would flip to
 * white the moment Windows decided it was morning.
 */
export function resolveTheme(theme: AppTheme): 'dark' | 'light' {
  if (theme !== 'system') return theme;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/**
 * Point the tab icon at the server-rendered mark.
 *
 * The favicon has to be a real file rather than inline SVG — the tab strip is
 * outside the document — so this is the one place the PNG endpoint is used from
 * the page. The version in the query is what makes a changed mark actually
 * appear: browsers cache favicons hard enough that a fixed URL would keep
 * showing the old one for days.
 */
export function applyFavicon(signature: string): void {
  const href = `/icon/64.png?v=${encodeURIComponent(signature)}`;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  if (link.getAttribute('href') !== href) link.setAttribute('href', href);

  // iOS uses this one for the home screen, and ignores `rel="icon"` entirely.
  let apple = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
  if (!apple) {
    apple = document.createElement('link');
    apple.rel = 'apple-touch-icon';
    document.head.appendChild(apple);
  }
  const appleHref = `/icon/180.png?v=${encodeURIComponent(signature)}`;
  if (apple.getAttribute('href') !== appleHref) apple.setAttribute('href', appleHref);
}

export function applyLook(theme: AppTheme, accent: Accent): void {
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(theme);
  root.dataset.accent = accent;

  // Keeps the iOS status bar and the Android address bar from being the one
  // light strip on a dark screen.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', getComputedStyle(root).getPropertyValue('--bg').trim() || '#14161c');
  }

  try {
    localStorage.setItem(THEME_KEY, theme);
    localStorage.setItem(ACCENT_KEY, accent);
  } catch {
    // Private mode, or storage full. The look is already applied; only the
    // no-flash cache for the next load is lost, which is not worth an error.
  }
}

let watching: MediaQueryList | null = null;
/**
 * The exact handler that was registered.
 *
 * Held at module level rather than recreated per call: `removeEventListener`
 * matches on function identity, so passing a freshly-declared closure would
 * silently remove nothing and leave a stale listener flipping the theme back
 * every time Windows changed its mind.
 */
let systemListener: (() => void) | null = null;

/**
 * Follow the OS while — and only while — the setting says `system`.
 *
 * Torn down when the choice changes, so switching to an explicit theme does not
 * leave a listener behind that would later override it.
 */
export function watchSystemTheme(theme: AppTheme, accent: Accent): void {
  if (watching && systemListener) watching.removeEventListener('change', systemListener);
  watching = null;
  systemListener = null;

  if (theme !== 'system') return;

  systemListener = () => applyLook('system', accent);
  watching = window.matchMedia('(prefers-color-scheme: light)');
  watching.addEventListener('change', systemListener);
}
