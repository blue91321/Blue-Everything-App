/**
 * Who is on air, across the services that can answer.
 *
 * ### One tab for a question, not one tab per service
 *
 * "Is anyone I follow streaming right now" is one question, so it gets one
 * screen with everything sorted together — the same reasoning that has the
 * Friends tab merge Steam, Discord and Riot rather than giving each a list you
 * compare by eye. Twitch is the only service on it today; the list and the
 * `provider` chip on each row are built for the second one, not retrofitted for
 * it.
 *
 * ### Only the services that can actually answer appear here
 *
 * `sources` is built from `LIVE_PROVIDERS`, which is derived from the manifest —
 * so a service that does not declare the capability is not listed and not
 * apologised for. YouTube is the one that costs explaining, and the explanation
 * lives in CLAUDE.md rather than on the screen: there is no endpoint for "which
 * of my subscriptions are live", and the per-channel route costs several times a
 * day's quota for one refresh. That is worth recording and was not worth a
 * permanent block on a tab about Twitch.
 *
 * The same call the Battle.net and Epic rows got — the research is in the
 * document, the row is gone.
 */
import { useState } from 'react';
import { api, type LiveSource, type LiveStreamRow } from '../../api';
import { useAsync } from '../../useAsync';

/** "3h 20m", "12m" — how long they have been going. */
export function liveFor(startedAt: number | null): string {
  if (!startedAt) return '';
  const minutes = Math.max(0, Math.round((Date.now() - startedAt) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function viewerLabel(viewers: number | null): string {
  if (viewers === null || viewers === undefined) return '';
  return viewers >= 1000 ? `${(viewers / 1000).toFixed(1)}k viewers` : `${viewers} viewers`;
}

export function Live() {
  const state = useAsync(() => api.integrations.live(), [], ['integrations']);

  if (state.loading) return <div className="empty">loading…</div>;
  if (state.error) return <div className="empty">Could not load: {state.error.message}</div>;

  const streams = state.data?.streams ?? [];
  const sources = state.data?.sources ?? [];
  const hidden = state.data?.hiddenCount ?? 0;

  return (
    <>
      <div className="row between" style={{ alignItems: 'baseline', marginBottom: '.5rem' }}>
        <div className="meta">
          {streams.length === 0 ? 'Nobody is live' : `${streams.length} live`}
          {hidden > 0 ? ` · ${hidden} hidden by Services` : ''}
        </div>
        <button className="btn subtle" disabled={state.refreshing} onClick={() => state.reload()}>
          {state.refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {streams.map((stream) => (
        <LiveCard key={stream.id} stream={stream} onChanged={state.reload} />
      ))}

      {streams.length === 0 && (
        <div className="empty">
          Nobody you follow is streaming.
        </div>
      )}

      <Sources sources={sources} />
    </>
  );
}

function LiveCard({ stream, onChanged }: { stream: LiveStreamRow; onChanged: () => void }) {
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  const star = async () => {
    setBusy(true);
    setProblem('');
    try {
      await api.integrations.favouriteFollow(stream.provider, stream.providerAccountId, !stream.favourite);
      onChanged();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const detail = [stream.category, viewerLabel(stream.viewers), liveFor(stream.startedAt) && `live ${liveFor(stream.startedAt)}`]
    .filter(Boolean)
    .join(' · ');

  return (
    /*
     * The card is a link and the star is a button *beside* it, not inside — a
     * `<button>` nested in an `<a>` is invalid HTML and behaves differently in
     * every browser, and the one thing that must not happen here is starring a
     * channel and having the page navigate away to the stream.
     */
    <div className="card live-card-wrap">
      <div className="row" style={{ alignItems: 'center', gap: '.5rem' }}>
        <button
          className={`star${stream.favourite ? ' on' : ''}`}
          disabled={busy}
          aria-pressed={stream.favourite}
          title={stream.favourite ? `Unstar ${stream.channelName}` : `Star ${stream.channelName}`}
          aria-label={stream.favourite ? `Unstar ${stream.channelName}` : `Star ${stream.channelName}`}
          onClick={() => void star()}
        >
          {stream.favourite ? '★' : '☆'}
        </button>

        <a className="live-card grow" href={stream.url} target="_blank" rel="noreferrer noopener">
      <div className="row" style={{ alignItems: 'center', gap: '.75rem' }}>
        {stream.thumbnailUrl && (
          // Decorative: the title beside it says everything this shows.
          <img className="live-thumb" src={stream.thumbnailUrl} alt="" width={96} height={54} loading="lazy" />
        )}

        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ alignItems: 'center', gap: '.4rem' }}>
            {/* Red dot, universally, and deliberately not the accent — the same
                argument the presence dots make: "live" is a colour people have
                already learned from every service that has ever had one. */}
            <span className="live-dot" role="img" aria-label="live" />
            <span className="title truncate">{stream.channelName}</span>
          </div>
          <div className="meta truncate">{stream.title}</div>
          {detail && <div className="meta truncate" style={{ opacity: 0.75 }}>{detail}</div>}
        </div>

        <span className="chip">{stream.provider}</span>
      </div>
        </a>
      </div>

      {/*
        The one failure worth showing on the row: a channel that is live but not
        yet in the followed list has nothing to flag, and a silent success would
        spring the star back on the next reload with nothing said.
      */}
      {problem && <div className="banner">{problem}</div>}
    </div>
  );
}

/**
 * What each service can contribute, and what is stopping it.
 *
 * Always rendered, not only when the list is empty. A list of two streams with
 * Twitch connected and nothing else able to answer is a *correct* list, and the
 * only way to know that is to be told what was asked.
 */
function Sources({ sources }: { sources: LiveSource[] }) {
  return (
    <details className="card" style={{ marginTop: '.75rem' }} open={sources.every((s) => !s.connected)}>
      <summary className="meta">Where this comes from</summary>

      {sources.map((source) => (
        <div key={source.provider} style={{ marginTop: '.5rem' }}>
          <div className="title">
            {source.label}
            <span className="meta">
              {' — '}
              {source.connected
                ? 'connected'
                : source.missingConfig.length > 0
                  ? 'not set up'
                  : 'not connected'}
            </span>
          </div>
          <div className="meta">{source.why}</div>
          {source.lastError && <div className="banner">Last attempt failed: {source.lastError}</div>}
        </div>
      ))}

    </details>
  );
}
