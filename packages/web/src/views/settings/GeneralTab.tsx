/**
 * Settings → General: your name, setup, the look, the menu and the Dashboard.
 *
 * The parts are each in their own file beside this one; this file only lays
 * them out in order.
 */
import { ClosingChoice } from '../../Closing';
import { useState } from 'react';
import { api } from '../../api';
import { Appearance } from './Appearance';
import { DashboardBlocks, DashboardPanel, DashboardRefresh } from './Dashboard';
import { MenuAndHome, MenuDrawer } from './Menu';

/**
 * Onboarding again: install, what's on, notifications. It opens at once, over
 * everything, on every device of this copy (`onboarding.ts`).
 */
/** The display name friends on this PC see. See `names.ts` on the server. */
function YourName({ initial, fallback }: { initial: string | null; fallback: string }) {
  const [value, setValue] = useState(initial ?? '');
  const [note, setNote] = useState('');
  const changed = value.trim() !== (initial ?? '');
  const save = () => {
    setNote('');
    api.profile.setName(value.trim() || null).then(
      () => {
        setNote('Saved.');
        window.dispatchEvent(new Event('everything:session-changed'));
      },
      (e: unknown) => setNote(e instanceof Error ? e.message : 'that did not save')
    );
  };
  return (
    <section>
      <div className="card">
        <div className="title">Your name</div>
        <div className="meta">
          What friends who share this Blue Everything see beside what you ask for, rate and keep. Left empty, you're {fallback}.
        </div>
        <form
          className="row"
          style={{ gap: 8, marginTop: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <input className="grow" maxLength={40} value={value} onChange={(e) => setValue(e.target.value)} placeholder={fallback} aria-label="Your name" />
          <button className="btn" type="submit" disabled={!changed}>
            Save
          </button>
        </form>
        {note && <p className="meta">{note}</p>}
      </div>
    </section>
  );
}

function SetupAgain() {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  return (
    <section>
      <div className="card">
        <div className="row between" style={{ alignItems: 'center' }}>
          <div className="grow">
            <div className="title">Set up</div>
            <div className="meta">Go through the first-run steps again: your name, installing, what's on, and notifications.</div>
          </div>
          <button
            className="btn"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setProblem('');
              api.onboarding.set({ done: false }).then(
                () => window.dispatchEvent(new Event('everything:session-changed')),
                (e: unknown) => {
                  setProblem(e instanceof Error ? e.message : 'that did not work');
                  setBusy(false);
                }
              );
            }}
          >
            {busy ? 'Opening…' : 'Go through setup again'}
          </button>
        </div>
        {problem && <p className="banner">{problem}</p>}
      </div>
    </section>
  );
}

export function GeneralTab({ name, fallback, local }: { name: string | null; fallback: string; local: boolean }) {
  return (
    <>
      <YourName initial={name} fallback={fallback} />
      <section>
        <div className="card">
          <div className="title">When you close the app</div>
          <ClosingChoice local={local} />
        </div>
      </section>
      <SetupAgain />
      <Appearance />
      <MenuDrawer />
      <MenuAndHome />
      {/*
        The two columns of the Dashboard, shown as two columns.
        They were stacked, which made the screen read as two unrelated settings
        rather than as the two halves of one layout — and the second was below
        the fold on a laptop. Side by side, "On the Dashboard" and "Beside the
        Dashboard" say what they are by sitting where they sit.

        A container query, not a media one: what decides whether two columns fit
        is the width of this screen, which the docked menu changes without the
        window moving at all. Asking the viewport would keep two columns while
        the drawer squeezed them — the same mistake the notes screen made and
        the same fix.
      */}
      <DashboardRefresh />
      <div className="settings-pair-wrap">
        <div className="settings-pair">
          <DashboardBlocks />
          <DashboardPanel />
        </div>
      </div>
      <section>
        <h2>This app</h2>
        <div className="card">
          <div className="meta">
            Everything here is stored on the server, so the phone and the desktop always
            agree. Nothing is sent anywhere else.
          </div>
        </div>
      </section>
    </>
  );
}
