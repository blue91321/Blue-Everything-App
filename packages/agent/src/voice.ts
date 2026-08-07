/**
 * The always-on listener.
 *
 * ```
 *  microphone ──► RMS gate ──► wake recogniser ──► command recogniser
 *                  (silence           ("hey everything")      │
 *                   costs nothing)                            ▼
 *                                                     speaker check
 *                                                            │
 *                                              POST /api/voice/command
 * ```
 *
 * Three things here are load-bearing:
 *
 * **The RMS gate.** A silent room must not cost anything. Without it the speech
 * model runs on all 86,400 seconds of every day; with it, it runs only while
 * there is something audible, which on a quiet desk is a small fraction of that.
 * This is the difference between voice being affordable on a machine whose
 * whole agent idles at 0.002% of a core and it not being.
 *
 * **Two recognisers, not one.** The wake recogniser knows two or three words and
 * nothing else, so it is cheap enough to run continuously and rarely fires by
 * accident. Only once it fires does the command recogniser — which knows every
 * word in every habit phrase — get fed anything. Running the wide vocabulary
 * continuously would be both slower and far more likely to hallucinate a habit
 * out of background conversation.
 *
 * **Audio never leaves this process.** The server receives a transcript and a
 * similarity score. There is no endpoint that takes a recording, nothing is
 * written to disk, and nothing is logged but the text. An always-on microphone
 * is the most invasive thing in this app, so the blast radius is kept to the
 * one process that has to have it.
 */
import { EventEmitter } from 'node:events';
import {
  DEFAULT_WAKE_WORD,
  VOICE_COMMAND_TIMEOUT_MS,
  VOICE_ENROL_MIN_FRAMES,
  cosineSimilarity,
  matchesWakeWord,
} from '@everything/shared';
import { findMicrophone, listMicrophones, MicrophoneError, openMicrophone, rms, SAMPLE_RATE, type Microphone } from './mic.js';
import {
  createRecogniser,
  disposeVosk,
  speakerModelAvailable,
  VoskUnavailable,
  type Recogniser,
  type Utterance,
} from './vosk.js';

export interface VoiceConfig {
  enabled: boolean;
  wakeWord: string;
  requireKnownSpeaker: boolean;
  speakerThreshold: number;
  voiceprint: number[] | null;
  vocabulary: string[];
  /** The literal phrase words, for the can-this-be-heard check. */
  checkWords?: string[];
  version: string;
  /** Device name to listen on; null follows the Windows default. */
  inputDevice?: string | null;
  /** Where the popup goes, and what face it wears. Passed straight through. */
  overlayPlacement?: string;
  overlayScreen?: string | null;
  overlayAvatar?: string;
  avatarVersion?: number;
  /** While in the future, report what is heard instead of acting on it. */
  testUntil?: number;
  /** While in the future, collect wake-word samples instead of obeying them. */
  enrolUntil?: number;
  /** How long to reopen after a miss. Read by index.ts, not used here. */
  retryMs?: number;
  /** How long to keep listening after answering. 0 switches follow-ups off. */
  followUpMs?: number;
}

/** What the listener can say about itself, for the Voice screen. */
export interface VoiceStatus {
  listening: boolean;
  device: string | null;
  devices: { id: number; name: string }[];
  error: string | null;
  /** Loudest level since this was last read; reading it resets the peak. */
  peak: number;
}

export interface VoiceHeard {
  text: string;
  speakerScore: number | null;
  accepted: boolean;
  reason?: 'wrong-speaker' | 'no-speaker-sample';
}

/**
 * Loud enough to be worth running speech recognition on.
 *
 * Measured on this machine: a quiet room reads ~0.002, ordinary speech peaks
 * around 0.05. The original 0.012 was a guess made before those numbers
 * existed, and it sat close enough to a soft or trailed-off delivery to clip
 * the *start* of it — which is the worst place to lose audio, because the wake
 * word is what comes first.
 *
 * 0.006 is still three times the noise floor, so a silent room costs nothing,
 * but it no longer needs a confident voice to open the gate. A little wasted
 * recognition on a door closing is much cheaper than a missed wake word.
 */
