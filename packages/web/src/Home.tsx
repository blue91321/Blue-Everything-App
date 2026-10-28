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
import { tapWordmark, useWordmark } from './wordmark';
import { useEditMode } from './edit-mode';
import { useReorder } from './reorder';
import { setHomeList } from './menu-prefs';
import { Editable, useUiText } from './ui-text';

export type HomeItem = { id: string; label: string; glyph: string; live?: boolean };

function greeting(now: Date): string {
  const h = now.getHours();
  return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function Home({
  items,
  everything,
  onOpen,
  logo,
}: {
  items: HomeItem[];
  /** Every screen and section there is, for edit mode to offer what is not on Home. */
  everything: HomeItem[];
  onOpen: (id: string) => void;
  logo: { shape: LogoShape; version: number };
}) {
  const now = new Date();
  const wordmark = useWordmark();
  const editing = useEditMode();
  const t = useUiText();
  /*
   * Arranging Home here is the same list Settings → Home screen arranges, so
   * the first move makes it your own list, as it does there (`homeList`).
   * Per device, like the rest of Home's choices.
   */
  const ids = items.map((i) => i.id);
  const { order, dragging, item, grip } = useReorder(ids, setHomeList);
  const byId = new Map(items.map((i) => [i.id, i]));
  const missing = everything.filter((e) => !ids.includes(e.id));
  return (
    <div className="home-screen">
      <div className="home-head">
        <Logo shape={logo.shape} size={34} version={logo.version} />
        <div>
          <div className="home-title wordmark" onClick={tapWordmark}>
            {wordmark}
          </div>
          <div className="meta">
            {greeting(now)} · {now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
          </div>
        </div>
      </div>
      {items.length === 0 && (
        <p className="empty">
          Nothing is on Home. Choose what goes here in{' '}
          <button className="btn subtle" onClick={() => onOpen('settings')}>
            Settings
          </button>
          , or open the menu with ☰.
        </p>
      )}
      <nav className="home-grid" aria-label="Parts of the app">
        {order.map((id) => {
          const tile = byId.get(id);
          if (!tile) return null;
          return (
            <div key={id} ref={item(id)} className={`home-cell${dragging === id ? ' dragging' : ''}`}>
              <button className="home-tile" onClick={() => onOpen(id)}>
                <span className="home-glyph" aria-hidden="true">
                  {tile.glyph}
                </span>
                <span className="home-label">
                  <Editable id={`screen:${id}`} fallback={tile.label} inButton />
                </span>
                {tile.live && <span className="live-dot home-live" title="On now" aria-label="on now" />}
              </button>
              {editing && (
                <>
                  <span className="edit-grip home-grip" aria-hidden="true" title="Drag to move" {...grip(id)}>
                    ⠿
                  </span>
                  <button
                    className="edit-remove"
                    aria-label={`Take ${t(`screen:${id}`, tile.label)} off Home`}
                    title="Take off Home"
                    onClick={() => setHomeList(ids.filter((other) => other !== id))}
                  >
                    ✕
                  </button>
                </>
              )}
            </div>
          );
        })}
      </nav>
      {editing && missing.length > 0 && (
        <div className="edit-offer">
          <div className="meta">Not on Home:</div>
          {missing.map((e) => (
            <button key={e.id} className="btn subtle" onClick={() => setHomeList([...ids, e.id])}>
              + {e.glyph} {t(`screen:${e.id}`, e.label)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
