import { useState } from 'react';
import { api, type Habit, type VoiceCommand, type VoiceCommandKind } from '../../api';
import { useAsync } from '../../useAsync';
import { Toggle } from '../../controls';

const KIND_LABEL: Record<VoiceCommandKind, string> = {
  habit: 'Tick off a habit',
  note: 'Write a note',
  url: 'Open a website',
  hotkey: 'Press keys',
  media: 'Control media',
  pause: 'Stop listening',
  // Not offered on its own — see SELECTABLE_KINDS. `cancel` is presented as one
  // of the ways to stop listening, because that is what it is from where you
  // is sitting; only the *duration* differs.
  cancel: 'Stop listening',
};

/**
 * What the "what it does" dropdown offers.
 *
 * `cancel` is deliberately absent. It is a scope of "Stop listening" rather
 * than a sixth thing to choose between — offering both side by side made two
 * near-identical entries and left you guessing which one meant "never mind".
 */
const SELECTABLE_KINDS: VoiceCommandKind[] = ['habit', 'note', 'url', 'hotkey', 'media', 'pause'];

/**
 * The media controls, duplicated from `MEDIA_LABEL` in @everything/shared.
 *
 * Same reason as everything else here: importing that package pulls zod into a
 * bundle that is otherwise almost entirely framework. Display copy only — the
 * server validates which of these is a real action.
 */
const MEDIA_LABEL: Record<string, string> = {
  playpause: 'Play / pause',
  next: 'Skip forward',
  previous: 'Skip back',
  stop: 'Stop',
  volumeup: 'Volume up',
  volumedown: 'Volume down',
  mute: 'Mute / unmute',
};

/** How long a "Stop listening" lasts. The only thing separating pause from cancel. */
type StopScope = 'sentence' | 'minutes' | 'manual';

const SCOPE_LABEL: Record<StopScope, string> = {
  sentence: 'Just this sentence — never mind',
  minutes: 'For a few minutes',
  manual: 'Until I switch it back on',
};

const SCOPE_HELP: Record<StopScope, string> = {
  sentence:
    'Drops whatever you were part-way through saying and hides the popup. The microphone stays on, so the wake word works again immediately.',
  minutes: 'Closes the microphone for a set time, then it starts listening again on its own.',
  manual: 'Closes the microphone until you turn it back on from this screen.',
};

/** Words of a command the speech model has no pronunciation for. */
function brokenWords(command: VoiceCommand, unknown: Set<string>): string[] {
  if (unknown.size === 0) return [];
  const words = command.phrases.flatMap((phrase) => phrase.toLowerCase().split(/\s+/));
  return [...new Set(words)].filter((word) => unknown.has(word));
}

/** What to call a saved command in the list — scope included, for the stop kinds. */
function describeKind(command: VoiceCommand): string {
  if (command.kind === 'media') {
    return `Control media · ${MEDIA_LABEL[command.target ?? ''] ?? 'unknown control'}`;
  }
  if (command.kind === 'cancel') return 'Stop listening · just this sentence';
  if (command.kind === 'pause') {
    return command.pauseMinutes
      ? `Stop listening · for ${command.pauseMinutes} minutes`
      : 'Stop listening · until switched back on';
  }
  return KIND_LABEL[command.kind];
}

const KIND_HELP: Record<VoiceCommandKind, string> = {
  habit: 'Records one against the habit. Saying "two" or "three" counts that many.',
  note: 'Whatever you say after the phrase becomes the note.',
  url: 'Opens in your default browser. Only http and https addresses.',
  hotkey: 'Sends the keys to whichever window is focused. Needs a modifier — ctrl, alt, shift or win.',
  media:
    'Uses the system media keys, so it reaches whatever is playing without that window being focused. Ignored entirely when nothing is playing, so a mis-heard word cannot skip a track in a silent room.',
  pause: 'Closes the microphone — for a moment, for a few minutes, or until you turn it back on.',
  cancel: 'Closes the microphone.',
};

/**
 * Everything a phrase can do, and how to change it.
 *
 * This was a read-only list of habit phrases. It is the whole command surface
 * now, because "what can I say" is a question about voice rather than about any
 * one habit — and because habits were never the only useful answer to it.
 */
/**
 * The groups the list is broken into.
 *
 * `pause` and `cancel` share one, because the screen already presents them as
 * one choice with a scope — splitting them here would undo that.
 */
