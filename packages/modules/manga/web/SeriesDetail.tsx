/**
 * One series from a source: what you see when you tap it in Browse.
 *
 * Everything needed to decide whether to follow it — what it is about, who made
 * it, where it stands, how many chapters this source actually has — and the
 * chapters themselves, readable before following. Reading here keeps no place:
 * there is no series yet to keep it in, and the page says so rather than
 * letting a finished chapter quietly go unrecorded.
 *
 * ### Other sources, when it came from a search
 *
 * A search row is every source that has the series, so the page lists them and
 * each opens its own copy of this page. From Popular and Recently released there
 * is only the one source, and the comparison view is a Follow away.
 */
import { useEffect, useRef, useState } from 'react';
import { Cover } from './Cover';
import { Reader } from './Reader';
import { chapterText } from './judge';
import { manga, type BrowseResult, type SeriesDetailPage } from './manga-api';
import { usePositionSaver } from './usePositionSaver';

const STATUS_LABEL: Record<SeriesDetailPage['status'], string> = {
  ongoing: 'Ongoing',
  completed: 'Finished',
  hiatus: 'On hiatus',
  cancelled: 'Cancelled',
  licensed: 'Licensed — taken down from this source',
  unknown: 'Status unknown',
};

/** Long enough to say what it is about; the rest is behind "More". */
const BLURB_CLAMP = 420;

type Chapter = SeriesDetailPage['chapters'][number];

/**
 * "Also on MangaFire" while reading MangaFire's copy reads as a mistake — it is
 * the same site's other edition of the series (the original and an "(Official)"
 * or colour one), so those are counted separately from other sites.
 */
function alsoOn(others: BrowseResult[], here: string): string {
  const elsewhere = [...new Set(others.map((o) => o.sourceName).filter((n) => n !== here))];
  const editions = others.filter((o) => o.sourceName === here).length;
  const parts = [
    elsewhere.length > 0 ? `Also on ${elsewhere.join(', ')}` : null,
    editions > 0 ? `${editions} other edition${editions === 1 ? '' : 's'} on ${here}` : null,
  ].filter(Boolean);
  return parts.join(' · ');
}

