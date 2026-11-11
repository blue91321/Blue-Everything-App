/**
 * A sum as it is drawn, the way Desmos draws one: characters in a row, a
 * fraction a box with a row above the line and a row below, and an exponent a
 * small row raised after what it is the power of. Typing `/` takes what is
 * just before the cursor as the top and puts the cursor below the line, so
 * everything typed next is underneath until → leaves it: `a / 1.5 * (1 + b)`
 * typed that way is a over all of the rest. `^` puts the cursor up in an
 * exponent the same way.
 *
 * What is stored is still text, which the server reads with the same parser
 * as always: `toText` writes a fraction as `top/bottom` and an exponent as
 * `^power`, bracketed wherever they could mean anything else, and `fromText`
 * turns a sum's `/` and `^` back into fractions and exponents by the parser's
 * own reading, so a sum typed before this opens as it was always worked out.
 * `blueprints-check` asserts the round trip.
 *
 * A selection is two carets, the anchor and the cursor, and is always a run
 * of whole things in one row: from inside a fraction to outside it selects
 * the fraction, as in Desmos.
 */
import { isConstantName } from './maths.js';

export type Item = { t: 'ch'; c: string } | Frac | Sup;
export interface Frac {
  t: 'frac';
  num: Item[];
  den: Item[];
}
/** An exponent, raised after the thing it is the power of. */
export interface Sup {
  t: 'sup';
  exp: Item[];
}
export type Row = Item[];
export type Part = 'num' | 'den' | 'exp';

/** Which fraction or exponent, in the row above, and which part of it. */
export interface Step {
  i: number;
  part: Part;
}
export interface Caret {
  path: Step[];
  at: number;
}
export interface Doc {
  root: Row;
  caret: Caret;
  /** Where a selection started; null with nothing selected. */
  anchor?: Caret | null;
}
/** What is selected: things `from` up to `to` in one row. */
export interface Selection {
  path: Step[];
  from: number;
  to: number;
}

const ch = (c: string): Item => ({ t: 'ch', c });

export function rowAt(root: Row, path: Step[]): Row {
  let row = root;
  for (const s of path) row = (row[s.i] as unknown as Record<Part, Row>)[s.part];
  return row;
}

function clone(row: Row): Row {
  return row.map((it) => (it.t === 'ch' ? it : it.t === 'frac' ? { t: 'frac', num: clone(it.num), den: clone(it.den) } : { t: 'sup', exp: clone(it.exp) }));
}

export function endOf(root: Row): Caret {
  return { path: [], at: root.length };
}

/* ---- Text ------------------------------------------------------------ */

/** Needs no brackets as the top or bottom of `/`: one number, letter run, or `{word}`. */
const SIMPLE = /^(?:[A-Za-z0-9_.]+%?|\{[^{}]*\})$/;
/** Needs no brackets after `^`: the parser takes only one thing as a power, so `x^ab` is x^a times b. */
const SIMPLE_POWER = /^(?:[0-9.]+|[A-Za-z]|\{[^{}]*\})$/;

const isBlank = (it: Item) => it.t === 'ch' && it.c === ' ';

export function toText(row: Row): string {
  const lone = row.filter((it) => !isBlank(it)).length === 1;
  return row
    .map((it) => {
      if (it.t === 'ch') return it.c;
      if (it.t === 'sup') {
        const p = toText(it.exp).trim();
        return `^${SIMPLE_POWER.test(p) || (isConstantName(p) && /^[A-Za-z]+$/.test(p)) ? p : `(${p})`}`;
      }
      const part = (r: Row) => {
        const s = toText(r).trim();
        return SIMPLE.test(s) ? s : `(${s})`;
      };
      const f = `${part(it.num)}/${part(it.den)}`;
      return lone ? f : `(${f})`;
    })
    .join('');
}

type Tok = { k: 'ch'; c: string } | { k: 'group'; inner: Tok[]; closed: boolean };