const GROUPS: { id: string; label: string; kinds: VoiceCommandKind[] }[] = [
  { id: 'habit', label: 'Habits', kinds: ['habit'] },
  { id: 'note', label: 'Notes', kinds: ['note'] },
  { id: 'url', label: 'Websites', kinds: ['url'] },
  { id: 'hotkey', label: 'Hotkeys', kinds: ['hotkey'] },
  { id: 'media', label: 'Media', kinds: ['media'] },
  { id: 'stop', label: 'Stop listening', kinds: ['pause', 'cancel'] },
];

const COLLAPSED_KEY = 'everything.voiceGroupsCollapsed';

/** Which sections are shut. Remembered, because reopening them every visit is a chore. */
function readCollapsed(): Set<string> {
  try {
    const stored = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
    return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

/**
 * Everything a phrase can do, and how to change it.
 *
 * Grouped by what the command *does*, because the flat list stopped being
 * scannable at about six entries and this is a list that only grows. Sections
 * are `<details>` rather than hand-rolled state: the browser gives keyboard
 * support and the open/closed semantics for free.
 */
export function VoicePhrases() {
  const commands = useAsync(() => api.voice.commands());
  // Only the agent can answer "does the model know this word", because only it
  // has the model loaded.
  const status = useAsync(() => api.voice.status());
  const habits = useAsync(() => api.habits.list());
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);

  if (commands.loading) return <div className="empty">loading…</div>;
  const all = commands.data ?? [];

  /*
   * Words the speech model has no pronunciation for.
   *
   * Vosk drops these from the grammar with a warning on stderr, so the phrase
   * reads perfectly and can never match — the exact failure this screen exists
   * to prevent. Compounds and coinages are the usual culprits: "unmute" is
   * absent from a dictionary that has "obstreperous".
   */
  const unknown = new Set(status.data?.unknownWords ?? []);
  const broken = unknown.size === 0
    ? []
    : all
        .map((command) => ({
          command,
          words: [...new Set(command.phrases.flatMap((p) => p.toLowerCase().split(/\s+/)))].filter((w) =>
            unknown.has(w)
          ),
        }))
        .filter((entry) => entry.words.length > 0);

  const reload = () => {
    commands.reload();
    habits.reload();
  };

  function setOpen(id: string, open: boolean) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (open) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // Private browsing, or a full quota. Losing the preference is not worth
        // failing the render over.
      }
      return next;
    });
  }

  function row(command: VoiceCommand) {
    if (editing === command.id) {
      return (
        <CommandEditor
          key={command.id}
          command={command}
          habits={habits.data ?? []}
          unknownWords={unknown}
          onDone={() => {
            setEditing(null);
            reload();
          }}
        />
      );
    }

    // Flagged on the command itself, not only in the summary above: this is the
    // row you are looking at when you wonder why the phrase never fires.
    const bad = brokenWords(command, unknown);

    return (
      <div className="card" key={command.id}>
        <div className="row between">
          <div className="grow">
            <div className="title">
              {command.label ?? KIND_LABEL[command.kind]}
              {bad.length > 0 && <span className="urgent" title="contains a word that cannot be recognised"> ⚠</span>}
            </div>
            <div className="meta">
              {describeKind(command)}
              {command.phrases.length > 0 && ` · ${command.phrases.map((p) => `"${p}"`).join(', ')}`}
              {!command.allowFollowUp && ' · no continuations'}
              {!command.enabled && ' · off'}
            </div>
            {bad.length > 0 && (
              <div className="meta urgent" style={{ marginTop: 4 }}>
                {bad.map((w) => `"${w}"`).join(', ')} cannot be recognised, so this never fires
              </div>
            )}
          </div>
          <button className="btn subtle" onClick={() => setEditing(command.id)}>
            edit
          </button>
          <button
            className="btn subtle danger"
            aria-label={`Remove ${command.label ?? command.kind}`}
            onClick={() => api.voice.removeCommand(command.id).then(reload)}
          >
            remove
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="meta" style={{ marginBottom: 8 }}>
        Tense and filler words don't matter — "drink water" already catches "I just drank some water". Add a
        second phrase only for a genuinely different wording.
      </div>

      {broken.length > 0 && (
        <div className="card">
          <div className="title urgent">Some words can never be recognised</div>
          <div className="meta" style={{ marginTop: 4 }}>
            The speech model has no pronunciation for these, so they are dropped and the phrase never matches.
            Compounds and made-up words are the usual cause — try two ordinary words instead.
          </div>
          {broken.map(({ command, words }) => (
            <div className="meta" key={command.id} style={{ marginTop: 6 }}>
              <strong>{command.label ?? KIND_LABEL[command.kind]}</strong> — {words.map((w) => `"${w}"`).join(', ')}
            </div>
          ))}
        </div>
      )}

      {all.length === 0 && <div className="empty">Nothing is wired up yet, so voice has nothing to match.</div>}

      {GROUPS.map((group) => {
        const mine = all.filter((command) => group.kinds.includes(command.kind));
        // An empty group is noise — the "Add" button below is how a new kind
        // gets its first entry, and the section appears once it has one.
        if (mine.length === 0) return null;

        return (
          <details
            className="group"
            key={group.id}
            open={!collapsed.has(group.id)}
            onToggle={(e) => setOpen(group.id, (e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary>
              {group.label}
              <span className="meta"> {mine.length}</span>
              {/* Collapsing a section should not hide a problem inside it. */}
              {mine.some((command) => brokenWords(command, unknown).length > 0) && (
                <span className="urgent" title="a command in here cannot be recognised"> ⚠</span>
              )}
            </summary>
            {mine.map(row)}
          </details>
        );
      })}

      {adding ? (
        <CommandEditor
          habits={habits.data ?? []}
          unknownWords={unknown}
          onDone={(savedKind) => {
            setAdding(false);
            // Open whichever section it landed in, or it looks like nothing
            // happened when that section happens to be shut.
            if (savedKind) {
              const group = GROUPS.find((g) => g.kinds.includes(savedKind));
              if (group) setOpen(group.id, true);
            }
            reload();
          }}
        />
      ) : (
        <button className="btn primary" style={{ marginTop: 4 }} onClick={() => setAdding(true)}>
          Add something to say
        </button>
      )}
    </>
  );
}

/**
 * One command, being written.
 *
 * The target field changes shape with the kind, because a habit id, a URL and a
 * key combination have nothing in common but the column they share. Validation
 * errors come back from the server rather than being duplicated here — it is
 * the side that refuses a bare letter as a hotkey, and it should stay the only
 * side that decides that.
 */
function CommandEditor({
  command,
  habits,
  unknownWords,
  onDone,
}: {
  command?: VoiceCommand;
  habits: Habit[];
  /** Words the model cannot pronounce, so a phrase using one never matches. */
  unknownWords: Set<string>;
  onDone: (savedKind?: VoiceCommandKind) => void;
}) {
  // `cancel` is edited as "Stop listening" with a scope, so the dropdown never
  // shows it: the two are one choice as far as this screen is concerned.
  const [kind, setKind] = useState<VoiceCommandKind>(
    command?.kind === 'cancel' ? 'pause' : (command?.kind ?? 'habit')
  );
  const [scope, setScope] = useState<StopScope>(
    command?.kind === 'cancel' ? 'sentence' : command?.pauseMinutes ? 'minutes' : 'manual'
  );
  const [phrases, setPhrases] = useState<string[]>(command?.phrases ?? []);
  const [draft, setDraft] = useState('');
  const [target, setTarget] = useState(command?.target ?? '');
  const [pauseMinutes, setPauseMinutes] = useState(command?.pauseMinutes ?? 0);
  const [label, setLabel] = useState(command?.label ?? '');
  const [enabled, setEnabled] = useState(command?.enabled ?? true);
  const [allowFollowUp, setAllowFollowUp] = useState(command?.allowFollowUp ?? true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const active = habits.filter((habit) => habit.active);

  function addPhrase() {
    const phrase = draft.trim().toLowerCase();
    if (!phrase || phrases.includes(phrase)) return;
    setPhrases([...phrases, phrase]);
    setDraft('');
  }

  async function save() {
    // Taking a phrase that was typed but never added: doing that is what
    // everyone does, and silently discarding it reads as "Save didn't work".
    const pending = draft.trim().toLowerCase();
    const finalPhrases = pending && !phrases.includes(pending) ? [...phrases, pending] : phrases;

    if (finalPhrases.length === 0) {
      setError('give it at least one phrase to listen for');
      return;
    }

    setBusy(true);
    setError('');

    // The scope is what decides which kind this really is. They do genuinely
    // different things underneath — one abandons a sentence, the other closes
    // the microphone — so the distinction stays in the data even though the
    // screen presents them as one choice.
    const realKind: VoiceCommandKind = kind === 'pause' && scope === 'sentence' ? 'cancel' : kind;

    const payload = {
      kind: realKind,
      phrases: finalPhrases,
      target: realKind === 'note' || realKind === 'pause' || realKind === 'cancel' ? null : target.trim(),
      pauseMinutes: realKind === 'pause' && scope === 'minutes' && pauseMinutes > 0 ? pauseMinutes : null,
      label: label.trim() || null,
      allowFollowUp,
      enabled,
    };

    try {
      if (command) await api.voice.updateCommand(command.id, payload);
      else await api.voice.createCommand(payload);
      onDone(realKind);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <select value={kind} onChange={(e) => setKind(e.target.value as VoiceCommandKind)} aria-label="What it does">
        {SELECTABLE_KINDS.map((option) => (
          <option key={option} value={option}>
            {KIND_LABEL[option]}
          </option>
        ))}
      </select>
      <div className="meta" style={{ marginTop: 6 }}>
        {KIND_HELP[kind]}
      </div>

      {kind === 'habit' && (
        <select
          style={{ marginTop: 10 }}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          aria-label="Which habit"
        >
          <option value="">choose a habit…</option>
          {active.map((habit) => (
            <option key={habit.id} value={habit.id}>
              {habit.name}
            </option>
          ))}
        </select>
      )}

      {kind === 'url' && (
        <input
          style={{ marginTop: 10 }}
          value={target}
          placeholder="https://mail.google.com"
          aria-label="Address to open"
          onChange={(e) => setTarget(e.target.value)}
        />
      )}

      {kind === 'media' && (
        <select
          style={{ marginTop: 10 }}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          aria-label="Which media control"
        >
          <option value="">choose a control…</option>
          {Object.entries(MEDIA_LABEL).map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </select>
      )}

      {kind === 'hotkey' && (
        <input
          style={{ marginTop: 10 }}
          value={target}
          placeholder="ctrl+shift+m"
          aria-label="Keys to press"
          onChange={(e) => setTarget(e.target.value)}
        />
      )}

      {kind === 'pause' && (
        <>
          <select
            style={{ marginTop: 10 }}
            value={scope}
            aria-label="How long to stop listening"
            onChange={(e) => setScope(e.target.value as StopScope)}
          >
            {(Object.keys(SCOPE_LABEL) as StopScope[]).map((option) => (
              <option key={option} value={option}>
                {SCOPE_LABEL[option]}
              </option>
            ))}
          </select>
          <div className="meta" style={{ marginTop: 6 }}>
            {SCOPE_HELP[scope]}
          </div>

          {scope === 'minutes' && (
            <div className="row" style={{ marginTop: 10 }}>
              <input
                type="number"
                min={1}
                max={1440}
                value={pauseMinutes || 5}
                aria-label="Minutes to stop listening for"
                onChange={(e) => setPauseMinutes(Number(e.target.value))}
              />
              <span className="meta">minutes</span>
            </div>
          )}
        </>
      )}

      {phrases.length > 0 && (
        <div className="row wrap" style={{ marginTop: 10 }}>
          {phrases.map((phrase) => {
            const bad = phrase
              .toLowerCase()
              .split(/\s+/)
              .filter((word) => unknownWords.has(word));
            return (
              <button
                key={phrase}
                className={`btn subtle${bad.length > 0 ? ' danger' : ''}`}
                aria-label={`Remove phrase ${phrase}`}
                title={bad.length > 0 ? `${bad.join(', ')} cannot be recognised` : undefined}
                onClick={() => setPhrases(phrases.filter((p) => p !== phrase))}
              >
                {bad.length > 0 && '⚠ '}
                {phrase} ✕
              </button>
            );
          })}
        </div>
      )}

      <div className="row" style={{ marginTop: 8 }}>
        <div className="grow">
          <input
            value={draft}
            placeholder="what you would say"
            aria-label="New phrase"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addPhrase();
              }
            }}
          />
        </div>
        <button className="btn" disabled={!draft.trim()} onClick={addPhrase}>
          Add phrase
        </button>
      </div>

      <input
        style={{ marginTop: 8 }}
        value={label}
        placeholder="name it (optional)"
        aria-label="Name"
        onChange={(e) => setLabel(e.target.value)}
      />

      <div className="row between" style={{ marginTop: 12 }}>
        <div className="grow">
          <div className="title">Open to continuations</div>
          <div className="meta">
            {allowFollowUp
              ? 'After this runs, you can say another thing without the wake word.'
              : 'The microphone closes as soon as this runs — good for anything that sends you elsewhere.'}
          </div>
        </div>
        <Toggle on={allowFollowUp} label="Open to continuations" onChange={setAllowFollowUp} />
      </div>

      {error && <div className="banner">{error}</div>}

      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn primary" disabled={busy} onClick={() => void save()}>
          Save
        </button>
        <button className="btn" onClick={() => onDone()}>
          Cancel
        </button>
        <div className="grow" />
        <span className="meta">on</span>
        <Toggle on={enabled} label="Enabled" onChange={setEnabled} />
      </div>
    </div>
  );
}
