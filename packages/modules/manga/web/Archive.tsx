/**
 * What is being kept for good, on the PC.
 *
 * The server side is `archive.ts`, and the distinction it draws is the one this
 * card has to make on screen, because "download" already means two other things
 * here: the last ten chapters opened are a **cache** that evicts, and the
 * Downloads tab is **this device's** storage, which a phone may clear when it
 * runs short of space. An archive is neither — it is on the PC's disk, it is
 * complete, and nothing removes it but you.
 *
 * So the copy leads with that rather than with a number.
 *
 * **Failures are on the card, not behind it.** A backup that quietly has holes
 * is the stale-data-as-fact failure this app is built against, and the day you
 * find out is the day the site has gone. So a series with chapters it could not
 * fetch says so on its own row, in the warning colour, with the button that
 * tries them again.
 */
import { thePc } from '@app/device';
import { useState } from 'react';
import { useAsync } from '@app/useAsync';
import { manga, type ArchiveProgress, type CollectionRules } from './manga-api';

/** Bytes as something a person can hold in their head. */
export function sizeLabel(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} bytes`;
}

function Row({ series, onChanged, onHost }: { series: ArchiveProgress; onChanged: () => void; onHost: boolean }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setProblem('');
    try {
      await run();
      onChanged();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'that did not work');
    } finally {
      setBusy(false);
    }
  };

  const remove = () => {
    /*
     * Asked about, and the question names the number. There is no trash here —
     * the same reasoning the notes folder menu gives for its destructive half.
     */
    if (!confirm(`Delete the ${series.pages} saved pages of ${series.title} from this PC? This cannot be undone.`)) {
      return;
    }
    void act(() => manga.archive.stop(series.seriesId, true));
  };

  return (
    <div className="manga-row">
      <div className="manga-row-text">
        <span className="title truncate">{series.title}</span>
        <span className="meta">
          {series.complete} of {series.chapters} chapters · {series.pages} pages · {sizeLabel(series.bytes)}
          {series.queued > 0 && ` · ${series.queued} waiting`}
        </span>
        {/*
          The honest line. Kept separate from the counts above rather than
          folded into them, because "18 of 20" and "two chapters are missing and
          will not come" read as very different things and only the second is
          true.
        */}
        {series.failed > 0 && (
          <span className="meta warn">
            {series.failed} chapter{series.failed === 1 ? '' : 's'} could not be fetched
          </span>
        )}
        {(series.keptFor ?? []).some((who) => who !== 'you') && (
          <span className="meta">
            {/* Names come from the host, already as this person sees them: "you", or a display name. */}
            Kept for {(series.keptFor ?? []).join(', ')}
          </span>
        )}
        {problem && <span className="meta warn">{problem}</span>}
      </div>
      {/* On a friend's copy this is the host's store: it fills itself, and only the host lets one go. */}
      {!onHost && (
        <>
          <button
            className="btn"
            disabled={busy}
            title="Fetch anything missing, and try the failed chapters again"
            onClick={() => void act(() => manga.archive.start(series.seriesId))}
          >
            {busy ? '…' : 'Catch up'}
          </button>
          <button
            className="btn subtle"
            disabled={busy}
            title="Stop saving new chapters. What is already saved is kept."
            onClick={() => void act(() => manga.archive.stop(series.seriesId, false))}
          >
            Stop
          </button>
          <button className="btn subtle danger" disabled={busy} onClick={remove}>
            Delete
          </button>
        </>
      )}
    </div>
  );
}

export function Archive() {
  /*
   * No scope, like every other reader on this screen. The scopes in
   * `live.ts` are core's, and there is no `manga` one — adding it would be
   * core learning that a package exists, which is the rule `hidden_providers`
   * and the opaque panel ids both exist to keep. So this wakes on any change,
   * and `reload` covers the moments that matter.
   */
  const overview = useAsync(() => manga.archive.overview());
  const data = overview.data;

  return (
    <div className="card">
      <div className="row between">
        <h3>Kept for good</h3>
        {data && data.series.length > 0 && !data.onHost && (
          <button className="btn" onClick={() => void manga.archive.run().then(() => overview.reload())}>
            Fetch now
          </button>
        )}
      </div>

      <p className="meta">
        A whole series saved onto {thePc()}, and every new chapter as it comes out — so it is still here if the site
        goes down or you have no internet. This is not the Downloads tab, which saves to the device you are holding,
        and not the last-ten-chapters cache, which throws things away. Nothing here is ever removed but by you.
      </p>

      {overview.loading && <p className="empty">loading…</p>}

      {data && data.series.length === 0 && (
        <p className="empty">
          Nothing yet. Open a series, then <strong>Keep every chapter</strong> from the ⋯ menu on its chapter list.
        </p>
      )}

      {data && data.series.length > 0 && (
        <>
          {data.series.map((series) => (
            <Row key={series.seriesId} series={series} onChanged={overview.reload} onHost={data.onHost === true} />
          ))}

          <p className="meta" style={{ marginTop: 8 }}>
            {sizeLabel(data.disk?.bytes ?? data.bytes)} on disk
            {data.queued > 0 && ` · ${data.queued} chapter${data.queued === 1 ? '' : 's'} waiting`}
            {/*
              What it is doing right now, because a long series is hours and a
              card that only ever says "12 of 900" looks stuck.
            */}
            {data.working && ` · fetching chapter ${data.working.number}`}
          </p>
          <p className="meta">
            {/*
              Named rather than hidden. The whole point is that the files
              outlive this app, so you should be able to find them without it.
            */}
            Saved in <code>{data.root}</code>, as ordinary folders of numbered images.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * What adds to the Local collection by itself, and who sees your ratings.
 * Sharing is off unless chosen, as asked: the other two ways are listed and
 * marked as coming, so where they will be is not a surprise later.
 */
export function CollectionRulesCard() {
  const rules = useAsync(() => manga.collectionRules.get());
  const [problem, setProblem] = useState('');
  const set = async (patch: Partial<CollectionRules>) => {
    setProblem('');
    try {
      await manga.collectionRules.set(patch);
      rules.reload();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'that could not be saved');
    }
  };
  const r = rules.data;
  return (
    <div className="card">
      <h3>Local collection and ratings</h3>
      {!r ? (
        <p className="meta">{rules.error ? `Could not load: ${rules.error.message}` : 'loading…'}</p>
      ) : (
        <>
          <p className="meta">Added to the Local collection by themselves, every chapter, as "Keep every chapter in the Local collection" does:</p>
          <label className="row" style={{ gap: 8 }}>
            <input type="checkbox" checked={r.autoKeepFavourites} onChange={(e) => void set({ autoKeepFavourites: e.target.checked })} />
            <span>Every favourite</span>
          </label>
          <label className="row" style={{ gap: 8 }}>
            <input
              type="checkbox"
              checked={r.autoKeepMinRating !== null}
              onChange={(e) => void set({ autoKeepMinRating: e.target.checked ? 8 : null })}
            />
            <span>Anything I rate</span>
            <select
              value={r.autoKeepMinRating ?? 8}
              disabled={r.autoKeepMinRating === null}
              onChange={(e) => void set({ autoKeepMinRating: Number(e.target.value) })}
              aria-label="Lowest rating to keep"
            >
              {[10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <span>or higher</span>
          </label>
          <p className="meta">A few series are added each time new chapters are checked, so a long list fills in over a few hours.</p>

          <h3>Share my ratings</h3>
          <label className="row" style={{ gap: 8 }}>
            <input
              type="checkbox"
              checked={r.shareRatingsWithCopies}
              onChange={(e) => void set({ shareRatingsWithCopies: e.target.checked })}
            />
            <span>With friends who share this Blue Everything, who see them on a series' page</span>
          </label>
          <label className="row meta" style={{ gap: 8 }}>
            <input type="checkbox" disabled checked={false} readOnly />
            <span>With other people's servers: coming, with linking servers</span>
          </label>
          <label className="row meta" style={{ gap: 8 }}>
            <input type="checkbox" disabled checked={false} readOnly />
            <span>Export to MyAnimeList or AniList: coming</span>
          </label>
        </>
      )}
      {problem && <p className="banner">{problem}</p>}
    </div>
  );
}
