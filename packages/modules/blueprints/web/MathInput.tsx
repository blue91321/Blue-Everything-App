/**
 * A Math field that draws fractions and exponents, as Desmos does: `/` puts
 * what is before the cursor on top of a line and the cursor in the box under
 * it, and `^` raises the cursor into an exponent. The keys are a hidden text
 * box's, so a phone's keyboard comes up and nothing typed is lost; what is
 * drawn is `math-doc.ts`, and what is saved is its text.
 *
 * Selecting is a drag, or Shift with the arrows, Home and End, or Ctrl+A; a
 * selection is replaced by what is typed, deleted by Backspace, copied as
 * text, and put on top of a fraction by `/`.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import {
  backspace,
  del,
  end,
  endOf,
  fromText,
  home,
  left,
  pathKey,
  pathOf,
  right,
  selectAll,
  selectedText,
  selection,
  toText,
  type,
  vertical,
  type Caret,
  type Doc,
  type Row,
  type Step,
} from './math-doc';

export function MathInput({
  value,
  wrong,
  label,
  placeholder,
  onChange,
}: {
  value: string;
  wrong: boolean;
  label: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const [doc, setDoc] = useState<Doc>(() => {
    const root = fromText(value);
    return { root, caret: endOf(root), anchor: null };
  });
  const [focused, setFocused] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLDivElement>(null);
  const history = useRef<Doc[]>([]);
  const composing = useRef(false);
  /** Every text this field has handed up lately, to know an echo of one of them for what it is. */
  const sent = useRef<string[]>([]);
  const dragging = useRef(false);
  const docRef = useRef(doc);
  docRef.current = doc;

  /*
   * Changed from somewhere else (another device, the board putting back an
   * older copy): read it again. But never an echo of something typed here,
   * which arrives a save's round trip late and would throw the cursor out of
   * the box it is in, or put back an older sum over what was typed since.
   */
  useEffect(() => {
    if (toText(docRef.current.root) === value || sent.current.includes(value)) return;
    const root = fromText(value);
    setDoc({ root, caret: endOf(root), anchor: null });
  }, [value]);

  const apply = (next: Doc, remember = true) => {
    const before = docRef.current;
    const text = toText(next.root);
    const changed = text !== toText(before.root);
    if (remember && changed) history.current = [...history.current.slice(-49), before];
    docRef.current = next;
    setDoc(next);
    if (changed) {
      sent.current = [...sent.current.slice(-49), text];
      onChange(text);
    }
  };

  // A phone's keyboard sends text and deletion this way, and its Backspace has no key name.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const onBefore = (e: InputEvent) => {
      const d = docRef.current;
      if (e.inputType === 'insertText' || e.inputType === 'insertReplacementText') {
        if (e.data) apply(type(d, e.data));
      } else if (e.inputType === 'insertFromPaste' || e.inputType === 'insertFromDrop') {
        const text = e.dataTransfer?.getData('text/plain') ?? e.data ?? '';
        if (text) apply(type(d, text));
      } else if (e.inputType === 'deleteContentBackward') apply(backspace(d));
      else if (e.inputType === 'deleteContentForward') apply(del(d));
      else return;
      e.preventDefault();
    };
    // A phone's keyboard that builds words as it goes cannot be refused: take the word when it is done.
    const onStart = () => (composing.current = true);
    const onEnd = (e: CompositionEvent) => {
      composing.current = false;
      if (e.data) apply(type(docRef.current, e.data));
      el.value = SENTINEL;
    };
    el.addEventListener('beforeinput', onBefore);
    el.addEventListener('compositionstart', onStart);
    el.addEventListener('compositionend', onEnd);
    return () => {
      el.removeEventListener('beforeinput', onBefore);
      el.removeEventListener('compositionstart', onStart);
      el.removeEventListener('compositionend', onEnd);
    };
  });

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const d = docRef.current;
    const shift = e.shiftKey;
    const moves: Record<string, (d: Doc) => Doc> = {
      ArrowLeft: (x) => left(x, shift),
      ArrowRight: (x) => right(x, shift),
      ArrowUp: (x) => vertical(x, 'up'),
      ArrowDown: (x) => vertical(x, 'down'),
      Home: (x) => home(x, shift),
      End: (x) => end(x, shift),
    };
    const ctrl = e.ctrlKey || e.metaKey;
    if (moves[e.key] && !e.altKey) {
      e.preventDefault();
      apply(moves[e.key]!(d), false);
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      apply(backspace(d));
    } else if (e.key === 'Delete') {
      e.preventDefault();
      apply(del(d));
    } else if (ctrl && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      const back = history.current.pop();
      if (back) apply({ ...back, anchor: null }, false);
    } else if (ctrl && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      apply(selectAll(d), false);
    } else if (e.key === 'Escape' || e.key === 'Enter') {
      input.current?.blur();
    }
  };

  /** Where in the sum a point on screen is: the row under it, and how many of that row's things are to its left. */
  const caretAt = (x: number, y: number): Caret => {
    const hit = document.elementFromPoint(x, y);
    const inField = !!hit && !!field.current?.contains(hit);
    const rowEl = (inField ? hit!.closest<HTMLElement>('[data-row]') : null) ?? field.current?.querySelector<HTMLElement>('.mf-row') ?? null;
    const path = pathOf(rowEl?.dataset.row ?? '');
    let at = 0;
    if (rowEl) {
      for (const child of Array.from(rowEl.children) as HTMLElement[]) {
        if (child.dataset.i === undefined) continue;
        const box = child.getBoundingClientRect();
        if (x > box.left + box.width / 2) at = Number(child.dataset.i) + 1;
      }
    }
    return { path, at };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // The board pans and selects boxes on a press; a press here is for the sum.
    e.stopPropagation();
    if (e.button !== 0) return;
    e.preventDefault();
    const caret = caretAt(e.clientX, e.clientY);
    const d = docRef.current;
    apply({ ...d, caret, anchor: e.shiftKey ? (d.anchor ?? d.caret) : caret }, false);
    dragging.current = true;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // A pointer the browser no longer knows: the drag simply ends at the edge.
    }
    input.current?.focus({ preventScroll: true });
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const caret = caretAt(e.clientX, e.clientY);
    const d = docRef.current;
    if (pathKey(caret.path) === pathKey(d.caret.path) && caret.at === d.caret.at) return;
    apply({ ...d, caret, anchor: d.anchor ?? d.caret }, false);
  };
  const onPointerUp = () => {
    dragging.current = false;
  };

  const sel = selection(doc);
  const view = (row: Row, path: Step[]): ReactNode[] => {
    const here = focused && samePath(doc.caret.path, path) && !sel;
    const chosen = (i: number) => !!sel && samePath(sel.path, path) && i >= sel.from && i < sel.to;
    const out: ReactNode[] = [];
    row.forEach((it, i) => {
      if (here && doc.caret.at === i) out.push(<span key={`c${i}`} className="mf-caret" />);
      const cls = chosen(i) ? ' sel' : '';
      if (it.t === 'ch') {
        out.push(
          <span key={i} data-i={i} className={`mf-ch${it.c === ' ' ? ' space' : ''}${cls}`}>
            {it.c === '*' ? '·' : it.c}
          </span>
        );
      } else if (it.t === 'sup') {
        const exp = [...path, { i, part: 'exp' as const }];
        out.push(
          <span key={i} data-i={i} data-row={pathKey(exp)} className={`mf-sup${cls}`}>
            {view(it.exp, exp)}
          </span>
        );
      } else {
        const num = [...path, { i, part: 'num' as const }];
        const den = [...path, { i, part: 'den' as const }];
        out.push(
          <span key={i} data-i={i} className={`mf-frac${cls}`}>
            <span className="mf-num" data-row={pathKey(num)}>
              {view(it.num, num)}
            </span>
            <span className="mf-den" data-row={pathKey(den)}>
              {view(it.den, den)}
            </span>
          </span>
        );
      }
    });
    if (here && doc.caret.at === row.length) out.push(<span key="c-end" className="mf-caret" />);
    if (!row.length && path.length) out.push(<span key="empty" className="mf-empty" />);
    return out;
  };

  const empty = doc.root.length === 0;
  return (
    <div
      ref={field}
      className={`mf${wrong ? ' wrong' : ''}${focused ? ' focused' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      role="group"
      aria-label={label}
    >
      <input
        ref={input}
        className="mf-input"
        defaultValue={SENTINEL}
        onInput={(e) => {
          // Anything that reached the box itself rather than being taken on the way: take it now.
          const el = e.currentTarget;
          if (composing.current || el.value === SENTINEL) return;
          if (el.value === '') apply(backspace(docRef.current));
          else apply(type(docRef.current, el.value.startsWith(SENTINEL) ? el.value.slice(SENTINEL.length) : el.value));
          el.value = SENTINEL;
          el.setSelectionRange(1, 1);
        }}
        onKeyDown={onKeyDown}
        onFocus={(e) => {
          setFocused(true);
          e.currentTarget.setSelectionRange(1, 1);
        }}
        onBlur={() => {
          setFocused(false);
          if (docRef.current.anchor) apply({ ...docRef.current, anchor: null }, false);
        }}
        onCopy={(e) => {
          e.preventDefault();
          e.clipboardData.setData('text/plain', selectedText(docRef.current));
        }}
        onCut={(e) => {
          e.preventDefault();
          e.clipboardData.setData('text/plain', selectedText(docRef.current));
          if (selection(docRef.current)) apply(backspace(docRef.current));
        }}
        aria-label={`${label}: ${toText(doc.root) || 'empty'}`}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        inputMode="text"
      />
      <span className="mf-row" data-row="" aria-hidden="true">
        {view(doc.root, [])}
        {empty && !focused && placeholder && <span className="mf-placeholder">{placeholder}</span>}
      </span>
    </div>
  );
}

/** One character in the hidden box, so a phone's Backspace has something to delete and says so. */
const SENTINEL = ' ';

function samePath(a: Step[], b: Step[]): boolean {
  return a.length === b.length && a.every((s, k) => s.i === b[k]!.i && s.part === b[k]!.part);
}
