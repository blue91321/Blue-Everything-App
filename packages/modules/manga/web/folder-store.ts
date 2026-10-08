/**
 * Saving chapters into a folder you chose, instead of into the browser.
 *
 * ### Why this exists beside the browser's own storage
 *
 * Asked, in as many words: *"where is the download stored, I want to make sure
 * my browser isn't going to clear the cache and get rid of it"*. Cache Storage
 * is the honest default — it needs no permission and no picker — but it is the
 * browser's, and on a phone the browser is entitled to reclaim it. A folder is
 * yours: it survives clearing site data, you can see it in Files, copy it to a
 * drive, and open it with anything.
 *
 * **It is not the answer on the PC**, and the screen says so rather than
 * offering it twice. There the archive already writes ordinary folders from
 * the server, with no picker, no permission to re-grant, and no need for the
 * browser to be open at all. This is for the device in your hand.
 *
 * ### What is actually supported, measured rather than assumed
 *
 * `showDirectoryPicker` is desktop Chromium **and Android Chrome** — verified
 * on an Android 16 emulator running Chrome 133, where calling it without a tap
 * fails with *"Must be handling a user gesture to show a file picker"*, which
 * is an implementation refusing, not an absence. Safari has never shipped it,
 * so an iPhone keeps the browser storage and is told so plainly instead of
 * being shown a button that cannot work.
 *
 * ### The handle is the state, and it lives in IndexedDB
 *
 * A `FileSystemDirectoryHandle` is structured-cloneable, so it can be stored
 * and re-used on a later visit — which is the whole reason this is a library
 * rather than a one-off export. It cannot go in Cache Storage (that holds
 * responses) or `localStorage` (strings), so this is the one place the manga
 * package opens an IndexedDB of its own, hand-rolled for the same reason the
 * zip reader and the WAV writer are: it is one object store and two calls.
 *
 * ### Permission can go away, and that is the cost
 *
 * A saved handle comes back needing permission again, and the grant needs a
 * user gesture — so it cannot be asked for silently on load. That is a failure
 * mode Cache Storage does not have, and the reason this is offered rather than
 * made the default: `permission()` reports it, and every screen that reads
 * from the folder has to be able to say "this needs permission again" instead
 * of looking empty.
 *
 * ### The layout is the archive's
 *
 * `<Series Title>/Chapter 0001/001.jpg`, zero-padded, real extensions — so the
 * folder is readable by any gallery app, and so that a folder moved between
 * the phone and the PC's archive is the same shape either way.
 */

const DB_NAME = 'everything-manga-folder';
const STORE = 'handles';
const KEY = 'root';

/** Chromium desktop and Android; not Safari. See the note above. */
export const folderSupported =
  typeof window !== 'undefined' && 'showDirectoryPicker' in window && window.isSecureContext;

/* ------------------------------------------------------------------ *
 * The handle, kept between visits
 * ------------------------------------------------------------------ */

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idb<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = run(tx.objectStore(STORE));
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
      })
  );
}

let cached: FileSystemDirectoryHandle | null | undefined;

/** The folder chosen on this device, or null. Read once and remembered. */
export async function savedFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (cached !== undefined) return cached;
  if (!folderSupported) return (cached = null);
  try {
    cached = (await idb<FileSystemDirectoryHandle | undefined>('readonly', (s) => s.get(KEY))) ?? null;
  } catch {
    // A browser that refuses IndexedDB (private mode, blocked site data) simply
    // has no folder, which is a state this already handles.
    cached = null;
  }
  return cached;
}

/**
 * Ask for one. Must be called from a click — the picker refuses otherwise, in
 * exactly those words.
 */
export async function chooseFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (!folderSupported) return null;
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await (window as unknown as {
      showDirectoryPicker: (o?: { mode?: string; id?: string }) => Promise<FileSystemDirectoryHandle>;
    }).showDirectoryPicker({ mode: 'readwrite', id: 'blue-everything-manga' });
  } catch (error) {
    /*
     * Dismissed is not a failure — changing your mind about a file picker is a
     * normal thing to do, and reporting it would be noise. Anything else is,
     * and swallowing all of it was wrong: on an Android 16 emulator the picker
     * opens, the folder is chosen and allowed, and **the result never reaches
     * the page** — after which every later attempt is refused with
     * `NotAllowedError: File picker already active`. Silently returning null
     * there leaves a button that does nothing with nothing anywhere saying why,
     * which is the failure this project keeps writing down.
     */
    if ((error as DOMException)?.name === 'AbortError') return null;
    throw error;
  }
  await idb('readwrite', (s) => s.put(handle, KEY));
  cached = handle;
  return handle;
}

/** Stop using it. The files are left exactly where they are. */
export async function forgetFolder(): Promise<void> {
  await idb('readwrite', (s) => s.delete(KEY)).catch(() => undefined);
  cached = null;
}

