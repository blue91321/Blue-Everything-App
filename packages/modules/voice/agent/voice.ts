/**
 * The always-on listener.
 *
 * ```
 *  microphone ──► RMS gate ──► wake spotter ──► command recogniser
 *                  (silence      ("hey jarvis")     (a worker thread,
 *                   costs nothing)                  loaded on wake)
 *                                                          │
 *                                                    speaker check
 *                                                          │
 *                                             POST /api/voice/command
 * ```
 *
 * Four things here are load-bearing:
 *
 * **The RMS gate.** A silent room must not cost anything. Without it the spotter
 * runs on all 86,400 seconds of every day; with it, it runs only while there is
 * something audible, which on a quiet desk is a small fraction of that.
 *
 * **Two models, not one.** The spotter is asked one question — was the wake
 * word said — so it is cheap enough to run continuously and can answer no. Only
 * once it says yes does the command recogniser, which can transcribe anything,
 * get fed audio. Running that one continuously would be both seven times the
 * memory and a transcript of every conversation in the room.
 *
 * **The spotter answers mid-sentence.** Vosk could only report the wake word
 * once the whole utterance ended, so "hey jarvis I drank water" said in one
 * breath went entirely into the wake recogniser and the command had to be dug
 * back out of a replay buffer. The spotter fires about a third of a second
 * after the word itself, so the command is still being spoken: what is replayed
 * now is only the fraction of a second since the keyword ended.
 *
 * **Audio never leaves this process.** The command recogniser runs on a worker
 * *thread*, not in another process, and the server receives a transcript and a
 * similarity score. There is no endpoint that takes a recording, nothing is
 * written to disk, and nothing is logged but the text.
 */
import { EventEmitter } from 'node:events';
import {
  DEFAULT_WAKE_WORD,
  VOICE_COMMAND_TIMEOUT_MS,
  VOICE_ENROL_MIN_FRAMES,
  cosineSimilarity,
  matchesWakeWord,
  voiceprintIsCurrent,
  wakeWordRequired,
} from '@everything/shared';
import { findMicrophone, listMicrophones, MicrophoneError, openMicrophone, rms, SAMPLE_RATE, type Microphone } from './mic.js';
import {
  createCommandRecogniser,
  createWakeSpotter,
  disposeEngine,
  speakerEmbedding,
  speakerModelAvailable,
  toFloat,
  VoiceUnavailable,
  type CommandRecogniser,
  type WakeHit,
  type WakeSpotter,
} from './engine.js';
import { downloadModels, modelsNeeded } from './models.js';

/**
 * Re-exported rather than declared here.
 *
 * `VoiceConfig` describes what `/api/voice/config` sends back, so it lives with
 * the HTTP client that fetches it. That is not tidiness: `client.ts` is core and
 * this folder is deletable, and core importing a type out of a folder that may
 * not exist is exactly the edge that makes "deletable" a lie.
 */
import type { VoiceConfig } from '../../../agent/src/client.js';

export type { VoiceConfig };

/** What the listener can say about itself, for the Voice screen. */
export interface VoiceStatus {
  listening: boolean;
  device: string | null;
  devices: { id: number; name: string }[];
  error: string | null;
  /** Fetching the models, in words, or null. */
  preparing: string | null;
  /** Loudest level since this was last read; reading it resets the peak. */
  peak: number;
}

export interface VoiceHeard {
  text: string;
  speakerScore: number | null;
  accepted: boolean;
  reason?: 'wrong-speaker' | 'no-speaker-sample';
  /** Started by the listen shortcut, not the wake word — the server needs to know. */
  manual?: boolean;
}

/**
 * Loud enough to be worth running speech recognition on.
 *
 * Measured on this machine: a quiet room reads ~0.002, ordinary speech peaks
 * around 0.05. 0.006 is three times the noise floor, so a silent room costs
 * nothing, but it does not need a confident voice to open the gate — clipping
 * the start of a soft delivery is the worst place to lose audio, because the
 * wake word is what comes first.
 */
const SPEECH_FLOOR = 0.006;

