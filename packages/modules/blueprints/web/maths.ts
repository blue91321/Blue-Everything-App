/**
 * Maths typed into a box, the way Desmos reads it (2026-11-04).
 *
 * `2a + b^2`, `sqrt(a) * 3`, `{score} >= 10 and {lives} > 0`, `round({hp} / 3)`.
 * Single letters are **inputs**: each one used grows a way in on the box, and a
 * number wired into it is its value, the way Desmos offers a slider for a
 * letter nothing has defined. A word in braces is **a run's word or a
 * variable**: `{count}` from a Repeat, `{score}` from "Set a variable".
 *
 * **No `eval`, and nothing that reaches outside.** It is a small parser of its
 * own over numbers, letters, words, a fixed list of functions and operators. A
 * text box that runs JavaScript would be a way to run anything on the PC from
 * a phone.
 *
 * **No imports**, so the server runs it, the board previews it and
 * `blueprints-check` tests it, and all three read a box the same way.
 *
 * What it reads, loosest first:
 *
 *   or, ||          and, &&          not, !
 *   = == != ≠ < <= ≤ > >= ≥           (one comparison: true is 1, false is 0)
 *   + -             * / × ÷ ·, `of` after a percentage, and two things side by side (`2a`, `3(a+1)`)
 *   - (in front)    ^ (right to left: 2^3^2 is 2^9)
 *   %               after a number, a percentage, as in Desmos: `50%` is 0.5,
 *                   `{hp} * 10%`, `10% of {hp}`. Remainder is `mod(a, b)`.
 *
 * `e` is Euler's number, so it is not an input letter; nor is anything that
 * spells a function or a constant. Angles are in radians, as in Desmos;
 * `30deg` is thirty degrees.
 */

type Tree =
  | { k: 'num'; v: number }
  | { k: 'letter'; name: string }
  | { k: 'word'; name: string }
  | { k: 'neg'; a: Tree }
  | { k: 'pct'; a: Tree }
  | { k: 'not'; a: Tree }
  | { k: 'bin'; op: string; a: Tree; b: Tree }
  | { k: 'call'; fn: string; args: Tree[] };

/** A variable's name as it is kept: lower case, spaces as `_`, letters, numbers and `_` only. Empty if it cannot be one. */
export function variableName(raw: unknown): string {
  const name = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  return /^\w{1,40}$/.test(name) ? name : '';
}

export class MathError extends Error {
  constructor(
    message: string,
    /** Where in the text, from 0, for pointing at it. */
    readonly at = -1
  ) {
    super(message);
  }
}

/** Letters that can be inputs: a to z without e, which is Euler's number. */
export const INPUT_LETTER = /^[a-df-z]$/;
/** The most letters one box takes, so a box cannot grow a hundred ways in. */
export const MAX_LETTERS = 8;

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  π: Math.PI,
  tau: Math.PI * 2,
  τ: Math.PI * 2,
  e: Math.E,
  deg: Math.PI / 180,
  inf: Infinity,
  infinity: Infinity,
  true: 1,
  false: 0,
};

/** Names that are one constant however many letters they have, for the Math field's drawing. */
export const isConstantName = (run: string) => run.toLowerCase() in CONSTANTS;

const one = (f: (x: number) => number) => ({ min: 1, max: 1, f: (xs: number[]) => f(xs[0]!) });

