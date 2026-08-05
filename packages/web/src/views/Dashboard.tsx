import { api, type Nudge, type Task } from '../api';
import { useAsync } from '../useAsync';
import { useSettling } from '../useSettling';
import { clockTime, endOfToday, relative, startOfToday } from '../format';
import { TaskRow, HabitRow } from '../rows';
import { Capture } from './Capture';

/**
 * The landing screen: capture something, see what's waiting to interrupt you,
 * see what's actually due, and see what you've already finished.
 */
export function Dashboard() {
  // 'done' is included so finished items can be shown rather than vanishing.
  const tasks = useAsync(() => api.tasks.list('todo,doing,done'));
  const queue = useAsync(() => api.nudges.queue());
  const habits = useAsync(() => api.habits.list());
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

  return (
    <>
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
    </>
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
