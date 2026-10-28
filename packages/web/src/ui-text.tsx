/**
 * Your wording for the app's, renaming it in place, and hiding what you do
 * not need to read.
 *
 * Text reaches edit mode two ways:
 *
 * - **`UiText`, put there by the build** (`ui-text-plugin.mjs`): every piece
 *   of wording written in the source inside an ordinary element, with an id
 *   made from the file and the words (`t:views.dashboard:1a2b3c4d`). That is
 *   nearly all of it, and it can be renamed **or hidden**.
 * - **`Editable`, by hand**, for text that has a meaning beyond where it sits:
 *   a screen's name is in the menu, on Home and in the page title, and one id
 *   ties them together. These are renamed, not hidden; a screen is taken out
 *   of the menu or off Home in their own ways.
 *
 * | id | is |
 * | --- | --- |
 * | `t:<file>:<hash>` | wording found by the build |
 * | `screen:<id>` | a screen's name: in the menu, on Home, as the page title |
 * | `screen:<id>#<section>` | a section's name, in the menu and on Home |
 * | `group:<id>` | a group heading in the menu (World) |
 * | `block:<block id>` | a Dashboard section's heading, also used by Settings |
 * | `<screen>:<thing>` | anything else named by hand, such as `dashboard:queue.empty` |
 *
 * Outside edit mode either is just the text, yours if you changed it. In edit
 * mode it is outlined, and a click opens a small editor beside it. Saved on
 * the server (`/api/ui-text`, `data/ui-text.json`), so the phone and the PC
 * agree and an update keeps it.
 *
 * **Hiding hides the line, not the words.** Hidden text leaves an empty
 * marker where it was, and the stylesheet hides the element holding that
 * marker (`:has(> [data-ui-hidden])`): the grey paragraph a hint sits in, not
 * the hint with the paragraph's other half still showing. In edit mode it is
 * drawn faded instead, so it can be brought back.
 *
 * **Only text the app writes**, never yours: a task's title arrives in a
 * variable, which the build never touches, and is edited on the task.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api';
import { onDataChange } from './live';
import { useEditMode } from './edit-mode';

/* ---------- the store ---------- */

let text: Record<string, string> = {};
let hidden = new Set<string>();
let version = 0;
let started = false;
const listeners = new Set<() => void>();
const announce = () => {
  version++;
  listeners.forEach((l) => l());
};

function load(): void {
  api.uiText
    .get()
    .then((reply) => {
      text = reply.text ?? {};
      hidden = new Set(reply.hidden ?? []);
      announce();
    })
    // An older server has no route, and offline there may be no saved copy:
    // the app's own wording either way, which is what nothing changed means.
    .catch(() => undefined);
}

