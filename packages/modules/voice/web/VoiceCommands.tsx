import { useState } from 'react';
import { goTo } from '@app/nav';
import { voiceApi, type SpokenCommand, type VoiceCommand, type VoiceCommandKind } from './voice-api';
import { useAsync } from '@app/useAsync';
import { Toggle } from '@app/controls';
import type { ChangeScope } from '@app/live';

/*
 * What you can say, and where each is changed.
 *
 * **A command is a blueprint now** (2026-10-29): a "When I say" box holds the
 * phrases and the Do boxes after it do the work, so a spoken command can do
 * anything a blueprint can. This tab lists those, each with a button that opens
 * it on the Blueprints screen, and **New voice command** makes one.
 *
 * **Two stay here**: stop listening, and never mind. They act on the
 * microphone itself, and work with Blueprints switched off, so voice can always
 * be silenced by voice. They keep the editor they had.
 */

// Blueprints announce their changes under a scope core does not name, and the
// list changes whenever one is saved.
const WATCH = ['settings', 'blueprints'] as unknown as ChangeScope[];

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

/** Words of a phrase the recogniser will never write — a number written as digits. */
function brokenWords(phrases: string[], unknown: Set<string>): string[] {
  if (unknown.size === 0) return [];
  const words = phrases.flatMap((phrase) => phrase.toLowerCase().split(/\s+/));
  return [...new Set(words)].filter((word) => unknown.has(word));
}

/** What a stop command does, in the list. */
function describeStop(command: VoiceCommand): string {
  if (command.kind === 'cancel') return 'Stop listening · just this sentence';
  return command.pauseMinutes ? `Stop listening · for ${command.pauseMinutes} minutes` : 'Stop listening · until switched back on';
}

