/**
 * A text box for source code, coloured.
 *
 * The usual trick, done by hand: an ordinary `<textarea>` with its text made
 * transparent, laid exactly over a `<pre>` that paints the same text in
 * colour. Typing, selecting, undo, copy and paste, the phone's keyboard and a
 * screen reader are all the browser's own, because the thing being typed in
 * *is* a text box; the colours are only a picture behind it.
 *
 * **Both are the size of the text, and their parent scrolls**, rather than the
 * text box scrolling inside itself with the picture following it. Two scroll
 * positions kept in step by an event lag by a frame and drift at fractional
 * zoom; one scroll container cannot disagree with itself.
 *
 * **The picture may lag one keystroke behind on a large file** (it is drawn
 * from a deferred copy of the text, so typing never waits for colouring).
 * While it does, the text box's own text is shown instead, so what is on
 * screen is never the old text.
 */
import { useDeferredValue, useEffect, useMemo, useRef } from 'react';
import { tokenize } from './highlight';

/** Past this many characters a file is shown without colours. */
const PAINT_LIMIT = 300_000;

export interface Jump {
  line: number;
  column: number;
  /** Changes every time, so asking twice for the same place jumps twice. */
  at: number;
}

export function Editor({
  text,
  onChange,
  readOnly,
  language,
  jump,
  onSave,
  label,
}: {
  text: string;
  onChange: (text: string) => void;
  readOnly: boolean;
  language: string | null;
  jump: Jump | null;
  onSave: () => void;
  label: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  /** After Escape, Tab leaves the box instead of indenting, so the keyboard is never trapped. */
  const escaped = useRef(false);

  const painted = useDeferredValue(text);
  const tooLarge = text.length > PAINT_LIMIT;
  const tokens = useMemo(() => (tooLarge ? null : tokenize(painted, language)), [painted, language, tooLarge]);
  const stale = painted !== text;

  const lines = useMemo(() => {
    let count = 1;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++;
    return count;
  }, [text]);
  const numbers = useMemo(() => Array.from({ length: lines }, (_, i) => i + 1).join('\n'), [lines]);

  useEffect(() => {
    const box = input.current;
    const area = scroller.current;
    if (!jump || !box || !area) return;
    const all = box.value.split('\n');
    const line = Math.min(Math.max(jump.line, 1), all.length);
    let offset = 0;
    for (let i = 0; i < line - 1; i++) offset += all[i]!.length + 1;
    offset += Math.min(Math.max(jump.column - 1, 0), all[line - 1]!.length);
    box.focus({ preventScroll: true });
    box.setSelectionRange(offset, offset);
    const height = parseFloat(getComputedStyle(box).lineHeight) || 20;
    area.scrollTop = Math.max(0, (line - 1) * height - area.clientHeight / 3);
  }, [jump]);

  /*
   * Through `execCommand('insertText')` where it exists, which is deprecated
   * and still the only way to change a text box's contents that keeps the
   * browser's own undo: setting the value directly empties the undo history,
   * and Ctrl+Z after an indent would then undo nothing.
   */
  const insert = (box: HTMLTextAreaElement, value: string) => {
    if (!document.execCommand('insertText', false, value)) {
      box.setRangeText(value, box.selectionStart, box.selectionEnd, 'end');
      onChange(box.value);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      onSave();
      return;
    }
    if (readOnly) return;
    if (event.key === 'Escape') {
      escaped.current = true;
      return;
    }
    const box = event.currentTarget;
    const { selectionStart: start, selectionEnd: end, value } = box;

    if (event.key === 'Tab' && !escaped.current && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      const selected = value.slice(start, end);
      if (!event.shiftKey && !selected.includes('\n')) {
        insert(box, '  ');
        return;
      }
      // Several lines, or Shift+Tab: indent or outdent every line touched.
      const from = value.lastIndexOf('\n', start - 1) + 1;
      const lastBreak = end > start && value[end - 1] === '\n' ? end - 1 : end;
      const toBreak = value.indexOf('\n', lastBreak);
      const to = toBreak === -1 ? value.length : toBreak;
      const block = value.slice(from, to);
      const changed = block
        .split('\n')
        .map((line) => (event.shiftKey ? line.replace(/^( {1,2}|\t)/, '') : `  ${line}`))
        .join('\n');
      box.setSelectionRange(from, to);
      insert(box, changed);
      box.setSelectionRange(from, from + changed.length);
      return;
    }
    escaped.current = false;

    // A new line starts at the same indent as the one it came from.
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const indent = /^[ \t]*/.exec(value.slice(lineStart, start))![0];
      if (indent) {
        event.preventDefault();
        insert(box, `\n${indent}`);
      }
    }
  };

  return (
    <div className="code-editor" ref={scroller}>
      <pre className="code-gutter" aria-hidden="true">
        {numbers}
      </pre>
      <div className={`code-body${stale || tooLarge ? ' plain' : ''}`}>
        <pre className="code-paint" aria-hidden="true">
          {tokens
            ? tokens.map(([kind, part], index) =>
                kind ? (
                  <span key={index} className={`tk-${kind}`}>
                    {part}
                  </span>
                ) : (
                  part
                )
              )
            : painted}
          {'\n '}
        </pre>
        <textarea
          ref={input}
          className="code-input"
          value={text}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          readOnly={readOnly}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          wrap="off"
          aria-label={label}
        />
      </div>
    </div>
  );
}
