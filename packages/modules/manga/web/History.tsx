/**
 * What you have read, newest first, grouped by day.
 *
 * Built from what the server already keeps — every chapter finished, with the
 * source it was read on, and the place you are partway through — so it needed
 * nothing new written to exist. A chapter finished before sources were recorded
 * says so by leaving the source out, rather than guessing one.
 *
 * Tapping a line opens that series' chapter list; the one you are partway
 * through goes straight back to the page, like Continue.
 */
import { useEffect, useState } from 'react';
import { useAsync } from '@app/useAsync';
import { Cover } from './Cover';
import { chapterText } from './judge';
import { sourceLabel } from './Library';
import { manga, type HistoryEntry, type OldHistorySearch } from './manga-api';

function dayOf(at: number, now: Date): string {
  const d = new Date(at);
  const days = Math.round(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) /
      86_400_000
  );
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], {
    month: 'long',
    day: 'numeric',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

export function History({
  onOpen,
  onGlimpse,
  onSearchSources,
}: {
  onOpen: (seriesId: string, carryOn: boolean) => void;
  /** Search your sources for a title: for something read in Manga Reader that you do not follow. */
  onSearchSources?: (title: string) => void;
  /**
   * Open something read but not followed.
   *
   * It has no series of its own to open, so the row hands back what the source
   * calls it and the screen rebuilds a browse result from that — landing on the
   * details card, which is where Continue and Follow already live. No new
   * screen, and the one thing you might want to do about such a row is already
   * on the one it goes to.
   */
  onGlimpse?: (entry: { seriesId: string; sourceMangaId: string; title: string; sourceName: string; carryOn: boolean }) => void;
}) {
  /*
   * Fetched each time the tab opens — it is mounted only while shown — because
   * your place is saved quietly as you scroll, without announcing a change, so
   * a copy held from earlier would be missing the page you just left.
   */
  const history = useAsync(() => manga.history(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState('');
  /*
   * Search: what History lists, by title, and Manga Reader's history below it
   * (`old-history.ts`), which holds the series opened there and never brought
   * in. Not remembered: a search is a question you are asking now.
   */
  const [q, setQ] = useState('');

  /**
   * Take one thing out of History.
   *
   * Two kinds of row and two different acts behind them: a finished chapter is
   * a read record, so removing it *is* marking it unread — the server already
   * had that in `read: false` and it simply had nowhere to be pressed. A row
   * you are partway through is the saved place instead, which no read flag can
   * reach, so that one is cleared on its own.
   */
  const remove = async (e: { seriesId: string; chapter: number; kind: 'read' | 'reading' }) => {
    setBusy(e.seriesId);
    setProblem('');
    try {
      if (e.kind === 'reading') await manga.reader.clearPosition(e.seriesId);
      else await manga.reader.markRead(e.seriesId, e.chapter, false);
      history.reload();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'that could not be removed');
    } finally {
      setBusy(null);
    }
  };
  const now = new Date();

  if (history.loading) return <p className="empty">loading…</p>;
  if (history.error) return <p className="banner">Could not load: {history.error.message}</p>;

  const all = history.data?.entries ?? [];
  const needle = q.trim().toLowerCase();
  const entries = needle ? all.filter((e) => e.title.toLowerCase().includes(needle)) : all;

  const days: Array<{ day: string; entries: HistoryEntry[] }> = [];
  for (const e of entries) {
    const day = dayOf(e.at, now);
    const last = days[days.length - 1];
    if (last?.day === day) last.entries.push(e);
    else days.push({ day, entries: [e] });
  }

  return (
    <div className="manga-history">
      <input
        className="manga-history-search"
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search what you have read"
        aria-label="Search history"
      />
      {problem && <p className="banner">{problem}</p>}
      {all.length === 0 && !needle && (
        <div className="card">
          <p className="empty">Nothing read yet. Chapters you finish, and where you stopped, are listed here.</p>
        </div>
      )}
      {needle && entries.length === 0 && <p className="empty">Nothing in this app's history matches “{q.trim()}”.</p>}
      {days.map((d) => (
        <section key={d.day}>
          <h2>{d.day}</h2>
          <div className="card">
            {d.entries.map((e) => (
              <div
                key={`${e.kind}:${e.seriesId}:${e.chapter}:${e.at}`}
                className={`manga-history-row${e.kind === 'reading' ? ' reading' : ''}`}
              >
                <button
                  className="manga-history-open"
                  onClick={() =>
                    e.following === false && e.sourceMangaId && onGlimpse
                      ? onGlimpse({
                          seriesId: e.seriesId,
                          sourceMangaId: e.sourceMangaId,
                          title: e.title,
                          sourceName: e.source ?? '',
                          carryOn: e.kind === 'reading',
                        })
                      : onOpen(e.seriesId, e.kind === 'reading')
                  }
                >
                  <Cover path={e.coverPath} title={e.title} size={40} />
                  <span className="manga-row-text">
                    <span className="title truncate">{e.title}</span>
                    <span className="meta">
                      {e.kind === 'reading'
                        ? `Reading ${e.chapterName ?? `chapter ${chapterText(e.chapter)}`}${
                            e.page !== null && e.pages ? ` · page ${e.page + 1} of ${e.pages}` : ''
                          }`
                        : `Finished chapter ${chapterText(e.chapter)}`}
                      {e.source ? ` · ${sourceLabel(e.source)}` : ''}
                      {/*
                        Said on the row rather than left to be noticed. A title
                        in History that is not in your library looks like a
                        series you have lost until something says why it is not
                        there.
                      */}
                      {e.following === false ? ' · not following' : ''}
                    </span>
                  </span>
                  <span className="meta manga-history-time">
                    {new Date(e.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  </span>
                </button>
                {/*
                  Removing a row is the same act as marking the chapter unread —
                  the list is built from the read records, so there is nothing
                  else for it to be. Said on the button rather than offering two
                  controls that do one thing.
                */}
                <button
                  className="manga-history-remove"
                  aria-label={
                    e.kind === 'reading'
                      ? `Forget where you were in ${e.title}`
                      : `Mark chapter ${chapterText(e.chapter)} of ${e.title} unread`
                  }
                  title={e.kind === 'reading' ? 'Forget where you were' : 'Mark unread, and take this out of History'}
                  disabled={busy === e.seriesId}
                  onClick={() => void remove(e)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </section>
      ))}
      {needle.length >= 2 && <OldHistory q={q.trim()} onOpen={(id) => onOpen(id, false)} onSearchSources={onSearchSources} />}
    </div>
  );
}

/**
 * Manga Reader's history, for what was typed: the series read there, with how
 * far, and whether you follow it here now. One you follow opens its chapter
 * list; one you do not searches your sources for it.
 */
function OldHistory({
  q,
  onOpen,
  onSearchSources,
}: {
  q: string;
  onOpen: (seriesId: string) => void;
  onSearchSources?: (title: string) => void;
}) {
  const [found, setFound] = useState<OldHistorySearch | null>(null);
  useEffect(() => {
    let alive = true;
    // A moment after typing stops, not on every key.
    const timer = setTimeout(() => {
      manga.oldHistory(q).then((r) => alive && setFound(r), () => alive && setFound(null));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q]);

  if (!found || !found.available) return null;
  return (
    <section>
      <h2>Read in Manga Reader</h2>
      <div className="card">
        {found.matches.length === 0 ? (
          <p className="empty">
            Nothing in Manga Reader's history matches “{q}” ({found.total} series there).
          </p>
        ) : (
          found.matches.map((m) => (
            <div key={m.title} className="manga-history-row">
              <button
                className="manga-history-open"
                onClick={() => (m.following ? onOpen(m.following) : onSearchSources?.(m.title))}
              >
                <span className="manga-row-text">
                  <span className="title truncate">{m.title}</span>
                  <span className="meta">
                    {m.chaptersRead > 0
                      ? `${m.chaptersRead} chapter${m.chaptersRead === 1 ? '' : 's'} read${m.furthest !== null ? `, up to ${chapterText(m.furthest)}` : ''}`
                      : 'Opened, no chapter finished'}
                    {m.sites.length > 0 ? ` · ${m.sites.join(', ')}` : ''}
                    {m.following ? ' · in your library' : ' · not following: tap to find it'}
                  </span>
                </span>
                {m.lastReadAt && (
                  <span className="meta manga-history-time">
                    {new Date(m.lastReadAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
                  </span>
                )}
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