function lex(src: string): Tok[] {
  let i = 0;
  const level = (): Tok[] => {
    const out: Tok[] = [];
    while (i < src.length) {
      const c = src[i]!;
      if (c === ')') return out;
      i++;
      if (c === '(') {
        const inner = level();
        const closed = src[i] === ')';
        if (closed) i++;
        out.push({ k: 'group', inner, closed });
      } else if (c === '{') {
        // A word is one thing, whatever is inside it.
        out.push({ k: 'ch', c });
        while (i < src.length && src[i] !== '}') out.push({ k: 'ch', c: src[i++]! });
        if (i < src.length) out.push({ k: 'ch', c: src[i++]! });
      } else out.push({ k: 'ch', c });
    }
    return out;
  };
  const out: Tok[] = [];
  while (i < src.length) {
    out.push(...level());
    // A ) with no ( is kept as typed, for the parser to say what is wrong.
    if (src[i] === ')') out.push({ k: 'ch', c: src[i++]! });
  }
  return out;
}

/** Between terms: + - , and the comparisons. A - with nothing before it is a minus sign, not a break. */
const BREAK = new Set(['+', '-', ',', '<', '>', '=', '!']);
const isSpace = (t: Tok | undefined) => t?.k === 'ch' && t.c === ' ';
const chOf = (t: Tok | undefined) => (t?.k === 'ch' ? t.c : null);

function trim(toks: Tok[]): Tok[] {
  let a = 0;
  let b = toks.length;
  while (a < b && isSpace(toks[a])) a++;
  while (b > a && isSpace(toks[b - 1])) b--;
  return toks.slice(a, b);
}

function convert(toks: Tok[]): Row {
  const out: Row = [];
  let term: Tok[] = [];
  const flush = () => {
    out.push(...termRow(term));
    term = [];
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    const significant = term.some((x) => !isSpace(x));
    const word = wordAt(toks, i);
    if (word === 'and' || word === 'or' || word === 'not') {
      // Looser than any sum, so a fraction never reaches across one.
      flush();
      for (const c of word) out.push(ch(c));
      i += word.length - 1;
      continue;
    }
    const lastOut = out[out.length - 1];
    const breaks =
      t.k === 'ch' &&
      BREAK.has(t.c) &&
      ((significant && !(t.c === '-' && endsInOperator(term)) && !(t.c === '+' && endsInOperator(term))) ||
        // The second half of <=, >=, == and !=.
        (!significant && t.c === '=' && lastOut?.t === 'ch' && '<>=!'.includes(lastOut.c)));
    if (breaks) {
      flush();
      out.push(ch((t as { c: string }).c));
    } else term.push(t);
  }
  flush();
  return out;
}

