/**
 * Speech recognition and speaker identification, from one DLL.
 *
 * Vosk was chosen over the alternatives for a specific reason: it does both
 * jobs. The same `libvosk.dll` that recognises the wake word also produces a
 * 128-dimension speaker embedding for whatever it just heard, which is what
 * "only respond to my voice" needs. The obvious alternative — an ONNX speaker
 * model — meant `onnxruntime-node`, a ~150MB native dependency, on top of a
 * separate wake-word engine. This is one library and two model folders.
 *
 * It is bound through koffi rather than the `vosk` npm package, because that
 * package is built on `ffi-napi`, which does not build on Node 24. The C API is
 * about eight functions, so binding it directly costs less than fighting that.
 *
 * ### Grammar mode is what makes an always-on microphone affordable
 *
 * `vosk_recognizer_new_grm` restricts recognition to a fixed list of phrases.
 * The vocabulary is a few dozen words instead of 200,000, which is both
 * dramatically cheaper per second of audio and dramatically more accurate — and
 * critically, the list is a *runtime string*. That is the whole reason the wake
 * word can be edited in a text box: a trained wake-word model would have to be
 * rebuilt to change it.
 */
import { existsSync } from 'node:fs';
import koffi from 'koffi';
import { SAMPLE_RATE } from './mic.js';
import { voiceModelPaths } from './voice-paths.js';

let lib: ReturnType<typeof koffi.load> | null = null;

/* The C API. Handles are opaque pointers; results are borrowed `const char *`
 * owned by the recogniser, valid until the next call on it. */
interface VoskApi {
  setLogLevel: (level: number) => void;
  modelNew: (path: string) => unknown;
  modelFree: (model: unknown) => void;
  findWord: (model: unknown, word: string) => number;
  spkModelNew: (path: string) => unknown;
  spkModelFree: (model: unknown) => void;
  recognizerNew: (model: unknown, rate: number) => unknown;
  recognizerNewGrm: (model: unknown, rate: number, grammar: string) => unknown;
  setSpkModel: (recognizer: unknown, spkModel: unknown) => void;
  acceptWaveform: (recognizer: unknown, data: unknown, length: number) => number;
  result: (recognizer: unknown) => string;
  partialResult: (recognizer: unknown) => string;
  finalResult: (recognizer: unknown) => string;
  reset: (recognizer: unknown) => void;
  recognizerFree: (recognizer: unknown) => void;
}

let api: VoskApi | null = null;

export class VoskUnavailable extends Error {}

function load(): VoskApi {
  if (api) return api;

  const paths = voiceModelPaths();
  if (!existsSync(paths.library)) {
    throw new VoskUnavailable(
      `libvosk.dll not found at ${paths.library} — run: npm run voice-setup -w @everything/agent`
    );
  }

  try {
    lib = koffi.load(paths.library);
  } catch (error) {
    throw new VoskUnavailable(`could not load ${paths.library}: ${(error as Error).message}`);
  }

  api = {
    setLogLevel: lib.func('void vosk_set_log_level(int level)'),
    modelNew: lib.func('void *vosk_model_new(const char *path)'),
    modelFree: lib.func('void vosk_model_free(void *model)'),
    findWord: lib.func('int vosk_model_find_word(void *model, const char *word)'),
    spkModelNew: lib.func('void *vosk_spk_model_new(const char *path)'),
    spkModelFree: lib.func('void vosk_spk_model_free(void *model)'),
    recognizerNew: lib.func('void *vosk_recognizer_new(void *model, float rate)'),
    recognizerNewGrm: lib.func('void *vosk_recognizer_new_grm(void *model, float rate, const char *grammar)'),
    setSpkModel: lib.func('void vosk_recognizer_set_spk_model(void *recognizer, void *spkModel)'),
    acceptWaveform: lib.func('int vosk_recognizer_accept_waveform(void *recognizer, const void *data, int length)'),
    result: lib.func('const char *vosk_recognizer_result(void *recognizer)'),
    partialResult: lib.func('const char *vosk_recognizer_partial_result(void *recognizer)'),
    finalResult: lib.func('const char *vosk_recognizer_final_result(void *recognizer)'),
    reset: lib.func('void vosk_recognizer_reset(void *recognizer)'),
    recognizerFree: lib.func('void vosk_recognizer_free(void *recognizer)'),
  };

  // Cuts Kaldi's startup chatter from hundreds of lines to about four. The
  // survivors are `Node ... is never used to compute any output` warnings
  // emitted during model load, which come out of Kaldi below the level this
  // controls. They are harmless and expected — the small model genuinely does
  // carry unused nodes — so they are left rather than papered over by
  // swallowing the library's stderr wholesale.
  api.setLogLevel(-1);
  return api;
}

