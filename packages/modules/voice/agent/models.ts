/**
 * Fetching the voice models, the first time voice is switched on.
 *
 * Under Vosk this was a page of instructions — three zips, which folder each
 * unpacks into, and "keep the folder name" — printed by `voice-setup` for
 * somebody to follow by hand. That is the open-a-terminal friction the
 * double-clickable files in the repo root exist to remove, and switching voice
 * on is already the decision to have what it needs. So the agent fetches them,
 * the Voice screen shows how far it has got, and `voice-setup` calls the same
 * function.
 *
 * About 100MB, from the sherpa-onnx releases on GitHub, once. Each archive is
 * unpacked into a scratch folder and only the files named in `VOICE_DOWNLOADS`
 * are moved into place, under short names: a half-finished download leaves
 * nothing that looks installed, because a file only appears under its real name
 * once it is whole.
 */
import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { OLD_VOSK_FILES, VOICE_DOWNLOADS, voiceModelPaths } from './voice-paths.js';

export interface ModelProgress {
  /** Bytes so far, across every download still to do. */
  done: number;
  total: number;
  /** What is being fetched now, in words. */
  what: string;
}

function target(root: string, into: string | null, name: string): string {
  return into ? resolve(root, into, name) : resolve(root, name);
}

function needed(root: string) {
  return VOICE_DOWNLOADS.filter((item) =>
    Object.keys(item.files).some((name) => !existsSync(target(root, item.into, name)))
  );
}

export function modelsNeeded(): boolean {
  return needed(voiceModelPaths().root).length > 0;
}

/**
 * Windows' own tar, by path. A bare `tar` on a machine with Git Bash is GNU
 * tar, which reads the `C:` in a path as a host to connect to — the release
 * packaging found that out first.
 */
function tarCommand(): string {
  if (process.platform !== 'win32') return 'tar';
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
}

let running: Promise<void> | null = null;

/** Fetch whatever is missing. One run at a time, however many ask. */
export function downloadModels(onProgress: (progress: ModelProgress) => void = () => undefined): Promise<void> {
  running ??= fetchAll(onProgress).finally(() => {
    running = null;
  });
  return running;
}

async function fetchAll(onProgress: (progress: ModelProgress) => void): Promise<void> {
  const root = voiceModelPaths().root;
  const work = resolve(root, '.download');
  mkdirSync(work, { recursive: true });

  const todo = needed(root);
  const total = todo.reduce((sum, item) => sum + item.bytes, 0);
  let done = 0;

  for (const item of todo) {
    const file = join(work, basename(new URL(item.url).pathname));
    const response = await fetch(item.url);
    if (!response.ok || !response.body) {
      throw new Error(`could not download ${item.what}: ${response.status} ${response.statusText}`);
    }

    // Counted as it arrives, so the screen can show a number that moves.
    const counted = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>);
    counted.on('data', (chunk: Buffer) => {
      done += chunk.length;
      onProgress({ done, total, what: item.what });
    });
    await pipeline(counted, createWriteStream(`${file}.part`));
    renameSync(`${file}.part`, file);

    if (item.into === null) {
      // A bare model file: it already is the thing.
      for (const name of Object.keys(item.files)) renameSync(file, target(root, null, name));
      continue;
    }

    const unpacked = join(work, `unpacked-${item.into}`);
    rmSync(unpacked, { recursive: true, force: true });
    mkdirSync(unpacked, { recursive: true });
    const tar = spawnSync(tarCommand(), ['-xf', file, '-C', unpacked], { windowsHide: true });
    if (tar.status !== 0) {
      throw new Error(`could not unpack ${item.what}: ${tar.stderr?.toString().trim() || `tar exited ${tar.status}`}`);
    }

    // Every archive holds one folder named after itself.
    const inner = join(unpacked, basename(file).replace(/\.tar\.bz2$/, ''));
    const into = resolve(root, item.into);
    mkdirSync(into, { recursive: true });
    for (const [name, from] of Object.entries(item.files)) {
      const source = join(inner, from ?? name);
      if (!existsSync(source)) throw new Error(`${item.what} did not contain ${from ?? name}`);
      renameSync(source, join(into, name));
    }

    rmSync(unpacked, { recursive: true, force: true });
    rmSync(file, { force: true });
  }

  rmSync(work, { recursive: true, force: true });
  removeOldVosk();
}

/**
 * Take Vosk's files away once the new models are in.
 *
 * They are ~150MB that nothing loads any more, in a folder of models this
 * feature downloaded in the first place — leaving them would make switching
 * engines cost the disk twice. Only the names Vosk used, and only after the new
 * set is whole, so a failed download never leaves a machine with neither.
 */
export function removeOldVosk(): string[] {
  const root = voiceModelPaths().root;
  if (needed(root).length > 0) return [];
  const removed: string[] = [];
  for (const name of OLD_VOSK_FILES) {
    const path = resolve(root, name);
    if (!existsSync(path)) continue;
    try {
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // A DLL a running agent still has mapped. The next start removes it.
    }
  }
  return removed;
}
