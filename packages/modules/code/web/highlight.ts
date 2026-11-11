/**
 * Colouring source by kind of word, by hand: comments, strings, numbers,
 * keywords, names of types and of functions.
 *
 * Not a parser, deliberately. An editor library with real grammars would be
 * the largest dependency in this repo by far, for one screen; a few regular
 * expressions per language get the colours right on nearly every line, and
 * where they guess wrong (a quote inside a regular expression) the cost is a
 * wrongly coloured line, never a wrongly saved file: what is saved is the text
 * box, which this only paints behind.
 *
 * **No imports**, so the server's checks can test it the way they test
 * `presence.ts`.
 */

export type Kind = 'comment' | 'string' | 'number' | 'keyword' | 'type' | 'fn' | 'tag' | 'key' | 'heading' | 'punct';

export type Token = readonly [Kind | null, string];

type Rule = readonly [Kind, string];

const STRING_SQ = String.raw`'(?:\\.|[^'\\\n])*'?`;
const STRING_DQ = String.raw`"(?:\\.|[^"\\\n])*"?`;
const NUMBER = String.raw`\b(?:0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?n?)\b`;

const SCRIPT: Rule[] = [
  ['comment', String.raw`\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|(?![\s\S]))`],
  ['string', String.raw`${STRING_SQ}|${STRING_DQ}|\x60(?:\\[\s\S]|[^\x60\\])*\x60?`],
  ['number', NUMBER],
  [
    'keyword',
    String.raw`\b(?:import|export|from|const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|implements|interface|type|enum|async|await|try|catch|finally|throw|typeof|instanceof|in|of|as|default|null|undefined|true|false|this|void|yield|satisfies|readonly|public|private|protected|static|declare|keyof|infer|is|delete|abstract|namespace)\b`,
  ],
  // Not after a name, so `Array<string>` is a type and not an element.
  ['tag', String.raw`(?<![\w$.\])])<\/?[A-Za-z][\w.]*|\/>`],
  ['type', String.raw`\b[A-Z][A-Za-z0-9_]*\b`],
  ['fn', String.raw`\b[a-z_$][\w$]*(?=\s*\()`],
];

const CSS: Rule[] = [
  ['comment', String.raw`\/\*[\s\S]*?(?:\*\/|(?![\s\S]))`],
  ['string', `${STRING_SQ}|${STRING_DQ}`],
  ['keyword', String.raw`@[\w-]+|!important\b`],
  ['type', String.raw`--[\w-]+`],
  ['number', String.raw`#[\da-fA-F]{3,8}\b|-?\b\d*\.?\d+(?:px|rem|em|ch|vh|vw|dvh|cqi|%|s|ms|deg|fr)?\b`],
  ['key', String.raw`[\w-]+(?=\s*:[^:{;]*[;}])`],
  ['fn', String.raw`\b[\w-]+(?=\()`],
];

const JSON_RULES: Rule[] = [
  ['key', String.raw`"(?:\\.|[^"\\\n])*"(?=\s*:)`],
  ['string', STRING_DQ],
  ['number', String.raw`-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b`],
  ['keyword', String.raw`\b(?:true|false|null)\b`],
];

const MARKDOWN: Rule[] = [
  ['string', String.raw`^\x60\x60\x60[\s\S]*?(?:^\x60\x60\x60[^\n]*|(?![\s\S]))`],
  ['heading', String.raw`^#{1,6} [^\n]*`],
  ['string', String.raw`\x60[^\x60\n]+\x60`],
  ['keyword', String.raw`\*\*[^*\n]+\*\*`],
  ['fn', String.raw`\[[^\]\n]*\]\([^)\n]*\)|\[\[[^\]\n]+\]\]`],
  ['punct', String.raw`^\s*(?:[-*+]|\d+\.)\s|^\s*\|.*`],
];

const POWERSHELL: Rule[] = [
  ['comment', String.raw`<#[\s\S]*?(?:#>|(?![\s\S]))|#[^\n]*`],
  ['string', `${STRING_SQ}|${STRING_DQ}`],
  ['type', String.raw`\$[\w:]+|\$\{[^}\n]*\}`],
  ['number', NUMBER],
  [
    'keyword',
    String.raw`\b(?:function|param|if|elseif|else|foreach|for|while|do|until|return|try|catch|finally|throw|switch|break|continue|exit|in)\b|-(?:eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|and|or|not|contains|notcontains|replace|split|join|is|isnot)\b`,
  ],
  ['fn', String.raw`\b[A-Z][a-z]+-[A-Z]\w*`],
];

const SQL: Rule[] = [
  ['comment', String.raw`--[^\n]*|\/\*[\s\S]*?(?:\*\/|(?![\s\S]))`],
  ['string', STRING_SQ],
  ['key', String.raw`\x60[^\x60\n]*\x60|"[^"\n]*"`],
  ['number', NUMBER],
  [
    'keyword',
    String.raw`\b(?:CREATE|TABLE|INDEX|UNIQUE|ALTER|ADD|COLUMN|DROP|INSERT|INTO|VALUES|SELECT|FROM|WHERE|UPDATE|SET|DELETE|PRIMARY|KEY|FOREIGN|REFERENCES|ON|NOT|NULL|DEFAULT|INTEGER|TEXT|REAL|BLOB|IF|EXISTS|AND|OR|CASCADE|AS)\b`,
  ],
];

const YAML: Rule[] = [
  ['comment', String.raw`#[^\n]*`],
  ['string', `${STRING_SQ}|${STRING_DQ}`],
  ['key', String.raw`^\s*-?\s*[\w.-]+(?=:)`],
  ['keyword', String.raw`\b(?:true|false|null)\b`],
];

