/**
 * What each change made offline does, here, before the server has seen it.
 *
 * Each one edits the saved reads the way the server would edit the database,
 * near enough to show at once — a ticked habit's count goes up, a finished task
 * moves under Finished — and answers the way the route would have. When the
 * outbox is replayed the server's own answer replaces all of it, so these only
 * have to be right until then, and they err towards the obvious reading.
 *
 * Registered for exactly the changes worth making on a train. Anything else —
 * rearranging note folders, anything to do with devices or packages — has no
 * entry, so it is refused with "needs the PC" rather than queued invisibly.
 */
import type { Habit, Note, NoteDetail, Nudge, Task } from './api';
import { patchSaved, putSaved, registerOfflineEffect } from './offline-sync';

const bare = (path: string) => path.split('?')[0]!;
const query = (path: string) => new URL(path, 'http://x').searchParams;

/* ---- tasks ---- */

const isTaskList = (path: string) => bare(path) === '/api/tasks';
/** Which statuses a saved task list holds, from its `?status=` — all of them if none. */
const listHolds = (path: string, status: string) => {
  const wanted = query(path).get('status');
  return !wanted || wanted.split(',').includes(status);
};

function taskFromInput(body: Record<string, any>, base: Partial<Task>, at: number): Partial<Task> {
  const next: Partial<Task> = { ...base };
  for (const key of ['title', 'notes', 'priority', 'dueAt', 'status'] as const) {
    if (key in body) (next as any)[key] = body[key];
  }
  if ('dueIsAllDay' in body) next.dueIsAllDay = body.dueIsAllDay ? 1 : 0;
  if ('pushToPhone' in body) next.pushToPhone = body.pushToPhone === null ? null : body.pushToPhone ? 1 : 0;
  if ('status' in body) next.completedAt = body.status === 'done' ? at : null;
  return next;
}

registerOfflineEffect({
  method: 'POST',
  pattern: /^\/api\/tasks$/,
  label: 'Add a task',
  creates: true,
  apply: async ({ body, at, tempId }) => {
    const task = taskFromInput(
      body,
      {
        id: tempId,
        title: '',
        notes: null,
        status: 'todo',
        priority: 0,
        dueAt: null,
        dueIsAllDay: 0,
        pushToPhone: null,
        projectId: null,
        createdAt: at,
        completedAt: null,
        source: null,
        sourceUrl: null,
      },
      at
    ) as Task;
    await patchSaved(isTaskList, (list: Task[], path) => (listHolds(path, task.status) ? [task, ...list] : list));
    return task;
  },
});

registerOfflineEffect({
  method: 'PATCH',
  pattern: /^\/api\/tasks\/([^/]+)$/,
  label: 'Change a task',
  creates: false,
  apply: async ({ match, body, at }) => {
    const id = match[1]!;
    let found: Task | null = null;
    await patchSaved(isTaskList, (list: Task[]) => {
      const hit = list.find((t) => t.id === id);
      if (hit) found = hit;
      return list;
    });
    const updated = taskFromInput(body, found ?? { id }, at) as Task;
    await patchSaved(isTaskList, (list: Task[], path) => {
      const without = list.filter((t) => t.id !== id);
      return listHolds(path, updated.status) ? [...without, updated] : without;
    });
    return updated;
  },
});

registerOfflineEffect({
  method: 'DELETE',
  pattern: /^\/api\/tasks\/([^/]+)$/,
  label: 'Delete a task',
  creates: false,
  apply: async ({ match }) => {
    await patchSaved(isTaskList, (list: Task[]) => list.filter((t) => t.id !== match[1]));
    return undefined;
  },
});

/* ---- habits ---- */

const isHabitList = (path: string) => bare(path) === '/api/habits';

/**
 * The server's rules, approximately: finished when a target is met or an
 * interval was done today; a gauge is never finished and wants doing at or
 * below its threshold. The server's own answer replaces this on sync.
 */
function settle(h: Habit): Habit {
  const mode = h.mode ?? 'target';
  if (mode === 'gauge') {
    return { ...h, met: false, wantsDoing: (h.gaugeNow ?? 0) <= (h.gaugeRemindAt ?? 0) };
  }
  if (mode === 'interval') {
    return { ...h, met: h.doneThisPeriod > 0, wantsDoing: h.doneThisPeriod === 0 };
  }
  const met = h.doneThisPeriod >= h.targetPerPeriod;
  return { ...h, met, wantsDoing: !met };
}