function subscribe(listener: () => void): () => void {
  if (!started) {
    started = true;
    load();
    // A change on another device reaches this one through the live stream.
    onDataChange(load, ['ui-text']);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const snapshot = () => version;

/** Your wording for `id`, or the app's. Not a hook: pair it with `useUiText` to re-render. */
export function uiText(id: string, fallback: string): string {
  return text[id] ?? fallback;
}

/** `uiText`, re-rendering the caller whenever any wording changes. */
export function useUiText(): (id: string, fallback: string) => string {
  useSyncExternalStore(subscribe, snapshot);
  return uiText;
}

/**
 * Change it: `text: null` for the original, `hidden` to hide or show. Shown at
 * once and saved after, as the accent swatches do; put back if refused.
 */
async function change(id: string, next: { text?: string | null; hidden?: boolean }): Promise<void> {
  const before = { text, hidden };
  if (next.text !== undefined) {
    const copy = { ...text };
    if (next.text === null || next.text.trim() === '') delete copy[id];
    else copy[id] = next.text.trim();
    text = copy;
  }
  if (next.hidden !== undefined) {
    const copy = new Set(hidden);
    if (next.hidden) copy.add(id);
    else copy.delete(id);
    hidden = copy;
  }
  announce();
  try {
    await api.uiText.set(id, next);
  } catch (error) {
    text = before.text;
    hidden = before.hidden;
    announce();
    throw error;
  }
}

/* ---------- the editor ---------- */

type Request = { id: string; fallback: string; anchor: DOMRect; el: HTMLElement; canHide: boolean };
let request: Request | null = null;
const editorListeners = new Set<() => void>();

/** Open the editor beside `anchor` for this piece of text. */
export function openTextEditor(id: string, fallback: string, anchor: HTMLElement, canHide = false): void {
  request = { id, fallback, anchor: anchor.getBoundingClientRect(), el: anchor, canHide };
  editorListeners.forEach((l) => l());
}

function closeTextEditor(): void {
  request = null;
  editorListeners.forEach((l) => l());
}

/**
 * Set while the editor's **Press it** passes a click through, so the text
 * lets it reach the button it sits in rather than opening the editor again.
 */
let passingThrough = false;

/** The control the text sits in, if a click on it does something: a tab, a button, a link. */
function controlAround(el: HTMLElement): HTMLElement | null {
  return el.parentElement?.closest<HTMLElement>('button, a[href], summary, label, [role="button"], [role="tab"], [role="link"]') ?? null;
}

/**
 * Some text, renameable in edit mode, placed by hand.
 *
 * `inButton` for text inside a button (a menu entry, a Home tile): no role or
 * tab stop of its own, since a control inside a control is not one a keyboard
 * can reach, and the click is kept from reaching the button. The keyboard's way
 * to a screen's name is its page title, which is the same id.
 */
export function Editable({ id, fallback, inButton = false }: { id: string; fallback: string; inButton?: boolean }) {
  const t = useUiText();
  const editing = useEditMode();
  const value = t(id, fallback);
  if (!editing) return <>{value}</>;

  const open = (e: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
    if (passingThrough) return;
    e.preventDefault();
    e.stopPropagation();
    openTextEditor(id, fallback, e.currentTarget);
  };
  return (
    <span
      className={`ui-editable${value !== fallback ? ' changed' : ''}`}
      title={value !== fallback ? `Click to rename (originally “${fallback}”)` : 'Click to rename'}
      onClick={open}
      // A drag or a press-and-hold that starts on the text is not one on the tile.
      onPointerDown={(e) => {
        if (!passingThrough) e.stopPropagation();
      }}
      {...(inButton
        ? {}
        : {
            role: 'button',
            tabIndex: 0,
            onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
              if (e.key === 'Enter' || e.key === ' ') open(e);
            },
          })}
    >
      {value}
    </span>
  );
}

/**
 * Wording the build found (`ui-text-plugin.mjs`): `i` is its id and `t` the
 * source's text, short names because every piece of text in the app carries
 * them. Outside edit mode it is the text and no element at all, so the page is
 * exactly what it was; hidden, it is the empty marker that hides its line.
 *
 * In edit mode it is a span you click. A click on text inside a button opens
 * the editor rather than pressing the button, so the editor offers **Press
 * it** for that.
 */
export function UiText({ i: id, t: fallback }: { i: string; t: string }) {
  useSyncExternalStore(subscribe, snapshot);
  const editing = useEditMode();
  const isHidden = hidden.has(id);
  const mine = text[id];
  if (!editing && isHidden) return <span data-ui-hidden="" hidden />;
  // The spaces JSX kept either side of the words stay outside them, so
  // renaming "Last checked" does not eat the space before `{when}`.
  const lead = /^\s*/.exec(fallback)![0];
  const trail = /\s*$/.exec(fallback)![0];
  const words = fallback.slice(lead.length, fallback.length - trail.length);
  const value = mine ?? words;
  if (!editing) return <>{mine === undefined ? fallback : lead + mine + trail}</>;

  const open = (e: MouseEvent<HTMLElement>) => {
    if (passingThrough) return;
    e.preventDefault();
    e.stopPropagation();
    openTextEditor(id, words, e.currentTarget, true);
  };
  return (
    <>
      {lead}
      <span
        className={`ui-editable ui-auto${mine !== undefined ? ' changed' : ''}`}
        {...(isHidden ? { 'data-ui-hidden': '' } : {})}
        title={isHidden ? 'Hidden. Click to show it again or rename it' : 'Click to rename or hide'}
        onClick={open}
        onPointerDown={(e) => {
          if (!passingThrough) e.stopPropagation();
        }}
      >
        {value}
      </span>
      {trail}
    </>
  );
}

/**
 * The one editor, mounted once by `App`, drawn beside whatever asked for it.
 *
 * A small card rather than typing into the text in place: much of what can be
 * renamed sits inside a button, where an input cannot take focus reliably and
 * Space or Enter would press the button instead.
 */
export function TextEditorHost() {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    editorListeners.add(l);
    return () => {
      editorListeners.delete(l);
    };
  }, []);
  const current = request;
  return current ? <TextEditor key={`${current.id}@${current.anchor.top},${current.anchor.left}`} request={current} /> : null;
}

