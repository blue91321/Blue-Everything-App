/**
 * Watching flights, and saying when one changes.
 *
 * ### The one timer in this package, and why it has to be one
 *
 * Everything else here is read when you look, like the weather and the friends
 * list. Delay alerts cannot be: a gate change is worth something only if it
 * reaches you while you are doing something else, which is the whole reason
 * there is a nudge engine. The same argument the coursework sync makes for its
 * half-hourly check.
 *
 * But it is a single `setTimeout` to the next moment a flight is due a look,
 * not an interval. With no flight inside a day of leaving it sleeps until the
 * first one is (re-armed at least every six hours, since a timeout cannot be
 * set years out and the clock can be changed); with no key it does nothing at
 * all. About twenty requests a flight, all inside that flight's day. See
 * `nextCheckAt` for the spacing.
 *
 * ### Held across the network, written against a fresh read
 *
 * A lookup is a request to somebody else's server, seconds at best, and the
 * manga sweep found what holding a store across that does: everything changed
 * meanwhile is overwritten. So the store is read again after the requests and
 * only the fields a lookup decides are copied across, onto flights that still
 * exist.
 */
import { db, nudges, getSettings, changes } from '@everything/server/module-api';
import { resolvePush } from '@everything/shared';
import { FlightServiceError, lookUp, type ServiceLeg } from './flights.js';
import { changesWorthSaying, nextCheckAt, spacedFlightNumber, URGENT_WITHIN, type LiveView } from './rules.js';
import { monthKey, read, usedThisMonth, write, type Flight, type Store } from './store.js';
import { syncTasks } from './tasks.js';

const HOUR = 3_600_000;

/** The times a flight is watched by: the best known, so a delayed flight is followed until it goes. */
export function watchable(f: Flight) {
  return {
    departs: f.live?.departs ?? f.departs,
    arrives: f.live?.arrives ?? f.arrives,
    checkedAt: f.checkedAt,
    status: f.live?.status ?? null,
  };
}

/** Of the legs flown under a number that day, the one this flight is. */
export function matchLeg(f: Flight, legs: ServiceLeg[]): ServiceLeg | null {
  return (
    legs.find((l) => l.from.iata === f.from.iata && l.to.iata === f.to.iata) ??
    legs.find((l) => l.from.iata === f.from.iata) ??
    (legs.length === 1 ? legs[0]! : null)
  );
}

const view = (f: Flight): LiveView | null =>
  f.live
    ? { status: f.live.status, departs: f.live.departs, arrives: f.live.arrives, gate: f.live.gate, terminal: f.live.terminal }
    : null;

/** "9:10 PM" at the departure airport, which is the clock the gate screen uses. */
export function timeAt(at: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(11, 16);
  }
}

type Outcome = { id: string; leg: ServiceLeg | null; error: string | null; at: number };

let running: Promise<boolean> | null = null;

/**
 * Ask about every flight that is due a look. Returns whether anything changed.
 *
 * `force` asks about the given flight now whatever the schedule says: the
 * screen's refresh button, which is still counted against the budget.
 */
export function refreshDue(force?: string): Promise<boolean> {
  // One at a time: the timer and a page open on the phone can both arrive here.
  if (running) return running.then(() => (force ? refreshDue(force) : false));
  running = run(force).finally(() => (running = null));
  return running;
}