async function changeHabit(id: string, change: (h: Habit) => Habit): Promise<Habit | null> {
  let result: Habit | null = null;
  await patchSaved(isHabitList, (list: Habit[]) =>
    list.map((h) => {
      if (h.id !== id) return h;
      result = settle(change(h));
      return result;
    })
  );
  return result;
}

const progress = (h: Habit | null, id: string) => ({
  habitId: id,
  doneThisPeriod: h?.doneThisPeriod ?? 0,
  gaugeNow: h?.gaugeNow ?? null,
  met: h?.met ?? false,
  wantsDoing: h?.wantsDoing ?? false,
});

registerOfflineEffect({
  method: 'POST',
  pattern: /^\/api\/habits\/([^/]+)\/check$/,
  label: 'Tick a habit',
  creates: false,
  apply: async ({ match, at }) => {
    const h = await changeHabit(match[1]!, (h) => ({
      ...h,
      doneThisPeriod: h.doneThisPeriod + 1,
      lastDoneAt: at,
      ...(h.mode === 'gauge' ? { gaugeNow: Math.min(100, (h.gaugeNow ?? 0) + (h.gaugeFillPercent ?? 100)) } : {}),
    }));
    return progress(h, match[1]!);
  },
});

registerOfflineEffect({
  method: 'POST',
  pattern: /^\/api\/habits\/([^/]+)\/uncheck$/,
  label: 'Untick a habit',
  creates: false,
  apply: async ({ match }) => {
    const h = await changeHabit(match[1]!, (h) => ({
      ...h,
      doneThisPeriod: Math.max(0, h.doneThisPeriod - 1),
      ...(h.mode === 'gauge' ? { gaugeNow: Math.max(0, (h.gaugeNow ?? 0) - (h.gaugeFillPercent ?? 100)) } : {}),
    }));
    return { ...progress(h, match[1]!), removed: 1 };
  },
});

registerOfflineEffect({
  method: 'PUT',
  pattern: /^\/api\/habits\/([^/]+)\/value$/,
  label: 'Set a habit’s tally',
  creates: false,
  apply: async ({ match, body }) => {
    const value = Number(body.value) || 0;
    const h = await changeHabit(match[1]!, (h) =>
      h.mode === 'gauge' ? { ...h, gaugeNow: Math.min(100, value) } : { ...h, doneThisPeriod: value }
    );
    return progress(h, match[1]!);
  },
});

registerOfflineEffect({
  method: 'PATCH',
  pattern: /^\/api\/habits\/([^/]+)$/,
  label: 'Edit a habit',
  creates: false,
  apply: async ({ match, body }) => {
    const h = await changeHabit(match[1]!, (h) => {
      const next: any = { ...h, ...body };
      if ('active' in body) next.active = body.active ? 1 : 0;
      if ('pushToPhone' in body) next.pushToPhone = body.pushToPhone === null ? null : body.pushToPhone ? 1 : 0;
      return next as Habit;
    });
    return h ?? { id: match[1] };
  },
});

registerOfflineEffect({
  method: 'POST',
  pattern: /^\/api\/habits\/reorder$/,
  label: 'Reorder habits',
  creates: false,
  apply: async ({ body }) => {
    const order: string[] = Array.isArray(body.ids) ? body.ids : [];
    await patchSaved(isHabitList, (list: Habit[]) =>
      list
        .map((h) => ({ ...h, sortOrder: order.includes(h.id) ? order.indexOf(h.id) : h.sortOrder }))
        .sort((a, b) => a.sortOrder - b.sortOrder)
    );
    return { ok: true, count: order.length };
  },
});

/* ---- notes ---- */

const isNoteList = (path: string) => bare(path) === '/api/notes';
/** Whether a saved note list would include a note in this folder: all notes, or that folder's. */
const listShows = (path: string, folder: string) => {
  const q = query(path);
  if (q.get('tag') || q.get('q')) return false; // searches are not guessed at
  return !q.has('folder') || q.get('folder') === folder;
};

