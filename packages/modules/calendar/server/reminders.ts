/**
 * Reminders before events, through the nudge queue, and the one timer here.
 *
 * A reminder is an ordinary nudge, so it waits for a good moment like any
 * other and is held through a match. What it carries is a **deadline**: a
 * few minutes before the event starts (the start itself for a reminder set at
 * the start), so a meeting is never missed for a game that ran long. A
 * reminder for an all-day event has none: a birthday is not worth breaking
 * into a match for. Each expires when its event ends.
 *
 * ### One timeout, to the next reminder
 *
 * Trips' arrangement: a single `setTimeout` to the next moment something is
 * due, re-armed after every change and at least every six hours, `unref`ed and
 * cleared on close. With no events coming up it sleeps the six hours. The same
 * wake refreshes calendar links fetched more than six hours ago, so a meeting
 * added in Google reaches the reminders without the screen being opened.
 *
 * Raised reminders are recorded by occurrence and offset (`Store.raised`), so
 * a restart, or the PC waking from sleep, raises nothing twice.
 */
import { and, inArray } from 'drizzle-orm';
import { db, nudges, getSettings, changes } from '@everything/server/module-api';
import { resolvePush } from '@everything/shared';
import { occurrencesIn, remindAt, type Occurrence } from './occurrences.js';
import { read, write, type Store } from './store.js';
import { dateOf, DAY, HOUR, MINUTE, serverZone, wallAt, addDays } from './time.js';

/** Offsets reach four weeks, so that far is looked at. */
const LOOK_AHEAD = 29 * DAY;
const MAX_SLEEP = 6 * HOUR;
/** A reminder may still be raised until its event starts, or this long after its own time, whichever is later. */
const LATE = 10 * MINUTE;
/** A link fetched longer ago than this is fetched again when the timer wakes. */
export const LINK_STALE = 6 * HOUR;
/** Kept this long, so a reminder is not raised again for an occurrence still in view. */
const KEEP_RAISED = 35 * DAY;

export interface Due {
  occ: Occurrence;
  offset: number;
  at: number;
  key: string;
}

const keyOf = (occ: Occurrence, offset: number) => `${occ.key}|${offset}`;
const lastChance = (occ: Occurrence, at: number) => Math.max(at + LATE, occ.allDay ? occ.endMs : occ.startMs);

/** Every reminder not yet raised that is due by `now`, and when the next one after that is. */
export function remindersDue(store: Store, now: number): { due: Due[]; next: number | null } {
  const due: Due[] = [];
  let next: number | null = null;
  if (!store.reminders.enabled) return { due, next };
  for (const occ of occurrencesIn(store.events, store.calendars, store.reminders, now - 2 * DAY, now + LOOK_AHEAD)) {
    for (const offset of occ.remind) {
      const key = keyOf(occ, offset);
      if (store.raised[key]) continue;
      const at = remindAt(occ, offset);
      if (at <= now) {
        if (now < lastChance(occ, at)) due.push({ occ, offset, at, key });
      } else if (next === null || at < next) next = at;
    }
  }
  return { due, next };
}

/** How an event is said in a reminder: "Today at 3:00 PM", "Tomorrow, all day", "Fri, Nov 20 at 9:30 AM". */
export function whenText(occ: Occurrence, now: number, zone = serverZone()): string {
  const today = dateOf(wallAt(now, zone));
  const day = occ.allDay ? occ.start : dateOf(wallAt(occ.startMs, zone));
  const dayText =
    day === today
      ? 'Today'
      : day === addDays(today, 1)
        ? 'Tomorrow'
        : new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
  if (occ.allDay) return `${dayText}, all day`;
  const time = (at: number) => new Date(at).toLocaleTimeString('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' });
  return occ.endMs > occ.startMs + MINUTE ? `${dayText} at ${time(occ.startMs)} to ${time(occ.endMs)}` : `${dayText} at ${time(occ.startMs)}`;
}

/** The nudge a reminder becomes. */
export function nudgeFor(d: Due, now: number) {
  const { occ, offset } = d;
  return {
    title: `📅 ${occ.title}`,
    body: [whenText(occ, now), occ.location].filter(Boolean).join(' · '),
    earliestAt: now,
    deadlineAt: occ.allDay ? null : Math.max(now, occ.startMs - Math.min(5 * MINUTE, Math.max(0, offset) * MINUTE)),
    expiresAt: occ.allDay ? occ.endMs : Math.max(occ.endMs, occ.startMs + 30 * MINUTE),
    minQuality: 'any' as const,
    accent: occ.color,
  };
}