const BATCH: Rule[] = [
  ['comment', String.raw`^\s*(?:@?rem\b|::)[^\n]*`],
  ['string', STRING_DQ],
  ['type', String.raw`%[\w~:]+%?|![\w]+!`],
  ['keyword', String.raw`\b(?:echo|set|if|else|goto|call|exit|start|not|exist|setlocal|endlocal)\b`],
];

const HTML: Rule[] = [
  ['comment', String.raw`<!--[\s\S]*?(?:-->|(?![\s\S]))`],
  ['string', `${STRING_SQ}|${STRING_DQ}`],
  ['tag', String.raw`<\/?[\w-]+|\/?>`],
  ['key', String.raw`\b[\w-]+(?==)`],
];

const LANGUAGES: Record<string, Rule[]> = {
  ts: SCRIPT,
  tsx: SCRIPT,
  mts: SCRIPT,
  cts: SCRIPT,
  js: SCRIPT,
  mjs: SCRIPT,
  cjs: SCRIPT,
  jsx: SCRIPT,
  css: CSS,
  json: JSON_RULES,
  webmanifest: JSON_RULES,
  md: MARKDOWN,
  ps1: POWERSHELL,
  sql: SQL,
  yml: YAML,
  yaml: YAML,
  cmd: BATCH,
  bat: BATCH,
  html: HTML,
};

const compiled = new Map<Rule[], { pattern: RegExp; kinds: Kind[] }>();

function compile(rules: Rule[]) {
  let found = compiled.get(rules);
  if (!found) {
    const flags = rules === SQL ? 'gmi' : 'gm';
    found = { pattern: new RegExp(rules.map(([, source]) => `(${source})`).join('|'), flags), kinds: rules.map(([kind]) => kind) };
    compiled.set(rules, found);
  }
  return found;
}

/** Which language a path is written in, as far as colouring goes; null for plain text. */
export function languageOf(path: string): string | null {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  return extension in LANGUAGES ? extension : null;
}

/**
 * The text as runs of one kind each. Joined back together they are exactly
 * the text, which is the property the editor depends on: the painted copy
 * behind the text box has to line up with it character for character.
 */
export function tokenize(text: string, language: string | null): Token[] {
  const rules = language ? LANGUAGES[language] : undefined;
  if (!rules) return [[null, text]];
  const { pattern, kinds } = compile(rules);
  const out: Token[] = [];
  let at = 0;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match[0] === '') {
      pattern.lastIndex += 1;
      continue;
    }
    if (match.index > at) out.push([null, text.slice(at, match.index)]);
    const group = match.findIndex((value, i) => i > 0 && value !== undefined);
    out.push([kinds[group - 1] ?? null, match[0]]);
    at = match.index + match[0].length;
  }
  if (at < text.length) out.push([null, text.slice(at)]);
  return out;
}

/** Changed lines between two texts, for "what did I change". */
export type DiffLine = readonly ['same' | 'added' | 'removed', string, number | null];

/**
 * A line diff: the common start and end are taken off, and what is left in the
 * middle is matched by longest common subsequence when it is small enough to
 * afford, or shown as all removed then all added when it is not. A person
 * reading their own edit wants which lines moved; a perfect minimal diff of a
 * rewritten half of a file says nothing more useful than "this half changed".
 */
export function diffLines(before: string, after: string, context = 3): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const middleA = a.slice(start, endA);
  const middleB = b.slice(start, endB);
  const middle: Array<['same' | 'added' | 'removed', string]> = [];
  if (middleA.length * middleB.length <= 4_000_000) {
    const rows = middleA.length + 1;
    const cols = middleB.length + 1;
    const table = new Uint32Array(rows * cols);
    for (let i = middleA.length - 1; i >= 0; i--) {
      for (let j = middleB.length - 1; j >= 0; j--) {
        table[i * cols + j] =
          middleA[i] === middleB[j] ? table[(i + 1) * cols + j + 1]! + 1 : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < middleA.length || j < middleB.length) {
      if (i < middleA.length && j < middleB.length && middleA[i] === middleB[j]) {
        middle.push(['same', middleA[i]!]);
        i++;
        j++;
      } else if (j < middleB.length && (i === middleA.length || table[i * cols + j + 1]! >= table[(i + 1) * cols + j]!)) {
        middle.push(['added', middleB[j]!]);
        j++;
      } else {
        middle.push(['removed', middleA[i]!]);
        i++;
      }
    }
  } else {
    for (const line of middleA) middle.push(['removed', line]);
    for (const line of middleB) middle.push(['added', line]);
  }

  // Line numbers are the new file's, so "line 40" means what the editor says.
  const all: Array<['same' | 'added' | 'removed', string, number | null]> = [];
  let lineB = 0;
  const push = (kind: 'same' | 'added' | 'removed', text: string) => {
    all.push([kind, text, kind === 'removed' ? null : ++lineB]);
  };
  for (const line of a.slice(0, start)) push('same', line);
  for (const [kind, line] of middle) push(kind, line);
  for (const line of a.slice(endA)) push('same', line);

  // Only the changes and a few lines either side.
  const keep = new Array<boolean>(all.length).fill(false);
  all.forEach(([kind], index) => {
    if (kind === 'same') return;
    for (let k = Math.max(0, index - context); k <= Math.min(all.length - 1, index + context); k++) keep[k] = true;
  });
  const out: DiffLine[] = [];
  let skipped = false;
  all.forEach((line, index) => {
    if (keep[index]) {
      out.push(line);
      skipped = false;
    } else if (!skipped) {
      out.push(['same', '…', null]);
      skipped = true;
    }
  });
  return out.some(([kind]) => kind !== 'same') ? out : [];
}
