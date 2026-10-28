/**
 * The menu drawer and the Home screen's tiles (Settings → General).
 */
import { useState } from 'react';
import {
  homeArranged,
  homeTiles,
  inMenu,
  isReady,
  resetHome,
  setHomeList,
  setShown,
  useMenuEntries,
} from '../../menu-prefs';
import { api } from '../../api';
import { useAsync } from '../../useAsync';
import { OrderedPicker } from './OrderedPicker';
import { useUiText } from '../../ui-text';

/**
 * Theme and accent.
 *
 * Both are applied optimistically the moment they are clicked, before the save
 * comes back. A colour picker that waits for a round trip to show you the
 * colour is the one interaction where latency is genuinely unacceptable — you
 * are choosing by looking. The server is still the source of truth, and the
 * reload triggered by the save puts it right if the write failed.
 */
/**
 * The menu: when it docks itself, and whether it starts docked.
 *
 * Both are about the same 260px of screen, so they are one card rather than two
 * scattered through Appearance.
 */
export function MenuDrawer() {
  const settings = useAsync(() => api.settings.get(), [], ['settings']);
  const [busy, setBusy] = useState(false);

  const breakpoint = settings.data?.drawerBreakpoint ?? 1200;
  // `!== 0`, never `=== true`: the row returns 0 or 1.
  const docked = (settings.data?.drawerDocked ?? 1) !== 0;
  // At the top of the range the menu never docks, so "start docked" has nothing
  // left to describe — it would be a switch with no effect and no explanation.
  const neverDocks = breakpoint >= 2400;

  async function save(next: { drawerBreakpoint?: number; drawerDocked?: boolean }) {
    setBusy(true);
    try {
      await api.settings.update(next);
      settings.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="menu-drawer">
      <h2>The menu</h2>

      <div className="card">
        <div className="title">When it sits beside the app</div>
        <div className="meta" style={{ marginTop: 4 }}>
          Below this width it becomes a button instead, and slides over the page when you press it. You
          can hide it with that button at any width — this only decides where it starts.
        </div>

        <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          {DRAWER_WIDTHS.map(({ px, label, hint }) => (
            <button
              key={px}
              className={breakpoint === px ? 'btn primary' : 'btn'}
              disabled={busy}
              title={hint}
              onClick={() => void save({ drawerBreakpoint: px })}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="meta" style={{ marginTop: 8 }}>
          {DRAWER_WIDTHS.find((w) => w.px === breakpoint)?.hint ?? `From ${breakpoint}px up`}
          {breakpoint < 2400 ? ` · ${breakpoint}px` : ''}
        </div>
      </div>

      <div className="card">
        <label className="row" style={{ gap: '.5rem', alignItems: 'flex-start' }}>
          <input
            type="checkbox"
            checked={docked && !neverDocks}
            disabled={busy || neverDocks}
            onChange={(event) => void save({ drawerDocked: event.target.checked })}
          />
          <span>
            <span className="title">Start with the menu showing</span>
            <span className="meta" style={{ display: 'block', marginTop: 2 }}>
              {neverDocks
                ? // Said rather than left as a mysteriously dead checkbox.
                  'Nothing to decide while the menu never sits beside the app.'
                : 'Off opens straight into the app with the menu put away. Hiding it by hand is a separate, temporary thing — it comes back next time you open the app.'}
            </span>
          </span>
        </label>
      </div>
    </section>
  );
}

/**
 * What Home and the menu show — see `menu-prefs.ts`.
 *
 * Home is an ordered list, the Dashboard's own picker: ↑ ↓ and a drag to
 * order it, remove to take a tile off, and everything else offered underneath
 * to add. Until it is arranged it shows the defaults; once arranged it shows
 * exactly the list, so hiding everything but a few is removing the rest.
 *
 * The menu keeps its switches, on sections only: a screen is always in the
 * menu, because one reachable only by a tile you might hide is a screen lost.
 *
 * Per device: the phone's first screen and the PC's menu are separate choices.
 */
export function MenuAndHome() {
  const t = useUiText();
  // By the names given in edit mode, which is what the menu and Home show.
  const all = useMenuEntries()
    .filter((e) => e.id !== 'home')
    .map((e) => ({ ...e, label: t(`screen:${e.id}`, e.label) }));
  const sections = all.filter((e) => e.parent);
  const arranged = homeArranged();
  const tiles = homeTiles(all);
  const choices = all.map((e) => ({
    id: e.id,
    label: `${e.glyph} ${e.parent ? `${all.find((p) => p.id === e.parent)?.label ?? ''} › ` : ''}${e.label}`,
    hint: isReady(e.id) === false ? 'not set up yet' : undefined,
  }));
  return (
    <section id="menu-home">
      <h2>Home screen and menu</h2>
      <div className="card">
        <div className="title">Home screen</div>
        <div className="meta" style={{ marginTop: 2 }}>
          {arranged
            ? 'Exactly these tiles, in this order, and nothing else. Something added in a later version is offered below rather than appearing by itself.'
            : 'Showing the defaults. Reorder, remove or add anything and Home becomes exactly your list.'}{' '}
          On this device only.
        </div>
        <OrderedPicker
          chosen={tiles.map((e) => e.id)}
          choices={choices}
          saving={false}
          onChange={setHomeList}
          missingNote="not in this build"
        />
        <div className="row" style={{ marginTop: '.75rem', gap: '.4rem', flexWrap: 'wrap' }}>
          {/* For "nothing but these": start from an empty Home and add the few. */}
          <button className="btn" disabled={tiles.length === 0} onClick={() => setHomeList([])}>
            Remove everything
          </button>
          {arranged && (
            <button className="btn subtle" onClick={resetHome}>
              Back to the defaults
            </button>
          )}
        </div>
      </div>

      {sections.length > 0 && (
        <div className="card">
          <div className="title">Sections in the menu</div>
          <div className="meta" style={{ marginTop: 2 }}>
            Listed under their screen in the menu. A screen itself is always there. On this device only.
          </div>
          <div className="menu-prefs">
            {sections.map((e) => (
              <label key={e.id} className="menu-prefs-row sub">
                <span className="menu-prefs-name">
                  <span aria-hidden="true">{e.glyph}</span> {all.find((p) => p.id === e.parent)?.label} › {e.label}
                  {isReady(e.id) === false && <span className="meta"> · not set up yet</span>}
                </span>
                <input
                  type="checkbox"
                  aria-label={`${e.label} in the menu`}
                  checked={inMenu(e)}
                  onChange={(ev) => setShown('menu', e.id, ev.target.checked)}
                />
              </label>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * The widths offered for docking the menu, as named alternatives.
 *
 * Named rather than a slider or a box, for the reason the refresh rate is: a
 * slider suits a number on a continuum, and this is a handful of real answers
 * where every position between them is a worse version of a neighbour. The
 * labels say what each one *means* on a screen, because "1200" is not a
 * decision anybody can make and "a large laptop" is.
 */
const DRAWER_WIDTHS = [
  { px: 900, label: 'Early', hint: 'from a small laptop up — the old behaviour' },
  { px: 1200, label: 'Balanced', hint: 'from a large laptop up' },
  { px: 1500, label: 'Late', hint: 'only on a big monitor' },
  { px: 2400, label: 'Never', hint: 'always a button, at every width' },
];
