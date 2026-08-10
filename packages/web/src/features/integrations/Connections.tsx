/**
 * The services, and what each one is actually able to do.
 *
 * Every provider renders its full capability list including the ones that can
 * never work, because "can I see my Battle.net friends?" answered with silence
 * reads as "not built yet" and sends you looking. It is answered with a
 * sentence instead.
 *
 * Connecting is local-only, guarded on the server. On a phone the rows still
 * render — you can see what is hooked up and sync it — and the buttons that
 * would change a connection are replaced with a line saying where to do it.
 */
import { useState } from 'react';
import { api, type ProviderInfo, type SyncOutcome } from '../../api';
import { useAsync } from '../../useAsync';
import { StatusChip, relativeTime } from './Integrations';
import { TakeoutImport } from './Takeout';

const CAPABILITY_LABEL: Record<string, string> = {
  playlists: 'Playlists',
  history: 'History',
  taste: 'Categories',
  friends: 'Friends',
};

export function Connections({ local }: { local: boolean }) {
  const state = useAsync(() => api.integrations.list(), [], ['integrations']);

  if (state.loading) return <div className="empty">loading…</div>;
  if (state.error) return <div className="empty">Could not load: {state.error.message}</div>;
  if (!state.data) return null;

  return (
    <>
      {!local && (
        <div className="banner">
          Connecting and disconnecting can only be done on the PC running the server — an OAuth redirect
          comes back to a browser there. Everything on this screen is readable from here.
        </div>
      )}

      {state.data.providers.map((provider) => (
        <ProviderCard key={provider.id} provider={provider} local={local} reload={state.reload} />
      ))}
    </>
  );
}

