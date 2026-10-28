/**
 * What a note *is*, in one place: Markdown, wiki-links, tags and folders.
 *
 * ### One parser, three renderers
 *
 * The screen, the PDF and the Word export all consume the block list this file
 * produces. That is the whole reason it is a parser rather than three sets of
 * regexes: an exporter with its own idea of what a bullet looks like drifts
 * from the screen silently, and the first time anybody notices is when they
 * send somebody a PDF. The same argument the tone palette settled — both sides
 * call the same `wav()` — and the same one that fails the build when
 * `ACCENT_HEX` drifts from `styles.css`.
 *
 * ### It never produces HTML
 *
 * The PWA renders these blocks as React elements, so a note cannot inject
 * anything however it is written. That is deliberate and worth stating: this
 * app has exactly one place that builds HTML by hand — the OAuth callback — and
 * that is precisely where its one reflected-XSS hole was found. A Markdown
 * renderer emitting `dangerouslySetInnerHTML` would be the second, on input
 * that arrives by dropping somebody else's export file into the app.
 *
 * ### The subset, and what is deliberately missing
 *
 * Headings, emphasis, code (inline and fenced), lists, quotes, rules, tables,
 * links, images, wiki-links and tags. **Not** raw HTML, footnotes, definition
 * lists or maths. Those are real Markdown and they are also the parts nobody
 * writes in a note about buying milk, and each would have to be answered three
 * times over — once per renderer.
 */

/* ------------------------------------------------------------------ */
/* Titles and links                                                     */
/* ------------------------------------------------------------------ */

/**
 * The key a `[[wiki-link]]` matches on.
 *
 * Case and surrounding punctuation are dropped so `[[Reading list]]`,
 * `[[reading list]]` and `[[Reading List!]]` all reach the same note — nobody
 * retypes a title exactly, and a link that fails on capitalisation is a link
 * that fails.
 *
 * Inner punctuation is kept, because `[[C++]]` and `[[C]]` are different notes.
 */
