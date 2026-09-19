/**
 * Suwayomi's own interface, inside this app.
 *
 * The native screens here cover a reading list, chapters, a reader and
 * extensions. Suwayomi's UI covers everything else it can do — browsing a
 * source's popular and latest, filters, categories, downloads, migration — and
 * rebuilding all of that would be months of work to arrive somewhere its authors
 * already are.
 *
 * So it is framed rather than reimplemented. See `uiproxy.ts` for why that needs
 * a proxy rather than pointing at `127.0.0.1:4567`: on a phone that address is
 * the phone, and inside an https page an http frame is blocked outright.
 *
 * ### The session is minted before the frame exists
 *
 * Not alongside it. The frame's very first request is for its own HTML, and if
 * the cookie is not already set that request is a 401 — which the browser
 * renders as its own error page inside the frame, with nothing this component
 * can say about it. So the mint is awaited, and only then is the `src` set.
 */
import { useEffect, useState } from 'react';
import { manga } from './manga-api';

export function SuwayomiUI({ onClose }: { onClose: () => void }) {
  const [path, setPath] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setProblem(null);
    manga.ui.session().then(
      (r) => alive && setPath(r.path),
      (error: unknown) => alive && setProblem(error instanceof Error ? error.message : 'could not open it')
    );
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="manga-frame-screen">
      <div className="row between manga-reader-bar">
        <button className="btn subtle" onClick={onClose}>
          ‹ Back
        </button>
        <span className="meta">Suwayomi</span>
      </div>

      {problem && <p className="banner">{problem}</p>}
      {!path && !problem && <p className="empty">Starting it up…</p>}

      {path && (
        <iframe
          className="manga-frame"
          src={path}
          title="Suwayomi"
          /*
           * Sandboxed, but with the two things it genuinely needs: its own
           * scripts, and same-origin so its service worker and storage work. It
           * is same-origin anyway by construction — that is what the proxy is
           * for — so this is a statement of what it may do rather than a
           * boundary it could not cross. `allow-popups` is deliberately absent:
           * nothing in here should be opening windows.
           */
          sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
        />
      )}
    </div>
  );
}