function TextEditor({ request: r }: { request: Request }) {
  useSyncExternalStore(subscribe, snapshot);
  const changed = r.id in text;
  const isHidden = hidden.has(r.id);
  const control = controlAround(r.el);
  const [draft, setDraft] = useState(uiText(r.id, r.fallback));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const card = useRef<HTMLFormElement>(null);
  const [place, setPlace] = useState({ top: r.anchor.bottom + 6, left: r.anchor.left });

  // Measured, then kept on screen: below the text, or above it near the bottom.
  useLayoutEffect(() => {
    const box = card.current?.getBoundingClientRect();
    if (!box) return;
    const margin = 8;
    const left = Math.max(margin, Math.min(r.anchor.left, window.innerWidth - box.width - margin));
    const below = r.anchor.bottom + 6;
    const top = below + box.height > window.innerHeight - margin ? Math.max(margin, r.anchor.top - box.height - 6) : below;
    setPlace({ top, left });
  }, [r]);

  const save = async (next: { text?: string | null; hidden?: boolean }) => {
    setBusy(true);
    setError('');
    try {
      await change(r.id, next);
      closeTextEditor();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not save that');
      setBusy(false);
    }
  };

  const press = () => {
    closeTextEditor();
    passingThrough = true;
    try {
      r.el.click();
    } finally {
      passingThrough = false;
    }
  };

  return createPortal(
    <>
      <div className="ui-editor-backdrop" onClick={closeTextEditor} />
      <form
        ref={card}
        className="ui-editor card"
        style={{ top: place.top, left: place.left }}
        onSubmit={(e) => {
          e.preventDefault();
          // Saving the original wording is putting it back, not storing a copy.
          void save({ text: draft.trim() === r.fallback ? null : draft });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') closeTextEditor();
        }}
      >
        <label className="meta" htmlFor="ui-editor-input">
          {isHidden ? 'Hidden. Rename' : 'Rename'}
        </label>
        <input
          id="ui-editor-input"
          value={draft}
          maxLength={600}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.target.value)}
        />
        {changed && <div className="meta">Originally “{r.fallback}”</div>}
        {error && <div className="banner">{error}</div>}
        <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <button className="btn primary" type="submit" disabled={busy || draft.trim() === ''}>
            Save
          </button>
          {r.canHide && (
            <button
              className="btn subtle"
              type="button"
              disabled={busy}
              title={isHidden ? undefined : 'Hides the line this text is on. Edit mode still shows it, faded, to bring back.'}
              onClick={() => void save({ hidden: !isHidden })}
            >
              {isHidden ? 'Show it again' : 'Hide'}
            </button>
          )}
          {changed && (
            <button className="btn subtle" type="button" disabled={busy} onClick={() => void save({ text: null })}>
              Use the original
            </button>
          )}
          {control && (
            <button className="btn subtle" type="button" onClick={press} title="Do what clicking it does outside edit mode">
              Press it
            </button>
          )}
          <button className="btn subtle" type="button" onClick={closeTextEditor}>
            Cancel
          </button>
        </div>
      </form>
    </>,
    document.body
  );
}
