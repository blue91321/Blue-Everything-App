/**
 * Bringing a library in from Manga Reader, and following it being found.
 *
 * Two-phase like the notes import: the file is read and what it holds is said
 * back — how many favourites, how many you read this year — and only then is
 * there a button that writes. The scope is chosen there, with the count beside
 * each choice, because "everything since 2019" and "what I read lately" are
 * both reasonable answers and nobody can pick between them without the numbers.
 *
 * After it lands, the same card follows the background search that links each
 * series to one of your sources. That list is the one place the imported
 * series without a source are gathered: the Needs a look card would otherwise
 * be several hundred rows long.
 */
import { useState } from 'react';
import { useAsync } from '@app/useAsync';
import { manga, type ImportScope, type MangaReaderImport, type MatchingState } from './manga-api';

const SCOPE_LABEL: Record<ImportScope, string> = {
  all: 'Everything',
  year: 'Read in the last year',
  quarter: 'Read in the last three months',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export function ImportCard({ local, onChanged }: { local: boolean; onChanged: () => void }) {
  const [data, setData] = useState<string | null>(null);
  const [preview, setPreview] = useState<MangaReaderImport | null>(null);
  const [scope, setScope] = useState<ImportScope>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // Refetched on every change, which is how the progress below moves: the
  // search announces itself every twenty series.
  const matching = useAsync(() => manga.import.matching(), []);
  const ignored = useAsync(() => manga.ignored.list(), []);

  async function setIgnored(id: string, name: string, on: boolean) {
    setProblem(null);
    try {
      await manga.ignored.set(id, name, on);
      ignored.reload();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'could not change that');
    }
  }

  async function inspect(file: File) {
    setProblem(null);
    setDone(null);
    setBusy('Reading…');
    try {
      const encoded = await toBase64(file);
      const found = await manga.import.mangaReader(encoded, 'all');
      setData(encoded);
      setPreview(found);
      setScope('all');
    } catch (error) {
      setData(null);
      setPreview(null);
      setProblem(error instanceof Error ? error.message : 'that file could not be read');
    } finally {
      setBusy(null);
    }
  }

  /** The add and merge counts depend on the scope, so the server is asked again. */
  async function choose(next: ImportScope) {
    if (!data) return;
    setScope(next);
    setBusy('Counting…');
    try {
      setPreview(await manga.import.mangaReader(data, next));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'that file could not be read');
    } finally {
      setBusy(null);
    }
  }

  async function commit() {
    if (!data) return;
    setBusy('Bringing it in…');
    setProblem(null);
    try {
      const result = await manga.import.mangaReader(data, scope, true);
      setDone(
        [
          `Brought in ${plural(result.added ?? 0, 'series', 'series')}`,
          result.merged ? `and added what you read to ${plural(result.merged, 'series', 'series')} you already followed` : '',
        ]
          .filter(Boolean)
          .join(' ') + '.'
      );
      setData(null);
      setPreview(null);
      onChanged();
      matching.reload();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'the import failed');
    } finally {
      setBusy(null);
    }
  }

  async function matchAgain() {
    setProblem(null);
    try {
      await manga.import.matchAgain();
      matching.reload();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'could not start');
    }
  }

  const state = matching.data;
  const showMatching = state && (state.running || state.total > 0 || (state.unmatched ?? 0) > 0);

  return (
    <div className="card manga-import">
      <h3>Bring in a library from Manga Reader</h3>
      <p className="meta">
        Back the app up in iMazing (Apps → Manga Reader → Back Up) and choose the <code>.imazingapp</code> it makes.
        Your favourites come across with what you had read and where you were; nothing is written until you have seen
        what it found.
      </p>

      {!local && <p className="meta urgent">Importing only works from the PC running the app.</p>}

      {local && !preview && (
        <label className="notes-drop">
          <input
            type="file"
            accept=".imazingapp,.zip"
            disabled={busy !== null}
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Cleared so choosing the same file again fires, which is what
              // somebody does after a failed attempt.
              event.target.value = '';
              if (file) void inspect(file);
            }}
          />
          <span>{busy ?? 'Choose the backup'}</span>
        </label>
      )}

      {problem && <p className="banner">{problem}</p>}
      {done && <p className="meta">{done}</p>}

      {preview && (
        <div className="manga-import-preview">
          <p>
            <strong>{plural(preview.favourites, 'favourite')}</strong>
            {preview.historyOnly > 0 && (
              <span className="meta">
                {' '}
                — and {plural(preview.historyOnly, 'series', 'series')} you opened and never favourited, which are
                left behind.
              </span>
            )}
          </p>

          <div className="manga-import-scopes" role="radiogroup" aria-label="How much to bring in">
            {(Object.keys(SCOPE_LABEL) as ImportScope[]).map((key) => (
              <button
                key={key}
                role="radio"
                aria-checked={scope === key}
                className={`btn${scope === key ? ' primary' : ''}`}
                disabled={busy !== null || preview.scopes[key] === 0}
                onClick={() => void choose(key)}
              >
                {SCOPE_LABEL[key]} <span className="count">{preview.scopes[key].toLocaleString()}</span>
              </button>
            ))}
          </div>

          <p className="meta">
            {plural(preview.add, 'new series', 'new series')}
            {preview.merge.length > 0 &&
              ` · ${preview.merge.length.toLocaleString()} you already follow, which gain what you read there`}
            {' · '}
            {plural(preview.readChapters, 'chapter')} marked read.
            {preview.bySite.length > 0 &&
              ` Read on ${preview.bySite
                .slice(0, 4)
                .map((s) => `${s.site} (${s.count.toLocaleString()})`)
                .join(', ')}${preview.bySite.length > 4 ? ` and ${preview.bySite.length - 4} more` : ''}.`}
          </p>
          <p className="meta">
            They arrive without a source. Each is then looked for, by its exact title, on the sites you read it on —
            in the background, most recently read first. Where you were within a chapter is not brought across: it
            counts pages of another site's copy.
          </p>

          <div className="row">
            <button className="btn primary" disabled={busy !== null || preview.add + preview.merge.length === 0} onClick={() => void commit()}>
              {busy ?? `Bring in ${(preview.add + preview.merge.length).toLocaleString()}`}
            </button>
            <button
              className="btn subtle"
              disabled={busy !== null}
              onClick={() => {
                setPreview(null);
                setData(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {showMatching && (
        <Matching
          state={state}
          ignoredIds={(ignored.data?.ignoredSources ?? []).map((s) => s.id)}
          onAgain={() => void matchAgain()}
          onIgnore={(id, name) => void setIgnored(id, name, true)}
        />
      )}

      {(ignored.data?.ignoredSources.length ?? 0) > 0 && (
        <div className="manga-import-matching">
          <p className="meta">Left out of searching, browsing and finding imports:</p>
          {ignored.data!.ignoredSources.map((s) => (
            <div className="row between" key={s.id}>
              <span>{s.name}</span>
              <button className="btn subtle" onClick={() => void setIgnored(s.id, s.name, false)}>
                Stop ignoring
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Matching({
  state,
  ignoredIds,
  onAgain,
  onIgnore,
}: {
  state: MatchingState;
  ignoredIds: string[];
  onAgain: () => void;
  onIgnore: (id: string, name: string) => void;
}) {
  const unmatched = state.unmatched ?? 0;
  return (
    <div className="manga-import-matching">
      {state.running ? (
        <>
          <p>
            Finding them on your sources: {state.done.toLocaleString()} of {state.total.toLocaleString()}
          </p>
          <progress max={Math.max(1, state.total)} value={state.done} />
          <p className="meta">
            {plural(state.linked, 'linked', 'linked')}
            {state.notFound > 0 && ` · ${state.notFound.toLocaleString()} not found under that title`}
            {state.failed > 0 && ` · ${state.failed.toLocaleString()} the site would not answer`}. You can read while
            this runs.
          </p>
        </>
      ) : (
        <>
          {state.problem && <p className="banner">{state.problem}</p>}
          {state.total > 0 && state.finishedAt !== null && (
            <p className="meta">
              Last search linked {state.linked.toLocaleString()} of {state.total.toLocaleString()}
              {state.notFound > 0 && `; ${state.notFound.toLocaleString()} were not found under that exact title`}
              {state.failed > 0 && `; ${state.failed.toLocaleString()} could not be asked`}.
            </p>
          )}
          {unmatched > 0 && (
            <p className="meta">
              {plural(unmatched, 'series', 'series')} from Manga Reader still{' '}
              {unmatched === 1 ? 'has' : 'have'} no source. Tap one in the library to find it by hand, or search
              again after installing an extension.
            </p>
          )}
        </>
      )}

      {(state.broken ?? [])
        .filter((b) => !b.id || !ignoredIds.includes(b.id))
        .map((b) => (
          <div key={b.source} className="row between">
            <p className="meta urgent">
              {b.source} refused searches and was skipped: {b.reason}. Its series were looked for on your other
              sources instead.
            </p>
            {b.id && (
              <button className="btn subtle" onClick={() => onIgnore(b.id!, b.source)}>
                Ignore it
              </button>
            )}
          </div>
        ))}

      {state.noSource.length > 0 && (
        <p className="meta">
          No source installed for{' '}
          {state.noSource
            .slice(0, 6)
            .map((s) => `${s.site} (${s.count.toLocaleString()})`)
            .join(', ')}
          {state.noSource.length > 6 ? ` and ${state.noSource.length - 6} more` : ''} — an extension for those would
          bring the most in.
        </p>
      )}

      {!state.running && unmatched > 0 && (
        <button className="btn" onClick={onAgain}>
          Search again
        </button>
      )}
    </div>
  );
}

/**
 * A file's bytes as base64, in chunks — `String.fromCharCode(...bytes)` on a
 * backup of any size is an argument list long enough to blow the stack. The
 * notes import has the same eight lines; that one is in a screen this package
 * cannot import without pulling the whole notebook in.
 */
async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