/* ------------------------------------------------------------------ */
/* Models                                                              */
/* ------------------------------------------------------------------ */

let speechModel: unknown = null;
let speakerModel: unknown = null;

/**
 * Loaded once and held. The speech model is ~40MB on disk and takes a second or
 * two to load; reloading it per utterance would make the wake word useless.
 */
function models(): { speech: unknown; speaker: unknown | null } {
  const vosk = load();
  const paths = voiceModelPaths();

  if (!speechModel) {
    if (!existsSync(paths.speechModel)) {
      throw new VoskUnavailable(
        `speech model not found at ${paths.speechModel} — run: npm run voice-setup -w @everything/agent`
      );
    }
    speechModel = vosk.modelNew(paths.speechModel);
    if (!speechModel) throw new VoskUnavailable(`vosk could not load the speech model at ${paths.speechModel}`);
  }

  // The speaker model is optional: without it voice still works, it just can't
  // tell who is talking. That degradation is deliberate — a missing model
  // should not stop the feature, it should stop the speaker check.
  if (!speakerModel && existsSync(paths.speakerModel)) {
    speakerModel = vosk.spkModelNew(paths.speakerModel);
  }

  return { speech: speechModel, speaker: speakerModel };
}

/**
 * Which of these words the model has no pronunciation for.
 *
 * A grammar can only contain words in the model's lexicon; anything else Vosk
 * drops with a warning nobody reads, and the phrase then silently never
 * matches. "unmute" is the one that caught us out — a perfectly ordinary word
 * to a person, absent from a 2020 dictionary.
 *
 * This is the check that generalises: it stays useful whichever model is
 * installed, because it asks that model rather than assuming anything.
 */
export function unknownWords(words: string[]): string[] {
  const vosk = load();
  const { speech } = models();

  return words.filter((word) => {
    const clean = word.trim().toLowerCase();
    return clean.length > 0 && vosk.findWord(speech, clean) < 0;
  });
}

export function speakerModelAvailable(): boolean {
  return existsSync(voiceModelPaths().speakerModel);
}

/* ------------------------------------------------------------------ */
/* Recognisers                                                         */
/* ------------------------------------------------------------------ */

export interface Utterance {
  text: string;
  /** The speaker embedding, when the speaker model is loaded and enough was said. */
  speaker: number[] | null;
  /** Frames the embedding was computed over. Short ones are not worth trusting. */
  speakerFrames: number;
}

export interface Recogniser {
  /**
   * Feed samples. Returns a finished utterance when Vosk decides the speaker
   * stopped, or null while they're still going.
   */
  accept(samples: Int16Array): Utterance | null;
  /**
   * What it thinks it has heard *so far*, before deciding the speaker stopped.
   *
   * The difference matters more than it sounds. `accept` only answers once the
   * endpointer is satisfied, which means a fixed stretch of silence *after* you
   * finish — and that silence is paid twice, once to notice the wake word and
   * again to read the command. The partial is available while you are still
   * talking, which is what lets the popup appear when you say the wake word
   * rather than a second after you stop.
   *
   * Never a substitute for `accept` where the *text* has consequences: a
   * partial can be revised, and it carries no speaker embedding.
   */
  partial(): string;
  /** Force whatever is buffered to be finalised — used when a command times out. */
  flush(): Utterance;
  reset(): void;
  close(): void;
}

