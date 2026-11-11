/**
 * The Blueprints screen: the list of them, and the board for the open one.
 *
 * **Saved as you go**, the way a note is: every change to the board is sent
 * after a moment's pause, and the draft on screen is kept until the save comes
 * back, so a box does not jump back to where it was for the length of a round
 * trip (the Dashboard pickers' lesson).
 *
 * **A new blueprint is off.** It does things, and should start doing them
 * because you switched it on, not because you opened a template. **Test** runs
 * it without doing anything: the checks are asked for real and the actions only
 * say what they would do, and the board lights up the way it went.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@app/api';
import type { FeatureViewProps } from '@app/features/index';
import { relative } from '@app/format';
import { useAsync } from '@app/useAsync';
import { useNow } from '@app/clock';
import type { ChangeScope } from '@app/live';
import { useButtonMenu } from '@app/ContextMenu';
import { Canvas, type AgentState, type HabitChoice } from './Canvas';
import { blueprints, type Blueprint, type BlueprintStatus, type Folder, type Graph, type Run } from './blueprints-api';
import { BlueprintList } from './List';
import { formatNumber } from './maths';
import { chainsBack } from './loops';
import { specOf } from './catalogue';
import { unreachable } from './engine';
import { blueprintIn, fromCode, MAX_FILE, toCode, withBlueprint, type Shared } from './share-png';
import { drawBlueprint } from './share-draw';
import './blueprints.css';

const OPEN = 'blueprints.open';

// Not one of core's scopes: the server announces its runs under a name only
// this screen listens for, so a run does not refetch every other screen.
// Settings too: voice switched off or on changes whether a blueprint can start.
const WATCH = ['blueprints', 'habits', 'settings'] as unknown as ChangeScope[];

function remembered(): string | null {
  try {
    return localStorage.getItem(OPEN);
  } catch {
    return null;
  }
}

function remember(id: string | null) {
  try {
    if (id) localStorage.setItem(OPEN, id);
    else localStorage.removeItem(OPEN);
  } catch {
    // a private window: the list opens on nothing, which is all that is lost
  }
}

const DOING: Record<string, string> = { 'in-game': 'in a game', free: 'free', focused: 'busy', away: 'away' };

export default function Blueprints({ focus, onFocused }: FeatureViewProps) {
  useNow();
  const state = useAsync(() => blueprints.get(), [], WATCH);
  const habitsList = useAsync(() => api.habits.list(), [], ['habits']);
  const habits: HabitChoice[] = (habitsList.data ?? []).map((h) => ({ id: h.id, name: h.name }));
  const [open, setOpen] = useState<string | null>(remembered);
  const [problem, setProblem] = useState('');
  const [picking, setPicking] = useState(false);
  const [makingFolder, setMakingFolder] = useState(false);

  useEffect(() => {
    if (!focus) return;
    setOpen(focus);
    onFocused?.();
  }, [focus]);

  useEffect(() => remember(open), [open]);

  const data = state.data;
  const list = data?.blueprints ?? [];
  const current = list.find((b) => b.id === open) ?? null;

  /** A shared blueprint read from a picture, waiting to be added. */
  const [incoming, setIncoming] = useState<Shared | null>(null);
  const importInput = useRef<HTMLInputElement>(null);

  async function readShared(file: File | undefined) {
    if (!file) return;
    setProblem('');
    try {
      if (file.size > MAX_FILE) throw new Error('That file is far too big to be a shared blueprint.');
      setIncoming(blueprintIn(new Uint8Array(await file.arrayBuffer())));
    } catch (error) {
      setProblem((error as Error).message);
    }
  }

  /**
   * A shared blueprint from the clipboard: the text code Copy puts there, or
   * failing that a picture, should its blueprint have survived the clipboard
   * (a browser usually re-encodes a copied picture and drops it).
   */
  async function pasteShared() {
    setProblem('');
    try {
      if (!navigator.clipboard) throw new Error('This browser does not let the app read the clipboard here: press Ctrl+V on the list instead.');
      if (navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        let problem: Error | null = null;
        for (const item of items) {
          if (item.types.includes('text/plain')) {
            try {
              setIncoming(await fromCode(await (await item.getType('text/plain')).text()));
              return;
            } catch (error) {
              problem = error as Error;
            }
          }
        }
        for (const item of items) {
          if (!item.types.includes('image/png')) continue;
          try {
            setIncoming(blueprintIn(new Uint8Array(await (await item.getType('image/png')).arrayBuffer())));
            return;
          } catch (error) {
            problem ??= error as Error;
          }
        }
        throw problem ?? new Error('There is no shared blueprint on the clipboard. Copy one with Copy on a blueprint first.');
      }
      setIncoming(await fromCode(await navigator.clipboard.readText()));
    } catch (error) {
      const e = error as Error;
      setProblem(e.name === 'NotAllowedError' ? 'The browser would not let the app read the clipboard: press Ctrl+V on the list instead.' : e.message);
    }
  }

  const importMenu = useButtonMenu(() => [
    { label: 'From a file…', onSelect: () => importInput.current?.click() },
    { label: 'From clipboard', onSelect: () => void pasteShared() },
  ]);

  // Ctrl+V anywhere on the screen but a text box or the board (which pastes boxes) takes a shared blueprint.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('input, textarea, [contenteditable], .bp-board, .mf')) return;
      const text = event.clipboardData?.getData('text/plain') ?? '';
      const picture = [...(event.clipboardData?.files ?? [])].find((f) => f.type === 'image/png');
      if (/BEBP[01]\./.test(text)) {
        event.preventDefault();
        fromCode(text).then(setIncoming, (error: Error) => setProblem(error.message));
      } else if (picture) {
        event.preventDefault();
        void readShared(picture);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  async function addShared(shared: Shared) {
    setProblem('');
    try {
      const made = await blueprints.create('empty');
      await blueprints.update(made.id, { name: shared.name, graph: shared.graph as Graph });
      setIncoming(null);
      setOpen(made.id);
      state.reload();
    } catch (error) {
      setProblem((error as Error).message);
    }
  }

  async function create(template: string) {
    setProblem('');
    try {
      const made = await blueprints.create(template);
      setPicking(false);
      setOpen(made.id);
      state.reload();
    } catch (error) {
      setProblem((error as Error).message);
    }
  }

  if (state.loading) return <p className="meta">Loading…</p>;
  if (state.error && !data) return <p className="error">{String(state.error)}</p>;

  return (
    <div className="bp-screen">
      {data?.error && <p className="error card">{data.error}</p>}
      {problem && <p className="error">{problem}</p>}
      <div className={`bp-columns${current ? ' has-open' : ''}`}>
        <aside
          className="bp-side"
          onDragOver={(e) => {
            if ([...e.dataTransfer.items].some((i) => i.kind === 'file')) e.preventDefault();
          }}
          onDrop={(e) => {
            const file = [...e.dataTransfer.files].find((f) => /\.png$/i.test(f.name) || f.type === 'image/png');
            if (!file) return;
            e.preventDefault();
            void readShared(file);
          }}
        >
          <div className="bp-new-row">
            <button type="button" className="primary bp-new" onClick={() => setPicking((p) => !p)} aria-expanded={picking}>
              ＋ New blueprint
            </button>
            {data?.folders && (
              <button type="button" onClick={() => setMakingFolder(true)} disabled={makingFolder}>
                ＋ Folder
              </button>
            )}
            <button type="button" onClick={importMenu.open} aria-haspopup="menu" title="Add a blueprint someone shared">
              Import ▾
            </button>
            {importMenu.menu}
            <input
              ref={importInput}
              type="file"
              accept="image/png,.png"
              hidden
              onChange={(e) => {
                void readShared(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </div>
          {incoming && <IncomingCard shared={incoming} onAdd={() => void addShared(incoming)} onCancel={() => setIncoming(null)} />}
          {picking && (
            <div className="bp-templates">
              {data?.templates.map((t) => (
                <button key={t.id} type="button" className="card bp-template" onClick={() => create(t.id)}>
                  <strong>{t.name}</strong>
                  <span className="meta">{t.blurb}</span>
                </button>
              ))}
            </div>
          )}
          {list.length === 0 && !picking && (
            <p className="meta">
              A blueprint is boxes joined by wires: <em>when</em> something happens, <em>check</em> a thing or two,{' '}
              <em>do</em> something. Start from one of the examples under New blueprint.
            </p>
          )}
          <BlueprintList
            list={list}
            folders={data?.folders ?? []}
            open={open}
            statusOf={(b) => statusFor(b, data?.statuses)}
            onOpen={setOpen}
            reload={state.reload}
            onProblem={setProblem}
            makingFolder={makingFolder}
            onMadeFolder={() => setMakingFolder(false)}
          />
          {data?.attention && (
            <p className="meta bp-side-foot">
              The PC says you are {data.attention.away ? 'away' : (DOING[data.attention.state] ?? data.attention.state)}.
            </p>
          )}
          {data?.switchesOn && data.switchesOn.length > 0 && (
            <p className="meta bp-side-foot">
              On now: {data.switchesOn.map((s) => `"${s}"`).join(', ')}.
            </p>
          )}
          {data?.variables && Object.keys(data.variables).length > 0 && (
            <div className="bp-variables">
              <h3 className="meta">Variables</h3>
              <ul>
                {Object.entries(data.variables).map(([name, value]) => (
                  <li key={name}>
                    <code>{`{${name}}`}</code>
                    <span className="bp-variable-value" title={String(value)}>
                      {typeof value === 'number' ? formatNumber(value) : `"${value}"`}
                    </span>
                    <button
                      type="button"
                      className="bp-folder-act"
                      onClick={() =>
                        void blueprints
                          .forgetVariable(name)
                          .then(state.reload)
                          .catch((error: Error) => setProblem(error.message))
                      }
                      aria-label={`Forget {${name}}`}
                      title="Forget it: a box adding to it then starts from 0"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
        <main className="bp-main">
          {current ? (
            <Editor
              key={current.id}
              blueprint={current}
              runs={(data?.runs ?? []).filter((r) => r.blueprint === current.id)}
              others={data?.blueprints ?? []}
              waiting={new Set(data?.waiting ?? [])}
              status={statusFor(current, data?.statuses)}
              habits={habits}
              agent={data?.agent ?? null}
              onBack={() => setOpen(null)}
              onGone={() => {
                setOpen(null);
                state.reload();
              }}
              reload={state.reload}
              folders={data?.folders ?? null}
              variables={data?.variables ?? {}}
            />
          ) : (
            list.length > 0 && <p className="meta bp-pick">Pick a blueprint to open it.</p>
          )}
        </main>
      </div>
    </div>
  );
}

function Editor({
  blueprint,
  runs,
  waiting,
  habits,
  agent,
  status,
  onBack,
  onGone,
  reload,
  folders,
  variables,
  others,
}: {
  blueprint: Blueprint;
  runs: Run[];
  /** Every blueprint, for saying which set this one off and are set off by it. */
  others: Blueprint[];
  waiting: Set<string>;
  habits: HabitChoice[];
  agent: AgentState | null;
  status: BlueprintStatus;
  onBack: () => void;
  onGone: () => void;
  reload: () => void;
  /** The list's folders, for moving it from a box rather than a drag. Null from a server without them. */
  folders: Folder[] | null;
  variables: Record<string, number | string>;
}) {
  const [draft, setDraft] = useState<Graph>(blueprint.graph);
  const unknownBoxes = draft.nodes.filter((n) => !specOf(n.type)).length;
  /*
   * Blueprints that set this one off and are set off by it, round in a circle.
   * A run never starts its own blueprint again and stops three deep, so it
   * cannot run away; it is said because it is rarely what was meant.
   */
  const chains = useMemo(
    () =>
      chainsBack({ id: blueprint.id, name: blueprint.name, graph: draft }, others).map(
        (c) => `${c.names.map((n) => `"${n}"`).join(' sets off ')}: they set each other off. It stops three deep, but each round does what they say again.`
      ),
    [blueprint.id, blueprint.name, draft, others]
  );
  const [name, setName] = useState(blueprint.name);
  const [saving, setSaving] = useState<'idle' | 'waiting' | 'saving' | 'saved' | 'failed'>('idle');
  const [problem, setProblem] = useState('');
  const [shown, setShown] = useState<string | null>(null);
  const [testFrom, setTestFrom] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);
  const lastSent = useRef(JSON.stringify(blueprint.graph));
  // The newest copy seen, by when it was saved: a list fetched before this screen's own
  // last save can arrive after it, and must not put back what was typed since.
  const newest = useRef(blueprint.updatedAt);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // The server's copy replaces the draft only when nothing is waiting to be
  // sent, and only when it is not what this screen sent itself.
  useEffect(() => {
    const incoming = JSON.stringify(blueprint.graph);
    if (blueprint.updatedAt < newest.current) return;
    newest.current = blueprint.updatedAt;
    if (dirty.current || incoming === lastSent.current) return;
    lastSent.current = incoming;
    setDraft(blueprint.graph);
  }, [blueprint.graph]);

  useEffect(() => setName(blueprint.name), [blueprint.name]);

  // Anything still waiting goes when the screen does.
  useEffect(() => () => {
    if (timer.current && dirty.current) {
      clearTimeout(timer.current);
      void blueprints.update(blueprint.id, { graph: draftRef.current }).catch(() => undefined);
    }
  }, []);

  function change(next: Graph) {
    setDraft(next);
    dirty.current = true;
    setSaving('waiting');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void send(), 700);
  }

  async function send() {
    timer.current = null;
    const graph = draftRef.current;
    const body = JSON.stringify(graph);
    setSaving('saving');
    try {
      const saved = await blueprints.update(blueprint.id, { graph });
      if (saved?.updatedAt) newest.current = Math.max(newest.current, saved.updatedAt);
      lastSent.current = body;
      // Only clean if nothing else changed while this was on its way.
      if (JSON.stringify(draftRef.current) === body) dirty.current = false;
      setSaving('saved');
    } catch (error) {
      setSaving('failed');
      setProblem((error as Error).message);
    }
  }

  async function act(what: () => Promise<unknown>) {
    setProblem('');
    setBusy(true);
    try {
      await what();
      reload();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const events = draft.nodes.filter((n) => specOf(n.type)?.kind === 'event');
  const button = events.find((n) => n.type === 'on-button');
  const from = events.find((n) => n.id === testFrom) ?? events[0] ?? null;
  const lonely = unreachable(draft);

  async function test() {
    if (timer.current) {
      clearTimeout(timer.current);
      await send();
    }
    await act(async () => {
      const run = await blueprints.run(blueprint.id, from?.id ?? null, true);
      if ('id' in run) setShown(run.id);
    });
  }

  async function runNow() {
    if (timer.current) {
      clearTimeout(timer.current);
      await send();
    }
    if (!confirm(`Run "${blueprint.name}" now? It will really do what its boxes say.`)) return;
    await act(async () => {
      const run = await blueprints.run(blueprint.id, button?.id ?? null, false);
      if ('id' in run) setShown(run.id);
    });
  }

  const sorted = [...runs].sort((a, b) => b.at - a.at);
  const run = sorted.find((r) => r.id === shown) ?? sorted[0] ?? null;
  /*
   * The way it went: a wire is lit when both its ends ran and, where the box
   * it leaves said which way it left, it is that way. A sequence and a repeat
   * leave by several, so all of theirs that led somewhere that ran are lit.
   */
  const ran = useMemo(() => {
    if (!run) return null;
    const results = new Map(run.steps.map((s) => [s.node, s.result]));
    const left = new Map<string, Set<string>>();
    for (const s of run.steps) if (s.pin) (left.get(s.node) ?? left.set(s.node, new Set()).get(s.node)!).add(s.pin);
    const wires = new Set<string>();
    for (const w of draft.wires) {
      if (!results.has(w.from) || !results.has(w.to)) continue;
      const pins = left.get(w.from);
      if (w.port || !pins || pins.has(w.pin)) wires.add(w.id);
    }
    return { results, wires };
  }, [run, draft.wires]);

  const placeholders = useMemo(() => {
    const words = new Set<string>(['time']);
    for (const n of draft.nodes) for (const g of specOf(n.type)?.gives ?? []) words.add(g.key);
    return [...words];
  }, [draft.nodes.map((e) => e.type).join()]);
  const going = runs.some((r) => waiting.has(r.id));

  const saveName = () => {
    const next = name.trim() || 'Untitled';
    if (next !== blueprint.name) void act(() => blueprints.update(blueprint.id, { name: next }));
  };

  /**
   * Save it as a picture of the board with the blueprint inside it. A path to
   * a file on this PC is asked about first, since it says where things are
   * here (and usually whose PC it is).
   */
  /** A path to a file on this PC is asked about first, since it says where things are here. */
  const okToShare = () => {
    const paths = draft.nodes.map((n) => String(n.fields.path ?? '')).filter((p) => /^[a-z]:[\\/]/i.test(p));
    return !paths.length || confirm(`It plays a file from this PC (${paths[0]}), so what you share says where that is. Share it anyway?`);
  };

  const [copied, setCopied] = useState(false);
  const shareMenu = useButtonMenu(() => [
    { label: 'As a file', onSelect: () => void share() },
    { label: 'To clipboard', onSelect: copyShare },
  ]);
  /**
   * Copy it: the picture and a line of text carrying the blueprint, in one go,
   * so a chat that takes pictures gets the picture and a text box gets the
   * text, which is what Paste reads back. The two are handed over as promises,
   * so the copy is started inside the click, which Safari insists on.
   */
  function copyShare() {
    setProblem('');
    if (!okToShare()) return;
    const shared = { name: name || blueprint.name, graph: draft };
    const code = toCode(shared);
    const picture = (async () => {
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4c8dff';
      const png = withBlueprint(await drawBlueprint(shared.name, draft, { accent, habits: new Map(habits.map((h) => [h.id, h.name])) }), shared);
      return new Blob([png as BlobPart], { type: 'image/png' });
    })();
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    };
    const asText = () =>
      code
        .then((text) => navigator.clipboard.writeText(text))
        .then(done, (error: Error) => setProblem(`Could not copy it: ${error.message}`));
    try {
      if (!navigator.clipboard) throw new Error('This browser does not let the app use the clipboard here.');
      if (typeof ClipboardItem === 'undefined' || !navigator.clipboard.write) {
        void asText();
        return;
      }
      const item = new ClipboardItem({ 'image/png': picture, 'text/plain': code.then((t) => new Blob([t], { type: 'text/plain' })) });
      // A browser that will not take a picture still takes the text, which is the part that carries the blueprint.
      navigator.clipboard.write([item]).then(done, () => void asText());
    } catch (error) {
      setProblem((error as Error).message);
    }
  }

  async function share() {
    setProblem('');
    if (!okToShare()) return;
    try {
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4c8dff';
      const picture = await drawBlueprint(name || blueprint.name, draft, { accent, habits: new Map(habits.map((h) => [h.id, h.name])) });
      const bytes = withBlueprint(picture, { name: name || blueprint.name, graph: draft });
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(name || blueprint.name).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'blueprint'}.blueprint.png`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      setProblem((error as Error).message);
    }
  }

  return (
    <div className="bp-editor">
      <button type="button" className="bp-back" onClick={onBack}>
        ‹ All blueprints
      </button>
      <div className="bp-bar">
        <input
          className="bp-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          aria-label="Blueprint name"
        />
        {folders && folders.length > 0 && (
          <select
            value={blueprint.folder && folders.some((f) => f.id === blueprint.folder) ? blueprint.folder : ''}
            onChange={(e) => act(() => blueprints.update(blueprint.id, { folder: e.target.value || null }))}
            aria-label="Folder"
            title="The folder it is in on the list"
          >
            <option value="">No folder</option>
            {[...folders]
              .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
              .map((f) => (
                <option key={f.id} value={f.id}>
                  📁 {f.name}
                </option>
              ))}
          </select>
        )}
        <button
          type="button"
          className={blueprint.enabled && !blueprint.stopped ? 'primary' : ''}
          aria-pressed={blueprint.enabled && !blueprint.stopped}
          disabled={busy}
          onClick={() => act(() => blueprints.update(blueprint.id, { enabled: !(blueprint.enabled && !blueprint.stopped) }))}
        >
          {blueprint.enabled && !blueprint.stopped ? 'On' : 'Off'}
        </button>
        {events.length > 1 && (
          <select value={from?.id ?? ''} onChange={(e) => setTestFrom(e.target.value)} aria-label="Test from">
            {events.map((n) => (
              <option key={n.id} value={n.id}>
                from: {specOf(n.type)!.label}
              </option>
            ))}
          </select>
        )}
        <button type="button" onClick={test} disabled={busy || !from}>
          Test
        </button>
        <button type="button" onClick={shareMenu.open} disabled={busy} aria-haspopup="menu" title="Send it to someone, as a picture that carries the blueprint">
          {copied ? 'Copied ✓' : 'Share ▾'}
        </button>
        {shareMenu.menu}
        {button && (
          <button type="button" onClick={runNow} disabled={busy}>
            ▶ Run
          </button>
        )}
        {going && (
          <button type="button" onClick={() => act(() => blueprints.stop(blueprint.id))} disabled={busy}>
            ■ Stop
          </button>
        )}
        <span className="meta bp-saving" aria-live="polite">
          {saving === 'waiting' || saving === 'saving' ? 'Saving…' : saving === 'saved' ? 'Saved' : saving === 'failed' ? 'Not saved' : ''}
        </span>
        <button
          type="button"
          className="bp-delete"
          disabled={busy}
          onClick={() => {
            if (!confirm(`Delete "${blueprint.name}"? This cannot be undone.`)) return;
            void act(async () => {
              await blueprints.remove(blueprint.id);
              onGone();
            });
          }}
        >
          Delete
        </button>
      </div>
      <p className="meta bp-status">
        {blueprint.stopped
          ? blueprint.stopped
          : !blueprint.enabled
            ? 'Off: it will not run until you switch it on. Test works either way.'
            : status.state === 'disabled'
              ? `Disabled: ${status.why}, so nothing can start it and it uses nothing. It runs again by itself once that changes.`
              : status.state === 'idle'
                ? `Idle: ${status.why}. Nothing is listened for until then.`
                : `On: runs ${events.map((n) => `when ${lowerFirst(specOf(n.type)!.label)}${hotkeyLabel(n)}`).join(', or ')}.`}
        {lonely.size > 0 && ` ${lonely.size} box${lonely.size === 1 ? ' is' : 'es are'} not joined to a "When" box and will never run.`}
      </p>
      {problem && <p className="error">{problem}</p>}
      {/*
        A window opened before an update, meeting a box added since: the board
        cannot draw what it does not know, and drawing the rest would save the
        blueprint without it at the first change. So it says to reload.
      */}
      {unknownBoxes > 0 ? (
        <div className="card bp-held">
          <p>
            This blueprint has {unknownBoxes === 1 ? 'a box' : `${unknownBoxes} boxes`} this window does not know yet: the app was
            updated after it was opened. Reload to see and change it. Changing it here could lose {unknownBoxes === 1 ? 'that box' : 'them'}.
          </p>
          <button type="button" className="primary" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      ) : (
      <Canvas
        graph={draft}
        onChange={change}
        habits={habits}
        ran={ran}
        placeholders={placeholders}
        agent={agent}
        enabled={blueprint.enabled && !blueprint.stopped}
        variables={variables}
        chains={chains}
        onForget={(name) => void blueprints.forgetVariable(name).then(reload)}
      />
      )}
      <Runs runs={sorted} shown={run?.id ?? null} onShow={setShown} draft={draft} waiting={waiting} />
    </div>
  );
}


/** What a shared blueprint's boxes can do to this PC, said before it is added. */
const ACTS_ON_PC: Record<string, string> = {
  'press-keys': 'press keys',
  'open-url': 'open websites',
  'launch-game': 'start games',
  media: 'press media keys',
  'play-music': 'play music',
  'on-hotkey': 'listen for keys or mouse buttons',
  'on-voice': 'listen for phrases',
};

function IncomingCard({ shared, onAdd, onCancel }: { shared: Shared; onAdd: () => void; onCancel: () => void }) {
  const nodes = shared.graph.nodes as Array<{ type?: unknown; fields?: Record<string, unknown> }>;
  const known = nodes.filter((n) => typeof n.type === 'string' && specOf(n.type));
  const acts = [...new Set(known.map((n) => ACTS_ON_PC[String(n.type)]).filter(Boolean))];
  if (known.some((n) => n.type === 'play-sound' && n.fields?.sound === 'file')) acts.push('play a sound file from this PC');
  const unknown = nodes.length - known.length;
  const habits = known.some((n) => specOf(String(n.type))!.fields.some((f) => f.kind === 'habit' && n.fields?.[f.key]));
  return (
    <div className="card bp-incoming">
      <strong>Add "{shared.name}"?</strong>
      <span className="meta">
        {known.length} box{known.length === 1 ? '' : 'es'}. It arrives switched off, so nothing runs until you have looked at it and switched it on.
      </span>
      {acts.length > 0 && <span className="meta warn">Once on, it can {acts.join(', ')}.</span>}
      {habits && <span className="meta">Its habit boxes name the habits of whoever made it: pick yours in them.</span>}
      {unknown > 0 && <span className="meta">{unknown} of its boxes are a kind this app does not have, and are left out.</span>}
      <span className="bp-incoming-buttons">
        <button type="button" className="primary" onClick={onAdd}>
          Add it
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </span>
    </div>
  );
}

/** " (ctrl+alt+t)", or for a watched one " (mouse4, in a game)", after "when I press a hotkey". */
function hotkeyLabel(n: Graph['nodes'][number]): string {
  if (n.type !== 'on-hotkey') return '';
  const keys = n.fields.listen === 'watch' ? n.fields.watch : n.fields.keys;
  if (!keys) return '';
  return n.fields.game ? ` (${keys}, while playing)` : ` (${keys})`;
}


/** What the server says about it, or, from a server older than that, what its own switch says. */
function statusFor(b: Blueprint, statuses: Record<string, BlueprintStatus> | undefined): BlueprintStatus {
  return statuses?.[b.id] ?? (b.stopped ? { state: 'stopped', why: b.stopped } : { state: b.enabled ? 'on' : 'off', why: '' });
}

// "When I press Run" reads as "when I press Run" after the word "when", not "when when…".
const lowerFirst = (s: string) => {
  const t = s.replace(/^When /, '');
  return /^I\b/.test(t) ? t : t.charAt(0).toLowerCase() + t.slice(1);
};

const MARK: Record<string, string> = { started: '●', yes: '✓', no: '✗', done: '✓', failed: '!', stopped: '■' };

function Runs({
  runs,
  shown,
  onShow,
  draft,
  waiting,
}: {
  runs: Run[];
  shown: string | null;
  onShow: (id: string) => void;
  draft: Graph;
  waiting: Set<string>;
}) {
  if (runs.length === 0) {
    return <p className="meta bp-runs-empty">It has not run yet. Press Test to see which way it would go.</p>;
  }
  const run = runs.find((r) => r.id === shown) ?? runs[0]!;
  const label = (id: string) => {
    const node = draft.nodes.find((n) => n.id === id);
    return node ? specOf(node.type)?.label ?? node.type : 'a box since removed';
  };
  return (
    <section className="card bp-runs">
      <div className="bp-runs-head">
        <h3>
          {run.dry ? 'Test' : run.hand ? 'Ran from its hotkey' : 'Ran'} {relative(run.at)}
          {waiting.has(run.id) && <span className="meta"> · still going</span>}
        </h3>
        {runs.length > 1 && (
          <select value={run.id} onChange={(e) => onShow(e.target.value)} aria-label="Show an earlier run">
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.dry ? 'Test' : 'Ran'} {new Date(r.at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
              </option>
            ))}
          </select>
        )}
      </div>
      <ol className="bp-steps">
        {run.steps.map((s, i) => (
          <li key={i} className={`bp-step ${s.result}`}>
            <span className="bp-step-mark" aria-hidden="true">{MARK[s.result]}</span>
            <span>
              <strong>{label(s.node)}</strong>
              {s.result !== 'started' && <span className="meta"> · {s.said}</span>}
            </span>
          </li>
        ))}
      </ol>
      {run.dry && <p className="meta">A test only says what it would do; nothing was changed.</p>}
    </section>
  );
}
