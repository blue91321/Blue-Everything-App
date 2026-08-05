import { useEffect, useState } from 'react';
import { api, type Session } from '../api';
import { useAsync } from '../useAsync';
import { clockTime, relative } from '../format';
import { checkPushSupport, currentSubscription, disablePush, enablePush } from '../push';

export function Settings({ session, onChanged }: { session: Session; onChanged: () => void }) {
  const devices = useAsync(() => api.devices.list());
  const [adding, setAdding] = useState(false);

  return (
    <>
      <QuietHours />
      <PhoneNudges />

      <section>
        <h2>This device</h2>
        <div className="card">
          <div className="title">{session.local ? 'This PC' : 'A connected device'}</div>
          <div className="meta">
            {session.local
              ? 'Running on the machine hosting Everything, so no code is needed here.'
              : 'Connected with a code.'}
          </div>
        </div>
      </section>

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

      <section>
        <h2>Connected devices</h2>
        {devices.loading && <div className="empty">loading…</div>}
        {devices.data?.length === 0 && <div className="empty">No devices connected yet.</div>}
        {devices.data?.map((device) => (
          <div className="card" key={device.id}>
            <div className="row between">
              <div className="grow">
                <div className={`title${device.revokedAt ? ' struck' : ''}`}>{device.name}</div>
                <div className="meta">
                  {device.kind}
                  {device.revokedAt
                    ? ' · revoked'
                    : device.lastSeenAt
                      ? ` · seen ${relative(device.lastSeenAt)}`
                      : ' · never used'}
                </div>
              </div>
              {!device.revokedAt && session.local && (
                <button
                  className="btn subtle danger"
                  onClick={() =>
                    api.devices.revoke(device.id).then(() => {
                      devices.reload();
                      onChanged();
                    })
                  }
                >
                  revoke
                </button>
              )}
            </div>
          </div>
        ))}
      </section>
    </>
  );
}

/**
 * Notifications on this device, when Blake isn't at the PC.
 *
 * Shown everywhere, because the useful place to turn it on is the phone itself
 * — but it explains itself differently depending on whether this device can
 * actually receive them.
 */
function PhoneNudges() {
  const settings = useAsync(() => api.settings.get());
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
          </div>
          {support.supported && (
            <button className="btn" disabled={busy} onClick={subscribed ? turnOff : turnOn}>
              {busy ? '…' : subscribed ? 'Turn off' : 'Turn on'}
            </button>
          )}
        </div>
        {message && <div className="meta" style={{ marginTop: 8 }}>{message}</div>}
      </div>
    </section>
  );
}

const toTimeInput = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

const fromTimeInput = (value: string) => {
  const [h, m] = value.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

const QUIET_EXPLANATION: Record<string, string> = {
  'reminders-off': 'Reminders are switched off entirely.',
  paused: 'Paused by hand.',
  'quiet-hours': 'Inside your quiet hours.',
  'windows-dnd': "Windows Do Not Disturb is on, and you've asked Everything to follow it.",
};

const PAUSE_CHOICES = [
  { hours: 1, label: '1 hour' },
  { hours: 8, label: '8 hours' },
  { hours: 12, label: '12 hours' },
];

/**
 * When reminders are allowed to interrupt at all.
 *
 * Three independent ways to go quiet, because one fixed schedule doesn't suit
 * an irregular one: a clock window, following Windows' own Do Not Disturb (a
 * switch flipped when you actually go to bed), and a manual pause.
 */
function QuietHours() {
  const settings = useAsync(() => api.settings.get());
  const [saving, setSaving] = useState(false);

  const current = settings.data;
  if (!current) return null;

  async function update(payload: Parameters<typeof api.settings.update>[0]) {
    setSaving(true);
    try {
      await api.settings.update(payload);
      settings.reload();
    } finally {
      setSaving(false);
    }
  }

  const pausedUntil = current.dndUntil && current.dndUntil > Date.now() ? current.dndUntil : null;

  return (
    <section>
      <h2>Reminders</h2>

      <div className="card">
        <div className="row between">
          <div className="grow">
            <div className="title">{current.quietNow ? 'Silent right now' : 'Active'}</div>
            <div className="meta">
              {current.quietNow
                ? QUIET_EXPLANATION[current.quietReason ?? ''] ?? 'Something is holding reminders.'
                : 'Still silent during a game, and while you are away from the desk.'}
            </div>
          </div>
          <button className="btn" disabled={saving} onClick={() => update({ remindersEnabled: !current.remindersEnabled })}>
            {current.remindersEnabled ? 'Turn all off' : 'Turn on'}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="row between">
          <div className="grow">
            <div className="title">Pause for a while</div>
            <div className="meta">
              {pausedUntil ? `Paused until ${clockTime(pausedUntil)}.` : 'A one-off, for when you turn in early or late.'}
            </div>
          </div>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          {pausedUntil ? (
            <button className="btn primary" disabled={saving} onClick={() => update({ dndUntil: null })}>
              Resume now
            </button>
          ) : (
            PAUSE_CHOICES.map(({ hours, label }) => (
              <button
                key={hours}
                className="btn"
                disabled={saving}
                onClick={() => update({ dndUntil: Date.now() + hours * 60 * 60_000 })}
              >
                {label}
              </button>
            ))
          )}
        </div>
      </div>

      <div className="card">
        <div className="row between">
          <div className="grow">
            <div className="title">Follow Windows Do Not Disturb</div>
            <div className="meta">
              Best if your sleep is irregular — flip Do Not Disturb in Windows whenever you turn in, and
              Everything goes quiet with it.
              {current.followWindowsDnd ? (current.windowsDnd ? ' Windows says it is on now.' : ' Windows says it is off now.') : ''}
            </div>
          </div>
          <Toggle
            on={Boolean(current.followWindowsDnd)}
            disabled={saving}
            label="Follow Windows Do Not Disturb"
            onChange={(on) => update({ followWindowsDnd: on })}
          />
        </div>
      </div>

      <div className="card">
        <div className="row between">
          <div className="grow">
            <div className="title">Quiet hours</div>
            <div className="meta">
              {current.quietHoursEnabled
                ? 'Nothing interrupts between these times, not even a deadline.'
                : 'Off — reminders can arrive at any hour.'}
            </div>
          </div>
          <Toggle
            on={Boolean(current.quietHoursEnabled)}
            disabled={saving}
            label="Quiet hours"
            onChange={(on) => update({ quietHoursEnabled: on })}
          />
        </div>

        {/* Times stay editable while off, so they're ready when it's switched on. */}
        <div className="row" style={{ marginTop: 10, opacity: current.quietHoursEnabled ? 1 : 0.5 }}>
          <input
            type="time"
            value={toTimeInput(current.quietStartMinute)}
            aria-label="Quiet hours start"
            onChange={(e) => update({ quietStartMinute: fromTimeInput(e.target.value) })}
          />
          <span className="meta">to</span>
          <input
            type="time"
            value={toTimeInput(current.quietEndMinute)}
            aria-label="Quiet hours end"
            onChange={(e) => update({ quietEndMinute: fromTimeInput(e.target.value) })}
          />
        </div>
      </div>
    </section>
  );
}

function Toggle({
  on,
  label,
  disabled,
  onChange,
}: {
  on: boolean;
  label: string;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      className={`toggle${on ? ' on' : ''}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <span className="knob" />
    </button>
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
  const info = useAsync(() => api.connectInfo());
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
        <li>
          <strong>Make sure Tailscale is on both devices.</strong>
          <div className="meta">It's what lets your phone reach this PC from anywhere. Free for personal use.</div>
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
