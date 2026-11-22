/**
 * Chapters on other sources, on Manga → More: the chapter catalogue
 * (`server/catalogue.ts`). What it knows, the series with more chapters on
 * another source than on yours, the library check and the mapping of whole
 * sources, and its two switches.
 *
 * Asks the server again every two seconds while a check or a mapping runs, and
 * not otherwise: the card is behind a tab, and a run is minutes to hours.
 */
import { useEffect, useState } from 'react';
import { manga, type CatalogueState, type SeriesSummary } from './manga-api';

const ago = (at: number | null) => {
  if (!at) return 'never';
  const mins = Math.round((Date.now() - at) / 60_000);
  if (mins < 60) return mins <= 1 ? 'just now' : `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
};
const n = (x: number | null) => (x === null ? 'none' : Number.isInteger(x) ? String(x) : x.toFixed(1));

const PHASE: Record<CatalogueState['state']['phase'], string> = {
  starting: 'Starting',
  seeding: 'Reading what Suwayomi already has',
  naming: 'Looking up the other names each series goes by',
  searching: 'Searching each source for your series',
  counting: 'Counting chapters on each copy found',
  mapping: 'Reading whole sources',
  done: 'Done',
};

export function Catalogue({ series, onCompare }: { series: SeriesSummary[]; onCompare: (s: SeriesSummary) => void }) {
  const [data, setData] = useState<CatalogueState | null>(null);
  const [problem, setProblem] = useState('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    manga.catalogue.get().then(
      (d) => {
        if (!alive) return;
        setData(d);
        if (d.state.running) timer = setTimeout(() => setTick((t) => t + 1), 2000);
      },
      (e: Error) => alive && setProblem(e.message)
    );
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [tick]);

  if (!data) return problem ? <div className="card"><p className="banner">{problem}</p></div> : null;
  const run = data.state;
  const act = async (what: () => Promise<unknown>) => {
    setProblem('');
    try {
      await what();
      setTick((t) => t + 1);
    } catch (e) {
      setProblem((e as Error).message);
    }
  };
  const mapped = data.sources.filter((s) => s.mapped).length;
  const byId = new Map(series.map((s) => [s.id, s]));

  return (
    <div className="card manga-catalogue">
      <div className="title">Chapters on other sources</div>
      <p className="meta">
        Every source you have installed in your languages, and how many chapters each copy of your series has, kept on {''}
        this PC so it shows without asking the sites again. {data.counted} copies counted; {data.withOthers} of your {data.library} series have
        another source counted. {mapped > 0 ? `${mapped} source${mapped === 1 ? ' is' : 's are'} fully mapped and only checked daily for what is new.` : ''}
      </p>

      {run.running ? (
        <div className="manga-catalogue-run">
          <div className="row between" style={{ alignItems: 'center', gap: 8 }}>
            <span>
              {run.automatic ? 'Running by itself. ' : ''}
              {PHASE[run.phase]}
              {run.total > 0 ? `: ${run.done.toLocaleString()} of ${run.total.toLocaleString()}` : '…'}
              {run.found > 0 ? ` · ${run.found} ${run.phase === 'searching' ? 'new copies found' : 'copies found'}` : ''}
            </span>
            <button className="btn subtle" disabled={run.stopping} onClick={() => void act(manga.catalogue.stop)}>
              {run.stopping ? 'Stopping…' : 'Stop'}
            </button>
          </div>
          {run.dropped.length > 0 && <p className="meta">Left out of this run, since they kept refusing: {run.dropped.map((d) => d.source).join(', ')}.</p>}
          {run.total > 0 && <progress max={run.total} value={run.done} style={{ width: '100%' }} />}
          <p className="meta">
            Each source is asked one thing at a time, with a pause of a few seconds, so this takes a while. A site that refuses is left alone for a while
            and asked again later. Stopping keeps what it found, and the next run carries on
            {data.settings.automatic && data.automaticHere ? '; it also pauses the automatic check until tomorrow.' : '.'}
          </p>
          {run.held
            .filter((h) => h.until > Date.now())
            .map((h) => (
            <p key={h.source} className="meta">
              {h.source} is resting until {new Date(h.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}: it answered "{h.why}".
            </p>
            ))}
        </div>
      ) : (
        <>
          <div className="row wrap" style={{ gap: 8 }}>
            <button className="btn primary" onClick={() => void act(manga.catalogue.check)}>
              {data.settings.automatic && data.automaticHere ? 'Check now' : 'Check my library on every source'}
            </button>
            <button className="btn" onClick={() => void act(manga.catalogue.map)} title="Read every unmapped source's whole list now, rather than a few pages a sweep">
              Map whole sources now
            </button>
          </div>
          {data.autoPausedUntil && (
            <p className="meta">
              Stopped by hand, so the automatic check waits until {new Date(data.autoPausedUntil).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.
              Check now starts it sooner.
            </p>
          )}
          {run.dropped.length > 0 && (
            <p className="meta">
              Left out of the last run, since they kept refusing: {run.dropped.map((d) => `${d.source} (${d.why})`).join('; ')}. The next run asks them
              again, a day later.
            </p>
          )}
          {run.finishedAt && (
            <p className="meta">
              {run.problem
                ? `The last ${run.kind === 'map' ? 'mapping' : 'check'} stopped ${ago(run.finishedAt)}: ${run.problem}`
                : run.stopping
                  ? `The last ${run.kind === 'map' ? 'mapping' : 'check'} was stopped ${ago(run.finishedAt)}. What it found is kept, and the next one carries on from there.`
                  : `Last ${run.kind === 'map' ? 'mapping' : 'check'} finished ${ago(run.finishedAt)}${
                      run.kind === 'check' ? `: ${run.found} copies on other sources, ${run.ahead} series further ahead elsewhere.` : '.'
                    }`}
            </p>
          )}
        </>
      )}

      {data.automaticHere && (
        <label className="meta">
          <input type="checkbox" checked={data.settings.automatic} onChange={(e) => void act(() => manga.catalogue.settings({ automatic: e.target.checked }))} /> Check
          my library by itself, whenever something is due and Suwayomi is running. The first time takes most of a day; after that it is new series, a
          search a month and a recount a week.
        </label>
      )}
      <label className="meta">
        <input type="checkbox" checked={data.settings.nudge} onChange={(e) => void act(() => manga.catalogue.settings({ nudge: e.target.checked }))} /> Tell me when another
        source has more chapters than mine. Said once per lead, again only if it grows; never for a series on a hidden shelf.
      </label>
      <label className="meta">
        <input type="checkbox" checked={data.settings.background} onChange={(e) => void act(() => manga.catalogue.settings({ background: e.target.checked }))} /> Map
        whole sources in the background, a few pages a sweep and only while Suwayomi is already running.
      </label>

      {data.ahead.length > 0 && (
        <details className="manga-catalogue-ahead" open>
          <summary>More chapters elsewhere ({data.ahead.length})</summary>
          {data.ahead.map((a) => {
            const s = byId.get(a.id);
            return (
              <div key={a.id} className="row between manga-catalogue-row">
                <span className="grow">
                  <span className="title">{a.title}</span>
                  <span className="meta">
                    {' '}
                    · {a.best.source} up to {n(a.best.latest)}, {a.ownSource ?? 'yours'} {n(a.own)}
                    {a.others > 1 ? ` · ${a.others - 1} more ahead` : ''} · counted {ago(a.best.at)}
                    {a.best.via ? ` by ${a.best.via}'s server` : ''}
                  </span>
                </span>
                {s && (
                  <button className="btn subtle" onClick={() => onCompare(s)}>
                    Compare
                  </button>
                )}
              </div>
            );
          })}
        </details>
      )}

      {data.sources.length > 0 && (
        <details className="manga-catalogue-sources">
          <summary>Sources ({data.sources.length})</summary>
          {data.sources.map((s) => (
            <div key={s.id} className="row between manga-catalogue-row">
              <span className="grow">
                <span>{s.name}</span>
                <span className="meta">
                  {' '}
                  · {s.series.toLocaleString()} series known ·{' '}
                  {s.mapped
                    ? `mapped ${ago(s.mappedAt)}, new ones looked at ${ago(s.latestAt)}`
                    : s.mapping
                      ? `mapping, ${s.mapping.pages} pages read`
                      : s.why
                        ? `searched, not mapped: ${s.why}`
                        : 'searched'}
                </span>
              </span>
              {s.why && (
                <button className="btn subtle" onClick={() => void act(() => manga.catalogue.retry(s.id))}>
                  Try mapping again
                </button>
              )}
            </div>
          ))}
        </details>
      )}
      {problem && <p className="banner">{problem}</p>}
    </div>
  );
}
