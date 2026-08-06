import { useState } from 'react';
import { api, type Habit, type VoiceCommand, type VoiceCommandKind } from '../api';
import { useAsync } from '../useAsync';
import { Toggle } from '../controls';

const KIND_LABEL: Record<VoiceCommandKind, string> = {
  habit: 'Tick off a habit',
  note: 'Write a note',
  url: 'Open a website',
  hotkey: 'Press keys',
  pause: 'Stop listening',
};

const KIND_HELP: Record<VoiceCommandKind, string> = {
  habit: 'Records one against the habit. Saying "two" or "three" counts that many.',
  note: 'Whatever you say after the phrase becomes the note.',
  url: 'Opens in your default browser. Only http and https addresses.',
  hotkey: 'Sends the keys to whichever window is focused. Needs a modifier — ctrl, alt, shift or win.',
  pause: 'Closes the microphone. Leave the minutes at zero to keep it off until you switch it back on.',
};

/**
 * Everything a phrase can do, and how to change it.
 *
 * This was a read-only list of habit phrases. It is the whole command surface
 * now, because "what can I say" is a question about voice rather than about any
 * one habit — and because habits were never the only useful answer to it.
 */
export function VoicePhrases() {
  const commands = useAsync(() => api.voice.commands());
  const habits = useAsync(() => api.habits.list());
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  if (commands.loading) return <div className="empty">loading…</div>;
  const all = commands.data ?? [];

  const reload = () => {
    commands.reload();
    habits.reload();
  };

  return (
    <>
      <div className="meta" style={{ marginBottom: 8 }}>
        Tense and filler words don't matter — "drink water" already catches "I just drank some water". Add a
        second phrase only for a genuinely different wording.
      </div>

      {all.length === 0 && <div className="empty">Nothing is wired up yet, so voice has nothing to match.</div>}

      {all.map((command) =>
        editing === command.id ? (
          <CommandEditor
            key={command.id}
            command={command}
            habits={habits.data ?? []}
            onDone={() => {
              setEditing(null);
              reload();
            }}
          />
        ) : (
          <div className="card" key={command.id}>
            <div className="row between">
              <div className="grow">
                <div className="title">{command.label ?? KIND_LABEL[command.kind]}</div>
                <div className="meta">
                  {KIND_LABEL[command.kind]}
                  {command.phrases.length > 0 && ` · ${command.phrases.map((p) => `"${p}"`).join(', ')}`}
                  {!command.enabled && ' · off'}
                </div>
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
        )
      )}

      {adding ? (
        <CommandEditor
          habits={habits.data ?? []}
          onDone={() => {
            setAdding(false);
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
  onDone,
}: {
  command?: VoiceCommand;
  habits: Habit[];
  onDone: () => void;
}) {
  const [kind, setKind] = useState<VoiceCommandKind>(command?.kind ?? 'habit');
  const [phrases, setPhrases] = useState<string[]>(command?.phrases ?? []);
  const [draft, setDraft] = useState('');
  const [target, setTarget] = useState(command?.target ?? '');
  const [pauseMinutes, setPauseMinutes] = useState(command?.pauseMinutes ?? 0);
  const [label, setLabel] = useState(command?.label ?? '');
  const [enabled, setEnabled] = useState(command?.enabled ?? true);
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

    const payload = {
      kind,
      phrases: finalPhrases,
      target: kind === 'note' || kind === 'pause' ? null : target.trim(),
      pauseMinutes: kind === 'pause' && pauseMinutes > 0 ? pauseMinutes : null,
      label: label.trim() || null,
      enabled,
    };

    try {
      if (command) await api.voice.updateCommand(command.id, payload);
      else await api.voice.createCommand(payload);
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <select value={kind} onChange={(e) => setKind(e.target.value as VoiceCommandKind)} aria-label="What it does">
        {(Object.keys(KIND_LABEL) as VoiceCommandKind[]).map((option) => (
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
        <div className="row" style={{ marginTop: 10 }}>
          <input
            type="number"
            min={0}
            max={1440}
            value={pauseMinutes}
            aria-label="Minutes to stop listening for"
            onChange={(e) => setPauseMinutes(Number(e.target.value))}
          />
          <span className="meta">{pauseMinutes > 0 ? 'minutes' : 'until switched back on by hand'}</span>
        </div>
      )}

      {phrases.length > 0 && (
        <div className="row wrap" style={{ marginTop: 10 }}>
          {phrases.map((phrase) => (
            <button
              key={phrase}
              className="btn subtle"
              aria-label={`Remove phrase ${phrase}`}
              onClick={() => setPhrases(phrases.filter((p) => p !== phrase))}
            >
              {phrase} ✕
            </button>
          ))}
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

      {error && <div className="banner">{error}</div>}

      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn primary" disabled={busy} onClick={() => void save()}>
          Save
        </button>
        <button className="btn" onClick={onDone}>
          Cancel
        </button>
        <div className="grow" />
        <span className="meta">on</span>
        <Toggle on={enabled} label="Enabled" onChange={setEnabled} />
      </div>
    </div>
  );
}
