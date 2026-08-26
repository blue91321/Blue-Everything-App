/**
 * Games this machine has seen, and what to do about each.
 *
 * The list is a *record*, not a configuration somebody maintains: rows appear
 * because the agent reported a process running or an app taking exclusive
 * fullscreen. Before this, the built-in list lived in `games.ts`, additions
 * lived in the agent's own config file on the PC, and an unrecognised fullscreen
 * app was written to the console — so there was nothing a screen could show and
 * nothing the phone could reach.
 *
 * Reading is not restricted; changing is, like every other write that decides
 * how this install behaves.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { labelForExe } from '@everything/shared';
import { db } from '../db/client.js';
import { games } from '../db/schema.js';
import { changes } from '../events.js';

/** Where a row came from. Kept so the screen can say why something is listed. */
export type GameSource = 'builtin' | 'seen' | 'fullscreen' | 'manual';

/**
 * Record that these executables were running, creating rows for new ones.
 *
 * Called from the attention heartbeat, which arrives every few seconds — so it
 * does the cheap thing first and only writes when something is genuinely new or
 * has not been touched for a while. Without that this would be one update per
 * game per poll, which is the row-per-tick cost the attention log was carefully
 * built to avoid.
 */
const TOUCH_AFTER_MS = 5 * 60 * 1000;

/**
 * What this process has already written, so the steady state costs no queries.
 *
 * The heartbeat arrives every two to fifteen seconds and nearly always names the
 * same executables, so without this it would be a `select` per poll forever —
 * which is exactly the row-per-tick cost the attention log was shaped to avoid,
 * arriving by a different door. In memory rather than in the database because
 * the question is "have *I* written this since booting", and the answer is not
 * worth persisting.
 */
const writtenAt = new Map<string, number>();

/**
 * Executables whose path this process has already stored.
 *
 * Without it the cache above swallows the one report that could fill a path in:
 * a row created before paths existed is "recently written", so every heartbeat
 * carrying its location is skipped and the Run button never appears. Which is
 * exactly the state every row on an upgraded install starts in.
 */
const pathKnown = new Set<string>();

export async function recordSeen(
  seen: Array<{ exe: string; source: GameSource; isGame: boolean; path?: string }>,
  now = Date.now()
): Promise<void> {
  if (seen.length === 0) return;

  const fresh = seen.filter((entry) => {
    const exe = entry.exe.toLowerCase();
    if (!exe) return false;
    // A path we have not stored yet is always worth a look, however recently
    // this row was touched.
    if (entry.path && !pathKnown.has(exe)) return true;
    const at = writtenAt.get(exe);
    return at === undefined || now - at >= TOUCH_AFTER_MS;
  });
  if (fresh.length === 0) return;

  const names = fresh.map((entry) => entry.exe.toLowerCase());
  const existing = await db.select().from(games).where(inArray(games.exe, names));
  const known = new Map(existing.map((row) => [row.exe, row]));
  let changed = false;

  for (const entry of fresh) {
    const exe = entry.exe.toLowerCase();
    writtenAt.set(exe, now);
    const row = known.get(exe);

    if (entry.path) pathKnown.add(exe);

    if (!row) {
      await db.insert(games).values({
        exe,
        label: labelForExe(exe),
        /*
         * A newly discovered *fullscreen* app is recorded but not assumed to be
         * a game. Plenty of things go fullscreen — a film, a browser, a photo
         * viewer — and treating one as a game means silently going quiet, which
         * is the failure nobody would attribute to this list. Something already
         * on the shipped list arrives with `isGame` true because that is a
         * judgement this repo already made.
         */
        isGame: entry.isGame ? 1 : 0,
        source: entry.source,
        launchPath: entry.path ?? null,
        firstSeenAt: now,
        lastSeenAt: now,
      });
      changed = true;
      continue;
    }

    if (now - row.lastSeenAt >= TOUCH_AFTER_MS || (entry.path && !row.launchPath)) {
      /*
       * The path is filled in the first time it is known, and never overwritten
       * — a game moved to another drive would otherwise silently keep the old
       * one, and a path you typed yourself should not be replaced by wherever
       * the process happened to be launched from.
       */
      await db
        .update(games)
        .set({ lastSeenAt: now, ...(entry.path && !row.launchPath ? { launchPath: entry.path } : {}) })
        .where(eq(games.exe, exe));
      if (entry.path && !row.launchPath) changed = true;
    } else if (entry.path && !row.launchPath) {
      // Not due a touch, but the path is new — the whole reason this entry got
      // past the cache above.
      await db.update(games).set({ launchPath: entry.path }).where(eq(games.exe, exe));
      changed = true;
      /*
       * Deliberately *not* announced. This fires every five minutes while
       * something is running and says nothing anybody is watching for — waking
       * every open browser for it would be the polling the SSE stream exists to
       * replace, the same reasoning `/api/attention` is excluded for.
       */
    }
  }

  if (changed) {
    forgetGameVersion();
    changes.emitChange('games');
  }
}