let timer: NodeJS.Timeout | null = null;
let running = false;
let again = false;
let stopped = false;
let refreshLinks: ((now: number) => Promise<void>) | null = null;

/** The link refresher, handed in by `index.ts` so this file need not know how links are fetched. */
export function onWake(refresh: (now: number) => Promise<void>): void {
  refreshLinks = refresh;
}

/** Raise what is due. Inserts are awaited, so the store is read again before what was raised is written down. */
async function raiseDue(now: number): Promise<number | null> {
  let store: Store;
  try {
    store = read();
  } catch {
    return null;
  }
  const { due, next } = remindersDue(store, now);
  if (due.length) {
    const pushDefault = Boolean((await getSettings()).pushDefault);
    const made: [string, { at: number; nudge: string | null }][] = [];
    for (const d of due) {
      const [row] = await db
        .insert(nudges)
        .values({ ...nudgeFor(d, now), pushToPhone: resolvePush(null, pushDefault) ? 1 : 0 })
        .returning({ id: nudges.id });
      made.push([d.key, { at: d.at, nudge: row?.id ?? null }]);
    }
    const fresh = read();
    for (const [key, value] of made) fresh.raised[key] = value;
    for (const [key, value] of Object.entries(fresh.raised)) if (value.at < now - KEEP_RAISED) delete fresh.raised[key];
    write(fresh);
    changes.emitChange('nudges');
  }
  return next;
}

/** When the next link is due a refresh, or null with none. */
function nextLinkAt(store: Store): number | null {
  const links = store.calendars.filter((c) => c.kind === 'link' && !c.hidden);
  if (!links.length) return null;
  return Math.min(...links.map((c) => (c.triedAt ?? c.fetchedAt ?? 0) + LINK_STALE));
}

async function wake(): Promise<void> {
  if (running) {
    again = true;
    return;
  }
  running = true;
  timer = null;
  try {
    const now = Date.now();
    try {
      const store = read();
      const linkAt = nextLinkAt(store);
      if (refreshLinks && linkAt !== null && linkAt <= now) await refreshLinks(now);
    } catch {
      // A link that fails says so on its calendar; reminders go on.
    }
    const next = await raiseDue(Date.now());
    let linkAt: number | null = null;
    try {
      linkAt = nextLinkAt(read());
    } catch {
      linkAt = null;
    }
    arm([next, linkAt].filter((n): n is number => n !== null));
  } finally {
    running = false;
    if (again && !stopped) {
      again = false;
      void wake();
    }
  }
}

function arm(candidates: number[]): void {
  if (stopped) return;
  if (timer) clearTimeout(timer);
  const now = Date.now();
  const at = Math.min(now + MAX_SLEEP, ...candidates);
  timer = setTimeout(() => void wake(), Math.max(1_000, at - now));
  timer.unref();
}

/** Look now, and set the timer from what is found. Called at start and after every change. */
export function schedule(): void {
  stopped = false;
  void wake();
}

export function stop(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

/**
 * Take back an event's reminders still waiting to be shown, after it is
 * changed or deleted: a reminder for 3pm about a meeting moved to 5 is wrong,
 * and one for a meeting deleted is noise. Those are forgotten, so the event as
 * it is now is reminded of afresh; one already shown is left recorded, so
 * fixing a typo in a title does not remind you twice.
 */
export async function forgetEvent(eventIds: string[]): Promise<void> {
  if (!eventIds.length) return;
  let store: Store;
  try {
    store = read();
  } catch {
    return;
  }
  const prefixes = eventIds.map((id) => `${id}|`);
  const mine = Object.entries(store.raised).filter(([key]) => prefixes.some((p) => key.startsWith(p)));
  const ids = mine.map(([, v]) => v.nudge).filter((id): id is string => id !== null);
  if (!ids.length) return;
  const waiting = await db
    .select({ id: nudges.id })
    .from(nudges)
    .where(and(inArray(nudges.id, ids), inArray(nudges.state, ['pending', 'snoozed'])));
  if (!waiting.length) return;
  const gone = new Set(waiting.map((w) => w.id));
  await db
    .update(nudges)
    .set({ state: 'expired' })
    .where(inArray(nudges.id, [...gone]));
  const fresh = read();
  for (const [key, value] of Object.entries(fresh.raised)) if (value.nudge && gone.has(value.nudge)) delete fresh.raised[key];
  write(fresh);
  changes.emitChange('nudges');
}
