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
  type MenuEntry,
} from '../../menu-prefs';
import {
  folderFor,
  foldersChanged,
  foldersFrom,
  makeFolder,
  putInFolder,
  removeFolder,
  resetFolders,
  setShownFolded,
  setStartsOpen,
  shownFolded,
  startsOpen,
  useFolderPrefs,
} from '../../menu-folders';
import { webFeatures } from '../../features';
import { Glyph } from '../../Glyph';
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
 * The menu's switches, on sections only, are in the folders card: a screen is
 * always in the menu, because one reachable only by a tile you might hide is a
 * screen lost.
 *
 * Per device: the phone's first screen and the PC's menu are separate choices.
 */
export function MenuAndHome() {
  const t = useUiText();
  // By the names given in edit mode, which is what the menu and Home show.
  const all = useMenuEntries()
    .filter((e) => e.id !== 'home')
    .map((e) => ({ ...e, label: t(`screen:${e.id}`, e.label) }));
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

      <MenuFolders all={all} />
    </section>
  );
}

/**
 * The menu's folders and sections, in one card (2026-11-20): which folder
 * each screen is in, how each folder starts, which sections are listed under
 * their screen, and what shows under a folder's heading while it is folded
 * (`menu-folders.ts`). It was two cards, "Folders in the menu" and "Sections
 * in the menu", which described one list from two sides.
 *
 * Laid out as the menu is: each folder with what is in it, then what is in
 * none. The menu itself does the moving by dragging in ✎ Edit screens; this is
 * the way for a keyboard, or for anybody who would rather pick from a list. A
 * folder is renamed in edit mode, by its heading.
 */
function MenuFolders({ all }: { all: MenuEntry[] }) {
  const t = useUiText();
  const prefs = useFolderPrefs();
  const [name, setName] = useState('');
  const declaredOf = (id: string) => webFeatures.find((w) => w.id === id)?.group;
  const folders = foldersFrom(webFeatures.map((w) => w.group), prefs);
  // Settings and Feedback are pinned to the foot of the menu and are in no folder.
  const screens = all.filter((e) => !e.parent && !PINNED.includes(e.id));
  const sectionsOf = (id: string) => all.filter((e) => e.parent === id);
  const folderOf = (id: string) => folderFor(id, declaredOf(id), folders, prefs)?.id ?? '';

  const screenRows = (list: MenuEntry[], inFolder: boolean) =>
    list.map((s) => (
      <div key={s.id} className="menu-fold-screen">
        <div className="menu-fold-row">
          <span className="menu-prefs-name">
            <span aria-hidden="true">
              <Glyph glyph={s.glyph} />
            </span>{' '}
            {s.label}
          </span>
          <select value={folderOf(s.id)} onChange={(e) => putInFolder(s.id, e.target.value)} aria-label={`Folder for ${s.label}`}>
            <option value="">Not in a folder</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {t(`group:${f.id}`, f.label)}
              </option>
            ))}
          </select>
          {inFolder && (
            <label className="menu-fold-check" title="Listed under the folder's heading even while the folder is folded">
              <input type="checkbox" checked={shownFolded(s.id, prefs)} onChange={(e) => setShownFolded(s.id, e.target.checked)} />
              Show when folded
            </label>
          )}
        </div>
        {sectionsOf(s.id).map((sec) => (
          <div key={sec.id} className="menu-fold-row sub">
            <span className="menu-prefs-name">
              <span aria-hidden="true">{sec.glyph}</span> {sec.label}
              {isReady(sec.id) === false && <span className="meta"> · not set up yet</span>}
            </span>
            <label className="menu-fold-check" title="Listed under its screen in the menu">
              <input type="checkbox" checked={inMenu(sec)} onChange={(e) => setShown('menu', sec.id, e.target.checked)} />
              In the menu
            </label>
            {inFolder && (
              <label className="menu-fold-check" title="Listed under the folder's heading even while the folder is folded">
                <input
                  type="checkbox"
                  disabled={!inMenu(sec)}
                  checked={inMenu(sec) && shownFolded(sec.id, prefs)}
                  onChange={(e) => setShownFolded(sec.id, e.target.checked)}
                />
                Show when folded
              </label>
            )}
          </div>
        ))}
      </div>
    ));

  const loose = screens.filter((s) => folderOf(s.id) === '');
  return (
    <div className="card">
      <div className="title">Folders and sections in the menu</div>
      <div className="meta" style={{ marginTop: 2 }}>
        A folder gathers screens under one heading that folds, like World. Choose whether each starts open or folded when the app
        opens, and tick <em>Show when folded</em> on anything that should stay under the heading either way. Sections are parts of a
        screen listed under it. Rename a folder in ✎ Edit screens, by clicking its name, where screens can also be dragged in and
        out. On this device only.
      </div>

      {folders.map((f) => {
        const inside = screens.filter((s) => folderOf(s.id) === f.id);
        const open = startsOpen(f.id, prefs);
        return (
          <section key={f.id} className="menu-fold">
            <div className="menu-fold-head">
              <span className="menu-prefs-name">
                <span aria-hidden="true">
                  <Glyph glyph={f.glyph} />
                </span>{' '}
                <strong>{t(`group:${f.id}`, f.label)}</strong>
                <span className="meta"> · {inside.length === 0 ? 'empty' : `${inside.length} in it`}</span>
              </span>
              <div className="menu-fold-start" role="group" aria-label={`How ${t(`group:${f.id}`, f.label)} starts`}>
                <button className={`btn subtle${open ? ' on' : ''}`} aria-pressed={open} onClick={() => setStartsOpen(f.id, true)}>
                  Starts open
                </button>
                <button className={`btn subtle${!open ? ' on' : ''}`} aria-pressed={!open} onClick={() => setStartsOpen(f.id, false)}>
                  Starts folded
                </button>
              </div>
              <button className="btn subtle" onClick={() => removeFolder(f.id)} title="What is in it moves to the top of the menu">
                Remove
              </button>
            </div>
            {inside.length ? screenRows(inside, true) : <p className="meta menu-fold-empty">Nothing in it yet. Pick it from a screen's list below.</p>}
          </section>
        );
      })}

      {loose.length > 0 && (
        <section className="menu-fold">
          <div className="menu-fold-head">
            <span className="menu-prefs-name">
              <strong>Not in a folder</strong>
            </span>
          </div>
          {screenRows(loose, false)}
        </section>
      )}

      <form
        className="row"
        style={{ marginTop: '.75rem', gap: '.4rem' }}
        onSubmit={(e) => {
          e.preventDefault();
          makeFolder(name);
          setName('');
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New folder's name" aria-label="New folder's name" />
        <button className="btn" type="submit">
          ＋ New folder
        </button>
      </form>
      {foldersChanged() && (
        <button className="btn subtle" style={{ marginTop: '.75rem' }} onClick={resetFolders}>
          Folders back to the defaults
        </button>
      )}
    </div>
  );
}

/** Pinned to the foot of the menu, in no folder: see `CORE_NAV` in App. */
const PINNED = ['settings', 'feedback'];

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
