/**
 * The queries a linked notebook needs, and the one write that keeps them true.
 *
 * ### The body is the truth; everything here is an index over it
 *
 * `note_links` and `note_tags` hold nothing you could not recompute by reading
 * every note — which is exactly why `reindexNote` **deletes and rewrites**
 * rather than working out a difference. A diff is a second model of what the
 * body says, and the day the two disagree the symptom is a backlink that will
 * not go away, with nothing on screen to explain it.
 *
 * Rewriting costs two deletes and two inserts on a note somebody is editing by
 * hand. That is not a loop this app has to defend against.
 */
import { and, desc, eq, inArray, like, or, sql } from 'drizzle-orm';
import {
  derivedTitle,
  extractTags,
  extractWikiLinks,
  noteKey,
  normaliseFolder,
  noteToText,
} from '@everything/shared/notes';
import { db } from '../db/client.js';
import { noteFiles, noteLinks, notes, noteTags } from '../db/schema.js';

export interface NoteRow {
  id: string;
  title: string | null;
  body: string;
  titleKey: string;
  folder: string;
  pinned: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * What a note is called, with the fallback applied.
 *
 * A note with no title of its own is known by its first meaningful line, the
 * way every notes app shows one — so "(untitled)" is a state this never
 * produces, only one an import can put in the database.
 */
export function titleOf(note: { title: string | null; body: string }): string {
  return note.title?.trim() || derivedTitle(note.body) || 'Untitled';
}

/**
 * Rebuild the links and tags for one note.
 *
 * Called on every write, which is what makes the backlinks panel correct rather
 * than nearly correct. The links are stored **by name**: see the note on the
 * table for why resolving to an id here would break the one behaviour that
 * makes wiki-links worth having.
 */
export async function reindexNote(id: string, body: string): Promise<void> {
  await db.delete(noteLinks).where(eq(noteLinks.fromId, id));
  await db.delete(noteTags).where(eq(noteTags.noteId, id));

  /*
   * Deduplicated by target here although `extractWikiLinks` deliberately keeps
   * repeats: the count belongs to the body, and a backlinks panel listing the
   * same note three times because it was mentioned three times is noise.
   */
  const seen = new Map<string, string>();
  for (const link of extractWikiLinks(body)) {
    const key = noteKey(link.target);
    if (key && !seen.has(key)) seen.set(key, link.label);
  }

  if (seen.size > 0) {
    await db
      .insert(noteLinks)
      .values([...seen].map(([target, display]) => ({ fromId: id, target, display })));
  }

  const tags = extractTags(body);
  if (tags.length > 0) {
    await db.insert(noteTags).values(tags.map((tag) => ({ noteId: id, tag })));
  }
}

/** Rebuild everything, for after an import or a change to how parsing works. */
export async function reindexAll(): Promise<number> {
  const all = await db.select({ id: notes.id, body: notes.body }).from(notes);
  for (const note of all) await reindexNote(note.id, note.body);
  return all.length;
}

export interface ListQuery {
  folder?: string;
  tag?: string;
  search?: string;
  limit?: number;
}

/**
 * The note list, filtered three ways that stack.
 *
 * Search is `LIKE` over title and body rather than an FTS table, and that is a
 * measured choice rather than laziness: SQLite's FTS5 would mean a virtual
 * table, a trigger to keep it in step, and a migration that cannot be undone —
 * against a personal notebook where a full scan of a few thousand rows is a
 * millisecond. The day this holds a hundred thousand notes it is worth
 * revisiting, and nothing here would have to move.
 */
export async function listNotes(query: ListQuery = {}): Promise<NoteRow[]> {
  const where = [];

  if (query.folder !== undefined) {
    const folder = normaliseFolder(query.folder);
    /*
     * A folder shows what is *under* it, not only what is directly in it. A
     * tree where clicking a parent shows nothing because everything sits one
     * level down reads as broken, and "show me everything about work" is the
     * question people actually ask a folder.
     */
    where.push(folder === '' ? undefined : or(eq(notes.folder, folder), like(notes.folder, `${folder}/%`)));
  }

  if (query.search?.trim()) {
    const needle = `%${query.search.trim().replace(/[%_]/g, (c) => `\\${c}`)}%`;
    where.push(or(like(notes.title, needle), like(notes.body, needle)));
  }

  if (query.tag) {
    const tagged = db
      .select({ id: noteTags.noteId })
      .from(noteTags)
      .where(eq(noteTags.tag, query.tag));
    where.push(inArray(notes.id, tagged));
  }

  const conditions = where.filter(Boolean);
  const rows = await db
    .select()
    .from(notes)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(notes.pinned), desc(notes.updatedAt))
    .limit(query.limit ?? 1000);

  return rows as NoteRow[];
}

export interface LinkedNote {
  id: string;
  title: string;
  folder: string;
  /** The sentence the link sits in, so a backlink says something. */
  context: string;
}

/**
 * What links *to* this note.
 *
 * The context line is what makes the panel worth having. A list of titles
 * answers "who mentioned this" and leaves you opening each one to find out why;
 * the line the link sits in usually answers it outright.
 */