async function run(force?: string): Promise<boolean> {
  const snapshot = read();
  const key = snapshot.apiKey;
  if (!key) return false;
  const now = Date.now();
  const due = snapshot.trips
    .flatMap((t) => t.flights)
    .filter((f) => f.id === force || (nextCheckAt(watchable(f)) ?? Infinity) <= now);
  if (due.length === 0) return false;

  const outcomes: Outcome[] = [];
  let calls = 0;
  for (const f of due) {
    if (usedThisMonth(snapshot) + calls >= snapshot.settings.monthlyBudget) {
      outcomes.push({ id: f.id, leg: null, error: `this month's ${snapshot.settings.monthlyBudget} lookups are used up`, at: now });
      continue;
    }
    calls += 1;
    try {
      const leg = matchLeg(f, await lookUp(key, f.number, f.date));
      outcomes.push({ id: f.id, leg, error: leg ? null : 'the flight service no longer lists this flight', at: Date.now() });
    } catch (error) {
      outcomes.push({ id: f.id, leg: null, error: error instanceof FlightServiceError ? error.message : 'the check failed', at: Date.now() });
    }
  }

  const store = read();
  const said: Array<{ f: Flight; lines: string[] }> = [];
  for (const o of outcomes) {
    const f = store.trips.flatMap((t) => t.flights).find((x) => x.id === o.id);
    if (!f) continue;
    f.checkedAt = o.at;
    f.checkError = o.error;
    if (!o.leg) continue;
    const before = view(f);
    f.live = o.leg.live;
    // The airline retiming the flight: the timetable moves, and the tasks follow it.
    f.departs = o.leg.departs;
    f.arrives = o.leg.arrives;
    f.airline = f.airline ?? o.leg.airline;
    const lines = changesWorthSaying(before, view(f)!, (at) => timeAt(at, f.from.tz));
    if (lines.length) said.push({ f, lines });
  }
  if (calls) store.usage = { month: monthKey(now), calls: usedThisMonth(store, now) + calls };

  const tasksMoved = await syncTasks(store);
  write(store);
  if (store.settings.alerts) await alert(said);
  if (tasksMoved) changes.emitChange('tasks');
  changes.emitChange('all');
  return true;
}

/** A nudge per changed flight, urgent when it leaves within three hours. */
async function alert(said: Array<{ f: Flight; lines: string[] }>): Promise<void> {
  if (said.length === 0) return;
  const pushDefault = Boolean((await getSettings()).pushDefault);
  const now = Date.now();
  for (const { f, lines } of said) {
    const departs = f.live?.departs ?? f.departs;
    await db.insert(nudges).values({
      title: `${spacedFlightNumber(f.number)} ${f.from.iata} → ${f.to.iata}`,
      body: lines.join('. '),
      taskId: f.tasks.leave.id ?? f.tasks.checkIn.id ?? null,
      earliestAt: now,
      /*
       * Close to leaving, a past deadline: the engine delivers it at once, into
       * a game if need be, because "your gate moved" twenty minutes after the
       * match ends is twenty minutes too late. Further out it waits for a good
       * moment like any reminder.
       */
      deadlineAt: departs - now < URGENT_WITHIN ? now : null,
      expiresAt: departs + HOUR,
      minQuality: 'any',
      pushToPhone: resolvePush(null, pushDefault) ? 1 : 0,
    });
  }
  changes.emitChange('nudges');
}

/* ---------------------------------------------------------------- */

let timer: NodeJS.Timeout | null = null;
const LONGEST_SLEEP = 6 * HOUR;

/** When the next look is due across every flight, or null for nothing to watch. */
export function nextDue(store: Store): number | null {
  if (!store.apiKey) return null;
  let soonest: number | null = null;
  for (const f of store.trips.flatMap((t) => t.flights)) {
    const at = nextCheckAt(watchable(f));
    if (at !== null && (soonest === null || at < soonest)) soonest = at;
  }
  return soonest;
}

/** Arm the one timer for the next look. Called at boot and after anything that changes what is watched. */
export function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  let store: Store;
  try {
    store = read();
  } catch {
    return;
  }
  const at = nextDue(store);
  if (at === null) return;
  const wait = Math.max(5_000, Math.min(at - Date.now(), LONGEST_SLEEP));
  timer = setTimeout(() => {
    timer = null;
    void refreshDue()
      .catch(() => false)
      .finally(schedule);
  }, wait);
  timer.unref();
}

export function stop(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
