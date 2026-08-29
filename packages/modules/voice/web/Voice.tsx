import { useEffect, useState } from 'react';
import { api, serverSupportsVoice, type VoiceSettings, type VoiceStatus as VoiceStatusType, type VoiceTest } from '@app/api';
import { useAsync } from '@app/useAsync';
import { RestartBanner } from '@app/views/InstalledPackages';
import { Vocabulary } from './Vocabulary';
import { Toggle } from '@app/controls';
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
        </div>
        {/*
          The button rather than the two file names it used to print. Restarting
          is the fix, the app can do it, and `RestartBanner` already asks the
          server whether it can before offering — so the fallback for a machine
          that cannot is its problem rather than a second copy of it here.
        */}
        <RestartBanner why="The running server predates this screen." />
      </section>
    );
  }

  return <VoiceSettings settings={settings.data} local={local} reload={settings.reload} />;
}

/**
 * The three tabs.
 *
 * This screen grew from a switch and a text box into appearance, reminders,
 * shortcuts, enrolment, the vocabulary and every phrase you can say — one long
 * scroll in which whatever you came to change was always in the middle.
 *
 * The split is by *how often you touch it*, not by subject. **General** is what
 * you open the screen for: is it on, is it hearing me, which microphone, and
 * the wake word. Everything set once and left is behind **Settings**, and the
 * phrase list is long enough to deserve a tab of its own.
 *
 * Which tab is open is `useState`, like every other bit of navigation here.
 */
const VOICE_TABS = [
  { id: 'general', label: 'General', hint: 'Is it on, is it hearing you, and what wakes it' },
  { id: 'settings', label: 'Settings', hint: 'Shortcuts, the popup, and only responding to your voice' },
  { id: 'commands', label: 'Commands', hint: 'Everything you can say' },
] as const;