function ProviderCard({
  provider,
  local,
  reload,
}: {
  provider: ProviderInfo;
  local: boolean;
  reload: () => void;
}) {
  const [busy, setBusy] = useState('');
  const [outcomes, setOutcomes] = useState<SyncOutcome[]>([]);
  const [steamId, setSteamId] = useState('');
  const [problem, setProblem] = useState('');

  const canConfigure = local && provider.missingConfig.length === 0;

  /**
   * Whether connecting this would buy anything *today*.
   *
   * Battle.net is the case: its OAuth details are in the manifest because they
   * are real and it would be silly to look them up twice, but its only
   * capability is `unavailable`, so a Connect button would complete a genuine
   * handshake and leave the app with a token it has no use for. A button that
   * works and achieves nothing is worse than one that explains itself.
   */
  const anythingUsable = Object.values(provider.capabilities).some(
    (spec) => spec && spec.status !== 'unavailable'
  );

  const guard = async (what: string, run: () => Promise<void>) => {
    setBusy(what);
    setProblem('');
    try {
      await run();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy('');
    }
  };

  const connect = () =>
    guard('connect', async () => {
      const { url } = await api.integrations.authorize(provider.id);
      /*
       * Opened in a new tab rather than navigating this one. The provider
       * redirects back to a small page on the server, and losing the app's own
       * tab to do it would mean coming back to a cold start every time.
       */
      window.open(url, '_blank', 'noopener');
    });

  const connectSteam = () =>
    guard('steam', async () => {
      await api.integrations.connectSteam(steamId.trim());
      setSteamId('');
      reload();
    });

  const disconnect = () =>
    guard('disconnect', async () => {
      await api.integrations.disconnect(provider.id);
      reload();
    });

  const sync = () =>
    guard('sync', async () => {
      setOutcomes((await api.integrations.sync(provider.id)).outcomes);
      reload();
    });

  return (
    <div className="card">
      <div className="row" style={{ alignItems: 'center', gap: '.6rem' }}>
        <span className="glyph" aria-hidden="true">
          {provider.glyph}
        </span>
        <div className="grow">
          <div className="title">
            {provider.label}
            {provider.connected && provider.accountName ? (
              <span className="meta"> — {provider.accountName}</span>
            ) : null}
          </div>
          <div className="meta">{provider.blurb}</div>
        </div>
      </div>

      {/* ---- what it can do ---- */}
      <div style={{ marginTop: '.75rem' }}>
        {Object.entries(provider.capabilities).map(([capability, spec]) =>
          spec ? (
            <div key={capability} style={{ marginTop: '.5rem' }}>
              <div className="row" style={{ alignItems: 'center', gap: '.5rem' }}>
                <strong>{CAPABILITY_LABEL[capability] ?? capability}</strong>
                <StatusChip status={spec.status} />
                {provider.syncedAt[capability] ? (
                  <span className="meta">synced {relativeTime(provider.syncedAt[capability])}</span>
                ) : null}
              </div>
              <div className="meta" style={{ marginTop: 2 }}>{spec.why}</div>
              {/* The citation, for when the sentence above is not believed —
                  which is the correct reaction to being told an API cannot do
                  something its documentation appears to describe. */}
              {spec.source && (
                <div className="meta" style={{ marginTop: 2, opacity: 0.7 }}>
                  {spec.source}
                </div>
              )}
            </div>
          ) : null
        )}
      </div>

      {/* ---- configuration ---- */}
      {!anythingUsable && (
        <div className="meta" style={{ marginTop: '.75rem' }}>
          Nothing to connect it for. Every capability above is out of reach, so there is no token worth
          holding — the row is here to answer the question rather than to leave a gap.
        </div>
      )}

      {anythingUsable && provider.missingConfig.length > 0 && (
        <div className="meta" style={{ marginTop: '.75rem' }}>
          Not configured yet — set{' '}
          {provider.missingConfig.map((name, i) => (
            <span key={name}>
              {i > 0 && ', '}
              <code>{name}</code>
            </span>
          ))}{' '}
          and restart.
        </div>
      )}

      {/*
        The setup steps live next to the button they unblock rather than in a
        readme. The redirect URI in particular has to match character for
        character, and a trailing slash is a rejected login with an error page
        that does not say so.
      */}
      {!provider.connected && anythingUsable && provider.auth !== 'client' && provider.setup.length > 0 && (
        <details style={{ marginTop: '.5rem' }}>
          <summary className="meta">What you have to set up at their end</summary>
          <ol className="meta" style={{ marginTop: '.4rem', paddingLeft: '1.2rem' }}>
            {provider.setup.map((step) => (
              <li key={step} style={{ marginBottom: '.25rem' }}>
                {step}
              </li>
            ))}
          </ol>
        </details>
      )}

      {/* ---- the granted-scope warning, which is the Discord case ---- */}
      {provider.connected && provider.id === 'discord' && !provider.grantedScopes.includes('sdk.social_layer_presence') && (
        <div className="banner" style={{ marginTop: '.75rem' }}>
          Connected, but Discord did not grant the presence scope — so it can confirm who you are and
          nothing more. Request Social SDK access for your application in the developer portal, then
          connect again.
        </div>
      )}

      {provider.lastError && (
        <div className="banner" style={{ marginTop: '.75rem' }}>
          Last attempt failed: {provider.lastError}
        </div>
      )}

      {/* ---- actions ---- */}
      <div className="row wrap row-actions" style={{ marginTop: '.75rem' }}>
        {provider.auth === 'oauth2' && !provider.connected && anythingUsable && (
          <button className="btn primary" disabled={!canConfigure || busy !== ''} onClick={connect}>
            {busy === 'connect' ? 'Opening…' : 'Connect'}
          </button>
        )}

        {provider.auth === 'api-key' && !provider.connected && (
          <>
            <input
              value={steamId}
              onChange={(e) => setSteamId(e.target.value)}
              placeholder="17-digit Steam ID"
              inputMode="numeric"
              aria-label="Steam ID"
              disabled={!canConfigure}
            />
            <button
              className="btn primary"
              disabled={!canConfigure || steamId.trim().length !== 17 || busy !== ''}
              onClick={connectSteam}
            >
              {busy === 'steam' ? 'Checking…' : 'Connect'}
            </button>
          </>
        )}

        {provider.runnable.length > 0 && provider.connected && (
          <button className="btn" disabled={busy !== ''} onClick={sync}>
            {busy === 'sync' ? 'Syncing…' : 'Sync now'}
          </button>
        )}

        {provider.connected && (
          <button className="btn subtle" disabled={!local || busy !== ''} onClick={disconnect}>
            Disconnect
          </button>
        )}

        {provider.auth === 'client' && (
          <span className="meta">
            {/* Nothing to press. The agent finds these on its own, and saying so
                is better than a Connect button that would do nothing. */}
            {provider.local?.stale
              ? 'The Windows agent is not reporting.'
              : provider.local?.clientRunning
                ? `Client running, last seen ${relativeTime(provider.local.reportedAt)}`
                : `Client closed, last seen ${relativeTime(provider.local?.reportedAt ?? null)}`}
          </span>
        )}
      </div>

      {problem && <div className="banner" style={{ marginTop: '.5rem' }}>{problem}</div>}

      {outcomes.length > 0 && (
        <div style={{ marginTop: '.5rem' }}>
          {outcomes.map((outcome) => (
            <div key={outcome.capability} className="meta">
              {CAPABILITY_LABEL[outcome.capability] ?? outcome.capability}: {outcome.ok ? '' : 'failed — '}
              {outcome.note}
            </div>
          ))}
        </div>
      )}

      {/* YouTube's watch history has no API at all, so the import lives here —
          on the provider whose capability list just explained why. */}
      {provider.id === 'youtube' && local && <TakeoutImport onDone={reload} />}
    </div>
  );
}