export function SeriesDetail({
  result,
  others,
  following,
  onBack,
  onOpen,
  onFollow,
  onRead,
  ownSeriesId,
  updatesUrl,
}: {
  result: BrowseResult;
  /** The same series on other sources, when it was opened from a search. */
  others: BrowseResult[];
  /** The library series this is, if followed — by this screen or before. */
  following: string | null;
  onBack: () => void;
  /** Open one of the other sources' copies in this page instead. */
  onOpen: (r: BrowseResult) => void;
  onFollow: (r: BrowseResult) => Promise<void>;
  onRead: (seriesId: string) => void;
  /**
   * The library series whose linked source *is* this copy — set when the page
   * is opened from the library's Details. Reading then keeps your place like
   * the library's own reader does, since this is the same series on the same
   * source rather than a preview of something you might follow.
   */
  ownSeriesId?: string;
  /** Its MangaUpdates page, which is where Details used to go. */
  updatesUrl?: string | null;
}) {
  const [page, setPage] = useState<SeriesDetailPage | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [blurbOpen, setBlurbOpen] = useState(false);
  const [open, setOpen] = useState<Chapter | null>(null);
  const [following_, setFollowing] = useState(false);
  // Only for your own series' linked copy: a preview has no series to keep a place in.
  const saver = usePositionSaver(ownSeriesId ?? null);
  const [resume, setResume] = useState<{ page: number; offset: number } | null>(null);
  /**
   * Where the reader last said you were. Held in a ref while reading — it
   * changes several times a second — and written into the page once you close
   * the chapter, so the row you came back to is lit without asking the site for
   * the whole page again.
   */
  const lastPlace = useRef<{ chapter: number; chapterId: string; chapterName: string; page: number; offset: number; pages: number } | null>(null);

  useEffect(() => {
    let alive = true;
    setPage(null);
    setProblem(null);
    setOpen(null);
    manga.browse.detail(result.id).then(
      (p) => alive && setPage(p),
      (e: unknown) => alive && setProblem(e instanceof Error ? e.message : 'the source did not answer')
    );
    return () => {
      alive = false;
    };
  }, [result.id]);

  // Followed with no source yet reads as not followed here: see `needsSource` in Browse.
  const followingId = following ?? (page?.unlinked || result.unlinked ? null : page?.following ?? null);

  if (open && page) {
    return (
      <Reader
        {...(ownSeriesId ? { seriesId: ownSeriesId } : { preview: result.id })}
        chapter={open}
        backLabel="Details"
        resume={resume}
        onClose={() => {
          saver.flush();
          const place = lastPlace.current;
          if (ownSeriesId && place) {
            setPage((p) =>
              p ? { ...p, position: { ...place, source: result.sourceName, mangaId: result.id, at: Date.now() } } : p
            );
          }
          lastPlace.current = null;
          setResume(null);
          setOpen(null);
        }}
        onPosition={
          ownSeriesId
            ? (p) => {
                const place = { chapter: open.number, chapterId: open.id, chapterName: open.name, ...p };
                lastPlace.current = place;
                saver.note(place);
              }
            : undefined
        }
        onFinished={async (n) => {
          saver.flush();
          lastPlace.current = null;
          setResume(null);
          if (ownSeriesId) {
            await manga.reader.markRead(ownSeriesId, n).catch(() => undefined);
            // As the server did: read here, and your place moves past it.
            setPage((p) =>
              p
                ? {
                    ...p,
                    position: p.position && p.position.chapter <= n ? null : p.position,
                    chapters: p.chapters.map((c) => (c.number === n ? { ...c, read: true, readOn: result.sourceName } : c)),
                  }
                : p
            );
          }
          // Next *up* by number, as the followed reader does; the list is newest-first.
          const next = page.chapters.filter((c) => c.number > n).sort((a, b) => a.number - b.number)[0];
          setOpen(next ?? null);
        }}
      />
    );
  }

  const first = page ? [...page.chapters].sort((a, b) => a.number - b.number)[0] ?? null : null;
  const blurb = page?.description ?? null;
  const long = blurb !== null && blurb.length > BLURB_CLAMP;
  // Sites put the artist among the authors as often as not ("Ye Xiao, Wuer
  // Manhua" and "Wuer Manhua"), so names are split and each said once.
  const people = page
    ? [
        ...new Set(
          [page.author, page.artist]
            .flatMap((p) => (p ?? '').split(','))
            .map((n) => n.trim())
            .filter(Boolean)
        ),
      ].join(', ')
    : '';

  return (
    <div className="manga-detail">
      <button className="btn subtle" onClick={onBack}>
        ‹ Back
      </button>

      <div className="manga-detail-head">
        <Cover path={page?.coverPath ?? result.coverPath} title={result.title} size={150} />
        <div className="manga-detail-facts">
          <h2 className="manga-detail-title">{page?.title || result.title}</h2>
          {people && <span className="meta">{people}</span>}
          <span className="meta">
            {page ? STATUS_LABEL[page.status] : '…'} · {result.sourceName}
          </span>
          {page?.profile.latest != null && (
            <span className="meta">
              <span className="strong">
                {page.profile.distinct} chapter{page.profile.distinct === 1 ? '' : 's'}
              </span>
              {page.profile.first !== null && ` · ${chapterText(page.profile.first)}–${chapterText(page.profile.latest)}`}
              {page.profile.missing > 0 && ` · ${page.profile.missing} missing`}
              {page.profile.newestUpload && ` · last upload ${new Date(page.profile.newestUpload).toLocaleDateString()}`}
            </span>
          )}

          <div className="manga-row-actions">
            {followingId ? (
              <button className="btn primary" onClick={() => onRead(followingId)}>
                Following · Open
              </button>
            ) : (
              <button
                className="btn primary"
                disabled={following_}
                onClick={async () => {
                  setFollowing(true);
                  await onFollow(result);
                  setFollowing(false);
                }}
              >
                {following_ ? 'Following…' : `${result.unlinked ? 'Read' : 'Follow'} from ${result.sourceName}`}
              </button>
            )}
            {first && (
              <button className="btn" onClick={() => setOpen(first)}>
                Read chapter {chapterText(first.number)}
              </button>
            )}
            {page?.url && (
              // The site itself, in a new tab — one of the two links here that leave the app.
              <a className="btn subtle" href={page.url} target="_blank" rel="noreferrer noopener">
                On the site
              </a>
            )}
            {updatesUrl && (
              <a className="btn subtle" href={updatesUrl} target="_blank" rel="noreferrer noopener">
                MangaUpdates
              </a>
            )}
          </div>
        </div>
      </div>

      {problem && <p className="banner">{problem}</p>}
      {!page && !problem && <p className="empty">Asking {result.sourceName} about it…</p>}
      {page?.stale && (
        <p className="meta">{result.sourceName} did not answer, so this is what was stored the last time it did.</p>
      )}

      {page && page.genres.length > 0 && (
        <div className="manga-flags">
          {page.genres.map((g) => (
            <span key={g} className="chip">
              {g}
            </span>
          ))}
        </div>
      )}

      {blurb && (
        <p className="manga-detail-blurb">
          {long && !blurbOpen ? `${blurb.slice(0, BLURB_CLAMP).trimEnd()}…` : blurb}{' '}
          {long && (
            <button className="btn subtle" onClick={() => setBlurbOpen(!blurbOpen)}>
              {blurbOpen ? 'Less' : 'More'}
            </button>
          )}
        </p>
      )}
      {page && !blurb && <p className="meta">{result.sourceName} gives no description.</p>}

      {others.length > 0 && (
        <details className="manga-compare-other">
          <summary>{alsoOn(others, result.sourceName)}</summary>
          {others.map((o) => (
            <div className="row between" key={`${o.sourceName}:${o.id}`}>
              <span className="meta truncate">
                {o.sourceName} — {o.title}
              </span>
              <button className="btn subtle" onClick={() => onOpen(o)}>
                View
              </button>
            </div>
          ))}
        </details>
      )}

      <h3>Chapters</h3>
      {!followingId && page && page.chapters.length > 0 && (
        <p className="meta">You can read before following. Nothing is marked read until you follow it.</p>
      )}
      {followingId && !ownSeriesId && page && page.chapters.length > 0 && (
        <p className="meta">
          You follow this series, but reading from this page does not mark anything — open it from your library to keep
          your place.
        </p>
      )}
      {page?.chaptersProblem && <p className="banner">Could not list its chapters: {page.chaptersProblem}</p>}
      {page && !page.chaptersProblem && page.chapters.length === 0 && (
        <p className="empty">{result.sourceName} lists no chapters for this.</p>
      )}
      <div className="manga-chapters">
        {page?.chapters.map((c) => {
          // The same marks as the library's chapter list — see its styles.
          const here = page.position?.chapterId === c.id ? page.position : null;
          return (
            <button
              key={c.id}
              className={`manga-chapter-row${c.read ? ' read' : ''}${here ? ' started' : ''}`}
              onClick={() => {
                setResume(here ? { page: here.page, offset: here.offset } : null);
                setOpen(c);
              }}
            >
              <span className="title truncate">{c.name}</span>
              <span className="meta">
                {c.scanlator ? `${c.scanlator} · ` : ''}
                {c.uploadedAt ? new Date(c.uploadedAt).toLocaleDateString() : ''}
                {here ? ` · page ${here.page + 1} of ${here.pages}` : ''}
                {c.read ? (c.readOn ? ` · read on ${c.readOn}` : ' · read') : ''}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