const firstLine = (body: string) =>
  body.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean)?.slice(0, 120) ?? 'Untitled';

function asNote(detail: NoteDetail): Note {
  const { body: _b, backlinks: _l, outgoing: _o, files: _f, ...note } = detail;
  return note;
}

registerOfflineEffect({
  method: 'POST',
  pattern: /^\/api\/notes$/,
  label: 'Write a note',
  creates: true,
  apply: async ({ body, at, tempId }) => {
    const text = typeof body.body === 'string' ? body.body : '';
    const folder = typeof body.folder === 'string' ? body.folder : '';
    const detail: NoteDetail = {
      id: tempId,
      title: body.title || firstLine(text),
      storedTitle: body.title ?? null,
      folder,
      pinned: 0,
      preview: text.slice(0, 200),
      createdAt: at,
      updatedAt: at,
      body: text,
      backlinks: [],
      outgoing: [],
      files: [],
    };
    await putSaved(`/api/notes/${tempId}`, detail);
    await patchSaved(isNoteList, (list: Note[], path) => (listShows(path, folder) ? [asNote(detail), ...list] : list));
    return asNote(detail);
  },
});

registerOfflineEffect({
  method: 'PATCH',
  pattern: /^\/api\/notes\/([^/]+)$/,
  label: 'Edit a note',
  creates: false,
  apply: async ({ match, body, at }) => {
    const id = match[1]!;
    let detail: NoteDetail | null = null;
    await patchSaved(
      (path) => path === `/api/notes/${id}`,
      (d: NoteDetail) => {
        const text = typeof body.body === 'string' ? body.body : d.body;
        detail = {
          ...d,
          ...('title' in body ? { storedTitle: body.title ?? null } : {}),
          title: ('title' in body ? body.title : d.storedTitle) || firstLine(text),
          ...('folder' in body && typeof body.folder === 'string' ? { folder: body.folder } : {}),
          ...('pinned' in body ? { pinned: body.pinned ? 1 : 0 } : {}),
          body: text,
          preview: text.slice(0, 200),
          updatedAt: at,
        };
        return detail;
      }
    );
    const note = detail ? asNote(detail) : null;
    await patchSaved(isNoteList, (list: Note[], path) => {
      const without = list.filter((n) => n.id !== id);
      if (!note) return list;
      return listShows(path, note.folder) ? [note, ...without] : without;
    });
    return note ?? { id };
  },
});

registerOfflineEffect({
  method: 'DELETE',
  pattern: /^\/api\/notes\/([^/]+)$/,
  label: 'Delete a note',
  creates: false,
  apply: async ({ match }) => {
    const id = match[1]!;
    await patchSaved((path) => path === `/api/notes/${id}`, () => undefined);
    await patchSaved(isNoteList, (list: Note[]) => list.filter((n) => n.id !== id));
    return undefined;
  },
});

/* ---- nudges ---- */

for (const [what, label] of [
  ['dismiss', 'Dismiss a reminder'],
  ['snooze', 'Snooze a reminder'],
] as const) {
  registerOfflineEffect({
    method: 'POST',
    pattern: new RegExp(`^/api/nudges/([^/]+)/${what}$`),
    label,
    creates: false,
    apply: async ({ match }) => {
      await patchSaved(
        (path) => bare(path) === '/api/nudges/queue',
        (list: Nudge[]) => list.filter((n) => n.id !== match[1])
      );
      return { ok: true };
    },
  });
}

/* ---- settings ---- */

registerOfflineEffect({
  method: 'PATCH',
  pattern: /^\/api\/settings$/,
  label: 'Change a setting',
  creates: false,
  apply: async ({ body }) => {
    let merged: unknown = body;
    await patchSaved(
      (path) => bare(path) === '/api/settings',
      (s: Record<string, unknown>) => {
        // The rows hold booleans as 0/1, which is what the screens compare against.
        const next: Record<string, unknown> = { ...s };
        for (const [k, v] of Object.entries(body)) next[k] = typeof v === 'boolean' ? (v ? 1 : 0) : v;
        merged = next;
        return next;
      }
    );
    return merged;
  },
});
