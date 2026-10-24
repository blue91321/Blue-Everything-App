/**
 * Installing the extensions that decide which sites you can read from.
 *
 * Here rather than in Suwayomi's own web UI because leaving the app to do the
 * one piece of setup that makes the rest work is the same friction the three
 * double-clickable files in the repo root exist to remove — and worse here,
 * since the thing you would be leaving for is a second server on a port you are
 * not supposed to have to know about.
 *
 * ### What you use, first
 *
 * Installed extensions are sorted by how much of your library reads from
 * them: the series linked to their sources and the chapters you have finished
 * there (`extension-usage.ts`). An extension nothing reads from sorts last,
 * which is the one worth asking whether to keep. Each has **Browse**, which
 * opens Browse on its source in a language you read.
 *
 * ### Browsing what there is, not only searching it
 *
 * The repository lists about 1,400. Those in the languages you read (and the
 * multi-language ones) can be scrolled, forty at a time, without typing; a
 * search covers every language. `nsfw` is marked rather than filtered: quietly
 * removing entries would make a search for something that exists come back
 * empty, which reads as the feature being broken.
 *
 * ### From any device
 *
 * Installing, removing, updating and the repository are all here on the phone
 * too. It used to be the PC's alone, with the phone flagging what it wanted,
 * but the phone already reaches Suwayomi's own interface through More, which
 * does all of this, so the rule was a detour rather than a guard. Anything
 * flagged from before is still listed at the top until installed or unflagged.
 *
 * ### Updating
 *
 * An out-of-date extension is the commonest reason a source stops working, so
 * each one with an update has its own button, **Update all** takes every one,
 * and a switch decides whether they update themselves once a day while
 * Suwayomi is running (on by default, as it always was).
 */
import { useEffect, useRef, useState } from 'react';
import { FloatingBack } from '@app/FloatingBack';
import { useAsync } from '@app/useAsync';
import { manga, type ExtensionUsage, type SourceExtension } from './manga-api';

const PAGE = 40;

function matches(extension: SourceExtension, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return extension.name.toLowerCase().includes(q) || extension.lang.toLowerCase() === q;
}

/** In a language you read: yours, a regional form of it (es-419 for es), or every language. */
function inYourLanguages(extension: SourceExtension, languages: readonly string[]): boolean {
  const lang = extension.lang.toLowerCase();
  return lang === 'all' || languages.some((l) => lang === l.toLowerCase() || lang.startsWith(`${l.toLowerCase()}-`));
}

/** The source to open Browse on: one in a language you read, else the first it has. */
function browseTarget(usage: ExtensionUsage | undefined, languages: readonly string[]): string | null {
  const sources = usage?.sources ?? [];
  const yours = sources.find((s) => languages.some((l) => s.lang.toLowerCase() === l.toLowerCase()));
  return (yours ?? sources[0])?.id ?? null;
}

