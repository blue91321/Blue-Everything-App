/**
 * Speech, through sherpa-onnx: a keyword spotter for the wake word, a streaming
 * recogniser for the command, and a speaker model for "only my voice".
 *
 * This replaced Vosk, and the reason is the wake word. Vosk could only listen
 * for one by running a general recogniser in a *closed grammar* — a list of two
 * words and `[unk]` — and a closed grammar has to answer every sound with
 * something it contains. So "harvest festival" came back as "hey jarvis", a dog
 * called Harley woke it, and the defence was a list of decoy words you filled in
 * by hand. A keyword spotter is the right tool: it is asked "was this phrase
 * said", it can say no, and it says so while the sentence is still going.
 * Measured on the same audio: no false wakes on any of the chatter, the wake
 * word caught 1.1s into a run-together sentence, and 11ms of CPU per second of
 * sound.
 *
 * It keeps the property that made Vosk worth its cost: **the wake word is a
 * runtime string.** The spotter takes its keywords as text at construction —
 * see `wake-tokens.ts` for the one wrinkle in that — so the box on the Voice tab
 * still works without training anything.
 *
 * The command side is an open-vocabulary recogniser, which Vosk's grammar never
 * was. It hears "I drank two waters" as exactly that, so the generated word
 * forms the grammar needed to be able to say "drank" are no longer what decides
 * whether a sentence can be understood.
 *
 * ### Three models, three lifetimes
 *
 * | | loaded | why |
 * | --- | --- | --- |
 * | spotter (~50MB) | while voice is on | it is what listens |
 * | command (~140MB) | on wake, in a worker; dropped after 10 min unused | it is needed for seconds at a time |
 * | speaker (~25MB) | on first use | only to check a wake word or enrol |
 *
 * The command model is most of the cost, and it is only needed between a wake
 * word and the end of a sentence. Keeping it resident for the whole day would
 * be the 200MB this project already apologises for; loading it per utterance
 * would put 1.4s in front of every command. Ten minutes is the user's choice
 * between the two: the first command of a session pays the load, a run of them
 * does not.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { SAMPLE_RATE } from './mic.js';
import { voiceModelPaths } from './voice-paths.js';
import { keywordLines, loadPieces, type Pieces } from './wake-tokens.js';

export class VoiceUnavailable extends Error {}

/* ------------------------------------------------------------------ */
/* The binding                                                         */
/* ------------------------------------------------------------------ */

interface Wave {
  samples: Float32Array;
  sampleRate: number;
}
interface Stream {
  acceptWaveform(wave: Wave): void;
  inputFinished(): void;
}
interface KeywordResult {
  keyword: string;
  /** Seconds, per token, from the start of the stream. */
  timestamps: number[];
  start_time?: number;
}
interface Spotter {
  createStream(): Stream;
  isReady(stream: Stream): boolean;
  decode(stream: Stream): void;
  getResult(stream: Stream): KeywordResult;
}
interface Extractor {
  dim: number;
  createStream(): Stream;
  compute(stream: Stream): Float32Array;
}
interface Sherpa {
  KeywordSpotter: new (config: object) => Spotter;
  SpeakerEmbeddingExtractor: new (config: object) => Extractor;
}

const require = createRequire(import.meta.url);
let sherpa: Sherpa | null = null;

function binding(): Sherpa {
  if (sherpa) return sherpa;
  try {
    sherpa = require('sherpa-onnx-node') as Sherpa;
  } catch (error) {
    throw new VoiceUnavailable(`the speech library would not load: ${(error as Error).message}`);
  }
  return sherpa;
}

/** Every file the wake word and the command need. The speaker model is optional. */
export function missingModels(): string[] {
  const paths = voiceModelPaths();
  const wanted = [
    paths.wake.encoder,
    paths.wake.decoder,
    paths.wake.joiner,
    paths.wake.tokens,
    paths.wake.bpe,
    paths.command.encoder,
    paths.command.decoder,
    paths.command.joiner,
    paths.command.tokens,
  ];
  return wanted.filter((file) => !existsSync(file));
}

export function speakerModelAvailable(): boolean {
  return existsSync(voiceModelPaths().speaker);
}

/** The microphone's 16-bit samples as the floats the models want. */
export function toFloat(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] / 32768;
  return out;
}

/* ------------------------------------------------------------------ */
/* The wake word                                                       */
/* ------------------------------------------------------------------ */

let pieces: Pieces | null = null;

/**
 * A keyword, and where it sits in what has been fed.
 *
 * Positions are counted back from the end in samples, because the listener's
 * replay buffer ends at the same instant the spotter's stream does — so "this
 * many samples ago" means the same moment in both.
 */
