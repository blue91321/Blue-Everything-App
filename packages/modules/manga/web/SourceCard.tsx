/**
 * Where chapters come from: setting it up, whether it is running, and why not.
 *
 * ### Setting up is one button
 *
 * It was "download the `.jar` from its releases page, then point this at it",
 * and the first person to follow that on another PC failed twice: their Java was
 * too old for the jar, and then they chose the `.msi` from a page of nine
 * downloads. So **Set up manga** fetches Java and Suwayomi into the app's own
 * folder, switches it on, starts it and adds the extension list — see
 * `server/setup.ts`. Pointing at a Suwayomi you already have is still here,
 * folded under "Use a Suwayomi you already have".
 *
 * The card opens itself while anything needs doing, and the Manga screen's
 * other tabs carry a banner that brings you here, so "where do I click" is never
 * a question.
 *
 * ### A failure says what to do, and the log is a click away
 *
 * The server turns the failures that happen in practice into a sentence with a
 * fix (`explainFailure`). Anything else ends in "the log below says why", and
 * **See the log** shows its end in the card — from the phone as well — with
 * **Open in Notepad** on the PC for the whole thing. A path to go and find was
 * the previous answer.
 */
import { useEffect, useRef, useState } from 'react';
import { useAsync } from '@app/useAsync';
import { manga, type SetupState, type SourceState } from './manga-api';

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
      return { text: 'Starting — this takes a few seconds (a minute the first time)…', urgent: false };
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

/** Nothing to run yet: no jar, and no Suwayomi of your own to point at. */
export const needsSetup = (s: SourceState) => !s.jar && !s.configured;
/**
 * Set up, and failing to start — or pointed at an address where nothing answers,
 * with no Suwayomi of the app's own to fall back on.
 */
export const failing = (s: SourceState) =>
  (s.manage && s.managed.state === 'failed') || (!s.jar && s.configured && s.health !== null && !s.health.reachable);

const mb = (bytes: number) => `${Math.round(bytes / 1048576)} MB`;

