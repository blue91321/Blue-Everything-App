import { Fragment, Suspense, useEffect, type ReactNode } from 'react';
import { api, type Nudge, type Task } from '../api';
import { useAsync } from '../useAsync';
import { refreshEvery } from '../live';
import { useSettling } from '../useSettling';
import { clockTime, endOfToday, relative, startOfToday } from '../format';
import { goTo } from '../nav';
import { chosenPanels, resolvePanel } from '../panels';
import { chosenBlocks, isCoreBlock } from '../blocks';
import { featureEnabled } from '../features';
import { TaskRow, HabitRow } from '../rows';
import { Capture } from './Capture';

/**
 * The landing screen: capture something, see what's waiting to interrupt you,
 * see what's actually due, and see what you've already finished.
 *
 * Optionally with a second column — see `SidePanel`.
 */
export function Dashboard() {
  // 'done' is included so finished items can be shown rather than vanishing.
  const tasks = useAsync(() => api.tasks.list('todo,doing,done'), [], ['tasks']);
  const queue = useAsync(() => api.nudges.queue(), [], ['nudges', 'tasks', 'habits']);
  const habits = useAsync(() => api.habits.list(), [], ['habits']);
  const settling = useSettling();

  const reloadAll = () => {
    tasks.reload();
    queue.reload();
    habits.reload();
  };

  const all = tasks.data ?? [];
  // A settling task counts as open, so it stays put for its moment.
  const open = all.filter((t) => t.status !== 'done' || settling.has(t.id));
  const finished = all.filter(
    (t) => t.status === 'done' && !settling.has(t.id) && (t.completedAt ?? 0) >= startOfToday()
  );

  const byDue = (a: Task, b: Task) => (a.dueAt ?? 0) - (b.dueAt ?? 0);
  const dueToday = open.filter((t) => t.dueAt !== null && t.dueAt <= endOfToday()).sort(byDue);
  const upcoming = open.filter((t) => t.dueAt !== null && t.dueAt > endOfToday()).sort(byDue);
  const anytime = open.filter((t) => t.dueAt === null);

  const allHabits = habits.data ?? [];
  const habitsLeft = allHabits.filter((h) => h.active && (!h.met || settling.has(h.id)));
  const habitsDone = allHabits.filter((h) => h.active && h.met && !settling.has(h.id));

  // Anything due today that hasn't entered the queue yet still *will* nudge —
  // saying "nothing queued" while a task is due in two hours is a lie.
  const queuedTaskIds = new Set((queue.data ?? []).map((n) => n.taskId).filter(Boolean));
  const willQueue = dueToday.filter((t) => !queuedTaskIds.has(t.id) && t.status !== 'done');

  const nothingPending = (queue.data?.length ?? 0) === 0 && willQueue.length === 0;

  /*
   * Read here rather than passed down from `App`, which does not fetch settings.
   * `useAsync` coalesces concurrent GETs of the same path, so this costs no
   * extra request on a page that is already asking for `/api/settings`.
   */
  const settings = useAsync(() => api.settings.get(), [], ['settings']);
  const panels = settings.data ? chosenPanels(settings.data) : [];

  /*
   * Refetch on a clock, if you asked for one.
   *
   * Only this screen, because it is the only one whose content moves without
   * anybody doing anything — a friend going idle at Steam, an hour passing in a
   * stored forecast, an away timer counting up. Everywhere else, a change
   * announces itself and a timer would be spending requests to learn nothing.
   *
   * Zero is off and is the default, so this hook usually starts nothing at all.
   */
  /**
   * Core's own sections, by id.
   *
   * Closures rather than components, deliberately: every one of these reads the
   * same `tasks`, `habits`, `settling` and `reloadAll`, so making them
   * components would mean threading all of it through each to gain nothing. The
   * ordering is a list of strings; what the strings name is this map.
   *
   * A section that renders nothing when empty still returns null here rather
   * than being left out of the map, so the picker can offer it and the order
   * can hold its place.
   */
  const coreBlocks: Record<string, () => ReactNode> = {
    'core:capture': () => (
      <section>
        <Capture onAdded={reloadAll} />
      </section>
    ),
    'core:queue': () => (
      <section>
        <h2>Waiting for a good moment</h2>
        {queue.loading && <div className="empty">loading…</div>}
        {queue.data?.map((nudge) => (
          <QueuedNudge key={nudge.id} nudge={nudge} onChange={queue.reload} />
        ))}
        {willQueue.map((task) => (
          <div className="card muted" key={task.id}>
            <div className="row between">
              <div className="grow">
                <div className="title">{task.title}</div>
                <div className="meta">
                  {task.dueAt && task.dueAt < Date.now()
                    ? `overdue — will interrupt at the next break`
                    : `will nudge you near ${task.dueAt ? clockTime(task.dueAt) : 'its due time'}`}
                </div>
              </div>
              <span className="quality">later</span>
            </div>
          </div>
        ))}
        {nothingPending && !queue.loading && (
          <div className="empty">Nothing queued. You'll be left alone.</div>
        )}
      </section>
    ),
    'core:due-today': () => (
      <TaskSection title="Due today" tasks={dueToday} onChange={reloadAll} settling={settling} empty="Nothing due." />
    ),
    'core:anytime': () => <TaskSection title="Anytime" tasks={anytime} onChange={reloadAll} settling={settling} />,
    'core:coming-up': () => <TaskSection title="Coming up" tasks={upcoming} onChange={reloadAll} settling={settling} />,
    'core:habits': () => (
      <section>
        <h2>Habits left</h2>
        {habitsLeft.length === 0 && !habits.loading && <div className="empty">All done for now.</div>}
        {habitsLeft.map((habit) => (
          <HabitRow key={habit.id} habit={habit} onChange={reloadAll} settling={settling} receivedAt={habits.receivedAt} />
        ))}
      </section>
    ),
    'core:finished': () =>
      finished.length > 0 || habitsDone.length > 0 ? (
        <section className="done-area">
          <h2>Finished today</h2>
          {habitsDone.map((habit) => (
            <HabitRow key={habit.id} habit={habit} onChange={reloadAll} settling={settling} receivedAt={habits.receivedAt} />
          ))}
          {finished.map((task) => (
            <TaskRow key={task.id} task={task} onChange={reloadAll} settling={settling} />
          ))}
        </section>
      ) : null,
  };

  /**
   * The main column, in the order you chose.
   *
   * Three kinds of id and one loop. A core section draws from the map above; a
   * panel id resolves to the same lazy component the side column uses, so a
   * package's card can sit between your tasks and your habits without core
   * learning anything about it; anything else draws nothing, which is what
   * should happen while whatever owned it is switched off.
   *
   * `core:habits` is dropped when habits are switched off — the section is
   * core's but the *feature* is not always on, and a heading with nothing under
   * it would be worse than its absence.
   */
  const blocks = chosenBlocks(settings.data).map((id) => {
    if (isCoreBlock(id)) {
      if (id === 'core:habits' && !featureEnabled('habits')) return null;
      return <Fragment key={id}>{coreBlocks[id]?.() ?? null}</Fragment>;
    }
    const Panel = resolvePanel(id);
    if (!Panel) return null;
    /*
     * Its own boundary, like the side column's — these are separate chunks that
     * arrive independently, and one boundary around the column would hold your
     * task list back until the slowest card had landed.
     */
    return (
      <Suspense key={id} fallback={<div className="empty">loading…</div>}>
        <Panel panelId={id} />
      </Suspense>
    );
  });

  const every = settings.data?.dashboardRefreshSeconds ?? 0;
  useEffect(() => refreshEvery(every), [every]);

  return (
    /*
     * `has-panel` widens the container, and it does that through
     * `.app:has(.dash.has-panel)` in the stylesheet rather than by `App` passing
     * a class down. `App` does not read settings and threading one boolean
     * through it purely to set a max-width would be a prop through three
     * components for a layout question the child already knows the answer to.
     *
     * Where `:has()` is unsupported this degrades to the one-column layout with
     * the panel stacked underneath, which is exactly what a narrow screen gets
     * anyway — so the fallback is a real layout rather than a broken one.
     */
    <div className={panels.length > 0 ? 'dash has-panel' : 'dash'}>
      <div className="dash-main">{blocks}</div>

      {panels.length > 0 && (
        <aside className="dash-panel">
          {/*
            A boundary *per panel*, not one around the column. They are separate
            chunks and arrive independently, so one shared boundary would hold
            every panel back until the slowest had landed — and the whole point
            of stacking them is that each is a small thing you glance at.
          */}
          {panels.map(({ id, Panel }) => (
            <Suspense key={id} fallback={<div className="empty">loading…</div>}>
              <Panel panelId={id} />
            </Suspense>
          ))}

          {/*
            Here rather than inside each panel, so every panel gets it and no
            feature has to know that the *setting* exists — the panel is the
            feature's, the slot it sits in is core's, and this button is about
            the slot.
          */}
          <button className="btn subtle panel-settings" onClick={() => goTo('settings', { focus: 'dashboard-panel' })}>
            Change what's here
          </button>
        </aside>
      )}
    </div>
  );
}

