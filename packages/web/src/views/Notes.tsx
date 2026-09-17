/**
 * Notes: a linked notebook.
 *
 * ### Three columns on a desktop, one at a time on a phone
 *
 * A sidebar of folders and tags, the list of notes, and the one you are
 * reading. On a narrow screen they become a stack with only the relevant part
 * showing, because three columns at 375px is three unusable columns — the same
 * call the Dashboard's side column makes at its own breakpoint.
 *
 * ### Editing and reading are one box, not two panes
 *
 * Obsidian has a split view and it is the thing people turn off first: two
 * copies of the same note competing for the width, with the cursor in one and
 * your eyes in the other. Here the note is *rendered* until you click into it,
 * and the raw Markdown is what you type in. One column, and the switch is
 * clicking the thing you want to change.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Note, type NoteDetail, type NoteFolder } from '../api';
import { useAsync } from '../useAsync';
import { relative } from '../format';
import { useButtonMenu, useContextMenu, type MenuItem } from '../ContextMenu';
import { Markdown } from '../notes/Markdown';
import { NoteGraphView } from '../notes/Graph';
import { NoteTransfer } from '../notes/Transfer';
import {
  canMoveFolder,
  canMoveNote,
  folderMoveTarget,
  noteKey,
  parseBlocks,
} from '@everything/shared/notes';

/**
 * The three tabs, split by what you came to do rather than by subject.
 *
 * *Notes* is the screen — writing, reading and finding. *Graph* is the same
 * notebook seen at once, which is a different question and wants the whole
 * width. *Import & export* is set-up: opened when you arrive from another app
 * and then not again for months, so it has no business taking a third of a
 * column you look at daily.
 */
const NOTE_TABS = [
  { id: 'notes', label: 'Notes' },
  { id: 'graph', label: 'Graph' },
  { id: 'transfer', label: 'Import & export' },
] as const;

type NoteTabId = (typeof NOTE_TABS)[number]['id'];

/** What is being dragged: one note, or a whole folder and everything under it. */
type DragPayload =
  | { kind: 'note'; id: string; folder: string; label: string }
  | { kind: 'folder'; path: string; label: string };

/**
 * May this land here?
 *
 * Asked on every `dragover`, so a target that would refuse never lights up and
 * never takes the drop — which is the difference between a drag that visibly
 * cannot go somewhere and one that appears to work and quietly does nothing.
 * The folder rules live in `shared`, where the server reads the same ones.
 */
function canDropOn(item: DragPayload | null, destination: string): boolean {
  if (!item) return false;
  return item.kind === 'note'
    ? canMoveNote(item.folder, destination)
    : canMoveFolder(item.path, destination);
}

