/**
 * Settings → Packages: which parts of the app run, installing and removing
 * packages, the version and updates.
 */
import { serverPc } from '../../device';
import { useState } from 'react';
import { api, apiRequest, type Session, type UpdateCheck } from '../../api';
import { InstalledPackages } from './InstalledPackages';
import { useAsync } from '../../useAsync';
import { Toggle } from '../../controls';

/**
 * Which parts of the app run at all.
 *
 * Not the same question as any other switch on this screen. Turning quiet hours
 * off changes what the app *does*; turning the vault off means its routes are
 * never registered, its tab never appears, and the agent never loads its code.
 * That is why it needs a restart and says so rather than pretending to be
 * instant — the alternative was unregistering Fastify routes at runtime, which
 * is a large fragile thing to build for a switch flipped twice a year.
 */
export function PackagesTab({ session }: { session: Session }) {
  const state = useAsync(() => api.features.get(), [], ['settings']);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  // Above the early returns below, like every hook here — see App's for why.
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);

  const data = state.data;
  if (state.loading) return <div className="empty">loading…</div>;
  if (!data) return <div className="banner">Could not read the feature list.</div>;

  async function toggle(id: string, enabled: boolean) {
    setError('');
    setBusy(id);
    try {
      await api.features.set(id, enabled);
      state.reload();
    } catch {
      setError(`That could not be saved. Features can only be changed from ${serverPc()}.`);
    } finally {
      setBusy(null);
    }
  }

  const updates = data.updates;

  async function checkForUpdates() {
    setError('');
    setChecking(true);
    try {
      setCheck(await api.updates.check());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check for updates.');
    } finally {
      setChecking(false);
    }
  }

  async function update() {
    if (!check?.latest) return;
    const ok = window.confirm(
      `Update to ${check.latest}? The app stops, updates and starts again — about a minute, longer if dependencies changed. ` +
        'Your data is backed up to the backups folder first and is not replaced.'
    );
    if (!ok) return;
    setError('');
    try {
      await api.updates.apply();
      setUpdating(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The update could not be started.');
    }
  }

  return (
    <section>
      <h2>Packages</h2>
      <div className="meta" style={{ marginBottom: 12 }}>
        Optional parts of the app. Switching one off unregisters its API routes, hides its tab, and stops
        the agent loading it — you get the memory and the disk back, not just the menu entry.
      </div>

      <ConfigurationCard />

      {/* Absent on a server older than per-package versions. */}
      {data.appVersion && (
        <div className="card">
          <div className="row between">
            <div className="grow">
              <div className="title">Blue Everything {data.appVersion}</div>
              <div className="meta" style={{ marginTop: 4 }}>
                {updates?.configured
                  ? 'Everything below ships with the app, so it is all this version. Updates come from its GitHub releases.'
                  : 'Everything below ships with the app, so it is all this version. Packages downloaded separately will show their own.'}
              </div>
              {/* Says why rather than leaving a dead button to be poked at.
                  The same reasoning as the switches being disabled when
                  EVERYTHING_FEATURES overrides them. */}
              {!updates?.configured && (
                <div className="meta" style={{ marginTop: 4 }}>
                  Update checking is switched off: <code>UPDATE_URL</code> is empty.
                </div>
              )}
            </div>
            <button
              className="btn"
              disabled={!updates?.configured || checking || updating}
              title={updates?.configured ? 'Ask GitHub for the newest release' : 'No update source configured'}
              onClick={() => void checkForUpdates()}
            >
              {checking ? 'Checking…' : 'Check for updates'}
            </button>
          </div>

          {updating && (
            <div className="banner" style={{ marginTop: 10 }}>
              Updating to {check?.latest}. The app will disconnect and come back on its own in a minute or two. If it
              does not,{' '}
              <button className="btn subtle" onClick={() => void api.logs.open('update.log').catch((e: Error) => setError(e.message))}>
                open the update log
              </button>
              .
            </div>
          )}

          {check && !updating && (
            <div style={{ marginTop: 10 }}>
              {check.note ? (
                <div className="meta">Nothing has been released yet.</div>
              ) : !check.newer ? (
                <div className="meta">You have the newest version ({check.current}).</div>
              ) : (
                <>
                  <div className="row between">
                    <div className="title">{check.latest} is available</div>
                    {check.canApply ? (
                      <button className="btn primary" onClick={() => void update()}>
                        Update now
                      </button>
                    ) : (
                      <span className="meta">Update from {serverPc()}.</span>
                    )}
                  </div>
                  <div className="meta" style={{ marginTop: 4 }}>
                    {check.kind === 'git'
                      ? 'This copy is a git clone, so it pulls the new version.'
                      : 'This copy came from a release zip, so it downloads the new one and replaces only the files the app ships.'}{' '}
                    Your data, settings and installed packages are kept, and backed up first. Or double-click{' '}
                    <code>Update Blue Everything.cmd</code>.
                  </div>
                  {check.notes && <pre className="meta update-notes">{check.notes}</pre>}
                  {check.url && (
                    <a className="meta" href={check.url} target="_blank" rel="noreferrer">
                      The release on GitHub
                    </a>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {data.lockedByEnv && (
        <div className="banner">
          <strong>EVERYTHING_FEATURES is set</strong>, and it overrides <code>features.json</code>. These
          switches would write a file nothing reads, so they are disabled until it is unset.
        </div>
      )}

      {data.pendingRestart && (
        <div className="banner">
          <strong>Restart to apply.</strong> The choices below are saved, but the running app still has the
          old set — features are resolved once when it starts. Right-click the tray icon and choose
          <strong> Restart</strong>.
        </div>
      )}

      {!session.local && (
        <div className="meta" style={{ marginBottom: 10 }}>
          These can only be changed from {serverPc()}.
        </div>
      )}

      {error && <div className="banner">{error}</div>}

      {/*
        Two kinds of package, and the split is honest rather than decorative.
        These ship inside the repo across up to three workspaces — the vault
        owns a server folder, a web folder and the whole extension — so there is
        no single folder to open or delete, which is exactly why the buttons
        below this list do not appear on these rows.
      */}
      <h3 className="pkg-head">Built in</h3>
      <div className="meta" style={{ marginBottom: 8 }}>
        Part of the app itself, and woven into the Dashboard — these three switch off but have no folder
        to delete. The packages below them ship with the app and can be removed like any other.
      </div>

      {data.features.map((feature) => (
        <div className="card" key={feature.id}>
          <div className="row between">
            <div className="grow">
              <div className="title">
                {feature.label}
                {/* The version sits on the row rather than in a column of its
                    own: with everything bundled they are all the same number,
                    and a column of identical values reads as noise until one
                    of them genuinely diverges. */}
                {feature.version && (
                  <span className="meta" title={feature.bundled ? 'ships with the app' : 'installed separately'}>
                    {' '}
                    · {feature.version}
                    {feature.bundled ? '' : ' (separate)'}
                  </span>
                )}
                {feature.missing && (
                  <span className="urgent" title="switched on, but its folders are gone from disk">
                    {' '}
                    ⚠ not installed
                  </span>
                )}
                {/* Saved but not yet live — the restart banner explains it once,
                    this says which rows it is about. */}
                {feature.wanted !== feature.running && (
                  <span className="meta"> · {feature.wanted ? 'on' : 'off'} after restart</span>
                )}
              </div>
              <div className="meta" style={{ marginTop: 4 }}>
                {feature.blurb}
              </div>
              {feature.cost && (
                <div className="meta" style={{ marginTop: 4 }}>
                  Costs: {feature.cost}
                </div>
              )}
              {/* The honest boundary: some of these switch off cleanly but
                  cannot be deleted, because the Dashboard renders them inline.
                  Saying so beats a `removable: true` that sends somebody
                  deleting a folder and into a broken build. */}
              <div className="meta" style={{ marginTop: 4 }}>
                {feature.removable
                  ? 'Can also be deleted from disk entirely.'
                  : 'Can be switched off, but not removed — the Dashboard uses it.'}
              </div>
            </div>

            <Toggle
              on={feature.wanted}
              disabled={busy !== null || data.lockedByEnv || !session.local}
              label={`${feature.label} on`}
              onChange={(on) => void toggle(feature.id, on)}
            />
          </div>

          {feature.missing && (
            <div className="meta" style={{ marginTop: 8 }}>
              Its folders have been removed: {feature.owns.join(', ') || 'none listed'}. Switching it off
              stops the app expecting it.
            </div>
          )}
        </div>
      ))}

      <InstalledPackages session={session} />
    </section>
  );
}

type ConfigurationState = {
  configuration: 'everything' | 'just-manga';
  kind: 'git' | 'release';
  canSwitch: boolean;
  why: string | null;
  leftOut: string[];
};

/**
 * Everything or Just Manga, and the button to switch, both ways. A release
 * install downloads the other one (backing your data up first); a clone
 * switches the other packages off or back on. Either way the app restarts.
 * See `routes/configuration.ts`.
 *
 * **Three confirmations, on purpose**, since it changes what the whole install
 * is: the button only opens an explanation, which has to be ticked as read;
 * then the new configuration's name has to be typed; then the browser asks one
 * last time. The server refuses a switch that does not carry the typed name,
 * so a stray or old request cannot do it either.
 */
function ConfigurationCard() {
  const state = useAsync(() => apiRequest<ConfigurationState>('/api/configuration'), [], ['settings']);
  const [step, setStep] = useState<'idle' | 'explain' | 'type'>('idle');
  const [understood, setUnderstood] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  const data = state.data;
  // Absent on a server older than the switch.
  if (!data) return null;
  const manga = data.configuration === 'just-manga';
  const to = manga ? 'everything' : 'just-manga';
  const toName = manga ? 'Everything' : 'Just Manga';
  const phrase = toName.toUpperCase();
  const matches = typed.trim().replace(/\s+/g, ' ').toUpperCase() === phrase;
  const what: string[] =
    data.kind === 'release'
      ? manga
        ? [
            'Your data is backed up first (to the backups folder).',
            'The newest full app is downloaded and installed over this one.',
            'The app stops while it installs, and starts again by itself.',
            'Your manga, reading history and settings stay.',
          ]
        : [
            'Your data is backed up first (to the backups folder).',
            'The newest manga-only app is downloaded and installed over this one.',
            `Everything but Manga is removed from the app's folder: ${data.leftOut.join(', ') || 'the other parts'}. Their data stays, and comes back if you switch again.`,
            'The app stops while it installs, and starts again by itself.',
          ]
      : manga
        ? ['The parts it switched off are switched back on.', 'The app restarts by itself.']
        : [
            `These are switched off, their folders kept: ${data.leftOut.join(', ') || 'everything but Manga'}.`,
            'Switching back to Everything turns exactly those on again.',
            'The app restarts by itself.',
          ];

  const cancel = () => {
    setStep('idle');
    setUnderstood(false);
    setTyped('');
  };

  async function go() {
    if (!matches || !understood) return;
    if (!confirm(`Last check: switch this install to ${toName} now? The app will restart.`)) return;
    setBusy(true);
    setSaid('');
    try {
      const done = await apiRequest<{ how: 'download' | 'restart' }>('/api/configuration', {
        method: 'POST',
        body: JSON.stringify({ to, confirmed: phrase }),
      });
      cancel();
      setSaid(
        done.how === 'download'
          ? 'Downloading and installing. The app stops and comes back by itself; logs/update.log says how it went.'
          : 'Restarting. The app comes back by itself in a few seconds.'
      );
    } catch (error) {
      setSaid((error as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="row between" style={{ gap: 12, flexWrap: 'wrap' }}>
        <div className="grow">
          <div className="title">{manga ? 'Just Manga' : 'Everything'}</div>
          <div className="meta" style={{ marginTop: 4 }}>
            {manga ? 'The manga reader on its own.' : 'The whole app.'}
          </div>
        </div>
        {step === 'idle' && (
          <button className="btn" disabled={busy || !data.canSwitch} title={data.why ?? undefined} onClick={() => setStep('explain')}>
            Switch to {toName}…
          </button>
        )}
      </div>
      {!data.canSwitch && data.why && <div className="meta" style={{ marginTop: 6 }}>Not from here: {data.why}.</div>}

      {step !== 'idle' && (
        <div className="config-switch" style={{ marginTop: 10 }}>
          <div className="title">Switching to {toName} will:</div>
          <ul className="meta">
            {what.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <label className="row" style={{ gap: '.5rem', alignItems: 'flex-start' }}>
            <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} disabled={busy} />
            <span>I have read this and want to switch.</span>
          </label>
          {step === 'explain' ? (
            <div className="row" style={{ gap: '.4rem', marginTop: 8 }}>
              <button className="btn" disabled={!understood} onClick={() => setStep('type')}>
                Continue
              </button>
              <button className="btn subtle" onClick={cancel}>
                Cancel
              </button>
            </div>
          ) : (
            <form
              style={{ marginTop: 8 }}
              onSubmit={(e) => {
                e.preventDefault();
                void go();
              }}
            >
              <label className="meta" htmlFor="config-phrase">
                To confirm, type <strong>{phrase}</strong>
              </label>
              <div className="row" style={{ gap: '.4rem', marginTop: 4, flexWrap: 'wrap' }}>
                <input
                  id="config-phrase"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoComplete="off"
                  disabled={busy}
                  autoFocus
                />
                <button className="btn primary" type="submit" disabled={busy || !understood || !matches}>
                  Switch to {toName}
                </button>
                <button className="btn subtle" type="button" onClick={cancel} disabled={busy}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}
      {said && <div className="meta" style={{ marginTop: 6 }}>{said}</div>}
    </div>
  );
}
