/**
 * The Code screen: a map of the app's parts, every file in it, and an editor.
 *
 * Opens on the map, because "where is the thing that does X" is the question a
 * file tree cannot answer for somebody who has not read the code: each part's
 * README says what it is in a sentence, and a card opens its folder and that
 * README. The tree and the search are for once you know.
 *
 * **A saved file is not in use yet.** The server reads its source when it
 * starts and the screens are built when the app starts, so the banner counts
 * the files newer than the running server and offers core's Restart. It counts
 * changes made anywhere, not only here, since an editor on the PC changes what
 * the next start runs just the same.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '@app/api';
import type { FeatureViewProps } from '@app/features/index';
import { useAsync } from '@app/useAsync';
import { Editor, type Jump } from './Editor';
import { code, type CodeFile, type OpenedFile, type Part, type Problem } from './code-api';
import { diffLines, languageOf } from './highlight';
import './code.css';

const OPEN_FOLDERS = 'code.open-folders';
const LAST_FILE = 'code.last-file';

function readSet(key: string): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeSet(key: string, value: Set<string>) {
  try {
    localStorage.setItem(key, JSON.stringify([...value]));
  } catch {
    // a private window: folders reopen closed, which is all that is lost
  }
}

/** `a/b/c.ts` → `a`, `a/b`. */
const foldersAbove = (path: string): string[] => {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
};

const sizeLabel = (bytes: number) =>
  bytes < 1024 ? `${bytes} bytes` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

interface Folder {
  folders: Map<string, Folder>;
  files: CodeFile[];
}

function treeOf(files: CodeFile[]): Folder {
  const root: Folder = { folders: new Map(), files: [] };
  for (const file of files) {
    let at = root;
    const parts = file.path.split('/');
    for (const name of parts.slice(0, -1)) {
      let next = at.folders.get(name);
      if (!next) {
        next = { folders: new Map(), files: [] };
        at.folders.set(name, next);
      }
      at = next;
    }
    at.files.push(file);
  }
  return root;
}

/** A file's own changes since the last commit, or one below it. */
function changedUnder(folder: Folder): number {
  let count = folder.files.filter((f) => f.changed).length;
  for (const child of folder.folders.values()) count += changedUnder(child);
  return count;
}

type Notice =
  | { kind: 'saved' }
  | { kind: 'conflict'; version: string }
  | { kind: 'problem'; problem: Problem }
  | { kind: 'error'; message: string };

interface Open {
  file: OpenedFile;
  draft: string;
}

