/**
 * The list of blueprints down the side, in folders (2026-11-03).
 *
 * A folder is a name and nothing more: it arranges the list, and nothing about
 * a run looks at it. Folders come first, as a file manager orders them, then
 * whatever is in none. Each folds, and which are folded is per device like the
 * menu's groups; a folder starts open, so one you just made shows what you
 * drop into it.
 *
 * **Moving a blueprint** is a drag on its grip, onto a folder (its heading or
 * anything in it) or anywhere else in the list to take it out, the way the
 * menu's screens move; or the Folder box above the board, for a keyboard or a
 * phone. The grip is pointer events, so a finger works as a mouse does, and the
 * row shows where it went before the save comes back.
 *
 * **Removing a folder keeps what is in it**, moved to the top, since deleting
 * an arrangement should not delete the things arranged.
 */
import { useEffect, useRef, useState } from 'react';
import { blueprints, type Blueprint, type BlueprintStatus, type Folder } from './blueprints-api';

const FOLDED = 'blueprints.folded';

function readFolded(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(FOLDED) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveFolded(folded: Set<string>) {
  try {
    localStorage.setItem(FOLDED, JSON.stringify([...folded]));
  } catch {
    // a private window: every folder opens again next time, which is all that is lost
  }
}

export const STATE_WORD: Record<BlueprintStatus['state'], string> = {
  on: 'on',
  idle: 'idle',
  disabled: 'disabled',
  off: 'off',
  stopped: 'stopped',
};

export function BlueprintList({
  list,
  folders,
  open,
  statusOf,
  onOpen,
  reload,
  onProblem,
  makingFolder,
  onMadeFolder,
}: {
  list: Blueprint[];
  folders: Folder[];
  open: string | null;
  statusOf: (b: Blueprint) => BlueprintStatus;
  onOpen: (id: string) => void;
  reload: () => void;
  onProblem: (message: string) => void;
  /** The New folder button was pressed: a name box shows at the top. */
  makingFolder: boolean;
  onMadeFolder: () => void;
}) {
  const [folded, setFolded] = useState(readFolded);
  const [dragging, setDragging] = useState<string | null>(null);
  /** What a dragged blueprint is over: a folder's id, '' for the top, null for outside the list. */
  const [dropOn, setDropOn] = useState<string | null>(null);
  /** Moves sent and not yet back, so a row does not jump back for the round trip. */
  const [moved, setMoved] = useState<Record<string, string | null>>({});
  const [renaming, setRenaming] = useState<string | null>(null);

  // A move is shown from the draft until the list says the same.
  useEffect(() => {
    setMoved((m) => {
      const left = Object.fromEntries(Object.entries(m).filter(([id, f]) => list.find((b) => b.id === id)?.folder !== f && list.some((b) => b.id === id)));
      return Object.keys(left).length === Object.keys(m).length ? m : left;
    });
  }, [list]);

  const folderOf = (b: Blueprint): string | null => {
    const f = b.id in moved ? moved[b.id]! : (b.folder ?? null);
    return f && folders.some((x) => x.id === f) ? f : null;
  };

  const toggle = (id: string) => {
    const next = new Set(folded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setFolded(next);
    saveFolded(next);
  };

  async function move(id: string, to: string | null) {
    setMoved((m) => ({ ...m, [id]: to }));
    if (to && folded.has(to)) toggle(to);
    try {
      await blueprints.update(id, { folder: to });
      reload();
    } catch (error) {
      setMoved((m) => {
        const { [id]: _, ...rest } = m;
        return rest;
      });
      onProblem((error as Error).message);
    }
  }

  async function act(what: () => Promise<unknown>) {
    try {
      await what();
      reload();
    } catch (error) {
      onProblem((error as Error).message);
    }
  }

  const folderAt = (x: number, y: number): string | null => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const folder = el?.closest<HTMLElement>('[data-bp-folder]');
    if (folder) return folder.dataset.bpFolder ?? '';
    return el?.closest('.bp-list-wrap') ? '' : null;
  };

  const row = (b: Blueprint) => {
    const status = statusOf(b);
    const here = folderOf(b);
    return (
      <li key={b.id} className={`bp-list-row${dragging === b.id ? ' dragging' : ''}`}>
        <span
          className="bp-grip"
          aria-hidden="true"
          title="Drag into a folder, or out to the top of the list"
          onPointerDown={(ev) => {
            ev.preventDefault();
            ev.currentTarget.setPointerCapture(ev.pointerId);
            setDragging(b.id);
            setDropOn(null);
          }}
          onPointerMove={(ev) => {
            if (dragging === b.id) setDropOn(folderAt(ev.clientX, ev.clientY));
          }}
          onPointerUp={(ev) => {
            if (dragging === b.id) {
              const to = folderAt(ev.clientX, ev.clientY);
              if (to !== null && to !== (here ?? '')) void move(b.id, to || null);
            }
            setDragging(null);
            setDropOn(null);
          }}
          onPointerCancel={() => {
            setDragging(null);
            setDropOn(null);
          }}
        >
          ⠿
        </span>
        <button
          type="button"
          className={`bp-list-item${b.id === open ? ' current' : ''}`}
          onClick={() => onOpen(b.id)}
          title={status.why ? `${STATE_WORD[status.state]}: ${status.why}` : undefined}
        >
          <span className={`bp-dot ${status.state}`} aria-hidden="true" />
          <span className="bp-list-name">{b.name}</span>
          <span className="meta">{STATE_WORD[status.state]}</span>
        </button>
      </li>
    );
  };

  const sorted = [...folders].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const loose = list.filter((b) => folderOf(b) === null);
  const dropping = dragging !== null;

  return (
    <div className={`bp-list-wrap${dropping && dropOn === '' ? ' drop-target' : ''}`}>
      {makingFolder && (
        <NameBox
          initial=""
          label="New folder's name"
          onDone={(name) => {
            onMadeFolder();
            if (name !== null) void act(() => blueprints.folders.create(name));
          }}
        />
      )}
      <ul className="bp-list">
        {sorted.map((f) => {
          const inside = list.filter((b) => folderOf(b) === f.id);
          const shut = folded.has(f.id);
          // A folded folder still shows the blueprint that is open, so where you are is never folded away.
          const shown = shut ? inside.filter((b) => b.id === open) : inside;
          return (
            <li key={f.id} className={`bp-folder${dropping && dropOn === f.id ? ' drop-target' : ''}`} data-bp-folder={f.id}>
              <div className="bp-folder-head">
                <button type="button" className="bp-twist" onClick={() => toggle(f.id)} aria-expanded={!shut} aria-label={`${shut ? 'Open' : 'Fold'} ${f.name}`}>
                  {shut ? '▸' : '▾'}
                </button>
                {renaming === f.id ? (
                  <NameBox
                    initial={f.name}
                    label="Folder name"
                    onDone={(name) => {
                      setRenaming(null);
                      if (name !== null && name !== f.name) void act(() => blueprints.folders.rename(f.id, name));
                    }}
                  />
                ) : (
                  <button type="button" className="bp-folder-name" onClick={() => toggle(f.id)} onDoubleClick={() => setRenaming(f.id)}>
                    <span aria-hidden="true">📁</span> {f.name}
                    <span className="meta"> {inside.length}</span>
                  </button>
                )}
                <button type="button" className="bp-folder-act" onClick={() => setRenaming(f.id)} aria-label={`Rename ${f.name}`} title="Rename">
                  ✎
                </button>
                <button
                  type="button"
                  className="bp-folder-act"
                  onClick={() => void act(() => blueprints.folders.remove(f.id))}
                  aria-label={`Remove the folder ${f.name}, keeping what is in it`}
                  title={inside.length ? `Remove the folder; the ${inside.length} in it move to the top` : 'Remove the folder'}
                >
                  ✕
                </button>
              </div>
              {shown.length > 0 && <ul className="bp-list bp-folder-list">{shown.map(row)}</ul>}
              {!shut && inside.length === 0 && <p className="meta bp-folder-empty">Empty: drag a blueprint here by its ⠿.</p>}
            </li>
          );
        })}
        {loose.map(row)}
      </ul>
    </div>
  );
}

/** A name typed in place. Enter or leaving keeps it; Escape keeps nothing. */
function NameBox({ initial, label, onDone }: { initial: string; label: string; onDone: (name: string | null) => void }) {
  const [text, setText] = useState(initial);
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      className="bp-folder-input"
      value={text}
      autoFocus
      maxLength={60}
      placeholder="Folder name"
      aria-label={label}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(text.trim() || null);
        else if (e.key === 'Escape') finish(null);
      }}
      onBlur={() => finish(text.trim() || null)}
    />
  );
}
