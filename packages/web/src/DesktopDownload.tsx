/**
 * Download Blue Everything Desktop from this server: a button, with its size.
 * See `routes/desktop-app.ts` for where the zip comes from and why the
 * download goes through a ticket. Falls back to the GitHub releases page when
 * this server cannot get it.
 */
import { useState } from 'react';
import { api } from './api';
import { useAsync } from './useAsync';
import { DESKTOP_APP_URL } from './desktop-app';

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

export function DesktopDownload({ label = 'Download Blue Everything Desktop' }: { label?: string }) {
  const info = useAsync(() => api.desktopApp.get(), []);
  const [state, setState] = useState<'idle' | 'getting' | 'started'>('idle');
  const [problem, setProblem] = useState('');

  const download = async () => {
    setProblem('');
    setState('getting');
    try {
      const { url } = await api.desktopApp.ticket();
      // A navigation to an attachment downloads it and leaves this page where it is.
      window.location.href = url;
      setState('started');
      info.reload();
    } catch (error) {
      setProblem((error as Error).message);
      setState('idle');
    }
  };

  return (
    <span className="desktop-download">
      <button className="btn" disabled={state === 'getting'} onClick={() => void download()}>
        {state === 'getting'
          ? info.data?.ready
            ? 'Starting…'
            : 'Getting it from GitHub…'
          : `${label}${info.data?.bytes ? ` (${mb(info.data.bytes)})` : ''}`}
      </button>
      {state === 'started' && <span className="meta"> Downloading. Unzip it and open Blue Everything Desktop.cmd.</span>}
      {problem && (
        <span className="meta warn">
          {' '}
          {problem}{' '}
          <a href={info.data?.releases ?? DESKTOP_APP_URL} target="_blank" rel="noreferrer">
            Releases on GitHub
          </a>
        </span>
      )}
    </span>
  );
}