export function Extensions({
  onClose,
  onBrowse,
}: {
  local?: boolean;
  onClose: () => void;
  /** Open Browse on this source id. */
  onBrowse: (sourceId: string) => void;
}) {
  const state = useAsync(() => manga.extensions.list());
  const [query, setQuery] = useState('');
  // Watched by the Back beside the ☰, shown once this one has scrolled away.
  const backRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const [updated, setUpdated] = useState<string | null>(null);
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
  const usage = data?.usage ?? {};
  const flagged = new Set(data?.flagged ?? []);
  /*
   * A guest copy (plan A) shares the host's Suwayomi, so it asks for a source
   * and the host installs it; updates and removals are the host's too.
   */
  const onHost = data?.onHost === true;
  const askedBy = data?.askedBy ?? {};
  const languages = data?.readLanguages ?? [];
  const use = (e: SourceExtension) => usage[e.pkg];
  const installed = all
    .filter((e) => e.installed)
    .sort(
      (a, b) =>
        (use(b)?.series ?? 0) - (use(a)?.series ?? 0) ||
        (use(b)?.chapters ?? 0) - (use(a)?.chapters ?? 0) ||
        a.name.localeCompare(b.name)
    );
  const waiting = all.filter((e) => !e.installed && flagged.has(e.pkg));
  const outdated = installed.filter((e) => e.hasUpdate);
  const searching = query.trim().length >= 2;
  const available = searching
    ? all.filter((e) => matches(e, query) && !e.installed)
    : all.filter((e) => !e.installed && inYourLanguages(e, languages)).sort((a, b) => a.name.localeCompare(b.name));

  const action = (e: SourceExtension) => {
    if (e.installed) {
      const target = browseTarget(use(e), languages);
      return (
        <>
          {e.hasUpdate && !onHost && (
            <button
              className="btn primary"
              disabled={busy !== null}
              onClick={() => act(`u:${e.pkg}`, () => manga.extensions.update(e.pkg))}
            >
              {busy === `u:${e.pkg}` ? '…' : 'Update'}
            </button>
          )}
          {target && (
            <button className="btn subtle" onClick={() => onBrowse(target)}>
              Browse
            </button>
          )}
          {!onHost && (
            <button
              className="btn danger"
              disabled={busy !== null}
              onClick={() => act(e.pkg, () => manga.extensions.install(e.pkg, false))}
            >
              {busy === e.pkg ? '…' : 'Remove'}
            </button>
          )}
        </>
      );
    }
    if (onHost) {
      return flagged.has(e.pkg) ? (
        <button className="btn subtle" disabled={busy !== null} onClick={() => act(`f:${e.pkg}`, () => manga.extensions.flag(e.pkg, false))}>
          {busy === `f:${e.pkg}` ? '…' : 'Asked · take back'}
        </button>
      ) : (
        <button className="btn" disabled={busy !== null} onClick={() => act(`f:${e.pkg}`, () => manga.extensions.flag(e.pkg, true))}>
          {busy === `f:${e.pkg}` ? '…' : 'Ask for it'}
        </button>
      );
    }
    return (
      <>
        {flagged.has(e.pkg) && (
          <button className="btn subtle" disabled={busy !== null} onClick={() => act(`f:${e.pkg}`, () => manga.extensions.flag(e.pkg, false))}>
            Unflag
          </button>
        )}
        <button className="btn" disabled={busy !== null} onClick={() => act(e.pkg, () => manga.extensions.install(e.pkg))}>
          {busy === e.pkg ? '…' : 'Install'}
        </button>
      </>
    );
  };

  const row = (e: SourceExtension) => {
    const u = use(e);
    return (
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
          {!e.installed && !onHost && (askedBy[e.pkg]?.length ?? 0) > 0 && (
            <span className="meta">Asked for by {askedBy[e.pkg]!.join(', ')}</span>
          )}
          {e.installed && (
            <span className="meta">
              {u && (u.series > 0 || u.chapters > 0)
                ? `${u.series} series · ${u.chapters} chapter${u.chapters === 1 ? '' : 's'} read`
                : 'Nothing in your library reads from it'}
            </span>
          )}
        </div>
        <div className="manga-ext-actions">{action(e)}</div>
      </div>
    );
  };

  return (
    <div className="card">
      <div className="row between">
        <button ref={backRef} className="btn subtle" onClick={onClose}>
          ‹ Back
        </button>
        <FloatingBack target={backRef} onBack={onClose} />
        <span className="meta">{data ? `${installed.length} installed of ${all.length}` : 'loading…'}</span>
        <button className="btn subtle" disabled={refreshing} onClick={() => void refresh()}>
          {refreshing ? 'Reading repos…' : 'Refresh'}
        </button>
      </div>

      {problem && <p className="banner">{problem}</p>}
      {state.loading && <p className="empty">loading…</p>}
      {state.error && <p className="banner">Could not load: {state.error.message}</p>}

      {/*
        * A Suwayomi with no repositories lists nothing, which is its state on a
        * fresh install and looks exactly like a broken screen. So the empty case
        * offers the community repository by name rather than asking for a URL
        * nobody has.
        */}
      {data && data.repos.length === 0 && onHost && (
        <p className="banner">The host's copy has no extension repository set yet, so there is nothing to ask for.</p>
      )}
      {data && data.repos.length === 0 && !onHost && (
        <div className="banner">
          <p>No extension repository is set, so there is nothing to install from.</p>
          <button
            className="btn primary"
            disabled={busy !== null}
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
          {waiting.length > 0 && (
            <>
              <h3>{onHost ? 'You asked for' : Object.keys(askedBy).length > 0 ? 'Asked for' : 'Flagged to install'}</h3>
              {waiting.map(row)}
            </>
          )}

          <div className="row between" style={{ alignItems: 'center', marginTop: 16 }}>
            <h3 style={{ margin: 0 }}>Installed</h3>
            {/*
              Always there, not only when something is out of date: the list
              says what Suwayomi last heard from the repositories, and this asks
              them again before updating, so it can find an update the list has
              not shown yet.
            */}
            {!onHost && (
              <button
                className={outdated.length > 0 ? 'btn primary' : 'btn subtle'}
                disabled={busy !== null || installed.length === 0}
                onClick={() =>
                  act('update-all', async () => {
                    setUpdated((await manga.extensions.updateAll()).note);
                  })
                }
              >
                {busy === 'update-all' ? 'Updating…' : outdated.length > 0 ? `Update all (${outdated.length})` : 'Check for updates'}
              </button>
            )}
          </div>
          {onHost && (
            <p className="meta">These are on the host's Suwayomi, which every copy shares. The host adds, updates and removes them.</p>
          )}
          {updated && <p className="meta">{updated[0]!.toUpperCase() + updated.slice(1)}.</p>}
          {data.autoUpdate !== undefined && !onHost && (
            <label className="meta" style={{ display: 'block', marginTop: 4 }}>
              <input
                type="checkbox"
                checked={data.autoUpdate}
                disabled={busy !== null}
                onChange={(e) => act('auto', () => manga.extensions.setAutoUpdate(e.target.checked))}
              />{' '}
              Update them by themselves once a day, while Suwayomi is running
              {data.lastCheck
                ? ` · last: ${new Date(data.lastCheck.at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}, ${data.lastCheck.note}`
                : ''}
            </label>
          )}
          {installed.length === 0 && <p className="empty">None yet. Find one below to add.</p>}
          {installed.map(row)}

          <h3>{onHost ? 'Ask for one' : 'Add one'}</h3>
          <div className="row">
            <input
              value={query}
              placeholder="Site name, or a language code like en"
              onChange={(e) => {
                setQuery(e.target.value);
                setShown(PAGE);
              }}
              aria-label="Search extensions"
            />
          </div>
          <p className="meta">
            {searching
              ? `${available.length} match${available.length === 1 ? '' : 'es'}, in every language.`
              : `${available.length} in ${languages.length > 0 ? languages.join(', ') : 'your languages'} and multi-language, of ${all.length}. Search to look in every language.`}
          </p>
          {searching && available.length === 0 && <p className="empty">Nothing matched.</p>}
          {available.slice(0, shown).map(row)}
          {available.length > shown && (
            <button className="btn subtle" onClick={() => setShown((n) => n + PAGE)}>
              Show {Math.min(PAGE, available.length - shown)} more
            </button>
          )}
        </>
      )}
    </div>
  );
}
