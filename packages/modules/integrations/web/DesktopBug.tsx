/**
 * Spotify's desktop app refusing the shuffle, and waiting for the fix — see
 * `spotify-desktop-bug.ts` on the server.
 *
 * Drawn only once the bug is known about here: Play has met it, the thread is
 * being watched, or there is a test or news to show. On an install that never
 * met it, nothing.
 */
import { useState } from 'react';
import { integrationsApi, type DesktopBug as Bug } from './integrations-api';
import { useAsync } from '@app/useAsync';
import { relativeTime } from './Integrations';

export function DesktopBug() {
  const state = useAsync(() => integrationsApi.desktopBug(), [], ['integrations']);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const s = state.data;
  if (!s || (!s.refusedAt && !s.watching && !s.test && s.news.length === 0)) return null;

  async function act(what: string, call: () => Promise<Bug>) {
    setBusy(what);
    setProblem(null);
    try {
      await call();
      state.reload();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  const fixed = s.fixedAt !== null;
  return (
    <div className="card">
      <div className="title">{fixed ? 'Spotify fixed its desktop app' : "Spotify's desktop app bug"}</div>
      <div className="meta" style={{ marginTop: '.4rem' }}>
        {fixed
          ? `The desktop app took a song sent to it ${relativeTime(s.fixedAt)}, so Play sends the shuffle there again.`
          : 'The desktop app says OK to songs sent to it and stops instead of playing, so Play picks the Web Player (open.spotify.com) while it lasts. '}
        {!fixed && (
          <a href={s.threadUrl} target="_blank" rel="noreferrer">
            The forum thread
          </a>
        )}
      </div>

      {!fixed && (
        <div className="meta" style={{ marginTop: '.5rem' }}>
          {s.watching
            ? `Checking the thread once a day for a reply from Spotify or a fix, with a reminder when there is one. Last checked ${relativeTime(s.checkedAt)}.`
            : 'Not watching the thread.'}
          {s.error && <span style={{ color: 'var(--danger)' }}> The last check failed: {s.error}.</span>}
        </div>
      )}

      {s.news.length > 0 && (
        <ul className="meta" style={{ marginTop: '.5rem', paddingLeft: '1.2rem' }}>
          {s.news.slice(0, 5).map((n) => (
            <li key={`${n.url}-${n.at}`}>
              <a href={n.url} target="_blank" rel="noreferrer">
                {n.by}
              </a>
              , {relativeTime(Date.parse(n.at))}: {n.excerpt}
            </li>
          ))}
        </ul>
      )}

      {s.test && (
        <div className="meta" style={{ marginTop: '.5rem', color: s.test.ok ? 'var(--ok)' : undefined }}>
          Tested on {s.test.device} {relativeTime(s.test.at)}: {s.test.detail}
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem', marginTop: '.75rem' }}>
        {!fixed && (
          <button
            className="btn"
            disabled={busy !== null}
            title="Sends one song to the desktop app. Pause anything playing first; if the bug is still there, it clears what the desktop app had paused."
            onClick={() => void act('test', () => integrationsApi.testDesktopApp())}
          >
            {busy === 'test' ? 'Testing…' : 'Test the desktop app'}
          </button>
        )}
        {s.watching && (
          <button className="btn" disabled={busy !== null} onClick={() => void act('check', () => integrationsApi.checkDesktopBug())}>
            {busy === 'check' ? 'Checking…' : 'Check the thread now'}
          </button>
        )}
        {!fixed && (
          <button
            className="btn"
            disabled={busy !== null}
            onClick={() => void act('watch', () => integrationsApi.watchDesktopBug(!s.watching))}
          >
            {s.watching ? 'Stop watching' : 'Tell me when it’s fixed'}
          </button>
        )}
      </div>
      {problem && (
        <div className="meta" style={{ marginTop: '.5rem', color: 'var(--danger)' }}>
          {problem}
        </div>
      )}
    </div>
  );
}
