/**
 * The calendar: your own events, calendars read from a link (Google, Outlook,
 * Apple, any secret iCal address), `.ics` files imported, and reminders
 * before each event through the nudge queue.
 *
 * Every route answers any paired device: a calendar is your data, like a task.
 * Fetching a link is held to the rules in `link.ts`. Routes announce under the
 * package's own scope (`calendar`), so a change here reloads the calendar's
 * readers and not every screen.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { changes, type ChangeScope } from '@everything/server/module-api';
import { looksLikeIcs, parseIcs } from './ics.js';
import { fetchLink, LinkRefused, maskLink } from './link.js';
import { mergeEvents } from './merge.js';
import { occurrencesIn } from './occurrences.js';
import { cleanRepeat } from './recur.js';
import { forgetEvent, LINK_STALE, onWake, schedule, stop } from './reminders.js';
import { cleanEvent, cleanOffsets, cleanReminders, COLORS, defaultCalendar, newId, read, StoreUnreadable, write, type CalEvent, type Calendar, type Store } from './store.js';
import { addDays, dateOf, DATE, DATETIME, DAY, isZone, serverZone } from './time.js';
import { dueTasks, TASK_LAYERS, type TaskLayer } from './tasks.js';

const SCOPE = 'calendar' as ChangeScope;
const QUIET = { config: { announce: false } };
/** A link is fetched again on a read once it is this old. The timer does it every six hours regardless. */
const READ_STALE = 60 * 60 * 1000;
const MAX_WINDOW = 400 * DAY;

type Body = Record<string, unknown> | null;
const str = (v: unknown, max = 300): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

class Refused extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof Refused) return reply.code(error.status).send({ error: error.message });
  if (error instanceof LinkRefused) return reply.code(400).send({ error: error.message });
  if (error instanceof StoreUnreadable) return reply.code(500).send({ error: error.message });
  throw error;
}

function announce(): void {
  changes.emitChange(SCOPE);
}

/** A calendar as a screen sees it: the link's secret part hidden. */
const shown = (c: Calendar, store: Store) => ({
  id: c.id,
  name: c.name,
  color: c.color,
  kind: c.kind,
  link: c.url ? maskLink(c.url) : null,
  fetchedAt: c.fetchedAt,
  error: c.error,
  hidden: c.hidden,
  remind: c.remind,
  events: store.events.filter((e) => e.calendarId === c.id).length,
});

function calendarOf(store: Store, id: string): Calendar {
  const cal = store.calendars.find((c) => c.id === id);
  if (!cal) throw new Refused('no such calendar', 404);
  return cal;
}

function eventOf(store: Store, id: string): CalEvent {
  const ev = store.events.find((e) => e.id === id);
  if (!ev) throw new Refused('no such event', 404);
  return ev;
}

/* ---- links ---- */

const fetching = new Map<string, Promise<void>>();

/** Fetch one link calendar again and replace its events. Failures are written on the calendar, never thrown. */
function refreshCalendar(id: string): Promise<void> {
  const already = fetching.get(id);
  if (already) return already;
  const job = (async () => {
    const before = read().calendars.find((c) => c.id === id);
    if (!before || before.kind !== 'link' || !before.url) return;
    const now = Date.now();
    let text: string | null = null;
    let error: string | null = null;
    try {
      text = await fetchLink(before.url);
    } catch (e) {
      error = (e as Error).message;
    }
    const store = read();
    const cal = store.calendars.find((c) => c.id === id);
    if (!cal) return;
    cal.triedAt = now;
    let changed: string[] = [];
    if (text !== null) {
      const parsed = parseIcs(text);
      const merged = mergeEvents(store.events, id, parsed.events, 'replace', newId);
      store.events = merged.events;
      changed = merged.changed;
      cal.fetchedAt = now;
      cal.error = null;
    } else {
      cal.error = error;
    }
    write(store);
    announce();
    if (changed.length) await forgetEvent(changed);
  })().finally(() => fetching.delete(id));
  fetching.set(id, job);
  return job;
}

/** Every link due a look, one at a time. */
async function refreshStale(now: number, olderThan: number): Promise<void> {
  const due = read().calendars.filter((c) => c.kind === 'link' && !c.hidden && (c.triedAt ?? c.fetchedAt ?? 0) + olderThan <= now);
  for (const c of due) await refreshCalendar(c.id);
}