export function SourceCard({
  local,
  onExtensions,
  onOpenUi,
  focus = 0,
}: {
  local: boolean;
  onExtensions: () => void;
  onOpenUi: () => void;
  /** Bumped by the screen's "Set up manga" banner: open this card and bring it into view. */
  focus?: number;
}) {
  const state = useAsync(() => manga.source.get());
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [log, setLog] = useState<string[] | null>(null);
  const [open, setOpen] = useState(false);
  const card = useRef<HTMLDetailsElement>(null);

  const data = state.data;
  const url = draft ?? data?.url ?? data?.defaultUrl ?? '';
  const attention = data ? needsSetup(data) || failing(data) : false;

  // Open by itself while something needs doing; left as you set it otherwise.
  useEffect(() => {
    if (attention) setOpen(true);
  }, [attention]);

  // Sent here by the banner on another tab.
  useEffect(() => {
    if (focus === 0) return;
    setOpen(true);
    // After the open has rendered. A timeout rather than a frame, which does
    // not fire in a window nobody is drawing.
    // Instant: a smooth scroll is an animation, and does not run in a window nobody is drawing.
    const timer = setTimeout(() => card.current?.scrollIntoView({ block: 'start' }), 50);
    return () => clearTimeout(timer);
  }, [focus]);

  // A setup already running when the card mounts is picked up, not restarted.
  useEffect(() => {
    void manga.source.setupState().then(setSetup, () => undefined);
  }, []);

  // While setting up, follow it; when it finishes, reload what the card shows.
  useEffect(() => {
    if (!setup?.running) return;
    const timer = setInterval(() => {
      void manga.source.setupState().then((next) => {
        setSetup(next);
        if (!next.running) state.reload();
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [setup?.running, state]);

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

  async function runSetup() {
    setProblem(null);
    setLog(null);
    try {
      setSetup(await manga.source.setup());
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'setup could not start');
    }
  }

  async function showLog() {
    try {
      const got = await manga.source.log();
      setLog(got.lines.length > 0 ? got.lines : ['(the log is empty — Suwayomi has not been started yet)']);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'could not read the log');
    }
  }

  const managed = data ? managedLine(data) : null;
  const settingUp = setup?.running === true;
  const failed = (data && failing(data)) || Boolean(setup?.problem);

  return (
    <details
      className="card manga-source-card"
      id="manga-setup"
      ref={card}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        Where chapters come from
        {data && (
          <span className={attention ? 'meta urgent' : 'meta'}>
            {' · '}
            {settingUp
              ? 'setting up…'
              : needsSetup(data)
                ? 'not set up — open this'
                : data.manage
                  ? data.managed.state === 'failed'
                    ? 'not starting — open this'
                    : data.managed.state
                  : data.health?.reachable
                    ? `${data.health.sources.length} sources`
                    : 'not answering'}
          </span>
        )}
      </summary>

      {problem && <p className="banner">{problem}</p>}
      {state.error && <p className="banner">Could not load: {state.error.message}</p>}

      {/* ---- setting up ---- */}
      {data && (needsSetup(data) || failing(data) || settingUp || setup?.problem) && (
        <div className="manga-setup">
          <h3>{needsSetup(data) ? 'Set up manga' : 'Set it up again'}</h3>
          <p className="meta">
            Chapters come from <strong>Suwayomi</strong>, a free program the app runs for you in the background. This
            downloads it and the Java it needs — about 210 MB, once — into the app's own folder. Nothing else is
            installed on the PC, and the Java already on it (if any) is left alone.
          </p>
          {!local ? (
            <p className="meta urgent">This has to be done on the PC running Blue Everything.</p>
          ) : settingUp ? (
            <div>
              <p>{setup!.step}…</p>
              {setup!.total ? (
                <>
                  <progress max={setup!.total} value={setup!.received} />
                  <p className="meta">
                    {mb(setup!.received)} of {mb(setup!.total)}
                  </p>
                </>
              ) : (
                <progress />
              )}
            </div>
          ) : (
            <button className="btn primary manga-setup-go" onClick={() => void runSetup()}>
              {needsSetup(data) ? 'Set up manga' : 'Set up manga again'}
            </button>
          )}
          {setup?.problem && <p className="meta urgent">Setup stopped: {setup.problem}</p>}
        </div>
      )}

      {/* ---- the next step, once it runs ---- */}
      {data?.health?.reachable && data.health.sources.filter((s) => s !== 'Local source').length === 0 && (
        <div className="manga-setup">
          <h3>Next: add sources</h3>
          <p className="meta">
            Suwayomi is running, but has nowhere to read from yet. Press <strong>Manage extensions</strong> below and
            install one or two — MangaFire, Weeb Central or Asura Scans are good places to start. Then Browse and your
            library can find chapters.
          </p>
          <button className="btn primary" onClick={onExtensions}>
            Manage extensions
          </button>
        </div>
      )}

      {data && !needsSetup(data) && (
        <>
          {managed && <p className={managed.urgent ? 'meta urgent' : 'meta'}>{managed.text}</p>}

          {/* The log, a click away whenever something has gone wrong. */}
          {failed && (
            <div className="row">
              <button className="btn subtle" onClick={() => void showLog()}>
                {log ? 'Refresh the log' : 'See the log'}
              </button>
              {local && (
                <button className="btn subtle" onClick={() => void act(() => manga.source.openLog())}>
                  Open in Notepad
                </button>
              )}
            </div>
          )}
          {log && <pre className="manga-log">{log.join('\n')}</pre>}

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

          {/*
            * Two named alternatives, so two buttons rather than a slider — the
            * same call the live-stream scope makes.
            */}
          {data.manage && (
            <>
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
              <p className="meta">
                {data.mode === 'always'
                  ? 'Started shortly after the app and left running, so opening a chapter is instant. Costs a few hundred megabytes of memory all day.'
                  : 'Started when you search or read, and stopped after fifteen minutes unused. Costs about six seconds the first time, and nothing the rest of the day.'}
              </p>
            </>
          )}

          {data.health && !data.health.reachable && !failing(data) && <p className="meta urgent">{data.health.problem}</p>}
          {data.health?.reachable && data.health.sources.length > 0 && (
            <p className="meta">Searching: {data.health.sources.slice(0, 6).join(', ')}</p>
          )}

          <div className="row">
            <button className="btn" onClick={onExtensions}>
              Manage extensions
            </button>
            {/*
              * Suwayomi's own interface, framed rather than opened in a tab —
              * which is also what makes it reachable from the phone.
              */}
            <button className="btn" onClick={onOpenUi}>
              Open Suwayomi
            </button>
          </div>
        </>
      )}

      {/* ---- a Suwayomi you run yourself: rarely wanted, so folded away ---- */}
      {data && (
        <details className="manga-source-advanced">
          <summary className="meta">Use a Suwayomi you already have</summary>

          <label className="meta" htmlFor="manga-jar">
            Suwayomi <code>.jar</code> file (not the .msi or .zip — those are installers)
          </label>
          <div className="row">
            <input
              id="manga-jar"
              defaultValue={data.jar ?? ''}
              disabled={!local || busy}
              placeholder="…\Suwayomi-Server-v2.3.2243.jar"
              onBlur={(e) => {
                const next = e.target.value.trim();
                if (next !== (data.jar ?? '')) void act(() => manga.source.setJar(next));
              }}
            />
          </div>

          {/*
            * Offered, never chosen for you — and only from the app's own folders.
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

          <label className="meta">
            <input
              type="checkbox"
              checked={data.manage}
              disabled={!local || busy || !data.jar}
              onChange={(e) => void act(() => manga.source.setManage(e.target.checked))}
            />{' '}
            Let the app start and stop it
          </label>

          <label className="meta" htmlFor="manga-url">
            Address, for a Suwayomi running somewhere else
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
        </details>
      )}
    </details>
  );
}
