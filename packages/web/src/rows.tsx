import { api, type Habit, type Task } from './api';
import { dueLabel, isOverdue } from './format';
import type { Settling } from './useSettling';

/**
 * Shared rows for tasks and habits.
 *
 * Both take an optional `settling`, which keeps a just-ticked item in place for
 * a beat before it moves to the finished section — see useSettling.
 */

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