/* ---- events from a screen ---- */

/** The fields a screen may set on an event, checked. `base` fills what was not sent. */
function eventFrom(body: Body, base: CalEvent): CalEvent {
  const b = body ?? {};
  const allDay = typeof b.allDay === 'boolean' ? b.allDay : base.allDay;
  const tz = typeof b.tz === 'string' && isZone(b.tz) ? b.tz : base.tz;
  const start = typeof b.start === 'string' ? b.start : base.start;
  const end = typeof b.end === 'string' ? b.end : base.end;
  if (!(allDay ? DATE : DATETIME).test(start)) throw new Refused(allDay ? 'an all-day event starts on a date' : 'an event starts at a date and a time');
  if (!(allDay ? DATE : DATETIME).test(end)) throw new Refused('the end is not a date and time');
  if (end < start) throw new Refused('it ends before it starts');
  const next = cleanEvent({
    ...base,
    title: 'title' in b ? (str(b.title) ?? '') : base.title,
    location: 'location' in b ? str(b.location, 500) : base.location,
    notes: 'notes' in b ? str(b.notes, 10_000) : base.notes,
    allDay,
    start,
    end: allDay && end === start ? addDays(start, 1) : end,
    tz,
    repeat: 'repeat' in b ? cleanRepeat(b.repeat) : base.repeat,
    remind: 'remind' in b ? (b.remind === null ? null : cleanOffsets(b.remind)) : base.remind,
  });
  if (!next) throw new Refused('that is not an event');
  if (next.title === '(no title)' && !str(b.title) && 'title' in b) throw new Refused('an event needs a name');
  return next;
}

/**
 * Taken-out days moved with a series whose start moved: they are walls, so a
 * weekly 3pm with the 16th taken out, moved to 10am, takes out 10am on the
 * 16th. Moved by the same wall-clock distance; dropped if the event changed
 * between all day and a time, where there is nothing to match them to.
 */
export function shiftSkips(skip: string[], from: string, to: string): string[] {
  if (from === to) return skip;
  if (from.length !== to.length) return [];
  const ms = (wall: string) => Date.parse(`${wall.length === 10 ? `${wall}T00:00` : wall}:00Z`);
  const delta = ms(to) - ms(from);
  return skip.map((s) => {
    const moved = new Date(ms(s) + delta).toISOString();
    return to.length === 10 ? moved.slice(0, 10) : moved.slice(0, 16);
  });
}

/** The day before an occurrence, as the last a series may run to when it is cut there. */
const untilBefore = (ev: CalEvent, occurrence: string): string => (ev.allDay ? addDays(dateOf(occurrence), -1) : `${addDays(dateOf(occurrence), -1)}T23:59`);

