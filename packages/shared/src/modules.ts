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
import { FEATURE_IDS } from './features.js';

/**
 * Reserved: a module may not take the name of a built-in feature.
 *
 * Derived from `FEATURE_IDS` rather than written out again, and that is not
 * tidiness — it is the only version of this list that stays true. `push` was
 * spelled out here, then moved out of the feature manifest and into
 * `packages/modules/push`, at which point the hand-written copy rejected the
 * package's own folder name as invalid and the feature simply stopped loading.
 * The symptom was a row on the Packages screen labelled `push` with no manifest.
 *
 * Both files are in `shared` and both are dependency-free, so this costs
 * nothing. A *shipped* package needs no protection here anyway: those roots are
 * scanned first, so a downloaded folder of the same name is skipped rather than
 * allowed to shadow one.
 */
export const RESERVED_MODULE_IDS = FEATURE_IDS;

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
  /**
   * Entry point for its browser-side half, relative to the module folder.
   *
   * **One self-contained ES module.** The PWA fetches it with the device token
   * and imports it as a blob URL — which it must, because `<script src>` and a
   * bare `import()` of a path send no Authorization header, and this app keeps
   * everything personal behind one. A blob has no base URL, so a relative
   * `import './other.js'` inside it cannot resolve: whatever the package needs
   * has to be in this one file.
   *
   * It gets React and the API client *passed in* rather than importing them, so
   * a package bundles neither and there is exactly one React on the page.
   */
  web?: string;
  /** A tab in the drawer. Only meaningful alongside `web`. */
  tab?: ModuleTab;
  /** What it offers to put in the Dashboard's side column. */
  panels?: ModulePanel[];
  /** Free text shown under the row, for anything the blurb cannot hold. */
  notes?: string;
}

export interface ModuleTab {
  label: string;
  /** One character in the drawer, like the built-in tabs. */
  glyph?: string;
  /**
   * Where it sits. Core screens occupy 10–40 and Settings pins to the foot, so
   * a package with no opinion lands after everything built in and before it.
   */
  order?: number;
}

export interface ModulePanel {
  /**
   * Local to the module — `now`, not `weather:now`. The full id is made by
   * prefixing the module's own, so two packages cannot collide however
   * carelessly they are named, and an author cannot get the convention wrong.
   */
  id: string;
  label: string;
  /** One line under the picker, saying what you would actually see. */
  hint?: string;
}

/** `now` in the weather module becomes `weather:now` everywhere outside it. */
export function fullPanelId(moduleId: string, panelId: string): string {
  return `${moduleId}:${panelId}`;
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

  /* The browser entry gets the same path rule as the server one. */
  const web = text('web', false, 200);
  if (web !== undefined) {
    if (web.startsWith('/') || web.startsWith('\\') || /^[A-Za-z]:/.test(web)) {
      problems.push({ field: 'web', message: 'must be a path inside the module, not an absolute one' });
    } else if (web.split(/[/\\]/).includes('..')) {
      problems.push({ field: 'web', message: 'must not climb outside the module folder' });
    } else if (!/\.(js|mjs)$/.test(web)) {
      // No `.ts` here, unlike the server entry: the browser gets this file
      // verbatim and nothing on that side strips types.
      problems.push({ field: 'web', message: 'must point at a built .js or .mjs file' });
    }
  }

  const tab = readTab(value.tab, web, problems);
  const panels = readPanels(value.panels, web, problems);

  if (problems.length > 0) return { manifest: null, problems };

  return {
    manifest: {
      id: id!,
      label: label!,
      blurb: blurb!,
      version: version!,
      ...(author === undefined ? {} : { author }),
      ...(server === undefined ? {} : { server }),
      ...(web === undefined ? {} : { web }),
      ...(tab === undefined ? {} : { tab }),
      ...(panels === undefined ? {} : { panels }),
      ...(notes === undefined ? {} : { notes }),
    },
    problems: [],
  };
}

/**
 * A tab is refused without a `web` entry rather than ignored.
 *
 * A manifest asking for a tab it cannot draw is a mistake somebody made, and
 * the failure it produces otherwise is the worst kind: a drawer entry that
 * opens an empty screen, with nothing anywhere saying why.
 */