/** The rows for a set of running executables, for the interruption decision. */
export async function runningGames(exes: string[]): Promise<Array<{ allowInterruptions: number | null }>> {
  const names = exes.map((exe) => exe.toLowerCase()).filter(Boolean);
  if (names.length === 0) return [];

  return db
    .select({ allowInterruptions: games.allowInterruptions })
    .from(games)
    .where(and(inArray(games.exe, names), eq(games.isGame, 1)));
}

/**
 * A short hash of the list, so the agent can tell whether it changed.
 *
 * Hashes the names rather than counting them — the same lesson the voice
 * vocabulary learned: renaming or swapping one leaves the count identical, and
 * a counted version would leave the agent watching for the old set indefinitely.
 *
 * Cached and invalidated on write, because it rides on the attention heartbeat
 * and recomputing it every few seconds would be a query per poll.
 */
let versionCache: string | null = null;

export function forgetGameVersion(): void {
  versionCache = null;
}

export async function gamesVersion(): Promise<string> {
  if (versionCache !== null) return versionCache;
  const [exes, off] = await Promise.all([gameExecutables(), suppressedExecutables()]);
  /*
   * Both halves are hashed. Unticking a *shipped* game removes nothing from
   * `exes` — the agent knew that name already — so a hash of the watch list
   * alone would not move, and the change would never reach the agent.
   */
  versionCache = createHash('sha256')
    .update(`${exes.sort().join(' ')}
${off.sort().join(' ')}`)
    .digest('hex')
    .slice(0, 16);
  return versionCache;
}

/** Every executable the list says is a game, for the agent to watch for. */
export async function gameExecutables(): Promise<string[]> {
  const rows = await db.select({ exe: games.exe }).from(games).where(eq(games.isGame, 1));
  return rows.map((row) => row.exe);
}

/**
 * Executables the screen has explicitly said are *not* games.
 *
 * Sent to the agent alongside the list, and it is what replaced seeding this
 * table from the built-in names.
 *
 * The agent knows the shipped list — that is how a game is recognised the first
 * time it runs — so the server cannot simply hand over "watch these": an empty
 * table would mean watch nothing, nothing would be detected, and the table would
 * stay empty. That deadlock shipped once and reported itself as
 * `watching 0 games`.
 *
 * Seeding fixed it and was the wrong fix: it filled the screen with sixteen
 * titles this machine had never run. So the agent keeps its own list for
 * *recognition* and the server only ever overrides it — additions in `exes`,
 * removals here. A row appears when something actually runs, which is the only
 * thing that makes the list a record rather than a catalogue.
 */
export async function suppressedExecutables(): Promise<string[]> {
  const rows = await db.select({ exe: games.exe }).from(games).where(eq(games.isGame, 0));
  return rows.map((row) => row.exe);
}