const SPEECH_FLOOR = 0.006;

/**
 * Keep feeding the recogniser for a moment after things go quiet.
 *
 * Cutting at the first quiet block would clip the end off every phrase, because
 * speech dips to near silence between words — the same reason `audio.ts`
 * remembers sound for two minutes rather than sampling it instantaneously.
 */
const HANGOVER_MS = 700;

/** How often the buffers are drained. Matches the mic's ~100ms buffer size. */
const POLL_MS = 100;

/**
 * How much recent audio to keep so the command can be recovered.
 *
 * The wake recogniser only reports a result once Vosk decides the *utterance*
 * ended — not once the wake word did. Say "hey jarvis I drank water" in one
 * breath and the whole sentence goes into the wake recogniser, which returns
 * "hey jarvis" (the rest being `[unk]`) only after you stop talking. The
 * command had already been consumed and thrown away, so a fluent speaker got
 * silence and a halting one got a result. Replaying this buffer into the
 * command recogniser is what makes run-together speech work.
 *
 * Four seconds covers a wake word plus a comfortably long command. At 16kHz
 * mono this is 128KB, which is not worth being clever about.
 */
const REPLAY_BUFFER_SAMPLES = SAMPLE_RATE * 4;

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
   * answered, it is still Blake's turn, and making him say "hey jarvis" again
   * to add a second thing would be the whole point missed.
   *
   * The duration is passed in rather than read from config because it differs
   * by situation — a retry after a miss is not the same wait as a follow-up
   * after a hit, and only the caller knows which just happened.
   */
  listenAgain(ms: number): void;
  /**
   * Abandon the sentence in progress and go back to waiting for the wake word.
   *
   * Not the same as stopping: the microphone stays open and the wake word works
   * immediately. "Never mind" should not cost the next five minutes of voice.
   */
  cancelExchange(): void;
  /** When the running listening test ends, or 0. Drives the report cadence. */
  readonly testingUntil: number;
  /** When the running enrolment ends, or 0. Also drives the report cadence. */
  readonly enrolUntil: number;
  readonly stats: { blocks: number; gated: number; recognised: number; wakes: number };
}

type Phase = 'idle' | 'awake';

