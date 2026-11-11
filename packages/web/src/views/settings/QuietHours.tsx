/**
 * Going quiet: Windows' Do Not Disturb, a pause, or set hours. See
 * `quietReason` in shared for the one decision all three feed.
 */
import { useState } from 'react';
import { api } from '../../api';
import { useAsync } from '../../useAsync';
import { Toggle } from '../../controls';
import { clockTime } from '../../format';
import { SoundTones } from './Sounds';

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
export function QuietHours() {
  const settings = useAsync(() => api.settings.get(), [], ['settings']);
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
    <section id="reminders">
      <h2>Reminders</h2>

      <div className="card">
        <div className="row between">
          <div className="grow">
            <div className="title">{current.quietNow ? 'Silent right now' : 'Active'}</div>
            <div className="meta">
              {current.quietNow
                ? QUIET_EXPLANATION[current.quietReason ?? ''] ?? 'Something is holding reminders.'
                : "Held while you're in a game, unless Games lets that one interrupt, and sent to your phone instead while you're away from the desk, if phone nudges are on."}
            </div>
          </div>
          <button className="btn" disabled={saving} onClick={() => update({ remindersEnabled: !current.remindersEnabled })}>
            {current.remindersEnabled ? 'Turn all off' : 'Turn on'}
          </button>
        </div>
      </div>

      {/* Absent on a server older than the column — see AppSettings. */}
      {current.soundEnabled !== undefined && (
        <div className="card">
          <div className="row between">
            <div className="grow">
              <div className="title">Play a sound</div>
              <div className="meta">
                A short tone with each popup — one for a nudge, and for voice, one when it starts
                listening and another when it did or didn't catch you. A nudge that quiet hours are
                holding makes no sound because it never arrives; a voice reply still will, since you
                asked for it.
              </div>
            </div>
            <Toggle
              on={Boolean(current.soundEnabled)}
              disabled={saving}
              label="Play a sound with popups"
              onChange={(on) => update({ soundEnabled: on })}
            />
          </div>

          {/* Only when there is something to hear. A row of tone pickers above
              a switch that is off is four controls for a thing that cannot
              happen. */}
          {Boolean(current.soundEnabled) && (
            <SoundTones current={current} saving={saving} update={update} />
          )}
        </div>
      )}

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
