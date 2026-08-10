import { useEffect, useState } from 'react';
import { api, serverSupportsVoice, type VoiceSettings, type VoiceStatus as VoiceStatusType, type VoiceTest } from '../../api';
import { useAsync } from '../../useAsync';
import { Toggle } from '../../controls';
import { VoicePhrases } from './VoiceCommands';
import { VoiceLook } from './VoiceLook';

/**
 * Advice on a wake word — a copy of `wakeWordAdvice` in @everything/shared.
 *
 * Deliberately duplicated rather than imported, for the same reason `api.ts`
 * redeclares its row types: that package's entry point pulls in zod, which is
 * 14KB gzipped in a bundle whose entire point is being mostly framework. This
 * is display copy with no consequences if the two ever drift — the shared copy
 * is the one under test, and neither refuses anything.
 */
function wakeWordAdvice(wakeWord: string): string | null {
  const words = wakeWord.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length !== 1) return null;

  return words[0].length <= 4
    ? `"${words[0]}" is short as well as single — it will fire on ordinary conversation. A distinctive name of three syllables or more is far more reliable.`
    : 'One word will fire more often by accident, since there is nothing before it to rule out ordinary speech. Worth it if the longer version keeps getting half-heard — a distinctive name works best.';
}

/**
 * The always-on listener — its own tab, not a section buried in Settings.
 *
 * It is the only feature that holds a microphone open, so the switch that turns
 * it off has to be somewhere you can reach without hunting. The copy leads with
 * what it costs rather than what it does, for the same reason.
 */
export function Voice({ local }: { local: boolean }) {
  const settings = useAsync(() => api.settings.get(), [], ['settings']);

  if (settings.loading) return <div className="empty">loading…</div>;
  if (!settings.data) return <div className="empty">Could not load settings.</div>;

  // The three packages deploy separately, so the PWA can outrun the server —
  // most often right after an update, when the browser has the new bundle and
  // the old server process is still running. Reading a field that isn't there
  // used to throw and take the whole screen down with it, which looks like a
  // broken app rather than a stale one.
  if (!serverSupportsVoice(settings.data)) {
    return (
      <section>
        <h2>Voice</h2>
        <div className="card">
          <div className="title">The server is running an older version</div>
          <div className="meta" style={{ marginTop: 4 }}>
            This screen needs voice support on the server, and the process that's running predates it.
            Restart it and this page will work.
          </div>
          <code className="snippet">Stop Blue Everything.cmd, then Blue Everything.cmd</code>
        </div>
      </section>
    );
  }

  return <VoiceSettings settings={settings.data} local={local} reload={settings.reload} />;
}

