/**
 * A chapter lands, and the nudge engine decides when you hear about it.
 *
 * This is the reason the module is in this app rather than being a separate
 * reader: nothing else knows you are mid-match. The rest — the library, the
 * covers, the ids — exists to give this something worth saying.
 *
 * ### A task *and* a nudge, which are two different things
 *
 * The **task** is the durable record: it sits under *Anytime* with no due date,
 * it is what you tick off when you have read the chapter, and it survives the
 * nudge being missed. The **nudge** is the interruption, and it is raised
 * directly rather than left to `sweepDueTasks`, because that sweep only ever
 * queues a task that is *coming due* — and a chapter release has no due date
 * that would be honest to invent.
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
 * stopping point rather than delivered about something already done.
 */
import { db, tasks, nudges, changes, getSettings } from '@everything/server/module-api';
import { resolvePush } from '@everything/shared';
import { isNewerChapter, worthPolling } from './identity.js';
import { read, write, alreadyRaised, type Series, type Store } from './library.js';
import { readSeries, MangaUpdatesError, SPACING_MS } from './mangaupdates.js';

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
    .filter((s) => s.muId !== null && worthPolling(s.status))
    .sort((a, b) => (a.checkedAt ?? 0) - (b.checkedAt ?? 0));
}

export type SweepResult = { checked: number; raised: number; failed: number };

export async function sweepReleases(now = Date.now()): Promise<SweepResult> {
  const store = read();
  const due = pollable(store).slice(0, BATCH);
  const result: SweepResult = { checked: 0, raised: 0, failed: 0 };
  if (due.length === 0) return result;

  const pushDefault = Boolean((await getSettings()).pushDefault);
  let announce = false;

  for (const [index, series] of due.entries()) {
    // Spacing between requests, never a burst — their policy asks for it and
    // there is no published limit to check against.
    if (index > 0) await sleep(SPACING_MS);

    const row = store.series.find((s) => s.id === series.id);
    if (!row) continue;

    try {
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

      const fresh = reading.latestChapter;

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

      const [task] = await db
        .insert(tasks)
        .values({
          title: `${row.title} — chapter ${fresh}`,
          notes: null,
          // Deliberately no due date. See the note at the top of this file.
          dueAt: null,
          source: 'manga',
          sourceUrl: row.muId ? seriesUrl(row.muId) : null,
        })
        .returning();

      await db.insert(nudges).values({
        title: row.title,
        body: `Chapter ${fresh} is out`,
        taskId: task.id,
        earliestAt: now,
        expiresAt: now + NUDGE_LIFE_MS,
        // Never breaks a match, and carries no deadline to escalate through.
        minQuality: 'any',
        pushToPhone: resolvePush(null, pushDefault) ? 1 : 0,
      });

      store.links.push({ seriesId: row.id, chapter: fresh, taskId: task.id, raisedAt: now });
      row.latestChapter = fresh;
      result.raised += 1;
      announce = true;
    } catch (error) {
      // Kept beside the reading it could not replace, so the screen can show
      // the last known chapter *and* why it is the last known one.
      row.error = error instanceof MangaUpdatesError ? error.message : 'the check failed';
      row.checkedAt = now;
      result.failed += 1;
      announce = true;
    }
  }

  write(store);
  if (announce) changes.emitChange('all');
  return result;
}
