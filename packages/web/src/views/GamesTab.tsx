/**
 * Game detection: what counts as a game, and what may interrupt one.
 *
 * The nudge engine's most consequential rule lives here — `in-game` has never
 * been a moment, which is the whole reason this app exists rather than being a
 * to-do list. Until now that rule had no screen at all: the game list was a
 * constant in the agent's source plus an array in a config file on the PC, and
 * an app that grabbed exclusive fullscreen was written to a console log.
 *
 * So the list is a **record of what actually ran here**, not a list to maintain.
 * Rows appear because something was seen; the choices on them are yours.
 */
import { useState } from 'react';
import { api, type Game, type Session } from '../api';
import { useAsync } from '../useAsync';
import { Toggle } from '../controls';
import { relative } from '../format';

/** What each `source` means, said plainly on the row. */
const SOURCE_LABEL: Record<string, string> = {
  seen: 'seen running',
  fullscreen: 'filled the screen',
  manual: 'you added it',
};

export function GamesTab({ session }: { session: Session }) {
  const settings = useAsync(() => api.settings.get(), [], ['settings']);
  const list = useAsync(() => api.games.list(), [], ['games']);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  const current = settings.data;
  const games = list.data ?? [];
  const local = session.local;

  async function run(what: () => Promise<unknown>) {
    setProblem('');
    setBusy(true);
    try {
      await what();
      settings.reload();
      list.reload();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (settings.loading || list.loading) return <div className="empty">loading…</div>;
  /*
   * A server older than this screen answers 404 for the list. Saying so beats
   * rendering an empty one, which would read as "nothing has ever run here".
   */
  if (list.error) return <div className="banner">This server is older than the Games screen — restart the app.</div>;
  if (!current) return <div className="banner">Could not read the settings.</div>;

  const detecting = Boolean(current.gameDetectionEnabled ?? 1);
  const interrupting = Boolean(current.interruptDuringGames ?? 0);
  const watched = games.filter((game) => game.isGame === 1);

  return (
    <section id="game-detection">
      <h2>Games</h2>
      <div className="meta" style={{ marginBottom: 12 }}>
        Holding a reminder until a match ends is the thing this app is for, so what counts as a game
        decides more here than anywhere else on this screen.
      </div>

      {problem && <div className="banner">{problem}</div>}
      {!local && (
        <div className="meta" style={{ marginBottom: 10 }}>
          These can only be changed from the PC running the server.
        </div>
      )}

      <div className="card">
        <div className="row between">
          <div className="grow">
            <div className="title">Notice when I'm in a game</div>
            <div className="meta" style={{ marginTop: 4 }}>
              {/*
                Deliberately not "watching for N games". The app recognises the
                common ones already — that is how anything gets onto the list at
                all — so a count of *rows* would read as "it only knows about
                these", which is the opposite of true when the list is empty.
              */}
              {detecting
                ? 'A match reads as "in a game" and the queue waits for it to end. Common games are recognised already; anything else is learned the first time it runs.'
                : 'Off — a match looks like ordinary desktop use, so nudges arrive during one. The list below is kept either way.'}
            </div>
          </div>
          <Toggle
            on={detecting}
            disabled={busy || !local}
            label="Notice when I'm in a game"
            onChange={(on) => void run(() => api.settings.update({ gameDetectionEnabled: on }))}
          />
        </div>
      </div>

      <div className="card">
        <div className="row between">
          <div className="grow">
            <div className="title">Interrupt me during a game</div>
            <div className="meta" style={{ marginTop: 4 }}>
              {interrupting
                ? 'Nudges arrive during a match like any other time.'
                : 'Nudges wait for the match to end. A passed deadline still breaks through — that has always been the one exception.'}
            </div>
            {/* Only worth saying while it can do nothing, which is otherwise a
                confusing switch to find already set the way you want it. */}
            {!detecting && (
              <div className="meta" style={{ marginTop: 4 }}>
                Nothing to apply while detection is off.
              </div>
            )}
          </div>
          <Toggle
            on={interrupting}
            disabled={busy || !local || !detecting}
            label="Interrupt me during a game"
            onChange={(on) => void run(() => api.settings.update({ interruptDuringGames: on }))}
          />
        </div>
      </div>

      <h3 className="pkg-head">
        Detected here{watched.length > 0 ? ` · ${watched.length} treated as ${watched.length === 1 ? 'a game' : 'games'}` : ''}
      </h3>
      <div className="meta" style={{ marginBottom: 8 }}>
        Only what has actually run on this PC — no game names ship with the app, so this is a record
        rather than a catalogue of things you may not have installed.
      </div>
      <div className="meta" style={{ marginBottom: 8 }}>
        Anything that fills a whole monitor gets listed, borderless included. One installed under a game
        library — Steam, Epic, Riot, GOG, Xbox — is switched on for you; anything else is listed switched
        off, because films and browsers fill the screen too.
      </div>

      {games.length === 0 ? (
        <div className="empty">
          Nothing yet — nothing is listed until it has actually run here. Start a game and it appears
          within a few seconds.
        </div>
      ) : (
        games.map((game) => (
          <GameRow
            key={game.exe}
            game={game}
            local={local}
            busy={busy}
            interruptByDefault={interrupting}
            onChange={(patch) => void run(() => api.games.update(game.exe, patch))}
            onForget={() => void run(() => api.games.forget(game.exe))}
            onLaunch={() => void run(() => api.games.launch(game.exe))}
            onShowFolder={() => void run(() => api.games.showFolder(game.exe))}
          />
        ))
      )}

      <AddGame local={local} busy={busy} onAdd={(exe) => void run(() => api.games.add(exe))} />
    </section>
  );
}

/**
 * One game, with the two questions that matter and the one that undoes them.
 *
 * "Interrupt" is deliberately three-state — yes, no, and *follow the setting
 * above*. Stamping every row with today's default would look identical on the
 * day it was made and diverge silently forever after: change the default and
 * every game already listed would keep answering the old question, with nothing
 * on screen to say why. The same reasoning `push_to_phone` uses.
 */
function GameRow({
  game,
  local,
  busy,
  interruptByDefault,
  onChange,
  onForget,
  onLaunch,
  onShowFolder,
}: {
  game: Game;
  local: boolean;
  busy: boolean;
  interruptByDefault: boolean;
  onChange: (patch: {
    isGame?: boolean;
    allowInterruptions?: boolean | null;
    label?: string;
    launchUrl?: string | null;
  }) => void;
  onForget: () => void;
  onLaunch: () => void;
  onShowFolder: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  const choice: 'default' | 'yes' | 'no' =
    game.allowInterruptions === null ? 'default' : game.allowInterruptions === 1 ? 'yes' : 'no';

  return (
    <div className="card">
      <div className="row between" style={{ alignItems: 'flex-start', gap: '.6rem' }}>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="title truncate">{game.label}</div>
          <div className="meta truncate" style={{ marginTop: 2 }}>
            <code>{game.exe}</code>
          </div>
          <div className="meta" style={{ marginTop: 2 }}>
            {SOURCE_LABEL[game.source] ?? game.source} · last seen {relative(game.lastSeenAt)}
          </div>

          {/*
            The path, and the two things worth doing with it. Both are absent
            rather than disabled until it is known: the path fills itself in the
            first time the game runs, and a greyed-out Run beside a game you have
            played would be a puzzle rather than a hint.
          */}
          {game.launchPath ? (
            <>
              <div className="meta truncate" style={{ marginTop: 2 }} title={game.launchPath}>
                {game.launchPath}
              </div>
              {/*
                Shown when there is one, because it changes what Run actually
                does — and because "it started through Steam" is the answer to
                why a game that would not start now does.
              */}
              {game.launchUrl && (
                <div className="meta truncate" style={{ marginTop: 2 }} title={game.launchUrl}>
                  starts via <code>{game.launchUrl}</code>
                </div>
              )}
              {local && (
                <div className="row" style={{ gap: '.35rem', marginTop: 6 }}>
                  <button className="btn subtle" disabled={busy} onClick={onLaunch}>
                    Run
                  </button>
                  <button className="btn subtle" disabled={busy} onClick={onShowFolder}>
                    Show folder
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="meta" style={{ marginTop: 2 }}>
              Where it lives is filled in the next time it runs.
            </div>
          )}
        </div>

        <div className="row" style={{ gap: '.4rem', alignItems: 'center', flex: 'none' }}>
          <Toggle
            on={game.isGame === 1}
            disabled={busy || !local}
            label={`${game.label} is a game`}
            onChange={(on) => onChange({ isGame: on })}
          />
          {confirming ? (
            <>
              <button className="btn danger" disabled={busy} onClick={onForget}>
                Forget
              </button>
              <button className="btn subtle" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button className="btn subtle" disabled={busy || !local} onClick={() => setConfirming(true)}>
              Forget
            </button>
          )}
        </div>
      </div>

      {confirming && (
        <div className="meta" style={{ marginTop: 8 }}>
          Removes the row and everything set on it. It comes back the next time this runs — which is the
          point of a list that fills itself in.
        </div>
      )}

      {/* Only for things that are actually games. Asking whether a photo viewer
          may interrupt you is a question about nothing. */}
      {game.isGame === 1 && local && <LaunchAddress game={game} busy={busy} onChange={onChange} />}

      {game.isGame === 1 && (
        <div style={{ marginTop: 10 }}>
          <div className="meta">Interrupt me during this one</div>
          <div className="row wrap" style={{ gap: '.35rem', marginTop: 6 }}>
            {(
              [
                ['default', `Follow the setting above (${interruptByDefault ? 'yes' : 'no'})`, null],
                ['yes', 'Yes', true],
                ['no', 'No', false],
              ] as const
            ).map(([id, label, value]) => (
              <button
                key={id}
                type="button"
                className={choice === id ? 'btn primary' : 'btn subtle'}
                disabled={busy || !local}
                onClick={() => onChange({ allowInterruptions: value })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Add one by hand.
 *
 * For the game that has not run since this list existed — the list fills itself
 * in, but only going forward, and waiting to play something before you can
 * configure it is a poor first experience.
 */
function AddGame({ local, busy, onAdd }: { local: boolean; busy: boolean; onAdd: (exe: string) => void }) {
  const [exe, setExe] = useState('');
  if (!local) return null;

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="title">Add one yourself</div>
      <div className="meta" style={{ marginTop: 4 }}>
        The executable's name, as it appears in Task Manager — <code>cs2.exe</code>, not a full path.
      </div>
      <form
        className="row"
        style={{ gap: '.4rem', marginTop: 8 }}
        onSubmit={(event) => {
          event.preventDefault();
          const name = exe.trim().toLowerCase();
          if (!name) return;
          onAdd(name);
          setExe('');
        }}
      >
        <div className="grow">
          <input
            value={exe}
            placeholder="something.exe"
            aria-label="Executable name"
            onChange={(event) => setExe(event.target.value)}
          />
        </div>
        <button className="btn" type="submit" disabled={busy || exe.trim() === ''}>
          Add
        </button>
      </form>
    </div>
  );
}

/**
 * The address that starts a game, when running its executable does not.
 *
 * Reported from real use: `"start warframe"` ran `Warframe.x64.exe` and got
 * **"start warframe from launcher"** back. Plenty of Steam games are a thin
 * binary behind a launcher that expects Steam to have set things up first, so
 * the executable is the wrong thing to run even though it is what was running
 * when the app saw it.
 *
 * Found automatically for anything under a Steam library — the app id is in
 * `appmanifest_*.acf` beside the game — and typeable here for everything else,
 * because the address is already sitting in the properties of a shortcut you
 * have. Collapsed, since most games need nothing here.
 */
function LaunchAddress({
  game,
  busy,
  onChange,
}: {
  game: Game;
  busy: boolean;
  onChange: (patch: { launchUrl?: string | null }) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? game.launchUrl ?? '';
  const trimmed = value.trim();
  // Empty is how you clear it, so it is "none" rather than invalid.
  const valid = trimmed === '' || /^steam:\/\/(?:rungameid|run)\/[0-9]{1,10}$/.test(trimmed.toLowerCase());

  return (
    <details style={{ marginTop: 10 }}>
      <summary className="meta">
        {game.launchUrl ? 'Starts through Steam' : 'Does it need a launcher to start?'}
      </summary>
      <div className="meta" style={{ marginTop: 6 }}>
        Some games refuse to run from their own executable and say so — "start it from the launcher".
        Right-click the game's desktop shortcut, copy the address from its properties, and paste it here.
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <div className="grow">
          <input
            value={value}
            placeholder="steam://rungameid/230410"
            aria-label={`How to start ${game.label}`}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
        <button
          className="btn"
          disabled={busy || !valid || trimmed === (game.launchUrl ?? '')}
          onClick={() => {
            onChange({ launchUrl: trimmed });
            setDraft(null);
          }}
        >
          Save
        </button>
      </div>
      {!valid && (
        <div className="meta urgent" style={{ marginTop: 6 }}>
          Only a Steam game address — <code>steam://rungameid/230410</code>. Anything else would hand the
          shell a program somebody else chose, which is a much larger thing than starting a game.
        </div>
      )}
    </details>
  );
}