export function noteKey(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/^[\s.,;:!?'"()[\]{}]+|[\s.,;:!?'"()[\]{}]+$/g, '')
    .replace(/\s+/g, ' ');
}

export interface WikiLink {
  /** The note it points at, as written. */
  target: string;
  /** What to show — `[[target|label]]`, or the target when there is no pipe. */
  label: string;
  /** A `#heading` or `^block` suffix, kept so a round trip does not lose it. */
  anchor: string;
}

/*
 * `[[target#anchor|label]]`, with every part optional but the target.
 *
 * `[^\]]` rather than a lazy `.` so an unclosed bracket cannot run to the end of
 * the note and swallow everything after it as one enormous link.
 */
const WIKI_LINK = /\[\[([^\]|#]+)(#[^\]|]*)?(\|[^\]]*)?\]\]/g;

/**
 * Every wiki-link in a note, in the order they appear.
 *
 * Duplicates are kept: "linked three times" is a real thing the backlinks panel
 * says, and deduplicating here would make that impossible to count later.
 */
export function extractWikiLinks(body: string): WikiLink[] {
  const found: WikiLink[] = [];
  for (const match of body.matchAll(WIKI_LINK)) {
    const target = match[1].trim();
    if (!target) continue;
    found.push({
      target,
      anchor: (match[2] ?? '').trim(),
      label: (match[3] ?? '').slice(1).trim() || target,
    });
  }
  return found;
}

/**
 * `#tag`, the way a note means it rather than the way a URL does.
 *
 * Three exclusions, each of which was going to be a bug:
 *
 *  - **a `#` inside a word** — `C#` is a language and `foo#bar` is a fragment,
 *    neither is a tag, so one is only recognised at a word boundary;
 *  - **a Markdown heading** — `# Shopping` is a heading, and reading it as a
 *    tag called `Shopping` would tag every note with its own first line;
 *  - **anything numeric** — `#1` is an issue number, and a tag list full of
 *    them is a tag list nobody opens.
 *
 * Nested tags (`#work/urgent`) are kept whole, which is what Obsidian does, and
 * the tree is built from the slashes by whoever displays them.
 */
const TAG = /(^|[\s([{,;:!?'"])#([A-Za-zÀ-\uffff][\wÀ-\uffff/-]*)/g;

export function extractTags(body: string): string[] {
  const found = new Set<string>();

  for (const line of stripCodeForScanning(body).split('\n')) {
    // A heading is not a tag. Leading spaces are allowed, as Markdown does.
    if (/^\s{0,3}#{1,6}(\s|$)/.test(line)) continue;
    for (const match of line.matchAll(TAG)) found.add(match[2].replace(/\/+$/, ''));
  }

  return [...found];
}

/**
 * Blank out fenced and inline code before scanning for tags or links.
 *
 * A shell snippet is nothing but `#` comments, and a note containing one would
 * otherwise come back tagged with every word after a hash in it. Replaced with
 * spaces rather than removed so line and column positions still line up for
 * anything that cares.
 */
function stripCodeForScanning(body: string): string {
  const blanked = (text: string) => text.replace(/[^\n]/g, ' ');
  return body
    .replace(/```[\s\S]*?(?:```|$)/g, blanked)
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, blanked)
    .replace(/`[^`\n]*`/g, blanked);
}

/* ------------------------------------------------------------------ */
/* Folders                                                              */
/* ------------------------------------------------------------------ */

/**
 * A folder path, cleaned to the one spelling everything else can rely on.
 *
 * Forward slashes, no leading or trailing one, no `.` or `..` segment, and the
 * empty string for the root. That last is deliberately not null: two spellings
 * of "no folder" is the kind of thing that ends up with a `WHERE folder = ''`
 * that silently misses half the rows.
 *
 * `..` is dropped rather than resolved. This value reaches a filename on export
 * — the zip writer's entry names — and the zip reader's own guard exists
 * because the same trick coming the other way would write outside the folder.
 */
export function normaliseFolder(folder: string | null | undefined): string {
  if (!folder) return '';
  return folder
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part !== '' && part !== '.' && part !== '..')
    .join('/');
}

/** Every folder on the way down, so a tree can be built without a second walk. */
export function folderAncestors(folder: string): string[] {
  const parts = normaliseFolder(folder).split('/').filter(Boolean);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

/** A folder's own name, without its parents. */
export function folderName(folder: string): string {
  const parts = normaliseFolder(folder).split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** The folder it lives in — `''` for a top-level one. */
export function folderParent(folder: string): string {
  const parts = normaliseFolder(folder).split('/').filter(Boolean);
  return parts.slice(0, -1).join('/');
}

/**
 * Where a folder lands when it is dropped into another one.
 *
 * A folder here is a path prefix on notes rather than a row of its own, so
 * moving one *is* renaming it: `a/b` dropped on `c` becomes `c/b`, and every
 * note underneath follows because their paths start with it. That is why the
 * server needs no move endpoint beyond the rename it already had.
 */
export function folderMoveTarget(source: string, destination: string): string {
  const into = normaliseFolder(destination);
  const name = folderName(source);
  return into ? `${into}/${name}` : name;
}

/**
 * Whether a folder may be dropped where it was aimed.
 *
 * Four refusals, and the third is the one that matters: **a folder cannot go
 * inside its own descendant.** Moving `a` into `a/b` would rewrite every path
 * under `a` to a prefix that is itself about to move, which is a loop rather
 * than a move — it does not error, it silently mangles the tree.
 *
 * The fourth is a no-op rather than a danger, and it is refused so the screen
 * can grey the target instead of accepting a drop that changes nothing, which
 * reads as the drag having failed.
 */
export function canMoveFolder(source: string, destination: string): boolean {
  const from = normaliseFolder(source);
  const into = normaliseFolder(destination);
  if (!from) return false; // the root is not a thing you can pick up
  if (into === from) return false; // onto itself
  if (`${into}/`.startsWith(`${from}/`)) return false; // into its own descendant
  return folderParent(from) !== into; // already sitting there
}

/** Whether a note in `from` may be dropped on `to`. */
export function canMoveNote(from: string, to: string): boolean {
  return normaliseFolder(from) !== normaliseFolder(to);
}

/**
 * A title turned into something a filesystem will accept.
 *
 * Windows is the strict one and therefore the one to satisfy: `<>:"/\|?*`, the
 * control characters, a trailing dot or space, and the reserved device names
 * that still cannot be used as filenames thirty years on.
 */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function safeFileName(title: string, fallback = 'note'): string {
  const cleaned = title
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');

  if (!cleaned) return fallback;
  if (RESERVED_NAMES.test(cleaned)) return `${cleaned}_`;
  // 120 rather than 255: the folder path and the extension share the budget,
  // and a path limit hit halfway through an export is a poor way to find out.
  return cleaned.slice(0, 120);
}

/* ------------------------------------------------------------------ */
/* Front matter                                                         */
/* ------------------------------------------------------------------ */

export interface FrontMatter {
  data: Record<string, string | string[]>;
  body: string;
}

/**
 * YAML front matter, to the depth notes actually use it.
 *
 * `key: value`, `key: [a, b]`, and a `- item` list under a bare key. Not a YAML
 * parser and not trying to be: anchors, nesting and block scalars are things a
 * note exported from another app does not contain, and a real YAML dependency
 * to read four keys would be the largest thing in this package.
 *
 * Anything it cannot read is **left in the body rather than thrown away**,
 * which is the important half. An importer that silently drops a block it did
 * not understand loses somebody's data on a path nobody tests.
 */
export function parseFrontMatter(text: string): FrontMatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return { data: {}, body: text };

  const data: Record<string, string | string[]> = {};
  let key: string | null = null;

  for (const raw of match[1].split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && key) {
      const existing = data[key];
      data[key] = Array.isArray(existing) ? [...existing, unquote(item[1])] : [unquote(item[1])];
      continue;
    }

    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;

    key = pair[1];
    const value = pair[2].trim();
    if (value === '') {
      // A bare key introduces a `- item` list, and holds nothing until one
      // arrives. Recorded as empty so the key survives a round trip.
      data[key] = [];
    } else if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((part) => unquote(part.trim()))
        .filter(Boolean);
    } else {
      data[key] = unquote(value);
    }
  }

  /*
   * The blank line that conventionally follows the block goes with it. Left in,
   * every note imported from a vault begins with an empty line — which is
   * invisible in the editor and turns into a stray paragraph in the PDF.
   * Newlines only, so a note that genuinely starts indented keeps its shape.
   */
  return { data, body: text.slice(match[0].length).replace(/^\n+/, '') };
}

function unquote(value: string): string {
  const match = /^(["'])([\s\S]*)\1$/.exec(value.trim());
  return match ? match[2] : value.trim();
}

/** Front matter back out again, for a vault export another app will read. */
export function stringifyFrontMatter(data: Record<string, string | string[] | undefined>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}: [${value.map(quoteIfNeeded).join(', ')}]`);
    } else if (value !== '') {
      lines.push(`${key}: ${quoteIfNeeded(value)}`);
    }
  }
  return lines.length === 0 ? '' : `---\n${lines.join('\n')}\n---\n\n`;
}

function quoteIfNeeded(value: string): string {
  return /^[\w .\/-]+$/.test(value) ? value : JSON.stringify(value);
}

/* ------------------------------------------------------------------ */
/* Inline text                                                          */
/* ------------------------------------------------------------------ */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'strike'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }
  | { kind: 'image'; src: string; alt: string }
  | { kind: 'wiki'; target: string; anchor: string; label: string }
  | { kind: 'tag'; tag: string };

/**
 * Inline Markdown, in one left-to-right pass.
 *
 * Ordered so the greedy constructs cannot eat the others: code spans first
 * because their contents are literal by definition, then images before links
 * (an image *is* a link with a `!`), then wiki-links before ordinary brackets,
 * then emphasis, then tags last — a tag is the only one that can start
 * mid-sentence with no closing delimiter, so anything else that wants a `#` has
 * already claimed it.
 */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buffer = '';

  const flush = () => {
    if (buffer) out.push({ kind: 'text', text: buffer });
    buffer = '';
  };

  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);

    // An escaped character is itself, and never a delimiter.
    if (rest[0] === '\\' && rest.length > 1 && /[\\`*_~[\]()#!|]/.test(rest[1])) {
      buffer += rest[1];
      i += 2;
      continue;
    }

    const code = /^(`+)([\s\S]*?)\1(?!`)/.exec(rest);
    if (code) {
      flush();
      out.push({ kind: 'code', text: code[2].trim() });
      i += code[0].length;
      continue;
    }

    const image = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
    if (image) {
      flush();
      out.push({ kind: 'image', alt: image[1], src: image[2] });
      i += image[0].length;
      continue;
    }

    // `![[x]]` is an Obsidian embed. Rendered as a link rather than inlined:
    // pulling one note into another is a whole behaviour, and a link that goes
    // to the right place beats an embed that half works.
    const wikiEmbed = /^!?\[\[([^\]|#]+)(#[^\]|]*)?(\|[^\]]*)?\]\]/.exec(rest);
    if (wikiEmbed) {
      flush();
      const target = wikiEmbed[1].trim();
      out.push({
        kind: 'wiki',
        target,
        anchor: (wikiEmbed[2] ?? '').trim(),
        label: (wikiEmbed[3] ?? '').slice(1).trim() || target,
      });
      i += wikiEmbed[0].length;
      continue;
    }

    const link = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
    if (link) {
      flush();
      out.push({ kind: 'link', href: link[2], children: parseInline(link[1]) });
      i += link[0].length;
      continue;
    }

    const auto = /^<((?:https?|mailto):[^>\s]+)>/.exec(rest);
    if (auto) {
      flush();
      out.push({ kind: 'link', href: auto[1], children: [{ kind: 'text', text: auto[1] }] });
      i += auto[0].length;
      continue;
    }

    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (strong) {
      flush();
      out.push({ kind: 'strong', children: parseInline(strong[2]) });
      i += strong[0].length;
      continue;
    }

    const strike = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest);
    if (strike) {
      flush();
      out.push({ kind: 'strike', children: parseInline(strike[1]) });
      i += strike[0].length;
      continue;
    }

    /*
     * Emphasis with `_` only at a word boundary, so `snake_case_names` survives.
     * That is the one emphasis rule everybody's Markdown gets wrong at least
     * once, and code-adjacent notes are full of underscores.
     */
    const em =
      /^\*(?=\S)([^*]*?\S)\*/.exec(rest) ??
      (i === 0 || /[\s([{]/.test(text[i - 1]) ? /^_(?=\S)([^_]*?\S)_(?![A-Za-z0-9])/.exec(rest) : null);
    if (em) {
      flush();
      out.push({ kind: 'em', children: parseInline(em[1]) });
      i += em[0].length;
      continue;
    }

    const tag = /^#([A-Za-zÀ-\uffff][\wÀ-\uffff/-]*)/.exec(rest);
    if (tag && (i === 0 || /[\s([{,;:!?'"]/.test(text[i - 1]))) {
      flush();
      out.push({ kind: 'tag', tag: tag[1].replace(/\/+$/, '') });
      i += tag[0].length;
      continue;
    }

    buffer += rest[0];
    i += 1;
  }

  flush();
  return out;
}

/** Inline nodes back to readable text, for previews, search and plain export. */
export function inlineToText(nodes: Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case 'text':
        case 'code':
          return node.text;
        case 'image':
          return node.alt;
        case 'wiki':
          return node.label;
        case 'tag':
          return `#${node.tag}`;
        default:
          return inlineToText(node.children);
      }
    })
    .join('');
}

/* ------------------------------------------------------------------ */
/* Blocks                                                               */
/* ------------------------------------------------------------------ */

export interface ListItem {
  children: Inline[];
  /** `null` for a plain bullet; a boolean for `- [ ]` and `- [x]`. */
  checked: boolean | null;
  /** Nesting depth, 0 at the top. Flat rather than a tree — see below. */
  depth: number;
}

export type Block =
  | { kind: 'heading'; level: number; children: Inline[] }
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'list'; ordered: boolean; items: ListItem[] }
  | { kind: 'code'; language: string; text: string }
  | { kind: 'table'; header: Inline[][]; rows: Inline[][][] }
  | { kind: 'rule' };

/**
 * Markdown to blocks.
 *
 * **Lists are flat with a depth, not a tree**, and that is a decision rather
 * than a shortcut. Every renderer here has to walk them: React nests `<ul>`,
 * the PDF indents by depth, and Word writes a numbering level — two of those
 * three want the depth as a number, so a tree would be flattened again twice.
 */
export function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = /^\s{0,3}(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s{0,3}${fence[1]}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      // Past the closing fence, or past the end — an unterminated fence runs to
      // the end of the note rather than being abandoned, which is what every
      // editor shows you while you are still typing it.
      i += 1;
      blocks.push({ kind: 'code', language: fence[2] ?? '', text: body.join('\n') });
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, children: parseInline(heading[2]) });
      i += 1;
      continue;
    }

    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: 'rule' });
      i += 1;
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && (/^\s{0,3}>/.test(lines[i]) || (quoted.length > 0 && lines[i].trim()))) {
        quoted.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
        i += 1;
      }
      blocks.push({ kind: 'quote', blocks: parseBlocks(quoted.join('\n')) });
      continue;
    }

    const bullet = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      const ordered = /\d/.test(bullet[2]);
      const items: ListItem[] = [];

      while (i < lines.length) {
        const item = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(lines[i]);
        if (!item) {
          // A line that is not a bullet but is indented continues the one above
          // — which is how anybody writes a wrapped bullet.
          if (items.length > 0 && /^\s+\S/.test(lines[i])) {
            items[items.length - 1].children.push(
              { kind: 'text', text: ' ' },
              ...parseInline(lines[i].trim())
            );
            i += 1;
            continue;
          }
          break;
        }
        if (/\d/.test(item[2]) !== ordered) break;

        const task = /^\[([ xX])\]\s+(.*)$/.exec(item[3]);
        items.push({
          // Two spaces per level is the common spelling and a tab counts as one
          // level; anything else rounds down rather than inventing a depth.
          depth: Math.floor(item[1].replace(/\t/g, '  ').length / 2),
          checked: task ? task[1].toLowerCase() === 'x' : null,
          children: parseInline(task ? task[2] : item[3]),
        });
        i += 1;
      }

      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    const table = parseTable(lines, i);
    if (table) {
      blocks.push(table.block);
      i = table.next;
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() && !startsNewBlock(lines[i])) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    // A paragraph must consume at least its own first line, or a line that
    // looks like the start of a block but parsed as none would loop forever.
    if (paragraph.length === 0) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ kind: 'paragraph', children: parseInline(paragraph.join('\n')) });
  }

  return blocks;
}

