/**
 * Installing the extensions that decide which sites you can read from.
 *
 * Here rather than in Suwayomi's own web UI because leaving the app to do the
 * one piece of setup that makes the rest work is the same friction the three
 * double-clickable files in the repo root exist to remove — and worse here,
 * since the thing you would be leaving for is a second server on a port you are
 * not supposed to have to know about.
 *
 * ### It is a list of 1,396, so it is a search box first
 *
 * That is the real number from the community repository, and a list that long
 * is not something to scroll. Nothing is shown until you have typed two
 * characters — except what is already installed, which is the short list you
 * actually come here to manage.
 *
 * ### Nothing is hidden by a judgement made here
 *
 * `nsfw` is marked rather than filtered. Quietly removing entries would make a
 * search for something that exists come back empty, which reads as the feature
 * being broken rather than as a decision somebody made on your behalf.
 */
import { useEffect, useRef, useState } from 'react';
import { useAsync } from '@app/useAsync';
import { manga, type SourceExtension } from './manga-api';

function matches(extension: SourceExtension, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return extension.name.toLowerCase().includes(q) || extension.lang.toLowerCase() === q;
}

export function Extensions({ local, onClose }: { local: boolean; onClose: () => void }) {
  const state = useAsync(() => manga.extensions.list());
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const autoRefreshed = useRef(false);

  async function refresh() {
    setRefreshing(true);
    try {
      await manga.extensions.list(true);
      state.reload();
    } finally {
      setRefreshing(false);
    }
  }

  /*
   * A repository with nothing listed from it has simply never been read — which
   * is every fresh install straight after "Set up manga". Showing that as an
   * empty list, with a Refresh button to find, is the dead end this screen
   * existed to avoid; so it reads the repository itself, once.
   */
  useEffect(() => {
    const d = state.data;
    if (!d || autoRefreshed.current || d.repos.length === 0 || d.extensions.length > 0) return;
    autoRefreshed.current = true;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.data]);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setProblem(null);
    try {
      await fn();
      state.reload();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'that did not work');
    } finally {
      setBusy(null);
    }
  }

  const data = state.data;
  const all = data?.extensions ?? [];
  const installed = all.filter((e) => e.installed);
  const found = query.trim().length >= 2 ? all.filter((e) => matches(e, query) && !e.installed).slice(0, 60) : [];

  const row = (e: SourceExtension) => (
    <div className="manga-ext-row" key={e.pkg}>
      <div className="manga-row-text">
        <span className="title truncate">
          {e.name}
          {e.nsfw && <span className="meta"> · 18+</span>}
        </span>
        <span className="meta">
          {e.lang} · v{e.version}
          {e.hasUpdate && ' · update available'}
        </span>
      </div>
      {e.installed ? (
        <button className="btn danger" disabled={!local || busy !== null} onClick={() => act(e.pkg, () => manga.extensions.install(e.pkg, false))}>
          {busy === e.pkg ? '…' : 'Remove'}
        </button>
      ) : (
        <button className="btn" disabled={!local || busy !== null} onClick={() => act(e.pkg, () => manga.extensions.install(e.pkg))}>
          {busy === e.pkg ? '…' : 'Install'}
        </button>
      )}
    </div>
  );

  return (
    <div className="card">
      <div className="row between">
        <button className="btn subtle" onClick={onClose}>
          ‹ Back
        </button>
        <span className="meta">{data ? `${installed.length} installed of ${all.length}` : 'loading…'}</span>
        <button
          className="btn subtle"
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          {refreshing ? 'Reading repos…' : 'Refresh'}
        </button>
      </div>

      {!local && <p className="meta urgent">Extensions can only be changed from the PC running the server.</p>}
      {problem && <p className="banner">{problem}</p>}
      {state.loading && <p className="empty">loading…</p>}
      {state.error && <p className="banner">Could not load: {state.error.message}</p>}

      {/*
        * A Suwayomi with no repositories lists nothing, which is its state on a
        * fresh install and looks exactly like a broken screen. So the empty case
        * offers the community repository by name rather than asking for a URL
        * nobody has.
        */}
      {data && data.repos.length === 0 && (
        <div className="banner">
          <p>No extension repository is set, so there is nothing to install from.</p>
          <button
            className="btn primary"
            disabled={!local || busy !== null}
            onClick={() => act('repo', () => manga.extensions.setRepos([data.suggestedRepo]))}
          >
            {busy === 'repo' ? 'Adding…' : 'Use the Keiyoushi repository'}
          </button>
          <p className="meta">
            It is the community continuation of Tachiyomi's own extension list. Adding it downloads and runs code from
            there, which is the same thing installing any extension does.
          </p>
        </div>
      )}

      {data && data.repos.length > 0 && (
        <>
          <h3>Installed</h3>
          {installed.length === 0 && <p className="empty">None yet. Search below to add one.</p>}
          {installed.map(row)}

          <h3>Add one</h3>
          <div className="row">
            <input
              value={query}
              placeholder="Site name, or a language code like en"
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search extensions"
            />
          </div>
          {query.trim().length < 2 && (
            <p className="meta">
              {all.length} available. Type at least two characters — a list this long is not one to scroll.
            </p>
          )}
          {query.trim().length >= 2 && found.length === 0 && <p className="empty">Nothing matched.</p>}
          {found.map(row)}
        </>
      )}
    </div>
  );
}