/** Every function, with how many numbers each takes. */
const FUNCTIONS: Record<string, { min: number; max: number; f: (xs: number[]) => number }> = {
  sin: one(Math.sin),
  cos: one(Math.cos),
  tan: one(Math.tan),
  sec: one((x) => 1 / Math.cos(x)),
  csc: one((x) => 1 / Math.sin(x)),
  cot: one((x) => 1 / Math.tan(x)),
  asin: one(Math.asin),
  acos: one(Math.acos),
  atan: one(Math.atan),
  arcsin: one(Math.asin),
  arccos: one(Math.acos),
  arctan: one(Math.atan),
  atan2: { min: 2, max: 2, f: ([y, x]) => Math.atan2(y!, x!) },
  sinh: one(Math.sinh),
  cosh: one(Math.cosh),
  tanh: one(Math.tanh),
  sqrt: one(Math.sqrt),
  cbrt: one(Math.cbrt),
  abs: one(Math.abs),
  sign: one(Math.sign),
  floor: one(Math.floor),
  ceil: one(Math.ceil),
  // To a number of places, as a spreadsheet's ROUND, and halves away from zero.
  round: {
    min: 1,
    max: 2,
    f: ([x, places = 0]) => {
      const p = 10 ** Math.round(places);
      return (Math.sign(x!) * Math.round(Math.abs(x!) * p)) / p;
    },
  },
  ln: one(Math.log),
  log: { min: 1, max: 2, f: ([x, base]) => (base === undefined ? Math.log10(x!) : Math.log(x!) / Math.log(base)) },
  log2: one(Math.log2),
  exp: one(Math.exp),
  // Desmos's mod: the answer has the sign of the divisor, so mod(-1, 3) is 2.
  mod: { min: 2, max: 2, f: ([a, b]) => ((a! % b!) + b!) % b! },
  min: { min: 1, max: 50, f: (xs) => Math.min(...xs) },
  max: { min: 1, max: 50, f: (xs) => Math.max(...xs) },
  mean: { min: 1, max: 50, f: (xs) => xs.reduce((s, x) => s + x, 0) / xs.length },
  avg: { min: 1, max: 50, f: (xs) => xs.reduce((s, x) => s + x, 0) / xs.length },
  total: { min: 1, max: 50, f: (xs) => xs.reduce((s, x) => s + x, 0) },
  hypot: { min: 1, max: 50, f: (xs) => Math.hypot(...xs) },
  clamp: { min: 3, max: 3, f: ([x, lo, hi]) => Math.min(Math.max(x!, lo!), hi!) },
  lerp: { min: 3, max: 3, f: ([a, b, t]) => a! + (b! - a!) * t! },
  // A whole number from a to b, both ends included; random() is 0 up to 1.
  random: {
    min: 0,
    max: 2,
    f: (xs) => {
      if (xs.length === 0) return Math.random();
      const [a, b = 0] = xs.length === 1 ? [0, xs[0]!] : (xs as [number, number]);
      const low = Math.ceil(Math.min(a, b));
      const high = Math.floor(Math.max(a, b));
      return low + Math.floor(Math.random() * (high - low + 1));
    },
  },
  if: { min: 2, max: 3, f: ([c, a, b = 0]) => (c ? a! : b) },
};

const KEYWORDS = new Set(['and', 'or', 'not', 'of']);

type Token =
  | { t: 'num'; v: number; at: number }
  | { t: 'id'; v: string; at: number }
  | { t: 'word'; v: string; at: number }
  | { t: 'op'; v: string; at: number }
  | { t: 'end'; at: number };

const OPS = ['<=', '>=', '!=', '==', '&&', '||', '**', '≤', '≥', '≠', '+', '-', '−', '*', '/', '%', '^', '(', ')', ',', '<', '>', '=', '!', '×', '÷', '·'];

function tokens(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(i));
    if (num) {
      out.push({ t: 'num', v: Number(num[1]), at: i });
      i += num[1]!.length;
      continue;
    }
    if (c === '{') {
      const word = /^\{\s*(\w{1,40})\s*\}/.exec(src.slice(i));
      if (!word) throw new MathError('A { needs a name and a }, like {score}.', i);
      out.push({ t: 'word', v: word[1]!.toLowerCase(), at: i });
      i += word[0].length;
      continue;
    }
    const id = /^[a-zA-Zπτ]+/.exec(src.slice(i));
    if (id) {
      out.push({ t: 'id', v: id[0], at: i });
      i += id[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      const v = op === '**' ? '^' : op === '−' ? '-' : op === '×' || op === '·' ? '*' : op === '÷' ? '/' : op;
      out.push({ t: 'op', v, at: i });
      i += op.length;
      continue;
    }
    throw new MathError(`"${c}" is not something this can read.`, i);
  }
  out.push({ t: 'end', at: src.length });
  return out;
}

/**
 * A run of letters is a function, a constant, a keyword, or letters side by
 * side: `ab` is a times b, `2pi` two pi. Spelled out rather than guessed, so
 * `sin` never reads as s times i times n.
 */
