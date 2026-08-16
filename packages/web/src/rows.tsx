import { api, type Habit, type Task } from './api';
import { dueLabel, isOverdue } from './format';
import type { Settling } from './useSettling';

/**
 * Shared rows for tasks and habits.
 *
 * Both take an optional `settling`, which keeps a just-ticked item in place for
 * a beat before it moves to the finished section — see useSettling.
 */

/**
 * What to call a task's `source` on screen.
 *
 * A local table, and a fallback that just prints the slug, because the PWA does
 * not import `@everything/shared` — the same arrangement the tone names and the
 * accent hexes have. Nothing here has consequences: an unknown slug renders as
 * itself, which is a slightly ugly label rather than a broken row, and is
 * exactly right for a service that has since been removed.
 */
const SOURCE_LABEL: Record<string, string> = { canvas: 'Canvas' };

/**
 * Where a task came from, when you did not write it yourself.
 *
 * A task appearing on the Dashboard with nobody's name on it is confusing in a
 * specific way — "did I write this, can I delete it, will it come back" — and
 * the answer to the last one is yes-and-no in a way worth being able to look up.
 * So the chip names the service and links to the thing itself.
 */
function SourceChip({ task }: { task: Task }) {
  if (!task.source) return null;
  const label = SOURCE_LABEL[task.source] ?? task.source;

  return (
    <span className="meta">
      {task.sourceUrl ? (
        // `noreferrer noopener` for the same reason every other outbound link
        // here has it: this opens in a new tab and the target has no business
        // with a handle on this window.
        <a href={task.sourceUrl} target="_blank" rel="noreferrer noopener">
          {label} ↗
        </a>
      ) : (
        label
      )}
    </span>
  );
}

export function TaskRow({
  task,
  onChange,
  settling,
}: {
  task: Task;
  onChange: () => void;
  settling?: Settling;
}) {
  const done = task.status === 'done';
  const isSettling = settling?.has(task.id) ?? false;

  async function toggle() {
    settling?.hold(task.id);
    await api.tasks.update(task.id, { status: done ? 'todo' : 'done' });
    onChange();
  }

  return (
    <div className={`card${isSettling ? ' settling' : ''}`}>
      <div className="row">
        <button
          className={`check ${done ? 'done' : ''}`}
          aria-label={done ? `Mark ${task.title} as not done` : `Mark ${task.title} as done`}
          onClick={toggle}
        >
          {done ? '✓' : ''}
        </button>
        <div className="grow">
          <div className={`title${done ? ' struck' : ''}`}>{task.title}</div>
          {task.dueAt && !done && (
            <div className={`meta ${isOverdue(task.dueAt) ? 'urgent' : ''}`}>
              {isOverdue(task.dueAt) ? 'overdue ' : 'due '}
              {dueLabel(task.dueAt, Boolean(task.dueIsAllDay))}
            </div>
          )}
          {/* Where it came from, and — for coursework — which course. Both on
              one line, since two stacked meta rows under a one-line title is
              more chrome than the task itself. */}
          {task.source && !done && (
            <div className="meta">
              <SourceChip task={task} />
              {task.notes ? ` · ${task.notes}` : ''}
            </div>
          )}
        </div>
        {task.priority >= 2 && !done && <span className="quality prime">!</span>}
      </div>
    </div>
  );
}

export function HabitRow({
  habit,
  onChange,
  settling,
}: {
  habit: Habit;
  onChange: () => void;
  settling?: Settling;
}) {
  const isSettling = settling?.has(habit.id) ?? false;

  async function check() {
    if (!habit.met) settling?.hold(habit.id);
    await api.habits.check(habit.id);
    onChange();
  }

  return (
    <div className={`card${isSettling ? ' settling' : ''}`}>
      <div className="row">
        <button
          className={`check ${habit.met ? 'done' : ''}`}
          aria-label={`Record ${habit.name}`}
          onClick={check}
        >
          {habit.met ? '✓' : ''}
        </button>
        <div className="grow">
          <div className={`title${habit.met ? ' struck' : ''}`}>{habit.name}</div>
          <div className="meta">
            {habit.doneThisPeriod} of {habit.targetPerPeriod} this {habit.cadence === 'daily' ? 'day' : 'week'}
          </div>
        </div>
      </div>
    </div>
  );
}
