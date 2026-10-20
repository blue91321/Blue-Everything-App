/**
 * Where the voice models live, and where they come from.
 *
 * Resolved from this file's own location, never the working directory — the
 * same rule the database and the migrations folder follow, and for the same
 * reason: Task Scheduler starts the agent in `C:\Windows\System32`, where a
 * relative path would silently find nothing and report the models as missing on
 * a machine where they are installed fine.
 *
 * `models/` is gitignored. These are ~100MB of third-party binaries, fetched by
 * `models.ts` the first time voice is switched on, and they have no business in
 * a git history.
 *
 * They sit *inside* this feature folder rather than at the package root, so
 * that deleting the voice feature reclaims the disk they take with it.
 *
 * **The file names are short on purpose.** Windows refuses a path longer than
 * 260 characters, and onnxruntime reports it as the file not existing — so the
 * upstream names (`encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx`), under a
 * checkout in a OneDrive folder with spaces in it, made a model that was plainly
 * on disk unloadable. Found in the spike, where the model "did not exist" from
 * one folder and loaded from another.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const featureRoot = dirname(fileURLToPath(import.meta.url));

export interface Transducer {
  dir: string;
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
}

export interface VoicePaths {
  root: string;
  /** The keyword spotter — the wake word. Always loaded while voice is on. */
  wake: Transducer & { bpe: string };
  /** The streaming recogniser — the command. Loaded on wake, in a worker. */
  command: Transducer;
  /** Speaker embeddings, for "only respond to my voice". */
  speaker: string;
}

function transducer(dir: string): Transducer {
  return {
    dir,
    encoder: resolve(dir, 'encoder.onnx'),
    decoder: resolve(dir, 'decoder.onnx'),
    joiner: resolve(dir, 'joiner.onnx'),
    tokens: resolve(dir, 'tokens.txt'),
  };
}

export function voiceModelPaths(): VoicePaths {
  const root = process.env.EVERYTHING_VOICE_DIR ?? resolve(featureRoot, 'models');
  const wake = transducer(resolve(root, 'wake'));

  return {
    root,
    wake: { ...wake, bpe: resolve(wake.dir, 'bpe.model') },
    command: transducer(resolve(root, 'command')),
    speaker: resolve(root, 'speaker.onnx'),
  };
}

const RELEASES = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';

/**
 * What is fetched, from where, and which file inside each archive becomes which
 * short name.
 *
 * The versions are the ones that were measured, and they are pinned for that
 * reason: a different keyword model is a different false-wake rate, and the
 * numbers in CLAUDE.md are about these.
 */
export const VOICE_DOWNLOADS = [
  {
    what: 'the wake word spotter (gigaspeech, 3.3M)',
    url: `${RELEASES}/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2`,
    bytes: 17_626_723,
    into: 'wake',
    /*
     * The int8 copies. 5MB against 14MB for the full ones, and the false-wake
     * and hit numbers were measured on these.
     */
    files: {
      'encoder.onnx': 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
      'decoder.onnx': 'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
      'joiner.onnx': 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
      'tokens.txt': 'tokens.txt',
      'bpe.model': 'bpe.model',
    },
  },
  {
    what: 'the command recogniser (kroko, English)',
    url: `${RELEASES}/asr-models/sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06.tar.bz2`,
    bytes: 57_267_600,
    into: 'command',
    files: {
      'encoder.onnx': 'encoder.onnx',
      'decoder.onnx': 'decoder.onnx',
      'joiner.onnx': 'joiner.onnx',
      'tokens.txt': 'tokens.txt',
    },
  },
  {
    what: 'the speaker model (3D-Speaker ERes2Net)',
    // "recongition" is the release tag's own spelling.
    url: `${RELEASES}/speaker-recongition-models/3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx`,
    bytes: 26_485_263,
    into: null,
    files: { 'speaker.onnx': null },
  },
] as const;

/** What Vosk left behind. Removed once the models above are in place. */
export const OLD_VOSK_FILES = [
  'libvosk.dll',
  'libvosk.lib',
  'vosk_api.h',
  'libgcc_s_seh-1.dll',
  'libstdc++-6.dll',
  'libwinpthread-1.dll',
  'vosk-model-small-en-us-0.15',
  'vosk-model-spk-0.4',
];
