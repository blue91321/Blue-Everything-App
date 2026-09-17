/**
 * A PDF, written by hand from the note blocks.
 *
 * Dependency-free like the PNG encoder, the WAV writer and the zip: the format
 * needed here is a handful of dictionaries, one content stream per page and a
 * cross-reference table. A PDF library is several megabytes to lay out
 * paragraphs of Helvetica.
 *
 * ### The one real limitation, stated rather than discovered
 *
 * It uses the **standard fonts** — Helvetica and Courier — which every reader
 * has and nobody has to ship. Those cover Latin-1 and nothing else, so an emoji
 * or a line of Chinese comes out as `?`. The alternative is embedding a
 * Unicode font, which means a multi-megabyte binary checked into a repository
 * whose icons and sounds are all *generated* precisely so it holds none.
 *
 * So the exporter says so on the screen, and anybody whose notes are not Latin
 * has Markdown, TXT, Word and the vault — all of which are UTF-8 and lose
 * nothing.
 */
import { inlineToText, type Block, type Inline } from '@everything/shared/notes';

/* ------------------------------------------------------------------ */
/* Page geometry                                                       */
/* ------------------------------------------------------------------ */

/** A4 in points, which is the unit PDF thinks in — 72 to the inch. */
const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const BODY_SIZE = 10.5;
const LINE_HEIGHT = 1.45;

/* ------------------------------------------------------------------ */
/* Font metrics                                                        */
/* ------------------------------------------------------------------ */

/**
 * Character widths for the standard fonts, in thousandths of an em.
 *
 * Wrapping needs real widths. Guessing an average makes every line of capitals
 * overflow the margin and every line of `iiii` end early, and a PDF whose text
 * runs off the page is worse than no PDF. These are the published AFM widths
 * for ASCII 32–126; Courier is monospaced, so it is one number.
 */
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const HELVETICA_BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

type FontName = 'body' | 'bold' | 'italic' | 'mono';

function widthOf(text: string, font: FontName, size: number): number {
  if (font === 'mono') return text.length * 600 * (size / 1000);

  const table = font === 'bold' ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  let total = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    // Anything outside the table is charged the width of an `n`, which is the
    // closest thing to an average and stops an accented word wrapping short.
    total += code >= 32 && code <= 126 ? table[code - 32] : 556;
  }
  return total * (size / 1000);
}

/* ------------------------------------------------------------------ */
/* Text encoding                                                       */
/* ------------------------------------------------------------------ */

/**
 * The handful of characters worth translating rather than losing.
 *
 * Markdown is full of curly quotes and dashes because editors insert them, and
 * a PDF full of `?` where every apostrophe was is the sort of thing that makes
 * an export look broken. Everything here has an honest Latin-1 equivalent;
 * nothing is invented.
 */
const TRANSLITERATE: Record<string, string> = {
  '‘': "'", '’': "'", '‚': ',', '“': '"', '”': '"',
  '–': '-', '—': '-', '−': '-', '…': '...', '•': '·',
  ' ': ' ', ' ': ' ', '​': '', '→': '->', '←': '<-',
  '✓': 'v', '✗': 'x', '×': 'x',
};

/**
 * Text to the bytes a PDF string holds, in WinAnsiEncoding.
 *
 * `(`, `)` and the backslash have to be escaped or they end the string early —
 * which does not produce a wrong character, it produces a file no reader will
 * open.
 */
