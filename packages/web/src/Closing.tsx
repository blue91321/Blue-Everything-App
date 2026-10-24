/**
 * "When you close the app": keep running in the background, or stop. One
 * component for Settings → General and onboarding's step, so the two cannot
 * describe the choice differently. See `closing.ts` on the server for the rule,
 * and the agent's `closing.ts` for what happens at the moment it closes.
 *
 * It says what is at stake, live: what needs the background right now, which
 * is what "close everything" would stop, and that with nothing needing it the
 * app closes with the window whichever is chosen.
 */
import { useState } from 'react';
import { api } from './api';
import { useAsync } from './useAsync';

const list = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

export function ClosingChoice({ local }: { local: boolean }) {
  // On the PC that runs it, closing stops the server too; anywhere else it is
  // the desktop app's, which only matters on a PC that has it.
  const side = local ? 'host' : 'desktop';
  const info = useAsync(() => api.closing.get(side), [side], ['settings', 'habits', 'tasks', 'devices']);
  const [problem, setProblem] = useState('');
  const mode = info.data?.mode ?? 'keep';
  const keeps = info.data?.keeps ?? [];

  const choose = async (next: 'keep' | 'quit') => {
    setProblem('');
    try {
      await api.closing.set(next);
      info.reload();
    } catch (error) {
      setProblem((error as Error).message);
    }
  };

  return (
    <div className="closing-choice">
      {!local && (
        <p className="meta">
          This is about Blue Everything Desktop on a Windows PC. In a browser or on a phone, closing the app just closes it.
        </p>
      )}
      <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
        <input type="radio" name="closing" checked={mode === 'keep'} onChange={() => void choose('keep')} />
        <span>
          <strong>Keep running in the background</strong>
          <span className="meta" style={{ display: 'block' }}>
            An icon under ^ on the taskbar, like Discord or Steam. Right-click it to stop.
          </span>
        </span>
      </label>
      <label className="row" style={{ gap: 8, alignItems: 'flex-start', marginTop: 6 }}>
        <input type="radio" name="closing" checked={mode === 'quit'} onChange={() => void choose('quit')} />
        <span>
          <strong>Close everything with the window</strong>
          <span className="meta" style={{ display: 'block' }}>
            {local
              ? 'Nothing keeps running once the window is closed, the server included.'
              : 'The desktop app stops when its window is closed.'}
          </span>
        </span>
      </label>
      <p className="meta" style={{ marginTop: 8 }}>
        {info.loading
          ? 'Checking what needs it…'
          : keeps.length === 0
            ? 'Nothing needs it running in the background right now, so it closes with the window either way.'
            : mode === 'quit'
              ? `Closing will stop ${list(keeps)} until you open it again.`
              : `Running in the background keeps ${list(keeps)} working.`}
      </p>
      {problem && <p className="banner">{problem}</p>}
    </div>
  );
}
