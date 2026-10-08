/**
 * The launcher: every part of the app as a tile, first thing on the phone.
 *
 * On a phone the drawer is off-screen, so the app opened straight into the
 * Dashboard and everything else was two taps and a slide away. A home screen of
 * tiles is how a phone already works, and it is one tap to anywhere.
 *
 * The tiles are the drawer's own list — the same items in the same order, with
 * whatever is switched off already gone and any package's tab included — so the
 * two can never disagree about what the app has. Settings comes last, as it sits
 * at the foot of the drawer.
 *
 * Only the *first* screen on a phone. The PC still opens to the Dashboard, and
 * Home is in the drawer on both, so it is always one tap back.
 */
import { Logo, type LogoShape } from './Logo';

export type HomeItem = { id: string; label: string; glyph: string; live?: boolean };

function greeting(now: Date): string {
  const h = now.getHours();
  return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function Home({
  items,
  onOpen,
  logo,
}: {
  items: HomeItem[];
  onOpen: (id: string) => void;
  logo: { shape: LogoShape; version: number };
}) {
  const now = new Date();
  return (
    <div className="home-screen">
      <div className="home-head">
        <Logo shape={logo.shape} size={34} version={logo.version} />
        <div>
          <div className="home-title">Blue Everything</div>
          <div className="meta">
            {greeting(now)} · {now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
          </div>
        </div>
      </div>
      <nav className="home-grid" aria-label="Parts of the app">
        {items.map((item) => (
          <button key={item.id} className="home-tile" onClick={() => onOpen(item.id)}>
            <span className="home-glyph" aria-hidden="true">
              {item.glyph}
            </span>
            <span className="home-label">{item.label}</span>
            {item.live && <span className="live-dot home-live" title="On now" aria-label="on now" />}
          </button>
        ))}
      </nav>
    </div>
  );
}
