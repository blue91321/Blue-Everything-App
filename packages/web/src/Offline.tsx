/**
 * What you see when the server is not running.
 *
 * The shell survives it: the service worker caches the app, so the window stays
 * open and usable-looking after `Stop Blue Everything.cmd` or a crash. Before
 * this, every request failed and the failure was indistinguishable from a 401,
 * so the app dropped to the pairing screen and asked for a token — sending you
 * to fix the one thing that was not broken.
 *
 * **The button genuinely starts it**, through a `everything:` URL that Windows
 * hands to `start.ps1`. A web page cannot launch a process any other way, and
 * the handler takes no arguments from the URL — the whole of what any page on
 * the internet could do by invoking it is start your own app.
 *
 * If the handler was never registered, nothing happens when the browser tries
 * to open it, which is a dead end you cannot see. So the fallback is always on
 * screen rather than behind the failure: the file to double-click, named.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from './api';

/**
 * Whether starting the server from here could possibly work.
 *
 * The protocol handler runs on *this* machine, so it is only any use when this
 * machine is the one the server lives on. From the phone over Tailscale the
 * button would appear to do nothing, which is worse than not offering it.
 */
function onTheServersMachine(): boolean {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname);
}

export function Offline({ onBack }: { onBack: () => void }) {
  const [starting, setStarting] = useState(false);
  const [waited, setWaited] = useState(0);
  const local = onTheServersMachine();

  /**
   * Poll until it answers, then reload.
   *
   * Reload rather than re-running the session check: a server that has just
   * started may also be a *newer* server, since `start.ps1` rebuilds the PWA
   * when the sources are newer. Picking up the new bundle is exactly what a
   * reload does and what a soft re-check would not.
   */
  const polling = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!starting) return;

    polling.current = window.setInterval(async () => {
      setWaited((seconds) => seconds + 2);
      if (await api.isUp()) window.location.reload();
    }, 2000);

    return () => window.clearInterval(polling.current);
  }, [starting]);

  /*
   * Started by a real `<a href="everything://start">`, not by assigning
   * `location.href` in the click handler.
   *
   * Chromium gates handing a URL to an external program on a genuine user
   * gesture, and treats a navigation *initiated by an anchor* as one far more
   * readily than a scripted assignment — which it will quietly drop. The anchor
   * is styled as a button and does the same job; only the browser can tell the
   * difference, and it is the one that has to be convinced.
   *
   * Expect a permission prompt the first time. That is the browser asking
   * whether this page may open Blue Everything, and it is the correct place for
   * that question to be asked.
   */
  const start = () => {
    setStarting(true);
    setWaited(0);
  };

  return (
    <div className="pair">
      <h1>Blue Everything isn't running</h1>
      <p>
        The app is still on screen because it was saved for offline use, but nothing can load until the
        server is back.
      </p>

      {local ? (
        <>
          <a
            className="btn primary"
            style={{ marginTop: 12, display: 'inline-block' }}
            href="everything://start"
            onClick={start}
          >
            {starting ? 'Starting…' : 'Start it'}
          </a>

          {starting && (
            <p className="meta" style={{ marginTop: 10 }}>
              {waited < 10
                ? 'Waiting for it to come up. If the browser asked whether to open Blue Everything, say yes.'
                : waited < 30
                  ? `Still waiting (${waited}s). The first start after an update rebuilds the app, which is slower.`
                  : `No answer after ${waited}s. Windows may not know what to do with the everything: link — ` +
                    'run Create Desktop Icon.cmd once to register it, or start the app the usual way below.'}
            </p>
          )}

          <p className="meta" style={{ marginTop: 14 }}>
            Or double-click <code>Blue Everything.cmd</code> in the app's folder. That always works, and is
            what the button is asking Windows to do.
          </p>
        </>
      ) : (
        <p className="meta" style={{ marginTop: 12 }}>
          Start it on the PC that runs it — this page can only reach it over the network, and cannot wake
          it up.
        </p>
      )}

      {/* An escape hatch, because a wrong guess about *why* the fetch failed
          must not lock you out of the pairing screen. */}
      <p style={{ marginTop: 18 }}>
        <button className="btn subtle" onClick={onBack}>
          It's running — let me sign in instead
        </button>
      </p>
    </div>
  );
}
