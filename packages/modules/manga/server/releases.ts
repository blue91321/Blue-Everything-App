/**
 * A chapter lands, and the nudge engine decides when you hear about it.
 *
 * This is the reason the module is in this app rather than being a separate
 * reader: nothing else knows you are mid-match. The rest — the library, the
 * covers, the ids — exists to give this something worth saying.
 *
 * ### A nudge, and a task only if you asked for one
 *
 * The **nudge** is the interruption, and it is raised directly rather than left
 * to `sweepDueTasks`, because that sweep only ever queues a task that is
 * *coming due* — and a chapter release has no due date that would be honest to
 * invent.
 *
 * The **task** is optional and off by default (`releaseTasks`). It is the
 * durable record — under *Anytime* with no due date, ticked off once read, and
 * surviving a missed nudge — which is worth having for one series and a chore
 * across twenty, where the task list becomes a reading log. The Manga screen's
 * own list already says what is new, so nothing is lost by leaving it off.
 *
 * Inventing one would not merely be untidy. A `dueAt` in the past makes a task a
 * **passed deadline**, and this project's nudge policy is explicit that a passed
 * deadline escalates and may break into a match. A new chapter of anything is
 * the last thing that should interrupt a fight. So:
 *
 *   - `minQuality: 'any'` — waits for a genuine stopping point, like a habit;
 *   - **no `deadlineAt`** — so it can never escalate through one;
 *   - `expiresAt` a few days out — a chapter is still out next week, but a
 *     *notification* about it is stale, and the task is still on the Dashboard
 *     either way.
 *
 * Linking the nudge to the task with `taskId` buys the last piece for free:
 * `freshenForDelivery` drops a nudge whose task has been completed, so reading
 * the chapter during a long session means the reminder is quietly dropped at the
 * stopping point rather than delivered about something already done. With no
 * task, the release link keeps the nudge's id and marking the chapter read in
 * the reader expires it instead — the same outcome by the route that exists.
 */
import { db, tasks, nudges, changes, getSettings } from '@everything/server/module-api';
import { resolvePush } from '@everything/shared';
import { isNewerChapter, worthPolling } from './identity.js';
import { read, readPositions, write, alreadyRaised, type ReadingPosition, type Series, type Store } from './library.js';
import { readSeries, MangaUpdatesError, SPACING_MS } from './mangaupdates.js';
import { SourceError, effectiveUrl } from './sources.js';
import { SuwayomiAdapter, DEFAULT_BASE_URL } from './suwayomi.js';
import { suwayomiProcess } from './process.js';

/**
 * How many series one sweep asks about.
 *
 * Small on purpose. MangaUpdates publishes no rate limit and asks for
 * "reasonable spacing", which is a reason to be conservative rather than a
 * licence to find the ceiling. At this size and spacing a sweep is a handful of
 * requests over a few seconds, and a library of any size is covered within a few
 * hours — which is well inside "you hear about it the same day".
 */
export const BATCH = 12;

/** Half an hour, chosen against the nudge sweep the way the coursework poll is. */
export const SWEEP_EVERY_MS = 30 * 60_000;

/** A notification about a chapter is stale long before the chapter is. */
const NUDGE_LIFE_MS = 3 * 24 * 60 * 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The canonical page for a series, rebuilt from the numeric id. */
export function seriesUrl(muId: number): string {
  return `https://www.mangaupdates.com/series/${muId.toString(36)}/`;
}

/**
 * Which series are worth asking about, oldest answer first.
 *
 * Ordering by `checkedAt` makes the rotation fall out of the data rather than
 * needing a cursor to keep — a series just polled goes to the back, and one
 * added a moment ago has `null` and goes to the front, which is what you want
 * since it is the one you are watching.
 */
export function pollable(store: Store): Series[] {
  return store.series
    .filter((s) => (s.muId !== null || s.source !== null) && worthPolling(s.status))
    .sort((a, b) => (a.checkedAt ?? 0) - (b.checkedAt ?? 0));
}

/*
 * How often a series is asked about, by how recently you have been in it.
 *
 * The rotation above is fair, and fairness is wrong once a library is large:
 * a sweep asks about twelve, so bringing in nine hundred series from another
 * app would have left the three you are reading waiting a day and a half for
 * their turn. So a series you read this month may be asked every sweep, one you
 * read this year every six hours, and one you have not opened in a year once a
 * day — and eight of the twelve slots are kept for this month's, so a backlog
 * of hundreds of never-checked series cannot crowd them out.
 */