export interface WakeHit {
  /** Which phrase, as it was given. */
  phrase: string;
  /** The keyword's start, with a little lead. */
  startsAgo: number;
  /** The keyword's end, with a little tail. The speaker sample is between the two. */
  endsAgo: number;
  /**
   * The keyword's last token. A token is stamped where its sound *begins*, so
   * every word of the wake word begins before this, and the first word of the
   * command after it — which is how the command's transcript is told apart
   * from the wake word's.
   */
  lastTokenAgo: number;
}

export interface WakeSpotter {
  accept(samples: Float32Array): WakeHit | null;
  /** Start a new stream. At every utterance boundary, so state never piles up. */
  restart(): void;
}

/**
 * How far past a keyword's last token the word actually ends.
 *
 * A token's timestamp is the frame it was emitted on, which is the start of its
 * sound: the `S` of "jarvis" is stamped at 0.80s and is still being said for a
 * while after. Without this the replay starts mid-hiss and the command arrives
 * prefixed with a fragment of the wake word.
 */
const KEYWORD_TAIL_S = 0.2;
/** And how far before its first token it starts, for the speaker sample. */
const KEYWORD_LEAD_S = 0.15;

/**
 * Listen for these phrases. Any of them is a hit; which one is in the result.
 *
 * Every phrase becomes a keyword, decoys included. A decoy here is not what it
 * was for Vosk — the spotter does not have to put a sound *somewhere* — but a
 * decoy that sounds like the wake word still competes for the same audio, and
 * one that wins is a hit the listener ignores, which is exactly the job.
 */
export function createWakeSpotter(phrases: string[]): WakeSpotter {
  const sherpa = binding();
  const paths = voiceModelPaths();
  pieces ??= loadPieces(paths.wake.bpe);

  const keywords = keywordLines(phrases, pieces);
  let spotter: Spotter;
  try {
    spotter = new sherpa.KeywordSpotter({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: paths.wake.encoder, decoder: paths.wake.decoder, joiner: paths.wake.joiner },
        tokens: paths.wake.tokens,
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
      },
      keywordsBuf: keywords,
      keywordsBufSize: Buffer.byteLength(keywords),
      keywordsScore: Number(process.env.EVERYTHING_WAKE_SCORE ?? 1.0),
      keywordsThreshold: Number(process.env.EVERYTHING_WAKE_THRESHOLD ?? 0.25),
    });
  } catch (error) {
    throw new VoiceUnavailable(`the wake word spotter would not load: ${(error as Error).message}`);
  }

  // Names in the keyword file have underscores for spaces; this undoes it.
  const byName = new Map(phrases.map((p) => [p.trim().toLowerCase().replace(/\s+/g, '_'), p.trim().toLowerCase()]));

  let stream = spotter.createStream();
  let fed = 0;
  const restart = (): void => {
    stream = spotter.createStream();
    fed = 0;
  };

  return {
    accept(samples: Float32Array): WakeHit | null {
      stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
      fed += samples.length;

      while (spotter.isReady(stream)) {
        spotter.decode(stream);
        const result = spotter.getResult(stream);
        if (!result.keyword) continue;

        const base = result.start_time ?? 0;
        const first = (result.timestamps[0] ?? 0) + base;
        const last = (result.timestamps.at(-1) ?? 0) + base;
        const at = (seconds: number) => Math.min(fed, Math.max(0, Math.round(seconds * SAMPLE_RATE)));
        const hit: WakeHit = {
          phrase: byName.get(result.keyword) ?? result.keyword.replace(/_/g, ' ').toLowerCase(),
          startsAgo: fed - at(first - KEYWORD_LEAD_S),
          endsAgo: fed - at(last + KEYWORD_TAIL_S),
          lastTokenAgo: fed - at(last),
        };

        restart();
        return hit;
      }
      return null;
    },

    restart,
  };
}

/* ------------------------------------------------------------------ */
/* Who is speaking                                                     */
/* ------------------------------------------------------------------ */

let extractor: Extractor | null = null;

/**
 * A speaker embedding for these samples, or null without the model.
 *
 * Loaded on first use, not with the spotter: nothing needs it until a wake word
 * is heard, and an install that never enrols never pays for it.
 */
export function speakerEmbedding(samples: Float32Array): number[] | null {
  if (!speakerModelAvailable() || samples.length === 0) return null;
  if (!extractor) {
    try {
      extractor = new (binding().SpeakerEmbeddingExtractor)({ model: voiceModelPaths().speaker, numThreads: 1, debug: 0 });
    } catch {
      return null;
    }
  }
  const stream = extractor.createStream();
  stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
  stream.inputFinished();
  return Array.from(extractor.compute(stream));
}

/* ------------------------------------------------------------------ */
/* The command                                                         */
/* ------------------------------------------------------------------ */

const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty',
];

/**
 * What the recogniser wrote, as the matcher reads it.
 *
 * It writes like a person types — "Hey, Jarvis, I drank 2 waters." — with
 * capitals, commas and digits. The matcher, the wake-word check and `spokenCount`
 * all expect lower-case words, and "2" is not a word any of them knows, so small
 * numbers are spelled back out. Larger ones are left as digits: no command
 * counts to forty, and spelling them would be guessing at "twenty one" versus
 * "twenty-one".
 */
