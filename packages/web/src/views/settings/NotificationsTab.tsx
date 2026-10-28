/**
 * Settings → Notifications: phone push, quiet hours and the sounds.
 */
import { useEffect, useState } from 'react';
import { api, type Session } from '../../api';
import { useAsync } from '../../useAsync';
import { Toggle } from '../../controls';
import {
  checkPushSupport,
  currentSubscription,
  disablePush,
  enablePush,
  pushDiagnostics,
  type PushDiagnostics,
} from '../../push';
import { QuietHours } from './QuietHours';

export function NotificationsTab({ session }: { session: Session }) {
  // An older server sends no feature list; absent means everything, not nothing.
  const has = (id: string) => session.features === undefined || session.features.includes(id);

  return (
    <>
      <QuietHours />
      {/* Configures a feature. With push off this would be a subscribe button
          with no key behind it. */}
      {has('push') && <PhoneNudges />}
    </>
  );
}

/**
 * Notifications on this device, when you aren't at the PC.
 *
 * Shown everywhere, because the useful place to turn it on is the phone itself
 * — but it explains itself differently depending on whether this device can
 * actually receive them.
 */
function PhoneNudges() {
  const settings = useAsync(() => api.settings.get(), [], ['settings']);
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const support = checkPushSupport();

  useEffect(() => {
    void currentSubscription().then((s) => setSubscribed(Boolean(s)));
  }, []);

  const current = settings.data;
  if (!current) return null;

  async function turnOn() {
    setBusy(true);
    try {
      const result = await enablePush(current!.vapidPublicKey);
      setMessage(result.message);
      setSubscribed(result.ok);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not enable notifications.');
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    try {
      await disablePush();
      setSubscribed(false);
      setMessage('This device will no longer be notified.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Phone nudges</h2>

      <div className="card">
        <div className="row between">
          <div className="grow">
            <div className="title">Send nudges to my phone when I'm away</div>
            <div className="meta">
              Only once the PC has been untouched for {current.awayFromPcIdleMinutes} minutes{' '}
              <strong>and</strong> nothing is playing — so a long film never sets your pocket buzzing.
            </div>
          </div>
          <Toggle
            on={Boolean(current.pushEnabled)}
            disabled={busy}
            label="Send nudges to my phone"
            onChange={async (on) => {
              await api.settings.update({ pushEnabled: on });
              settings.reload();
            }}
          />
        </div>
      </div>

      {/* Absent on a server older than the column. Rendering a switch that
          would be silently dropped is worse than not offering it. */}
      {current.pushDefault !== undefined && (
        <div className="card">
          <div className="row between">
            <div className="grow">
              <div className="title">Push new tasks and habits by default</div>
              <div className="meta">
                What something gets when you haven't said either way. Each task and habit can override
                this in its own editor, and anything left on <em>Default</em> follows this switch —
                including things you made before you changed it.
              </div>
            </div>
            <Toggle
              on={Boolean(current.pushDefault)}
              disabled={busy || !current.pushEnabled}
              label="Push new tasks and habits by default"
              onChange={async (on) => {
                await api.settings.update({ pushDefault: on });
                settings.reload();
              }}
            />
          </div>
          {!current.pushEnabled && (
            <div className="meta" style={{ marginTop: 8 }}>
              Nothing goes to the phone at all while the switch above is off, so this has no effect yet.
            </div>
          )}
        </div>
      )}

      <div className="card">
        <div className="row between">
          <div className="grow">
            <div className="title">Notifications on this device</div>
            <div className="meta">
              {!support.supported
                ? support.reason
                : subscribed
                  ? 'This device is set up to receive them.'
                  : 'Not set up yet.'}
            </div>
            {!support.supported && support.fix && (
              <div className="meta" style={{ marginTop: 6 }}>
                <strong>{support.fix}</strong>
              </div>
            )}
          </div>
          {support.supported && (
            <button className="btn" disabled={busy} onClick={subscribed ? turnOff : turnOn}>
              {busy ? '…' : subscribed ? 'Turn off' : 'Turn on'}
            </button>
          )}
        </div>
        {message && <div className="meta" style={{ marginTop: 8 }}>{message}</div>}

        {/* Shown on the device with the problem, since that's where it can be
            read — describing it back on the PC is no help. */}
        {!support.supported && <Diagnostics />}
      </div>
    </section>
  );
}

function Diagnostics() {
  const [info, setInfo] = useState<PushDiagnostics | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void pushDiagnostics().then(setInfo);
  }, []);

  if (!info) return null;

  const rows: [string, string, boolean][] = [
    ['Address', info.origin, info.secure],
    ['Secure connection', info.secure ? 'yes' : 'no — needs https', info.secure],
    ['Opened from Home Screen', info.installed ? 'yes' : 'no', info.installed],
    ['Service worker', info.hasServiceWorker ? 'available' : 'missing', info.hasServiceWorker],
    ['Push support', info.hasPushManager ? 'available' : 'missing', info.hasPushManager],
    ['Permission', info.permission, info.permission === 'granted'],
  ];

  return (
    <>
      <button className="btn subtle" style={{ marginTop: 8 }} onClick={() => setOpen((v) => !v)}>
        {open ? 'hide details' : 'why not?'}
      </button>
      {open && (
        <div className="diagnostics">
          {rows.map(([label, value, ok]) => (
            <div className="row between" key={label}>
              <span className="meta">{label}</span>
              <span className={ok ? 'meta ok-text' : 'meta urgent'}>{value}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
