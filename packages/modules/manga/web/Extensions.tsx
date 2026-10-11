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
 * ### On a phone, flag instead of install
 *
 * Installing runs code on the PC, so it is the PC's to do. A phone can flag an
 * extension instead, which runs nothing; flagged ones wait at the top of this
 * screen on the PC with an Install button, and installing clears the flag.
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
  local,
  onClose,
  onBrowse,
}: {
  local: boolean;
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
  const searching = query.trim().length >= 2;
  const available = searching
    ? all.filter((e) => matches(e, query) && !e.installed)
    : all.filter((e) => !e.installed && inYourLanguages(e, languages)).sort((a, b) => a.name.localeCompare(b.name));

  const action = (e: SourceExtension) => {
    if (e.installed) {
      const target = browseTarget(use(e), languages);
      return (
        <>
          {target && (
            <button className="btn subtle" onClick={() => onBrowse(target)}>
              Browse
            </button>
          )}
          {local && (
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
    if (local) {
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
    }
    // Not this PC: a flag, which the PC will offer to install.
    const on = flagged.has(e.pkg);
    return (
      <button
        className={on ? 'btn primary' : 'btn'}
        aria-pressed={on}
        disabled={busy !== null}
        onClick={() => act(`f:${e.pkg}`, () => manga.extensions.flag(e.pkg, !on))}
        title={on ? 'Flagged: it will be waiting on the PC. Tap to unflag.' : 'Flag it to install on the PC'}
      >
        {busy === `f:${e.pkg}` ? '…' : on ? '⚑ Flagged' : '⚐ Flag'}
      </button>
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

      {!local && (
        <p className="meta">
          Installing happens on the PC, since an extension is code that runs there. Flag what you want here and it will be
          waiting at the top of this screen on the PC.
        </p>
      )}
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
          {waiting.length > 0 && (
            <>
              <h3>Flagged to install{local ? '' : ' on the PC'}</h3>
              {waiting.map(row)}
            </>
          )}

          <h3>Installed</h3>
          {installed.length === 0 && <p className="empty">None yet. Find one below to add.</p>}
          {installed.map(row)}

          <h3>Add one</h3>
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
