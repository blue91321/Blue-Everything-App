/**
 * Makes the app's own text editable in edit mode, without wrapping it by hand.
 *
 * A Babel plugin, run by Vite on every `.tsx` it compiles (the app's and the
 * shipped packages'). It finds text **written in the source** inside an
 * ordinary element, `<p className="meta">Last checked</p>`, and draws it
 * through `UiText` (`src/ui-text.tsx`) with an id made from the file and the
 * words. Outside edit mode `UiText` is that text, or yours if you renamed it,
 * so nothing on screen changes until somebody changes something.
 *
 * **Only text in the source, which is why it is safe.** A task's title, a
 * note, a manga's name all arrive in variables (`{task.title}`), so they are
 * never touched: what can be renamed or hidden is the app's wording and
 * nothing of yours. The same string in a variable (`const label = 'Save'`)
 * is not reached either; that is the cost of the rule.
 *
 * What it takes:
 * - text directly inside a lowercase element: `<h2>Due today</h2>`;
 * - a string written straight into one: `{busy ? 'Saving…' : 'Save'}`,
 *   `{late && 'overdue'}`.
 *
 * What it leaves alone:
 * - text inside a component (`<Section>Text</Section>`), since a component
 *   may need its children to be a string;
 * - `<option>`, `<textarea>`, `<title>`, SVG text, `<code>` and `<pre>`,
 *   where an element in place of the text would break it or the text is not
 *   wording;
 * - anything inside an element marked `data-ui-fixed`, which is how edit
 *   mode's own way out cannot be hidden;
 * - edit mode's own files;
 * - text with no letter in it (`·`, `✕`, `⠿`).
 *
 * **The id is the file and the words, not the line**, so moving the line
 * keeps your change. Rewording it in the source starts it afresh: the new
 * wording is a different piece of text, and the old change no longer applies.
 */
import { relative, sep } from 'node:path';

const SKIP_PARENTS = new Set(['option', 'textarea', 'title', 'style', 'script', 'text', 'tspan', 'textPath', 'code', 'pre']);
const SKIP_FILES = /[\\/](ui-text\.tsx|EditBar\.tsx|edit-mode\.ts)$/;
const HAS_LETTER = /\p{L}/u;

/** FNV-1a, 32 bits: short, stable and plenty for telling a file's texts apart. */
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Where a file is, as a short part of an id: `views.dashboard` for
 * `packages/web/src/views/Dashboard.tsx`, `manga.library` for
 * `packages/modules/manga/web/Library.tsx`.
 */
function fileKey(packagesDir, filename) {
  let rel = relative(packagesDir, filename).split(sep).join('/');
  rel = rel.replace(/^web\/src\//, '').replace(/^modules\/([^/]+)\/web\//, '$1/');
  rel = rel.replace(/\.[tj]sx?$/, '');
  return rel.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 90);
}

/**
 * What a JSX text means, by JSX's own whitespace rules (Babel's
 * `cleanJSXElementLiteralChild`): lines trimmed where they meet, empty lines
 * dropped, the rest joined by spaces.
 */
function cleanJsxText(value) {
  const lines = value.split(/\r\n|\n|\r/);
  let lastNonEmpty = 0;
  for (let i = 0; i < lines.length; i++) if (/[^ \t]/.test(lines[i])) lastNonEmpty = i;
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/\t/g, ' ');
    if (i !== 0) line = line.replace(/^[ ]+/, '');
    if (i !== lines.length - 1) line = line.replace(/[ ]+$/, '');
    if (line) {
      if (i !== lastNonEmpty) line += ' ';
      out += line;
    }
  }
  return out;
}

export function uiTextPlugin({ packagesDir }) {
  return function uiTextBabel({ types: t }) {
    const isHost = (opening) => t.isJSXIdentifier(opening.name) && /^[a-z]/.test(opening.name.name);
    const fixed = (element) =>
      element.openingElement.attributes.some((a) => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name, { name: 'data-ui-fixed' }));

    return {
      name: 'ui-text',
      visitor: {
        Program: {
          enter(_, state) {
            state.uiUsed = false;
            state.uiFile = state.filename && !SKIP_FILES.test(state.filename) ? fileKey(packagesDir, state.filename) : null;
          },
          exit(path, state) {
            if (!state.uiUsed) return;
            path.unshiftContainer(
              'body',
              t.importDeclaration([t.importSpecifier(t.identifier('__UiText'), t.identifier('UiText'))], t.stringLiteral('@app/ui-text'))
            );
          },
        },
        JSXElement(path, state) {
          if (!state.uiFile) return;
          const opening = path.node.openingElement;
          if (!isHost(opening) || SKIP_PARENTS.has(opening.name.name)) return;
          if (fixed(path.node) || path.findParent((p) => p.isJSXElement() && fixed(p.node))) return;
          if (path.findParent((p) => p.isJSXElement() && isHost(p.node.openingElement) && SKIP_PARENTS.has(p.node.openingElement.name.name))) return;

          const make = (text) => {
            state.uiUsed = true;
            const id = `t:${state.uiFile}:${hash(text.trim())}`;
            return t.jsxElement(
              t.jsxOpeningElement(
                t.jsxIdentifier('__UiText'),
                [
                  t.jsxAttribute(t.jsxIdentifier('i'), t.jsxExpressionContainer(t.stringLiteral(id))),
                  t.jsxAttribute(t.jsxIdentifier('t'), t.jsxExpressionContainer(t.stringLiteral(text))),
                ],
                true
              ),
              null,
              [],
              true
            );
          };
          const wording = (text) => HAS_LETTER.test(text) && text.trim().length > 0;

          // A string written into an expression: itself, or either side of a
          // `?:`, or what follows `&&`, `||` or `??`.
          const walk = (expr) => {
            if (expr.isStringLiteral()) {
              if (wording(expr.node.value)) expr.replaceWith(make(expr.node.value));
            } else if (expr.isConditionalExpression()) {
              walk(expr.get('consequent'));
              walk(expr.get('alternate'));
            } else if (expr.isLogicalExpression()) {
              walk(expr.get('right'));
            }
          };

          for (const child of path.get('children')) {
            if (child.isJSXText()) {
              const text = cleanJsxText(child.node.value);
              if (wording(text)) child.replaceWith(make(text));
            } else if (child.isJSXExpressionContainer()) {
              walk(child.get('expression'));
            }
          }
        },
      },
    };
  };
}