export function createVoiceListener(post: (heard: VoiceHeard) => void): VoiceListener {
  const emitter = new EventEmitter() as VoiceListener;

  let config: VoiceConfig | null = null;
  let mic: Microphone | null = null;
  let wake: Recogniser | null = null;
  let command: Recogniser | null = null;
  let timer: NodeJS.Timeout | null = null;

  let phase: Phase = 'idle';
  let wokeAt = 0;
  let lastLoudAt = 0;
  let builtFor = '';

  /** Reported to the server, and reset each time it is read. */
  let peak = 0;
  let openDevice: string | null = null;
  let lastError: string | null = null;
  /** Device name that was asked for but isn't plugged in. */
  let openedFor: string | null | undefined;

  /**
   * Whether the open microphone is a follow-up rather than a fresh wake.
   *
   * They wait for different lengths: after the wake word the window is fixed —
   * you are part-way through one sentence — while after an answer it is however
   * long Blake set, because that is a choice about how conversational he wants
   * it to be.
   */
  let inFollowUp = false;
  /** How long the current follow-up lasts; set by `listenAgain`. */
  let followWindow = 0;

  const testing = (now = Date.now()) => (config?.testUntil ?? 0) > now;
  const enrolling = (now = Date.now()) => (config?.enrolUntil ?? 0) > now;

  /** Recent audio, so a command spoken without a pause can be recovered. */
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

  /**
   * Is there anything in this transcript besides the wake word?
   *
   * The replay deliberately includes the wake word audio, so the command
   * recogniser transcribes it too. Extra words are harmless to the matcher, but
   * a transcript of *only* the wake word is not a command — and delivering it
   * would file "jarvis" as a note every time Blake paused to think.
   */
  function hasCommand(text: string): boolean {
    const wakeWords = new Set((config?.wakeWord ?? '').toLowerCase().split(/\s+/).filter(Boolean));
    return text.split(/\s+/).some((word) => word && !wakeWords.has(word));
  }

  const stats = { blocks: 0, gated: 0, recognised: 0, wakes: 0 };
  Object.defineProperty(emitter, 'stats', { get: () => stats });
  Object.defineProperty(emitter, 'testingUntil', { get: () => config?.testUntil ?? 0 });
  Object.defineProperty(emitter, 'enrolUntil', { get: () => config?.enrolUntil ?? 0 });

  function teardownRecognisers(): void {
    wake?.close();
    command?.close();
    wake = null;
    command = null;
  }

  /**
   * Rebuild both recognisers for the current config.
   *
   * Only ever called when `version` changed, because loading a grammar is not
   * free and the settings payload is fetched on a timer.
   */
  function build(): void {
    if (!config) return;
    teardownRecognisers();

    const wakeWord = config.wakeWord || DEFAULT_WAKE_WORD;

    // The wake recogniser carries the speaker model, not the command one. The
    // wake word is the part reliably spoken at the microphone in a known
    // phrase, which makes it a far better speaker sample than a command that
    // might be two words long.
    wake = createRecogniser([wakeWord], { withSpeaker: true });

    // One space-joined string, not one entry per word — that is how a Vosk
    // grammar expresses "any sequence of these words". A list of separate
    // entries would mean "exactly one of these phrases", which would reject
    // "i drank two waters" for having a word in the wrong place.
    command = createRecogniser(config.vocabulary.length > 0 ? [config.vocabulary.join(' ')] : [wakeWord]);
    builtFor = config.version;
  }

  function ensureOpen(): void {
    // Reopen when the chosen device changes, not just when there's no mic at
    // all — otherwise picking a different microphone in Settings would appear
    // to work and keep listening to the old one until the agent restarted.
    if (mic && openedFor !== config?.inputDevice) {
      mic.close();
      mic = null;
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

    if (!wake || !command || builtFor !== config?.version) build();
  }

  function shutdown(): void {
    // Order matters: the recognisers hold pointers into the models, so freeing
    // the models first would leave them dangling.
    teardownRecognisers();
    mic?.close();
    mic = null;

    // Give the models back too. They are ~165MB — the overwhelming majority of
    // what voice costs — and keeping them resident for a feature that has been
    // switched off would make "off" a lie about everything except the
    // microphone. Reloading costs 0.2s, paid only when it is switched on again.
    disposeVosk();

    phase = 'idle';
    builtFor = '';
    openDevice = null;
    openedFor = undefined;
    peak = 0;
  }

  /** Compare against the enrolled voiceprint, if there is anything to compare. */
  function scoreSpeaker(embedding: number[] | null): number | null {
    if (!config?.voiceprint || !embedding) return null;
    return cosineSimilarity(embedding, config.voiceprint);
  }

  let lastSpeakerScore: number | null = null;

  function poll(): void {
    if (!config?.enabled) return;

    try {
      ensureOpen();
      lastError = null;
    } catch (error) {
      // Held for the status report rather than only logged: "the microphone is
      // in use by another application" is the answer to "why isn't it hearing
      // me", and it belongs on the screen asking that question.
      lastError = (error as Error).message;
      emitter.emit('error', error);
      // A missing model cannot fix itself, so stop rather than retrying at 10Hz
      // forever. A busy or unplugged microphone might, so keep trying.
      if (error instanceof VoskUnavailable) stop();
      return;
    }

    const samples = mic!.read();
    if (samples.length === 0) return;
    stats.blocks++;

    const now = Date.now();
    const level = rms(samples);
    if (level > peak) peak = level;
    if (level >= SPEECH_FLOOR) lastLoudAt = now;

    // The gate. In `idle` a quiet block is dropped before it reaches the model;
    // in `awake` everything is fed through, because the command has already
    // been asked for and clipping it would be worse than the cost.
    if (phase === 'idle' && now - lastLoudAt > HANGOVER_MS) {
      stats.gated++;
      // Silence this long is an utterance boundary, so anything still buffered
      // belongs to a sentence that is over. Without this the replay is a flat
      // four-second window: say something, get no reaction, say it again, and
      // both deliveries end up in the buffer and come back transcribed as one
      // utterance — "hey jarvis drink water hey jarvis drink water".
      if (replay.length > 0) forgetReplay();
      return;
    }
    stats.recognised++;

    if (phase === 'idle') {
      remember(samples);
      const heard = wake!.accept(samples);

      // During a test, run the wide recogniser alongside the wake one and
      // report whatever words come back. Without this a failed test shows a
      // twitching level meter and nothing else, which says "something is wrong"
      // but not which thing — and "it can't hear me" and "it hears me but not
      // the wake word" need opposite fixes. Only worth the second recogniser
      // for the 30 seconds a test runs.
      if (testing(now)) {
        const loose = command!.accept(samples);
        if (loose?.text && !heard) {
          emitter.emit('heard', {
            kind: 'speech',
            text: loose.text,
            speakerScore: null,
            peak: level,
            // The two recognisers endpoint independently, so this one finishing
            // first says nothing about whether the wake word was recognised.
            matchedWake: matchesWakeWord(loose.text, config.wakeWord),
          });
        }
      }

      if (!heard) return;

      // Grammar mode still returns `[unk]` for anything off-list, so this means
      // the wake word rather than merely "some speech happened". Leading
      // attention words are optional — see `wakeWordRequired`: "hey" is dropped
      // by the recogniser far more often than the name it precedes is.
      if (!matchesWakeWord(heard.text, config.wakeWord)) {
        // Vosk just decided a sentence ended and it was not for us, so nothing
        // buffered belongs to whatever comes next. This is a better boundary
        // than the RMS gate, which a close-talk headset can hold open through
        // breathing between sentences.
        forgetReplay();
        return;
      }

      stats.wakes++;

      /*
       * Enrolling: the wake word is a sample, not an instruction.
       *
       * Collected from the wake word rather than free speech on purpose — the
       * enrolled vectors and the ones compared against them at runtime then
       * come from the same words, at the same distance, on the same
       * microphone, which is what lets the threshold be strict.
       */
      if (enrolling(now)) {
        if (heard.speaker && heard.speakerFrames >= VOICE_ENROL_MIN_FRAMES) {
          emitter.emit('enrol-sample', { embedding: heard.speaker, frames: heard.speakerFrames });
        } else {
          emitter.emit('enrol-short', { frames: heard.speakerFrames });
        }
        wake!.reset();
        forgetReplay();
        return;
      }

      lastSpeakerScore = scoreSpeaker(heard.speaker);
      inFollowUp = false;
      phase = 'awake';
      wokeAt = now;
      command!.reset();
      emitter.emit('wake', { speakerScore: lastSpeakerScore });
      if (testing(now))
        emitter.emit('heard', { kind: 'wake', text: heard.text, speakerScore: lastSpeakerScore, peak: level, matchedWake: true });

      /*
       * Replay everything the wake recogniser just consumed.
       *
       * Vosk reports the wake word only once the whole utterance ends, so for
       * anyone who doesn't pause after it, the command has already gone by. The
       * buffer holds it; feeding it to the command recogniser is what lets
       * "hey jarvis I drank water" work said as one sentence.
       */
      let replayed: Utterance | null = null;
      for (const block of replay) replayed = command!.accept(block) ?? replayed;
      forgetReplay();

      // A completed result here means the sentence was already finished — the
      // run-together case. If it holds only the wake word, Blake paused after
      // it and is still to speak, so keep listening rather than filing "jarvis"
      // as a note.
      if (replayed?.text && hasCommand(replayed.text)) {
        phase = 'idle';
        wake!.reset();
        deliver(replayed.text, level);
      }
      return;
    }

    // Awake: everything now goes to the command recogniser until it finishes a
    // phrase or the window closes.
    const finished = command!.accept(samples);
    const window = inFollowUp ? followWindow : VOICE_COMMAND_TIMEOUT_MS;
    const timedOut = now - wokeAt > window;

    if (!finished && !timedOut) return;

    const utterance = finished ?? command!.flush();
    phase = 'idle';
    inFollowUp = false;
    wake!.reset();
    forgetReplay();

    // Same guard as the replay path: a transcript of nothing but the wake word
    // is someone who trailed off, not a command.
    if (utterance.text && !hasCommand(utterance.text)) {
      emitter.emit('missed');
      return;
    }

    if (!utterance.text) {
      emitter.emit('missed');
      if (testing(now)) {
        emitter.emit('heard', { kind: 'command', text: '', speakerScore: lastSpeakerScore, peak: level, matchedWake: false });
      }
      return;
    }

    // Anything that reaches here ends the exchange one way or another, so the
    // overlay is told to stop saying "listening" whatever the outcome is.
    emitter.emit('sleep');

    deliver(utterance.text, level);
  }

  function deliver(text: string, level = 0): void {
    if (!config) return;

    const score = lastSpeakerScore;

    // A test reports and stops. Ticking off real habits while someone is
    // checking whether the microphone works would be its own kind of bug — the
    // whole point is to see what *would* happen.
    if (testing()) {
      emitter.emit('heard', { kind: 'command', text, speakerScore: score, peak: level, matchedWake: false });
      return;
    }

    // Checked here as well as on the server. Locally it avoids a pointless
    // round trip for every television advert; on the server it is the check
    // that cannot be bypassed. Neither is redundant.
    if (config.requireKnownSpeaker && config.voiceprint) {
      if (score === null) {
        post({ text, speakerScore: null, accepted: false, reason: 'no-speaker-sample' });
        return;
      }
      if (score < config.speakerThreshold) {
        post({ text, speakerScore: score, accepted: false, reason: 'wrong-speaker' });
        return;
      }
    }

    post({ text, speakerScore: score, accepted: true });
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

  emitter.listenAgain = (ms: number): void => {
    if (!config?.enabled || !command || !wake) return;
    // 0 means the microphone closes when a command is done. A real choice, and
    // the conservative one — nothing stays open on stray speech.
    if (ms <= 0) return;
    inFollowUp = true;
    followWindow = ms;
    phase = 'awake';
    wokeAt = Date.now();
    // A follow-up is not a fresh wake, so the speaker score from the wake word
    // that started this exchange still stands — it is the same person talking.
    command.reset();
    wake.reset();
    forgetReplay();
  };

  emitter.cancelExchange = (): void => {
    phase = 'idle';
    inFollowUp = false;
    followWindow = 0;
    wake?.reset();
    command?.reset();
    forgetReplay();
  };

  emitter.status = (): VoiceStatus => {
    // The device list is read live rather than cached: the whole reason to show
    // it is that headsets get plugged in and unplugged, and a list captured at
    // startup would be the one thing guaranteed not to reflect that.
    let devices: { id: number; name: string }[] = [];
    try {
      devices = listMicrophones().map(({ id, name }) => ({ id, name }));
    } catch {
      // A machine with no audio stack at all. An empty list says that fine.
    }

    const reading = peak;
    peak = 0;

    return {
      listening: mic !== null && wake !== null,
      device: openDevice,
      devices,
      error: lastError,
      peak: reading,
    };
  };
  emitter.configure = (next: VoiceConfig) => {
    const wasEnabled = config?.enabled ?? false;
    config = next;

    if (!next.enabled) {
      // Release the microphone the moment it is switched off. Holding a device
      // open for a disabled feature is exactly the kind of thing that makes
      // people not trust it.
      if (wasEnabled) stop();
      return;
    }

    if (next.requireKnownSpeaker && !speakerModelAvailable()) {
      emitter.emit('error', new VoskUnavailable('the speaker model is missing, so "only my voice" cannot be enforced'));
    }

    start();
  };

  return emitter;
}