/** The whole word of letters starting at `i`, if one starts there. */
function wordAt(toks: Tok[], i: number): string | null {
  const letter = (t: Tok | undefined) => t?.k === 'ch' && /[A-Za-z_]/.test(t.c);
  if (!letter(toks[i]) || letter(toks[i - 1]) || /[0-9{]/.test(chOf(toks[i - 1]) ?? '')) return null;
  let s = '';
  for (let k = i; letter(toks[k]); k++) s += chOf(toks[k]);
  return s;
}

function endsInOperator(term: Tok[]): boolean {
  const last = [...term].reverse().find((t) => !isSpace(t));
  return !!last && last.k === 'ch' && (BREAK.has(last.c) || last.c === '*' || last.c === '/' || last.c === '^');
}

/** One term: its factors left to right, each `/` making a fraction of everything before it in the term. */
function termRow(term: Tok[]): Row {
  const factors: Tok[][] = [[]];
  const ops: string[] = [];
  for (const t of term) {
    const prev = factors[factors.length - 1]!;
    // `2^-1` and `a*-b`: an operator straight after another belongs to the next factor.
    if (t.k === 'ch' && (t.c === '*' || t.c === '/') && prev.some((x) => !isSpace(x)) && !endsInOperator(prev)) {
      ops.push(t.c);
      factors.push([]);
    } else prev.push(t);
  }
  if (!ops.includes('/')) return render(term);
  let acc = factor(factors[0]!);
  for (let k = 0; k < ops.length; k++) {
    const next = factor(factors[k + 1]!);
    if (ops[k] === '*') acc = { row: [...acc.row, ...(acc.row.length ? [ch('*')] : []), ...next.row], lone: null };
    else acc = { row: [{ t: 'frac', num: acc.lone ?? acc.row, den: next.lone ?? next.row }], lone: null };
  }
  // The spaces before the term and after it, kept where they were.
  const lead = term.slice(0, term.findIndex((t) => !isSpace(t))).map(() => ch(' '));
  const trail = term.slice(term.length - [...term].reverse().findIndex((t) => !isSpace(t))).map(() => ch(' '));
  return [...lead, ...acc.row, ...trail];
}

/** A factor as drawn, and, when it is one bracketed group, what is inside it, to drop the brackets in a fraction. */
function factor(toks: Tok[]): { row: Row; lone: Row | null } {
  const t = trim(toks);
  const only = t.length === 1 && t[0]!.k === 'group' && t[0]!.closed ? convert(t[0]!.inner) : null;
  return { row: render(t), lone: only };
}

/**
 * What the parser takes as the power after a `^` at `k`: signs, then one
 * thing (a number, a letter, a constant, a `{word}`, a bracket or a function
 * of one), its %, and a power of its own.
 */
function powerAt(toks: Tok[], k: number): number {
  let i = k;
  while (isSpace(toks[i])) i++;
  while (chOf(toks[i]) === '-' || chOf(toks[i]) === '+') i++;
  const t = toks[i];
  if (!t) return i;
  if (t.k === 'group') i++;
  else if (t.c === '{') {
    while (i < toks.length && chOf(toks[i]) !== '}') i++;
    if (i < toks.length) i++;
  } else if (/[0-9.]/.test(t.c)) {
    while (/[0-9.]/.test(chOf(toks[i]) ?? '')) i++;
  } else if (/[A-Za-z]/.test(t.c)) {
    let j = i;
    let run = '';
    while (/[A-Za-z]/.test(chOf(toks[j]) ?? '')) run += chOf(toks[j++]);
    if (toks[j]?.k === 'group') i = j + 1;
    else if (isConstantName(run)) i = j;
    else i += 1;
  } else return i;
  while (chOf(toks[i]) === '%') i++;
  if (chOf(toks[i]) === '^') return powerAt(toks, i + 1);
  return i;
}

function render(toks: Tok[]): Row {
  const out: Row = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.k === 'ch' && t.c === '^') {
      const end = powerAt(toks, i + 1);
      const power = trim(toks.slice(i + 1, end));
      const exp = power.length === 1 && power[0]!.k === 'group' && power[0]!.closed ? convert(power[0]!.inner) : render(power);
      out.push({ t: 'sup', exp });
      i = end - 1;
      continue;
    }
    if (t.k === 'ch') {
      out.push(ch(t.c));
      continue;
    }
    const inner = convert(t.inner);
    const solid = inner.filter((it) => !isBlank(it));
    // The brackets `toText` puts round a fraction are not drawn.
    if (t.closed && solid.length === 1 && solid[0]!.t === 'frac') out.push(solid[0]!);
    else out.push(ch('('), ...inner, ...(t.closed ? [ch(')')] : []));
  }
  return out;
}

export function fromText(src: string): Row {
  return convert(lex(String(src ?? '')));
}

/* ---- Selection --------------------------------------------------------- */

const samePrefix = (a: Step[], b: Step[], n: number) => a.slice(0, n).every((s, k) => s.i === b[k]!.i && s.part === b[k]!.part);

/** The anchor and the cursor as whole things in the row they share. */
export function selection(doc: Doc): Selection | null {
  const a = doc.anchor;
  const c = doc.caret;
  if (!a) return null;
  let k = 0;
  while (k < a.path.length && k < c.path.length && samePrefix(a.path, c.path, k + 1)) k++;
  const span = (x: Caret): [number, number] => (x.path.length > k ? [x.path[k]!.i, x.path[k]!.i + 1] : [x.at, x.at]);
  const [a0, a1] = span(a);
  const [c0, c1] = span(c);
  const from = Math.min(a0, c0);
  const to = Math.max(a1, c1);
  return to > from ? { path: a.path.slice(0, k), from, to } : null;
}

export function selectedText(doc: Doc): string {
  const sel = selection(doc);
  return sel ? toText(rowAt(doc.root, sel.path).slice(sel.from, sel.to)) : toText(doc.root);
}

function cutSelection(doc: Doc): { doc: Doc; taken: Row } {
  const sel = selection(doc);
  // A copy either way: what is typed next changes it, and the doc it came from must stay as it was.
  if (!sel) return { doc: { ...doc, root: clone(doc.root), anchor: null }, taken: [] };
  const root = clone(doc.root);
  const taken = rowAt(root, sel.path).splice(sel.from, sel.to - sel.from);
  return { doc: { root, caret: { path: sel.path, at: sel.from }, anchor: null }, taken };
}

