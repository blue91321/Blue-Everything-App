import { api, type Habit, type Task } from './api';
import { dueLabel, isOverdue, relative } from './format';
import { useCallback } from 'react';
import { HabitGauge } from './Gauge';
import { useContextMenu } from './ContextMenu';
import { goTo } from './nav';
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

  /*
   * Right-click goes to the screen that edits this, with its editor open.
   *
   * A list because it is going to grow; one item is what is honest today.
   * `useCallback` so the row does not rebuild the array on every render of a
   * Dashboard that may be holding twenty of them.
   */
  const { onContextMenu, menu } = useContextMenu(
    useCallback(() => [{ label: 'Edit task…', onSelect: () => goTo('tasks', { focus: task.id }) }], [task.id])
  );

  async function toggle() {
    settling?.hold(task.id);
    await api.tasks.update(task.id, { status: done ? 'todo' : 'done' });
    onChange();
  }

  return (
    <div className={`card${isSettling ? ' settling' : ''}`} onContextMenu={onContextMenu}>
      {menu}
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

/** "in 3 hours", "in 4 days" — how long a gauge has left. */
function roughly(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${Math.round(hours / 24)} days`;
}

/**
 * The line under a habit's name, which is a different sentence per mode.
 *
 * The count is meaningless for the two new modes and saying it anyway was the
 * temptation worth resisting: "1 of 1 this day" under a plant you water every
 * four days is not merely useless, it is wrong about what the habit is.
 */
function habitLine(habit: Habit): string {
  if (habit.mode === 'gauge') {
    const level = habit.gaugeNow ?? 100;
    const remindAt = habit.gaugeRemindAt ?? 0;
    const parts: string[] = [level <= 0 ? 'empty' : `${level}% full`];

    /*
     * Two countdowns, and they answer different questions: when will it start
     * asking, and when will it be gone. At a threshold of 0 they are the same
     * instant, so only one is shown — two identical times side by side would
     * read as a bug rather than as thoroughness.
     */
    if (level <= remindAt) {
      parts.push('needs doing');
    } else if (remindAt > 0 && habit.gaugeRemindInMs != null) {
      parts.push(`reminds in ${roughly(habit.gaugeRemindInMs)}`);
    }

    if (level > 0 && habit.gaugeEmptyInMs != null) parts.push(`empty in ${roughly(habit.gaugeEmptyInMs)}`);

    return parts.join(' · ');
  }

  if (habit.mode === 'interval') {
    if (!habit.lastDoneAt) return 'never done';
    const done = `last done ${relative(habit.lastDoneAt)}`;
    if (!habit.intervalMinutes) return done;
    const dueAt = habit.lastDoneAt + habit.intervalMinutes * 60_000;
    return dueAt <= Date.now() ? `due now · ${done}` : `${done} · due ${relative(dueAt)}`;
  }

  return `${habit.doneThisPeriod} of ${habit.targetPerPeriod} this ${habit.cadence === 'daily' ? 'day' : 'week'}`;
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
  const isGauge = habit.mode === 'gauge';

  const { onContextMenu, menu } = useContextMenu(
    useCallback(() => [{ label: 'Edit habit…', onSelect: () => goTo('habits', { focus: habit.id }) }], [habit.id])
  );

  async function check() {
    /*
     * Settling pins a just-ticked row in place for a beat before it drops to
     * *Finished today*. A gauge never drops — it is never finished — so there is
     * no movement to cushion, and holding it would apply the animation to a row
     * that was not going anywhere.
     */
    if (!habit.met && !isGauge) settling?.hold(habit.id);
    await api.habits.check(habit.id);
    onChange();
  }

  return (
    <div className={`card${isSettling ? ' settling' : ''}`} onContextMenu={onContextMenu}>
      {menu}
      <div className="row">
        {/*
          The gauge *is* the button, rather than sitting beside a tick box.
          Two controls on one row would raise the question of what the tick did
          that the shape did not — and the answer would have to be "nothing",
          since topping it up is the only thing you can do to a gauge.
        */}
        <button
          className={isGauge ? 'check gauge-button' : `check ${habit.met ? 'done' : ''}`}
          aria-label={`Record ${habit.name}`}
          onClick={check}
        >
          {isGauge ? (
            <HabitGauge habit={habit} />
          ) : habit.met ? (
            '✓'
          ) : (
            ''
          )}
        </button>
        <div className="grow">
          {/*
            A gauge is never struck through. Striking means finished, and a
            gauge that is full is not finished — it is draining again already,
            which is the whole idea of it.
          */}
          <div className={`title${habit.met && !isGauge ? ' struck' : ''}`}>{habit.name}</div>
          <div className="meta">{habitLine(habit)}</div>
        </div>
      </div>
    </div>
  );
}
