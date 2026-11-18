/**
 * The one question the calendar asks: remind you before events? Put during
 * onboarding (`onboarding.tsx`), or, for somebody who updated into the
 * calendar after onboarding, the first time it is opened. Yes is the default
 * answer, as asked; when to be reminded is then set per event.
 */
import { useState } from 'react';
import { calendar } from './calendar-api';

export function ReminderQuestion({ onDone, heading = 'h2' }: { onDone: () => void; heading?: 'h1' | 'h2' }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const answer = async (enabled: boolean) => {
    setBusy(true);
    setProblem('');
    try {
      await calendar.setReminders({ asked: true, enabled });
      onDone();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const Heading = heading;
  return (
    <>
      <Heading>Remind you before events?</Heading>
      <p>
        A reminder before each event: 15 minutes before one at a time, and 9:00 on the day for an all-day one. Change when for any event, or switch them off, whenever you like.
      </p>
      <p className="meta">Like every reminder here it waits for a good moment and holds back during a game, until a few minutes before the event starts.</p>
      <div className="row wrap" style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={busy} onClick={() => void answer(true)}>
          Yes, remind me
        </button>
        <button className="btn" disabled={busy} onClick={() => void answer(false)}>
          No reminders
        </button>
      </div>
      {problem && <p className="banner">{problem}</p>}
    </>
  );
}
