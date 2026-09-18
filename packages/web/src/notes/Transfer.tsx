/**
 * Bringing notes in from another app, and taking them out again.
 *
 * ### The format is detected, and shown before anything is written
 *
 * A dropdown of fourteen formats asks somebody to know what their own export
 * is, which is the thing they are least sure about. So the file is read, the
 * format is named back — *"that looks like an Evernote export, 412 notes"* —
 * and only then is there a button that writes. The preview is the whole point:
 * a wrong guess costs a click rather than a thousand rows.
 */
import { useState } from 'react';
import { api, type NoteImportResult } from '../api';
import { useAsync } from '../useAsync';

export function NoteTransfer({
  local,
  folder,
  onImported,
}: {
  local: boolean;
  folder: string | undefined;
  onImported: () => void;
}) {
  const formats = useAsync(() => api.notes.formats(), [], []);
  const [pending, setPending] = useState<{ name: string; data: string } | null>(null);
  const [preview, setPreview] = useState<NoteImportResult | null>(null);
  const [into, setInto] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [done, setDone] = useState('');

  async function inspect(file: File) {
    setProblem('');
    setDone('');
    setBusy(true);
    try {
      const data = await toBase64(file);
      const result = await api.notes.import({ name: file.name, data });
      setPending({ name: file.name, data });
      setPreview(result);
      setInto(result.formatLabel);
    } catch (error) {
      setPending(null);
      setPreview(null);
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!pending) return;
    setBusy(true);
    setProblem('');
    try {
      const result = await api.notes.import({ ...pending, commit: true, folder: into });
      setDone(`Brought in ${result.committed} ${result.committed === 1 ? 'note' : 'notes'}${result.folder ? ` under ${result.folder}` : ''}.`);
      setPending(null);
      setPreview(null);
      onImported();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function download(format: string) {
    setProblem('');
    setBusy(true);
    try {
      const { fileName, blob } = await api.notes.export({ format, folder });
      /*
       * A blob and a synthetic click, because `/api/` needs a bearer token and
       * an `<a download href="/api/…">` sends none — the same constraint that
       * put the icons and the tones outside `/api/` and the habit pictures
       * behind a fetch.
       */
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="card">
        <div className="title">Bring notes in</div>
        <div className="meta" style={{ marginTop: 4 }}>
          Drop an export in and it works out what it is. Nothing is written until you have seen what it found.
        </div>

        {!local && (
          <div className="meta urgent" style={{ marginTop: 8 }}>
            Importing only works from the PC running the app.
          </div>
        )}

        {local && (
          <label className="notes-drop">
            <input
              type="file"
              accept=".zip,.enex,.json,.jex,.md,.markdown,.txt,.csv,.html,.htm,.docx,.bearnote,.textbundle"
              onChange={(event) => {
                const file = event.target.files?.[0];
                // Cleared so choosing the same file twice fires again, which is
                // exactly what somebody does after a failed attempt.
                event.target.value = '';
                if (file) void inspect(file);
              }}
            />
            <span>{busy ? 'Reading…' : 'Choose a file'}</span>
          </label>
        )}

        {problem && <div className="banner" style={{ marginTop: 8 }}>{problem}</div>}
        {done && <div className="meta" style={{ marginTop: 8 }}>{done}</div>}

        {preview && (
          <div className="notes-preview">
            <div className="title" style={{ marginTop: 10 }}>
              That looks like {preview.formatLabel} — {preview.total}{' '}
              {preview.total === 1 ? 'note' : 'notes'}
            </div>

            {preview.notes.map((note, i) => (
              <div key={i} className="card" style={{ marginTop: 6 }}>
                <div className="title truncate">{note.title || '(untitled)'}</div>
                <div className="meta notes-peek">{note.body.slice(0, 160) || '(empty)'}</div>
                {(note.folder || note.tags.length > 0) && (
                  <div className="meta">
                    {note.folder ? `${note.folder} · ` : ''}
                    {note.tags.map((tag) => `#${tag}`).join(' ')}
                  </div>
                )}
              </div>
            ))}

            {preview.total > preview.notes.length && (
              <div className="meta" style={{ marginTop: 6 }}>
                …and {preview.total - preview.notes.length} more.
              </div>
            )}

            {preview.skipped.length > 0 && (
              <div className="meta" style={{ marginTop: 8 }}>
                Not brought in:{' '}
                {preview.skipped.slice(0, 5).map((entry) => `${entry.name} (${entry.why})`).join(', ')}
                {preview.skipped.length > 5 ? `, and ${preview.skipped.length - 5} more` : ''}
              </div>
            )}

            <div className="row" style={{ gap: '.4rem', marginTop: 10 }}>
              <div className="grow">
                <input
                  value={into}
                  aria-label="Folder to import into"
                  placeholder="Folder — blank to merge into the root"
                  onChange={(event) => setInto(event.target.value)}
                />
              </div>
              <button className="btn primary" disabled={busy} onClick={() => void commit()}>
                Bring in {preview.total}
              </button>
              <button className="btn subtle" disabled={busy} onClick={() => { setPreview(null); setPending(null); }}>
                Cancel
              </button>
            </div>
            <div className="meta" style={{ marginTop: 6 }}>
              {/* Merging somebody's whole Evernote into an existing notebook is
                  not something that can be undone by hand. */}
              A folder can be taken apart afterwards; a merge cannot.
            </div>
          </div>
        )}

        <div className="meta" style={{ marginTop: 10 }}>
          Reads:{' '}
          {(formats.data?.import ?? []).map((format) => format.label).join(', ')}.
        </div>
      </div>

      <div className="card">
        <div className="title">Take notes out</div>
        <div className="meta" style={{ marginTop: 4 }}>
          {folder ? `Everything in ${folder}.` : 'Every note.'} The vault is a real Obsidian vault — unzip it
          into Obsidian and the [[links]] work, because they were Obsidian's syntax all along.
        </div>

        <div className="row wrap" style={{ gap: '.35rem', marginTop: 8 }}>
          {(formats.data?.export ?? []).map((format) => (
            <button key={format.id} className="btn subtle" disabled={busy} title={format.hint} onClick={() => void download(format.id)}>
              {format.label}
            </button>
          ))}
        </div>

        <div className="meta" style={{ marginTop: 8 }}>
          {/* Said here rather than discovered on opening the file. */}
          PDF and Word flatten the links; CSV and plain text flatten the formatting too. The PDF uses the
          fonts every reader has, so it can only draw Latin alphabets — an emoji or a line of Chinese comes
          out as a question mark. Everything else is UTF-8 and loses nothing.
        </div>
      </div>
    </>
  );
}

/**
 * A file's bytes as base64, in chunks.
 *
 * `String.fromCharCode(...bytes)` on a 200MB import is an argument list long
 * enough to blow the stack, and the failure looks like the file being rejected.
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
