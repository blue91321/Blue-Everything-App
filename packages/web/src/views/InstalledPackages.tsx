/**
 * Packages you installed, and the folder they live in.
 *
 * Deliberately shaped like adding a texture pack: a folder you can open, a zip
 * you can drop on the page, a list you can switch and delete from. What the
 * comparison cannot carry over is the safety — a resource pack is data, and a
 * package here may be code — so the warning sits above the drop zone rather
 * than in a README nobody opens.
 *
 * Its own file rather than another section inside `Settings.tsx`, which is long
 * enough already and holds five tabs' worth of screens. Nothing here is a
 * feature, so it stays in `views/` with the rest of core: the screen that
 * *removes* a broken package must exist whatever is installed.
 */
import { useRef, useState } from 'react';
import { api, type ModuleInfo, type Session } from '../api';
import { useAsync } from '../useAsync';
import { Toggle } from '../controls';

/** Bytes in the unit that fits, the same idea as the gauge editor's spans. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * One installed package.
 *
 * Removing asks first, like `DeviceRow` and for the same reason: it is the only
 * irreversible thing on the row and it sits beside a toggle that is not. Unlike
 * a device there is no revoke step to soften it — the folder goes.
 */
function PackageRow({
  mod,
  local,
  busy,
  onToggle,
  onRemove,
}: {
  mod: ModuleInfo;
  local: boolean;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="card">
      <div className="row between">
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="title">
            {mod.label}
            {mod.version && (
              <span className="meta" title="the package's own version, not the app's">
                {' '}
                · {mod.version}
              </span>
            )}
            {/* Saved but not live — the same wording the built-in rows use, so
                both halves of the screen read the same way. */}
            {mod.pendingRestart && <span className="meta"> · {mod.enabled ? 'on' : 'off'} after restart</span>}
            {!mod.usable && (
              <span className="urgent" title="this package cannot run until its problems are fixed">
                {' '}
                ⚠ broken
              </span>
            )}
          </div>

          {mod.blurb && (
            <div className="meta" style={{ marginTop: 4 }}>
              {mod.blurb}
            </div>
          )}

          <div className="meta" style={{ marginTop: 4 }}>
            {mod.author ? `by ${mod.author} · ` : ''}
            {formatBytes(mod.bytes)}
            {/*
              Said on every row, not only in the banner above. The banner states
              the rule once; this says which rows it is actually about — and a
              data-only package genuinely is a smaller thing to trust than one
              that runs.
            */}
            {mod.code ? ' · runs code in the app' : ' · data only, runs no code'}
          </div>

          {mod.notes && (
            <div className="meta" style={{ marginTop: 4 }}>
              {mod.notes}
            </div>
          )}

          {/*
            Every problem, named by field. A broken package that merely vanished
            from the list would be indistinguishable from one that never
            installed — the most confusing outcome available on this screen.
          */}
          {mod.problems.length > 0 && (
            <div style={{ marginTop: 6 }}>
              {mod.problems.map((problem) => (
                <div className="urgent" key={`${problem.field}:${problem.message}`}>
                  {problem.field} {problem.message}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="row" style={{ gap: '.4rem', alignItems: 'center', flex: 'none' }}>
          <Toggle
            on={mod.enabled}
            disabled={busy || !local || !mod.usable}
            label={`${mod.label} on`}
            onChange={onToggle}
          />
          {mod.shipped ? (
            /*
              No Remove for a shipped package, and it is absent rather than
              disabled. A disabled button is a promise that it could work under
              some condition; this one never can, because the folder is part of
              your checkout — deleting it would be a `git checkout` away from
              coming back and a `git status` away from being confusing.
            */
            <span className="meta" style={{ whiteSpace: 'nowrap' }}>
              built in
            </span>
          ) : confirming ? (
            <>
              <button className="btn danger" disabled={busy} onClick={onRemove}>
                Delete
              </button>
              <button className="btn subtle" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button
              className="btn subtle"
              disabled={busy || !local}
              title={local ? 'Delete this package from disk' : 'Only from the PC running the server'}
              onClick={() => setConfirming(true)}
            >
              Remove
            </button>
          )}
        </div>
      </div>

      {confirming && (
        <div className="meta" style={{ marginTop: 8 }}>
          This deletes <code>{mod.id}</code> from disk, and cannot be undone from here — you would need the
          zip again.
        </div>
      )}
    </div>
  );
}

export function InstalledPackages({ session }: { session: Session }) {
  const state = useAsync(() => api.modules.get(), [], ['packages']);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [problem, setProblem] = useState('');
  const [done, setDone] = useState('');
  const fileInput = useRef<HTMLInputElement | null>(null);

  const data = state.data;
  /*
   * A server older than this feature answers 404, which `useAsync` reports as
   * an error. Rendering nothing is right: the built-in list above is the whole
   * screen on that version, and a banner would suggest something had broken.
   * The same reasoning as the voice tab's `serverSupportsVoice` guard.
   */
  if (state.error || !data) return null;

  const local = session.local && data.canInstall;

  async function install(file: File) {
    setProblem('');
    setDone('');

    /*
     * Checked here as well as on the server, purely so the common mistake gets
     * an instant answer instead of a round trip. The server does not trust it —
     * it reads the archive itself and ignores the name entirely.
     */
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setProblem(`"${file.name}" is not a .zip — packages are distributed as zip files.`);
      return;
    }

    setBusy(true);
    try {
      const result = await api.modules.install(file);
      setDone(
        `${result.label} ${result.version} ${result.replaced ? 'replaced the old copy' : 'installed'} — ` +
          `${result.files} file${result.files === 1 ? '' : 's'}. Switch it on below, then restart.`
      );
      state.reload();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggle(id: string, enabled: boolean) {
    setProblem('');
    setBusy(true);
    try {
      await api.modules.set(id, enabled);
      state.reload();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setProblem('');
    setDone('');
    setBusy(true);
    try {
      await api.modules.remove(id);
      state.reload();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const pendingRestart = data.modules.some((mod) => mod.pendingRestart);
  /*
   * Two groups from one list. A shipped package is *also* built in — it came
   * with the app — so it belongs with the features above rather than under a
   * heading claiming you installed it. The only thing separating the two is
   * where the folder lives, and that is exactly what decides whether Remove
   * can mean anything.
   */
  const shipped = data.modules.filter((mod) => mod.shipped);
  const added = data.modules.filter((mod) => !mod.shipped);

  return (
    <>
      {/* Rendered before the "Installed" heading, so they read as a
          continuation of the built-in list the tab has already drawn. */}
      {shipped.map((mod) => (
        <PackageRow
          key={mod.id}
          mod={mod}
          local={local}
          busy={busy}
          onToggle={(enabled) => void toggle(mod.id, enabled)}
          onRemove={() => void remove(mod.id)}
        />
      ))}

      <h3 className="pkg-head">Installed</h3>
      <div className="meta" style={{ marginBottom: 8 }}>
        Packages you added yourself. One folder each, under <code>modules/</code>.
      </div>

      {/*
        Above the drop zone, not below it and not in the README. This is where
        the texture-pack comparison breaks: a package with a server half is
        ordinary code in the app's own process, with the app's own reach.
        Somebody about to drag a file in is exactly who needs to read it.
      */}
      <div className="banner">
        <strong>A package can run code.</strong> One with a server half has the same access to your database
        and this PC as the app itself — there is no sandbox. Install ones you would be willing to run as a
        program.
      </div>

      {pendingRestart && (
        <div className="banner">
          <strong>Restart to apply.</strong> Packages are loaded once when the app starts. Right-click the
          tray icon and choose <strong>Restart</strong>.
        </div>
      )}

      {problem && <div className="banner">{problem}</div>}
      {done && <div className="card">{done}</div>}

      {local ? (
        <>
          {/*
            A drop target that is also a button, so the two ways in are one
            control. `onDragOver` must preventDefault or the browser navigates
            to the dropped file — which looks exactly like the app crashing.
          */}
          <div
            className={dragging ? 'dropzone dragging' : 'dropzone'}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              const file = event.dataTransfer.files[0];
              if (file) void install(file);
            }}
          >
            <div className="title">{busy ? 'Installing…' : 'Drop a package here'}</div>
            <div className="meta" style={{ marginTop: 4 }}>
              A <code>.zip</code> you downloaded — or put the folder in by hand, using the button below.
            </div>

            <div className="row" style={{ gap: '.4rem', marginTop: 10, justifyContent: 'center' }}>
              <button className="btn primary" disabled={busy} onClick={() => fileInput.current?.click()}>
                Choose a zip
              </button>
              <button
                className="btn"
                disabled={busy}
                title={data.folder ?? undefined}
                onClick={() => {
                  setProblem('');
                  api.modules.openFolder().catch((error: Error) => setProblem(error.message));
                }}
              >
                Show folder
              </button>
            </div>

            <input
              ref={fileInput}
              type="file"
              accept=".zip,application/zip"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                // Cleared so choosing the same file twice fires again — after a
                // failed install that is exactly what you are about to do.
                event.target.value = '';
                if (file) void install(file);
              }}
            />
          </div>

          {data.folder && (
            <div className="meta" style={{ marginTop: 6, wordBreak: 'break-all' }}>
              <code>{data.folder}</code>
            </div>
          )}
        </>
      ) : (
        <div className="meta" style={{ marginBottom: 8 }}>
          Packages can only be installed or removed from the PC running the server.
        </div>
      )}

      {added.length === 0 ? (
        <div className="empty" style={{ marginTop: 10 }}>
          Nothing installed yet.
        </div>
      ) : (
        added.map((mod) => (
          <PackageRow
            key={mod.id}
            mod={mod}
            local={local}
            busy={busy}
            onToggle={(enabled) => void toggle(mod.id, enabled)}
            onRemove={() => void remove(mod.id)}
          />
        ))
      )}
    </>
  );
}
