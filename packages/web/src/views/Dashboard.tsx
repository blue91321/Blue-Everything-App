import { Fragment, Suspense, useEffect, type ReactNode } from 'react';
import { api, type Nudge, type Task } from '../api';
import { useAsync } from '../useAsync';
import { refreshEvery } from '../live';
import { useSettling } from '../useSettling';
import { clockTime, endOfToday, relative, startOfToday } from '../format';
import { goTo } from '../nav';
import { chosenPanels, panelChoices, resolvePanel } from '../panels';
import { CORE_BLOCKS, chosenBlocks, isCoreBlock } from '../blocks';
import { useEditMode } from '../edit-mode';
import { useReorder } from '../reorder';
import { Editable, useUiText } from '../ui-text';
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
  const editing = useEditMode();
  const t = useUiText();

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
        <h2>
          <Editable id="block:core:queue" fallback="Waiting for a good moment" />
        </h2>
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
          <div className="empty">
            <Editable id="dashboard:queue.empty" fallback="Nothing queued. You'll be left alone." />
          </div>
        )}
      </section>
    ),
    'core:due-today': () => (
      <TaskSection
        id="core:due-today"
        title="Due today"
        tasks={dueToday}
        onChange={reloadAll}
        settling={settling}
        empty="Nothing due."
        editing={editing}
      />
    ),
    'core:anytime': () => (
      <TaskSection id="core:anytime" title="Anytime" tasks={anytime} onChange={reloadAll} settling={settling} editing={editing} />
    ),
    'core:coming-up': () => (
      <TaskSection id="core:coming-up" title="Coming up" tasks={upcoming} onChange={reloadAll} settling={settling} editing={editing} />
    ),
    'core:habits': () => (
      <section>
        <h2>
          <Editable id="block:core:habits" fallback="Habits left" />
        </h2>
        {habitsLeft.length === 0 && !habits.loading && (
          <div className="empty">
            <Editable id="dashboard:habits.empty" fallback="All done for now." />
          </div>
        )}
        {habitsLeft.map((habit) => (
          <HabitRow key={habit.id} habit={habit} onChange={reloadAll} settling={settling} receivedAt={habits.receivedAt} />
        ))}
      </section>
    ),
    'core:finished': () =>
      // Shown empty in edit mode too, so it can still be moved or taken off.
      finished.length > 0 || habitsDone.length > 0 || editing ? (
        <section className="done-area">
          <h2>
            <Editable id="block:core:finished" fallback="Finished today" />
          </h2>
          {finished.length === 0 && habitsDone.length === 0 && <div className="empty">Nothing yet today.</div>}
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
  const blockIds = chosenBlocks(settings.data);
  const renderBlock = (id: string): ReactNode => {
    if (isCoreBlock(id)) {
      if (id === 'core:habits' && !featureEnabled('habits')) return null;
      return coreBlocks[id]?.() ?? null;
    }
    const Panel = resolvePanel(id);
    if (!Panel) return null;
    /*
     * Its own boundary, like the side column's — these are separate chunks that
     * arrive independently, and one boundary around the column would hold your
     * task list back until the slowest card had landed.
     */
    return (
      <Suspense fallback={<div className="empty">loading…</div>}>
        <Panel panelId={id} />
      </Suspense>
    );
  };

  /*
   * Edit mode moves sections here, on the Dashboard itself: the same two lists
   * the Settings pickers write (`dashboardBlocks`, `dashboardPanels`), written
   * the same way. The pickers stay, as the way to do it by keyboard too.
   */
  const saveBlocks = (next: string[]) => void api.settings.update({ dashboardBlocks: next }).then(settings.reload);
  const storedPanels =
    settings.data?.dashboardPanels ?? (settings.data?.dashboardPanel ? [settings.data.dashboardPanel] : []);
  const savePanels = (next: string[]) => void api.settings.update({ dashboardPanels: next }).then(settings.reload);
  const mainOrder = useReorder(blockIds, saveBlocks, !settings.data);
  const sideOrder = useReorder(storedPanels, savePanels, !settings.data);

  const labelFor = (id: string): string => {
    const core = CORE_BLOCKS.find((b) => b.id === id);
    if (core) return t(`block:${id}`, core.label);
    return panelChoices().find((p) => p.id === id)?.label ?? id;
  };
  const offerable = [
    ...CORE_BLOCKS.filter((b) => !b.featureId || featureEnabled(b.featureId)).map((b) => b.id),
    ...panelChoices().map((p) => p.id),
  ];

  const blocks = editing
    ? mainOrder.order.map((id, index) => {
        // Something switched off keeps its place in the list, out of sight, as before.
        if (!isCoreBlock(id) && !resolvePanel(id)) return null;
        if (id === 'core:habits' && !featureEnabled('habits')) return null;
        return (
          <EditFrame
            key={id}
            label={labelFor(id)}
            frameRef={mainOrder.item(id)}
            grip={mainOrder.grip(id)}
            dragging={mainOrder.dragging === id}
            first={index === 0}
            last={index === mainOrder.order.length - 1}
            onMove={(delta) => mainOrder.move(index, delta)}
            onRemove={() => saveBlocks(blockIds.filter((other) => other !== id))}
            removeLabel="Take off the Dashboard"
          >
            {renderBlock(id)}
          </EditFrame>
        );
      })
    : blockIds.map((id) => <Fragment key={id}>{renderBlock(id)}</Fragment>);

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
    <div className={panels.length > 0 || editing ? 'dash has-panel' : 'dash'}>
      <div className="dash-main">
        {blocks}
        {editing && (
          <EditOffer
            what="Not on the Dashboard"
            ids={offerable.filter((id) => !blockIds.includes(id))}
            labelFor={labelFor}
            onAdd={(id) => saveBlocks([...blockIds, id])}
          />
        )}
      </div>

      {(panels.length > 0 || editing) && (
        <aside className="dash-panel">
          {/*
            A boundary *per panel*, not one around the column. They are separate
            chunks and arrive independently, so one shared boundary would hold
            every panel back until the slowest had landed — and the whole point
            of stacking them is that each is a small thing you glance at.
          */}
          {editing
            ? sideOrder.order.map((id, index) => {
                const Panel = resolvePanel(id);
                if (!Panel) return null;
                return (
                  <EditFrame
                    key={id}
                    label={labelFor(id)}
                    frameRef={sideOrder.item(id)}
                    grip={sideOrder.grip(id)}
                    dragging={sideOrder.dragging === id}
                    first={index === 0}
                    last={index === sideOrder.order.length - 1}
                    onMove={(delta) => sideOrder.move(index, delta)}
                    onRemove={() => savePanels(storedPanels.filter((other) => other !== id))}
                    removeLabel="Take out of the side column"
                  >
                    <Suspense fallback={<div className="empty">loading…</div>}>
                      <Panel panelId={id} />
                    </Suspense>
                  </EditFrame>
                );
              })
            : panels.map(({ id, Panel }) => (
                <Suspense key={id} fallback={<div className="empty">loading…</div>}>
                  <Panel panelId={id} />
                </Suspense>
              ))}

          {editing ? (
            <EditOffer
              what={storedPanels.length === 0 ? 'The side column is empty. Add' : 'Not in the side column'}
              ids={panelChoices()
                .map((p) => p.id)
                .filter((id) => !storedPanels.includes(id))}
              labelFor={labelFor}
              onAdd={(id) => savePanels([...storedPanels, id])}
            />
          ) : (
            /*
              Here rather than inside each panel, so every panel gets it and no
              feature has to know that the *setting* exists — the panel is the
              feature's, the slot it sits in is core's, and this button is about
              the slot.
            */
            <button className="btn subtle panel-settings" onClick={() => goTo('settings', { focus: 'dashboard-panel' })}>
              Change what's here
            </button>
          )}
        </aside>
      )}
    </div>
  );
}