function VoiceSettings({
  settings: current,
  local,
  reload,
}: {
  settings: VoiceSettings;
  local: boolean;
  reload: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [draftWakeWord, setDraftWakeWord] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function update(payload: Parameters<typeof api.settings.update>[0]) {
    setSaving(true);
    setError('');
    try {
      await api.settings.update(payload);
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'could not save');
    } finally {
      setSaving(false);
    }
  }

  // Fetched for the screen list, which only the agent can see — `window.screen`
  // describes the display this tab is on and nothing else.
  const look = useAsync(() => api.voice.status(), [], ['settings']).data ?? null;

  // The slider moves freely and saves once, on release. Sending a PATCH per
  // pixel would be a dozen writes and a dozen agent reconfigures for one drag.
  const [draftFollowUp, setDraftFollowUp] = useState<number | null>(null);
  const followUp = draftFollowUp ?? current.voiceFollowUpSeconds ?? 6;

  function commitFollowUp() {
    if (draftFollowUp === null || draftFollowUp === current.voiceFollowUpSeconds) return;
    void update({ voiceFollowUpSeconds: draftFollowUp }).then(() => setDraftFollowUp(null));
  }

  const [draftRetry, setDraftRetry] = useState<number | null>(null);
  const retry = draftRetry ?? current.voiceRetrySeconds ?? 8;

  function commitRetry() {
    if (draftRetry === null || draftRetry === current.voiceRetrySeconds) return;
    void update({ voiceRetrySeconds: draftRetry }).then(() => setDraftRetry(null));
  }

  const wakeWord = draftWakeWord ?? current.wakeWord;
  // One word is allowed. It is a worse choice, not an invalid one — and it is
  // the choice that survives the recogniser dropping half the phrase, so the
  // screen advises rather than refuses.
  const wakeWordValid = /^[a-z]+(?: [a-z]+)*$/i.test(wakeWord.trim()) && wakeWord.trim().length >= 3;
  const advice = wakeWordValid ? wakeWordAdvice(wakeWord) : null;

  /*
   * A wake word the model cannot pronounce is the worst version of this bug:
   * nothing wakes at all, and every other diagnostic on this screen looks fine.
   * Only checks the *saved* one, since that is what the agent was asked about.
   */
  const wakeWordUnknown = (look?.unknownWords ?? []).filter((word) =>
    current.wakeWord.toLowerCase().split(/\s+/).includes(word)
  );

  return (
    <>
      <section>
        <div className="card">
          <div className="row between">
            <div className="grow">
              <div className="title">Listen for a wake word</div>
              <div className="meta">
                Say the wake word, then something like <em>"I drank water"</em>, and the matching habit gets
                ticked off. The microphone stays open while this is on — nothing is recorded, nothing leaves
                this PC, and speech is only processed while there's actually sound in the room.
              </div>
            </div>
            <Toggle
              on={Boolean(current.voiceEnabled)}
              disabled={saving}
              label="Listen for a wake word"
              onChange={(on) => update({ voiceEnabled: on })}
            />
          </div>
        </div>

        <LiveStatus enabled={Boolean(current.voiceEnabled)} selectedDevice={current.voiceInputDevice ?? null} onPick={(device) => update({ voiceInputDevice: device })} saving={saving} />

        <div className="card">
          <div className="title">Wake word</div>
          <div className="meta" style={{ marginTop: 4 }}>
            Pick something you would never say by accident. Two words are safer, but a leading "hey" or "ok"
            is optional when it's heard — so "hey jarvis" also answers to just "jarvis".
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <div className="grow">
              <input value={wakeWord} aria-label="Wake word" onChange={(e) => setDraftWakeWord(e.target.value)} />
            </div>
            <button
              className="btn primary"
              disabled={saving || !wakeWordValid || wakeWord.trim() === current.wakeWord}
              onClick={() =>
                update({ wakeWord: wakeWord.trim().toLowerCase() }).then(() => setDraftWakeWord(null))
              }
            >
              Save
            </button>
          </div>
          {!wakeWordValid && (
            <div className="meta urgent" style={{ marginTop: 6 }}>
              Letters and spaces only, three characters or more.
            </div>
          )}
          {advice && (
            <div className="meta urgent" style={{ marginTop: 6 }}>
              {advice}
            </div>
          )}
          {wakeWordUnknown.length > 0 && (
            <div className="meta urgent" style={{ marginTop: 6 }}>
              ⚠ {wakeWordUnknown.map((w) => `"${w}"`).join(', ')} is not in the speech model's dictionary, so this
              wake word can never be heard. Compounds and invented names are the usual cause — separating one into
              two ordinary words almost always fixes it.
            </div>
          )}
          <div className="meta" style={{ marginTop: 6 }}>
            Takes effect straight away — the status above will say what it's listening for.
          </div>
        </div>

        <div className="card">
          <div className="title">Keep listening after it answers</div>
          <div className="meta" style={{ marginTop: 4 }}>
            {followUp === 0
              ? 'Off — the microphone closes as soon as a command is done, so every command needs the wake word.'
              : `For ${followUp} second${followUp === 1 ? '' : 's'} you can say another thing without the wake word. Longer is more conversational, but it also means stray speech can reach it for longer after each command.`}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <input
              type="range"
              min={0}
              max={30}
              step={1}
              value={followUp}
              aria-label="Seconds to keep listening after answering"
              onChange={(e) => setDraftFollowUp(Number(e.target.value))}
              onMouseUp={() => commitFollowUp()}
              onTouchEnd={() => commitFollowUp()}
              onKeyUp={() => commitFollowUp()}
            />
            <span className="meta" style={{ minWidth: 52 }}>
              {followUp === 0 ? 'off' : `${followUp}s`}
            </span>
          </div>
        </div>

        <div className="card">
          <div className="title">Keep listening after it misses</div>
          <div className="meta" style={{ marginTop: 4 }}>
            {retry === 0
              ? "Off — a miss closes the microphone, so you'd say the wake word again."
              : `For ${retry} second${retry === 1 ? '' : 's'} after it fails to understand, so you can just repeat yourself. Usually wants to be longer than the one above — you have to notice it missed first. Only one retry per wake, so a misheard cough can't hold the microphone open.`}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <input
              type="range"
              min={0}
              max={30}
              step={1}
              value={retry}
              aria-label="Seconds to keep listening after a miss"
              onChange={(e) => setDraftRetry(Number(e.target.value))}
              onMouseUp={() => commitRetry()}
              onTouchEnd={() => commitRetry()}
              onKeyUp={() => commitRetry()}
            />
            <span className="meta" style={{ minWidth: 52 }}>
              {retry === 0 ? 'off' : `${retry}s`}
            </span>
          </div>
        </div>
      </section>

      <VoiceLook settings={current} status={look} saving={saving} onChange={update} />

      <section>
        <h2>Only respond to my voice</h2>
        <div className="card">
          <div className="row between">
            <div className="grow">
              <div className="title">{current.hasVoiceprint ? 'Enrolled' : 'Not set up'}</div>
              <div className="meta">
                {current.hasVoiceprint
                  ? `Learned from ${current.voiceprintSamples} samples. Commands that don't sound like you are ignored.`
                  : 'Without this, anything that says the wake word can tick off a habit — including a video playing on this PC.'}
              </div>
            </div>
            <Toggle
              on={Boolean(current.requireKnownSpeaker)}
              disabled={saving || !current.hasVoiceprint}
              label="Only respond to my voice"
              onChange={(on) => update({ requireKnownSpeaker: on })}
            />
          </div>

          {local && <Enrol wakeWord={current.wakeWord} hasVoiceprint={Boolean(current.hasVoiceprint)} onDone={reload} />}

          {current.hasVoiceprint && local && (
            <div className="row" style={{ marginTop: 8 }}>
              <button
                className="btn subtle danger"
                disabled={saving}
                onClick={() => api.voice.forgetVoice().then(reload)}
              >
                Forget my voice
              </button>
              <span className="meta">Also turns the check off.</span>
            </div>
          )}

          {current.hasVoiceprint && (
            <>
              <div className="row" style={{ marginTop: 10 }}>
                <span className="meta">Strictness</span>
                <input
                  type="range"
                  min={30}
                  max={80}
                  step={5}
                  value={Math.round(current.speakerThreshold * 100)}
                  aria-label="Voice match strictness"
                  onChange={(e) => update({ speakerThreshold: Number(e.target.value) / 100 })}
                />
                <span className="meta">{Math.round(current.speakerThreshold * 100)}%</span>
              </div>
              <div className="meta" style={{ marginTop: 6 }}>
                Higher rejects more. If it starts ignoring you, lower it a notch; if the TV gets through,
                raise it. This filters the room — it is not a lock, and a recording of your voice would pass
                it.
              </div>
            </>
          )}
        </div>
      </section>

      <section>
        <h2>What can I say?</h2>
        <VoicePhrases />
        <PhraseTester />
      </section>

      {error && <div className="banner">{error}</div>}
    </>
  );
}