function splitLetters(run: string, at: number): Tree[] {
  const lower = run.toLowerCase();
  if (lower in CONSTANTS) return [{ k: 'num', v: CONSTANTS[lower]! }];
  const out: Tree[] = [];
  for (const [k, ch] of [...run].entries()) {
    const c = ch.toLowerCase();
    if (c in CONSTANTS) out.push({ k: 'num', v: CONSTANTS[c]! });
    else if (INPUT_LETTER.test(c)) out.push({ k: 'letter', name: c });
    else throw new MathError(`"${run}" is not a function or a letter this knows.`, at + k);
  }
  return out;
}

class Parser {
  private i = 0;
  constructor(private readonly list: Token[]) {}

  private get peek(): Token {
    return this.list[this.i]!;
  }

  private isOp(v: string): boolean {
    const t = this.peek;
    return t.t === 'op' && t.v === v;
  }

  private isWord(v: string): boolean {
    const t = this.peek;
    return t.t === 'id' && t.v.toLowerCase() === v;
  }

  parse(): Tree {
    if (this.peek.t === 'end') throw new MathError('There is nothing to work out yet.', 0);
    const tree = this.or();
    const after = this.list[this.i]!;
    if (after.t !== 'end') {
      const t = after;
      throw new MathError(t.t === 'op' && t.v === ')' ? 'There is a ) with no ( before it.' : 'Something is missing between these.', t.at);
    }
    return tree;
  }

  private or(): Tree {
    let a = this.and();
    while (this.isOp('||') || this.isWord('or')) {
      this.i += 1;
      a = { k: 'bin', op: 'or', a, b: this.and() };
    }
    return a;
  }

  private and(): Tree {
    let a = this.not();
    while (this.isOp('&&') || this.isWord('and')) {
      this.i += 1;
      a = { k: 'bin', op: 'and', a, b: this.not() };
    }
    return a;
  }

  private not(): Tree {
    if (this.isOp('!') || this.isWord('not')) {
      this.i += 1;
      return { k: 'not', a: this.not() };
    }
    return this.compare();
  }

  private compare(): Tree {
    const a = this.sum();
    const t = this.peek;
    if (t.t === 'op' && ['<', '<=', '>', '>=', '=', '==', '!=', '≤', '≥', '≠'].includes(t.v)) {
      this.i += 1;
      const op = t.v === '==' ? '=' : t.v === '≤' ? '<=' : t.v === '≥' ? '>=' : t.v === '≠' ? '!=' : t.v;
      return { k: 'bin', op, a, b: this.sum() };
    }
    return a;
  }

  private sum(): Tree {
    let a = this.product();
    while (this.isOp('+') || this.isOp('-')) {
      const op = (this.peek as { v: string }).v;
      this.i += 1;
      a = { k: 'bin', op, a, b: this.product() };
    }
    return a;
  }

  /** Whether the next token starts a thing, so two side by side multiply. */
  private startsThing(): boolean {
    const t = this.peek;
    if (t.t === 'num' || t.t === 'word') return true;
    if (t.t === 'id') return !KEYWORDS.has(t.v.toLowerCase());
    return t.t === 'op' && t.v === '(';
  }

  private product(): Tree {
    let a = this.unary();
    for (;;) {
      if (this.isOp('*') || this.isOp('/')) {
        const op = (this.peek as { v: string }).v;
        this.i += 1;
        a = { k: 'bin', op, a, b: this.unary() };
      } else if (this.isWord('of')) {
        // "10% of 50", as Desmos reads it: only after a percentage, where it means times.
        if (a.k !== 'pct') throw new MathError('"of" goes after a percentage, as in 10% of {hp}.', this.peek.at);
        this.i += 1;
        a = { k: 'bin', op: '*', a, b: this.unary() };
      } else if (this.startsThing()) {
        a = { k: 'bin', op: '*', a, b: this.power() };
      } else return a;
    }
  }

  private unary(): Tree {
    if (this.isOp('-')) {
      this.i += 1;
      return { k: 'neg', a: this.unary() };
    }
    if (this.isOp('+')) {
      this.i += 1;
      return this.unary();
    }
    return this.power();
  }

  private power(): Tree {
    let base = this.primary();
    // A percentage: the number before it, a hundredth as much.
    while (this.isOp('%')) {
      this.i += 1;
      base = { k: 'pct', a: base };
    }
    if (this.isOp('^')) {
      this.i += 1;
      return { k: 'bin', op: '^', a: base, b: this.unary() };
    }
    return base;
  }