export async function gameRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/games', async () => {
    const rows = await db.select().from(games).orderBy(desc(games.lastSeenAt));
    return rows;
  });

  /**
   * Just the executables, for the agent.
   *
   * Separate from `GET /api/games` because the agent wants a list of strings and
   * the screen wants rows with labels and timestamps — and this one is fetched
   * whenever the version moves, so it should be the small shape.
   */
  app.get('/api/games/watching', async () => ({
    version: await gamesVersion(),
    /** Extra names the agent would not otherwise know about. */
    exes: await gameExecutables(),
    /** Names it *does* know and must stop treating as games. */
    off: await suppressedExecutables(),
  }));

  /**
   * Change one.
   *
   * Local-only, like every other decision about how this machine behaves. The
   * *reading* is not, so the phone can see what is going on.
   */
  app.patch('/api/games/:exe', async (request, reply) => {
    if (!request.isLocal) {
      return reply.code(403).send({ error: 'games can only be changed from the PC running the server' });
    }

    const { exe } = request.params as { exe: string };
    const body = z
      .object({
        label: z.string().min(1).max(120).optional(),
        isGame: z.boolean().optional(),
        /** Null puts it back to following the global setting. */
        allowInterruptions: z.boolean().nullable().optional(),
        launchPath: z.string().max(500).nullable().optional(),
      })
      .parse(request.body);

    const [updated] = await db
      .update(games)
      .set({
        label: body.label,
        isGame: body.isGame === undefined ? undefined : body.isGame ? 1 : 0,
        /*
         * Pulled out of a spread rather than written as a conditional one. A
         * `...(x === undefined ? {} : { … })` contributes nothing on one branch
         * and leaves a boolean where an integer belongs on the other — the bug
         * this repo found ten times over when the server was first typechecked.
         */
        allowInterruptions:
          body.allowInterruptions === undefined ? undefined : body.allowInterruptions === null ? null : body.allowInterruptions ? 1 : 0,
        launchPath: body.launchPath === undefined ? undefined : body.launchPath,
      })
      .where(eq(games.exe, exe.toLowerCase()))
      .returning();

    if (!updated) return reply.code(404).send({ error: 'no such game' });
    forgetGameVersion();
    changes.emitChange('games');
    return updated;
  });

  /**
   * Start it.
   *
   * **The path is never taken from the caller.** It comes from the row, which
   * was filled in by the agent watching that executable actually run here — so
   * this can only ever launch something this machine has already launched by
   * itself. A route that took a path would be a remote "run anything" button
   * wearing a game's name.
   *
   * Local-only on top of that, and detached so a game outlives the request.
   */
  app.post('/api/games/:exe/launch', async (request, reply) => {
    if (!request.isLocal) {
      return reply.code(403).send({ error: 'games can only be started from the PC running the server' });
    }

    const { exe } = request.params as { exe: string };
    const [row] = await db.select().from(games).where(eq(games.exe, exe.toLowerCase()));
    if (!row) return reply.code(404).send({ error: 'no such game' });
    if (!row.launchPath) {
      return reply.code(409).send({ error: 'nowhere to launch it from — run it once and this fills itself in' });
    }
    if (!existsSync(row.launchPath)) {
      return reply.code(409).send({ error: `${row.launchPath} is not there any more` });
    }

    /*
     * `cmd /c start` rather than spawning the executable directly, for the
     * reason the tray menu and the restart button both learned: the child has
     * to outlive this process, and `detached` alone on Windows means
     * DETACHED_PROCESS, which leaves a program with no console host.
     *
     * `start` also wants the working directory to be the game's own folder —
     * plenty of games look for files beside themselves and simply fail if
     * started from somewhere else.
     */
    const child = spawn('cmd.exe', ['/c', 'start', '', row.launchPath], {
      cwd: dirname(row.launchPath),
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (error) => request.log.error(error, 'launch failed'));
    child.unref();

    return { ok: true, launched: row.launchPath };
  });

  /** Open the folder it lives in, so you can see what is actually there. */
  app.post('/api/games/:exe/folder', async (request, reply) => {
    if (!request.isLocal) {
      return reply.code(403).send({ error: 'the folder can only be opened on the PC running the server' });
    }

    const { exe } = request.params as { exe: string };
    const [row] = await db.select().from(games).where(eq(games.exe, exe.toLowerCase()));
    if (!row?.launchPath) return reply.code(409).send({ error: 'nowhere to look — run it once first' });
    if (!existsSync(row.launchPath)) {
      return reply.code(409).send({ error: `${row.launchPath} is not there any more` });
    }

    // `/select,` highlights the file rather than just opening the folder, which
    // is the difference between "here it is" and "here are ninety files".
    const child = spawn('explorer.exe', [`/select,${row.launchPath}`], { detached: true, stdio: 'ignore' });
    // Explorer returns a non-zero exit code on success, so nothing reads one.
    child.on('error', () => {});
    child.unref();

    return { ok: true, folder: dirname(row.launchPath) };
  });

  /** Forget one. It comes back if it runs again, which is the point of a record. */
  app.delete('/api/games/:exe', async (request, reply) => {
    if (!request.isLocal) {
      return reply.code(403).send({ error: 'games can only be changed from the PC running the server' });
    }

    const { exe } = request.params as { exe: string };
    const [removed] = await db.delete(games).where(eq(games.exe, exe.toLowerCase())).returning();
    if (!removed) return reply.code(404).send({ error: 'no such game' });

    forgetGameVersion();
    changes.emitChange('games');
    return { ok: true, exe: removed.exe };
  });

  /**
   * Add one by hand.
   *
   * For the game that has not run since this list existed, and for pointing a
   * voice command at something before it has ever been seen.
   */
  app.post('/api/games', async (request, reply) => {
    if (!request.isLocal) {
      return reply.code(403).send({ error: 'games can only be added from the PC running the server' });
    }

    const body = z
      .object({
        exe: z.string().min(3).max(260),
        label: z.string().min(1).max(120).optional(),
        launchPath: z.string().max(500).optional(),
      })
      .parse(request.body);

    const exe = body.exe.trim().toLowerCase();
    if (!/^[a-z0-9 ._+-]+\.exe$/.test(exe)) {
      return reply.code(400).send({ error: 'that does not look like an executable name, e.g. "cs2.exe"' });
    }

    const now = Date.now();
    const [existing] = await db.select().from(games).where(eq(games.exe, exe));
    if (existing) return reply.code(409).send({ error: `${exe} is already on the list` });

    const [created] = await db
      .insert(games)
      .values({
        exe,
        label: body.label?.trim() || labelForExe(exe),
        isGame: 1,
        source: 'manual',
        launchPath: body.launchPath ?? null,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .returning();

    forgetGameVersion();
    changes.emitChange('games');
    return reply.code(201).send(created);
  });
}