/**
 * Teaching it your voice, from a button.
 *
 * This used to be a terminal command, which could not work while voice was on:
 * the agent already holds the microphone, so a second process opening it gets
 * `MMSYSERR_ALLOCATED`. So the server arms a window and the *running* agent
 * collects the samples — which also means the progress can be shown here, and
 * on the overlay at the same time.
 */
function Enrol({
  wakeWord,
  hasVoiceprint,
  onDone,
}: {
  wakeWord: string;
  hasVoiceprint: boolean;
  onDone: () => void;
}) {
  const [status, setStatus] = useState<VoiceStatusType | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const enrolling = status?.enrolling ?? false;

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const next = await api.voice.status();
        if (!live) return;
        // Finished: the agent stored a voiceprint and the window closed.
        if (enrolling && !next.enrolling) onDone();
        setStatus(next);
        timer = setTimeout(tick, next.enrolling ? 400 : 3000);
      } catch {
        if (live) timer = setTimeout(tick, 4000);
      }
    };

    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `enrolling` is read inside to spot the transition; re-running on it is
    // what makes the finish land immediately rather than a poll later.
  }, [enrolling, onDone]);

  async function start() {
    setBusy(true);
    setError('');
    try {
      await api.voice.startEnrol();
      setStatus(await api.voice.status());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'could not start');
    } finally {
      setBusy(false);
    }
  }

  const collected = status?.enrolSamples ?? 0;
  const agreement = status?.enrolAgreement ?? null;

  return (
    <div style={{ marginTop: 12 }}>
      {enrolling ? (
        <>
          <div className="title">
            Say "{wakeWord}" — {collected} of 10
          </div>
          <div className="meta" style={{ marginTop: 4 }}>
            Leave a beat between each one. Speak the way you actually will: sitting where you sit, at the
            volume you use.
            {agreement !== null && ` Consistency ${Math.round(agreement * 100)}%.`}
          </div>
          <div className="level" style={{ marginTop: 8 }} aria-label={`${collected} of 10 collected`}>
            <div className="level-fill" style={{ width: `${collected * 10}%` }} />
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn" disabled={busy} onClick={() => void api.voice.stopEnrol().then(() => setStatus(null))}>
              Cancel
            </button>
            <span className="meta">Progress also shows on the popup at your cursor.</span>
          </div>
        </>
      ) : (
        <>
          <div className="meta">
            {hasVoiceprint
              ? 'Enrol again to replace what it learned.'
              : `It learns from the wake word itself — say "${wakeWord}" ten times.`}
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn primary" disabled={busy} onClick={() => void start()}>
              {hasVoiceprint ? 'Enrol again' : 'Teach it my voice'}
            </button>
          </div>
        </>
      )}
      {error && <div className="banner">{error}</div>}
    </div>
  );
}