export async function routes(app: FastifyInstance): Promise<void> {
  onWake((now) => refreshStale(now, LINK_STALE));
  schedule();
  app.addHook('onClose', async () => stop());

  // ---------------------------------------------------------------- reading

  app.get('/api/calendar', async (request, reply) => {
    try {
      const q = request.query as { from?: string; to?: string };
      const now = Date.now();
      const from = Number(q.from) || now - 7 * DAY;
      const to = Math.min(Number(q.to) || now + 35 * DAY, from + MAX_WINDOW);
      const store = read();
      // A link not looked at for an hour is fetched in the background; the screen hears when it lands.
      void refreshStale(now, READ_STALE).catch(() => undefined);
      return {
        zone: serverZone(),
        calendars: store.calendars.map((c) => shown(c, store)),
        occurrences: occurrencesIn(store.events, store.calendars, store.reminders, from, to),
        reminders: store.reminders,
        due: await dueTasks(from, to, store.taskLayer),
        taskLayer: store.taskLayer,
      };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/calendar/upcoming', async (request, reply) => {
    try {
      const q = request.query as { days?: string };
      // Up to six weeks: the week card shows up to four, from up to a week back (its week may start on last Sunday).
      const days = Math.max(1, Math.min(42, Number(q.days) || 7));
      const now = Date.now();
      // From the start of the card's first day on the screen's clock when it says so, so the week card can show what already happened.
      const asked = Number((q as { from?: string }).from);
      const from = Number.isFinite(asked) && asked <= now && asked > now - 8 * DAY ? asked : now;
      const to = from + days * DAY;
      const store = read();
      void refreshStale(now, READ_STALE).catch(() => undefined);
      return {
        occurrences: occurrencesIn(store.events, store.calendars, store.reminders, from, to).slice(0, 400),
        reminders: store.reminders,
        calendars: store.calendars.length,
        due: await dueTasks(from, to, store.taskLayer),
        taskLayer: store.taskLayer,
      };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/calendar/events/:id', async (request, reply) => {
    try {
      const store = read();
      const ev = eventOf(store, (request.params as { id: string }).id);
      const cal = calendarOf(store, ev.calendarId);
      return { ...ev, readOnly: cal.kind !== 'own' };
    } catch (error) {
      return fail(reply, error);
    }
  });

  // ---------------------------------------------------------------- calendars

  app.post('/api/calendar/calendars', QUIET, async (request, reply) => {
    try {
      const body = request.body as Body;
      const store = read();
      const cal: Calendar = {
        id: newId(),
        name: str(body?.name, 100) ?? 'Calendar',
        color: typeof body?.color === 'string' && /^#[0-9a-f]{6}$/i.test(body.color) ? body.color : COLORS[store.calendars.length % COLORS.length]!,
        kind: 'own',
        url: null,
        fetchedAt: null,
        triedAt: null,
        error: null,
        hidden: false,
        remind: null,
      };
      store.calendars.push(cal);
      write(store);
      announce();
      return shown(cal, store);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.put('/api/calendar/calendars/:id', QUIET, async (request, reply) => {
    try {
      const body = (request.body as Body) ?? {};
      const store = read();
      const cal = calendarOf(store, (request.params as { id: string }).id);
      if ('name' in body) cal.name = str(body.name, 100) ?? cal.name;
      if (typeof body.color === 'string' && /^#[0-9a-f]{6}$/i.test(body.color)) cal.color = body.color;
      const hiding = typeof body.hidden === 'boolean' && body.hidden && !cal.hidden;
      if (typeof body.hidden === 'boolean') cal.hidden = body.hidden;
      if ('remind' in body) cal.remind = body.remind === null ? null : cleanOffsets(body.remind);
      write(store);
      announce();
      const ids = store.events.filter((e) => e.calendarId === cal.id).map((e) => e.id);
      if (hiding || 'remind' in body) await forgetEvent(ids);
      schedule();
      return shown(cal, store);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete('/api/calendar/calendars/:id', QUIET, async (request, reply) => {
    try {
      const store = read();
      const cal = calendarOf(store, (request.params as { id: string }).id);
      if (cal.kind === 'own' && store.calendars.filter((c) => c.kind === 'own').length === 1) {
        throw new Refused('This is your only calendar of your own, so it stays. Delete its events instead.');
      }
      const ids = store.events.filter((e) => e.calendarId === cal.id).map((e) => e.id);
      await forgetEvent(ids);
      const fresh = read();
      fresh.calendars = fresh.calendars.filter((c) => c.id !== cal.id);
      fresh.events = fresh.events.filter((e) => e.calendarId !== cal.id);
      write(fresh);
      announce();
      return { ok: true };
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** A calendar read from a link. Fetched first, so a link that does not work is never saved. */
  app.post('/api/calendar/links', QUIET, async (request, reply) => {
    try {
      const body = request.body as Body;
      const url = str(body?.url, 2000);
      if (!url) throw new Refused('paste the calendar link');
      const text = await fetchLink(url).catch((e: Error) => {
        if (e instanceof LinkRefused) throw e;
        throw new Refused(e.message, 502);
      });
      const parsed = parseIcs(text);
      const store = read();
      if (store.calendars.some((c) => c.url === url)) throw new Refused('That calendar is already here.');
      const cal: Calendar = {
        id: newId(),
        name: str(body?.name, 100) ?? parsed.name ?? 'Linked calendar',
        color: COLORS[store.calendars.length % COLORS.length]!,
        kind: 'link',
        url,
        fetchedAt: Date.now(),
        triedAt: Date.now(),
        error: null,
        hidden: false,
        remind: null,
      };
      store.calendars.push(cal);
      store.events = mergeEvents(store.events, cal.id, parsed.events, 'replace', newId).events;
      write(store);
      announce();
      schedule();
      return { calendar: shown(cal, store), problems: parsed.problems };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/calendar/calendars/:id/refresh', QUIET, async (request, reply) => {
    try {
      const id = (request.params as { id: string }).id;
      const cal = calendarOf(read(), id);
      if (cal.kind !== 'link') throw new Refused('only a linked calendar is fetched');
      await refreshCalendar(id);
      schedule();
      const store = read();
      return shown(calendarOf(store, id), store);
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * An `.ics` file: read and described first, nothing written, so a file that
   * is not what you thought costs a click; then `commit` puts its events into
   * one of your calendars (or a new one named after the file), merged by UID.
   */
  app.post('/api/calendar/import', { ...QUIET, bodyLimit: 12 * 1024 * 1024 }, async (request, reply) => {
    try {
      const body = request.body as Body;
      const text = typeof body?.text === 'string' ? body.text : '';
      if (!looksLikeIcs(text)) throw new Refused('That is not a calendar file (.ics).');
      const parsed = parseIcs(text);
      if (!body?.commit) {
        const starts = parsed.events.map((e) => dateOf(e.start)).sort();
        return {
          name: parsed.name,
          events: parsed.events.length,
          repeating: parsed.events.filter((e) => e.repeat).length,
          first: starts[0] ?? null,
          last: starts.at(-1) ?? null,
          sample: parsed.events.slice(0, 5).map((e) => ({ title: e.title, start: e.start, allDay: e.allDay })),
          problems: parsed.problems,
        };
      }
      const store = read();
      let target: Calendar;
      if (body.into === 'new' || !body.into) {
        target = {
          id: newId(),
          name: str(body.name, 100) ?? parsed.name ?? 'Imported',
          color: COLORS[store.calendars.length % COLORS.length]!,
          kind: 'own',
          url: null,
          fetchedAt: null,
          triedAt: null,
          error: null,
          hidden: false,
          remind: null,
        };
        store.calendars.push(target);
      } else {
        target = calendarOf(store, String(body.into));
        if (target.kind !== 'own') throw new Refused('A linked calendar shows only what its link says, so a file goes into one of your own.');
      }
      const merged = mergeEvents(store.events, target.id, parsed.events, 'merge', newId);
      store.events = merged.events;
      write(store);
      announce();
      if (merged.changed.length) await forgetEvent(merged.changed);
      schedule();
      return { calendar: shown(target, store), ...merged.count, problems: parsed.problems };
    } catch (error) {
      return fail(reply, error);
    }
  });

  // ---------------------------------------------------------------- events

  app.post('/api/calendar/events', QUIET, async (request, reply) => {
    try {
      const body = request.body as Body;
      const store = read();
      const cal = body?.calendarId ? calendarOf(store, String(body.calendarId)) : defaultCalendar(store);
      if (cal.kind !== 'own') throw new Refused('A linked calendar is read-only here; add it to one of your own.');
      const id = newId();
      const base: CalEvent = {
        id,
        calendarId: cal.id,
        uid: `${id}@blue-everything`,
        title: '',
        location: null,
        notes: null,
        allDay: false,
        start: '',
        end: '',
        tz: serverZone(),
        repeat: null,
        skip: [],
        remind: null,
      };
      const ev = eventFrom(body, base);
      store.events.push(ev);
      write(store);
      announce();
      schedule();
      return ev;
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * Change an event. `scope` decides what a change to a repeating one means:
   * `all` (the series), `one` (this occurrence, taken out and made an event of
   * its own) or `following` (this one and later: the series ends the day
   * before, and a new one starts here). `occurrence` is that occurrence's start.
   *
   * A linked calendar's event is the link's to change, so only its reminder
   * times can be set here (`remind`, kept across refreshes).
   */
  app.put('/api/calendar/events/:id', QUIET, async (request, reply) => {
    try {
      const body = (request.body as Body) ?? {};
      const q = request.query as { scope?: string; occurrence?: string };
      const store = read();
      const ev = eventOf(store, (request.params as { id: string }).id);
      const cal = calendarOf(store, ev.calendarId);
      if (cal.kind !== 'own') {
        if (Object.keys(body).some((k) => k !== 'remind')) throw new Refused('A linked calendar is read-only here: change it where it comes from. Its reminders can be set here.');
        ev.remind = body.remind === null ? null : cleanOffsets(body.remind);
        write(store);
        announce();
        await forgetEvent([ev.id]);
        schedule();
        return ev;
      }
      const scope = q.scope === 'one' || q.scope === 'following' ? q.scope : 'all';
      const occurrence = typeof q.occurrence === 'string' && (DATE.test(q.occurrence) || DATETIME.test(q.occurrence)) ? q.occurrence : null;
      let result: CalEvent;
      if (!ev.repeat || scope === 'all' || !occurrence || (scope === 'following' && occurrence === ev.start)) {
        result = eventFrom(body, ev);
        result.skip = shiftSkips(ev.skip, ev.start, result.start);
        Object.assign(ev, result);
        // Moved to another of your calendars.
        if (typeof body.calendarId === 'string' && body.calendarId !== ev.calendarId) {
          const to = calendarOf(store, body.calendarId);
          if (to.kind !== 'own') throw new Refused('A linked calendar is read-only here.');
          ev.calendarId = to.id;
        }
      } else if (scope === 'one') {
        ev.skip = [...new Set([...ev.skip, occurrence])];
        const id = newId();
        result = eventFrom({ ...body, repeat: null }, { ...ev, id, uid: `${ev.uid}#${occurrence}`, repeat: null, skip: [] });
        store.events.push(result);
      } else {
        const id = newId();
        result = eventFrom(body, { ...ev, id, uid: `${id}@blue-everything`, skip: [] });
        result.skip = shiftSkips(
          ev.skip.filter((s) => s >= occurrence),
          occurrence,
          result.start
        );
        // Counted from here, a series with a count would run long; the new one gets the rest of no count, the old its own up to here.
        if (result.repeat?.count) delete result.repeat.count;
        ev.repeat = { ...ev.repeat, until: untilBefore(ev, occurrence) };
        delete ev.repeat.count;
        ev.skip = ev.skip.filter((s) => s < occurrence);
        store.events.push(result);
      }
      write(store);
      announce();
      await forgetEvent([ev.id]);
      schedule();
      return result;
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete('/api/calendar/events/:id', QUIET, async (request, reply) => {
    try {
      const q = request.query as { scope?: string; occurrence?: string };
      const store = read();
      const ev = eventOf(store, (request.params as { id: string }).id);
      if (calendarOf(store, ev.calendarId).kind !== 'own') throw new Refused('A linked calendar is read-only here: delete it where it comes from.');
      const occurrence = typeof q.occurrence === 'string' && (DATE.test(q.occurrence) || DATETIME.test(q.occurrence)) ? q.occurrence : null;
      if (ev.repeat && occurrence && q.scope === 'one') {
        ev.skip = [...new Set([...ev.skip, occurrence])];
      } else if (ev.repeat && occurrence && q.scope === 'following' && occurrence > ev.start) {
        ev.repeat = { ...ev.repeat, until: untilBefore(ev, occurrence) };
        delete ev.repeat.count;
      } else {
        store.events = store.events.filter((e) => e.id !== ev.id);
      }
      write(store);
      announce();
      await forgetEvent([ev.id]);
      schedule();
      return { ok: true };
    } catch (error) {
      return fail(reply, error);
    }
  });

  // ---------------------------------------------------------------- tasks

  app.put('/api/calendar/task-layer', QUIET, async (request, reply) => {
    try {
      const layer = ((request.body as Body) ?? {}).layer;
      if (!TASK_LAYERS.includes(layer as TaskLayer)) throw new Refused('layer is all, synced or none');
      const store = read();
      store.taskLayer = layer as TaskLayer;
      write(store);
      announce();
      return { taskLayer: store.taskLayer };
    } catch (error) {
      return fail(reply, error);
    }
  });

  // ---------------------------------------------------------------- reminders

  app.put('/api/calendar/reminders', QUIET, async (request, reply) => {
    try {
      const body = (request.body as Body) ?? {};
      const store = read();
      const before = store.reminders;
      store.reminders = cleanReminders({
        asked: typeof body.asked === 'boolean' ? body.asked : before.asked,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : before.enabled,
        timed: 'timed' in body ? (body.timed as number[]) : before.timed,
        allDay: 'allDay' in body ? (body.allDay as number[]) : before.allDay,
      });
      write(store);
      announce();
      // Switched off: what is waiting is taken back, as switching manga's chapter nudges off does.
      if (before.enabled && !store.reminders.enabled) await forgetEvent(store.events.map((e) => e.id));
      schedule();
      return store.reminders;
    } catch (error) {
      return fail(reply, error);
    }
  });
}