  private primary(): Tree {
    const t = this.peek;
    if (t.t === 'num') {
      this.i += 1;
      return { k: 'num', v: t.v };
    }
    if (t.t === 'word') {
      this.i += 1;
      return { k: 'word', name: t.v };
    }
    if (t.t === 'op' && t.v === '(') {
      this.i += 1;
      const inner = this.or();
      if (!this.isOp(')')) throw new MathError('A ( is never closed with a ).', t.at);
      this.i += 1;
      return inner;
    }
    if (t.t === 'id') {
      this.i += 1;
      const name = t.v.toLowerCase();
      const fn = FUNCTIONS[name];
      if (fn && this.isOp('(')) return this.call(name, fn, t.at);
      if (fn) throw new MathError(`${name} needs brackets: ${name}(…).`, t.at);
      if (KEYWORDS.has(name)) throw new MathError(`"${name}" needs something on both sides.`, t.at);
      const parts = splitLetters(t.v, t.at);
      return parts.slice(1).reduce<Tree>((a, b) => ({ k: 'bin', op: '*', a, b }), parts[0]!);
    }
    if (t.t === 'end') throw new MathError('It stops before it is finished.', t.at);
    throw new MathError(`"${t.v}" cannot go there.`, t.at);
  }

  private call(name: string, fn: { min: number; max: number }, at: number): Tree {
    this.i += 1;
    const args: Tree[] = [];
    if (!this.isOp(')')) {
      args.push(this.or());
      while (this.isOp(',')) {
        this.i += 1;
        args.push(this.or());
      }
    }
    if (!this.isOp(')')) throw new MathError(`${name}( is never closed with a ).`, at);
    this.i += 1;
    if (args.length < fn.min || args.length > fn.max) {
      const want = fn.min === fn.max ? `${fn.min}` : fn.max >= 50 ? `${fn.min} or more` : `${fn.min} to ${fn.max}`;
      throw new MathError(`${name} takes ${want} number${want === '1' ? '' : 's'}, not ${args.length}.`, at);
    }
    return { k: 'call', fn: name, args };
  }
}

export type Parsed =
  | { ok: true; tree: Tree; letters: string[]; words: string[] }
  | { ok: false; error: string; at: number };

const cache = new Map<string, Parsed>();

/** Read a sum, saying what is wrong and where if it cannot be read. Kept, since boxes are read often. */
export function parseMath(src: string): Parsed {
  const text = String(src ?? '').slice(0, 500);
  const known = cache.get(text);
  if (known) return known;
  let parsed: Parsed;
  try {
    const tree = new Parser(tokens(text)).parse();
    const letters = new Set<string>();
    const words = new Set<string>();
    const walk = (n: Tree) => {
      if (n.k === 'letter') letters.add(n.name);
      else if (n.k === 'word') words.add(n.name);
      else if (n.k === 'neg' || n.k === 'not' || n.k === 'pct') walk(n.a);
      else if (n.k === 'bin') (walk(n.a), walk(n.b));
      else if (n.k === 'call') n.args.forEach(walk);
    };
    walk(tree);
    if (letters.size > MAX_LETTERS) throw new MathError(`That uses ${letters.size} letters; a box takes up to ${MAX_LETTERS}.`, 0);
    parsed = { ok: true, tree, letters: [...letters].sort(), words: [...words].sort() };
  } catch (error) {
    if (!(error instanceof MathError)) throw error;
    parsed = { ok: false, error: error.message, at: error.at };
  }
  if (cache.size > 500) cache.clear();
  cache.set(text, parsed);
  return parsed;
}

/**
 * The input letters a sum uses, in order: the ways in its box grows.
 *
 * **A sum half typed keeps its letters.** "a + b *" cannot be read, and
 * reading that as "no letters" took the ways in away on the way to "a + b * 2"
 * and with them the wires into them, on every keystroke that left it
 * unfinished. So a sum that cannot be read is looked through for the letters
 * it plainly has: every run of letters that is not a function, a constant or
 * a word, outside the braces.
 */