export function Notes({ session }: { session?: { local: boolean } }) {
  const [folder, setFolder] = useState<string | undefined>(undefined);
  const [tag, setTag] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [showing, setShowing] = useState<NoteTabId>('notes');

  /*
   * Debounced, because the list is re-fetched per keystroke otherwise. 180ms is
   * under the point a pause reads as lag and over the length of a fast typist's
   * gap between letters.
   */
  const [query, setQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 180);
    return () => clearTimeout(timer);
  }, [search]);

  const list = useAsync(() => api.notes.list({ folder, tag, q: query }), [folder, tag, query], ['notes']);
  const tree = useAsync(() => api.notes.tree(), [], ['notes']);
  const tags = useAsync(() => api.notes.tags(), [], ['notes']);

  const notes = list.data ?? [];

  /*
   * Which titles exist, so a `[[link]]` to a note nobody has written yet can
   * look different from one that goes somewhere. Built from the *unfiltered*
   * tree of titles rather than the visible list, or every link would read as
   * broken while a filter was on.
   */
  const all = useAsync(() => api.notes.list({}), [], ['notes']);
  const known = useMemo(() => new Set((all.data ?? []).map((note) => noteKey(note.title))), [all.data]);

  const openNote = useCallback((id: string) => {
    setOpenId(id);
    setShowing('notes');
  }, []);

  /** Follow a wiki-link: open the note, or offer to write it. */
  const followLink = useCallback(
    async (target: string) => {
      const key = noteKey(target);
      const found = (all.data ?? []).find((note) => noteKey(note.title) === key);
      if (found) return openNote(found.id);

      const created = await api.notes.create({ title: target, body: '', folder: folder ?? '' });
      all.reload();
      list.reload();
      openNote(created.id);
    },
    [all, folder, list, openNote]
  );

  /*
   * What is currently under the cursor, held in state rather than only in the
   * drag event.
   *
   * `dataTransfer` is deliberately unreadable during `dragover` — a page may
   * only see what is being dragged when it is dropped, which stops a page
   * snooping on a file you are dragging past it. But "may this land here" has
   * to be answered *during* `dragover`, because calling `preventDefault` there
   * is the only thing that makes a target droppable at all. So the payload is
   * kept beside the drag, and `dataTransfer` carries a label for anything
   * outside this app that the drag may end up over.
   */
  const [dragging, setDragging] = useState<DragPayload | null>(null);
  const [moveProblem, setMoveProblem] = useState('');

  /**
   * The same payload again, in a ref, and both are load-bearing.
   *
   * State drives the highlight, because only a render can paint one. But the
   * *decision* cannot come from state: `setDragging` in `dragstart` does not
   * reach the handlers until React re-renders, and `dragover` can arrive in the
   * same frame — which read `null`, refused to `preventDefault`, and made the
   * first pass over a folder silently not a drop target.
   *
   * `useEdgeDrawer` documents this exact trap for the same reason, in the same
   * words: the rendered value is stale and the gesture is quietly dropped. A
   * ref is what is true right now; state is what is on screen.
   */
  const draggingRef = useRef<DragPayload | null>(null);
  const setDrag = useCallback((item: DragPayload | null) => {
    draggingRef.current = item;
    setDragging(item);
  }, []);

  /** Carry out whatever was dropped on `destination`. */
  const dropOnto = useCallback(
    async (destination: string) => {
      const item = draggingRef.current;
      setDrag(null);
      if (!item) return;

      try {
        setMoveProblem('');
        if (item.kind === 'note') {
          await api.notes.update(item.id, { folder: destination });
        } else {
          // A folder is a path prefix, so moving it is renaming that prefix —
          // every note underneath follows without being touched one by one.
          await api.notes.renameFolder(item.path, folderMoveTarget(item.path, destination));
        }
        list.reload();
        all.reload();
        tree.reload();
        tags.reload();
      } catch (error) {
        // Named rather than swallowed: a drop that does nothing is
        // indistinguishable from one the browser never registered.
        setMoveProblem((error as Error).message);
      }
    },
    [setDrag, list, all, tree, tags]
  );

  /** Everything the tree reads, after something has been added or moved. */
  const reloadAll = useCallback(() => {
    list.reload();
    all.reload();
    tree.reload();
    tags.reload();
  }, [list, all, tree, tags]);

  async function newNote() {
    const created = await api.notes.create({ body: '', folder: folder ?? '' });
    list.reload();
    all.reload();
    openNote(created.id);
  }

  async function newFolder() {
    // Inside whichever folder is open, which is what a file manager does — and
    // the root when the answer is "all notes", since that is the only place a
    // folder can go when you are not standing in one.
    const parent = folder ?? '';
    const name = window.prompt(parent ? `New folder inside ${parent}` : 'New folder');
    if (name === null) return;
    if (!name.trim()) return;

    try {
      setMoveProblem('');
      const { folder: created } = await api.notes.createFolder(parent ? `${parent}/${name}` : name);
      reloadAll();
      // Opened, so it is obvious it was made — an empty folder appearing
      // somewhere in a long tree is easy to miss entirely.
      setFolder(created);
      setTag(undefined);
    } catch (error) {
      setMoveProblem((error as Error).message);
    }
  }

  async function removeFolder(path: string) {
    try {
      setMoveProblem('');
      await api.notes.removeFolder(path);
      // Standing in the folder that just went would leave the list filtered by
      // something no longer in the tree, which renders as an empty screen with
      // no way back to it.
      if (folder === path || (folder ?? '').startsWith(`${path}/`)) setFolder(undefined);
      reloadAll();
    } catch (error) {
      // The 409 for a folder that still holds notes arrives here, and says how
      // many — which is the whole reason the route refuses rather than cascades.
      setMoveProblem((error as Error).message);
    }
  }

  /**
   * What the New button offers.
   *
   * A table rather than two buttons, because this is the list that grows: a
   * template, a note from the clipboard, a daily note are all the same shape,
   * and each is one entry here rather than another control competing for the
   * same corner. The menu itself is the one the right-click menu already uses.
   */
  const newMenu = useButtonMenu(() => [
    { label: 'Note', onSelect: () => void newNote() },
    { label: 'Folder', onSelect: () => void newFolder() },
  ]);

  return (
    <section className="notes">
      {/*
        The same tab markup Settings and Voice use, rather than three buttons
        that merely look like tabs: `role="tablist"` and `aria-selected` are what
        make them announced as a set with one chosen, and arrow keys work.

        There is deliberately no heading here. `App` already draws an `h1` with
        this screen's name, so a second one read out as "Notes, Notes" and put
        the same word on screen twice. Voice's own `h2` exists only on the
        stale-server branch, where it renders instead of the shell.
      */}
      <div className="tabs" role="tablist" aria-label="Notes sections">
        {NOTE_TABS.map((entry) => (
          <button
            key={entry.id}
            role="tab"
            className={`tab${showing === entry.id ? ' on' : ''}`}
            aria-selected={showing === entry.id}
            onClick={() => setShowing(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {showing === 'graph' && <NoteGraphView onOpen={openNote} />}
      {showing === 'transfer' && (
        <NoteTransfer
          local={session?.local ?? true}
          folder={folder}
          onImported={() => {
            list.reload();
            all.reload();
            tree.reload();
            tags.reload();
          }}
        />
      )}

      {/*
          `has-open` is what turns a narrow screen into a detail view.

          Stacked, an open note sits below the sidebar and the whole list, so on
          a phone tapping one scrolled you to the bottom of the page to find it.
          The alternative was expanding it inline under the row you tapped, and
          that is right for a preview and wrong for a document: the thing being
          opened is a full-screen editor, and putting one inside a list leaves
          it wearing the list's width with the rest of the list still above and
          below it.

          So below the breakpoint the list and sidebar are hidden outright and
          the note takes the screen, with a Back button — which is what every
          notes app on a phone does, because a note is a place you go rather
          than a row that grows. Nothing is unmounted: it is CSS, so going back
          is instant and the list keeps its scroll position.
      */}
      {newMenu.menu}

      {showing === 'notes' && (
        <div className={`notes-layout${openId ? ' has-open' : ''}`}>
          <aside className="notes-side">
            <input
              value={search}
              placeholder="Search every note"
              aria-label="Search notes"
              onChange={(event) => setSearch(event.target.value)}
            />

            <FolderList
              folders={tree.data?.folders ?? []}
              selected={folder}
              onPick={(next) => {
                setFolder(next);
                setTag(undefined);
              }}
              dragging={dragging}
              dragRef={draggingRef}
              onDragItem={setDrag}
              onDrop={(destination) => void dropOnto(destination)}
              onRemove={(path) => void removeFolder(path)}
            />

            {moveProblem && (
              <div className="banner" style={{ marginTop: 6 }}>
                Could not move that — {moveProblem}
              </div>
            )}

            {/*
              Said once, where the folders are, rather than left to be
              discovered: a drag target that is never tried is a feature nobody
              has. It names the folder case too, since dragging a *folder* into
              another is the part people do not think to attempt.
            */}
            <div className="meta notes-drag-hint">
              Drag a note onto a folder to file it, or a folder into another to move it — and onto
              <em> Not in a folder</em> to take it back out.
            </div>

            {(tags.data?.tags.length ?? 0) > 0 && (
              <>
                <div className="meta notes-side-head">Tags</div>
                <div className="row wrap" style={{ gap: '.25rem' }}>
                  {tags.data?.tags.map((entry) => (
                    <button
                      key={entry.tag}
                      className={tag === entry.tag ? 'btn primary' : 'btn subtle'}
                      onClick={() => {
                        setTag(tag === entry.tag ? undefined : entry.tag);
                        setFolder(undefined);
                      }}
                    >
                      #{entry.tag} {entry.count}
                    </button>
                  ))}
                </div>
              </>
            )}
          </aside>

          <div className="notes-list">
            <div className="row between" style={{ alignItems: 'center', marginBottom: 6 }}>
              <div className="meta">
                {notes.length} {notes.length === 1 ? 'note' : 'notes'}
                {folder !== undefined && folder !== '' ? ` in ${folder}` : ''}
                {tag ? ` tagged #${tag}` : ''}
              </div>
              <button className="btn primary" onClick={newMenu.open} aria-haspopup="menu">
                New ▾
              </button>
            </div>

            {list.loading && <div className="empty">loading…</div>}
            {!list.loading && notes.length === 0 && (
              <div className="empty">
                {query
                  ? `Nothing matches “${query}”.`
                  : tag || folder
                    ? 'Nothing here yet.'
                    : 'No notes yet — press New, or bring some in from another app.'}
              </div>
            )}

            {notes.map((note) => (
              <NoteRow
                key={note.id}
                note={note}
                open={note.id === openId}
                onOpen={() => openNote(note.id)}
                onDragItem={setDrag}
              />
            ))}
          </div>

          <div className="notes-editor">
            {openId ? (
              <NoteEditor
                key={openId}
                id={openId}
                known={(target) => known.has(noteKey(target))}
                onFollow={followLink}
                onOpenTag={(picked) => {
                  setTag(picked);
                  setFolder(undefined);
                }}
                onChanged={() => {
                  list.reload();
                  all.reload();
                  tree.reload();
                  tags.reload();
                }}
                onClosed={() => setOpenId(null)}
              />
            ) : (
              <div className="empty">Pick a note, or press New.</div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */

function NoteRow({
  note,
  open,
  onOpen,
  onDragItem,
}: {
  note: Note;
  open: boolean;
  onOpen: () => void;
  onDragItem: (item: DragPayload | null) => void;
}) {
  return (
    <button
      className={`card notes-row${open ? ' on' : ''}`}
      onClick={onOpen}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        // Firefox refuses to begin a drag with nothing set, and the title is
        // what any other app dropped on would sensibly receive.
        event.dataTransfer.setData('text/plain', note.title);
        onDragItem({ kind: 'note', id: note.id, folder: note.folder, label: note.title });
      }}
      onDragEnd={() => onDragItem(null)}
    >
      <div className="title truncate">{note.title}</div>
      {note.preview && <div className="meta notes-peek">{note.preview}</div>}
      <div className="meta">
        {note.folder ? `${note.folder} · ` : ''}
        {relative(note.updatedAt)}
      </div>
    </button>
  );
}

/**
 * The folder tree, with "All" and "Root" as real entries.
 *
 * "All" is not the same question as the root folder — one is every note and the
 * other is the notes filed nowhere — and a tree with only one of them makes the
 * other unreachable.
 */
function FolderList({
  folders,
  selected,
  onPick,
  dragging,
  dragRef,
  onDragItem,
  onDrop,
  onRemove,
}: {
  folders: NoteFolder[];
  selected: string | undefined;
  onPick: (folder: string | undefined) => void;
  /** For the highlight, which only a render can paint. */
  dragging: DragPayload | null;
  /** For the decision, which cannot wait for one. */
  dragRef: React.RefObject<DragPayload | null>;
  onDragItem: (item: DragPayload | null) => void;
  onDrop: (destination: string) => void;
  onRemove: (path: string) => void;
}) {
  /** Which target the cursor is over, so exactly one can light up. */
  const [over, setOver] = useState<string | null>(null);

  /**
   * The handlers a droppable row needs, in one place.
   *
   * `preventDefault` in `dragover` is the whole mechanism: without it the
   * browser's default is to refuse the drop, so a target that does not call it
   * is simply not a target. Calling it only when the move is legal is what
   * makes an illegal one show the "no entry" cursor by itself, with no styling
   * required to say so.
   */
  const dropTarget = (destination: string) => ({
    // Painted from state — this is what is on screen.
    className: `notes-folder${selected === destination ? ' on' : ''}${
      over === destination && canDropOn(dragging, destination) ? ' drop-here' : ''
    }`,
    // Decided from the ref — this is what is true right now. Reading the render's
    // copy here loses the first `dragover` of every drag.
    onDragOver: (event: React.DragEvent) => {
      if (!canDropOn(dragRef.current, destination)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setOver(destination);
    },
    onDragLeave: () => setOver((current) => (current === destination ? null : current)),
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      setOver(null);
      if (canDropOn(dragRef.current, destination)) onDrop(destination);
    },
  });

  /** The handlers a folder needs to be picked up. */
  const dragSource = (path: string, label: string) => ({
    draggable: true,
    onDragStart: (event: React.DragEvent) => {
      event.dataTransfer.effectAllowed = 'move';
      // Firefox will not start a drag at all without some data set, and a plain
      // label is the honest thing to hand anywhere outside this screen.
      event.dataTransfer.setData('text/plain', label);
      onDragItem({ kind: 'folder', path, label });
    },
    onDragEnd: () => {
      onDragItem(null);
      setOver(null);
    },
  });

  return (
    <div className="notes-tree">
      {/*
        "All notes" is a filter rather than a place, so it is deliberately not a
        drop target — there is no folder called everything, and accepting a drop
        here would have to silently pick one.
      */}
      <button className={selected === undefined ? 'notes-folder on' : 'notes-folder'} onClick={() => onPick(undefined)}>
        All notes
      </button>

      {/* The root, and therefore how things come *out* of a folder. */}
      <button {...dropTarget('')} onClick={() => onPick('')}>
        Not in a folder
      </button>

      {folders.map((entry) => (
        <FolderRow
          key={entry.path}
          entry={entry}
          target={dropTarget(entry.path)}
          source={dragSource(entry.path, entry.path)}
          onPick={onPick}
          onRemove={onRemove}
        />
      ))}
    </div>
  );
}

/**
 * One folder in the tree.
 *
 * Its own component so it can hold a hook — a right-click menu belongs to a
 * row, and `useContextMenu` cannot be called inside a `map`.
 */
function FolderRow({
  entry,
  target,
  source,
  onPick,
  onRemove,
}: {
  entry: NoteFolder;
  target: Record<string, unknown>;
  source: Record<string, unknown>;
  onPick: (folder: string) => void;
  onRemove: (path: string) => void;
}) {
  const menu = useContextMenu(() => [
    {
      /*
       * Named with its count when it cannot go, rather than simply greyed.
       * "Remove" disabled for no stated reason is a dead end; "3 notes inside"
       * says what to do about it.
       */
      label: entry.count > 0 ? `Remove — ${entry.count} inside` : 'Remove folder',
      onSelect: () => onRemove(entry.path),
      disabled: entry.count > 0,
      danger: true,
    } satisfies MenuItem,
  ]);

  return (
    <>
      <button
        {...target}
        {...source}
        style={{ paddingLeft: 10 + entry.path.split('/').length * 12 }}
        onClick={() => onPick(entry.path)}
        onContextMenu={menu.onContextMenu}
        title={`${entry.path} — drag a note here, or drag this into another folder`}
      >
        {entry.name} <span className="meta">{entry.count}</span>
      </button>
      {menu.menu}
    </>
  );
}

/* ------------------------------------------------------------------ */

/**
 * One note: rendered until you click into it, raw Markdown while you type.
 *
 * **Saving is debounced and on a timer, not a button.** A notes app with a Save
 * button is one that loses a paragraph every time somebody closes a tab, and
 * this one is edited from a phone over Tailscale where "I pressed back" is the
 * normal way to leave. The body is also flushed on unmount, so switching notes
 * mid-sentence keeps the sentence.
 */
function NoteEditor({
  id,
  known,
  onFollow,
  onOpenTag,
  onChanged,
  onClosed,
}: {
  id: string;
  known: (target: string) => boolean;
  onFollow: (target: string) => void;
  onOpenTag: (tag: string) => void;
  onChanged: () => void;
  onClosed: () => void;
}) {
  const note = useAsync(() => api.notes.get(id), [id], []);
  const [draft, setDraft] = useState<{ title: string; body: string; folder: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [problem, setProblem] = useState('');
  const area = useRef<HTMLTextAreaElement | null>(null);
  /** The last thing written, so an unchanged draft is never written again. */
  const saved = useRef<string>('');

  const loaded = note.data;
  useEffect(() => {
    if (loaded && draft === null) {
      const initial = { title: loaded.storedTitle ?? '', body: loaded.body, folder: loaded.folder };
      /*
       * What is on screen is what is stored, so the first autosave has nothing
       * to do. Without this the debounce fired 700ms after *opening* a note and
       * wrote it back unchanged — which bumps `updatedAt` and, in a list sorted
       * by it, shuffles the note to the top for the crime of being read. A
       * notebook that rearranges itself as you browse it is worse than one that
       * saves a little late.
       */
      saved.current = JSON.stringify(initial);
      setDraft(initial);
      // A brand-new note opens ready to type in, since there is nothing to read.
      if (!loaded.body.trim() && !loaded.storedTitle) setEditing(true);
    }
  }, [loaded, draft]);

  /*
   * The latest draft in a ref as well as in state, so the unmount cleanup below
   * can see it. A cleanup closes over the values from the render that scheduled
   * it, which for a draft is whatever you had typed several keystrokes ago.
   */
  const latest = useRef(draft);
  latest.current = draft;

  const save = useCallback(
    async (next: { title: string; body: string; folder: string }) => {
      const signature = JSON.stringify(next);
      if (signature === saved.current) return;
      saved.current = signature;
      try {
        await api.notes.update(id, { title: next.title || null, body: next.body, folder: next.folder });
        setProblem('');
        onChanged();
      } catch (error) {
        // Named on the row rather than thrown away: a save that failed silently
        // is the worst thing a notes app can do.
        setProblem((error as Error).message);
      }
    },
    [id, onChanged]
  );

  useEffect(() => {
    if (!draft) return;
    const timer = setTimeout(() => void save(draft), 700);
    return () => clearTimeout(timer);
  }, [draft, save]);

  // Flush on the way out, so closing or switching notes mid-sentence keeps it.
  useEffect(() => {
    return () => {
      if (latest.current) void save(latest.current);
    };
  }, [save]);

  if (note.loading) return <div className="empty">loading…</div>;
  if (note.error || !loaded || !draft) return <div className="banner">Could not open that note.</div>;

  const blocks = parseBlocks(draft.body);
  /*
   * The same condition `Links` returns null on, asked one level up so the
   * layout knows whether to reserve a rail. Two places deciding this is a thing
   * to keep in step, so `hasNoteLinks` is the single statement of it.
   */
  const hasLinks = hasNoteLinks(loaded);

  /** Drop or paste a picture straight into the body. */
  async function attach(file: File) {
    const data = await file.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(data)));
    const uploaded = await api.notes.uploadFile({ name: file.name, data: base64, noteId: id });
    setDraft((current) => (current ? { ...current, body: `${current.body}\n\n${uploaded.markdown}\n` } : current));
    setEditing(true);
  }

  return (
    <div className="card notes-note">
      {/*
        One row that wraps, rather than two rows of one field each.

        The stacked version paired Edit with the title and Delete with the
        folder, which reads as though each button acted on the box beside it —
        and Delete sitting against a text field is the worst available place for
        it. They belong together at the end, after the two things that describe
        the note. It wraps on a narrow column, which is where the stack came
        from in the first place.
      */}
      <div className="row wrap notes-head" style={{ gap: '.4rem' }}>
        {/*
          The way out of the detail view, and the only control that is purely a
          phone affordance — hidden by CSS wherever the list is still on screen,
          because there it would close a note for no reason you could see.
        */}
        <button className="btn subtle notes-back" onClick={onClosed} aria-label="Back to the list">
          ‹
        </button>
        <div className="grow notes-title-field">
          <input
            className="notes-title-input"
            value={draft.title}
            placeholder={loaded.title}
            aria-label="Note title"
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          />
        </div>
        <div className="notes-folder-field">
          <input
            value={draft.folder}
            placeholder="Folder — blank for none"
            aria-label="Folder"
            onChange={(event) => setDraft({ ...draft, folder: event.target.value })}
          />
        </div>
        {/*
          The two buttons wrap as one block. Left to themselves the row broke
          between them and dropped Delete onto a line of its own, directly under
          the folder box — a destructive button alone against a text field,
          which is the arrangement this row was reshaped to avoid.
        */}
        <div className="row notes-head-actions" style={{ gap: '.4rem' }}>
          <button className="btn subtle" onClick={() => setEditing(!editing)}>
            {editing ? 'Read' : 'Edit'}
          </button>
          <button
            className="btn subtle danger"
            onClick={async () => {
              // Nothing to confirm on an empty note — it is not a deletion, it is
              // tidying up after opening one by accident.
              if (draft.body.trim() && !confirm(`Delete “${loaded.title}”?`)) return;
              // Cleared first, or the unmount flush recreates what was deleted.
              latest.current = null;
              await api.notes.remove(id);
              onChanged();
              onClosed();
            }}
          >
            Delete
          </button>
        </div>
      </div>

      {problem && <div className="banner" style={{ marginTop: 8 }}>Not saved — {problem}</div>}

      {/*
        The note and what links to it, side by side once there is room.

        A wide window gave the note a column far wider than its prose wants to
        be, so reading one left several hundred pixels blank down the right. The
        backlinks were underneath, off the bottom of a long note — the half of
        the notebook you are least likely to scroll to and the half most worth
        seeing. Putting them in that space uses the width for something rather
        than letterboxing it.

        `has-rail` rather than letting an empty track collapse: a grid gap is
        drawn between tracks whether or not the second holds anything, so a note
        with no links would carry a stray column of padding.
      */}
      <div className={`notes-work${hasLinks ? ' has-rail' : ''}`}>
        <div className="notes-main">
      {editing ? (
        <textarea
          ref={area}
          className="notes-body"
          value={draft.body}
          aria-label="Note"
          placeholder="Markdown. [[Link]] to another note, #tag it, drop a picture in."
          onChange={(event) => setDraft({ ...draft, body: event.target.value })}
          onPaste={(event) => {
            const file = [...event.clipboardData.files][0];
            if (file) {
              event.preventDefault();
              void attach(file);
            }
          }}
          onDrop={(event) => {
            const file = [...event.dataTransfer.files][0];
            if (file) {
              event.preventDefault();
              void attach(file);
            }
          }}
        />
      ) : (
        <div
          className="notes-read"
          onDoubleClick={() => setEditing(true)}
          title="Double-click to edit"
        >
          {draft.body.trim() ? (
            <Markdown blocks={blocks} handlers={{ onOpenNote: onFollow, onOpenTag, known }} />
          ) : (
            <div className="empty">Empty. Press Edit.</div>
          )}
        </div>
      )}
        </div>

        <Links note={loaded} onFollow={onFollow} />
      </div>
    </div>
  );
}

/**
 * What points here, and where this points.
 *
 * Both directions, because the backlinks are the half that makes a notebook a
 * notebook — the outgoing list you can already see by reading the note.
 */
/** Whether this note has anything to say in the links panel. */
function hasNoteLinks(note: NoteDetail): boolean {
  return note.backlinks.length > 0 || note.outgoing.some((link) => !link.id);
}

function Links({ note, onFollow }: { note: NoteDetail; onFollow: (target: string) => void }) {
  const dangling = note.outgoing.filter((link) => !link.id);

  if (!hasNoteLinks(note)) return null;

  return (
    <div className="notes-links">
      {note.backlinks.length > 0 && (
        <>
          <div className="meta notes-side-head">
            {note.backlinks.length} {note.backlinks.length === 1 ? 'note links' : 'notes link'} here
          </div>
          {note.backlinks.map((link) => (
            <button key={link.id} className="notes-backlink" onClick={() => onFollow(link.title)}>
              <div className="title truncate">{link.title}</div>
              {link.context && <div className="meta notes-peek">{link.context}</div>}
            </button>
          ))}
        </>
      )}

      {dangling.length > 0 && (
        <>
          <div className="meta notes-side-head">Not written yet</div>
          <div className="row wrap" style={{ gap: '.25rem' }}>
            {dangling.map((link) => (
              <button key={link.target} className="btn subtle" onClick={() => onFollow(link.display || link.target)}>
                {link.display || link.target}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
