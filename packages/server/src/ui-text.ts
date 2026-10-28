/**
 * Your own words for the app's: a screen's name, a section's heading, what an
 * empty list says, and which of its lines you would rather not see. Changed in edit mode on any screen (the ✎ in the menu), and
 * kept here rather than in the source, so a change works from the phone, shows
 * at once on every device, and survives an update.
 *
 * Each piece of text the app lets you change has a stable id (`screen:notes`,
 * `block:core:due-today`), and this holds only what you changed: an id with no
 * entry shows the app's own wording, so a reworded default in a later version
 * still reaches everything you never touched. Removing an entry is "use the
 * original".
 *
 * `data/ui-text.json`, per copy, like `closing.json`. Not a table: it is a
 * handful of strings, read whole, and a migration would be a column per idea.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { dataDir } from './paths.js';
import { parseJsonText } from './json.js';

const FILE = resolve(dataDir, 'ui-text.json');

/** What an id may look like: the app writes these, so anything else is a mistake. */
const ID = /^[a-z0-9][a-z0-9:._#-]{0,119}$/;
/** Room for a line of grey help text; a page is not what this is for. */
const MAX_TEXT = 600;
/** A bound on the file, well past anything somebody renames by hand. */
const MAX_ENTRIES = 2000;

export type UiTextState = {
  /** Your wording, by id: only what you changed. */
  text: Record<string, string>;
  /** Text you hid. Hiding it hides the line it sits in, and edit mode still shows it, faded, to bring back. */
  hidden: string[];
};

export function readUiText(): UiTextState {
  try {
    const raw = parseJsonText(readFileSync(FILE, 'utf8')) as { text?: unknown; hidden?: unknown };
    const text: Record<string, string> = {};
    if (raw.text && typeof raw.text === 'object') {
      for (const [id, value] of Object.entries(raw.text as Record<string, unknown>)) {
        if (ID.test(id) && typeof value === 'string' && value.trim() !== '') text[id] = value.slice(0, MAX_TEXT);
      }
    }
    // Absent in a file written before text could be hidden.
    const hidden = Array.isArray(raw.hidden) ? [...new Set(raw.hidden.filter((id): id is string => typeof id === 'string' && ID.test(id)))] : [];
    return { text, hidden };
  } catch {
    // No file yet, or a damaged one: the app's own wording everywhere, which
    // is what an empty set of changes means anyway.
    return { text: {}, hidden: [] };
  }
}

function writeUiText(state: UiTextState): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(`${FILE}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${FILE}.tmp`, FILE);
}

const changeSchema = z
  .object({
    id: z.string().regex(ID),
    /** `null` or blank goes back to the app's own wording; absent leaves the wording alone. */
    text: z.string().max(MAX_TEXT).nullable().optional(),
    /** Absent leaves it as it is. */
    hidden: z.boolean().optional(),
  })
  .refine((body) => body.text !== undefined || body.hidden !== undefined);

/**
 * Not local-only: this is your data like a habit's name, changed from wherever
 * you are. The generic announcer tells every device (scope `ui-text`).
 */
export async function uiTextRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/ui-text', async () => readUiText());

  app.put('/api/ui-text', async (request, reply) => {
    const parsed = changeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: `expected { id, text } or { id, hidden }, with a short id and at most ${MAX_TEXT} characters` });
    }
    const { id } = parsed.data;
    const current = readUiText();
    if (parsed.data.text !== undefined) {
      const text = parsed.data.text?.trim() ?? '';
      if (text === '') delete current.text[id];
      else {
        if (!(id in current.text) && Object.keys(current.text).length >= MAX_ENTRIES) {
          return reply.code(400).send({ error: 'too many changed texts; put some back to the original first' });
        }
        current.text[id] = text;
      }
    }
    if (parsed.data.hidden !== undefined) {
      const rest = current.hidden.filter((h) => h !== id);
      if (parsed.data.hidden && rest.length >= MAX_ENTRIES) return reply.code(400).send({ error: 'too much hidden; show some again first' });
      current.hidden = parsed.data.hidden ? [...rest, id] : rest;
    }
    writeUiText(current);
    return { id, text: current.text[id] ?? null, hidden: current.hidden.includes(id) };
  });
}
