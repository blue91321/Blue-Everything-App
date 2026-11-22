/**
 * A task on the calendar: the box that ticks it off, and its name, which opens
 * it where it came from (an assignment on Canvas) or on the Tasks screen.
 * Shared by the Calendar screen and the week card.
 */
import { useState, type ReactNode } from 'react';
import { api } from '@app/api';
import { goTo } from '@app/nav';
import { sourceName, type DueTask } from './calendar-api';

/** The box that ticks a task off, or back on. */
export function Tick({ t }: { t: DueTask }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={`cal-tick${t.done ? ' done' : ''}`}
      aria-label={t.done ? `Mark ${t.title} not done` : `Mark ${t.title} done`}
      aria-pressed={t.done}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation();
        setBusy(true);
        void api.tasks.update(t.id, { status: t.done ? 'todo' : 'done' }).finally(() => setBusy(false));
      }}
    >
      {t.done ? '✓' : ''}
    </button>
  );
}

/** A task's name: a link to where it came from (the assignment on Canvas), else the Tasks screen. */
export function TaskName({ t, children, className }: { t: DueTask; children: ReactNode; className?: string }) {
  if (t.sourceUrl)
    return (
      <a className={className} href={t.sourceUrl} target="_blank" rel="noreferrer noopener" title={`Open on ${sourceName(t.source) ?? 'the site'}`}>
        {children}
      </a>
    );
  return (
    <button className={className} onClick={() => goTo('tasks', { focus: t.id })}>
      {children}
    </button>
  );
}
