/**
 * Where chapters come from, and whether it is running.
 *
 * Its own component because this is the one part of the screen that can be in
 * six states with six different fixes — no jar chosen, jar chosen but management
 * off, off and startable, starting, running, failed — and a card that collapsed
 * them into "not working" would be the write-only switch the Voice screen exists
 * as a warning about.
 *
 * It says plainly that Suwayomi is a separate program. The app can **start** one
 * you have downloaded; it does not ship, bundle or download it, and a card
 * implying otherwise would be a promise the package cannot keep — its extensions
 * are Android APKs and the artifact is 166MB.
 */
import { useEffect, useState } from 'react';
import { useAsync } from '@app/useAsync';
import { manga, type SourceState } from './manga-api';

const RELEASES = 'https://github.com/Suwayomi/Suwayomi-Server/releases/latest';

function managedLine(state: SourceState): { text: string; urgent: boolean } {
  if (!state.manage) return { text: 'Not managed — start Suwayomi yourself.', urgent: false };
  switch (state.managed.state) {
    case 'running':
      // The sentence has to follow the mode, or the card promises an idle stop
      // that will never come.
      return {
        text: state.mode === 'always' ? 'Running, and staying up.' : 'Running. It will stop on its own after a while unused.',
        urgent: false,
      };
    case 'starting':
      // Named rather than shown as a spinner, because a JVM is seconds and a
      // silent wait of that length reads as nothing having happened.
      return { text: 'Starting — a JVM takes a few seconds…', urgent: false };
    case 'failed':
      return { text: state.managed.problem, urgent: true };
    default:
      return {
        text:
          state.mode === 'always'
            ? 'Off — it starts shortly after the app, or press Start now.'
            : 'Off. It starts when you search or read, and stops when idle.',
        urgent: false,
      };
  }
}

