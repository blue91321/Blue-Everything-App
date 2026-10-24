/**
 * First run, for a new person: their name, install the app, pick what's on,
 * then notifications and quiet hours, last.
 *
 * **The name comes first** because everything after it is about this person,
 * and friends on this PC see it beside what they ask for, rate and keep. It is
 * a display name, kept per copy (`names.ts`): the copy's own name stays what it
 * was made as.
 *
 * Shown over everything until finished, on any copy whose onboarding is not
 * done (a friend's new copy starts that way; yours starts done, having been set
 * up before this existed). **Settings → General → Go through setup again**
 * starts it over. The answers are kept on the server (`onboarding.ts`), so
 * every device of one person agrees, and finishing on the phone finishes it.
 *
 * **Notifications are last on purpose**, as asked: by then the app is
 * installed, which on an iPhone is the only place push works, and the person
 * has said what they use it for, so the question means something.
 */
import { useEffect, useState } from 'react';
import { api, setToken, type AppSettings } from './api';
import { isAndroid, isInstalled, isIOS, isMobile } from './device';
import { checkPushSupport, enablePush } from './push';
import { featureEnabled } from './features';
import { ClosingChoice } from './Closing';

export interface OnboardingScreen {
  id: string;
  label: string;
  glyph: string;
}

type Step = 'name' | 'install' | 'parts' | 'closing' | 'notify';

/** Not installed on a phone, where installing is what makes it an app (and, on an iPhone, what push needs). */
const wantsInstall = () => (isIOS() || isAndroid()) && !isInstalled();

