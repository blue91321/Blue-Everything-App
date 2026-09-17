/**
 * Notes: a linked notebook rather than a list of scraps.
 *
 * ### The list does not carry bodies
 *
 * A sidebar of a thousand notes was returning a thousand full Markdown bodies
 * on every keystroke of the search box. The list sends a *preview* — the first
 * line or two of rendered text — and the editor fetches the one note it opens.
 * That is the same split the friends list draws between the row and the panel,
 * and the reason is the same: the thing you are looking at is small and the
 * thing behind it is not.
 *
 * ### Writing goes through one function
 *
 * `saveNote` fills the title, normalises the folder, and rebuilds the link and
 * tag index. Nothing else may write a note — the voice command reaches it
 * through `module-api` for exactly that reason. A second insert somewhere else
 * is a note that exists and has no backlinks, which looks like the link being
 * broken rather than the write being incomplete.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createNoteSchema, updateNoteSchema } from '@everything/shared';
import { derivedTitle, extractTags, noteKey, normaliseFolder, noteToText } from '@everything/shared/notes';
import { db } from '../db/client.js';
import { noteFiles, notes, noteTags } from '../db/schema.js';
import {
  isDisplayable,
  mimeForExtension,
  readAttachment,
  safeExtension,
  writeAttachment,
} from '../notes/files.js';
import { changes } from '../events.js';
import { EXPORT_FORMATS, ExportRefused, exportNotes } from '../notes/export.js';
import { IMPORT_FORMATS, ImportRefused, readImport } from '../notes/import.js';
import {
  backlinksFor,
  filesFor,
  folderTree,
  declareFolder,
  undeclareFolder,
  notesInFolder,
  moveDeclaredFolders,
  graph,
  listNotes,
  outgoingFor,
  reindexAll,
  reindexNote,
  tagCounts,
  titleOf,
  type NoteRow,
} from '../notes/store.js';

/**
 * 25MB, which is a screenshot or a scanned page and not a video.
 *
 * Generous enough that nobody meets it pasting from a phone, small enough that
 * a notes folder cannot quietly become the largest thing on the disk.
 */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * 200MB, which is a decade of Evernote with its attachments still in it.
 *
 * Larger than anything else this app accepts, and deliberately: an import is a
 * one-off on a local machine, and refusing somebody's whole history at the door
 * would make the feature pointless for exactly the person it is for.
 */
const MAX_IMPORT_BYTES = 200 * 1024 * 1024;