function pdfString(text: string): string {
  let out = '';
  for (const char of text) {
    const mapped = TRANSLITERATE[char] ?? char;
    for (const c of mapped) {
      const code = c.charCodeAt(0);
      if (c === '(' || c === ')' || c === String.fromCharCode(92)) {
        out += String.fromCharCode(92) + c;
      } else if (code >= 32 && code <= 126) {
        out += c;
      } else if (code >= 160 && code <= 255) {
        // Latin-1 lines up with WinAnsi above 160, so it goes out as an octal
        // escape rather than a raw byte that a text-mode write would mangle.
        out += String.fromCharCode(92) + code.toString(8).padStart(3, '0');
      } else {
        out += '?';
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Laying out                                                          */
/* ------------------------------------------------------------------ */

interface Line {
  text: string;
  font: FontName;
  size: number;
  indent: number;
  /** Space above, for headings and between blocks. */
  spaceBefore: number;
}

/** Break a string to a width, on spaces where possible. */
function wrap(text: string, font: FontName, size: number, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];

  const lines: string[] = [];
  let line = '';

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (widthOf(candidate, font, size) <= width || !line) {
      /*
       * A single word longer than the line is broken by character rather than
       * left to overflow — a URL in a note would otherwise run into the margin
       * and off the page.
       */
      if (!line && widthOf(word, font, size) > width) {
        let piece = '';
        for (const char of word) {
          if (widthOf(piece + char, font, size) > width && piece) {
            lines.push(piece);
            piece = char;
          } else {
            piece += char;
          }
        }
        line = piece;
        continue;
      }
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }

  if (line) lines.push(line);
  return lines;
}

/** Blocks to a flat run of laid-out lines. */
function layout(blocks: Block[], depth = 0): Line[] {
  const lines: Line[] = [];
  const indentOf = (extra: number) => depth * 16 + extra;

  const push = (text: string, font: FontName, size: number, indent: number, spaceBefore: number) => {
    for (const [i, piece] of wrap(text, font, size, CONTENT_WIDTH - indent).entries()) {
      lines.push({ text: piece, font, size, indent, spaceBefore: i === 0 ? spaceBefore : 0 });
    }
  };

  for (const block of blocks) {
    switch (block.kind) {
      case 'heading': {
        // 1.9em down to about 1.1em, so six levels stay distinguishable without
        // the deepest one being smaller than the body text.
        const size = BODY_SIZE * Math.max(1.05, 2 - block.level * 0.15);
        push(inlineToText(block.children), 'bold', size, indentOf(0), size * 0.9);
        break;
      }
      case 'paragraph':
        push(inlineToText(block.children), 'body', BODY_SIZE, indentOf(0), BODY_SIZE * 0.6);
        break;
      case 'quote':
        // Indented rather than ruled: a vertical line would mean tracking where
        // the quote started across a page break, for a decoration.
        lines.push(...layout(block.blocks, depth + 1));
        break;
      case 'list':
        for (const item of block.items) {
          const marker = item.checked === null ? '·' : item.checked ? '[x]' : '[ ]';
          push(
            `${marker} ${inlineToText(item.children)}`,
            'body',
            BODY_SIZE,
            indentOf(12 + item.depth * 14),
            BODY_SIZE * 0.25
          );
        }
        break;
      case 'code':
        for (const row of block.text.split('\n')) {
          push(row || ' ', 'mono', BODY_SIZE * 0.92, indentOf(12), 0);
        }
        break;
      case 'table': {
        // Tab-separated rather than ruled. Drawing a real table means measuring
        // every column and splitting cells across pages, which is a great deal
        // of machinery for something a note uses to hold four values.
        const row = (cells: Inline[][]) => cells.map(inlineToText).join('   |   ');
        push(row(block.header), 'bold', BODY_SIZE, indentOf(0), BODY_SIZE * 0.6);
        for (const cells of block.rows) push(row(cells), 'body', BODY_SIZE, indentOf(0), 0);
        break;
      }
      case 'rule':
        lines.push({ text: '—'.repeat(24), font: 'body', size: BODY_SIZE, indent: indentOf(0), spaceBefore: BODY_SIZE });
        break;
    }
  }

  return lines;
}

/* ------------------------------------------------------------------ */
/* Assembling                                                          */
/* ------------------------------------------------------------------ */

const FONT_RESOURCE: Record<FontName, string> = {
  body: 'F1',
  bold: 'F2',
  italic: 'F3',
  mono: 'F4',
};

export interface PdfNote {
  title: string;
  blocks: Block[];
}

/**
 * One PDF holding every note given, each starting on a new page.
 *
 * A note per page rather than running them together: an export of forty notes
 * is a document you scroll looking for one of them, and a page break is the
 * only signal that costs nothing.
 */
export function writePdf(notes: PdfNote[]): Buffer {
  const pages: Line[][] = [];
  let current: Line[] = [];
  let y = PAGE_HEIGHT - MARGIN;

  const newPage = () => {
    if (current.length > 0) pages.push(current);
    current = [];
    y = PAGE_HEIGHT - MARGIN;
  };

  for (const note of notes) {
    if (current.length > 0) newPage();

    const lines: Line[] = [
      { text: note.title, font: 'bold', size: BODY_SIZE * 1.9, indent: 0, spaceBefore: 0 },
      ...layout(note.blocks),
    ];

    for (const line of lines) {
      const step = line.size * LINE_HEIGHT + line.spaceBefore;
      // A line that will not fit starts a page rather than being clipped.
      if (y - step < MARGIN) newPage();
      y -= step;
      current.push({ ...line, spaceBefore: PAGE_HEIGHT - MARGIN - y });
    }
  }

  if (current.length > 0) pages.push(current);
  if (pages.length === 0) pages.push([]);

  /* --- objects -------------------------------------------------- */

  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length; // object numbers are 1-based
  };

  const fonts = [
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'),
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>'),
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>'),
  ];

  const resources =
    `<< /Font << /F1 ${fonts[0]} 0 R /F2 ${fonts[1]} 0 R /F3 ${fonts[2]} 0 R /F4 ${fonts[3]} 0 R >> >>`;

  const pagesObject = objects.length + 1 + pages.length * 2;
  const pageRefs: number[] = [];

  for (const lines of pages) {
    const stream = lines
      .map((line) => {
        const top = PAGE_HEIGHT - MARGIN - line.spaceBefore;
        return `BT /${FONT_RESOURCE[line.font]} ${line.size.toFixed(2)} Tf ${(MARGIN + line.indent).toFixed(2)} ${top.toFixed(2)} Td (${pdfString(line.text)}) Tj ET`;
      })
      .join('\n');

    const contents = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    pageRefs.push(
      add(
        `<< /Type /Page /Parent ${pagesObject} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
          `/Resources ${resources} /Contents ${contents} 0 R >>`
      )
    );
  }

  const pagesRef = add(
    `<< /Type /Pages /Kids [${pageRefs.map((ref) => `${ref} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`
  );
  const catalog = add(`<< /Type /Catalog /Pages ${pagesRef} 0 R >>`);

  /* --- the file ------------------------------------------------- */

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];

  for (const [i, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }

  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  /*
   * `latin1` rather than `utf8`, and it is load-bearing: every byte above 127
   * was already written as an octal escape, so a UTF-8 encode here would turn
   * each one into two bytes and every cross-reference offset after it would
   * point at the wrong place. That is a file no reader will open, from a change
   * that looks like a tidy-up.
   */
  return Buffer.from(out, 'latin1');
}
