/**
 * What an installed package is, as opposed to a built-in feature.
 *
 * `features.ts` describes the seven parts of the app that ship *in this repo*.
 * They are compiled in, spread across up to three workspaces — the vault owns a
 * server folder, a web folder and the whole extension — and there is no single
 * directory that is "the vault", which is exactly why they can be switched off
 * and deleted but never dropped in.
 *
 * A module is the other kind: **one folder, arriving from outside**, unpacked
 * into `modules/` at the repo root. That is the shape that makes a folder you
 * can open and a zip you can drag in possible at all, so it is the shape the
 * contract insists on.
 *
 * Deliberately dependency-free, like `features.ts`: this is read while deciding
 * how much of the app exists, which happens before anything else is set up, and
 * a manifest is a handful of strings rather than something needing a schema
 * library. It validates by hand and **reports every problem it finds** instead
 * of throwing on the first, because the screen's job is to tell you what is
 * wrong with a package rather than to make it disappear.
 */

/** Reserved: a module may not shadow a built-in. Kept in step by `modules-check`. */
export const RESERVED_MODULE_IDS = ['vault', 'voice', 'push', 'integrations', 'habits', 'notes', 'time'] as const;

/**
 * The folder name and the id are the same string, so this is also a filename
 * rule: lowercase, no dots, no separators, nothing the shell or the filesystem
 * treats specially. Anything outside it is refused at the boundary rather than
 * sanitised into something else, since a package silently installed under a
 * different name is a package you cannot find again.
 */
export const MODULE_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

/** The file that makes a folder a module. Named for what it is, at the root of the folder. */
export const MODULE_MANIFEST = 'module.json';

/** Where the enabled/disabled choice is recorded, beside `features.json`. */
export const MODULES_STATE_FILE = 'modules.json';

export interface ModuleManifest {
  id: string;
  label: string;
  /** One line, shown on the Packages tab. */
  blurb: string;
  /** Its own version — the whole point of a package that does not ship with the app. */
  version: string;
  /** Optional, and shown as written. Nothing verifies it; see `trusted` below. */
  author?: string;
  /**
   * Entry point for its server-side half, relative to the module folder.
   *
   * Optional because a module may be nothing but data. When present it is
   * imported at boot and handed the Fastify instance, which means **it is
   * ordinary code running in the server process** — see the warning on the
   * Packages screen. There is no sandbox here and this contract does not
   * pretend to offer one.
   */
  server?: string;
  /** Free text shown under the row, for anything the blurb cannot hold. */
  notes?: string;
}

export interface ModuleProblem {
  field: string;
  message: string;
}

/**
 * Check a parsed `module.json`.
 *
 * Takes `unknown` rather than a partial manifest on purpose: this is the
 * boundary where a downloaded file becomes something the app believes, and
 * typing the input as though it were already the right shape is how that
 * boundary stops being one.
 */
export function validateModuleManifest(raw: unknown): { manifest: ModuleManifest | null; problems: ModuleProblem[] } {
  const problems: ModuleProblem[] = [];

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { manifest: null, problems: [{ field: MODULE_MANIFEST, message: 'is not a JSON object' }] };
  }
  const value = raw as Record<string, unknown>;

  const text = (field: string, required: boolean, max: number): string | undefined => {
    const found = value[field];
    if (found === undefined || found === null) {
      if (required) problems.push({ field, message: 'is missing' });
      return undefined;
    }
    if (typeof found !== 'string') {
      problems.push({ field, message: 'must be a string' });
      return undefined;
    }
    const trimmed = found.trim();
    if (required && trimmed === '') {
      problems.push({ field, message: 'is empty' });
      return undefined;
    }
    if (trimmed.length > max) {
      problems.push({ field, message: `is longer than ${max} characters` });
      return undefined;
    }
    return trimmed;
  };

  const id = text('id', true, 32);
  if (id !== undefined) {
    if (!MODULE_ID_PATTERN.test(id)) {
      problems.push({
        field: 'id',
        message: 'must be lowercase letters, digits and hyphens, starting with a letter',
      });
    } else if ((RESERVED_MODULE_IDS as readonly string[]).includes(id)) {
      problems.push({ field: 'id', message: `"${id}" is a built-in part of the app and cannot be reused` });
    }
  }

  const label = text('label', true, 64);
  const blurb = text('blurb', true, 300);
  const version = text('version', true, 32);
  const author = text('author', false, 64);
  const notes = text('notes', false, 1000);
  const server = text('server', false, 200);

  /*
   * The entry path is a path, so it gets the path rule rather than the string
   * rule. A module that names `../../packages/server/src/db.js` as its entry
   * would be asking the loader to import something outside the folder it was
   * given, which is the same escape the zip reader refuses one layer earlier.
   */
  if (server !== undefined) {
    if (server.startsWith('/') || server.startsWith('\\') || /^[A-Za-z]:/.test(server)) {
      problems.push({ field: 'server', message: 'must be a path inside the module, not an absolute one' });
    } else if (server.split(/[/\\]/).includes('..')) {
      problems.push({ field: 'server', message: 'must not climb outside the module folder' });
    } else if (!/\.(js|mjs|ts)$/.test(server)) {
      problems.push({ field: 'server', message: 'must point at a .js, .mjs or .ts file' });
    }
  }

  if (problems.length > 0) return { manifest: null, problems };

  return {
    manifest: {
      id: id!,
      label: label!,
      blurb: blurb!,
      version: version!,
      ...(author === undefined ? {} : { author }),
      ...(server === undefined ? {} : { server }),
      ...(notes === undefined ? {} : { notes }),
    },
    problems: [],
  };
}

/** Is this a name we are willing to use as a folder under `modules/`? */
export function isModuleId(value: string): boolean {
  return MODULE_ID_PATTERN.test(value) && !(RESERVED_MODULE_IDS as readonly string[]).includes(value);
}
