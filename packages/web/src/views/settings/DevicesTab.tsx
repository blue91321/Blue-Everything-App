/**
 * Settings → Devices: what is signed in, adding a phone or another PC, the
 * browser extension and the desktop shortcut.
 */
import { DesktopDownload } from '../../DesktopDownload';
import { useState } from 'react';
import { api, type Device, type Session } from '../../api';
import { useAsync } from '../../useAsync';
import { relative } from '../../format';

/**
 * A short code another device types to sign in to this copy: an app just added
 * to a Home Screen, a laptop's browser, or the desktop client on another PC.
 * From any signed-in device, which is how a friend adds one, since pairing on
 * the PC is the host's. The address is this page's, or on the PC itself, the
 * Tailscale one the phone would use.
 */
function SignInAnother({ local }: { local: boolean }) {
  const info = useAsync(() => (local ? api.connectInfo() : Promise.resolve(null)), [local], ['devices']);
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [problem, setProblem] = useState('');
  const address = local
    ? (info.data?.addresses.find((a) => a.secure && a.kind === 'tailscale-https')?.url ?? null)
    : window.location.origin;
  return (
    <section>
      <h2>Sign in another device</h2>
      <div className="card">
        <div className="meta">
          On the other device, open the address below and type the code when it asks. The code works once, for ten
          minutes.
        </div>
        <div className="row" style={{ gap: 12, alignItems: 'baseline', flexWrap: 'wrap', marginTop: 8 }}>
          {address ? <code style={{ wordBreak: 'break-all' }}>{address}</code> : <span className="meta">Add your phone shows this PC's address.</span>}
          {code ? (
            <strong style={{ fontSize: '1.4rem', letterSpacing: '0.08em' }}>{code.code}</strong>
          ) : (
            <button
              className="btn"
              onClick={() => {
                setProblem('');
                api.devices.handoff().then(setCode, (e: unknown) => setProblem(e instanceof Error ? e.message : 'no code'));
              }}
            >
              Make a code
            </button>
          )}
        </div>
        <div className="meta" style={{ marginTop: 12 }}>
          <strong>Blue Everything Desktop</strong> is optional: the app works in a browser and on a phone without it. On a
          Windows PC it adds popups over games, noticing when a match ends, and voice, which need it running in the
          background there. Unzip it, open <code>Blue Everything Desktop.cmd</code>, and type the address above and a
          code.
        </div>
        <div style={{ marginTop: 8 }}>
          <DesktopDownload />
        </div>
        {problem && <p className="banner">{problem}</p>}
      </div>
    </section>
  );
}

export function DevicesTab({ session, onChanged }: { session: Session; onChanged: () => void }) {
  const devices = useAsync(() => api.devices.list(), [], ['devices']);
  const [adding, setAdding] = useState(false);

  const has = (id: string) => session.features === undefined || session.features.includes(id);

  return (
    <>
      <section>
        <h2>This device</h2>
        <div className="card">
          <div className="title">{session.local ? 'This PC' : 'A connected device'}</div>
          <div className="meta">
            {session.local
              ? 'Running on the machine hosting Blue Everything, so no code is needed here.'
              : 'Connected with a code.'}
          </div>
          {/* Worth showing because the PWA and the server update independently:
              a phone holding a cached bundle against a restarted server is the
              ordinary case, and "which version am I looking at" is the first
              question when something looks wrong. */}
          {session.version && <div className="meta">Version {session.version}</div>}
        </div>
      </section>

      {/* First on this tab after "this device", because it is the first thing
          anybody wants: a way back into the app that is not the folder they
          unzipped. */}
      <DesktopIcon />

      {session.local && (
        <section>
          <div className="row between">
            <h2 style={{ margin: 0 }}>Add your phone</h2>
            <button className="btn" onClick={() => setAdding((v) => !v)}>
              {adding ? 'Close' : 'Show me how'}
            </button>
          </div>
          {adding && <AddDeviceGuide onAdded={devices.reload} />}
        </section>
      )}

      <SignInAnother local={session.local} />

      {/* The extension exists to fill vault entries, so it is part of that
          feature rather than a device type of its own. */}
      {session.local && has('vault') && <BrowserExtension onAdded={devices.reload} />}

      <section>
        <h2>Connected devices</h2>
        {devices.loading && <div className="empty">loading…</div>}
        {devices.data?.length === 0 && <div className="empty">No devices connected yet.</div>}
        {devices.data?.map((device) => (
          <DeviceRow
            key={device.id}
            device={device}
            local={session.local}
            onChanged={() => {
              devices.reload();
              onChanged();
            }}
          />
        ))}
      </section>
    </>
  );
}

/**
 * One paired device, and what can be done to it.
 *
 * Revoked ones stay on the list until they are cleared by hand, because the row
 * *is* the record that it happened — but a list that only ever grows turns into
 * a wall of struck-through names, and there is no way to tell which of four
 * revoked "iPhone" entries is which. So the record can be closed once it has
 * been read.
 *
 * Removing asks first. It is the only irreversible thing on this screen, and it
 * sits one button away from `revoke`, which is not.
 */
function DeviceRow({
  device,
  local,
  onChanged,
}: {
  device: Device;
  local: boolean;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="card">
      <div className="row between">
        <div className="grow">
          <div className={`title${device.revokedAt ? ' struck' : ''}`}>{device.name}</div>
          <div className="meta">
            {device.kind}
            {device.revokedAt
              ? ` · revoked ${relative(device.revokedAt)}`
              : device.lastSeenAt
                ? ` · seen ${relative(device.lastSeenAt)}`
                : ' · never used'}
          </div>
        </div>

        {!device.revokedAt && local && (
          <button className="btn subtle danger" onClick={() => api.devices.revoke(device.id).then(onChanged)}>
            revoke
          </button>
        )}

        {device.revokedAt &&
          local &&
          (confirming ? (
            <>
              <span className="meta">remove for good?</span>
              <button className="btn subtle danger" onClick={() => api.devices.remove(device.id).then(onChanged)}>
                yes
              </button>
              <button className="btn subtle" onClick={() => setConfirming(false)}>
                no
              </button>
            </>
          ) : (
            <button className="btn subtle" onClick={() => setConfirming(true)}>
              remove
            </button>
          ))}
      </div>
    </div>
  );
}

/**
 * Pairing for the browser extension.
 *
 * Separate from the phone flow because the answer is different: the extension
 * is the only other thing allowed to touch the vault, so its code is worth
 * treating as a distinct decision rather than one more device.
 */
function BrowserExtension({ onAdded }: { onAdded: () => void }) {
  const [issued, setIssued] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function createCode() {
    setError('');
    try {
      const created = await api.devices.create({ name: 'Browser extension', kind: 'extension' });
      setIssued(created.token);
      onAdded();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'could not create a code');
    }
  }

  return (
    <section>
      <h2>Browser extension</h2>
      <div className="card">
        <div className="title">Autofill in this browser</div>
        <div className="meta" style={{ marginTop: 4 }}>
          The extension is the only thing besides this PC that may read the vault. Load it from{' '}
          <code>packages\extension</code> at <code>brave://extensions</code> with developer mode on, then
          paste a code below into it.
        </div>

        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn primary" onClick={createCode}>
            Create code
          </button>
        </div>
        {error && <div className="banner">{error}</div>}
        {issued && (
          <>
            <input readOnly value={issued} onFocus={(e) => e.currentTarget.select()} style={{ marginTop: 8 }} />
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn" onClick={() => navigator.clipboard?.writeText(issued).catch(() => {})}>
                Copy
              </button>
              <span className="meta">Shown once.</span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Put the app's icon on the Desktop.
 *
 * This has always been `Create Desktop Icon.cmd`, and having that as the only
 * way meant the answer to "how do I open this tomorrow" was "go back to the
 * folder you unzipped it into" — which is the friction the double-clickable
 * files were supposed to remove, turning up one level higher. The first thing
 * anybody wants after getting the app open is a reliable way back to it, and
 * they are already looking at the app when they want it.
 *
 * **It reports where the shortcut went, rather than saying "done".** OneDrive
 * redirects the Desktop, so the folder Windows means by it is often not
 * `%USERPROFILE%\Desktop` — the script asks Windows and prints the paths, and
 * repeating them here is what stops "it worked" being followed by "then where
 * is it".
 *
 * Absent rather than disabled from the phone. The Desktop in question is the
 * PC's, so the button could only ever apologise there.
 */
function DesktopIcon() {
  const status = useAsync(() => api.desktopIcon.status(), [], ['devices']);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<string[] | null>(null);
  const [problem, setProblem] = useState('');

  if (status.loading || !status.data?.local) return null;

  async function create() {
    setBusy(true);
    setProblem('');
    setMade(null);
    try {
      const result = await api.desktopIcon.create();
      setMade(result.created);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'could not make the shortcut');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="desktop-icon">
      <h2>Desktop icon</h2>
      <div className="card">
        <div className="meta">
          Puts a <strong>Blue Everything</strong> icon on your Desktop and in the Start Menu. Clicking it
          starts the app if it is not already running, then opens it in its own window — so this folder is
          not something you ever need to find again.
        </div>

        {status.data.available ? (
          <>
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn primary" onClick={create} disabled={busy}>
                {busy ? 'making it…' : made ? 'Make it again' : 'Create desktop icon'}
              </button>
              {busy && <span className="meta">the first one also builds the icon, which takes a moment</span>}
            </div>

            {made && (
              <div className="meta ok-text" style={{ marginTop: 8 }}>
                {made.length > 0 ? (
                  <>
                    Done — it went here:
                    {made.map((path) => (
                      <div key={path}>
                        <code>{path}</code>
                      </div>
                    ))}
                  </>
                ) : (
                  'Done.'
                )}
                <div style={{ marginTop: 4 }}>You can drag the Desktop one onto your taskbar to pin it.</div>
              </div>
            )}
            {problem && <div className="banner">{problem}</div>}
          </>
        ) : (
          <div className="meta" style={{ marginTop: 8 }}>
            The script that does this is missing, so double-click{' '}
            <code>Create Desktop Icon.cmd</code> in the app's folder instead.
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * Step-by-step for putting Everything on a phone.
 *
 * The address matters more than the code: iOS will only install a web app, and
 * only deliver push notifications, over HTTPS. A plain Tailscale IP loads fine
 * in Safari and then silently fails to install, which is a miserable thing to
 * debug from the sofa — so the guide leads with getting that right.
 */
function AddDeviceGuide({ onAdded }: { onAdded: () => void }) {
  const info = useAsync(() => api.connectInfo(), [], ['devices']);
  const [name, setName] = useState('iPhone');
  const [issued, setIssued] = useState<string | null>(null);
  const [error, setError] = useState('');

  const secure = info.data?.addresses.find((a) => a.secure && a.kind === 'tailscale-https');
  const plainTailscale = info.data?.addresses.find((a) => a.kind === 'tailscale');
  const address = secure ?? plainTailscale ?? info.data?.addresses.find((a) => a.kind === 'lan');

  async function createCode() {
    setError('');
    try {
      const created = await api.devices.create({ name: name.trim() || 'iPhone', kind: 'phone' });
      setIssued(created.token);
      onAdded();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'could not create a code');
    }
  }

  return (
    <div className="card guide">
      <ol>
        {/*
          The step that was a sentence and is now a link.
          "Make sure Tailscale is on both devices" is a fine instruction for
          somebody who has it, and for everybody else it is an errand: work out
          what Tailscale is, find the right site among the search results, and
          pick the right download for the machine you are sitting at. Every step
          of that is a chance to give up, and none of it is a decision — there
          is exactly one place to get it.

          Whether it is *running here* is already known, so the step says which
          half is outstanding rather than making you check.
        */}
        <li>
          <strong>Install Tailscale on both devices.</strong>
          <div className="meta">
            It's what lets your phone reach this PC from anywhere, without opening anything to the
            internet. Free for personal use, and you sign in to it with the same account on both.
          </div>
          <div className="row wrap" style={{ gap: '.35rem', marginTop: 8 }}>
            <a
              className="btn"
              href="https://tailscale.com/download/windows"
              target="_blank"
              rel="noreferrer noopener"
            >
              Download for this PC
            </a>
            <a className="btn subtle" href="https://tailscale.com/download" target="_blank" rel="noreferrer noopener">
              Get it for your phone
            </a>
          </div>
          {!info.loading &&
            (info.data?.tailscale ? (
              <div className="meta ok-text" style={{ marginTop: 6 }}>
                Running on this PC as <code>{info.data.tailscale.dnsName}</code> — the phone is the half
                left to do.
              </div>
            ) : (
              <div className="meta" style={{ marginTop: 6 }}>
                Not running on this PC yet. Install it, sign in, and this page will fill in the rest.
              </div>
            ))}
        </li>

        <li>
          <strong>Turn on the secure address.</strong>
          {info.loading && <div className="meta">checking…</div>}
          {!info.loading && secure && (
            <div className="meta ok-text">Already done — your secure address is ready below.</div>
          )}
          {!info.loading && !secure && (
            <>
              <div className="meta">
                iPhones will only install an app, and only show its notifications, over a secure (https)
                address. Run this once on this PC, in PowerShell:
              </div>
              <code className="snippet">tailscale serve --bg {info.data?.port ?? 8787}</code>
              {plainTailscale && (
                <div className="meta">
                  Without it you'd be using <code>{plainTailscale.url}</code>, which loads in Safari but
                  can't be added to the Home Screen.
                </div>
              )}
            </>
          )}
        </li>

        <li>
          <strong>Open this address on your phone.</strong>
          {address ? (
            <>
              <code className="snippet">{secure ? secure.url : address.url}</code>
              <div className="meta">{secure ? secure.label : address.label}</div>
            </>
          ) : (
            <div className="meta">No network address found — is Tailscale running?</div>
          )}
        </li>

        <li>
          <strong>Create a code and paste it there.</strong>
          <div className="row" style={{ marginTop: 8 }}>
            <div className="grow">
              <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Device name" />
            </div>
            <button className="btn primary" onClick={createCode}>
              Create code
            </button>
          </div>
          {error && <div className="banner">{error}</div>}
          {issued && (
            <>
              <input readOnly value={issued} onFocus={(e) => e.currentTarget.select()} style={{ marginTop: 8 }} />
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn" onClick={() => navigator.clipboard?.writeText(issued).catch(() => {})}>
                  Copy
                </button>
                <span className="meta">Shown once — copy it now.</span>
              </div>
            </>
          )}
        </li>

        <li>
          <strong>Add it to your Home Screen.</strong>
          <div className="meta">
            In Safari, tap Share, then "Add to Home Screen". It has to be Safari — other iPhone browsers
            can't install apps. Open it from the Home Screen icon from then on, or notifications won't
            arrive.
          </div>
        </li>
      </ol>
    </div>
  );
}