function readTab(raw: unknown, web: string | undefined, problems: ModuleProblem[]): ModuleTab | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push({ field: 'tab', message: 'must be an object' });
    return undefined;
  }
  if (web === undefined) {
    problems.push({ field: 'tab', message: 'needs a "web" entry point — there would be nothing to show' });
    return undefined;
  }

  const value = raw as Record<string, unknown>;
  const label = typeof value.label === 'string' ? value.label.trim() : '';
  if (label === '' || label.length > 32) {
    problems.push({ field: 'tab.label', message: 'must be 1–32 characters' });
    return undefined;
  }

  const glyph = typeof value.glyph === 'string' ? value.glyph.trim() : '';
  const order = typeof value.order === 'number' && Number.isFinite(value.order) ? value.order : 50;

  return { label, order, ...(glyph === '' ? {} : { glyph: firstGrapheme(glyph) }) };
}

/**
 * One character as a person would count them, not as the string does.
 *
 * `[...glyph][0]` takes the first **code point**, which is right for 👋 and
 * wrong for every emoji built out of several — 👨‍💻 is three code points joined
 * by a zero-width joiner, and slicing it yields a lone 👨. A package author
 * picking one of those would get a tab icon that was silently not the one they
 * chose.
 *
 * `Intl.Segmenter` is built into Node 24 and every browser this app runs in, so
 * it costs no dependency — but it is guarded anyway, because this file is also
 * read by `npm run features`-style scripts on whatever Node happens to be
 * installed, and a missing Intl API should cost a mangled glyph rather than a
 * crash while deciding which parts of the app exist.
 */
function firstGrapheme(text: string): string {
  const segmenter = (Intl as { Segmenter?: new (locale?: string, options?: { granularity: string }) => { segment(input: string): Iterable<{ segment: string }> } }).Segmenter;
  if (segmenter) {
    for (const { segment } of new segmenter(undefined, { granularity: 'grapheme' }).segment(text)) return segment;
    return '';
  }
  return [...text][0] ?? '';
}

function readPanels(raw: unknown, web: string | undefined, problems: ModuleProblem[]): ModulePanel[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    problems.push({ field: 'panels', message: 'must be an array' });
    return undefined;
  }
  if (raw.length === 0) return undefined;
  if (web === undefined) {
    problems.push({ field: 'panels', message: 'need a "web" entry point — there would be nothing to draw' });
    return undefined;
  }
  if (raw.length > 8) {
    problems.push({ field: 'panels', message: 'more than eight is not a side column, it is a second app' });
    return undefined;
  }

  const out: ModulePanel[] = [];
  const seen = new Set<string>();

  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      problems.push({ field: `panels[${index}]`, message: 'must be an object' });
      continue;
    }
    const value = entry as Record<string, unknown>;
    const id = typeof value.id === 'string' ? value.id.trim() : '';
    const label = typeof value.label === 'string' ? value.label.trim() : '';
    const hint = typeof value.hint === 'string' ? value.hint.trim() : '';

    /*
     * The same rule as a module id, minus the reserved-word check: this half is
     * namespaced by the module's own id, so `weather:notes` is nobody else's
     * business. The shape still matters — it ends up in a stored settings list.
     */
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) {
      problems.push({ field: `panels[${index}].id`, message: 'must be lowercase letters, digits and hyphens' });
      continue;
    }
    if (seen.has(id)) {
      problems.push({ field: `panels[${index}].id`, message: `"${id}" appears twice` });
      continue;
    }
    if (label === '' || label.length > 48) {
      problems.push({ field: `panels[${index}].label`, message: 'must be 1–48 characters' });
      continue;
    }

    seen.add(id);
    out.push({ id, label, ...(hint === '' ? {} : { hint }) });
  }

  return out.length > 0 ? out : undefined;
}

/** Is this a name we are willing to use as a folder under `modules/`? */
export function isModuleId(value: string): boolean {
  return MODULE_ID_PATTERN.test(value) && !(RESERVED_MODULE_IDS as readonly string[]).includes(value);
}
