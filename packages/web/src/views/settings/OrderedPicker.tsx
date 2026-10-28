/**
 * An ordered list you add to, remove from and rearrange: the Dashboard's two
 * columns and the Home screen all use it.
 */
import { useReorder } from '../../reorder';

/**
 * Which tab a linkable section lives behind.
 *
 * A table rather than a search of the DOM, because the section is not *in* the
 * DOM until its tab is open — so finding it has to start from knowing where it
 * is. The key is the element's `id`, which is also what the caller passes.
 */
/**
 * A reorderable list of chosen ids, with the rest offered underneath.
 *
 * Both Dashboard columns are this: an ordered list of opaque ids drawn from one
 * pool of choices. It was written once for the side column and the main column
 * needed exactly it, so it is a component rather than a second copy — the same
 * call `useButtonMenu` made when the New menu wanted the right-click menu's
 * measuring and clamping.
 *
 * **Both arrows and a drag**, which reverses what this file said.
 *
 * The argument against a drag was that it "has to be built twice, once for the
 * mouse and once for touch" — true of HTML5 drag-and-drop, which does not exist
 * on iOS at all and is why the notes tree's drag is desktop-only. Pointer
 * events are not that: one set of handlers, and a finger is a pointer. So the
 * objection was really to a *particular way* of building one.
 *
 * The arrows stay, and not out of politeness. They are the keyboard's way —
 * the grip is `aria-hidden` and not focusable, because a third control that
 * cannot be operated by keyboard is noise to anybody using one — and they are
 * exact where a drag is approximate.
 */
export function OrderedPicker({
  chosen,
  choices,
  saving,
  onChange,
  missingNote,
}: {
  chosen: string[];
  choices: Array<{ id: string; label: string; hint?: string }>;
  saving: boolean;
  onChange: (ids: string[]) => void;
  /** What to say beside an id nothing currently answers to. */
  missingNote: string;
}) {
  const labelFor = (id: string) => choices.find((c) => c.id === id)?.label ?? id;
  const available = choices.filter((c) => !chosen.includes(c.id));

  // The drag, the draft held until the save comes back, and the arrows: see `reorder.ts`.
  const { order, dragging, item, grip, move } = useReorder(chosen, onChange, saving);

  return (
    <>
      {/*
        The chosen ones first, in their order, because that is what the column
        looks like — the list on screen and the column on the Dashboard read top
        to bottom the same way.
      */}
      {order.map((id, index) => (
        <div
          className={`row picker-row${dragging === id ? ' dragging' : ''}`}
          key={id}
          ref={item(id)}
          style={{ alignItems: 'center', gap: '.4rem', marginTop: 6 }}
        >
          {/*
            A handle, not the whole row.

            On touch the browser has to be told to stop scrolling before a drag
            can begin — `touch-action: none` — and putting that on the whole row
            would mean the list could not be scrolled past on a phone. On a
            handle it costs nothing: everywhere else in the row still scrolls.

            `aria-hidden`, and not focusable: it does exactly what the ↑ and ↓
            beside it already do, and a third control in the tab order that
            cannot be operated by keyboard is noise to anybody using one.
          */}
          <span
            className="picker-grip"
            aria-hidden="true"
            title="Drag to reorder"
            {...grip(id)}
          >
            ⠿
          </span>

          <span className="grow">
            {labelFor(id)}
            {/*
              One whose feature is switched off keeps its place rather than being
              dropped. The stored order is left alone so turning the feature back
              on restores it — the Dashboard simply draws one fewer meanwhile.
            */}
            {!choices.some((c) => c.id === id) && <span className="meta"> — {missingNote}</span>}
          </span>

          <button
            className="btn subtle"
            aria-label={`Move ${labelFor(id)} up`}
            disabled={saving || index === 0}
            onClick={() => move(index, -1)}
          >
            ↑
          </button>
          <button
            className="btn subtle"
            aria-label={`Move ${labelFor(id)} down`}
            disabled={saving || index === order.length - 1}
            onClick={() => move(index, 1)}
          >
            ↓
          </button>
          <button
            className="btn subtle"
            aria-label={`Remove ${labelFor(id)}`}
            disabled={saving}
            onClick={() => onChange(order.filter((other) => other !== id))}
          >
            remove
          </button>
        </div>
      ))}

      {available.length > 0 && (
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
          <div className="meta" style={{ marginBottom: 8 }}>{chosen.length === 0 ? 'Available' : 'Also available'}</div>

          {available.map((choice) => (
            <div className="row" key={choice.id} style={{ alignItems: 'center', gap: '.4rem', marginTop: 6 }}>
              <span className="grow">
                {choice.label}
                {choice.hint && <span className="meta"> — {choice.hint}</span>}
              </span>
              {/* Appended rather than inserted: the bottom is predictable, and
                  anywhere else is a guess about what you meant. */}
              <button className="btn subtle" disabled={saving} onClick={() => onChange([...chosen, choice.id])}>
                add
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