export default function Code({ local, focus, onFocused }: FeatureViewProps) {
  const listing = useAsync(() => code.list(), [], []);
  const restart = useAsync(() => api.restart.status(), [], []);
  const [open, setOpen] = useState<Open | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState('');
  const [folders, setFolders] = useState(() => readSet(OPEN_FOLDERS));
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [jump, setJump] = useState<Jump | null>(null);
  const [view, setView] = useState<'edit' | 'changes'>('edit');
  const [committed, setCommitted] = useState<{ path: string; text: string | null } | null>(null);
  const [restarting, setRestarting] = useState(false);
  /** On a phone, the tree instead of the map. Two columns show both. */
  const [browsing, setBrowsing] = useState(false);

  const data = listing.data;
  const canSave = data?.canSave ?? false;
  const dirty = open !== null && open.file.text !== null && open.draft !== open.file.text;
  const readOnly = !canSave || open?.file.readOnly != null;

  const tree = useMemo(() => treeOf(data?.files ?? []), [data]);
  const byPath = useMemo(() => new Map((data?.files ?? []).map((f) => [f.path, f])), [data]);
  const notRunning = useMemo(
    () => (data ? data.files.filter((f) => f.modified > data.startedAt + 1000) : []),
    [data]
  );

  const matches = useMemo(() => {
    const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length || !data) return null;
    return data.files.filter((f) => words.every((w) => f.path.toLowerCase().includes(w))).slice(0, 200);
  }, [search, data]);

  // Leaving with unsaved changes asks first, as closing the tab does.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const toggleFolder = (path: string, to?: boolean) => {
    setFolders((before) => {
      const next = new Set(before);
      if (to ?? !next.has(path)) next.add(path);
      else next.delete(path);
      writeSet(OPEN_FOLDERS, next);
      return next;
    });
  };

  const reveal = (path: string) => {
    setFolders((before) => {
      const next = new Set(before);
      for (const folder of foldersAbove(path)) next.add(folder);
      writeSet(OPEN_FOLDERS, next);
      return next;
    });
  };

  const openFile = async (path: string, at?: { line: number; column: number }) => {
    if (dirty && open && open.file.path !== path && !confirm(`Leave ${open.file.path} without saving your changes?`)) return;
    setOpening(path);
    setOpenError('');
    setNotice(null);
    setView('edit');
    try {
      const file = await code.open(path);
      setOpen({ file, draft: file.text ?? '' });
      reveal(path);
      try {
        localStorage.setItem(LAST_FILE, path);
      } catch {
        // not remembered; nothing else is lost
      }
      if (at) setJump({ ...at, at: Date.now() });
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error));
    } finally {
      setOpening(null);
    }
  };

  const close = () => {
    if (dirty && open && !confirm(`Close ${open.file.path} without saving your changes?`)) return;
    setOpen(null);
    setNotice(null);
  };

  // Something elsewhere asked for a file: `focus` is its path, optionally `path:line`.
  useEffect(() => {
    if (!focus || !data) return;
    const [, path, line] = /^(.*?)(?::(\d+))?$/.exec(focus) ?? [];
    if (path && byPath.has(path)) void openFile(path, line ? { line: Number(line), column: 1 } : undefined);
    onFocused?.();
  }, [focus, data]);

  const save = async (force = false, version = open?.file.version) => {
    if (!open || readOnly || version === undefined) return;
    setBusy(true);
    setNotice(null);
    try {
      const draft = open.draft;
      const result = await code.save(open.file.path, draft, version, force);
      if (result.saved) {
        setOpen((now) => (now ? { ...now, file: { ...now.file, text: draft, version: result.version } } : now));
        setNotice({ kind: 'saved' });
        listing.reload();
      } else if ('conflict' in result) {
        setNotice({ kind: 'conflict', version: result.version });
      } else {
        setNotice({ kind: 'problem', problem: result.problem });
      }
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const loadCommitted = async (path: string) => {
    if (committed?.path === path) return committed.text;
    const { text } = await code.committed(path);
    setCommitted({ path, text });
    return text;
  };

  const showChanges = async () => {
    if (!open) return;
    try {
      await loadCommitted(open.file.path);
      setView('changes');
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  const putBack = async () => {
    if (!open) return;
    try {
      const text = await loadCommitted(open.file.path);
      if (text === null) {
        setNotice({ kind: 'error', message: 'There is no earlier copy of this file to put back: it is new since the last commit.' });
        return;
      }
      if (text === open.draft) return;
      if (!confirm('Replace what is in the editor with this file as it was at the last commit? Nothing is saved until you press Save.')) return;
      setOpen({ ...open, draft: text });
      setView('edit');
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  const restartNow = async () => {
    if (dirty && !confirm('Restart without saving your changes to this file?')) return;
    setRestarting(true);
    try {
      await api.restart.now();
    } catch (error) {
      setRestarting(false);
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  if (listing.loading) return <p className="meta">Reading the app’s files…</p>;
  if (listing.error || !data) return <p className="banner">{listing.error?.message ?? 'Could not read the files.'}</p>;
  if (data.source === null) {
    return (
      <p className="meta">
        This install has no list of its own files, so there is nothing to show: it is not a git checkout and has no
        release-files.txt.
      </p>
    );
  }

  const file = open?.file;
  const language = file ? languageOf(file.path) : null;
  const status = file ? byPath.get(file.path)?.changed ?? null : null;
  const diff = view === 'changes' && open && committed && committed.path === open.file.path ? diffLines(committed.text ?? '', open.draft) : null;

  return (
    <div className="code-screen">
      {notRunning.length > 0 && (
        <div className="code-banner card">
          <span>
            {notRunning.length === 1 ? '1 file has' : `${notRunning.length} files have`} changed since the app started,
            so it is still running the old {notRunning.length === 1 ? 'version' : 'versions'}.
          </span>
          {restart.data?.available ? (
            <button type="button" className="btn primary" onClick={() => void restartNow()} disabled={restarting}>
              {restarting ? 'Restarting…' : notRunning.length === 1 ? 'Restart to use it' : 'Restart to use them'}
            </button>
          ) : (
            <span className="meta">{local ? 'Restart it from the tray icon.' : 'Restart it from the PC.'}</span>
          )}
        </div>
      )}

      <div className={`code-columns${open || opening || !browsing ? ' has-open' : ''}`}>
      <aside className="code-side">
        <input
          type="search"
          className="code-search"
          placeholder="Find a file"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Find a file"
        />
        <button
          type="button"
          className={`code-row code-map-link${!open && !opening ? ' current' : ''}`}
          onClick={() => {
            close();
            setBrowsing(false);
          }}
        >
          🗺 Parts of the app
        </button>
        {matches ? (
          <ul className="code-tree">
            {matches.length === 0 && <li className="meta">No file has that in its name.</li>}
            {matches.map((f) => (
              <li key={f.path}>
                <FileRow file={f} label={f.path} current={file?.path === f.path} onOpen={() => void openFile(f.path)} depth={0} />
              </li>
            ))}
          </ul>
        ) : (
          <FolderRows folder={tree} path="" depth={0} folders={folders} onToggle={toggleFolder} current={file?.path ?? null} onOpen={(p) => void openFile(p)} />
        )}
        <p className="meta code-side-foot">
          {data.files.length} files{data.source === 'release' ? ', as this release shipped them' : ''}.
          {data.source === 'git' && ' ● changed since the last commit, + new.'}
        </p>
      </aside>

      <section className="code-main">
        {!open && !opening && <PartsMap parts={data.parts} files={data.files} onOpen={(p) => void openFile(p)} onBrowse={() => setBrowsing(true)} canSave={canSave} />}

        {opening && !open && <p className="meta">Opening {opening}…</p>}
        {openError && <p className="banner">{openError}</p>}

        {open && file && (
          <>
            <header className="code-head">
              <button type="button" className="code-back" onClick={close}>
                ‹ Back
              </button>
              <div className="code-title">
                <h2>{file.path.split('/').pop()}</h2>
                <span className="meta code-path">{file.path}</span>
              </div>
              <div className="code-actions">
                {data.source === 'git' && file.text !== null && (
                  <>
                    <button type="button" className="btn" onClick={() => (view === 'changes' ? setView('edit') : void showChanges())}>
                      {view === 'changes' ? 'Back to editing' : 'What changed'}
                    </button>
                    {!readOnly && (status === 'changed' || (dirty && status !== 'new')) && (
                      <button type="button" className="btn" onClick={() => void putBack()}>
                        Put back as committed
                      </button>
                    )}
                  </>
                )}
                {!readOnly && (
                  <button type="button" className="btn primary" onClick={() => void save()} disabled={!dirty || busy}>
                    {busy ? 'Saving…' : dirty ? 'Save' : 'Saved'}
                  </button>
                )}
              </div>
            </header>

            <p className="meta code-facts">
              {sizeLabel(file.size)}
              {status === 'changed' && ' · changed since the last commit'}
              {status === 'new' && ' · new since the last commit'}
              {dirty && ' · not saved yet'}
              {file.readOnly && file.text !== null && ` · read only: ${file.readOnly}`}
              {!canSave && file.text !== null && !file.readOnly && ' · read only here: changing the code is only from the PC running the app'}
              {!readOnly && ' · Ctrl+S saves; Esc then Tab leaves the editor'}
            </p>

            {notice && <NoticeLine notice={notice} onJump={(p) => setJump({ line: p.line, column: p.column, at: Date.now() })} onForce={() => void save(true)} onReload={() => void openFile(file.path)} onOverwrite={(v) => void save(false, v)} />}

            {file.text === null ? (
              <p className="meta">{file.why}</p>
            ) : diff ? (
              <Changes lines={diff} isNew={committed?.text === null} />
            ) : (
              <Editor
                text={open.draft}
                onChange={(draft) => {
                  setOpen((now) => (now ? { ...now, draft } : now));
                  if (notice?.kind === 'saved') setNotice(null);
                }}
                readOnly={readOnly}
                language={language}
                jump={jump}
                onSave={() => void save()}
                label={`Contents of ${file.path}`}
              />
            )}
          </>
        )}
      </section>
      </div>
    </div>
  );
}

function FolderRows({
  folder,
  path,
  depth,
  folders,
  onToggle,
  current,
  onOpen,
}: {
  folder: Folder;
  path: string;
  depth: number;
  folders: Set<string>;
  onToggle: (path: string) => void;
  current: string | null;
  onOpen: (path: string) => void;
}) {
  const names = [...folder.folders.keys()].sort((a, b) => a.localeCompare(b));
  return (
    <ul className="code-tree">
      {names.map((name) => {
        const full = path ? `${path}/${name}` : name;
        const child = folder.folders.get(name)!;
        const isOpen = folders.has(full);
        const changed = changedUnder(child);
        return (
          <li key={full}>
            <button
              type="button"
              className="code-row folder"
              style={{ paddingLeft: `${6 + depth * 14}px` }}
              onClick={() => onToggle(full)}
              aria-expanded={isOpen}
            >
              <span className="code-twist" aria-hidden="true">
                {isOpen ? '▾' : '▸'}
              </span>
              <span className="code-name">{name}</span>
              {changed > 0 && <span className="code-mark" title={`${changed} changed inside`}>●</span>}
            </button>
            {isOpen && <FolderRows folder={child} path={full} depth={depth + 1} folders={folders} onToggle={onToggle} current={current} onOpen={onOpen} />}
          </li>
        );
      })}
      {folder.files.map((f) => (
        <li key={f.path}>
          <FileRow file={f} label={f.path.split('/').pop()!} current={current === f.path} onOpen={() => onOpen(f.path)} depth={depth} />
        </li>
      ))}
    </ul>
  );
}

function FileRow({ file, label, current, onOpen, depth }: { file: CodeFile; label: string; current: boolean; onOpen: () => void; depth: number }) {
  return (
    <button
      type="button"
      className={`code-row file${current ? ' current' : ''}`}
      style={{ paddingLeft: `${6 + depth * 14 + 14}px` }}
      onClick={onOpen}
      title={file.path}
    >
      <span className="code-name">{label}</span>
      {file.changed === 'changed' && <span className="code-mark" title="changed since the last commit">●</span>}
      {file.changed === 'new' && <span className="code-mark" title="new since the last commit">+</span>}
    </button>
  );
}

function PartsMap({
  parts,
  files,
  onOpen,
  onBrowse,
  canSave,
}: {
  parts: Part[];
  files: CodeFile[];
  onOpen: (path: string) => void;
  onBrowse: () => void;
  canSave: boolean;
}) {
  const docs = ['CLAUDE.md', 'ARCHITECTURE.md', 'README.md', 'CHANGELOG.md'].filter((p) => files.some((f) => f.path === p));
  return (
    <div className="code-map">
      <h2>Parts of the app</h2>
      <button type="button" className="btn code-browse" onClick={onBrowse}>
        Every file, as folders
      </button>
      <p className="meta">
        Each part is a folder, and each says what it is in its README. Open one to see its files.
        {canSave ? ' Anything you change here is saved on this PC and used the next time the app starts.' : ' You can read everything here; changing it is only from the PC running the app.'}
      </p>
      <div className="code-parts">
        {parts.map((part) => {
          const inside = files.filter((f) => f.path.startsWith(`${part.folder}/`));
          const changed = inside.filter((f) => f.changed).length;
          return (
            <button
              type="button"
              key={part.folder}
              className="card code-part"
              onClick={() => onOpen(part.readme)}
            >
              <strong>{part.title}</strong>
              <span className="code-part-summary">{part.summary}</span>
              <span className="meta">
                {part.folder} · {inside.length} files{changed > 0 ? ` · ${changed} changed` : ''}
              </span>
            </button>
          );
        })}
      </div>
      {docs.length > 0 && (
        <>
          <h3>The written records</h3>
          <div className="code-docs">
            {docs.map((path) => (
              <button type="button" key={path} className="code-row file" onClick={() => onOpen(path)}>
                <span className="code-name">{path}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function NoticeLine({
  notice,
  onJump,
  onForce,
  onReload,
  onOverwrite,
}: {
  notice: Notice;
  onJump: (problem: Problem) => void;
  onForce: () => void;
  onReload: () => void;
  onOverwrite: (version: string) => void;
}) {
  if (notice.kind === 'saved') return <p className="banner ok code-notice">Saved. It is used the next time the app starts.</p>;
  if (notice.kind === 'error') return <p className="banner code-notice">{notice.message}</p>;
  if (notice.kind === 'conflict') {
    return (
      <div className="banner code-notice">
        <p>This file was changed somewhere else after you opened it, so it was not saved.</p>
        <div className="code-notice-actions">
          <button type="button" className="btn" onClick={() => confirm('Load the version on disk? Your changes here are lost.') && onReload()}>
            Load that version
          </button>
          <button type="button" className="btn" onClick={() => confirm('Save yours over the other change? It is lost.') && onOverwrite(notice.version)}>
            Save mine over it
          </button>
        </div>
      </div>
    );
  }
  const { problem } = notice;
  return (
    <div className="banner code-notice">
      <p>
        Not saved: line {problem.line}, column {problem.column} would stop this file working. {problem.message}
      </p>
      <div className="code-notice-actions">
        <button type="button" className="btn" onClick={() => onJump(problem)}>
          Go to line {problem.line}
        </button>
        <button type="button" className="btn" onClick={() => confirm('Save it anyway? If this file is part of the server or the screens, the app may not start until it is fixed.') && onForce()}>
          Save anyway
        </button>
      </div>
    </div>
  );
}

function Changes({ lines, isNew }: { lines: ReturnType<typeof diffLines>; isNew: boolean }) {
  if (isNew) return <p className="meta">This file is new since the last commit, so all of it is a change.</p>;
  if (lines.length === 0) return <p className="meta">Nothing in this file has changed since the last commit.</p>;
  return (
    <div className="code-editor code-diff" role="table" aria-label="Changes since the last commit">
      {lines.map(([kind, text, number], index) => (
        <div key={index} className={`code-diff-line ${kind}`} role="row">
          <span className="code-diff-number" role="cell">
            {number ?? ''}
          </span>
          <span className="code-diff-sign" role="cell" aria-label={kind === 'same' ? undefined : kind}>
            {kind === 'added' ? '+' : kind === 'removed' ? '−' : ' '}
          </span>
          <code className="code-diff-text" role="cell">
            {text || ' '}
          </code>
        </div>
      ))}
    </div>
  );
}