export function VoicePhrases() {
  const commands = useAsync(() => voiceApi.commands(), [], WATCH);
  // Only the agent can answer "is this word ever written", because only it has
  // the model loaded.
  const status = useAsync(() => voiceApi.status(), [], ['settings']);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [problem, setProblem] = useState('');

  if (commands.loading) return <div className="empty">loading…</div>;
  const own = commands.data?.own ?? [];
  const spoken = commands.data?.spoken ?? [];
  const unknown = new Set(status.data?.unknownWords ?? []);

  async function newCommand() {
    setProblem('');
    try {
      const { edit } = await voiceApi.newBlueprint();
      goTo(edit.screen, { focus: edit.focus });
    } catch (error) {
      setProblem((error as Error).message);
    }
  }

  function spokenRow(command: SpokenCommand) {
    const bad = brokenWords(command.phrases, unknown);
    return (
      <div className="card" key={command.id}>
        <div className="row between">
          <div className="grow">
            <div className="title">
              {command.label}
              {bad.length > 0 && <span className="urgent" title="contains a word that is never heard as written"> ⚠</span>}
            </div>
            <div className="meta">
              {command.phrases.length > 0 ? command.phrases.map((p) => `"${p}"`).join(', ') : 'no phrases yet'}
              {!command.allowFollowUp && ' · stops listening after'}
              {!command.enabled && ' · off'}
            </div>
            {bad.length > 0 && (
              <div className="meta urgent" style={{ marginTop: 4 }}>
                {bad.map((w) => `"${w}"`).join(', ')} is never heard that way, so this never fires. Numbers are heard as words:
                write "two", not "2".
              </div>
            )}
          </div>
          <button className="btn subtle" onClick={() => goTo(command.edit.screen, { focus: command.edit.focus })}>
            Open
          </button>
        </div>
      </div>
    );
  }

  function ownRow(command: VoiceCommand) {
    if (editing === command.id) {
      return (
        <StopEditor
          key={command.id}
          command={command}
          unknownWords={unknown}
          onDone={() => {
            setEditing(null);
            commands.reload();
          }}
        />
      );
    }
    return (
      <div className="card" key={command.id}>
        <div className="row between">
          <div className="grow">
            <div className="title">{command.label ?? 'Stop listening'}</div>
            <div className="meta">
              {describeStop(command)}
              {command.phrases.length > 0 && ` · ${command.phrases.map((p) => `"${p}"`).join(', ')}`}
              {!command.enabled && ' · off'}
            </div>
          </div>
          <button className="btn subtle" onClick={() => setEditing(command.id)}>
            edit
          </button>
          <button
            className="btn subtle danger"
            aria-label={`Remove ${command.label ?? 'this'}`}
            onClick={() => voiceApi.removeCommand(command.id).then(commands.reload)}
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
        Each command is a blueprint: a <strong>When I say</strong> box with its phrases, joined to whatever it should
        do. Tense and filler words don't matter, so "drink water" already catches "I just drank some water".
      </div>

      <h3 className="voice-commands-head">From blueprints</h3>
      {!commands.data?.blueprints ? (
        <div className="empty">Blueprints is switched off, so voice has only its own commands below. Switch it on under Settings → Packages.</div>
      ) : spoken.length === 0 ? (
        <div className="empty">Nothing to say yet. Make one with New voice command.</div>
      ) : (
        spoken.map(spokenRow)
      )}
      {commands.data?.blueprints && (
        <button className="btn primary" style={{ marginTop: 4 }} onClick={() => void newCommand()}>
          New voice command
        </button>
      )}
      {problem && <div className="banner">{problem}</div>}

      <h3 className="voice-commands-head">Voice's own</h3>
      <div className="meta" style={{ marginBottom: 6 }}>
        These act on the microphone, so they stay here and work with Blueprints switched off.
      </div>
      {own.map(ownRow)}
      {adding ? (
        <StopEditor
          unknownWords={unknown}
          onDone={() => {
            setAdding(false);
            commands.reload();
          }}
        />
      ) : (
        <button className="btn" style={{ marginTop: 4 }} onClick={() => setAdding(true)}>
          Add a way to stop listening
        </button>
      )}
    </>
  );
}

/** A "stop listening" command, being written: the phrases and how long it lasts. */
function StopEditor({
  command,
  unknownWords,
  onDone,
}: {
  command?: VoiceCommand;
  /** Words the recogniser never writes, so a phrase using one never matches. */
  unknownWords: Set<string>;
  onDone: () => void;
}) {
  const [scope, setScope] = useState<StopScope>(
    command?.kind === 'cancel' ? 'sentence' : command?.pauseMinutes ? 'minutes' : command ? 'manual' : 'sentence'
  );
  const [phrases, setPhrases] = useState<string[]>(command?.phrases ?? []);
  const [draft, setDraft] = useState('');
  const [pauseMinutes, setPauseMinutes] = useState(command?.pauseMinutes ?? 0);
  const [label, setLabel] = useState(command?.label ?? '');
  const [enabled, setEnabled] = useState(command?.enabled ?? true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function addPhrase() {
    const phrase = draft.trim().toLowerCase();
    if (!phrase || phrases.includes(phrase)) return;
    setPhrases([...phrases, phrase]);
    setDraft('');
  }

  async function save() {
    // A phrase typed but never added is taken: silently discarding it reads as
    // "Save didn't work".
    const pending = draft.trim().toLowerCase();
    const finalPhrases = pending && !phrases.includes(pending) ? [...phrases, pending] : phrases;
    if (finalPhrases.length === 0) {
      setError('give it at least one phrase to listen for');
      return;
    }
    setBusy(true);
    setError('');
    // The scope decides which kind this really is: one abandons a sentence, the
    // other closes the microphone, so the distinction stays in the data.
    const kind: VoiceCommandKind = scope === 'sentence' ? 'cancel' : 'pause';
    const payload = {
      kind,
      phrases: finalPhrases,
      target: null,
      pauseMinutes: kind === 'pause' && scope === 'minutes' && pauseMinutes > 0 ? pauseMinutes : null,
      label: label.trim() || null,
      allowFollowUp: false,
      enabled,
    };
    try {
      if (command) await voiceApi.updateCommand(command.id, payload);
      else await voiceApi.createCommand(payload);
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <select value={scope} aria-label="How long to stop listening" onChange={(e) => setScope(e.target.value as StopScope)}>
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
                title={bad.length > 0 ? `${bad.join(', ')} is never heard that way — write numbers as words` : undefined}
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