const DAY = 24 * 60 * 60_000;
const RECENT_MS = 30 * DAY;
const YEAR_MS = 365 * DAY;
export const RECENT_SLOTS = 8;

/**
 * Slots kept for asking again about something whose last check failed.
 *
 * Making a failed row *eligible* sooner was not enough, and the numbers say why:
 * on this install the four timed-out rows had **216, 331, 451 and 216 series
 * queued ahead of them**, all equally due, and the back half of twelve slots
 * clears about eight an hour. A row 451 deep waits more than two days — which
 * is exactly how long "source not answering" had been sitting on a series with
 * nothing wrong with it.
 *
 * So they get reserved slots, the same answer `RECENT_SLOTS` gives the series
 * you are actually reading. Two, not more: a source that is genuinely down
 * would otherwise spend a sixth of every sweep failing, and these are the rows
 * least likely to reward one. A handful of broken rows clear within the hour;
 * hundreds take a few hours, which is still days faster than their turn.
 */
export const RETRY_SLOTS = 2;

/** When you last did anything with it: read a chapter, left a place, or followed it. */
export function lastActive(series: Series, positions: Record<string, ReadingPosition>): number {
  return Math.max(series.addedAt, positions[series.id]?.at ?? 0, ...series.readLog.map((r) => r.at));
}

/**
 * How soon a series whose last check *failed* is asked again.
 *
 * Its ordinary turn is not good enough. A timeout is usually nothing — Suwayomi
 * busy, a site slow — but the row says "source not answering" until something
 * asks again and succeeds, and for a series you have not opened in a year that
 * is its daily slot behind a queue of hundreds. Measured on this install:
 * **five of eight broken rows were timeouts, the oldest two days old**, with
 * nothing wrong by then.
 *
 * An hour, not the next sweep. A source that is genuinely down would otherwise
 * take a slot every half hour forever, and these are the rows least likely to
 * reward one.
 */
const RETRY_FAILED_MS = 60 * 60_000;

/** How long a series may go unasked, from how recently it was active. */
export function checkEvery(active: number, now: number, failed = false): number {
  const age = now - active;
  const ordinary = age <= RECENT_MS ? 0 : age <= YEAR_MS ? 6 * 60 * 60_000 : DAY;
  // Never *less* often because it failed — a recent series is already every sweep.
  return failed ? Math.min(ordinary, RETRY_FAILED_MS) : ordinary;
}

/** What this sweep asks about: this month's first, then whatever else is due. */
export function dueForCheck(
  store: Store,
  now: number,
  positions: Record<string, ReadingPosition>,
  batch = BATCH
): Series[] {
  const recent: Series[] = [];
  const failed: Series[] = [];
  const rest: Series[] = [];
  for (const s of pollable(store)) {
    const active = lastActive(s, positions);
    if (now - active <= RECENT_MS) {
      // Already asked about every sweep; a retry slot would buy it nothing.
      recent.push(s);
      continue;
    }
    if (s.checkedAt !== null && now - s.checkedAt < checkEvery(active, now, s.error !== null)) continue;
    // Due, and the last answer was a failure: ahead of the ordinary queue.
    if (s.error !== null) failed.push(s);
    else rest.push(s);
  }
  // All three already oldest-answer-first, from `pollable`.
  const first = recent.slice(0, RECENT_SLOTS);
  const retry = failed.slice(0, RETRY_SLOTS);
  const others = rest.slice(0, Math.max(0, batch - first.length - retry.length));
  /*
   * Unused slots flow outwards rather than being lost — a library with nothing
   * broken spends all twelve on reading, and one with nothing read recently
   * spends them on the backlog. The leftovers of each are appended so a short
   * batch is still a full one.
   */
  return [...first, ...retry, ...others, ...recent.slice(RECENT_SLOTS), ...failed.slice(RETRY_SLOTS)].slice(0, batch);
}

export type SweepResult = { checked: number; raised: number; failed: number };

