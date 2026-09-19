/**
 * Where chapters come from, and whether it is answering.
 *
 * Its own component because it is the one part of this screen that can be in
 * four states with four different fixes — not configured, configured and
 * unreachable, reachable with no extensions, and working — and a card that
 * collapsed those into "not working" would be the write-only switch the Voice
 * screen exists as a warning about.
 *
 * It says plainly that Suwayomi is a separate program you run yourself. Nothing
 * here installs, downloads or starts it, and a card implying otherwise would be
 * a promise this module cannot keep.
 */
import { useState } from 'react';
import { useAsync } from '@app/useAsync';
import { manga } from './manga-api';

export function SourceCard({ local }: { local: boolean }) {
  const state = useAsync(() => manga.source.get());
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const data = state.data;
  const value = draft ?? data?.url ?? data?.defaultUrl ?? '';

  async function save(url: string) {
    setSaving(true);
    setProblem(null);
    try {
      await manga.source.set(url);
      setDraft(null);
      state.reload();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'could not save that');
    } finally {
      setSaving(false);
    }
  }

  return (
    <details className="card">
      <summary>
        Where chapters come from
        {data && (
          <span className="meta">
            {' · '}
            {!data.configured
              ? 'not set up'
              : data.health?.reachable
                ? `${data.health.sources.length} source${data.health.sources.length === 1 ? '' : 's'}`
                : 'not answering'}
          </span>
        )}
      </summary>

      <p className="meta">
        MangaUpdates only knows what scanlation groups have reported to it, which runs behind what sites actually
        carry. Pointing this at a reader that holds your sources lets it answer with what you could open right now.
      </p>
      <p className="meta">
        Suwayomi is a separate program you run yourself — nothing here installs, downloads or starts it. Once it is
        running, give its address below.
      </p>

      {/*
        * Changing this is refused away from the PC, because the address becomes
        * something the server POSTs to on a timer. Said here rather than left
        * to a 403, since from the phone the field would otherwise just fail.
        */}
      {!local && <p className="meta urgent">This can only be changed from the PC running the server.</p>}

      <div className="row">
        <input
          value={value}
          disabled={!local || saving}
          placeholder={data?.defaultUrl ?? 'http://127.0.0.1:4567'}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="Suwayomi address"
        />
        <button className="btn primary" disabled={!local || saving || !value.trim()} onClick={() => save(value.trim())}>
          {saving ? 'Checking…' : 'Save'}
        </button>
        {data?.configured && (
          <button className="btn subtle" disabled={!local || saving} onClick={() => save('')}>
            Clear
          </button>
        )}
      </div>

      {problem && <p className="banner">{problem}</p>}
      {state.error && <p className="banner">Could not load: {state.error.message}</p>}

      {data?.configured && data.health && !data.health.reachable && (
        <p className="meta urgent">{data.health.problem}</p>
      )}

      {/*
        * Running with nothing installed is its own state and its own fix. It
        * looks identical to "broken" from a chapter count that never moves, so
        * it is named rather than left to be worked out.
        */}
      {data?.health?.reachable && data.health.sources.length === 0 && (
        <p className="meta urgent">
          It is answering, but has no sources installed — add an extension repository in Suwayomi first.
        </p>
      )}

      {data?.health?.reachable && data.health.sources.length > 0 && (
        <p className="meta">Searching: {data.health.sources.slice(0, 6).join(', ')}</p>
      )}
    </details>
  );
}
