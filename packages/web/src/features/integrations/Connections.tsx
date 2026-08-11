/**
 * The services, and what each one is actually able to do.
 *
 * Every provider renders its full capability list, each with the sentence
 * explaining what it does and does not cover — Spotify keeping only fifty plays,
 * Discord needing approval, Riot working only while the client is open. A
 * status with no explanation reads as "not built yet" and sends you looking.
 *
 * Connecting is local-only, guarded on the server. On a phone the rows still
 * render — you can see what is hooked up and sync it — and the buttons that
 * would change a connection are replaced with a line saying where to do it.
 */
import { useState } from 'react';
import { api, type ProviderInfo, type SyncOutcome } from '../../api';
import { useAsync } from '../../useAsync';
import { Credentials } from './Credentials';
import { StatusChip, relativeTime } from './Integrations';

const CAPABILITY_LABEL: Record<string, string> = {
  playlists: 'Playlists',
  taste: 'Categories',
  follows: 'Following',
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
  const [steamKey, setSteamKey] = useState('');
  const [steamProfile, setSteamProfile] = useState('');
  const [problem, setProblem] = useState('');

  /**
   * Whether the controls that *start* a connection can be used.
   *
   * `missingConfig` belongs in here for OAuth, where a missing client id means
   * the redirect would land on the provider's own error page. It must **not**
   * gate a text box: Steam's form used to be disabled whenever `STEAM_API_KEY`
   * was unset, which is to say almost always, and a field that looks typeable
   * and silently is not is the worst way to communicate a prerequisite.
   *
   * Steam no longer declares any `needs`, so this is true for it regardless —
   * but the split is kept because the two answer different questions.
   */
  const canConfigure = local && provider.missingConfig.length === 0;

  /**
   * Whether connecting this would buy anything *today*.
   *
   * No provider fails this now — Battle.net, the one that did, has been removed
   * rather than left on the screen apologising. The guard stays because it
   * encodes the rule that removal followed: a Connect button that completes a
   * real handshake and leaves the app holding a token it can do nothing with is
   * worse than one that explains why it is not offered.
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
      await api.integrations.connectSteam(steamProfile.trim(), steamKey.trim() || undefined);
      // Cleared on success only — `guard` throws before this on failure, so a
      // rejected key stays in the box to be corrected rather than retyped.
      setSteamKey('');
      setSteamProfile('');
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
                  {/* Linked only where the citation is a page. Half of them name
                      endpoints rather than documents, and linking those would
                      invent a URL. */}
                  {spec.sourceUrl ? (
                    <a href={spec.sourceUrl} target="_blank" rel="noreferrer noopener">
                      {spec.source} ↗
                    </a>
                  ) : (
                    spec.source
                  )}
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

      {/*
        The credentials, as text boxes.

        This used to be a line reading "not configured yet — set SPOTIFY_CLIENT_ID
        and restart", which is an instruction to go and edit a file. The values
        are yours rather than the application's, they change without a release,
        and there is no reason they should live anywhere you need a terminal to
        reach. The env var still works and the field says when it is in use.
      */}
      {anythingUsable && local && provider.credentialFields.length > 0 && !provider.connected && (
        <Credentials provider={provider} reload={reload} />
      )}

      {/* Once connected the form is out of the way, but reachable — a client
          secret gets rotated, and hiding the box would mean editing a file
          after all. */}
      {anythingUsable && local && provider.credentialFields.length > 0 && provider.connected && (
        <details style={{ marginTop: '.75rem' }}>
          <summary className="meta">Change its client ID or secret</summary>
          <Credentials provider={provider} reload={reload} />
        </details>
      )}

      {anythingUsable && !local && provider.missingConfig.length > 0 && (
        <div className="meta" style={{ marginTop: '.75rem' }}>
          Not configured yet. Its credentials are filled in on the PC running the server.
        </div>
      )}

      {/*
        The setup steps live next to the button they unblock rather than in a
        readme. The redirect URI in particular has to match character for
        character, and a trailing slash is a rejected login with an error page
        that does not say so.
      */}
      {/*
        Rendered when connected too, which it was not at first.

        Hiding these the moment a connection succeeded meant the links vanished
        exactly when they became most useful: "Steam returned no friends" is
        nearly always the privacy setting, and the link that fixes it is in this
        list. The same goes for a revoked key or a client id that has to be
        re-created. Collapsed by default, so it costs a line either way.
      */}
      {anythingUsable && provider.auth !== 'client' && provider.setup.length > 0 && (
        <details style={{ marginTop: '.5rem' }}>
          <summary className="meta">
            {provider.connected ? 'Setup and troubleshooting' : 'What you have to set up at their end'}
          </summary>
          <ol className="meta" style={{ marginTop: '.4rem', paddingLeft: '1.2rem' }}>
            {provider.setup.map((step) => (
              <li key={step.text} style={{ marginBottom: '.35rem' }}>
                {step.text}
                {/*
                  A real anchor, not a domain rendered as text you have to retype
                  into the address bar. `noreferrer noopener` because these open
                  in a new tab and the target has no business with a handle on
                  this window.
                */}
                {step.link && (
                  <>
                    {' '}
                    <a href={step.link.url} target="_blank" rel="noreferrer noopener">
                      {step.link.label} ↗
                    </a>
                  </>
                )}
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

      {/*
        ---- Steam: both credentials, in one place, in one submission ----

        A real <form> rather than an input beside a button, so Enter submits and
        the browser groups the two fields as one thing to fill in. Neither is
        ever disabled: the previous version gated the box on STEAM_API_KEY being
        set in the environment, which meant it was dead until you had already
        done the hard half somewhere else.
      */}
      {provider.auth === 'api-key' && !provider.connected && local && (
        <form
          style={{ marginTop: '.75rem', display: 'grid', gap: '.5rem' }}
          onSubmit={(e) => {
            e.preventDefault();
            void connectSteam();
          }}
        >
          <label style={{ display: 'grid', gap: '.25rem' }}>
            <span className="meta">
              {provider.envFallback ? (
                <>
                  Steam Web API key — <code>STEAM_API_KEY</code> is set in the environment, so leave this
                  blank to use it. Paste one here to store it with the account instead.
                </>
              ) : (
                <>
                  Your Steam Web API key —{' '}
                  <a href="https://steamcommunity.com/dev/apikey" target="_blank" rel="noreferrer noopener">
                    get one here
                  </a>
                  . It asks for a domain; <code>localhost</code> is fine.
                </>
              )}
            </span>
            <input
              value={steamKey}
              onChange={(e) => setSteamKey(e.target.value)}
              placeholder={provider.envFallback ? 'Using STEAM_API_KEY' : 'Paste the key'}
              aria-label="Steam Web API key"
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <label style={{ display: 'grid', gap: '.25rem' }}>
            <span className="meta">
              Your profile — the URL, your custom name, or the 17-digit ID. Any of the three.
            </span>
            <input
              value={steamProfile}
              onChange={(e) => setSteamProfile(e.target.value)}
              placeholder="steamcommunity.com/id/yourname"
              aria-label="Steam profile"
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <div className="row wrap row-actions">
            <button
              type="submit"
              className="btn primary"
              // Only the profile is genuinely required — the key may already be
              // in the environment, and the server says so plainly if it is not.
              disabled={steamProfile.trim() === '' || busy !== ''}
            >
              {busy === 'steam' ? 'Checking with Steam…' : 'Connect'}
            </button>
          </div>

          <div className="meta">
            Both are stored with your account here, not in a config file. Your profile and friends list
            have to be Public in Steam's privacy settings, or the API returns an empty list with no error.
          </div>
        </form>
      )}

      {provider.auth === 'api-key' && !provider.connected && !local && (
        <div className="meta" style={{ marginTop: '.75rem' }}>
          Steam is connected from the PC running the server.
        </div>
      )}

      {/* ---- actions ---- */}
      <div className="row wrap row-actions" style={{ marginTop: '.75rem' }}>
        {provider.auth === 'oauth2' && !provider.connected && anythingUsable && (
          <button className="btn primary" disabled={!canConfigure || busy !== ''} onClick={connect}>
            {busy === 'connect' ? 'Opening…' : 'Connect'}
          </button>
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
    </div>
  );
}