export const selectAll = (doc: Doc): Doc => ({ ...doc, anchor: { path: [], at: 0 }, caret: endOf(doc.root) });

/* ---- Editing ---------------------------------------------------------- */

const OPERAND = /[A-Za-z0-9_.%{}]/;

/** Type one character at the caret; `/` makes a fraction of what is just before it, `^` an exponent. */
function typeOne(doc: Doc, c: string): Doc {
  const { doc: plain, taken } = cutSelection(doc);
  const root = plain.root;
  const { path, at } = plain.caret;
  const row = rowAt(root, path);
  if (c === '/' && taken.length) {
    // A selection, then /: what was selected goes on top.
    row.splice(at, 0, { t: 'frac', num: taken, den: [] });
    return { root, caret: { path: [...path, { i: at, part: 'den' }], at: 0 }, anchor: null };
  }
  if (c === '^') {
    row.splice(at, 0, { t: 'sup', exp: [] });
    return { root, caret: { path: [...path, { i: at, part: 'exp' }], at: 0 }, anchor: null };
  }
  if (c !== '/') {
    row.splice(at, 0, ch(c));
    return { root, caret: { path, at: at + 1 }, anchor: null };
  }
  let j = at;
  // An exponent goes with what it is the power of: x² / 2.
  while (row[j - 1]?.t === 'sup') j--;
  const before = row[j - 1];
  if (before?.t === 'frac') j -= 1;
  else if (before?.t === 'ch' && before.c === ')') {
    let depth = 0;
    for (let k = j - 1; k >= 0; k--) {
      const it = row[k]!;
      if (it.t !== 'ch') continue;
      if (it.c === ')') depth++;
      else if (it.c === '(' && --depth === 0) {
        j = k;
        break;
      }
    }
    // A function's name goes with its brackets: sqrt(a) / 2.
    while (j > 0 && row[j - 1]!.t === 'ch' && /[A-Za-z]/.test((row[j - 1] as { c: string }).c)) j--;
  } else {
    while (j > 0 && row[j - 1]!.t === 'ch' && OPERAND.test((row[j - 1] as { c: string }).c)) j--;
  }
  const num = row.slice(j, at);
  row.splice(j, at - j, { t: 'frac', num, den: [] });
  return { root, caret: { path: [...path, { i: j, part: num.length ? 'den' : 'num' }], at: 0 }, anchor: null };
}

export function type(doc: Doc, text: string): Doc {
  let next = doc;
  for (const c of text.replace(/[\r\n\t]/g, ' ')) next = typeOne(next, c);
  return next;
}

const up = (path: Step[]) => path.slice(0, -1);
const last = (path: Step[]) => path[path.length - 1];
const into = (path: Step[], i: number, part: Part, at: number): Caret => ({ path: [...path, { i, part }], at });

function leftOf(root: Row, caret: Caret): Caret {
  const { path, at } = caret;
  const before = rowAt(root, path)[at - 1];
  if (before?.t === 'frac') return into(path, at - 1, 'den', before.den.length);
  if (before?.t === 'sup') return into(path, at - 1, 'exp', before.exp.length);
  if (before) return { path, at: at - 1 };
  const s = last(path);
  if (!s) return caret;
  if (s.part === 'den') return into(up(path), s.i, 'num', rowAt(root, [...up(path), { i: s.i, part: 'num' }]).length);
  return { path: up(path), at: s.i };
}

function rightOf(root: Row, caret: Caret): Caret {
  const { path, at } = caret;
  const row = rowAt(root, path);
  const after = row[at];
  if (after?.t === 'frac') return into(path, at, 'num', 0);
  if (after?.t === 'sup') return into(path, at, 'exp', 0);
  if (after) return { path, at: at + 1 };
  const s = last(path);
  if (!s) return caret;
  if (s.part === 'num') return into(up(path), s.i, 'den', 0);
  return { path: up(path), at: s.i + 1 };
}

/**
 * Move the cursor; with `extend` (Shift held) the anchor stays where the
 * selection began. Without it, ← or → with something selected lands at that
 * end of it, as in any text box.
 */
