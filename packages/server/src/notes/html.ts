/**
 * HTML to Markdown, for the exports that are secretly web pages.
 *
 * Evernote's `.enex` wraps every note in ENML, which is HTML with a different
 * doctype. Apple Notes exports HTML. Bear and Joplin can. So this is written
 * once rather than four times, and every importer that meets markup hands it
 * here.
 *
 * ### Not a parser, and that is a decision
 *
 * It walks tags with a regex rather than building a tree. A real HTML parser is
 * a large thing to own, and the input here is not the open web — it is one
 * app's exporter emitting a narrow, predictable subset. What it costs is
 * deeply-nested or malformed markup coming out imperfectly, which for a note is
 * a paragraph in the wrong place rather than data lost.
 *
 * **What it must never do is emit HTML.** Anything it does not recognise has
 * its tags stripped and its text kept: a note is Markdown by the time it
 * reaches the database, so a `<script>` in somebody's Evernote export arrives
 * as inert text rather than as something the renderer has to be trusted to
 * refuse later.
 */

/** The named entities that actually appear, plus numeric ones. */
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', bull: '•', middot: '·', copy: '©',
  reg: '®', trade: '™', deg: '°', pound: '£', euro: '€',
  times: '×', divide: '÷', laquo: '«', raquo: '»', check: '✓',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      // Surrogates and out-of-range values would throw or produce a lone
      // surrogate that later breaks JSON — left as written instead.
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Escape the characters that would otherwise become Markdown by accident. */
function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_[\]])/g, '\\$1');
}

/**
 * Markup to Markdown.
 *
 * Block tags become blank-line-separated blocks, inline tags become their
 * Markdown spelling, and everything else is dropped with its text kept.
 */
export function htmlToMarkdown(html: string): string {
  let text = html;

  // Whole elements whose *contents* are not text at all.
  text = text.replace(/<(script|style|head|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  /*
   * Evernote's to-do boxes, which are an element rather than text. Done before
   * lists so a checked item inside a bullet keeps both.
   */
  text = text.replace(/<en-todo[^>]*checked\s*=\s*["']?true["']?[^>]*\/?>/gi, '[x] ');
  text = text.replace(/<en-todo[^>]*\/?>/gi, '[ ] ');

  // Images and links, before the general tag strip that would lose their URLs.
  text = text.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = attr(tag, 'src');
    const alt = attr(tag, 'alt');
    // An Evernote resource reference points at an attachment by hash, which
    // this importer has no file for — kept as a marker rather than a broken
    // image that renders as an error.
    if (!src) return alt ? `[${alt}]` : '[image]';
    return `![${alt}](${src})`;
  });

  text = text.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_whole, attrs: string, inner: string) => {
    const href = attr(`<a ${attrs}>`, 'href');
    const label = stripTags(inner).trim();
    if (!href) return label;
    // A link whose text is its own address reads better as a bare URL than as
    // `[https://x](https://x)`, which is how most exporters write them.
    return label === href || !label ? href : `[${label}](${href})`;
  });

  // Inline emphasis.
  text = text.replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_w, _t, inner: string) => `**${stripTags(inner)}**`);
  text = text.replace(/<(i|em)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_w, _t, inner: string) => `*${stripTags(inner)}*`);
  text = text.replace(/<(s|strike|del)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_w, _t, inner: string) => `~~${stripTags(inner)}~~`);
  text = text.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_w, inner: string) => `\`${stripTags(inner)}\``);

  // Fenced code, before paragraphs so its newlines survive.
  text = text.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_w, inner: string) => {
    const code = decodeEntities(stripTags(inner.replace(/<br\s*\/?>/gi, '\n')));
    return `\n\n\`\`\`\n${code.replace(/^\n+|\n+$/g, '')}\n\`\`\`\n\n`;
  });

  text = text.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_w, level: string, inner: string) => {
    const heading = stripTags(inner).trim();
    return heading ? `\n\n${'#'.repeat(Number(level))} ${heading}\n\n` : '\n\n';
  });

  text = text.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_w, inner: string) => {
    const quoted = stripTags(inner)
      .trim()
      .split('\n')
      .map((line) => `> ${line.trim()}`)
      .join('\n');
    return `\n\n${quoted}\n\n`;
  });

  text = text.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_w, inner: string) => tableToMarkdown(inner));

  // Lists. Ordered ones are numbered as they are met, so a list of ten does not
  // come out as ten items all called "1.".
  text = text.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_w, inner: string) => {
    let n = 0;
    return `\n\n${listItems(inner)
      .map((item) => `${(n += 1)}. ${item}`)
      .join('\n')}\n\n`;
  });
  text = text.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_w, inner: string) => {
    return `\n\n${listItems(inner)
      .map((item) => `- ${item}`)
      .join('\n')}\n\n`;
  });

  text = text.replace(/<hr\b[^>]*\/?>/gi, '\n\n---\n\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|section|article|li|tr)>/gi, '\n\n');

  text = stripTags(text);
  text = decodeEntities(text);

  return tidy(text);
}

/** Collapse the blank lines markup leaves behind, without losing paragraphs. */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

function attr(tag: string, name: string): string {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return decodeEntities(match?.[2] ?? match?.[3] ?? match?.[4] ?? '');
}

function listItems(inner: string): string[] {
  return [...inner.matchAll(/<li\b[^>]*>([\s\S]*?)(?=<li\b|<\/[uo]l>|$)/gi)]
    .map((match) => decodeEntities(stripTags(match[1].replace(/<\/li>/gi, ''))).trim().replace(/\n+/g, ' '))
    .filter(Boolean);
}

/** An HTML table to a GFM pipe table, which the note parser reads back. */
function tableToMarkdown(inner: string): string {
  const rows = [...inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
    [...row[1].matchAll(/<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((cell) =>
      // A pipe inside a cell would end the cell; escaped, since a table with a
      // stray column is worse than one with a visible backslash.
      decodeEntities(stripTags(cell[2])).trim().replace(/\|/g, '\\|').replace(/\n+/g, ' ')
    )
  );

  if (rows.length === 0) return '\n\n';

  const width = Math.max(...rows.map((row) => row.length));
  const pad = (row: string[]) => Array.from({ length: width }, (_, i) => row[i] ?? '');

  const [header, ...body] = rows;
  return (
    `\n\n| ${pad(header).join(' | ')} |\n| ${Array(width).fill('---').join(' | ')} |\n` +
    body.map((row) => `| ${pad(row).join(' | ')} |`).join('\n') +
    '\n\n'
  );
}

/** Plain text to Markdown, escaping what would otherwise become formatting. */
export function textToMarkdown(text: string): string {
  return tidy(escapeMarkdown(text.replace(/\r\n?/g, '\n')));
}