/**
 * Keep feeding for a moment after things go quiet.
 *
 * Speech dips to near silence between words, so cutting at the first quiet
 * block would clip the end off every phrase — and the spotter needs a few
 * frames *after* a keyword to be sure of it.
 */
const HANGOVER_MS = 700;

/** How often the buffers are drained. Matches the mic's ~100ms buffer size. */
const POLL_MS = 100;

/**
 * How much recent audio to keep.
 *
 * Two uses: the speaker sample, which is the keyword itself, and the start of
 * the command, which is whatever arrived between the keyword ending and the
 * spotter saying so. Both are well inside a second; four leaves room for a slow
 * speaker and costs 128KB.
 */
const REPLAY_BUFFER_SAMPLES = SAMPLE_RATE * 4;

/**
 * How long the command model is kept after it was last fed.
 *
 * Ten minutes, chosen over "for as long as voice is on": it is ~140MB, and
 * needed for a few seconds per command. A run of commands in one sitting pays
 * the 1.4s load once; a single "drink water" an hour pays it every time, which
 * is the trade.
 */
const COMMAND_IDLE_MS = 10 * 60_000;

/**
 * How long a pause after the wake word before the "go ahead" tone.
 *
 * The spotter fires while you may still be talking — "hey jarvis I drank water"
 * wakes it at "jarvis" — and a beep over the rest of the sentence is noise. So
 * the tone waits for a gap, and a sentence that finishes without one is
 * answered by the result tone alone, as the run-together case always was.
 */
const TONE_AFTER_QUIET_MS = 300;

/** Once a download has failed, how long before trying again. */
const DOWNLOAD_RETRY_MS = 10 * 60_000;

const megabytes = (bytes: number) => `${Math.round(bytes / 1_048_576)}MB`;

export interface VoiceListener extends EventEmitter {
  start(): void;
  stop(): void;
  /** Swap in new settings without dropping the microphone, if we can help it. */
  configure(config: VoiceConfig): void;
  /** Current state for the Voice screen. Reading it resets the peak meter. */
  status(): VoiceStatus;
  /**
   * Keep listening for one more command *without* the wake word, for `ms`.
   *
   * What makes the overlay a conversation rather than a receipt: having just
   * answered, it is still your turn.
   */
  listenAgain(ms: number): void;
  /**
   * Abandon the sentence in progress and go back to waiting for the wake word.
   * The microphone stays open; "never mind" should not cost the next five
   * minutes of voice.
   */
  cancelExchange(): void;
  /**
   * Start an exchange now, without the wake word — for the hotkey.
   *
   * Returns false when there is nothing to start: voice off, paused, or the
   * models not in place yet. The caller says so rather than the key doing
   * nothing.
   */
  listenNow(): boolean;
  /** When the running listening test ends, or 0. Drives the report cadence. */
  readonly testingUntil: number;
  /** When the running enrolment ends, or 0. Also drives the report cadence. */
  readonly enrolUntil: number;
  /** What is being downloaded, in words, or null. Also drives the report cadence. */
  readonly preparing: string | null;
  readonly stats: { blocks: number; gated: number; recognised: number; wakes: number };
}

type Phase = 'idle' | 'awake';

export interface ListenerOptions {
  /**
   * Where the audio comes from. Only the listening harness passes this — a
   * stand-in that plays synthesised speech, so the gate, the tone, the window
   * and the model's load on wake can be driven without anybody talking.
   */
  microphone?: () => Microphone;
}