function startsNewBlock(line: string): boolean {
  return (
    /^\s{0,3}(```|~~~)/.test(line) ||
    /^\s{0,3}#{1,6}\s/.test(line) ||
    /^\s{0,3}>/.test(line) ||
    /^\s*([-*+]|\d{1,9}[.)])\s+/.test(line) ||
    /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)
  );
}

/** GFM pipe tables, which are the only kind anybody writes by hand. */
function parseTable(lines: string[], start: number): { block: Block; next: number } | null {
  const header = lines[start];
  const divider = lines[start + 1];
  if (!header?.includes('|') || !divider) return null;
  if (!/^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(divider)) return null;

  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => parseInline(cell.trim()));

  const rows: Inline[][][] = [];
  let i = start + 2;
  while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
    rows.push(cells(lines[i]));
    i += 1;
  }

  return { block: { kind: 'table', header: cells(header), rows }, next: i };
}

/* ------------------------------------------------------------------ */
/* Plain text                                                           */
/* ------------------------------------------------------------------ */

/**
 * Markdown reduced to readable text, for search, previews and `.txt` export.
 *
 * Through the parser rather than by stripping characters with a regex, so a
 * `#` inside a code fence stays put and a table does not come out as a row of
 * pipes. The preview on a card and the body a search runs over are then the
 * same text, which is what stops "I can see the word but search cannot".
 */
export function blocksToText(blocks: Block[]): string {
  const out: string[] = [];

  for (const block of blocks) {
    switch (block.kind) {
      case 'heading':
      case 'paragraph':
        out.push(inlineToText(block.children));
        break;
      case 'quote':
        out.push(blocksToText(block.blocks));
        break;
      case 'list':
        for (const item of block.items) {
          const box = item.checked === null ? '' : item.checked ? '[x] ' : '[ ] ';
          out.push(`${'  '.repeat(item.depth)}• ${box}${inlineToText(item.children)}`);
        }
        break;
      case 'code':
        out.push(block.text);
        break;
      case 'table':
        out.push(block.header.map(inlineToText).join('\t'));
        for (const row of block.rows) out.push(row.map(inlineToText).join('\t'));
        break;
      case 'rule':
        out.push('—');
        break;
    }
  }

  return out.join('\n');
}

export function noteToText(markdown: string): string {
  return blocksToText(parseBlocks(markdown));
}

/**
 * The line a note is known by when it has no title of its own.
 *
 * Imported notes very often have none — a Keep note is a body and nothing else
 * — and "(untitled)" repeated forty times is a list you cannot use. The first
 * meaningful line is what every notes app shows, and going through the parser
 * means a note starting with `# Shopping` is called *Shopping* rather than
 * *# Shopping*.
 */
export function derivedTitle(body: string, max = 80): string {
  for (const line of noteToText(body).split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed.length > max ? `${trimmed.slice(0, max).trimEnd()}…` : trimmed;
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* CSV                                                                  */
/* ------------------------------------------------------------------ */

/**
 * A CSV reader that survives the things that break a `split(',')`.
 *
 * A comma inside a body, a quote inside a quoted field, a newline inside
 * either. The vault's importer says the same thing about password exports and
 * for the same reason — those are exactly the rows it is hardest to notice have
 * been corrupted.
 *
 * Here rather than in the vault package because both need it and the vault is
 * deletable: a reader that disappears when somebody removes a feature they were
 * not using is a poor foundation for the notes importer.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  // A byte-order mark is stripped for the reason `json.ts` strips one: Windows
  // tools write them and the first column name silently stops matching.
  const input = text.replace(/^﻿/, '');

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      // Either line ending, and `\r\n` counts once.
      if (char === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

/** One CSV row, quoted only where it has to be. */
export function csvRow(cells: (string | number | null | undefined)[]): string {
  return cells
    .map((cell) => {
      const text = cell === null || cell === undefined ? '' : String(cell);
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    })
    .join(',');
}
