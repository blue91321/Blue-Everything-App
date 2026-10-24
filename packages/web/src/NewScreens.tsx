/**
 * After an update brings a screen this copy has never offered: asked once,
 * "show these?", for a person who hand-picked what's on.
 *
 * Only for a hand-picked list (`preset: 'custom'`). "Everything" takes in a new
 * screen by itself, since it is the empty list meaning all, and "just the
 * manga" means only manga, so neither is asked. A screen is new when it is not
 * in `known`, the screens there were when the list was last chosen or answered;
 * both buttons record the current ones, so each screen is asked about once.
 * Leaving one out hides it, as onboarding does: Settings → General → Go through
 * setup again brings the whole choice back.
 */
import { useEffect, useState } from 'react';
import { api } from './api';
import type { OnboardingScreen } from './Onboarding';

export function NewScreens({
  every,
  shown,
  known,
  onDone,
}: {
  /** Every screen this copy has now, but Home and Settings. */
  every: OnboardingScreen[];
  shown: string[];
  /** Null on a copy that chose before this was recorded: taken as today's list, without asking. */
  known: string[] | null;
  onDone: () => void;
}) {
  const fresh = known === null ? [] : every.filter((s) => !known.includes(s.id));
  const [picked, setPicked] = useState<Set<string>>(new Set(fresh.map((s) => s.id)));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const all = every.map((s) => s.id);

  // Nothing to compare with yet: today's screens are what was known.
  useEffect(() => {
    if (known === null) void api.onboarding.set({ known: all }).then(onDone, () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [known === null]);

  if (fresh.length === 0) return null;

  const answer = async (add: string[]) => {
    setBusy(true);
    setProblem('');
    try {
      await api.onboarding.set({ shown: [...new Set([...shown, ...add])], known: all });
      onDone();
    } catch (error) {
      setProblem((error as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="onboarding over-app" role="dialog" aria-modal="true" aria-labelledby="new-screens-title">
      <div className="onboarding-card card">
        <h1 id="new-screens-title">New in this version</h1>
        <p>You chose which parts of the app to show. These are new; tick the ones you want.</p>
        <div className="onboarding-picks">
          {fresh.map((s) => (
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
        <div className="row" style={{ gap: 8, marginTop: 12 }}>
          <button className="btn primary" disabled={busy || picked.size === 0} onClick={() => void answer([...picked])}>
            Show {picked.size === fresh.length && fresh.length > 1 ? 'them' : picked.size === 1 ? 'it' : 'these'}
          </button>
          <button className="btn" disabled={busy} onClick={() => void answer([])}>
            Not now
          </button>
        </div>
        <p className="meta">Settings → General → Go through setup again changes the whole list later.</p>
        {problem && <p className="banner">{problem}</p>}
      </div>
    </div>
  );
}