export type FolderPermission = 'none' | 'granted' | 'prompt' | 'denied';

/** Whether the chosen folder can be written to right now. */
export async function permission(): Promise<FolderPermission> {
  const handle = await savedFolder();
  if (!handle) return 'none';
  try {
    const state = await (handle as unknown as {
      queryPermission: (o: { mode: string }) => Promise<PermissionState>;
    }).queryPermission({ mode: 'readwrite' });
    return state;
  } catch {
    return 'prompt';
  }
}

/** Ask for it back. Needs a click, like the picker itself. */
export async function grant(): Promise<boolean> {
  const handle = await savedFolder();
  if (!handle) return false;
  try {
    const state = await (handle as unknown as {
      requestPermission: (o: { mode: string }) => Promise<PermissionState>;
    }).requestPermission({ mode: 'readwrite' });
    return state === 'granted';
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Names, laid out as the archive lays them out
 * ------------------------------------------------------------------ */

/** Nothing a path can use, and nothing Windows refuses at write time. */
export function safeName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/[. ]+$/, '');
  return cleaned || 'Untitled';
}

/** `Chapter 0012.5` — padded, so a gallery app sorts it the way you read it. */
export function chapterName(number: number): string {
  const whole = Math.floor(Math.abs(number));
  const fraction = Math.abs(number) % 1;
  return `Chapter ${number < 0 ? '-' : ''}${String(whole).padStart(4, '0')}${fraction ? String(fraction).slice(1) : ''}`;
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

export function extensionFor(type: string): string {
  return EXTENSIONS[type.split(';')[0]!.trim().toLowerCase()] ?? 'img';
}

const TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  img: 'application/octet-stream',
};

function typeFor(file: string): string {
  return TYPES[file.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

/* ------------------------------------------------------------------ *
 * Reading and writing
 * ------------------------------------------------------------------ */

/** Walk to a subfolder, making it when asked to. */
async function dirFor(parts: string[], create: boolean): Promise<FileSystemDirectoryHandle | null> {
  let dir = await savedFolder();
  if (!dir) return null;
  for (const part of parts) {
    try {
      dir = await dir.getDirectoryHandle(part, { create });
    } catch {
      return null;
    }
  }
  return dir;
}

/**
 * One page, written where a person can find it.
 *
 * Returns the path it used, relative to the chosen folder, which is what the
 * manifest records so the reader can find it again without re-deriving a name
 * from a title that may since have been renamed.
 */
export async function writePage(
  series: string,
  chapter: number,
  index: number,
  body: ArrayBuffer,
  type: string
): Promise<string | null> {
  const parts = [safeName(series), chapterName(chapter)];
  const dir = await dirFor(parts, true);
  if (!dir) return null;
  const file = `${String(index + 1).padStart(3, '0')}.${extensionFor(type)}`;
  try {
    const handle = await dir.getFileHandle(file, { create: true });
    const writable = await handle.createWritable();
    await writable.write(body);
    await writable.close();
  } catch {
    return null;
  }
  return [...parts, file].join('/');
}

/**
 * Write over a page already in the folder, at the path the manifest has for it.
 *
 * For a saved page that turned out damaged and was fetched again: the manifest
 * keeps pointing at the same file, so nothing else has to learn it changed.
 */
export async function rewritePage(path: string, body: ArrayBuffer): Promise<boolean> {
  const parts = path.split('/');
  const file = parts.pop();
  if (!file) return false;
  const dir = await dirFor(parts, false);
  if (!dir) return false;
  try {
    const handle = await dir.getFileHandle(file);
    const writable = await handle.createWritable();
    await writable.write(body);
    await writable.close();
    return true;
  } catch {
    return false;
  }
}

/** A page back out of the folder, as the reader's `cachedResponse` wants it. */
export async function readPage(path: string): Promise<Response | undefined> {
  const parts = path.split('/');
  const file = parts.pop();
  if (!file) return undefined;
  const dir = await dirFor(parts, false);
  if (!dir) return undefined;
  try {
    const handle = await dir.getFileHandle(file);
    const blob = await handle.getFile();
    return new Response(blob, { headers: { 'content-type': typeFor(file) } });
  } catch {
    return undefined;
  }
}

/** Remove one chapter's folder. A folder that is already gone is not an error. */
export async function removeChapterFolder(series: string, chapter: number): Promise<void> {
  const dir = await dirFor([safeName(series)], false);
  if (!dir) return;
  try {
    await dir.removeEntry(chapterName(chapter), { recursive: true });
  } catch {
    // Already gone, or the folder was tidied by hand. Either way, nothing to do.
  }
}

/** Remove a whole series' folder. */
export async function removeSeriesFolder(series: string): Promise<void> {
  const root = await savedFolder();
  if (!root) return;
  try {
    await root.removeEntry(safeName(series), { recursive: true });
  } catch {
    // As above.
  }
}