/**
 * The fields this sweep is allowed to change on a series.
 *
 * Named, because the commit below copies exactly these onto a freshly read
 * store and nothing else. A field added to the sweep and not added here would
 * be computed and then silently dropped — so the list is the contract, and it
 * is short on purpose: everything here is *what the source said*, which is the
 * only thing a background check has any business deciding.
 */
const SWEPT = [
  'latestChapter',
  'sourceChapter',
  'sourceCheckedAt',
  'checkedAt',
  'error',
  'totalChapters',
  'status',
] as const;

export async function sweepReleases(now = Date.now()): Promise<SweepResult> {
  const store = read();
  const linksBefore = store.links.length;
  const due = dueForCheck(store, now, readPositions());
  const result: SweepResult = { checked: 0, raised: 0, failed: 0 };
  if (due.length === 0) return result;

  const pushDefault = Boolean((await getSettings()).pushDefault);
  let announce = false;

  const sourceUrl = effectiveUrl(store, DEFAULT_BASE_URL);
  const suwayomi = sourceUrl ? new SuwayomiAdapter(sourceUrl) : null;
  // Counts only the calls that leave this machine, so the first one is not
  // preceded by a pointless pause and a run of linked series costs nothing.
  let remoteCalls = 0;

  for (const series of due) {
    const row = store.series.find((s) => s.id === series.id);
    if (!row) continue;

    /*
     * A linked series asks its source and nothing else.
     *
     * The source is the authority — it is the thing serving the chapter — and it
     * is on this machine, so it costs no rate limit and needs no spacing. Asking
     * MangaUpdates as well would be a remote request per series per sweep to
     * refresh a number now shown only as context, so `totalChapters` and
     * `completed` stop being refreshed once a series is linked and keep their
     * last value.
     *
     * **A sweep never starts Suwayomi**, which is what keeps "on demand" true.
     *
     * Waking a 166MB JVM every half hour to ask a dozen questions is the
     * always-running option wearing a timer, and it is the trade this project
     * refuses everywhere else. So the source is used when it happens to be up —
     * because you have been reading — and MangaUpdates answers when it is not.
     *
     * The consequence is worth stating: a linked series checked while Suwayomi
     * is down reports the narrower number until the next time you open it. That
     * is a stale number rather than a wrong one, and the row says where it came
     * from either way.
     */
    const sourceUp = suwayomiProcess.state.state === 'running' || !store.manageSuwayomi;
    const viaSource =
      row.source !== null && suwayomi !== null && row.source.adapter === suwayomi.id && sourceUp;

    // Spacing applies to MangaUpdates only. Their policy asks for it; a
    // localhost GraphQL call does not need it and should not be slowed by it.
    if (!viaSource && remoteCalls > 0) await sleep(SPACING_MS);

    try {
      let fresh: string | null;

      if (viaSource) {
        try {
          const latest = await suwayomi!.latestChapter(row.source!.mangaId);
          row.sourceChapter = latest;
          row.sourceCheckedAt = now;
          row.checkedAt = now;
          row.error = null;
          result.checked += 1;
          /*
           * The source's answer, or nothing. `readableChapter` decides which
           * number to *show* and is not what this needs: falling back to the
           * stored value here would compare a number against itself and could
           * never be news.
           */
          fresh = latest === null ? null : String(latest);
        } catch (error) {
          /*
           * A source that will not answer falls back rather than failing the row.
           *
           * Extensions break and servers stop. A linked series going silent
           * about its chapter count over that would be worse than the narrower
           * MangaUpdates number it had before it was linked — so the fallback is
           * taken and the row says it was taken, rather than quietly presenting
           * one service's answer as the other's.
           *
           * With no MangaUpdates id there is nothing to fall back *to*, so the
           * error stands and the outer handler records it.
           */
          if (series.muId === null) throw error;
          const why = error instanceof SourceError ? error.message : 'the source failed';

          remoteCalls += 1;
          const reading = await readSeries(series.muId);
          row.checkedAt = now;
          row.totalChapters = reading.totalChapters;
          if (reading.completed && row.status === 'ongoing') row.status = 'completed';
          /*
           * The stale source number is cleared, not kept.
           *
           * The row would otherwise print "ch 45 · via Suwayomi" above a line
           * saying it is showing MangaUpdates — a label and its own explanation
           * contradicting each other, which is worse than losing a number that
           * comes back on the next successful check.
           */
          row.sourceChapter = null;
          row.error = `${why} — showing MangaUpdates for now`;
          result.checked += 1;
          fresh = reading.latestChapter;
        }
      } else {
        remoteCalls += 1;
        const reading = await readSeries(series.muId!);
        row.checkedAt = now;
        row.error = null;
        // Written on every poll, including the first, so the count is on screen
        // even for a series that has never gained a chapter while we watched.
        row.totalChapters = reading.totalChapters;
        result.checked += 1;

        // Their judgement that the run has ended takes the series out of the
        // rotation permanently, which is most of what keeps this cheap.
        if (reading.completed && row.status === 'ongoing') row.status = 'completed';
        fresh = reading.latestChapter;
      }

      /*
       * Nothing seen before: record and say nothing.
       *
       * Adding a series should not immediately raise a nudge about the chapter
       * that was already out when you added it — exactly the "already handed in
       * when we first looked" case the coursework sync writes a link for and no
       * task.
       */
      if (row.latestChapter === null) {
        row.latestChapter = fresh;
        announce = true;
        continue;
      }

      if (!isNewerChapter(fresh, row.latestChapter) || fresh === null) continue;
      // Belt and braces against a sweep that overlapped itself.
      if (alreadyRaised(store, row.id, fresh)) continue;

      const task = store.releaseTasks
        ? (
            await db
              .insert(tasks)
              .values({
                title: `${row.title} — chapter ${fresh}`,
                notes: null,
                // Deliberately no due date. See the note at the top of this file.
                dueAt: null,
                source: 'manga',
                sourceUrl: row.muId ? seriesUrl(row.muId) : null,
              })
              .returning()
          )[0]
        : null;

      // Switched off, the chapter is still recorded below — only the nudge is skipped.
      const nudge = store.releaseNudges
        ? (
            await db
              .insert(nudges)
              .values({
                title: row.title,
                body: `Chapter ${fresh} is out`,
                taskId: task?.id ?? null,
                earliestAt: now,
                expiresAt: now + NUDGE_LIFE_MS,
                // Never breaks a match, and carries no deadline to escalate through.
                minQuality: 'any',
                pushToPhone: resolvePush(null, pushDefault) ? 1 : 0,
              })
              .returning()
          )[0]
        : null;

      store.links.push({
        seriesId: row.id,
        chapter: fresh,
        taskId: task?.id ?? null,
        nudgeId: nudge?.id ?? null,
        raisedAt: now,
      });
      row.latestChapter = fresh;
      result.raised += 1;
      announce = true;
    } catch (error) {
      // Kept beside the reading it could not replace, so the screen can show
      // the last known chapter *and* why it is the last known one.
      row.error =
        error instanceof MangaUpdatesError || error instanceof SourceError ? error.message : 'the check failed';
      row.checkedAt = now;
      result.failed += 1;
      announce = true;
    }
  }

  /*
   * Re-read, merge, write — never write back the store this began with.
   *
   * This function holds a store across every network call it makes: a dozen
   * series, each a request to somebody else's site, which is seconds at best
   * and the better part of a minute when a source is slow. Writing that store
   * at the end overwrote **everything done in the app meanwhile** — a series
   * followed, a chapter marked read, a star, a shelf. Silently, and only
   * sometimes, which is the worst shape a bug can have.
   *
   * Found when two libraries made during the sweep that runs 45s after boot
   * vanished a moment later. It is not new: this file has written a
   * minutes-old store since it was written, and `tags.ts` and `matching.ts`
   * both already re-read immediately before writing — the pattern was here,
   * this was the one place not following it.
   *
   * Only `SWEPT` fields are copied, and only onto series that still exist: one
   * unfollowed during the sweep stays unfollowed, which is what you asked for.
   */
  const fresh = read();
  for (const row of due) {
    const target = fresh.series.find((x) => x.id === row.id);
    if (!target) continue;
    for (const field of SWEPT) {
      (target as Record<string, unknown>)[field] = (row as Record<string, unknown>)[field];
    }
  }
  // Appended, not replaced: anything raised meanwhile is somebody else's and
  // this run's are the ones past where it started.
  fresh.links.push(...store.links.slice(linksBefore));
  write(fresh);

  if (announce) changes.emitChange('all');
  return result;
}
