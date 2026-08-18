/**
 * Who is on air, across the services that can answer.
 *
 * ### One tab for a question, not one tab per service
 *
 * Twitch and YouTube are different companies and the same question — "is anyone
 * I follow streaming right now" — so they belong on one screen sorted together
 * rather than in two lists you compare by eye. That is the same reasoning the
 * Friends tab merges Steam, Discord and Riot.
 *
 * ### YouTube is not here, and the tab says why rather than showing nothing
 *
 * This is the honest half. YouTube has no "which of my subscriptions are live"
 * endpoint at all; the only route is a `search.list` per channel at 100 quota
 * units against a 10,000/day default. At the subscription counts this app
 * actually holds that is several times the whole day's allowance for a single
 * refresh — and spending it would break the playlist and Following syncs too.
 *
 * Saying so where you would look for it is this module's whole design rule. An
 * empty list with no explanation sends somebody hunting for a setting that was
 * never there.
 */
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
        <LiveCard key={stream.id} stream={stream} />
      ))}

      {streams.length === 0 && (
        <div className="empty">
          Nothing on air right now — or nothing that can be asked. The services below say which.
        </div>
      )}

      <Sources sources={sources} />
    </>
  );
}

function LiveCard({ stream }: { stream: LiveStreamRow }) {
  const detail = [stream.category, viewerLabel(stream.viewers), liveFor(stream.startedAt) && `live ${liveFor(stream.startedAt)}`]
    .filter(Boolean)
    .join(' · ');

  return (
    /*
     * The whole card opens the stream, the way a friend row is entirely a
     * button. A real `<a>` rather than a click handler so middle-click and
     * "open in new tab" work, which is exactly what you want from a list of
     * things to go and watch.
     */
    <a className="card live-card" href={stream.url} target="_blank" rel="noreferrer noopener">
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

      {/*
        The absence, stated. YouTube is not in `sources` because it does not
        declare the capability — so without this the tab would simply never
        mention the service you most expected to see, which reads as an
        oversight rather than as a limit somebody measured.
      */}
      <div style={{ marginTop: '.75rem' }}>
        <div className="title">
          YouTube <span className="meta">— cannot be asked</span>
        </div>
        <div className="meta">
          There is no endpoint for "which of my subscriptions are live". The only route is a search per
          channel at 100 quota units against a 10,000-a-day allowance, so one sweep of a few hundred
          subscriptions would cost several times the whole day — and take the playlist and Following syncs
          down with it. Twitch answers the same question in a single request, which is why it is here and
          YouTube is not.
        </div>
        <div className="meta" style={{ marginTop: 2, opacity: 0.7 }}>
          <a
            href="https://developers.google.com/youtube/v3/determine_quota_cost"
            target="_blank"
            rel="noreferrer noopener"
          >
            YouTube Data API quota costs ↗
          </a>
        </div>
      </div>
    </details>
  );
}