/**
 * A section in edit mode: a bar above it to move it by, and its content as
 * usual underneath, so you can see what you are moving.
 */
function EditFrame({
  label,
  frameRef,
  grip,
  dragging,
  first,
  last,
  onMove,
  onRemove,
  removeLabel,
  children,
}: {
  label: string;
  frameRef: (el: HTMLElement | null) => void;
  grip: ReturnType<ReturnType<typeof useReorder>['grip']>;
  dragging: boolean;
  first: boolean;
  last: boolean;
  onMove: (delta: number) => void;
  onRemove: () => void;
  removeLabel: string;
  children: ReactNode;
}) {
  return (
    <div ref={frameRef} className={`edit-frame${dragging ? ' dragging' : ''}`}>
      <div className="edit-frame-bar">
        <span className="edit-grip" aria-hidden="true" title="Drag to move" {...grip}>
          ⠿
        </span>
        <span className="grow edit-frame-label">{label}</span>
        <button className="btn subtle" aria-label={`Move ${label} up`} disabled={first} onClick={() => onMove(-1)}>
          ↑
        </button>
        <button className="btn subtle" aria-label={`Move ${label} down`} disabled={last} onClick={() => onMove(1)}>
          ↓
        </button>
        <button className="btn subtle" aria-label={`${removeLabel}: ${label}`} title={removeLabel} onClick={onRemove}>
          ✕
        </button>
      </div>
      {children ?? <div className="empty">Nothing to show here right now.</div>}
    </div>
  );
}

/** What could be added back, in edit mode. Appended, as the Settings picker does. */
function EditOffer({
  what,
  ids,
  labelFor,
  onAdd,
}: {
  what: string;
  ids: string[];
  labelFor: (id: string) => string;
  onAdd: (id: string) => void;
}) {
  if (ids.length === 0) return null;
  return (
    <div className="edit-offer">
      <div className="meta">{what}:</div>
      {ids.map((id) => (
        <button key={id} className="btn subtle" onClick={() => onAdd(id)}>
          + {labelFor(id)}
        </button>
      ))}
    </div>
  );
}

function TaskSection({
  id,
  title,
  tasks,
  onChange,
  settling,
  empty,
  editing,
}: {
  /** Its block id, which names its heading's wording (`block:<id>`). */
  id: string;
  title: string;
  tasks: Task[];
  onChange: () => void;
  settling: ReturnType<typeof useSettling>;
  empty?: string;
  editing: boolean;
}) {
  // Sections without a meaningful empty state simply don't render when bare,
  // so the dashboard doesn't fill with headings for things you don't have —
  // except in edit mode, where a section you cannot see is one you cannot move.
  if (tasks.length === 0 && !empty && !editing) return null;

  return (
    <section>
      <h2>
        <Editable id={`block:${id}`} fallback={title} />
      </h2>
      {tasks.length === 0 && empty && (
        <div className="empty">
          <Editable id={`dashboard:${id.replace(/^core:/, '')}.empty`} fallback={empty} />
        </div>
      )}
      {tasks.length === 0 && !empty && <div className="empty">Nothing here right now.</div>}
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