export function move(doc: Doc, dir: 'left' | 'right', extend = false): Doc {
  const sel = selection(doc);
  if (!extend && sel) return { ...doc, anchor: null, caret: { path: sel.path, at: dir === 'left' ? sel.from : sel.to } };
  if (extend) {
    // Selecting goes over a fraction or a power whole, rather than into it.
    const { path, at } = doc.caret;
    const next = rowAt(doc.root, path)[dir === 'left' ? at - 1 : at];
    if (next && next.t !== 'ch') return withAnchor(doc, { path, at: dir === 'left' ? at - 1 : at + 1 }, true);
  }
  const caret = (dir === 'left' ? leftOf : rightOf)(doc.root, doc.caret);
  return withAnchor(doc, caret, extend);
}

function withAnchor(doc: Doc, caret: Caret, extend: boolean): Doc {
  const anchor = extend ? (doc.anchor ?? doc.caret) : null;
  const next = { ...doc, caret, anchor };
  return extend && !selection(next) ? { ...next, anchor } : next;
}

export const left = (doc: Doc, extend = false) => move(doc, 'left', extend);
export const right = (doc: Doc, extend = false) => move(doc, 'right', extend);

/** ↑ from below the line goes above it, ↓ the other way. */
export function vertical(doc: Doc, dir: 'up' | 'down'): Doc {
  const path = doc.caret.path;
  for (let k = path.length - 1; k >= 0; k--) {
    const s = path[k]!;
    if ((dir === 'up' && s.part === 'den') || (dir === 'down' && s.part === 'num')) {
      const to = [...path.slice(0, k), { i: s.i, part: dir === 'up' ? ('num' as const) : ('den' as const) }];
      return { ...doc, anchor: null, caret: { path: to, at: Math.min(doc.caret.at, rowAt(doc.root, to).length) } };
    }
  }
  return { ...doc, anchor: null };
}

export function backspace(doc: Doc): Doc {
  if (selection(doc)) return cutSelection(doc).doc;
  const { path, at } = doc.caret;
  const before = rowAt(doc.root, path)[at - 1];
  // Into a fraction or an exponent from after it, as Desmos does, rather than deleting it whole.
  if (before && before.t !== 'ch') return { ...doc, anchor: null, caret: leftOf(doc.root, doc.caret) };
  const root = clone(doc.root);
  if (before) {
    rowAt(root, path).splice(at - 1, 1);
    return { root, caret: { path, at: at - 1 }, anchor: null };
  }
  const s = last(path);
  if (!s) return { ...doc, anchor: null };
  if (s.part === 'den') return { ...doc, anchor: null, caret: leftOf(doc.root, doc.caret) };
  // At the start of a top or an exponent: it goes, and what was in it stays.
  const parent = rowAt(root, up(path));
  const it = parent[s.i]!;
  const kept = it.t === 'frac' ? [...it.num, ...it.den] : it.t === 'sup' ? it.exp : [];
  parent.splice(s.i, 1, ...kept);
  return { root, caret: { path: up(path), at: s.i }, anchor: null };
}

export function del(doc: Doc): Doc {
  if (selection(doc)) return cutSelection(doc).doc;
  const { path, at } = doc.caret;
  const after = rowAt(doc.root, path)[at];
  if (!after) return { ...doc, anchor: null };
  if (after.t !== 'ch') return { ...doc, anchor: null, caret: rightOf(doc.root, doc.caret) };
  const root = clone(doc.root);
  rowAt(root, path).splice(at, 1);
  return { root, caret: { path, at }, anchor: null };
}

export const home = (doc: Doc, extend = false): Doc => withAnchor(doc, { path: [], at: 0 }, extend);
export const end = (doc: Doc, extend = false): Doc => withAnchor(doc, endOf(doc.root), extend);

/** A path as text, for a row's element to say which row it is. */
export const pathKey = (path: Step[]) => path.map((s) => `${s.i}${s.part[0]}`).join('.');
export function pathOf(key: string): Step[] {
  if (!key) return [];
  return key.split('.').map((s) => ({ i: Number(s.slice(0, -1)), part: ({ n: 'num', d: 'den', e: 'exp' } as const)[s.slice(-1) as 'n' | 'd' | 'e'] }));
}