/** The first couple of lines, rendered, for a row in the list. */
function preview(body: string, max = 180): string {
  const text = noteToText(body).replace(/\n+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

function asListRow(note: NoteRow) {
  return {
    id: note.id,
    title: titleOf(note),
    /** Null when there is no stored title, so the editor can tell them apart. */
    storedTitle: note.title,
    folder: note.folder,
    pinned: note.pinned,
    preview: preview(note.body),
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

/**
 * Create or update, with the index kept true.
 *
 * Exported so `module-api` can hand it to the voice package: a dictated note
 * has to reach the same write the screen uses, or it is a note with no tags and
 * no title key — invisible to a wiki-link pointing straight at it.
 */
export async function saveNote(
  input: { title?: string | null; body?: string; folder?: string | null; pinned?: boolean },
  id?: string
): Promise<NoteRow> {
  const body = input.body ?? '';
  /*
   * A blank title becomes the first meaningful line rather than staying empty.
   * That is what makes every note linkable: `[[…]]` matches a title, and a
   * notebook where half the notes have none is one where half of them cannot be
   * reached by a link.
   */
  const title = (input.title ?? '').trim() || derivedTitle(body);
  const folder = normaliseFolder(input.folder);

  const values = {
    title: title || null,
    titleKey: noteKey(title),
    body,
    folder,
    ...(input.pinned === undefined ? {} : { pinned: input.pinned ? 1 : 0 }),
  };

  const [row] = id
    ? await db.update(notes).set(values).where(eq(notes.id, id)).returning()
    : await db.insert(notes).values(values).returning();

  if (row) await reindexNote(row.id, row.body);
  return row as NoteRow;
}

export async function noteRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------------------------------------------------------- */
  /* Reading                                                           */
  /* ---------------------------------------------------------------- */

  app.get('/api/notes', async (request) => {
    const { folder, tag, q, limit } = request.query as Record<string, string | undefined>;
    const rows = await listNotes({
      folder,
      tag,
      search: q,
      limit: limit ? Math.min(2000, Math.max(1, Number(limit) || 0)) : undefined,
    });
    return rows.map(asListRow);
  });

  /*
   * Registered before `/:id` reads better than it matters — Fastify prefers a
   * static segment over a parameter either way — but the ordering is kept so
   * nobody has to know that to be sure `tree` is not a note id.
   */
  app.get('/api/notes/tree', async () => ({ folders: await folderTree() }));
  app.get('/api/notes/tags', async () => ({ tags: await tagCounts() }));
  app.get('/api/notes/graph', async () => graph());

  app.get('/api/notes/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const [row] = await db.select().from(notes).where(eq(notes.id, id));
    if (!row) return reply.code(404).send({ error: 'no such note' });

    const note = row as NoteRow;
    return {
      ...asListRow(note),
      body: note.body,
      /** Both directions, because a notebook is only as good as its links. */
      backlinks: await backlinksFor(note),
      outgoing: await outgoingFor(note),
      files: await filesFor(note.id),
    };
  });

  /* ---------------------------------------------------------------- */
  /* Writing                                                           */
  /* ---------------------------------------------------------------- */

  app.post('/api/notes', async (request, reply) => {
    const body = createNoteSchema.parse(request.body);
    const created = await saveNote(body);
    changes.emitChange('notes');
    return reply.code(201).send(asListRow(created));
  });

  app.patch('/api/notes/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const patch = updateNoteSchema.parse(request.body);

    const [existing] = await db.select().from(notes).where(eq(notes.id, id));
    if (!existing) return reply.code(404).send({ error: 'no such note' });

    /*
     * Merged with what is stored rather than written from the patch alone.
     * `saveNote` derives the title from the body, so a patch of `{ pinned }`
     * alone would otherwise rewrite the title from an empty body and quietly
     * rename the note to nothing.
     */
    const updated = await saveNote(
      {
        title: patch.title === undefined ? existing.title : patch.title,
        body: patch.body === undefined ? existing.body : patch.body,
        folder: patch.folder === undefined ? existing.folder : patch.folder,
        pinned: patch.pinned === undefined ? existing.pinned === 1 : patch.pinned,
      },
      id
    );

    changes.emitChange('notes');
    return asListRow(updated);
  });

  app.delete('/api/notes/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    // The link and tag rows cascade; the attachments cascade with them, and
    // their files are swept below.
    const attached = await filesFor(id);
    await db.delete(notes).where(eq(notes.id, id));
    for (const file of attached) await removeAttachment(file.id, file.ext);

    changes.emitChange('notes');
    return reply.code(204).send();
  });

  /**
   * Move a whole folder, which is a rename rather than a move.
   *
   * Notes hold their path as a string, so "rename work to projects" is one
   * update over a prefix rather than a walk. Done here rather than by the
   * screen sending one PATCH per note: a hundred round trips to rename a folder
   * is a progress bar nobody should need.
   */
  app.post('/api/notes/folder/rename', async (request, reply) => {
    const { from, to } = request.body as { from?: string; to?: string };
    const source = normaliseFolder(from);
    const target = normaliseFolder(to);
    if (!source) return reply.code(400).send({ error: 'name the folder to rename' });

    /*
     * Renaming a folder into its own descendant would move rows under a path
     * that is about to move again, which is a loop rather than a rename.
     */
    if (target === source || `${target}/`.startsWith(`${source}/`)) {
      return reply.code(400).send({ error: 'a folder cannot move inside itself' });
    }

    const moved = await db
      .update(notes)
      .set({
        folder: target
          ? sql`${target} || substr(${notes.folder}, ${source.length + 1})`
          : sql`ltrim(substr(${notes.folder}, ${source.length + 1}), '/')`,
      })
      .where(sql`${notes.folder} = ${source} or ${notes.folder} like ${`${source}/%`}`)
      .returning({ id: notes.id });

    /*
     * The declarations move with the notes, or an empty folder would appear not
     * to move at all and a full one would leave a ghost behind at the old path.
     */
    await moveDeclaredFolders(source, target);

    changes.emitChange('notes');
    return { moved: moved.length, folder: target };
  });

  /**
   * Make a folder that has nothing in it.
   *
   * The one folder operation that needs its own table: everywhere else a folder
   * is a prefix on notes and needs no record, but an empty one has no note to
   * be a prefix of. Creating one that already exists is a success rather than a
   * conflict — the screen cannot tell a declared folder from an implied one, and
   * should not have to.
   */
  app.post('/api/notes/folder', async (request, reply) => {
    const { path } = request.body as { path?: string };
    const folder = normaliseFolder(path);
    if (!folder) return reply.code(400).send({ error: 'name the folder' });

    await declareFolder(folder);
    changes.emitChange('notes');
    return reply.code(201).send({ folder });
  });

  /**
   * Remove a folder, but only while it is empty.
   *
   * Deleting one that still holds notes would have to answer a question this
   * route cannot: whether the notes go too. Refusing and saying how many are in
   * there leaves that decision where it belongs, and makes the destructive
   * reading of "delete folder" impossible to reach by accident.
   */
  app.delete('/api/notes/folder', async (request, reply) => {
    const { path, notes: withNotes } = request.query as { path?: string; notes?: string };
    const folder = normaliseFolder(path);
    if (!folder) return reply.code(400).send({ error: 'name the folder' });

    const holding = await notesInFolder(folder);

    /*
     * Taking the notes too has to be asked for by name.
     *
     * "Delete folder" has a destructive reading and a harmless one, and which
     * one was meant is not recoverable afterwards — there is no trash here. So
     * the default refuses and says how many are in the way, and `notes=delete`
     * is the caller stating which it meant. The screen offers both as separate
     * menu items rather than one that behaves differently depending on what is
     * inside.
     */
    if (holding > 0 && withNotes !== 'delete') {
      return reply.code(409).send({
        error: `${folder} still has ${holding} ${holding === 1 ? 'note' : 'notes'} in it`,
      });
    }

    let deleted = 0;
    if (holding > 0) {
      const doomed = await db
        .select({ id: notes.id })
        .from(notes)
        .where(sql`${notes.folder} = ${folder} or ${notes.folder} like ${`${folder}/%`}`);

      for (const note of doomed) {
        // Same order the single-note delete uses: the rows cascade, the files
        // on disk do not and are swept by hand.
        const attached = await filesFor(note.id);
        await db.delete(notes).where(eq(notes.id, note.id));
        for (const file of attached) await removeAttachment(file.id, file.ext);
      }
      deleted = doomed.length;
    }

    await undeclareFolder(folder);
    changes.emitChange('notes');
    return { folder, notesDeleted: deleted };
  });

  /* ---------------------------------------------------------------- */
  /* Attachments                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Store a pasted picture and answer with the Markdown to insert.
   *
   * Its own `bodyLimit`, like the package upload: Fastify's global default is
   * 1MB, and raising *that* to accept a screenshot would widen how much memory
   * any request can ask this process to buffer, for one endpoint.
   *
   * The reply carries the Markdown rather than the id, so the editor pastes
   * what the server decided to call it instead of assembling a path — which is
   * the difference between one place knowing the URL shape and two.
   */
  app.post(
    '/api/notes/files',
    { bodyLimit: MAX_ATTACHMENT_BYTES + 1_000_000 },
    async (request, reply) => {
      const body = request.body as { name?: string; data?: string; noteId?: string | null };
      if (typeof body?.data !== 'string') return reply.code(400).send({ error: 'no file' });

      const bytes = Buffer.from(body.data, 'base64');
      if (bytes.length === 0) return reply.code(400).send({ error: 'that file is empty' });
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        return reply.code(413).send({ error: 'that file is larger than 25MB' });
      }

      const name = (body.name ?? 'file').slice(0, 200);
      const ext = safeExtension(name, 'png');

      const [row] = await db
        .insert(noteFiles)
        .values({
          noteId: body.noteId ?? null,
          name,
          ext,
          mime: mimeForExtension(ext),
          bytes: bytes.length,
        })
        .returning();

      await writeAttachment(row.id, ext, bytes);

      return reply.code(201).send({
        ...row,
        /*
         * An image embeds, anything else links. Getting that the wrong way
         * round shows a broken-image icon for a PDF, which reads as the upload
         * having failed rather than as it not being a picture.
         */
        markdown: isDisplayable(ext)
          ? `![${name}](/api/notes/files/${row.id})`
          : `[${name}](/api/notes/files/${row.id})`,
      });
    }
  );

  app.get('/api/notes/files/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const [row] = await db.select().from(noteFiles).where(eq(noteFiles.id, id));
    if (!row) return reply.code(404).send({ error: 'no such file' });

    const bytes = await readAttachment(row.id, row.ext);
    if (!bytes) return reply.code(404).send({ error: 'that file is no longer on disk' });

    return reply
      .header('content-type', row.mime)
      /*
       * Immutable: the id is generated per upload and the bytes never change,
       * so the one thing this must not do is make the browser ask again for a
       * picture it already has on every render of the note.
       */
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(bytes);
  });

  app.delete('/api/notes/files/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const [row] = await db.select().from(noteFiles).where(eq(noteFiles.id, id));
    if (!row) return reply.code(404).send({ error: 'no such file' });

    await db.delete(noteFiles).where(eq(noteFiles.id, id));
    await removeAttachment(row.id, row.ext);
    changes.emitChange('notes');
    return reply.code(204).send();
  });

  /* ---------------------------------------------------------------- */
  /* Coming from, and going to, other apps                             */
  /* ---------------------------------------------------------------- */

  app.get('/api/notes/formats', async () => ({ import: IMPORT_FORMATS, export: EXPORT_FORMATS }));

  /**
   * Read somebody's export, and say what is in it.
   *
   * **Two phases, and the first writes nothing.** A mis-detected layout
   * produces a plausible number of plausible-looking notes, and finding that
   * out afterwards means deleting a thousand rows by hand — the same reasoning
   * the vault's password import is built on.
   *
   * Local-only: it reads a file from this machine and, on commit, writes a
   * great many rows. `bodyLimit` of its own for the reason the package upload
   * has one.
   */
  app.post('/api/notes/import', { bodyLimit: MAX_IMPORT_BYTES + 2_000_000 }, async (request, reply) => {
    if (!request.isLocal) return reply.code(403).send({ error: 'import from the PC running the app' });

    const body = request.body as { name?: string; data?: string; commit?: boolean; folder?: string };
    if (typeof body?.data !== 'string') return reply.code(400).send({ error: 'no file' });

    const bytes = Buffer.from(body.data, 'base64');
    if (bytes.length === 0) return reply.code(400).send({ error: 'that file is empty' });
    if (bytes.length > MAX_IMPORT_BYTES) return reply.code(413).send({ error: 'that file is larger than 200MB' });

    let preview;
    try {
      preview = readImport(body.name ?? 'export', bytes);
    } catch (error) {
      // Named rather than a 500: "this is not a notes export" is something
      // somebody can act on, and a stack trace is not.
      if (error instanceof ImportRefused) return reply.code(400).send({ error: error.message });
      throw error;
    }

    if (!body.commit) {
      return {
        ...preview,
        /*
         * Only the first few, and the count separately. A preview of four
         * thousand notes is a response nobody reads and a screen that hangs
         * drawing it — six is enough to recognise your own notes.
         */
        notes: preview.notes.slice(0, 6).map((note) => ({ ...note, body: note.body.slice(0, 400) })),
        total: preview.notes.length,
        committed: 0,
      };
    }

    /*
     * Everything lands under one folder by default, named for where it came
     * from. Merging somebody's Evernote into the root of an existing notebook
     * is the kind of thing that cannot be undone by hand, and a folder can be
     * dragged apart afterwards by anybody who wanted it merged.
     */
    const into = normaliseFolder(body.folder ?? preview.formatLabel);

    let committed = 0;
    for (const note of preview.notes) {
      const saved = await saveNote({
        title: note.title,
        // The tags an importer found go into the body, because that is where
        // this app keeps tags — the index is rebuilt from the text, so a tag
        // stored anywhere else would vanish on the next edit.
        body: appendMissingTags(note.body, note.tags),
        folder: normaliseFolder(into ? `${into}/${note.folder}` : note.folder),
      });

      // The dates the export carried, restored after the insert — `createdAt`
      // and `updatedAt` default to now, and an imported decade all dated today
      // would lose the one ordering that matters.
      if (note.createdAt || note.updatedAt) {
        await db
          .update(notes)
          .set({
            ...(note.createdAt ? { createdAt: note.createdAt } : {}),
            ...(note.updatedAt ? { updatedAt: note.updatedAt } : {}),
          })
          .where(eq(notes.id, saved.id));
      }
      committed += 1;
    }

    changes.emitChange('notes');
    return { ...preview, notes: [], total: preview.notes.length, committed, folder: into };
  });

  /**
   * Write the notebook out.
   *
   * Not local-only: your notes are your data and the phone should be able to
   * take a copy, the same call the habit pictures make. Nothing here touches
   * this machine.
   */
  app.post('/api/notes/export', async (request, reply) => {
    const body = request.body as { format?: string; ids?: string[]; folder?: string };

    const rows = body?.ids?.length
      ? await db.select().from(notes).where(inArray(notes.id, body.ids))
      : await listNotes({ folder: body?.folder, limit: 10_000 });

    if (rows.length === 0) return reply.code(400).send({ error: 'there are no notes to export' });

    const tagsByNote = await tagsFor(rows.map((row) => row.id));

    let result;
    try {
      result = exportNotes(
        body?.format ?? 'vault',
        (rows as NoteRow[]).map((note) => ({
          title: titleOf(note),
          body: note.body,
          folder: note.folder,
          tags: tagsByNote.get(note.id) ?? [],
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
        }))
      );
    } catch (error) {
      if (error instanceof ExportRefused) return reply.code(400).send({ error: error.message });
      throw error;
    }

    return reply
      .header('content-type', result.mime)
      // The browser needs the name; `fetch` cannot see it without this being
      // exposed, since the PWA downloads through a blob rather than a link.
      .header('content-disposition', `attachment; filename="${result.fileName}"`)
      .header('access-control-expose-headers', 'content-disposition')
      .send(result.bytes);
  });

  /**
   * Rebuild every link and tag.
   *
   * For after an import, and for after a change to how a body is parsed — the
   * index is derived, so the only way it can be wrong is by having been written
   * under older rules. Local-only: it is cheap but it is a whole-table rewrite.
   */
  app.post('/api/notes/reindex', async (request, reply) => {
    if (!request.isLocal) return reply.code(403).send({ error: 'only from the PC running the app' });
    const count = await reindexAll();
    changes.emitChange('notes');
    return { reindexed: count };
  });
}