export function createVoiceListener(post: (heard: VoiceHeard) => void, options: ListenerOptions = {}): VoiceListener {
  const emitter = new EventEmitter() as VoiceListener;

  let config: VoiceConfig | null = null;
  let mic: Microphone | null = null;
  let spotter: WakeSpotter | null = null;
  let command: CommandRecogniser | null = null;
  let timer: NodeJS.Timeout | null = null;

  let phase: Phase = 'idle';
  let wokeAt = 0;
  let lastLoudAt = 0;
  let lastLevel = 0;
  let builtFor = '';
  /** The wake word was heard and the "go ahead" tone has not played yet. */
  let toneDue = false;

  /** Reported to the server, and reset each time it is read. */
  let peak = 0;
  let openDevice: string | null = null;
  let lastError: string | null = null;
  /** Device name that was asked for, so a change reopens the microphone. */
  let openedFor: string | null | undefined;

  let preparing: string | null = null;
  let downloading = false;
  let downloadFailedAt = 0;

  /**
   * Whether the open microphone is a follow-up rather than a fresh wake. They
   * wait for different lengths: after the wake word the window is fixed, after
   * an answer it is however long you set.
   */
  let inFollowUp = false;
  /**
   * True while this exchange was started by the hotkey rather than by the wake
   * word. It exists to skip the speaker check — see `listenNow`.
   */
  let manual = false;
  /** How long the current follow-up lasts; set by `listenAgain`. */
  let followWindow = 0;

  const testing = (now = Date.now()) => (config?.testUntil ?? 0) > now;
  const enrolling = (now = Date.now()) => (config?.enrolUntil ?? 0) > now;

  /** Recent audio: the keyword for the speaker check, and the start of the command. */
  let replay: Int16Array[] = [];
  let replaySamples = 0;

  function remember(block: Int16Array): void {
    replay.push(block);
    replaySamples += block.length;
    while (replaySamples > REPLAY_BUFFER_SAMPLES && replay.length > 1) {
      replaySamples -= replay[0].length;
      replay.shift();
    }
  }

  function forgetReplay(): void {
    replay = [];
    replaySamples = 0;
  }

  /** `length` samples of the replay, ending `endsAgo` before its end. */
  function replaySlice(endsAgo: number, length: number): Int16Array {
    const all = new Int16Array(replaySamples);
    let at = 0;
    for (const block of replay) {
      all.set(block, at);
      at += block.length;
    }
    const end = Math.max(0, all.length - endsAgo);
    return all.subarray(Math.max(0, end - length), end);
  }

  /**
   * Everything after the wake word, when the transcript has one in it.
   *
   * The replay starts where the spotter said the keyword ended, so usually there
   * is nothing to strip. But a slow "jaaarvis" can run past that estimate, and
   * the recogniser then writes the tail of it at the front of the command.
   */
  function afterWake(text: string): string {
    const words = text.split(/\s+/).filter(Boolean);
    const names = new Set(wakeWordRequired(config?.wakeWord || DEFAULT_WAKE_WORD));
    let cut = -1;
    words.forEach((word, i) => {
      if (names.has(word)) cut = i;
    });
    return words.slice(cut + 1).join(' ');
  }

  /**
   * Is there anything in this transcript besides the wake word?
   *
   * A transcript of only the wake word — or of nothing, which is what the
   * recogniser reports after a long enough silence — is you pausing to think,
   * and delivering it would answer a question nobody had asked yet.
   */
  function hasCommand(text: string): boolean {
    const wakeWords = new Set((config?.wakeWord ?? '').toLowerCase().split(/\s+/).filter(Boolean));
    return text.split(/\s+/).some((word) => word && !wakeWords.has(word));
  }

  const stats = { blocks: 0, gated: 0, recognised: 0, wakes: 0 };
  Object.defineProperty(emitter, 'stats', { get: () => stats });
  Object.defineProperty(emitter, 'testingUntil', { get: () => config?.testUntil ?? 0 });
  Object.defineProperty(emitter, 'enrolUntil', { get: () => config?.enrolUntil ?? 0 });
  Object.defineProperty(emitter, 'preparing', { get: () => preparing });

  /**
   * The phrases the spotter listens for.
   *
   * The wake word as typed, and again without its leading attention words — "hey"
   * is short, unstressed and run into the next word, so "jarvis" alone has to
   * count — and the decoys, which a hit on is ignored.
   */
  function wakePhrases(): string[] {
    const wakeWord = (config?.wakeWord || DEFAULT_WAKE_WORD).toLowerCase().trim();
    const required = wakeWordRequired(wakeWord).join(' ');
    return [...new Set([wakeWord, required, ...(config?.wakeDecoys ?? [])].map((p) => p.trim().toLowerCase()).filter(Boolean))];
  }

  function isWake(phrase: string): boolean {
    return matchesWakeWord(phrase, config?.wakeWord || DEFAULT_WAKE_WORD);
  }

  /**
   * Rebuild the spotter when what it listens for changed — the wake word or the
   * decoys, and not `version`, which also moves with every command phrase. The
   * spotter knows nothing about phrases, and rebuilding it is half a second on
   * this thread.
   */
  function build(): void {
    if (!config) return;
    const phrases = wakePhrases();
    spotter = createWakeSpotter(phrases);
    builtFor = phrases.join('|');
  }

  /** The command recogniser, starting its load if it is not running. */
  function ensureCommand(): CommandRecogniser {
    if (command) return command;
    const started = Date.now();
    command = createCommandRecogniser({
      final: (text) => onFinal(text),
      error: (message) => {
        lastError = `the command recogniser failed: ${message}`;
        emitter.emit('error', new Error(lastError));
        command?.close();
        command = null;
        if (phase === 'awake') endExchange();
      },
      ready: (ms) => emitter.emit('command-ready', { ms, waitedMs: Date.now() - started }),
    });
    return command;
  }

  function dropCommand(): void {
    command?.close();
    command = null;
  }

  /**
   * Fetch the models if they are not here, and say so meanwhile.
   *
   * Returns true when there is nothing to wait for. A failure is held as the
   * error on the Voice screen and retried after `DOWNLOAD_RETRY_MS`, rather than
   * hammering GitHub ten times a second from a machine that is offline.
   */
  function modelsReady(now: number): boolean {
    if (spotter) return true;
    if (downloading) return false;
    if (!modelsNeeded()) return true;
    if (downloadFailedAt && now - downloadFailedAt < DOWNLOAD_RETRY_MS) return false;

    downloading = true;
    preparing = 'Downloading the speech models…';
    lastError = null;
    emitter.emit('preparing', preparing);
    downloadModels((progress) => {
      preparing = `Downloading ${progress.what} — ${megabytes(progress.done)} of ${megabytes(progress.total)}`;
    })
      .then(() => {
        downloadFailedAt = 0;
        emitter.emit('prepared');
      })
      .catch((error: Error) => {
        downloadFailedAt = Date.now();
        lastError = `Could not download the speech models: ${error.message}`;
        emitter.emit('error', new Error(lastError));
      })
      .finally(() => {
        downloading = false;
        preparing = null;
      });
    return false;
  }

  function ensureOpen(): void {
    // Reopen when the chosen device changes, not just when there's no mic at
    // all — otherwise picking a different microphone would appear to work and
    // keep listening to the old one until the agent restarted.
    if (mic && openedFor !== config?.inputDevice) {
      mic.close();
      mic = null;
    }

    if (!mic && options.microphone) {
      mic = options.microphone();
      openedFor = config?.inputDevice;
      openDevice = 'stand-in';
    }

    if (!mic) {
      const wanted = config?.inputDevice ?? null;
      const index = findMicrophone(wanted);
      if (index === null) {
        throw new MicrophoneError(`"${wanted}" isn't plugged in — pick another microphone on the Voice screen`);
      }

      mic = openMicrophone(index);
      openedFor = config?.inputDevice;
      openDevice = wanted ?? listMicrophones().find((d) => d.id === index)?.name ?? 'Windows default';
    }

    if (!spotter || builtFor !== wakePhrases().join('|')) build();
  }

  function shutdown(): void {
    mic?.close();
    mic = null;
    spotter = null;
    dropCommand();

    // Give the models back too. Keeping them resident for a feature that has
    // been switched off would make "off" a lie about everything except the
    // microphone.
    disposeEngine();

    phase = 'idle';
    toneDue = false;
    builtFor = '';
    openDevice = null;
    openedFor = undefined;
    peak = 0;
    forgetReplay();
  }

  /**
   * Compare against the enrolled voiceprint, if there is anything to compare.
   *
   * A voiceprint from the old speaker model is a different length and means
   * nothing to this one, so it is treated as absent rather than scored — a
   * cosine of zero against every voice would refuse every command.
   */
  function scoreSpeaker(hit: WakeHit): number | null {
    if (!config?.voiceprint || !voiceprintIsCurrent(config.voiceprint)) return null;
    const embedding = speakerEmbedding(toFloat(replaySlice(hit.endsAgo, hit.startsAgo - hit.endsAgo)));
    return embedding ? cosineSimilarity(embedding, config.voiceprint) : null;
  }

  let lastSpeakerScore: number | null = null;

  function poll(): void {
    if (!config?.enabled) return;
    const now = Date.now();

    if (!modelsReady(now)) return;

    try {
      ensureOpen();
      lastError = null;
    } catch (error) {
      // Held for the status report rather than only logged: "the microphone is
      // in use by another application" is the answer to "why isn't it hearing
      // me", and it belongs on the screen asking that question.
      lastError = (error as Error).message;
      emitter.emit('error', error);
      // A model that will not load cannot fix itself, so stop rather than
      // retrying at 10Hz forever. A busy or unplugged microphone might.
      if (error instanceof VoiceUnavailable) stop();
      return;
    }

    // The command model goes back once it has sat unused for long enough.
    if (command && phase === 'idle' && !testing(now) && now - command.lastUsed > COMMAND_IDLE_MS) {
      dropCommand();
      disposeEngine();
      emitter.emit('command-unloaded');
    }

    const samples = mic!.read();
    if (samples.length === 0) return;
    stats.blocks++;

    const level = rms(samples);
    lastLevel = level;
    if (level > peak) peak = level;
    if (level >= SPEECH_FLOOR) lastLoudAt = now;

    if (phase === 'awake') {
      awake(samples, now);
      return;
    }

    // The gate. A quiet block is dropped before it reaches a model.
    if (now - lastLoudAt > HANGOVER_MS) {
      stats.gated++;
      // Silence this long is an utterance boundary: nothing buffered belongs to
      // whatever is said next, and a fresh stream keeps the spotter's state
      // from piling up across a day.
      if (replay.length > 0) {
        spotter!.restart();
        forgetReplay();
        // A test's transcript ends on 0.8s of silence, and the gate stops
        // feeding after 0.7s — so it is handed a second of it, or the last thing
        // said would sit unreported until somebody spoke again.
        if (testing(now) && command) command.feed(new Float32Array(SAMPLE_RATE));
      }
      return;
    }
    stats.recognised++;

    remember(samples);
    const audio = toFloat(samples);
    const hit = spotter!.accept(audio);

    /*
     * During a test, run the command recogniser alongside and report whatever
     * words come back. Without this a failed test shows a twitching level meter
     * and nothing else — and "it can't hear me" and "it hears me but not the
     * wake word" need opposite fixes. The words arrive through `onFinal`.
     */
    if (testing(now) && !hit) ensureCommand().feed(audio);

    if (hit) wakeHeard(hit, now, level);
  }

  /** Awake: everything goes to the command recogniser until it answers or the window shuts. */
  function awake(samples: Int16Array, now: number): void {
    const recogniser = ensureCommand();
    recogniser.feed(toFloat(samples));

    /*
     * The tone, if you paused. Still talking a moment after the keyword means
     * the command is coming in the same breath, and that sentence gets the
     * result tone alone — the run-together case never had a gap to acknowledge.
     * The 200ms is the spotter's own lag: it answers a beat after the word, and
     * the end of "jarvis" can still be loud in the first block after the hit.
     */
    if (toneDue && lastLoudAt > wokeAt + 200) toneDue = false;
    if (toneDue && now - lastLoudAt >= TONE_AFTER_QUIET_MS) {
      toneDue = false;
      emitter.emit('listening');
    }

    /*
     * The window runs from when the recogniser could hear, not from the wake.
     * The first command of a session waits 1.4s for the model to load, and
     * whatever was said meanwhile is queued for it, not lost — so charging that
     * second and a half to your window would time out commands that had been
     * said perfectly well.
     */
    if (!recogniser.ready) return;
    const window = inFollowUp ? followWindow : VOICE_COMMAND_TIMEOUT_MS;
    if (now - Math.max(wokeAt, recogniser.readyAt) <= window) return;

    // The window is up. Whatever it was in the middle of hearing is the answer.
    const said = afterWake(recogniser.partial);
    if (said && hasCommand(said)) {
      finish(said);
      return;
    }

    endExchange();
    emitter.emit('missed');
    if (testing(now)) {
      emitter.emit('heard', { kind: 'command', text: '', speakerScore: lastSpeakerScore, peak: lastLevel, matchedWake: false });
    }
  }

  /** The recogniser finished an utterance. */
  function onFinal(text: string): void {
    if (phase !== 'awake') {
      // Only fed while idle during a test: report it, and that is all.
      if (testing() && text) {
        emitter.emit('heard', {
          kind: 'speech',
          text,
          speakerScore: null,
          peak: lastLevel,
          matchedWake: isWake(text),
        });
      }
      return;
    }

    /*
     * Nothing but the wake word, or nothing at all, and the window is still open
     * — you have not started the command yet. Keep listening; `awake` reports
     * the miss once the window is genuinely up, which is when it is true.
     */
    const said = afterWake(text);
    if (!hasCommand(said)) return;
    finish(said);
  }

  function endExchange(): void {
    phase = 'idle';
    inFollowUp = false;
    toneDue = false;
    spotter?.restart();
    command?.reset();
    forgetReplay();
  }

  function finish(text: string): void {
    endExchange();
    // Anything that reaches here ends the exchange one way or another, so the
    // overlay is told to stop saying "listening" whatever the outcome is.
    emitter.emit('sleep');
    deliver(text, lastLevel);
  }

  /** The spotter heard one of its phrases. */
  function wakeHeard(hit: WakeHit, now: number, level: number): void {
    // A decoy: it was there to absorb the sound, and it did.
    if (!isWake(hit.phrase)) {
      forgetReplay();
      return;
    }

    /*
     * Enrolling: the wake word is a sample, not an instruction.
     *
     * Collected from the wake word rather than free speech on purpose — the
     * enrolled vectors and the ones compared against them at runtime then come
     * from the same words, at the same distance, on the same microphone, which
     * is what lets the threshold be strict.
     */
    if (enrolling(now)) {
      const length = hit.startsAgo - hit.endsAgo;
      const frames = Math.round(length / (SAMPLE_RATE / 100));
      const embedding = frames >= VOICE_ENROL_MIN_FRAMES ? speakerEmbedding(toFloat(replaySlice(hit.endsAgo, length))) : null;
      if (embedding) emitter.emit('enrol-sample', { embedding, frames });
      else emitter.emit('enrol-short', { frames });
      forgetReplay();
      return;
    }

    const speakerScore = scoreSpeaker(hit);
    stats.wakes++;
    lastSpeakerScore = speakerScore;
    inFollowUp = false;
    // A wake word carries its own evidence, so whatever started the last
    // exchange does not carry over.
    manual = false;
    phase = 'awake';
    wokeAt = now;
    toneDue = true;

    /*
     * The whole sentence so far goes to the recogniser, wake word included, and
     * the wake word is then taken back out by time.
     *
     * Cutting the *audio* at the keyword was tried first and it mangles the next
     * word whichever way the cut is tuned: 0.2s past the last token gave "rank
     * two waters", none gave "gip this track", and 0.1s early gave "strike
     * water". A word cut in half is a different word. A word the recogniser
     * heard whole and was told to ignore is simply gone.
     *
     * 0.1s past the last token: both models stamp a token where its sound
     * begins, and they disagree by a fraction of that, while the gap before the
     * next word is longer even said fast.
     */
    const recogniser = ensureCommand();
    const lastToken = Math.max(0, replaySamples - hit.lastTokenAgo);
    recogniser.reset(lastToken / SAMPLE_RATE + 0.1);

    emitter.emit('wake', { speakerScore });
    if (testing(now)) {
      emitter.emit('heard', { kind: 'wake', text: hit.phrase, speakerScore, peak: level, matchedWake: true });
    }

    recogniser.feed(toFloat(replaySlice(0, replaySamples)));
    forgetReplay();
  }

  function deliver(text: string, level = 0): void {
    if (!config) return;

    const score = lastSpeakerScore;

    // A test reports and stops. Ticking off real habits while someone is
    // checking whether the microphone works would be its own kind of bug.
    if (testing()) {
      emitter.emit('heard', { kind: 'command', text, speakerScore: score, peak: level, matchedWake: false });
      return;
    }

    /*
     * Checked here as well as on the server. Locally it avoids a pointless
     * round trip for every television advert; on the server it is the check
     * that cannot be bypassed.
     *
     * **The hotkey is the check.** `requireKnownSpeaker` is a filter against the
     * *room*, and nothing in the room can press a key on this keyboard. And a
     * stale voiceprint is not enforced at all — see `voiceprintIsCurrent`.
     */
    if (config.requireKnownSpeaker && voiceprintIsCurrent(config.voiceprint) && !manual) {
      if (score === null) {
        post({ text, speakerScore: null, accepted: false, reason: 'no-speaker-sample' });
        return;
      }
      if (score < config.speakerThreshold) {
        post({ text, speakerScore: score, accepted: false, reason: 'wrong-speaker' });
        return;
      }
    }

    post({ text, speakerScore: score, accepted: true, manual });
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(poll, POLL_MS);
    timer.unref();
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
    shutdown();
  }

  emitter.start = start;
  emitter.stop = stop;

  /**
   * Begin an exchange because a key was pressed, not because a word was heard.
   *
   * Not `listenAgain`: that reopens a follow-up, inheriting the wake word's
   * speaker score and the follow-up window. This is a fresh exchange with no
   * wake word behind it, so it gets the ordinary timeout and its own reason for
   * being trusted. The replay is dropped: whatever was said in the moment before
   * you reached for the keyboard is not the command.
   */
  emitter.listenNow = (): boolean => {
    if (!config?.enabled || !spotter) return false;

    stats.wakes++;
    lastSpeakerScore = null;
    inFollowUp = false;
    manual = true;
    phase = 'awake';
    wokeAt = Date.now();
    toneDue = false;
    ensureCommand().reset();
    forgetReplay();

    // Nobody is mid-sentence after pressing a key, so the tone is now.
    emitter.emit('wake', { speakerScore: null });
    emitter.emit('listening');
    return true;
  };

  emitter.listenAgain = (ms: number): void => {
    if (!config?.enabled || !spotter) return;
    // 0 means the microphone closes when a command is done.
    if (ms <= 0) return;
    inFollowUp = true;
    followWindow = ms;
    phase = 'awake';
    wokeAt = Date.now();
    toneDue = false;
    // A follow-up is not a fresh wake, so the speaker score from the wake word
    // that started this exchange still stands — it is the same person talking.
    ensureCommand().reset();
    forgetReplay();
  };

  emitter.cancelExchange = (): void => {
    endExchange();
    followWindow = 0;
  };

  emitter.status = (): VoiceStatus => {
    // Read live: the reason to show it is that headsets get plugged in and
    // unplugged, and a list captured at startup would not reflect that.
    let devices: { id: number; name: string }[] = [];
    try {
      devices = listMicrophones().map(({ id, name }) => ({ id, name }));
    } catch {
      // A machine with no audio stack at all. An empty list says that fine.
    }

    const reading = peak;
    peak = 0;

    return {
      listening: mic !== null && spotter !== null,
      device: openDevice,
      devices,
      error: lastError,
      preparing,
      peak: reading,
    };
  };

  emitter.configure = (next: VoiceConfig) => {
    const wasEnabled = config?.enabled ?? false;
    config = next;

    if (!next.enabled) {
      // Release the microphone the moment it is switched off.
      if (wasEnabled) stop();
      return;
    }

    if (next.requireKnownSpeaker && !speakerModelAvailable() && !modelsNeeded()) {
      emitter.emit('error', new VoiceUnavailable('the speaker model is missing, so "only my voice" cannot be enforced'));
    }

    start();
  };

  return emitter;
}