interface VoskResult {
  text?: string;
  partial?: string;
  spk?: number[];
  spk_frames?: number;
}

function parse(json: string): Utterance {
  let parsed: VoskResult;
  try {
    parsed = JSON.parse(json) as VoskResult;
  } catch {
    return { text: '', speaker: null, speakerFrames: 0 };
  }

  return {
    // `[unk]` is Vosk's "that was not in the grammar" token, and with a closed
    // grammar it is most of what comes back from ordinary speech — "i drank two
    // waters" arrives as "[unk] drink two water [unk]". Stripping it here rather
    // than downstream means an utterance made *entirely* of unknown words
    // reduces to the empty string, and empty already means "heard nothing" to
    // every caller. Leaving it in would have posted "[unk] [unk]" to the server
    // and filed it as a note.
    text: (parsed.text ?? '').replace(/\[unk\]/g, ' ').replace(/\s+/g, ' ').trim(),
    speaker: Array.isArray(parsed.spk) ? parsed.spk : null,
    speakerFrames: parsed.spk_frames ?? 0,
  };
}

/**
 * A recogniser restricted to `phrases`.
 *
 * `[unk]` must be in the list. Without it Vosk has no way to represent "that
 * wasn't any of these" and will force everything it hears onto the nearest
 * phrase — which for an always-on microphone means the wake word firing on
 * coughs, music, and half of every conversation.
 */
export function createRecogniser(phrases: string[], options: { withSpeaker?: boolean } = {}): Recogniser {
  const vosk = load();
  const { speech, speaker } = models();

  const grammar = JSON.stringify([...new Set(phrases.map((p) => p.toLowerCase().trim()).filter(Boolean)), '[unk]']);
  const recogniser = vosk.recognizerNewGrm(speech, SAMPLE_RATE, grammar);
  if (!recogniser) throw new VoskUnavailable('vosk could not create a recogniser');

  if (options.withSpeaker && speaker) vosk.setSpkModel(recogniser, speaker);

  let closed = false;

  return {
    accept(samples: Int16Array): Utterance | null {
      if (closed || samples.length === 0) return null;

      // Vosk wants the raw little-endian PCM bytes, which is exactly what backs
      // the Int16Array — so this is a view, not a conversion.
      const bytes = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
      const complete = vosk.acceptWaveform(recogniser, bytes, bytes.length);
      if (complete !== 1) return null;

      const utterance = parse(vosk.result(recogniser));
      return utterance.text ? utterance : null;
    },

    partial(): string {
      if (closed) return '';
      // `parse` reads `text`; a partial result carries `partial` instead, so it
      // is normalised here rather than teaching `parse` about both shapes.
      try {
        const { partial } = JSON.parse(vosk.partialResult(recogniser)) as VoskResult;
        return (partial ?? '').replace(/\[unk\]/g, ' ').replace(/\s+/g, ' ').trim();
      } catch {
        return '';
      }
    },

    flush(): Utterance {
      if (closed) return { text: '', speaker: null, speakerFrames: 0 };
      return parse(vosk.finalResult(recogniser));
    },

    reset(): void {
      if (!closed) vosk.reset(recogniser);
    },

    close(): void {
      if (closed) return;
      closed = true;
      vosk.recognizerFree(recogniser);
    },
  };
}

/** Release the models. Only needed on shutdown; they are held for the process life. */
export function disposeVosk(): void {
  if (!api) return;
  if (speakerModel) {
    api.spkModelFree(speakerModel);
    speakerModel = null;
  }
  if (speechModel) {
    api.modelFree(speechModel);
    speechModel = null;
  }
}