/**
 * Is it actually listening, on which microphone, and can I prove it?
 *
 * The switch above used to be the whole screen, which made it write-only: it
 * could turn the microphone on but never said whether anything happened. A
 * switch reading "on" while the agent is stopped, the models are missing, or
 * the wrong microphone is selected is worse than no switch at all, because it
 * looks like it worked.
 *
 * Polls rather than using the SSE stream: this is live hardware state that
 * changes continuously while nothing in the database does, and announcing every
 * level reading would reload every open client several times a second. It only
 * polls while this screen is open, and faster only while a test is running.
 */
function LiveStatus({
  enabled,
  selectedDevice,
  onPick,
  saving,
}: {
  enabled: boolean;
  selectedDevice: string | null;
  onPick: (device: string | null) => void;
  saving: boolean;
}) {
  const [status, setStatus] = useState<VoiceStatusType | null>(null);
  const [busy, setBusy] = useState(false);

  const testing = status?.testing ?? false;

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const next = await api.voice.status();
        if (!live) return;
        setStatus(next);
        // A test is a live readout, so it needs to feel immediate; the rest of
        // the time twice a second is plenty and costs a tiny local request.
        timer = setTimeout(tick, next.testing ? 400 : 2000);
      } catch {
        if (live) timer = setTimeout(tick, 4000);
      }
    };

    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);

  if (!status) return null;

  const secondsLeft = testing ? Math.max(0, Math.ceil((status.testUntil - Date.now()) / 1000)) : 0;

  const pausedFor =
    status.pausedUntil && status.pausedUntil > 0
      ? `until ${new Date(status.pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : 'until you switch it back on';

  // The states worth telling apart, because each has a different fix. `paused`
  // has to come before `listening`: the setting is still on while paused, so
  // without it this said "Starting up…" indefinitely at something that was
  // never going to start.
  const state = !status.agentRunning
    ? { text: 'The agent is not running', tone: 'urgent', why: 'Nothing is listening. Start it with Blue Everything.cmd.' }
    : status.error
      ? { text: 'Not listening', tone: 'urgent', why: status.error }
      : !enabled
        ? { text: 'Switched off', tone: 'meta', why: 'The microphone is closed and the models are unloaded.' }
        : status.paused
          ? { text: 'Paused', tone: 'urgent', why: `You asked it to stop listening, ${pausedFor}.` }
          : // Before `listening`, for the same reason `paused` is: the setting
            // is still on, so without this the screen said "Starting up…" at a
            // microphone that had been closed deliberately and was not coming
            // back until somebody touched the keyboard.
            status.awayFromPc
            ? {
                text: 'Asleep — you are away',
                tone: 'meta',
                why: 'The microphone and the speech models are released while the desk is empty. Move the mouse and it comes back.',
              }
            : status.listening
              ? { text: `Listening on ${status.device ?? 'the default microphone'}`, tone: 'ok-text', why: '' }
              : { text: 'Starting up…', tone: 'meta', why: 'Loading the speech models — this takes a moment.' };

  return (
    <div className="card">
      <div className="row between">
        <div className="grow">
          <div className={`title ${state.tone === 'ok-text' ? 'ok-text' : ''}`}>{state.text}</div>
          {state.why && <div className={`meta ${state.tone === 'urgent' ? 'urgent' : ''}`}>{state.why}</div>}
        </div>
        {/* Resume outranks Test: while paused there is nothing to test, and
            getting back to listening is the only thing worth offering. */}
        {enabled && status.paused ? (
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.voice.resume();
                setStatus(await api.voice.status());
              } finally {
                setBusy(false);
              }
            }}
          >
            Start listening
          </button>
        ) : (
          enabled &&
          status.agentRunning && (
            <button
              className={`btn ${testing ? '' : 'primary'}`}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  if (testing) await api.voice.stopListening();
                  else await api.voice.startListening();
                  setStatus(await api.voice.status());
                } finally {
                  setBusy(false);
                }
              }}
            >
              {testing ? `Stop (${secondsLeft}s)` : 'Test it'}
            </button>
          )
        )}
      </div>

      {/* The level meter answers "is this microphone picking me up at all",
          which is the first thing to check and the hardest to guess at. */}
      {enabled && status.listening && (
        <div className="level" style={{ marginTop: 10 }} aria-label={`Input level ${Math.round(status.peak * 100)}%`}>
          <div className="level-fill" style={{ width: `${Math.min(100, Math.round(status.peak * 400))}%` }} />
        </div>
      )}

      <div className="row" style={{ marginTop: 10 }}>
        <span className="meta">Microphone</span>
        <select
          value={selectedDevice ?? ''}
          disabled={saving || status.devices.length === 0}
          aria-label="Input device"
          onChange={(e) => onPick(e.target.value === '' ? null : e.target.value)}
        >
          <option value="">Windows default</option>
          {status.devices.map((device) => (
            <option key={device.id} value={device.name}>
              {device.name}
            </option>
          ))}
        </select>
      </div>
      {status.devices.length === 0 && (
        <div className="meta" style={{ marginTop: 6 }}>
          {status.agentRunning ? 'Windows reports no microphones.' : 'The list comes from the agent, which is not running.'}
        </div>
      )}

      {(testing || status.heard.length > 0) && <TestReadout status={status} />}
    </div>
  );
}

/**
 * What the microphone heard during a test, as it happens.
 *
 * Nothing here is acted on — the agent reports instead of ticking off, and the
 * server refuses these reports outside a test window. Checking whether voice
 * works should not quietly log four glasses of water.
 */
function TestReadout({ status }: { status: VoiceStatusType }) {
  const events = status.heard;

  return (
    <div className="diagnostics" style={{ marginTop: 10 }}>
      <div className="meta">
        {status.testing
          ? 'Say your wake word, then a phrase. Nothing you say during a test is recorded against a habit.'
          : status.testSucceeded
            ? 'That worked, so the test stopped there — nothing was recorded against a habit.'
            : 'Test finished.'}
      </div>

      {status.testing && events.length === 0 && (
        <div className="meta" style={{ marginTop: 8 }}>
          Listening…
        </div>
      )}

      {events.map((event, index) => (
        <div className="row between" key={`${event.at}-${index}`} style={{ marginTop: 8 }}>
          <span className="meta">
            {event.kind === 'wake' ? (
              <span className="ok-text">heard the wake word</span>
            ) : event.kind === 'speech' ? (
              // Two recognisers run during a test and finish independently, so
              // this one arriving first proves nothing about the wake word.
              // Saying "but not the wake word" over a transcript containing it
              // was simply false, and sent you looking for the wrong problem.
              event.matchedWake ? (
                <>
                  heard "{event.text}" <span className="ok-text">— wake word in there</span>
                </>
              ) : (
                <>heard "{event.text}" — no wake word yet</>
              )
            ) : event.text ? (
              <>said "{event.text}"</>
            ) : (
              <span className="urgent">woke, but caught no words</span>
            )}
          </span>
          <span className="meta">
            {event.speakerScore !== null && `voice match ${Math.round(event.speakerScore * 100)}%`}
            {event.kind === 'command' &&
              (event.wouldMatch ? ` → would tick off ${event.wouldMatch.habitName}` : event.text ? ' → no habit matches' : '')}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Every phrase currently wired up, across all habits.
 *
 * The phrases are edited on the Habits screen, next to the habit they belong
 * to. But "what can I actually say?" is a question about voice, not about any
 * one habit, and answering it used to mean opening every habit in turn.
 */
/**
 * Type a sentence and see which habit it would tick off.
 *
 * The failure everyone hits with this kind of matching is a phrase that reads
 * perfectly and never matches. The alternative way to discover that is saying
 * it at the microphone over and over while watching a log, so this exists.
 */
function PhraseTester() {
  const [text, setText] = useState('');
  const [result, setResult] = useState<VoiceTest | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    if (!text.trim()) return;
    setBusy(true);
    try {
      setResult(await api.voice.test(text.trim()));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="title">Try a phrase</div>
      <div className="meta" style={{ marginTop: 4 }}>
        Checks what a sentence would do, without doing it.
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <div className="grow">
          <input
            value={text}
            placeholder="I drank two waters"
            aria-label="Phrase to test"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void run()}
          />
        </div>
        <button className="btn" disabled={busy || !text.trim()} onClick={() => void run()}>
          Test
        </button>
      </div>

      {result && (
        <div className="meta" style={{ marginTop: 10 }}>
          {result.chain?.length ? (
            <>
              <span className="ok-text">Would do {result.chain.length} things, in order:</span>
              <ol style={{ margin: '6px 0 0', paddingLeft: 20 }}>
                {result.chain.map((step, index) => (
                  <li key={`${step.phrase}-${index}`}>
                    <strong>{step.habitName}</strong>
                    {step.count > 1 ? ` ${step.count} times` : ''} — matched "{step.phrase}"
                  </li>
                ))}
              </ol>
            </>
          ) : result.match ? (
            <>
              <span className="ok-text">
                Would tick off <strong>{result.match.habitName}</strong>
                {result.count > 1 ? ` ${result.count} times` : ''}
              </span>{' '}
              — matched "{result.match.phrase}".
            </>
          ) : (
            <>
              {/* Not "it would be saved as a note" — that stopped being true when
                  the overlay made a miss visible as it happens, and unmatched
                  speech started being dropped instead of filed. */}
              <span className="meta urgent">Nothing matches.</span> It would be dropped, and the popup
              would say so. Heard words: {result.tokens.join(', ') || '(none)'}.
            </>
          )}
        </div>
      )}
    </div>
  );
}
