/**
 * Linked servers' Local collections in Browse, and the copies of theirs kept
 * here (2026-11-21). A linked server is another person's own Blue Everything,
 * linked on purpose in Settings → People → Linked servers; see `routes/peers.ts`
 * for what it shares and how.
 *
 * Each linked server that shares its collection is a choice in Browse's "Browse
 * from", listed after this server's own Local collection. A series opens to its
 * kept chapters, read in the ordinary reader as a preview (nothing is marked
 * read: it is not in your library), and **Copy to my Local collection** keeps a
 * copy here, fetched from their server in the background, so it reads when
 * their PC is off or the link is gone. Copies are listed under your own Local
 * collection.
 */
import { useEffect, useState } from 'react';
import { manga, type CopiedSeries, type LinkedChapter, type LinkedPeer, type LinkedSeriesRow } from './manga-api';
import { Cover } from './Cover';
import { Reader } from './Reader';
import { beside } from './chapter-nav';

/** What Browse opens: a linked server's series, or a copy of one kept here. */
export type LinkedTarget = { kind: 'peer'; peer: string; manga: string; title: string } | { kind: 'copy'; seriesId: string; title: string };

/** The linked servers, asked once per visit to Browse. Empty on a friend's copy, whose links are the host's. */
export function useLinkedPeers(): LinkedPeer[] {
  const [peers, setPeers] = useState<LinkedPeer[]>([]);
  useEffect(() => {
    manga.linked.peers().then(
      (got) => setPeers(got.peers),
      () => setPeers([])
    );
  }, []);
  return peers;
}

const chaptersText = (n: number) => (n === 1 ? '1 chapter' : `${n} chapters`);

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="manga-browse-grid">{children}</div>;
}

function LinkedTile({ title, cover, meta, onOpen }: { title: string; cover: string | null; meta: string; onOpen: () => void }) {
  return (
    <div className="manga-browse-tile">
      <button className="manga-browse-open" onClick={onOpen} title={title}>
        <Cover path={cover} title={title} fill />
        <span className="title manga-browse-title">{title}</span>
        <span className="meta manga-browse-chapters">{meta}</span>
      </button>
    </div>
  );
}

/** One linked server's Local collection, as Browse's grid. */
export function PeerCollection({ peer, onOpen }: { peer: LinkedPeer; onOpen: (t: LinkedTarget) => void }) {
  const [rows, setRows] = useState<LinkedSeriesRow[] | null>(null);
  const [problem, setProblem] = useState('');
  const [filter, setFilter] = useState('');

  useEffect(() => {
    setRows(null);
    setProblem('');
    manga.linked.collection(peer.id).then(
      (got) => setRows(got.series),
      (e: unknown) => setProblem(e instanceof Error ? e.message : 'could not reach their server')
    );
  }, [peer.id]);

  if (problem) {
    return (
      <p className="banner">
        {problem}. Their PC has to be on, and their machine shared with your tailnet in Tailscale.
      </p>
    );
  }
  if (!rows) return <p className="empty">Asking {peer.name}'s server…</p>;
  if (rows.length === 0) return <p className="empty">Nothing is in {peer.name}'s Local collection yet.</p>;
  const typed = filter.trim().toLowerCase();
  const shown = typed ? rows.filter((r) => r.title.toLowerCase().includes(typed)) : rows;
  return (
    <>
      <p className="meta">
        {rows.length} series in {peer.name}'s Local collection, read from their server while their PC is on.
        {peer.copy ? ' Open one to copy it into yours, so it reads when theirs is off.' : ' They share it to read, not to copy.'}
      </p>
      {rows.length > 12 && (
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by title" aria-label="Filter by title" style={{ width: '100%' }} />
      )}
      <Grid>
        {shown.map((r) => (
          <LinkedTile
            key={r.mangaId}
            title={r.title}
            cover={`/api/manga/peers/${peer.id}/cover?manga=${r.mangaId}`}
            meta={`${chaptersText(r.complete)}${r.copied ? ' · copied' : ''}`}
            onOpen={() => onOpen({ kind: 'peer', peer: peer.id, manga: r.mangaId, title: r.title })}
          />
        ))}
      </Grid>
    </>
  );
}