function TaskSection({
  title,
  tasks,
  onChange,
  settling,
  empty,
}: {
  title: string;
  tasks: Task[];
  onChange: () => void;
  settling: ReturnType<typeof useSettling>;
  empty?: string;
}) {
  // Sections without a meaningful empty state simply don't render when bare,
  // so the dashboard doesn't fill with headings for things you don't have.
  if (tasks.length === 0 && !empty) return null;

  return (
    <section>
      <h2>{title}</h2>
      {tasks.length === 0 && empty && <div className="empty">{empty}</div>}
      {tasks.map((task) => (
        <TaskRow key={task.id} task={task} onChange={onChange} settling={settling} />
      ))}
    </section>
  );
}

function QueuedNudge({ nudge, onChange }: { nudge: Nudge; onChange: () => void }) {
  const waitingFor =
    nudge.minQuality === 'prime'
      ? 'when you finish something'
      : nudge.minQuality === 'decent'
        ? 'at your next break'
        : 'next time you look up';

  return (
    <div className="card">
      <div className="row between">
        <div className="grow">
          <div className="title">{nudge.title}</div>
          <div className="meta">
            {waitingFor}
            {nudge.deadlineAt && <> · deadline {relative(nudge.deadlineAt)}</>}
          </div>
        </div>
        <span className={`quality ${nudge.minQuality}`}>{nudge.minQuality}</span>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn subtle" onClick={() => api.nudges.snooze(nudge.id, 60).then(onChange)}>
          snooze 1h
        </button>
        <button className="btn subtle danger" onClick={() => api.nudges.dismiss(nudge.id).then(onChange)}>
          dismiss
        </button>
      </div>
    </div>
  );
}
