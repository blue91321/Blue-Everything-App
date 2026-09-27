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
import { useAsync } from '@app/useAsync';
import { Cover } from './Cover';
import { chapterText } from './judge';
import { sourceLabel } from './Library';
import { manga, type HistoryEntry } from './manga-api';

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

export function History({ onOpen }: { onOpen: (seriesId: string, carryOn: boolean) => void }) {
  /*
   * Fetched each time the tab opens — it is mounted only while shown — because
   * your place is saved quietly as you scroll, without announcing a change, so
   * a copy held from earlier would be missing the page you just left.
   */
  const history = useAsync(() => manga.history(), []);
  const now = new Date();

  if (history.loading) return <p className="empty">loading…</p>;
  if (history.error) return <p className="banner">Could not load: {history.error.message}</p>;

  const entries = history.data?.entries ?? [];
  if (entries.length === 0) {
    return (
      <div className="card">
        <p className="empty">Nothing read yet. Chapters you finish, and where you stopped, are listed here.</p>
      </div>
    );
  }

  const days: Array<{ day: string; entries: HistoryEntry[] }> = [];
  for (const e of entries) {
    const day = dayOf(e.at, now);
    const last = days[days.length - 1];
    if (last?.day === day) last.entries.push(e);
    else days.push({ day, entries: [e] });
  }

  return (
    <div className="manga-history">
      {days.map((d) => (
        <section key={d.day}>
          <h2>{d.day}</h2>
          <div className="card">
            {d.entries.map((e) => (
              <button
                key={`${e.kind}:${e.seriesId}:${e.chapter}:${e.at}`}
                className={`manga-history-row${e.kind === 'reading' ? ' reading' : ''}`}
                onClick={() => onOpen(e.seriesId, e.kind === 'reading')}
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
                  </span>
                </span>
                <span className="meta manga-history-time">
                  {new Date(e.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
