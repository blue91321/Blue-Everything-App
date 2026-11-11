/**
 * What a series' page says when its source is failing, and the button that
 * fixes it. Asked for on 2026-11-09, when MangaHub shut apps out: a warning
 * when it applies, what will happen if the source does not come back in two
 * days, and a way to find a new source without going through the comparison.
 *
 * Three cases, said differently because they mean different things:
 * - **Gone** (a 404, "no chapters"): the site has taken it down, and it will
 *   not come back by waiting.
 * - **Not answering**: it may come back; if it has not after two days of
 *   failing, it is switched automatically (when that is on, More).
 * - **Switched already**: which source it came from, when and why, for two
 *   weeks after, so a switch is never a mystery.
 *
 * The button is `switchNow` on the server: the same rules as the automatic
 * switch (the same title, another source, chapters there, as far as you have
 * read if one does), only now.
 */
import { useState } from 'react';
import { manga, type SeriesSummary } from './manga-api';
import { goneFromSource, sourceLabel, switchDueAt } from './shelf';

const DAY = 24 * 60 * 60_000;

/** "Monday 14:30", or "today 14:30" and "tomorrow 09:00" when it is near. */
function whenSaid(at: number, now: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days === -1) return `yesterday at ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })} at ${time}`;
}

export function SourceTrouble({
  series,
  autoSwitch,
  onSwitched,
  onCompare,
}: {
  series: SeriesSummary;
  /** Whether switching after two days is on (More). Undefined from an older server, which never switches. */
  autoSwitch: boolean | undefined;
  /** It has a new source: the chapter list and the library want reloading. */
  onSwitched: () => void;
  /** Choose one by hand, across every source. */
  onCompare: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; good: boolean } | null>(null);
  const now = Date.now();
  const source = series.source ? sourceLabel(series.source.sourceName) : null;
  const switched = series.switchedFrom && now - series.switchedFrom.at < 14 * DAY ? series.switchedFrom : null;

  const find = async () => {
    setBusy(true);
    setSaid(null);
    try {
      const { outcome } = await manga.switchSource(series.id);
      if (outcome.kind === 'switched') {
        setSaid({ text: `Switched from ${sourceLabel(outcome.from)} to ${sourceLabel(outcome.to)}, which has ${outcome.chapters} chapters. What you have read is kept.`, good: true });
        onSwitched();
      } else if (outcome.kind === 'notFound') {
        setSaid({ text: `None of your other sources has it under the same name. "Choose one" lists every source's results, to pick by hand.`, good: false });
      } else if (outcome.kind === 'failed') {
        setSaid({ text: `The sources could not be searched: ${outcome.problem}.`, good: false });
      } else {
        setSaid({ text: 'It was changed meanwhile, so nothing was switched.', good: false });
      }
    } catch (error) {
      setSaid({ text: (error as Error).message, good: false });
    } finally {
      setBusy(false);
    }
  };

  const failing = Boolean(series.source && series.error);
  if (!failing && !switched && !said) return null;

  const gone = goneFromSource(series.error);
  const since = typeof series.failingSince === 'number' ? series.failingSince : null;
  const due = switchDueAt({ source: series.source, error: series.error, failingSince: since, switchTriedAt: series.switchTriedAt ?? null }, autoSwitch === true);

  return (
    <div className={`manga-trouble${failing ? ' warn' : ''}`} role={failing ? 'alert' : undefined}>
      {failing && (
        <>
          <strong>
            {gone ? `${source} no longer has this series` : `${source} is not answering`}
            {since ? ` (since ${whenSaid(since, now)})` : ''}
          </strong>
          <span className="meta">
            {gone
              ? /\b404\b/.test(series.error!)
                ? 'The site has taken the page down, so it will not come back by waiting. '
                : 'The source answers that it has no chapters for it: usually taken down, or the wrong entry linked. '
              : `It answered "${series.error!.replace(/ — showing MangaUpdates for now$/, '')}". It is asked again within the hour, and new chapters will not show until it answers. `}
            {due === null
              ? autoSwitch === false
                ? 'Switching sources automatically is off (More), so it stays here until you change it.'
                : ''
              : typeof series.switchTriedAt === 'number' && series.switchTriedAt >= (since ?? 0)
                ? `It was due to switch, but none of your other sources had it under the same name on ${whenSaid(series.switchTriedAt, now)}; they are asked again ${due <= now ? 'at the next check' : whenSaid(due, now)}.`
                : due <= now
                  ? `It has failed for two days, so it will be switched to another of your sources that has it, keeping what you have read, at the next check (every half hour, while manga is running).`
                  : `If it is still failing ${whenSaid(due, now)}, it will be switched automatically to another of your sources that has it under the same name, keeping what you have read and where you are.`}
          </span>
          <span className="manga-trouble-actions">
            <button className="btn primary" disabled={busy} onClick={() => void find()}>
              {busy ? 'Searching your sources…' : 'Find a new source now'}
            </button>
            <button className="btn subtle" disabled={busy} onClick={onCompare}>
              Choose one
            </button>
          </span>
          {busy && <span className="meta">About fifteen seconds: each source is searched, and the best few asked for their chapters.</span>}
        </>
      )}
      {!failing && switched && !said && (
        <span className="meta">
          Switched from {sourceLabel(switched.sourceName)} {whenSaid(switched.at, now)}: {switched.why}.{' '}
          {switched.automatic ? 'Done automatically; what you had read carried over.' : 'What you had read carried over.'}
        </span>
      )}
      {said && <span className={`meta${said.good ? '' : ' urgent'}`}>{said.text}</span>}
    </div>
  );
}