export function cleanTranscript(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (/^\d+$/.test(word) && Number(word) < NUMBER_WORDS.length ? NUMBER_WORDS[Number(word)] : word))
    .join(' ');
}

/**
 * Words in a phrase that the recogniser will never write.
 *
 * Under a closed grammar this was the model's lexicon — "unmute" was missing
 * from it, and a phrase containing it could never fire. An open vocabulary has
 * no such list, so what is left is spelling: the transcript is letters and
 * apostrophes once cleaned, so a phrase with a digit or a symbol in it can never
 * be matched. "drink 2 water" is heard as "drink two water".
 */
export function unknownWords(words: string[]): string[] {
  return words.filter((word) => {
    const clean = word.trim().toLowerCase();
    return clean.length > 0 && /[^a-z']/.test(clean);
  });
}

export interface CommandRecogniser {
  /** True once the model has loaded. Audio sent before then waits, in order. */
  readonly ready: boolean;
  /** When it became ready, or 0. The command window does not run before this. */
  readonly readyAt: number;
  /** The latest guess for the utterance in progress, cleaned. */
  readonly partial: string;
  /** When it was last fed. The idle unload counts from this. */
  readonly lastUsed: number;
  feed(samples: Float32Array): void;
  /**
   * Forget the utterance in progress. Anything already sent for it is ignored.
   *
   * `skipUntil` is a time in seconds from now on the new stream's clock: words
   * the recogniser says *started* before it are dropped. The listener feeds the
   * whole sentence, wake word included, and uses this to take the wake word back
   * out — by when it was said, so a wake word the recogniser misheard as "hey
   * travis" goes as surely as one it heard right.
   */
  reset(skipUntil?: number): void;
  close(): void;
}

export interface CommandEvents {
  final(text: string): void;
  error(message: string): void;
  ready?(ms: number): void;
}

export function createCommandRecogniser(events: CommandEvents): CommandRecogniser {
  const paths = voiceModelPaths();
  const worker = new Worker(new URL('./command-worker.mjs', import.meta.url), {
    workerData: { model: paths.command },
    // Not this process's flags: the worker is plain JavaScript and needs no
    // loader, and `--import tsx` would be one more thing between it and running.
    execArgv: [],
  });
  worker.unref();

  let ready = false;
  let readyAt = 0;
  let gen = 0;
  let skipUntil = 0;
  let partial = '';
  const kept = (words: Array<{ text: string; at: number }> = []) =>
    cleanTranscript(words.filter((word) => word.at >= skipUntil).map((word) => word.text).join(' '));
  let lastUsed = Date.now();
  let closed = false;

  worker.on('message', (message: {
    type: string;
    gen?: number;
    words?: Array<{ text: string; at: number }>;
    ms?: number;
    message?: string;
  }) => {
    if (message.type === 'ready') {
      ready = true;
      readyAt = Date.now();
      events.ready?.(message.ms ?? 0);
    } else if (message.type === 'error') {
      events.error(message.message ?? 'the command recogniser failed');
    } else if (message.gen === gen) {
      // Anything from an earlier generation is the tail of an exchange that has
      // already been settled, and acting on it would answer a question twice.
      if (message.type === 'partial') partial = kept(message.words);
      else if (message.type === 'final') {
        partial = '';
        events.final(kept(message.words));
      }
    }
  });
  worker.on('error', (error: Error) => events.error(error.message));
  worker.on('exit', () => {
    if (!closed) events.error('the command recogniser stopped');
    closed = true;
  });

  return {
    get ready() {
      return ready;
    },
    get readyAt() {
      return readyAt;
    },
    get partial() {
      return partial;
    },
    get lastUsed() {
      return lastUsed;
    },
    feed(samples: Float32Array): void {
      if (closed) return;
      lastUsed = Date.now();
      // Transferred rather than copied: the caller made this array for the
      // purpose and does not touch it again.
      worker.postMessage({ type: 'audio', gen, samples }, [samples.buffer as ArrayBuffer]);
    },
    reset(skip = 0): void {
      if (closed) return;
      gen++;
      skipUntil = skip;
      partial = '';
      worker.postMessage({ type: 'reset', gen });
    },
    close(): void {
      if (closed) return;
      closed = true;
      void worker.terminate();
    },
  };
}

/**
 * Let go of the models held on this thread.
 *
 * The binding has no free; they are returned when collected. `global.gc` is
 * there only when the process was started with `--expose-gc`, and without it
 * the collector gets to them on its own schedule — measured, a drop plus a
 * forced collection took 180MB to 68MB, and waiting does get there, later.
 */
export function disposeEngine(): void {
  extractor = null;
  (globalThis as { gc?: () => void }).gc?.();
}
