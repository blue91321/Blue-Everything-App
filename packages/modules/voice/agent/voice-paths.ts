/**
 * Where the voice models live.
 *
 * Resolved from this file's own location, never the working directory — the
 * same rule the database and the migrations folder follow, and for the same
 * reason: Task Scheduler starts the agent in `C:\Windows\System32`, where a
 * relative path would silently find nothing and report the models as missing on
 * a machine where they are installed fine.
 *
 * `models/` is gitignored. These are ~150MB of third-party binaries; they are
 * downloaded once by hand and have no business in a git history.
 *
 * They sit *inside* this feature folder rather than at the package root, so
 * that deleting the voice feature reclaims the disk they take with it. Losing
 * 150MB of models that nothing can load would be a poor reward for switching a
 * feature off.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const featureRoot = dirname(fileURLToPath(import.meta.url));

export interface VoicePaths {
  root: string;
  /** libvosk.dll, alongside the other DLLs from the same zip. */
  library: string;
  /** vosk-model-small-en-us-0.15 — the wake word and command recogniser. */
  speechModel: string;
  /** vosk-model-spk-0.4 — speaker embeddings, for "only respond to my voice". */
  speakerModel: string;
}

export function voiceModelPaths(): VoicePaths {
  const root = process.env.EVERYTHING_VOICE_DIR ?? resolve(featureRoot, 'models');

  return {
    root,
    library: resolve(root, 'libvosk.dll'),
    speechModel: resolve(root, 'vosk-model-small-en-us-0.15'),
    speakerModel: resolve(root, 'vosk-model-spk-0.4'),
  };
}

/** What to download, and where to put it. Printed by the setup CLI on failure. */
export const VOICE_DOWNLOADS = [
  {
    what: 'libvosk.dll (and the DLLs beside it)',
    url: 'https://github.com/alphacep/vosk-api/releases/download/v0.3.45/vosk-win64-0.3.45.zip',
    unpackTo: 'the files from inside the zip, directly into models/',
    size: '~30MB',
  },
  {
    what: 'vosk-model-small-en-us-0.15',
    url: 'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip',
    unpackTo: 'models/vosk-model-small-en-us-0.15/ (keep the folder name)',
    size: '~40MB',
  },
  {
    what: 'vosk-model-spk-0.4',
    url: 'https://alphacephei.com/vosk/models/vosk-model-spk-0.4.zip',
    unpackTo: 'models/vosk-model-spk-0.4/ (keep the folder name)',
    size: '~13MB',
  },
] as const;