/* ------------------------------------------------------------------ */

/**
 * Put an importer's tags into the body, where this app keeps tags.
 *
 * The index is rebuilt from the text on every write, so a tag recorded anywhere
 * else would survive exactly until the first edit and then vanish — which is
 * the worst available outcome, because it looks like the editor deleted it.
 * Only the ones not already written somewhere in the note, so an Obsidian vault
 * whose tags are in both the front matter and the body does not gain a
 * duplicate line.
 */
function appendMissingTags(body: string, tags: string[]): string {
  const present = new Set(extractTags(body).map((tag) => tag.toLowerCase()));
  const missing = tags
    .map((tag) => tag.trim().replace(/^#/, '').replace(/\s+/g, '-'))
    .filter((tag) => tag && !present.has(tag.toLowerCase()));

  if (missing.length === 0) return body;
  return `${body.trimEnd()}

${[...new Set(missing)].map((tag) => `#${tag}`).join(' ')}
`;
}

/** The tags of many notes at once, so an export is not a query per note. */
async function tagsFor(ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;

  for (const row of await db.select().from(noteTags).where(inArray(noteTags.noteId, ids))) {
    out.set(row.noteId, [...(out.get(row.noteId) ?? []), row.tag]);
  }
  return out;
}

/** Removing the row is not removing the bytes; nothing cascades to a file. */
async function removeAttachment(id: string, ext: string): Promise<void> {
  const { rm } = await import('node:fs/promises');
  const { attachmentPath } = await import('../notes/files.js');
  await rm(attachmentPath(id, ext), { force: true });
}