type VoiceTabId = (typeof VOICE_TABS)[number]['id'];

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
  const [tab, setTab] = useState<VoiceTabId>('general');
  const [draftDecoys, setDraftDecoys] = useState<string | null>(null);
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
  /**
   * Whether a miss reuses the answer timer.
   *
   * A stored flag, not `retry === followUp`: two settings that happen to hold
   * the same number is not the same statement as "keep these together", and
   * inferring it would tick the box by coincidence and then start dragging one
   * slider with the other. `quietHoursEnabled` is a real flag for exactly this
   * reason.
   */
  const sameTimer = Boolean(current.voiceRetryMatchesFollowUp);

  function commitRetry() {
    if (draftRetry === null || draftRetry === current.voiceRetrySeconds) return;
    void update({ voiceRetrySeconds: draftRetry }).then(() => setDraftRetry(null));
  }

  const decoys = draftDecoys ?? current.wakeDecoys ?? '';

  /*
   * A decoy the model cannot pronounce is dropped by Vosk without a word, which
   * is the same silent failure the wake word already has a warning for — so it
   * reuses the same list rather than growing a second mechanism.
   */
  const decoyUnknown = (look?.unknownWords ?? []).filter((word) =>
    (current.wakeDecoys ?? '')
      .toLowerCase()
      .split(/[,\s]+/)
      .includes(word)
  );
  return (
    <>
      <div className="tabs" role="tablist" aria-label="Voice sections">
        {VOICE_TABS.map((entry) => (
          <button
            key={entry.id}
            role="tab"
            className={`tab${tab === entry.id ? ' on' : ''}`}
            aria-selected={tab === entry.id}
            title={entry.hint}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === 'general' && (
      <section>
        <div className="card">
          <div className="row between">
            <div className="grow">
              <div className="title">Enable voice</div>
              <div className="meta">
                Say the wake word, then something like <em>"I drank water"</em>, and the matching habit gets
                ticked off. The microphone stays open while this is on — nothing is recorded, nothing leaves
                this PC, and speech is only processed while there's actually sound in the room.
              </div>
              {/*
                This one switch is the whole system, on every device: it is a
                server-side setting, so turning it off from the phone closes the
                microphone on the PC. Saying so matters because the status card
                below reports a *second* thing — whether the agent is running —
                and without this the two read as one confusing switch.
              */}
              <div className="meta" style={{ marginTop: 6 }}>
                Applies to this PC whichever device you set it from, and stays set until you change it.
              </div>
            </div>
            <Toggle
              on={Boolean(current.voiceEnabled)}
              disabled={saving}
              label="Enable voice"
              onChange={(on) => update({ voiceEnabled: on })}
            />
          </div>
        </div>

        <LiveStatus enabled={Boolean(current.voiceEnabled)} selectedDevice={current.voiceInputDevice ?? null} onPick={(device) => update({ voiceInputDevice: device })} saving={saving} />

        {/*
          The wake word is on this tab *as well as* Settings, and it is the same
          component rather than a second copy of the markup — the one thing that
          must not happen is the two drifting apart. It earns the duplication by
          being the setting people come here to change: everything else on this
          screen is set once and left, while a wake word that keeps mishearing
          gets tried three or four times in an evening.
        */}
        <WakeWordCard
          current={current}
          saving={saving}
          unknown={look?.unknownWords ?? []}
          update={update}
        />
      </section>
      )}

      {tab === 'settings' && (
      <section>
        {/*
          Here too. The General tab is the short version of this screen, so
          somebody who came to Settings for the decoys should not have to go back
          a tab to change the word those decoys are about.
        */}
        <WakeWordCard
          current={current}
          saving={saving}
          unknown={look?.unknownWords ?? []}
          update={update}
        />

        {/*
          The two things that work when the wake word does not — and one of them
          is how you switch voice on at all, which the microphone can never do
          for itself.
        */}
        <div className="card">
          <div className="title">Keyboard shortcuts</div>
          <div className="meta" style={{ marginTop: 4 }}>
            System-wide, so they work from inside a game. Neither is set by default: these take the
            combination away from every other program on this PC, which is not something to do to somebody
            who has not asked for it.
          </div>

          <HotkeyField
            label="Turn voice on and off"
            hint="Works while voice is off — that is the point of it. The microphone cannot hear you ask for it to be switched on."
            value={current.voiceToggleHotkey ?? ''}
            saving={saving}
            onSave={(value) => update({ voiceToggleHotkey: value })}
          />

          <HotkeyField
            label="Listen now, without the wake word"
            hint="Starts an exchange as though you had said it. More reliable than the wake word, because nothing has to be heard correctly first."
            value={current.voiceListenHotkey ?? ''}
            saving={saving}
            onSave={(value) => update({ voiceListenHotkey: value })}
          />

          {/*
            The speaker check does not apply to a hotkey, and saying so matters:
            somebody who switched "only my voice" on has a reasonable claim to
            know where it stops applying.
          */}
          {Boolean(current.requireKnownSpeaker) && (
            <div className="meta" style={{ marginTop: 8 }}>
              "Only respond to my voice" does not apply to the second one. It is a filter against the room —
              the television, someone else talking — and none of those can press a key on this keyboard.
            </div>
          )}
        </div>

        {/*
          Directly after the wake word, because it is only ever about the wake
          word — not about commands, which have their own tab and their own
          matcher.
        */}
        <div className="card">
          <div className="title">Words that keep waking it by mistake</div>
          <div className="meta" style={{ marginTop: 4 }}>
            The recogniser is only allowed to answer with the wake word or "not that", so anything close
            enough gets forced onto the wake word — a pet called Harley, a name, a phrase you say often.
            Listing the real word here gives it somewhere better to put that sound.
          </div>

          <div className="row" style={{ marginTop: 8, gap: '.4rem' }}>
            <div className="grow">
              <input
                value={decoys}
                aria-label="Words that are not the wake word"
                placeholder="harley, harvest, charlie"
                onChange={(event) => setDraftDecoys(event.target.value)}
              />
            </div>
            <button
              className="btn"
              disabled={saving || decoys.trim() === (current.wakeDecoys ?? '').trim()}
              onClick={() =>
                update({ wakeDecoys: decoys.trim().toLowerCase() }).then(() => setDraftDecoys(null))
              }
            >
              Save
            </button>
          </div>

          {decoyUnknown.length > 0 && (
            <div className="meta urgent" style={{ marginTop: 6 }}>
              ⚠ {decoyUnknown.map((w) => `"${w}"`).join(', ')} is not in the speech model's dictionary, so
              it cannot absorb anything. The same fix as for a wake word: two ordinary words beat one
              invented one.
            </div>
          )}

          <div className="meta" style={{ marginTop: 6 }}>
            {/*
              Said plainly, because the obvious reading of this box is "ignore
              these", and it is not that. A decoy is never matched against — it
              only ever competes for the sound.
            */}
            These are never treated as commands and can never trigger anything. They only compete for the
            sound. Separate them with commas.
          </div>
        </div>

        {/* Directly after the two cards about the grammar, because it is the
            same subject: what the recogniser is allowed to say. */}
        <Vocabulary unknown={look?.unknownWords ?? []} />

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

          {/*
            On the *follow-up* card rather than the retry one, because it is the
            follow-up time it copies — and because the card it governs is the one
            that disappears, which would be an odd place to keep its own switch.
          */}
          <label className="row" style={{ marginTop: 12, gap: '.5rem', alignItems: 'center', cursor: 'pointer' }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={sameTimer}
              disabled={saving}
              onChange={(event) => void update({ voiceRetryMatchesFollowUp: event.target.checked })}
            />
            <span className="meta">Use this after a miss too</span>
          </label>
          {sameTimer && (
            <div className="meta" style={{ marginTop: 4 }}>
              {followUp === 0
                ? 'A miss closes the microphone as well.'
                : `It waits ${followUp} second${followUp === 1 ? '' : 's'} after a miss as well as after an answer.`}
            </div>
          )}
        </div>

        {/*
          Hidden rather than disabled while the box is ticked. A disabled slider
          sitting at a number that is no longer the one in use would be a worse
          lie than not showing it — and the value behind it is untouched, so
          unticking brings the card back exactly where it was.
        */}
        {!sameTimer && (
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
        )}

      <VoiceLook settings={current} status={look} saving={saving} onChange={update} />

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
      )}

      {tab === 'commands' && (
      <section>
        <VoicePhrases />
        <PhraseTester />
      </section>
      )}

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
    ? {
        text: 'The agent is not running',
        tone: 'urgent',
        /*
         * This said "Start it with Blue Everything.cmd", which is accurate and
         * is exactly the friction the double-clickable files exist to remove:
         * an app that can tell you something is not running can start it. The
         * button is beside this line; the fallback text only appears when there
         * is genuinely no button to offer.
         */
        why: 'Nothing is listening — the part of the app that holds the microphone has stopped.',
      }
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
        {/*
          Start outranks both. While the agent is down, resuming and testing are
          requests to a process that is not there — so this is the only thing on
          the card worth offering, and it is the thing the screen was previously
          telling you to leave the app to do.
        */}
        {!status.agentRunning ? (
          <StartAgent onStarted={async () => setStatus(await api.voice.status())} />
        ) : /* Resume outranks Test: while paused there is nothing to test, and
              getting back to listening is the only thing worth offering. */
        enabled && status.paused ? (
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

      {/*
        A hotkey another program already owns registers as a failure and then
        does nothing at all — which is indistinguishable from one that was never
        saved. Windows will not say *which* program, so this says what to do
        rather than pretending to diagnose it.
      */}
      {(status.hotkeyProblems ?? []).map((problem) => (
        <div className="meta urgent" key={problem} style={{ marginTop: 8 }}>
          ⚠ {problem}
        </div>
      ))}

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

/**
 * "Start it", where the instructions to go and find a .cmd file used to be.
 *
 * It asks the server whether it *can* before offering, the same call the
 * Restart button makes — a button that fails when pressed is worse than one
 * that says why it cannot, and over Tailscale from the phone this genuinely
 * cannot: the agent runs on the PC, and only the PC may start it.
 *
 * The fallback names the file, because that is still the answer when the script
 * is missing or you are not at that machine — and a screen that reports a
 * stopped agent with no route forward at all is what this replaced.
 */
function StartAgent({ onStarted }: { onStarted: () => void }) {
  const can = useAsync(() => api.agent.canStart(), [], []);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  if (can.loading) return null;

  if (!can.data?.available) {
    return (
      <div className="meta" style={{ maxWidth: 260, textAlign: 'right' }}>
        {can.data?.local
          ? 'scripts/start.ps1 is missing — double-click Blue Everything.cmd instead.'
          : 'It runs on the PC, so only the PC can start it.'}
      </div>
    );
  }

  return (
    <div style={{ textAlign: 'right' }}>
      <button
        className="btn primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setProblem('');
          try {
            await api.agent.start();
            /*
             * The agent takes a few seconds to load, and its first heartbeat is
             * what actually proves it is up. The card already polls twice a
             * second, so the honest thing is to say it is starting and let that
             * poll be what changes the answer — rather than checking once,
             * finding it not up yet, and reporting a failure that is only
             * earliness.
             */
            setTimeout(onStarted, 3000);
          } catch (error) {
            setProblem((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Starting…' : 'Start it'}
      </button>
      {problem && (
        <div className="meta urgent" style={{ marginTop: 6, maxWidth: 260 }}>
          {problem}
        </div>
      )}
    </div>
  );
}

/**
 * One key combination, typed rather than captured.
 *
 * **Typed, deliberately.** A "press the keys now" capture box is the nicer
 * interaction right up against the thing this actually sets: a *system-wide*
 * hotkey, which means the capture box has to swallow combinations the browser
 * and Windows already own — ctrl+w closes the tab, alt+f4 closes the window, and
 * neither ever reaches a keydown handler. A text box has no such holes, and the
 * spelling is the same one a `hotkey` voice command already uses.
 *
 * Validated with the same rule the server applies, so an impossible combination
 * is refused here rather than round-tripping to a 400.
 */
function HotkeyField({
  label,
  hint,
  value,
  saving,
  onSave,
}: {
  label: string;
  hint: string;
  value: string;
  saving: boolean;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const current = draft ?? value;
  const trimmed = current.trim().toLowerCase();
  // Empty is a legitimate value — it is how you clear one — so it is not
  // "invalid", it is "none".
  const valid = trimmed === '' || looksLikeHotkey(trimmed);
  const dirty = trimmed !== value;

  /*
   * Recording listens on the window rather than on an input, and captures.
   *
   * On the *capture* phase and on `window` so nothing downstream has a chance to
   * act on the key first, and `preventDefault` so the page does not scroll on
   * space or tab away on tab.
   */
  useEffect(() => {
    if (!recording) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey) {
        setRecording(false);
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      const combo = comboFromEvent(event);
      // Null is a modifier on its own — still mid-press, so keep listening
      // rather than treating a held Ctrl as a failed attempt.
      if (!combo) return;

      setDraft(combo);
      setRecording(false);
    };

    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording]);

  return (
    <div style={{ marginTop: 12 }}>
      <div className="title" style={{ fontSize: '.95em' }}>
        {label}
      </div>
      <div className="meta" style={{ marginTop: 2 }}>
        {hint}
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <div className="grow">
          <input
            value={recording ? '' : current}
            placeholder={recording ? 'press the keys…' : 'ctrl+alt+numpad5'}
            aria-label={label}
            disabled={recording}
            onChange={(e) => setDraft(e.target.value)}
          />
        </div>
        <button
          className={recording ? 'btn' : 'btn subtle'}
          disabled={saving}
          onClick={() => setRecording(!recording)}
        >
          {recording ? 'Cancel' : 'Record'}
        </button>
        <button
          className="btn primary"
          disabled={saving || !valid || !dirty || recording}
          onClick={() => {
            onSave(trimmed);
            setDraft(null);
          }}
        >
          Save
        </button>
        {value !== '' && (
          <button
            className="btn subtle"
            disabled={saving || recording}
            onClick={() => {
              onSave('');
              setDraft(null);
            }}
          >
            Clear
          </button>
        )}
      </div>

      {recording ? (
        /*
          Said while recording rather than in the help text, because this is the
          moment somebody presses ctrl+w, loses the tab, and concludes the
          feature is broken. The browser never sees those: Windows and Chrome
          take them first, which is precisely why the box stays typeable.
        */
        <div className="meta" style={{ marginTop: 6 }}>
          Press the combination now. Escape cancels. Some are taken before the page sees them —
          <code>ctrl+w</code>, <code>alt+f4</code>, anything with the Windows key — so type those in
          instead; recording cannot capture what it is never shown.
        </div>
      ) : (
        <div className="meta" style={{ marginTop: 6 }}>
          <strong>modifier + key</strong>, joined by <code>+</code>. Modifiers are <code>ctrl</code>,{' '}
          <code>alt</code>, <code>shift</code> and <code>win</code>; keys are <code>a</code>–<code>z</code>,{' '}
          <code>0</code>–<code>9</code>, <code>f1</code>–<code>f12</code>, <code>numpad0</code>–
          <code>numpad9</code>, <code>numpadplus</code>, <code>numpadminus</code>,{' '}
          <code>numpadmultiply</code>, <code>numpaddivide</code>, <code>numpaddecimal</code>, the arrows
          (<code>up</code>, <code>down</code>, <code>left</code>, <code>right</code>) and{' '}
          <code>space</code>, <code>enter</code>, <code>tab</code>, <code>escape</code>,{' '}
          <code>backspace</code>, <code>delete</code>, <code>insert</code>, <code>home</code>,{' '}
          <code>end</code>, <code>pageup</code>, <code>pagedown</code>, <code>minus</code>,{' '}
          <code>plus</code>, <code>comma</code>, <code>period</code>.
        </div>
      )}

      {/*
        Worth saying next to the number pad rather than in a footnote: with Num
        Lock off the keyboard sends the navigation codes instead, so the hotkey
        simply stops answering and nothing on screen would explain why.
      */}
      {!recording && trimmed.includes('numpad') && (
        <div className="meta" style={{ marginTop: 6 }}>
          Number-pad keys follow Num Lock — with it off this will not answer.
        </div>
      )}

      {!valid && !recording && (
        <div className="meta urgent" style={{ marginTop: 6 }}>
          Needs at least one modifier and one key — <code>ctrl+alt+v</code>, <code>ctrl+alt+numpad5</code>.
          A bare key is refused on purpose: registered system-wide it would swallow that key everywhere.
        </div>
      )}
    </div>
  );
}

/**
 * The same shape `parseHotkey` accepts, checked again here.
 *
 * A second copy of the rule, and the reason is the one this file already lives
 * with: the PWA cannot import `@everything/shared` without pulling zod into a
 * bundle that is almost entirely framework. The server is the side that
 * enforces it — this only decides whether to grey out the Save button.
 */
const HOTKEY_MODIFIERS = ['ctrl', 'control', 'alt', 'shift', 'win', 'super', 'meta'];
const HOTKEY_KEYS = [
  ...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''),
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
  'space', 'enter', 'tab', 'escape', 'backspace', 'delete', 'insert', 'home', 'end',
  'pageup', 'pagedown', 'up', 'down', 'left', 'right', 'minus', 'plus', 'comma', 'period',
  ...Array.from({ length: 10 }, (_, i) => `numpad${i}`),
  'numpadplus', 'numpadminus', 'numpadmultiply', 'numpaddivide', 'numpaddecimal',
];

function looksLikeHotkey(value: string): boolean {
  const parts = value.split('+').map((p) => p.trim()).filter(Boolean);
  // At least one modifier, always. Registering a bare key takes it away from
  // every program on the machine.
  if (parts.length < 2) return false;
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);
  if (!HOTKEY_KEYS.includes(key)) return false;
  if (modifiers.some((m) => !HOTKEY_MODIFIERS.includes(m))) return false;
  return new Set(modifiers).size === modifiers.length;
}

/**
 * A browser key event in the spelling the rest of the app uses.
 *
 * Reads `event.code`, which is the *physical* key, rather than `event.key`,
 * which is what that key produces — the two differ exactly where it matters
 * here. `event.key` for the number pad is `"5"` whether you pressed the digit
 * row or the pad, and it is the empty-ish `"Dead"` or an accented letter under
 * some layouts; `code` says `Numpad5` or `Digit5` and says the same thing on
 * every layout, which is what a virtual-key code needs.
 */
function comboFromEvent(event: KeyboardEvent): string | null {
  const code = event.code;

  let key: string | null = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3).toLowerCase();
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-2])$/.test(code)) key = code.toLowerCase();
  else if (/^Numpad[0-9]$/.test(code)) key = code.toLowerCase();
  else {
    const named: Record<string, string> = {
      Space: 'space', Enter: 'enter', Tab: 'tab', Escape: 'escape',
      Backspace: 'backspace', Delete: 'delete', Insert: 'insert',
      Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
      ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
      Minus: 'minus', Equal: 'plus', Comma: 'comma', Period: 'period',
      NumpadAdd: 'numpadplus', NumpadSubtract: 'numpadminus',
      NumpadMultiply: 'numpadmultiply', NumpadDivide: 'numpaddivide',
      NumpadDecimal: 'numpaddecimal',
    };
    key = named[code] ?? null;
  }

  // A modifier on its own is not a combination yet — it is somebody still
  // reaching for the second key, so the recorder waits rather than refusing.
  if (!key) return null;

  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push('ctrl');
  if (event.altKey) modifiers.push('alt');
  if (event.shiftKey) modifiers.push('shift');
  if (event.metaKey) modifiers.push('win');
  if (modifiers.length === 0) return null;

  return [...modifiers, key].join('+');
}

/**
 * The wake word, on two tabs at once.
 *
 * A component rather than the markup twice, because the one thing that must not
 * happen is the copies drifting — the version that warns about a word the model
 * cannot pronounce is the whole reason this box is worth looking at, and a
 * second copy would be the one that quietly lost it.
 *
 * The draft lives here, so switching tabs mid-edit discards it rather than
 * carrying half a wake word to the other tab. That is the right loss: the two
 * boxes are the same setting, and a half-typed value showing up somewhere you
 * did not type it would be worse than starting again.
 */
function WakeWordCard({
  current,
  saving,
  unknown,
  update,
}: {
  current: VoiceSettings;
  saving: boolean;
  /** Words the speech model has no pronunciation for. */
  unknown: string[];
  update: (patch: Record<string, unknown>) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const wakeWord = draft ?? current.wakeWord;
  // One word is allowed. It is a worse choice, not an invalid one — and it is
  // the choice that survives the recogniser dropping half the phrase, so the
  // screen advises rather than refuses.
  const valid = /^[a-z]+(?: [a-z]+)*$/i.test(wakeWord.trim()) && wakeWord.trim().length >= 3;
  const advice = valid ? wakeWordAdvice(wakeWord) : null;
  /*
   * A wake word the model cannot pronounce is the worst version of this bug:
   * nothing wakes at all, and every other diagnostic on this screen looks fine.
   * Only checks the *saved* one, since that is what the agent was asked about.
   */
  const broken = unknown.filter((word) => current.wakeWord.toLowerCase().split(/\s+/).includes(word));

  return (
    <div className="card">
      <div className="title">Wake word</div>
      <div className="meta" style={{ marginTop: 4 }}>
        Pick something you would never say by accident. Two words are safer, but a leading "hey" or "ok"
        is optional when it's heard — so "hey jarvis" also answers to just "jarvis".
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <div className="grow">
          <input value={wakeWord} aria-label="Wake word" onChange={(e) => setDraft(e.target.value)} />
        </div>
        <button
          className="btn primary"
          disabled={saving || !valid || wakeWord.trim() === current.wakeWord}
          onClick={() => void update({ wakeWord: wakeWord.trim().toLowerCase() }).then(() => setDraft(null))}
        >
          Save
        </button>
      </div>
      {!valid && (
        <div className="meta urgent" style={{ marginTop: 6 }}>
          Letters and spaces only, three characters or more.
        </div>
      )}
      {advice && (
        <div className="meta urgent" style={{ marginTop: 6 }}>
          {advice}
        </div>
      )}
      {broken.length > 0 && (
        <div className="meta urgent" style={{ marginTop: 6 }}>
          ⚠ {broken.map((w) => `"${w}"`).join(', ')} is not in the speech model's dictionary, so this wake
          word can never be heard. Compounds and invented names are the usual cause — separating one into
          two ordinary words almost always fixes it.
        </div>
      )}
      <div className="meta" style={{ marginTop: 6 }}>
        Takes effect straight away — the status on General will say what it's listening for.
      </div>
    </div>
  );
}
