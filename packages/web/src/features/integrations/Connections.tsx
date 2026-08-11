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

  /**
   * A one-line answer for the collapsed row.
   *
   * The summary has to be worth reading without opening anything, or collapsing
   * by default just hides the screen. Whether it is connected is the question
   * this card exists to answer, so it goes here and the detail goes inside.
   */
  const headline = provider.connected
    ? provider.accountName ?? 'connected'
    : provider.missingConfig.length > 0
      ? 'not set up'
      : 'not connected';

  return (
    <details className="card provider">
      {/*
        Collapsed by default. Five providers with their full capability list,
        citations, credential form and setup steps is several screens of text to
        scroll past on the way to the one you came to change — and this is a
        screen you visit twice a year. The summary carries the name and the
        state, which is the whole of what you need when you are not changing
        anything.
      */}
      <summary className="row" style={{ alignItems: 'center', gap: '.6rem' }}>
        <span className="glyph" aria-hidden="true">
          {provider.glyph}
        </span>
        <div className="grow">
          <div className="title">
            {provider.label}
            <span className="meta"> — {headline}</span>
          </div>
          <div className="meta">{provider.blurb}</div>
        </div>
        {/*
          Its own chip rather than a capability status. The first version reused
          `unavailable`, which renders as "not possible" — a phrase reserved for
          something that can never work, and exactly the wrong thing to say
          about a connection that failed once and will retry.
        */}
        {provider.lastError && <span className="chip problem">problem</span>}
      </summary>

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

      {/* ---- what to do, before the boxes that do it ---- */}
      {/*
        **Above the credential form, and open until it is connected.**

        It was below, inside a collapsed disclosure — so the default view was a
        form with no instructions, and the steps themselves said "paste it into
        the box below" while sitting underneath the box they meant. Reported as
        not being able to see what to do, which is exactly right: the reading
        order was backwards and the reading material was hidden.

        Once connected it collapses and is retitled, because by then it is
        reference rather than instruction — but it stays, since "Steam returned
        no friends" is nearly always the privacy setting and the link that fixes
        it is in this list.
      */}
      {anythingUsable && provider.auth !== 'client' && provider.setup.length > 0 && (
        <details className="setup" style={{ marginTop: '.75rem' }} open={!provider.connected}>
          <summary className="meta">
            {provider.connected ? 'Setup and troubleshooting' : `Setting up ${provider.label}`}
          </summary>
          <ol style={{ marginTop: '.5rem', paddingLeft: '1.3rem' }}>
            {provider.setup.map((step) => (
              <li key={step.text} className="meta" style={{ marginBottom: '.5rem' }}>
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
        The provider refused an optional scope, so the app stopped asking.

        Stated on the card rather than left to the callback page, which you see
        once and then close: after that the only visible symptom is a feature
        that is quietly missing. The button is the way back, for once the gated
        thing has been enabled at their end.
      */}
      {provider.optionalScopesRefused && (
        <div className="banner" style={{ marginTop: '.75rem' }}>
          {provider.label} would not grant everything this asks for, so it is no longer asking — the
          connection works, and the capability above marked <em>needs approval</em> is the part you do not
          have. Enable it for your application at {provider.label}, then press below and connect again.
          <div className="row" style={{ marginTop: '.5rem' }}>
            <button
              className="btn subtle"
              disabled={!local || busy !== ''}
              onClick={() =>
                void guard('scopes', async () => {
                  await api.integrations.retryScopes(provider.id);
                  reload();
                })
              }
            >
              Ask for everything again
            </button>
          </div>
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

      {/* ---- what a sync does ---- */}
      {provider.options.length > 0 && local && (
        <div style={{ marginTop: '.75rem', display: 'grid', gap: '.4rem' }}>
          {provider.options.map((option) => (
            <label key={option.key} style={{ display: 'grid', gap: '.15rem' }}>
              <span className="row" style={{ alignItems: 'center', gap: '.45rem' }}>
                <input
                  type="checkbox"
                  checked={provider.optionValues[option.key] ?? option.fallback}
                  disabled={busy !== ''}
                  onChange={(e) =>
                    void guard('option', async () => {
                      await api.integrations.setOptions(provider.id, { [option.key]: e.target.checked });
                      reload();
                    })
                  }
                />
                {option.label}
              </span>
              {option.help && (
                <span className="meta" style={{ paddingLeft: '1.6rem' }}>
                  {option.help}
                </span>
              )}
            </label>
          ))}
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
    </details>
  );
}