export function lettersOf(src: string): string[] {
  const parsed = parseMath(src);
  if (parsed.ok) return parsed.letters;
  const found = new Set<string>();
  for (const [run] of String(src ?? '').replace(/\{[^}]*\}?/g, ' ').matchAll(/[a-zA-Z]+/g)) {
    const lower = run.toLowerCase();
    if (lower in FUNCTIONS || lower in CONSTANTS || KEYWORDS.has(lower)) continue;
    for (const c of lower) if (INPUT_LETTER.test(c)) found.add(c);
  }
  return [...found].sort().slice(0, MAX_LETTERS);
}

export interface Scope {
  /** A letter's number: what is wired into it. Undefined with nothing wired in. */
  letter(name: string): number | undefined;
  /** A `{word}`: a run's word, or a variable. Undefined when there is neither. */
  word(name: string): number | string | undefined;
}

/** A word's value as a number, or why it is not one. */
export function asNumber(value: number | string | undefined, name: string): number {
  if (typeof value === 'number') return value;
  if (value === undefined) throw new MathError(`{${name}} has no value: no variable or word of the run is called that.`);
  const text = value.trim().toLowerCase();
  if (text === 'on' || text === 'yes' || text === 'true') return 1;
  if (text === 'off' || text === 'no' || text === 'false') return 0;
  const n = Number(text.replace(/,/g, ''));
  if (text === '' || !Number.isFinite(n)) throw new MathError(`{${name}} is "${value.slice(0, 40)}", not a number.`);
  return n;
}

function run(n: Tree, scope: Scope): number {
  switch (n.k) {
    case 'num':
      return n.v;
    case 'letter': {
      const v = scope.letter(n.name);
      if (v === undefined) throw new MathError(`Nothing is wired into ${n.name}: wire a number into it, or write a number instead.`);
      return v;
    }
    case 'word':
      return asNumber(scope.word(n.name), n.name);
    case 'neg':
      return -run(n.a, scope);
    case 'pct':
      return run(n.a, scope) / 100;
    case 'not':
      return run(n.a, scope) ? 0 : 1;
    case 'call':
      return FUNCTIONS[n.fn]!.f(n.args.map((a) => run(a, scope)));
    case 'bin': {
      // Both sides of and/or are worked out only when needed, as in a program.
      if (n.op === 'and') return run(n.a, scope) && run(n.b, scope) ? 1 : 0;
      if (n.op === 'or') return run(n.a, scope) || run(n.b, scope) ? 1 : 0;
      const a = run(n.a, scope);
      const b = run(n.b, scope);
      switch (n.op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          return a / b;
        case '^':
          return a ** b;
        // Equal to a hair, since 0.1 + 0.2 is not quite 0.3 to a computer.
        case '=':
          return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)) ? 1 : 0;
        case '!=':
          return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)) ? 0 : 1;
        case '<':
          return a < b ? 1 : 0;
        case '<=':
          return a <= b ? 1 : 0;
        case '>':
          return a > b ? 1 : 0;
        case '>=':
          return a >= b ? 1 : 0;
      }
    }
  }
  throw new MathError('Something in it cannot be worked out.');
}

/**
 * Work a sum out. Throws `MathError` in words when it cannot be read, when a
 * letter has nothing wired in, or when the answer is not a number (dividing by
 * zero, the square root of something negative).
 */
export function evaluate(src: string, scope: Scope): number {
  return evaluator(src)(scope);
}

/** A sum read once and worked out many times, for trying every value its inputs can take. */
export function evaluator(src: string): (scope: Scope) => number {
  const parsed = parseMath(src);
  if (!parsed.ok) throw new MathError(parsed.error, parsed.at);
  const tree = parsed.tree;
  return (scope) => checked(run(tree, scope));
}

function checked(value: number): number {
  if (Number.isNaN(value)) throw new MathError('It comes out undefined: dividing zero by zero, or the root of something below zero?');
  if (!Number.isFinite(value)) throw new MathError('It comes out infinite: dividing by zero?');
  return value;
}

/** A number for reading: no 0.30000000000000004, and no "-0". */
export function formatNumber(n: number): string {
  if (Object.is(n, -0) || Math.abs(n) < 1e-12) return '0';
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  const rounded = Number(n.toPrecision(10));
  return Math.abs(rounded) >= 1e15 || Math.abs(rounded) < 1e-6 ? rounded.toExponential(4) : String(rounded);
}