/** Copies of linked servers' series kept here, under your own Local collection. Nothing when there are none. */
export function CopiedList({ onOpen }: { onOpen: (t: LinkedTarget) => void }) {
  const [copies, setCopies] = useState<CopiedSeries[]>([]);
  useEffect(() => {
    manga.linked.copies().then(
      (got) => setCopies(got.copies),
      () => setCopies([])
    );
  }, []);
  if (copies.length === 0) return null;
  return (
    <>
      <p className="meta" style={{ marginTop: 16 }}>
        <strong>Copied from linked servers</strong>: kept here, so they read whether or not their server is on.
      </p>
      <Grid>
        {copies.map((c) => (
          <LinkedTile
            key={c.seriesId}
            title={c.title}
            cover={null}
            meta={`${c.complete} of ${chaptersText(c.chapters)} · from ${c.of.name}`}
            onOpen={() => onOpen({ kind: 'copy', seriesId: c.seriesId, title: c.title })}
          />
        ))}
      </Grid>
    </>
  );
}

/** A linked server's series, or a copy of one: its chapters, the reader, and copying. */
export function LinkedSeries({ target, onBack }: { target: LinkedTarget; onBack: () => void }) {
  const [chapters, setChapters] = useState<LinkedChapter[] | null>(null);
  const [about, setAbout] = useState<{ from: string; sourceName: string; canCopy: boolean; copy: { chapters: number; complete: number } | null; waiting: number }>({
    from: '',
    sourceName: '',
    canCopy: false,
    copy: null,
    waiting: 0,
  });
  const [problem, setProblem] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<LinkedChapter | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setProblem('');
    const load =
      target.kind === 'peer'
        ? manga.linked.series(target.peer, target.manga).then((got) => {
            setChapters(got.chapters);
            setAbout({ from: got.peer.name, sourceName: got.sourceName, canCopy: got.peer.copy, copy: got.copy, waiting: 0 });
          })
        : manga.linked.copied(target.seriesId).then((got) => {
            setChapters(got.chapters);
            setAbout({ from: got.of.name, sourceName: got.of.sourceName, canCopy: false, copy: null, waiting: got.waiting });
          });
    load.catch((e: unknown) => setProblem(e instanceof Error ? e.message : 'could not list its chapters'));
  }, [target, tick]);

  const preview = target.kind === 'peer' ? `peer:${target.peer}:${target.manga}` : `copy:${target.seriesId}`;

  if (open && chapters) {
    return (
      <Reader
        preview={preview}
        chapter={open}
        backLabel="Chapters"
        onClose={() => setOpen(null)}
        onFinished={() => undefined}
        onGo={(direction) => {
          const next = beside(chapters, open.number, direction);
          if (next) setOpen(next);
        }}
        hasPrevious={beside(chapters, open.number, -1) !== undefined}
        hasNext={beside(chapters, open.number, 1) !== undefined}
        nextNumber={beside(chapters, open.number, 1)?.number ?? null}
      />
    );
  }

  async function copy() {
    if (target.kind !== 'peer') return;
    setBusy(true);
    setNote('');
    try {
      const got = await manga.linked.copy(target.peer, target.manga);
      setNote(
        got.queued > 0
          ? `Copying ${chaptersText(got.queued)} from ${about.from}'s server, a page at a time, in the background. Downloads → Kept for good shows how far it has got.`
          : 'Your copy already has every chapter they keep.'
      );
      setTick((t) => t + 1);
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'could not start the copy');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="manga-linked-series">
      <button className="btn subtle" onClick={onBack}>
        ‹ Back
      </button>
      <h3 style={{ margin: '8px 0 4px' }}>{target.title}</h3>
      <p className="meta">
        {target.kind === 'peer' ? `In ${about.from || 'their'} Local collection` : `Copied from ${about.from || 'a linked server'}`}
        {about.sourceName ? `, from ${about.sourceName}` : ''}. Read here as a preview: nothing is marked read, since it is not in your library.
      </p>
      {target.kind === 'peer' && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {about.canCopy ? (
            <button className="btn primary" disabled={busy} onClick={() => void copy()}>
              {busy ? '…' : about.copy ? `Copy what is new (${about.copy.complete} of ${about.copy.chapters} copied)` : 'Copy to my Local collection'}
            </button>
          ) : (
            <span className="meta">{about.from || 'They'} share this to read, not to copy.</span>
          )}
        </div>
      )}
      {target.kind === 'copy' && about.waiting > 0 && <p className="meta">{chaptersText(about.waiting)} still being copied.</p>}
      {note && <p className="meta">{note}</p>}
      {problem && <p className="banner">{problem}</p>}
      {chapters && chapters.length === 0 && <p className="empty">No whole chapters yet.</p>}
      {chapters && chapters.length > 0 && (
        <div className="manga-linked-chapters">
          {[...chapters].reverse().map((c) => (
            <button key={c.id} className="row between manga-linked-chapter" onClick={() => setOpen(c)}>
              <span>{c.name || `Chapter ${c.number}`}</span>
              <span className="meta">{c.pages} pages</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
