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
import { api, type ProviderInfo, type SetupStep, type SyncOutcome } from '../../api';
import { useAsync } from '../../useAsync';
import { Credentials } from './Credentials';
import { relativeTime } from './Integrations';

/**
 * A numbered list of steps with their links.
 *
 * Extracted because it is now used twice — the setup list, and the steps that
 * unlock a gated capability — and a second copy would be the one that stopped
 * opening links in a new tab.
 */
function SetupSteps({ steps }: { steps: SetupStep[] }) {
  return (
    <ol style={{ marginTop: '.5rem', paddingLeft: '1.3rem' }}>
      {steps.map((step) => (
        <li key={step.text} className="meta" style={{ marginBottom: '.5rem' }}>
          {step.text}
          {/*
            A real anchor, not a domain rendered as text you have to retype into
            the address bar. `noreferrer noopener` because these open in a new
            tab and the target has no business with a handle on this window.
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
  );
}

const CAPABILITY_LABEL: Record<string, string> = {
  playlists: 'Playlists',
  taste: 'Categories',
  follows: 'Following',
  friends: 'Friends',
  assignments: 'Coursework',
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

      <LeaveOut
        providers={state.data.providers}
        hidden={state.data.hiddenProviders ?? []}
        local={local}
        onChanged={state.reload}
      />

      {state.data.providers.map((provider) => (
        <ProviderCard key={provider.id} provider={provider} local={local} reload={state.reload} />
      ))}
    </>
  );
}

/**
 * What a service stops contributing when you leave it out.
 *
 * Read off the provider's own capabilities rather than a table of ids here, so
 * a new service says the right thing without this file being edited — and one
 * that contributes to neither list is described honestly rather than given a
 * label promising something it cannot do.
 */
function leavingOut(provider: ProviderInfo): string {
  if (provider.capabilities.friends) return 'friends you know only from here';
  // Both follow providers would otherwise read "accounts you follow", which is
  // accurate and useless — the entire job of this line is naming what vanishes.
  if (provider.capabilities.follows) {
    return provider.id === 'youtube' ? 'channels you subscribe to' : 'artists you follow';
  }
  return 'nothing on these lists';
}

/**
 * Whether leaving this one out would change anything.
 *
 * The panel governs the Friends and Following lists and nothing else, so a
 * provider contributing to neither gets a box that does *precisely nothing* when
 * ticked — with a line underneath admitting as much. That was tolerable while
 * every provider fed one of the two lists; Canvas feeds neither, and a control
 * whose own label says it has no effect is worse than no control.
 */
function canBeLeftOut(provider: ProviderInfo): boolean {
  return Boolean(provider.capabilities.friends ?? provider.capabilities.follows);
}

/**
 * Services to leave out of the lists.
 *
 * **At the top of Services, not on Friends where it started.** It is a fact
 * about a *service* — the same sort of thing as whether it is connected — and
 * it governs the Following tab as well, so living on Friends made it both hard
 * to find and wrong about its own scope.
 *
 * One switch with two effects, because no service contributes both kinds of
 * thing: Steam, Discord and Riot bring people, YouTube and Spotify bring
 * accounts you follow. Separate friend and follow settings would have been two
 * lists with no provider ever appearing in both.
 *
 * Stored on the server like the theme, so a filter set on the PC does not leave
 * the phone showing everything. The filtering happens server-side too, so this
 * only sends the list and reloads.
 */
function LeaveOut({
  providers,
  hidden,
  local,
  onChanged,
}: {
  providers: ProviderInfo[];
  hidden: string[];
  local: boolean;
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState('');
  const [problem, setProblem] = useState('');

  const toggle = async (id: string, hide: boolean) => {
    setSaving(id);
    setProblem('');
    const next = hide ? [...hidden, id] : hidden.filter((p) => p !== id);

    try {
      await api.settings.update({ hiddenProviders: next });
      onChanged();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setSaving('');
    }
  };

  return (
    <details className="card" open={hidden.length > 0}>
      <summary>
        Services to leave out
        {/* On the summary, so a collapsed panel still admits it is doing
            something — and it opens itself when anything is ticked, because a
            filter you cannot see is one you forget you set. */}
        {hidden.length > 0 ? <span className="meta"> — {hidden.length} left out</span> : null}
      </summary>

      <div className="meta" style={{ marginTop: '.5rem' }}>
        These stay connected and keep syncing — they only stop appearing in the Friends and Following
        lists. A person is dropped only when <em>every</em> account they have is on a service ticked here,
        so someone you know from both League and Discord stays.
      </div>

      {providers.filter(canBeLeftOut).map((provider) => (
        <label
          key={provider.id}
          className="row"
          style={{ alignItems: 'center', gap: '.5rem', marginTop: '.5rem' }}
        >
          <input
            type="checkbox"
            checked={hidden.includes(provider.id)}
            // Read-only from the phone, like every other write on this screen.
            // The server refuses it regardless; a box that silently fails is
            // worse than one that is visibly not yours to press.
            disabled={!local || saving === provider.id}
            onChange={(e) => void toggle(provider.id, e.target.checked)}
          />
          <span aria-hidden="true">{provider.glyph}</span>
          <span className="grow">
            {provider.label} <span className="meta">— {leavingOut(provider)}</span>
          </span>
        </label>
      ))}

      {problem && <div className="banner">{problem}</div>}
    </details>
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
  const [canvasHost, setCanvasHost] = useState('');
  const [canvasToken, setCanvasToken] = useState('');
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
  /** Steps to unlock whichever capability the provider is gating, if any. */
  const unlockSteps = Object.values(provider.capabilities).flatMap((spec) => spec?.unlock ?? []);

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

  const connectCanvas = () =>
    guard('canvas', async () => {
      await api.integrations.connectCanvas(canvasHost.trim(), canvasToken.trim());
      // Cleared on success only. `guard` throws before this on failure, so a
      // rejected token stays in the box to be corrected — and a Canvas token is
      // shown once and never again, which makes retyping it from memory
      // impossible rather than merely irritating.
      setCanvasHost('');
      setCanvasToken('');
      reload();
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
              {/*
                No status chip. It read "works" / "partly" / "needs approval",
                which is a grade rather than information — the sentence
                underneath already says exactly what is and is not covered, and
                three of them stacked down a card turned the useful part into
                the small print beneath a label.

                `status` itself stays: it decides whether a Connect button is
                offered at all and whether the unlock steps appear. It is a fact
                the screen acts on, not one it needs to announce.
              */}
              <div className="row" style={{ alignItems: 'center', gap: '.5rem' }}>
                <strong>{CAPABILITY_LABEL[capability] ?? capability}</strong>
                {provider.syncedAt[capability] ? (
                  <span className="meta">synced {relativeTime(provider.syncedAt[capability])}</span>
                ) : null}
              </div>
              <div className="meta" style={{ marginTop: 2 }}>{spec.why}</div>
              {/* The citation, for when the sentence above is not believed —
                  which is the correct reaction to being told an API cannot do
                  something its documentation appears to describe. */}
              {/*
                How to turn it on, right under the row saying it is off. A
                `needs-approval` status that does not say how to get the
                approval is the same dead end as an `unavailable` one.

                Suppressed while the refusal banner is up, because that carries
                the same steps expanded — two copies of one list on one card is
                how a screen starts looking like it is repeating itself.
              */}
              {spec.unlock && spec.status === 'needs-approval' && !provider.optionalScopesRefused && (
                <details style={{ marginTop: '.35rem' }}>
                  <summary className="meta">How to enable it</summary>
                  <SetupSteps steps={spec.unlock} />
                </details>
              )}
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
          <SetupSteps steps={provider.setup} />
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
          connection works, and the part it refused is the one described above as needing to be enabled
          for your application.
          {/*
            The steps repeated here rather than pointed at. This banner is the
            moment you want them, and "see the list above" is one more thing to
            go and find on a screen you are already lost on.
          */}
          {unlockSteps.length > 0 && (
            <details open style={{ marginTop: '.4rem' }}>
              <summary className="meta">How to enable it</summary>
              <SetupSteps steps={unlockSteps} />
            </details>
          )}
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
      {provider.id === 'steam' && !provider.connected && local && (
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

      {/*
        ---- Canvas: the school's address, and the token ----

        Its own form rather than the api-key one above, which was Steam's alone
        while Steam was the only provider of that kind. Gating on `auth` there
        was correct exactly until it stopped being — a second api-key provider
        would have been shown a box asking for a Steam profile.

        The address is not a convenience field. Every school runs its own Canvas,
        so without it there is nowhere to send the token.
      */}
      {provider.id === 'canvas' && !provider.connected && local && (
        <form
          style={{ marginTop: '.75rem', display: 'grid', gap: '.5rem' }}
          onSubmit={(e) => {
            e.preventDefault();
            void connectCanvas();
          }}
        >
          <label style={{ display: 'grid', gap: '.25rem' }}>
            <span className="meta">
              Your school's Canvas address — whatever is in the address bar. A full course URL is fine;
              only the host is kept.
            </span>
            <input
              value={canvasHost}
              onChange={(e) => setCanvasHost(e.target.value)}
              placeholder="canvas.yourschool.edu"
              aria-label="Canvas address"
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <label style={{ display: 'grid', gap: '.25rem' }}>
            <span className="meta">
              Your access token — Account → Settings → <strong>+ New Access Token</strong>. Canvas shows
              it once, so copy it before leaving the page.
            </span>
            {/*
              `type="password"`, unlike Steam's key box. This one is the whole
              account rather than a read-only API key, and it is pasted from a
              page that is very likely still open on the screen behind this one.
            */}
            <input
              type="password"
              value={canvasToken}
              onChange={(e) => setCanvasToken(e.target.value)}
              placeholder="Paste the token"
              aria-label="Canvas access token"
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <div className="row wrap row-actions">
            <button
              type="submit"
              className="btn primary"
              disabled={canvasHost.trim() === '' || canvasToken.trim() === '' || busy !== ''}
            >
              {busy === 'canvas' ? 'Checking with Canvas…' : 'Connect'}
            </button>
          </div>

          <div className="meta">
            Worth knowing: a Canvas token is your whole account — grades, submissions, everything — and
            there is no read-only kind to ask for. It is stored in this app's database in the clear, like
            every other token here. Coursework with a due date becomes a task; nothing is ever written
            back to Canvas.
          </div>
        </form>
      )}

      {provider.auth === 'api-key' && !provider.connected && !local && (
        <div className="meta" style={{ marginTop: '.75rem' }}>
          {provider.label} is connected from the PC running the server.
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