const toTime = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const fromTime = (value: string) => {
  const [h, m] = value.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export function Onboarding({
  screens,
  shown,
  name,
  defaultName,
  local,
  onDone,
}: {
  /** Every screen this copy has, but Home and Settings, in menu order. */
  screens: OnboardingScreen[];
  /** What it shows now: null for everything. */
  shown: string[] | null;
  /** The display name so far, if one was chosen before. */
  name: string | null;
  /** What they are called if they skip it: the name the host gave this copy, or "user". */
  defaultName: string;
  /** On the PC that runs the server, where closing the app stops the server too. */
  local: boolean;
  /** Finished: the first screen it shows is opened. */
  onDone: (shown: string[] | null) => void;
}) {
  // Closing is asked on a computer only: on a phone, closing the app just closes it.
  const steps: Step[] = [
    'name',
    ...(wantsInstall() ? (['install'] as const) : []),
    'parts',
    ...(isMobile() ? [] : (['closing'] as const)),
    'notify',
  ];
  const [step, setStep] = useState<Step>('name');
  const after = (s: Step) => steps[steps.indexOf(s) + 1] ?? 'notify';
  const [chosen, setChosen] = useState<string[] | null>(shown);
  const [problem, setProblem] = useState('');

  const save = async (patch: { done?: boolean; shown?: string[] | null; preset?: 'manga' | 'everything' | 'custom'; known?: string[] }) => {
    setProblem('');
    try {
      await api.onboarding.set(patch);
      return true;
    } catch (error) {
      setProblem((error as Error).message);
      return false;
    }
  };

  const finish = async () => {
    if (await save({ done: true })) onDone(chosen);
  };

  return (
    <div className="onboarding">
      <div className="onboarding-card card">
        <p className="meta">
          {step === 'notify' ? 'Last step' : `Step ${steps.indexOf(step) + 1} of ${steps.length}`}
        </p>
        {step === 'name' && <Name initial={name} fallback={defaultName} onNext={() => setStep(after('name'))} />}
        {step === 'install' && <Install onNext={() => setStep(after('install'))} />}
        {step === 'parts' && (
          <Parts
            screens={screens}
            chosen={chosen}
            onChoose={async (next, preset) => {
              setChosen(next);
              // What was on offer is recorded, so a screen an update adds can be asked about.
              if (await save({ shown: next, preset, known: screens.map((s) => s.id) })) setStep(after('parts'));
            }}
          />
        )}
        {step === 'closing' && (
          <>
            <h1>When you close the app</h1>
            <p>Some apps keep running after their window closes, so they can still remind you. Choose which you want.</p>
            <ClosingChoice local={local} />
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn primary" onClick={() => setStep(after('closing'))}>
                Next
              </button>
            </div>
          </>
        )}
        {step === 'notify' && <Notify onFinish={() => void finish()} />}
        {problem && <p className="banner">{problem}</p>}
      </div>
    </div>
  );
}

/* ---- 1. Name ---- */

function Name({ initial, fallback, onNext }: { initial: string | null; fallback: string; onNext: () => void }) {
  const [value, setValue] = useState(initial ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const next = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem('');
    try {
      await api.profile.setName(value.trim());
      onNext();
    } catch (error) {
      setProblem((error as Error).message);
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(e) => void next(e)}>
      <h1>What should people call you?</h1>
      <p>
        Friends who share this Blue Everything see it beside what you ask for, rate, and keep. Skip it and you're <strong>{fallback}</strong>;
        you can change it in Settings.
      </p>
      <input
        autoFocus
        maxLength={40}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={fallback}
        aria-label="Your name"
      />
      <div className="row" style={{ marginTop: 12, gap: 8 }}>
        <button className="btn primary" type="submit" disabled={busy || value.trim() === ''}>
          {busy ? 'Saving…' : 'Next'}
        </button>
        <button className="btn" type="button" disabled={busy} onClick={onNext}>
          Skip
        </button>
      </div>
      {problem && <p className="banner">{problem}</p>}
    </form>
  );
}

/* ---- 2. Install ---- */

function Install({ onNext }: { onNext: () => void }) {
  /*
   * An app added to the Home Screen keeps its own storage, apart from the
   * browser's, so it opens signed out. A short code typed into it signs it in.
   */
  const [handoff, setHandoff] = useState<{ code: string; expiresAt: number } | null>(null);
  const [problem, setProblem] = useState('');
  useEffect(() => {
    api.devices.handoff().then(setHandoff, (e: unknown) => setProblem(e instanceof Error ? e.message : 'no code'));
  }, []);

  return (
    <>
      <h1>Put it on your Home Screen</h1>
      <p>So it opens like an app, full screen, and can send you notifications.</p>
      {isIOS() ? (
        <ol>
          <li>
            Tap <strong>Share</strong> at the bottom of Safari (the square with the arrow).
          </li>
          <li>
            Choose <strong>Add to Home Screen</strong>, then <strong>Add</strong>.
          </li>
          <li>Open it from the Home Screen, and type the code below when it asks.</li>
        </ol>
      ) : (
        <ol>
          <li>
            Open the browser's menu (the three dots) and choose <strong>Install app</strong> or{' '}
            <strong>Add to Home screen</strong>.
          </li>
          <li>Open it from the Home Screen, and type the code below if it asks.</li>
        </ol>
      )}
      {handoff ? (
        <p className="onboarding-code" aria-label="Sign-in code">
          {handoff.code}
        </p>
      ) : (
        <p className="meta">{problem ? `Could not make a code: ${problem}` : 'Making a code…'}</p>
      )}
      {handoff && (
        <p className="meta">
          Works once, for ten minutes. Setup carries on in the installed app from the next step.
        </p>
      )}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="btn subtle" onClick={onNext}>
          Skip, use it here
        </button>
      </div>
    </>
  );
}

/* ---- 2. What's on ---- */

function Parts({
  screens,
  chosen,
  onChoose,
}: {
  screens: OnboardingScreen[];
  chosen: string[] | null;
  onChoose: (shown: string[] | null, preset: 'manga' | 'everything' | 'custom') => void;
}) {
  const hasManga = screens.some((s) => s.id === 'manga');
  const [custom, setCustom] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set(chosen ?? screens.map((s) => s.id)));

  return (
    <>
      <h1>What do you want it for?</h1>
      <p>You can change this later in Settings, and set it up again from there.</p>
      <div className="onboarding-choices">
        {hasManga && (
          <button className="onboarding-choice" onClick={() => onChoose(['manga'], 'manga')}>
            <strong>📖 Just the manga</strong>
            <span className="meta">Only Manga and Settings: a reader, your library and new chapters.</span>
          </button>
        )}
        <button className="onboarding-choice" onClick={() => onChoose(null, 'everything')}>
          <strong>Everything</strong>
          <span className="meta">Tasks, habits, notes and every part this copy has.</span>
        </button>
        <button className={`onboarding-choice${custom ? ' on' : ''}`} onClick={() => setCustom((c) => !c)}>
          <strong>Choose</strong>
          <span className="meta">Pick the parts yourself.</span>
        </button>
      </div>
      {custom && (
        <>
          <div className="onboarding-picks">
            {screens.map((s) => (
              <label key={s.id} className="row" style={{ gap: 8 }}>
                <input
                  type="checkbox"
                  checked={picked.has(s.id)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(s.id);
                    else next.delete(s.id);
                    setPicked(next);
                  }}
                />
                <span>
                  {s.glyph} {s.label}
                </span>
              </label>
            ))}
          </div>
          <button
            className="btn primary"
            disabled={picked.size === 0}
            onClick={() =>
              picked.size === screens.length
                ? onChoose(null, 'everything')
                : onChoose(screens.map((s) => s.id).filter((id) => picked.has(id)), 'custom')
            }
          >
            Use these
          </button>
        </>
      )}
      <p className="meta">Settings is always there. Parts you leave out are hidden, not deleted.</p>
    </>
  );
}

