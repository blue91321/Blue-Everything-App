/**
 * What landed lately, beside the Dashboard.
 *
 * Deliberately **not** the list of things to read — the Dashboard already shows
 * the tasks these releases raised, and a panel repeating them would be a second
 * copy of something already on that screen. This is the release itself, with its
 * cover, which is a picture rather than a list and answers "what turned up this
 * week" without being read.
 *
 * Each row is a button, like the friends panel's rows and for the same reason: a
 * whole-row hit target in a 320px column beats an icon per row, which is width
 * taken from the thing the column is for.
 */
import { useNow } from '@app/clock';
import { useAsync } from '@app/useAsync';
import { goTo } from '@app/nav';
import { Cover } from './Cover';
import { ageOf, manga } from './manga-api';

export default function MangaPanel() {
  // Redraws the ages on screen without asking the server anything.
  useNow();
  const state = useAsync(() => manga.list());

  if (state.loading) return <div className="empty">loading…</div>;
  // Said rather than swallowed: a panel silently showing nothing when the
  // request failed is indistinguishable from one with nothing to show, and the
  // two want completely different reactions.
  if (state.error) return <div className="empty">Could not load: {state.error.message}</div>;

  const data = state.data;
  if (!data) return null;

  if (data.series.length === 0) {
    return (
      <div className="empty">
        Nothing followed yet.{' '}
        <button className="btn subtle" onClick={() => goTo('manga')}>
          Add a series
        </button>
      </div>
    );
  }

  if (data.recent.length === 0) {
    /*
     * Two empty states, because "nothing has come out" and "nothing is being
     * watched" are different situations with different fixes — the same
     * distinction the live panel draws between a quiet evening and a filter
     * hiding everybody.
     */
    return (
      <div className="empty">
        {data.watching > 0
          ? `Watching ${data.watching} series. Nothing new yet.`
          : 'Nothing is being watched — every series you follow has finished.'}
      </div>
    );
  }

  const now = Date.now();

  return (
    <div className="manga-panel">
      {data.recent.map((release) => (
        <button
          key={`${release.seriesId}:${release.chapter}`}
          className="manga-panel-row"
          onClick={() => goTo('manga', { search: release.title })}
          title={`${release.title} — chapter ${release.chapter}`}
        >
          <Cover path={release.coverPath} title={release.title} size={34} />
          <span className="manga-panel-text">
            <span className="title truncate">{release.title}</span>
            <span className="meta">
              ch {release.chapter} · {ageOf(release.raisedAt, now)}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