export async function backlinksFor(note: NoteRow): Promise<LinkedNote[]> {
  const key = noteKey(titleOf(note));
  if (!key) return [];

  const rows = await db
    .select({
      id: notes.id,
      title: notes.title,
      body: notes.body,
      folder: notes.folder,
    })
    .from(noteLinks)
    .innerJoin(notes, eq(notes.id, noteLinks.fromId))
    .where(and(eq(noteLinks.target, key), sql`${notes.id} <> ${note.id}`));

  return rows.map((row) => ({
    id: row.id,
    title: titleOf(row),
    folder: row.folder,
    context: contextAround(row.body, key),
  }));
}

/** Where this note points, and whether those notes exist yet. */
export async function outgoingFor(note: NoteRow): Promise<
  { target: string; display: string; id: string | null; title: string }[]
> {
  const links = await db.select().from(noteLinks).where(eq(noteLinks.fromId, note.id));
  if (links.length === 0) return [];

  const targets = links.map((link) => link.target);
  const existing = await db
    .select({ id: notes.id, title: notes.title, body: notes.body, titleKey: notes.titleKey })
    .from(notes)
    .where(inArray(notes.titleKey, targets));

  const byKey = new Map(existing.map((row) => [row.titleKey, row]));

  return links.map((link) => {
    const found = byKey.get(link.target);
    return {
      target: link.target,
      display: link.display,
      id: found?.id ?? null,
      title: found ? titleOf(found) : link.display || link.target,
    };
  });
}

/**
 * The line a link appears on, trimmed to something that fits a panel.
 *
 * Read off the rendered text rather than the raw Markdown, so the context of a
 * link inside a bullet is the bullet rather than `- [[Thing]] — note the`.
 */
function contextAround(body: string, key: string, max = 140): string {
  /*
   * **The raw line is searched, and only then rendered.** That order is not the
   * obvious one and it is the only one that works: turning `[[Thing]]` into
   * "Thing" is exactly what rendering does, so looking for wiki-links in
   * rendered text finds none, ever. The first version did it the other way and
   * every backlink came back with an empty context — which reads as the panel
   * being broken rather than as the search running over the wrong text.
   */
  for (const raw of body.split('\n')) {
    if (!extractWikiLinks(raw).some((link) => noteKey(link.target) === key)) continue;

    // Rendered afterwards, so a link inside a bullet reads as the bullet.
    const text = noteToText(raw).trim();
    if (!text) continue;
    return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
  }

  /*
   * The link is in the body but on no single line — split across a wrap, or
   * inside a fence. Better to say nothing than to show a line without it.
   */
  return '';
}

export interface FolderNode {
  path: string;
  name: string;
  /** Notes at or under this path, so a parent is never misleadingly empty. */
  count: number;
}

/** Every folder that has a note in it, with the counts the sidebar shows. */
export async function folderTree(): Promise<FolderNode[]> {
  const rows = await db.select({ folder: notes.folder }).from(notes);

  const counts = new Map<string, number>();
  for (const { folder } of rows) {
    const path = normaliseFolder(folder);
    if (!path) continue;
    // Counted against every ancestor, so `work` includes `work/2026/notes`.
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i++) {
      const at = parts.slice(0, i + 1).join('/');
      counts.set(at, (counts.get(at) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([path, count]) => ({ path, count, name: path.split('/').pop() ?? path }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Tags with their counts, commonest first. */
export async function tagCounts(): Promise<{ tag: string; count: number }[]> {
  const rows = await db
    .select({ tag: noteTags.tag, count: sql<number>`count(*)` })
    .from(noteTags)
    .groupBy(noteTags.tag);

  return rows.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export interface GraphNode {
  id: string;
  title: string;
  folder: string;
  /** How many links touch it, which is what decides how big the dot is. */
  degree: number;
}

/**
 * The graph, resolved server-side.
 *
 * The browser could join links to notes itself, and that would mean shipping
 * every link and every title to draw a picture — and a second copy of the
 * name-matching rule, in the one package that cannot import `shared`.
 *
 * **Unresolved links are left out.** A link to a note that does not exist has
 * nothing to draw an edge *to*, and inventing a phantom node for it would fill
 * the picture with dots you cannot click.
 */
export async function graph(): Promise<{ nodes: GraphNode[]; edges: { from: string; to: string }[] }> {
  const all = await db
    .select({ id: notes.id, title: notes.title, body: notes.body, folder: notes.folder, titleKey: notes.titleKey })
    .from(notes);

  const byKey = new Map(all.filter((note) => note.titleKey).map((note) => [note.titleKey, note.id]));
  const links = await db.select().from(noteLinks);

  const degree = new Map<string, number>();
  const edges: { from: string; to: string }[] = [];

  for (const link of links) {
    const to = byKey.get(link.target);
    if (!to || to === link.fromId) continue;
    edges.push({ from: link.fromId, to });
    degree.set(link.fromId, (degree.get(link.fromId) ?? 0) + 1);
    degree.set(to, (degree.get(to) ?? 0) + 1);
  }

  return {
    nodes: all.map((note) => ({
      id: note.id,
      title: titleOf(note),
      folder: note.folder,
      degree: degree.get(note.id) ?? 0,
    })),
    edges,
  };
}

/** Attachments belonging to a note, newest first. */
export async function filesFor(noteId: string) {
  return db.select().from(noteFiles).where(eq(noteFiles.noteId, noteId)).orderBy(desc(noteFiles.createdAt));
}