export function SourceCard({ local, onExtensions }: { local: boolean; onExtensions: () => void }) {
  const state = useAsync(() => manga.source.get());
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const data = state.data;
  const url = draft ?? data?.url ?? data?.defaultUrl ?? '';

  /*
   * While it is starting, keep asking. There is no push from the server and the
   * change announcer does not fire for a process that has not written anything,
   * so without this the card would sit on "Starting…" until something unrelated
   * reloaded it.
   */
  useEffect(() => {
    if (data?.managed.state !== 'starting') return;
    const timer = setInterval(() => state.reload(), 2000);
    return () => clearInterval(timer);
  }, [data?.managed.state, state]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setProblem(null);
    try {
      await fn();
      setDraft(null);
      state.reload();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'that did not work');
    } finally {
      setBusy(false);
    }
  }

  const managed = data ? managedLine(data) : null;

  return (
    <details className="card">
      <summary>
        Where chapters come from
        {data && (
          <span className="meta">
            {' · '}
            {!data.jar && !data.configured
              ? 'not set up'
              : data.manage
                ? data.managed.state
                : data.health?.reachable
                  ? `${data.health.sources.length} sources`
                  : 'not answering'}
          </span>
        )}
      </summary>

      <p className="meta">
        MangaUpdates only knows what scanlation groups have reported, which runs behind what sites actually carry.
        Pointing this at a reader that holds your sources lets it answer with what you could open right now.
      </p>
      <p className="meta">
        Suwayomi is a separate program — its extensions are Android packages and the download is 166MB, so it cannot
        live inside this app. Download the <code>.jar</code> from{' '}
        <a href={RELEASES} target="_blank" rel="noreferrer noopener">
          its releases page
        </a>
        , then point this at it and the app will start and stop it for you.
      </p>

      {!local && <p className="meta urgent">This can only be changed from the PC running the server.</p>}
      {problem && <p className="banner">{problem}</p>}
      {state.error && <p className="banner">Could not load: {state.error.message}</p>}

      {/* ---- the jar ---- */}
      {data && (
        <>
          <label className="meta" htmlFor="manga-jar">
            Suwayomi jar
          </label>
          <div className="row">
            <input
              id="manga-jar"
              defaultValue={data.jar ?? ''}
              disabled={!local || busy}
              placeholder="C:\\…\\Suwayomi-Server-v2.3.2243.jar"
              onBlur={(e) => {
                const next = e.target.value.trim();
                if (next !== (data.jar ?? '')) void act(() => manga.source.setJar(next));
              }}
            />
          </div>

          {/*
            * Offered, never chosen for you. A guessed path that happened to be
            * wrong would start something nobody asked for — the same rule the
            * series matcher follows.
            */}
          {data.foundJars.length > 0 && (
            <p className="meta">
              Found:{' '}
              {data.foundJars.map((path) => (
                <button key={path} className="btn subtle" disabled={!local || busy} onClick={() => void act(() => manga.source.setJar(path))}>
                  {path.split(/[\\/]/).pop()}
                </button>
              ))}
            </p>
          )}

          <div className="row">
            <label className="meta">
              <input
                type="checkbox"
                checked={data.manage}
                disabled={!local || busy || !data.jar}
                onChange={(e) => void act(() => manga.source.setManage(e.target.checked))}
              />{' '}
              Let the app start and stop it
            </label>
          </div>

          {/*
            * Two named alternatives, so two buttons rather than a slider — the
            * same call the live-stream scope makes. A slider would have two
            * positions, no labels at the stops, and no way to show which is on.
            */}
          {data.manage && (
            <div className="row">
              <button
                className={data.mode === 'on-demand' ? 'btn primary' : 'btn'}
                disabled={!local || busy}
                onClick={() => void act(() => manga.source.setMode('on-demand'))}
              >
                Only when I need it
              </button>
              <button
                className={data.mode === 'always' ? 'btn primary' : 'btn'}
                disabled={!local || busy}
                onClick={() => void act(() => manga.source.setMode('always'))}
              >
                Always on
              </button>
            </div>
          )}

          {data.manage && (
            <p className="meta">
              {data.mode === 'always'
                ? 'Started shortly after the app and left running, so opening a chapter is instant. Costs a few hundred megabytes of memory all day.'
                : 'Started when you search or read, and stopped after fifteen minutes unused. Costs about six seconds the first time, and nothing the rest of the day.'}
            </p>
          )}

          {managed && <p className={managed.urgent ? 'meta urgent' : 'meta'}>{managed.text}</p>}

          {data.manage && local && (
            <div className="row">
              <button className="btn" disabled={busy || data.managed.state === 'starting'} onClick={() => void act(() => manga.source.start())}>
                {data.managed.state === 'starting' ? 'Starting…' : 'Start now'}
              </button>
              <button className="btn subtle" disabled={busy || data.managed.state !== 'running'} onClick={() => void act(() => manga.source.stop())}>
                Stop
              </button>
            </div>
          )}

          {/* ---- the address ---- */}
          <label className="meta" htmlFor="manga-url">
            Address
          </label>
          <div className="row">
            <input
              id="manga-url"
              value={url}
              disabled={!local || busy}
              placeholder={data.defaultUrl}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button className="btn primary" disabled={!local || busy || !url.trim()} onClick={() => void act(() => manga.source.set(url.trim()))}>
              Save
            </button>
            {data.configured && (
              <button className="btn subtle" disabled={!local || busy} onClick={() => void act(() => manga.source.set(''))}>
                Clear
              </button>
            )}
          </div>

          {data.health && !data.health.reachable && <p className="meta urgent">{data.health.problem}</p>}

          {/*
            * Running with nothing installed is its own state and its own fix. It
            * looks identical to "broken" from a chapter count that never moves,
            * so it is named rather than left to be worked out.
            */}
          {data.health?.reachable && data.health.sources.length === 0 && (
            <p className="meta urgent">
              It is answering, but has no sources installed — add an extension repository in Suwayomi first.
            </p>
          )}
          {data.health?.reachable && data.health.sources.length > 0 && (
            <p className="meta">Searching: {data.health.sources.slice(0, 6).join(', ')}</p>
          )}

          {/*
            * Always offered, not only once something is reachable: the screen it
            * opens is where you go *because* nothing is installed, and hiding it
            * until things work would hide it exactly when it is needed.
            */}
          <div className="row">
            <button className="btn" onClick={onExtensions}>
              Manage extensions
            </button>
          </div>
        </>
      )}
    </details>
  );
}
