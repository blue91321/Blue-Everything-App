/**
 * Markdown on screen, as React elements.
 *
 * ### It never touches `dangerouslySetInnerHTML`, and that is the point
 *
 * A note can arrive by dropping somebody else's Evernote export into the app,
 * so its body is genuinely untrusted input. Building elements means React
 * escapes everything by construction — this app has exactly one place that
 * assembles HTML by hand, and that is precisely where its one reflected-XSS
 * hole was found. A Markdown renderer emitting a string would be the second,
 * on a far wider input.
 *
 * The parser lives in `shared` and feeds the PDF and Word exports too, so what
 * is on screen and what comes out of a file are the same reading of the same
 * text.
 */
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Block, Inline } from '@everything/shared/notes';

export interface MarkdownHandlers {
  /** A `[[wiki-link]]` was clicked. The target may not exist yet. */
  onOpenNote?: (target: string) => void;
  onOpenTag?: (tag: string) => void;
  /** Which link targets exist, so a dead one can look dead. */
  known?: (target: string) => boolean;
}

export function Markdown({ blocks, handlers }: { blocks: Block[]; handlers?: MarkdownHandlers }) {
  return (
    <div className="md">
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} handlers={handlers} />
      ))}
    </div>
  );
}

function BlockView({ block, handlers }: { block: Block; handlers?: MarkdownHandlers }) {
  switch (block.kind) {
    case 'heading': {
      // Clamped to h2–h6: the screen already has an h1 for the note's title, and
      // a second one is wrong for anything reading the page structure.
      const Tag = `h${Math.min(6, block.level + 1)}` as 'h2';
      return (
        <Tag className="md-h">
          <InlineView nodes={block.children} handlers={handlers} />
        </Tag>
      );
    }

    case 'paragraph':
      return (
        <p className="md-p">
          <InlineView nodes={block.children} handlers={handlers} />
        </p>
      );

    case 'quote':
      return (
        <blockquote className="md-quote">
          {block.blocks.map((inner, i) => (
            <BlockView key={i} block={inner} handlers={handlers} />
          ))}
        </blockquote>
      );

    case 'code':
      return (
        <pre className="md-code">
          <code>{block.text}</code>
        </pre>
      );

    case 'rule':
      return <hr className="md-rule" />;

    case 'list':
      /*
       * The parser hands back a flat list with a depth per item, because the PDF
       * and Word exports both want the number. Nesting is rebuilt here, since
       * this is the one renderer that wants a tree.
       */
      return <ListView ordered={block.ordered} items={block.items} handlers={handlers} />;

    case 'table':
      return (
        <div className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th key={i}>
                    <InlineView nodes={cell} handlers={handlers} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j}>
                      <InlineView nodes={cell} handlers={handlers} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

type Items = Extract<Block, { kind: 'list' }>['items'];

/** Flat-with-depth back to nested lists, one level per call. */
function ListView({
  ordered,
  items,
  handlers,
  depth = 0,
}: {
  ordered: boolean;
  items: Items;
  handlers?: MarkdownHandlers;
  depth?: number;
}) {
  const Tag = ordered ? 'ol' : 'ul';
  const out: React.ReactNode[] = [];

  for (let i = 0; i < items.length; i++) {
    if (items[i].depth < depth) break;
    if (items[i].depth > depth) continue;

    // Everything below this item until the next one at the same depth is its
    // children — which is what "flat with a depth" means once you read it back.
    const start = i + 1;
    let end = start;
    while (end < items.length && items[end].depth > depth) end += 1;

    const item = items[i];
    out.push(
      <li key={i} className={item.checked === null ? undefined : 'md-task'}>
        {item.checked !== null && (
          <input
            type="checkbox"
            checked={item.checked}
            readOnly
            /*
             * Read-only on purpose. Ticking here would have to write back into
             * the Markdown by position, and a body edited in two places at once
             * is how a note loses a paragraph. The box is a picture of the text.
             */
            aria-label={item.checked ? 'done' : 'not done'}
          />
        )}
        <InlineView nodes={item.children} handlers={handlers} />
        {end > start && (
          <ListView ordered={ordered} items={items.slice(start, end)} handlers={handlers} depth={depth + 1} />
        )}
      </li>
    );
  }

  return <Tag className="md-list">{out}</Tag>;
}

function InlineView({ nodes, handlers }: { nodes: Inline[]; handlers?: MarkdownHandlers }) {
  return (
    <>
      {nodes.map((node, i) => {
        switch (node.kind) {
          case 'text':
            return <span key={i}>{node.text}</span>;

          case 'code':
            return (
              <code key={i} className="md-inline-code">
                {node.text}
              </code>
            );

          case 'strong':
            return (
              <strong key={i}>
                <InlineView nodes={node.children} handlers={handlers} />
              </strong>
            );

          case 'em':
            return (
              <em key={i}>
                <InlineView nodes={node.children} handlers={handlers} />
              </em>
            );

          case 'strike':
            return (
              <s key={i}>
                <InlineView nodes={node.children} handlers={handlers} />
              </s>
            );

          case 'link':
            return <ExternalLink key={i} href={node.href} nodes={node.children} handlers={handlers} />;

          case 'image':
            return <NoteImage key={i} src={node.src} alt={node.alt} />;

          case 'wiki': {
            const exists = handlers?.known?.(node.target) ?? true;
            return (
              <button
                key={i}
                type="button"
                className={`md-wiki${exists ? '' : ' md-wiki-new'}`}
                // Said out loud, because the only other signal that a link goes
                // nowhere yet is a colour.
                title={exists ? `Open ${node.target}` : `${node.target} — not written yet`}
                onClick={() => handlers?.onOpenNote?.(node.target)}
              >
                {node.label}
              </button>
            );
          }

          case 'tag':
            return (
              <button key={i} type="button" className="md-tag" onClick={() => handlers?.onOpenTag?.(node.tag)}>
                #{node.tag}
              </button>
            );
        }
      })}
    </>
  );
}

/**
 * An ordinary link, restricted to the schemes a note may open.
 *
 * The same rule voice commands follow: `http:` and `https:` only, so a note
 * cannot hand the browser a `javascript:` URL — which is a real XSS vector in a
 * Markdown renderer and the one that survives building elements rather than
 * HTML, because React will happily set an `href` to anything.
 */
function ExternalLink({
  href,
  nodes,
  handlers,
}: {
  href: string;
  nodes: Inline[];
  handlers?: MarkdownHandlers;
}) {
  const safe = /^(https?:|mailto:|\/)/i.test(href.trim());

  if (!safe) {
    // Shown as text with its address, rather than silently dropped: a link that
    // vanishes looks like the renderer losing content.
    return (
      <span className="md-unsafe" title="only http, https and mailto links open from a note">
        <InlineView nodes={nodes} handlers={handlers} /> ({href})
      </span>
    );
  }

  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      <InlineView nodes={nodes} handlers={handlers} />
    </a>
  );
}

/**
 * A picture in a note.
 *
 * An attachment lives behind `/api/`, and an `<img src>` sends no bearer token
 * — so the bytes are fetched and wrapped in an object URL, exactly as the habit
 * pictures are. Anything already absolute is left to the browser.
 */
function NoteImage({ src, alt }: { src: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const needsToken = src.startsWith('/api/');

  useEffect(() => {
    if (!needsToken) return;

    let live = true;
    let objectUrl = '';

    void api.notes
      .fetchFile(src)
      .then((blob) => {
        if (!live) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => live && setFailed(true));

    return () => {
      live = false;
      // Revoked, or every render of a note with pictures leaks one per image.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, needsToken]);

  if (failed) return <span className="md-unsafe">[{alt || 'image'} — could not be loaded]</span>;

  const resolved = needsToken ? url : src;
  if (!resolved) return <span className="meta">[{alt || 'image'}…]</span>;

  return <img className="md-image" src={resolved} alt={alt} />;
}