/* ---- 3. Notifications and quiet hours ---- */

function Notify({ onFinish }: { onFinish: () => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [on, setOn] = useState(false);
  const support = checkPushSupport();
  const pushHere = featureEnabled('push');

  useEffect(() => {
    api.settings.get().then(setSettings, () => undefined);
  }, []);

  type Change = Parameters<typeof api.settings.update>[0];
  /** Shown at once, saved after. The row holds 0 or 1 where the change sends a boolean. */
  const update = async (change: Change, shown: Partial<AppSettings>) => {
    setSettings((s) => (s ? { ...s, ...shown } : s));
    try {
      await api.settings.update(change);
    } catch (error) {
      setMessage((error as Error).message);
    }
  };

  const allow = async () => {
    if (!settings) return;
    setBusy(true);
    try {
      const result = await enablePush(settings.vapidPublicKey);
      setMessage(result.message);
      setOn(result.ok);
      if (result.ok) await update({ pushEnabled: true }, { pushEnabled: 1 });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not turn notifications on.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>Notifications</h1>
      <p>New chapters, and anything you ask to be reminded of, sent to this device.</p>
      {!pushHere ? (
        <p className="meta">Notifications are switched off on this copy.</p>
      ) : !support.supported ? (
        <p className="meta">{support.reason}</p>
      ) : (
        <button className="btn primary" disabled={busy || on || !settings} onClick={() => void allow()}>
          {on ? 'Notifications on' : busy ? 'Asking…' : 'Allow notifications'}
        </button>
      )}
      {message && <p className="meta">{message}</p>}

      {settings && (
        <>
          <h3>Quiet hours</h3>
          <label className="row" style={{ gap: 8 }}>
            <input
              type="checkbox"
              checked={Boolean(settings.quietHoursEnabled)}
              onChange={(e) => void update({ quietHoursEnabled: e.target.checked }, { quietHoursEnabled: e.target.checked ? 1 : 0 })}
            />
            <span>Nothing between</span>
          </label>
          <div className="row" style={{ gap: 8, opacity: settings.quietHoursEnabled ? 1 : 0.5 }}>
            <input
              type="time"
              value={toTime(settings.quietStartMinute)}
              disabled={!settings.quietHoursEnabled}
              onChange={(e) => void update({ quietStartMinute: fromTime(e.target.value) }, { quietStartMinute: fromTime(e.target.value) })}
              aria-label="Quiet from"
            />
            <span>and</span>
            <input
              type="time"
              value={toTime(settings.quietEndMinute)}
              disabled={!settings.quietHoursEnabled}
              onChange={(e) => void update({ quietEndMinute: fromTime(e.target.value) }, { quietEndMinute: fromTime(e.target.value) })}
              aria-label="Quiet until"
            />
          </div>
        </>
      )}

      <button className="btn primary" onClick={onFinish} style={{ marginTop: 16 }}>
        Done
      </button>
    </>
  );
}

/**
 * A typed hand-off code, for the installed app's first screen: swapped for a
 * token as a sign-in link's code is. Returns what went wrong, or null.
 */
export async function redeemTypedCode(code: string): Promise<string | null> {
  try {
    const response = await fetch('/api/invite/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        kind: isIOS() || isAndroid() ? 'phone' : 'browser',
        name: isIOS() || isAndroid() ? 'Phone (installed app)' : 'Browser',
      }),
    });
    const body = (await response.json().catch(() => null)) as { token?: string; error?: string } | null;
    if (!response.ok || !body?.token) return body?.error ?? `that code did not work (${response.status})`;
    setToken(body.token);
    return null;
  } catch {
    return 'could not reach the server';
  }
}
