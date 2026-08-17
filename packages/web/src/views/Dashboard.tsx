import { Suspense } from 'react';
import { api, type Nudge, type Task } from '../api';
import { useAsync } from '../useAsync';
import { useSettling } from '../useSettling';
import { clockTime, endOfToday, relative, startOfToday } from '../format';
import { goTo } from '../nav';
import { resolvePanel } from '../panels';
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
  const panelId = settings.data?.dashboardPanel ?? '';
  const Panel = resolvePanel(panelId);

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
    <div className={Panel ? 'dash has-panel' : 'dash'}>
      <div className="dash-main">
      <section>
        <Capture onAdded={reloadAll} />
      </section>

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

      <TaskSection title="Due today" tasks={dueToday} onChange={reloadAll} settling={settling} empty="Nothing due." />
      <TaskSection title="Anytime" tasks={anytime} onChange={reloadAll} settling={settling} />
      <TaskSection title="Coming up" tasks={upcoming} onChange={reloadAll} settling={settling} />

      <section>
        <h2>Habits left</h2>
        {habitsLeft.length === 0 && !habits.loading && <div className="empty">All done for now.</div>}
        {habitsLeft.map((habit) => (
          <HabitRow key={habit.id} habit={habit} onChange={reloadAll} settling={settling} />
        ))}
      </section>

      {(finished.length > 0 || habitsDone.length > 0) && (
        <section className="done-area">
          <h2>Finished today</h2>
          {habitsDone.map((habit) => (
            <HabitRow key={habit.id} habit={habit} onChange={reloadAll} settling={settling} />
          ))}
          {finished.map((task) => (
            <TaskRow key={task.id} task={task} onChange={reloadAll} settling={settling} />
          ))}
        </section>
      )}
      </div>

      {Panel && (
        <aside className="dash-panel">
          {/*
            Its own Suspense boundary, so a panel whose chunk is still arriving
            leaves the tasks on screen rather than blanking the Dashboard. The
            fallback is deliberately plain and deliberately not a spinner: on
            this network the chunk lands in a frame or two, and something that
            animates would be more noticeable than the thing it is covering for.
          */}
          <Suspense fallback={<div className="empty">loading…</div>}>
            <Panel panelId={panelId} />
          </Suspense>

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
