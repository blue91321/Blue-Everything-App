/**
 * Play your songs in a properly random order on Spotify — see
 * `spotify-shuffle.ts` and `shuffle-rules.ts`.
 *
 * Two orders:
 * - **Shuffle** — every song once, evenly. What Spotify's shuffle should be:
 *   it favours the same few dozen songs of a long playlist and carries its
 *   order between devices.
 * - **Random** — drawn afresh for every slot, so a song can come back, but not
 *   until a number of others have played. Songs and artists can be boosted to
 *   come up more often.
 *
 * Either is played straight away or added to the queue; no playlist is made.
 * A song listed twice — in two playlists, or as both the single and the album
 * version — counts once.
 *
 * Which lists, which order and the gap are remembered per device, like the
 * Library's sort. Boosts are on the server, so they are the same everywhere.
 */
import { useMemo, useState } from 'react';
import { api } from '@app/api';
import { useAsync } from '@app/useAsync';
import { isMobile } from '@app/device';

const PICKS = 'spotify-shuffle-picks';
const ORDER = 'spotify-shuffle-order';
const GAP = 'spotify-shuffle-gap';
const RECENT = 'spotify-shuffle-recent';
const FRESH = 'spotify-shuffle-fresh';

function stored<T>(key: string, fallback: T, valid: (v: unknown) => v is T): T {
  try {
    const raw = localStorage.getItem(key);
    const v = raw === null ? null : (JSON.parse(raw) as unknown);
    return valid(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function keep(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Remembered for this visit only.
  }
}

/** Up for more often, down for less; 0 leaves it out of Random altogether. */
const BOOSTS = [10, 5, 3, 2, 1.5];
const DAMPS = [0.5, 0.25, 0.1];

export function Shuffle() {
  const info = useAsync(() => api.integrations.shuffleSources(), [], ['integrations']);
  // Null means "every list", so a playlist made later is in without ticking it.
  const [picks, setPicks] = useState<string[] | null>(() =>
    stored(PICKS, null, (v): v is string[] | null => v === null || (Array.isArray(v) && v.every((x) => typeof x === 'string')))
  );
  const [order, setOrder] = useState<'shuffle' | 'random'>(() =>
    stored(ORDER, 'shuffle', (v): v is 'shuffle' | 'random' => v === 'shuffle' || v === 'random')
  );
  const [gap, setGap] = useState<number>(() => stored(GAP, 50, (v): v is number => typeof v === 'number' && v >= 0));
  /*
   * Random's recency settings: songs heard within `within` songs weighted down
   * by `factor`, songs not heard within `after` songs weighted up by theirs.
   * A count of 0 is off. Per device, like the gap.
   */
  const [recent, setRecent] = useState<{ within: number; factor: number }>(() =>
    stored(RECENT, { within: 0, factor: 0.5 }, (v): v is { within: number; factor: number } =>
      typeof v === 'object' && v !== null && typeof (v as { within?: unknown }).within === 'number'
    )
  );
  const [fresh, setFresh] = useState<{ after: number; factor: number }>(() =>
    stored(FRESH, { after: 0, factor: 2 }, (v): v is { after: number; factor: number } =>
      typeof v === 'object' && v !== null && typeof (v as { after?: unknown }).after === 'number'
    )
  );
  const [search, setSearch] = useState('');
  const [browse, setBrowse] = useState<'artists' | 'songs'>('artists');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ songs: number; of: number; mode: 'play' | 'queue'; device: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The queue-ahead box while it is being typed in; null shows the saved number.
  const [aheadDraft, setAheadDraft] = useState<string | null>(null);

  /*
   * Only what the ticked lists hold, narrowed by the search box. Artists are
   * counted here from those songs, so the counts change with the ticks — an
   * artist with eleven songs across everything may have two in the list you
   * are about to play. A credit lists names in the same order as the ids.
   */
  const inPlay = useMemo(() => {
    if (!info.data) return { songs: [], artists: [], names: new Map<string, string>() };
    const ticked = picks === null ? null : new Set(picks);
    const songs = info.data.songs.filter((s) => !ticked || s.lists.some((l) => ticked.has(l)));
    const names = new Map<string, string>();
    const counts = new Map<string, number>();
    for (const s of info.data.songs) {
      const parts = s.artist.split(', ');
      s.artistIds.forEach((id, i) => {
        if (!names.has(id)) names.set(id, parts[i] ?? parts[0] ?? id);
      });
    }
    for (const s of songs) for (const id of s.artistIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    const artists = [...counts]
      .map(([id, n]) => ({ id, name: names.get(id) ?? id, songs: n }))
      .sort((a, b) => b.songs - a.songs || a.name.localeCompare(b.name));
    return { songs, artists, names };
  }, [info.data, picks]);

  const found = useMemo(() => {
    const q = search.trim().toLowerCase();
    return {
      artists: q ? inPlay.artists.filter((a) => a.name.toLowerCase().includes(q)) : inPlay.artists,
      songs: (q
        ? inPlay.songs.filter((s) => s.title.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q))
        : inPlay.songs
      )
        .slice()
        .sort((a, b) => a.title.localeCompare(b.title)),
    };
  }, [search, inPlay]);

  if (!info.data || !info.data.connected) return null;
  const { sources, canPlay, weights, session } = info.data;

  /*
   * Yours: Liked Songs first, then the playlists you made. Ones saved from
   * somebody else can't be used — a Development Mode app may not read a
   * playlist you do not own, so the sync never gets their songs — and they
   * are left out, with a line saying why and what to do instead.
   */
  const readable = sources.filter((s) => s.readable);
  const liked = readable.filter((s) => s.kind === 'saved');
  const mine = readable.filter((s) => s.kind !== 'saved');
  const chosen = picks ? readable.filter((s) => picks.includes(s.id)) : readable;
  const isOn = (id: string) => chosen.some((c) => c.id === id);

  const choose = (ids: string[]) => {
    const kept = readable.filter((s) => ids.includes(s.id)).map((s) => s.id);
    const next = kept.length === readable.length ? null : kept;
    setPicks(next);
    keep(PICKS, next);
  };
  const toggle = (id: string) => choose(isOn(id) ? chosen.map((s) => s.id).filter((x) => x !== id) : [...chosen.map((s) => s.id), id]);
  const setGroup = (group: typeof readable, on: boolean) => {
    const ids = new Set(chosen.map((s) => s.id));
    for (const s of group) {
      if (on) ids.add(s.id);
      else ids.delete(s.id);
    }
    choose([...ids]);
  };

  /*
   * The fewest songs that can sit in the queue. In Random a song is kept out
   * for `gap` songs after it plays, so a queue shorter than that would be
   * topping up with less of the gap visible than the rule promises. There is
   * no upper limit: each song is one request when it is added, and that is
   * the only cost.
   */
  /*
   * And the most: the number of songs in the ticked lists, a song in several
   * counting once. Queueing more than that can only mean queueing repeats —
   * in Shuffle the next round's, in Random whatever the gap no longer holds
   * back. The gap is held one below it for the same reason: a gap as long as
   * the list would leave nothing allowed to play.
   */
  // …and never more than a hundred: each song queued is a request of its own,
  // and the server holds the same line to stay under Spotify's rate limit.
  const maxAhead = Math.max(1, Math.min(100, inPlay.songs.length));
  // The gap is held by the list's length, not the queue's: the dealer keeps it
  // whatever the queue holds.
  const effectiveGap = Math.min(gap, Math.max(0, inPlay.songs.length - 1));
  const minAhead = order === 'random' ? Math.min(maxAhead, Math.max(1, effectiveGap)) : 1;
  const ahead = Math.min(maxAhead, Math.max(session.queueAhead, minAhead));

  const saveAhead = async () => {
    if (aheadDraft === null) return;
    const n = Number(aheadDraft);
    setAheadDraft(null);
    if (!aheadDraft || n === session.queueAhead) return;
    try {
      await api.integrations.setQueueAhead(Math.min(maxAhead, Math.max(minAhead, n)));
      info.reload();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };

  const stop = async (pause: boolean) => {
    await api.integrations.stopShuffle(pause);
    info.reload();
  };

  const deal = async (mode: 'play' | 'queue') => {
    setBusy(true);
    setProblem(null);
    setDone(null);
    try {
      setDone(
        await api.integrations.shuffle(mode, picks ? chosen.map((s) => s.id) : undefined, order, effectiveGap, {
          recent: recent.within > 0 ? recent : undefined,
          fresh: fresh.after > 0 ? fresh : undefined,
        }, isMobile() ? 'phone' : 'computer')
      );
      info.reload();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const boost = async (kind: 'song' | 'artist', id: string, weight: number) => {
    try {
      await api.integrations.setShuffleWeight(kind, id, weight);
      info.reload();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };

  const songName = (uri: string) => {
    const s = info.data!.songs.find((x) => x.uri === uri);
    return s ? `${s.title} — ${s.artist}` : uri;
  };
  const artistName = (id: string) => inPlay.names.get(id) ?? id;
  const boosted = [
    ...Object.entries(weights.artists).map(([id, w]) => ({ kind: 'artist' as const, id, w, name: artistName(id) })),
    ...Object.entries(weights.songs).map(([id, w]) => ({ kind: 'song' as const, id, w, name: songName(id) })),
  ];

  const boostPicker = (kind: 'song' | 'artist', id: string, current: number) => (
    <select value={current} onChange={(e) => void boost(kind, id, Number(e.target.value))} aria-label="How much more often">
      {BOOSTS.map((b) => (
        <option key={b} value={b}>
          ×{b} more
        </option>
      ))}
      <option value={1}>no boost</option>
      {DAMPS.map((b) => (
        <option key={b} value={b}>
          ×{b} less
        </option>
      ))}
      <option value={0}>never</option>
    </select>
  );

  const group = (title: string, items: typeof readable) =>
    items.length > 0 && (
      <div className="shuffle-group">
        <div className="shuffle-group-head">
          <b>{title}</b>
          {items.length > 1 && (
            <span className="shuffle-group-all">
              <button className="link" onClick={() => setGroup(items, true)}>
                all
              </button>
              {' · '}
              <button className="link" onClick={() => setGroup(items, false)}>
                none
              </button>
            </span>
          )}
        </div>
        <div className="shuffle-chips">
          {items.map((s) => (
            <button
              key={s.id}
              className={isOn(s.id) ? 'shuffle-chip on' : 'shuffle-chip'}
              aria-pressed={isOn(s.id)}
              onClick={() => toggle(s.id)}
            >
              {s.name} <span className="meta">{s.itemCount}</span>
            </button>
          ))}
        </div>
      </div>
    );

  const songCount = inPlay.songs.length;
  const summary =
    `${chosen.length} of ${readable.length} lists · ${songCount} songs · ` +
    (order === 'random' ? `random, repeats after ${effectiveGap}` : 'shuffle') +
    ` · ${ahead} queued ahead` +
    (order === 'random' && recent.within > 0 ? ` · recent ×${recent.factor}` : '') +
    (order === 'random' && fresh.after > 0 ? ` · unplayed ×${fresh.factor}` : '') +
    (boosted.length > 0 && order === 'random' ? ` · ${boosted.length} boosted` : '');

  return (
    <div className="card">
      <div className="title">Shuffle properly</div>
      <div className="meta" style={{ marginTop: 2 }}>
        Spotify's shuffle keeps coming back to the same few songs, and picks its order back up on another device. This
        picks the order here and has Spotify play it through the queue, topped up as it goes. No playlist is made, and
        a song in several lists counts once.
      </div>

      {!canPlay && (
        <div className="meta" style={{ marginTop: '.5rem', color: 'var(--danger)' }}>
          Spotify hasn't let this app control playback yet. Press Connect on Spotify once, on the Services tab on the
          PC, to allow it.
        </div>
      )}

      <div style={{ display: 'flex', gap: '.75rem', alignItems: 'center', marginTop: '.75rem', flexWrap: 'wrap' }}>
        <button className="btn primary" disabled={busy || !canPlay || chosen.length === 0} onClick={() => void deal('play')}>
          {busy ? 'Working…' : order === 'random' ? 'Play random' : 'Play shuffled'}
        </button>
        <button className="btn" disabled={busy || !canPlay || chosen.length === 0} onClick={() => void deal('queue')}>
          Add to queue
        </button>
      </div>

      {/*
        Neither button cuts off the song that is on. There was a choice to, and
        it went: Spotify will not let an app empty a queue, so everything here
        is adding to it, and interrupting the song bought nothing but a skip.
      */}
      <div className="meta" style={{ marginTop: '.4rem' }}>
        <b>Play</b> lets the song on finish and plays the shuffle after it, in place of the rest of its album or
        playlist. <b>Add to queue</b> puts it after everything already lined up. Songs already in your Spotify queue
        play first either way: Spotify doesn't let apps remove them.
      </div>

      {session.active ? (
        /*
         * On, and saying so where it cannot be missed: a coloured bar with what
         * is playing where, and the two ways to end it. It updates as songs
         * finish — the session announces each one.
         */
        <div className="shuffle-on" role="status">
          <span className="shuffle-on-dot" aria-hidden="true" />
          <span className="shuffle-on-text">
            <b>{session.order === 'random' ? 'Random' : 'Shuffle'} is on</b> · {session.device} · {session.played}{' '}
            played, {session.queued} queued
            {/* What it is playing — which may not be what this device's Settings say. */}
            <span className="meta" style={{ display: 'block' }}>
              from {session.lists.join(', ') || 'your lists'}
              {session.repeatAfter !== null ? ` · repeats after ${session.repeatAfter}` : ''}
            </span>
          </span>
          <span className="shuffle-on-buttons">
            <button className="btn primary" onClick={() => void stop(true)}>
              Stop
            </button>
            <button className="btn" onClick={() => void stop(false)} title="End it but let the queued songs play on">
              Stop adding songs
            </button>
          </span>
        </div>
      ) : session.ended ? (
        <div className="meta" style={{ marginTop: '.5rem' }}>
          Stopped topping up: {session.ended.why}.
        </div>
      ) : (
        done && (
          <div className="meta" style={{ marginTop: '.5rem' }}>
            {done.mode === 'play' ? `Started on ${done.device}.` : `Queued on ${done.device}.`}
          </div>
        )
      )}
      {problem && (
        <div className="meta" style={{ marginTop: '.5rem', color: 'var(--danger)' }}>
          {problem}
        </div>
      )}

      {/*
        * Everything that is set rather than pressed, folded under one line that
        * says what it is set to — so the card is two buttons and a sentence,
        * and nothing has to be opened to know what Play will do.
        */}
      <details className="shuffle-settings">
        <summary>
          <b>Settings</b>
          <div className="meta">{summary}</div>
        </summary>

        <div className="shuffle-section">
          <div className="shuffle-label">Play from</div>
          {group('Yours', [...liked, ...mine])}
          <div className="meta" style={{ marginTop: '.4rem' }}>
            Only playlists you made can be used: Spotify won't let this app read ones you saved from someone else. To
            use one, copy its songs into one of your playlists.
          </div>
        </div>

        <div className="shuffle-section">
          <div className="shuffle-label">Order</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem 1rem' }}>
            <label style={{ display: 'flex', gap: '.4rem', alignItems: 'center' }}>
              <input
                type="radio"
                checked={order === 'shuffle'}
                onChange={() => {
                  setOrder('shuffle');
                  keep(ORDER, 'shuffle');
                }}
              />
              Shuffle <span className="meta">every song once</span>
            </label>
            <label style={{ display: 'flex', gap: '.4rem', alignItems: 'center' }}>
              <input
                type="radio"
                checked={order === 'random'}
                onChange={() => {
                  setOrder('random');
                  keep(ORDER, 'random');
                }}
              />
              Random <span className="meta">songs can come back, boosts count</span>
            </label>
          </div>
          {order === 'random' && (
            <label style={{ display: 'flex', gap: '.5rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '.5rem' }}>
              A song can play again after
              <input
                inputMode="numeric"
                value={String(gap)}
                style={{ width: '5em' }}
                onChange={(e) => {
                  const n = Math.max(0, Number(e.target.value.replace(/\D/g, '')) || 0);
                  setGap(n);
                  keep(GAP, n);
                }}
              />
              other songs
            </label>
          )}
          {/*
            The number typed is kept, so ticking more lists later raises the gap
            back to it; only what is used is held below the song count.
          */}
          {order === 'random' && gap > effectiveGap && (
            <div className="meta" style={{ marginTop: '.25rem' }}>
              Held at {effectiveGap}: the lists you picked have {maxAhead} songs, and a gap as long as that would leave
              nothing to play.
            </div>
          )}
          {order === 'random' && (
            <>
              <label className="shuffle-recency">
                Played in the last
                <input
                  inputMode="numeric"
                  value={recent.within === 0 ? '' : String(recent.within)}
                  placeholder="0"
                  style={{ width: '4.5em' }}
                  onChange={(e) => {
                    const v = { ...recent, within: Number(e.target.value.replace(/\D/g, '')) || 0 };
                    setRecent(v);
                    keep(RECENT, v);
                  }}
                />
                songs:
                <select
                  value={recent.factor}
                  onChange={(e) => {
                    const v = { ...recent, factor: Number(e.target.value) };
                    setRecent(v);
                    keep(RECENT, v);
                  }}
                >
                  {[0.75, 0.5, 0.25, 0.1].map((f) => (
                    <option key={f} value={f}>
                      ×{f} less
                    </option>
                  ))}
                </select>
              </label>
              <label className="shuffle-recency">
                Not played in the last
                <input
                  inputMode="numeric"
                  value={fresh.after === 0 ? '' : String(fresh.after)}
                  placeholder="0"
                  style={{ width: '4.5em' }}
                  onChange={(e) => {
                    const v = { ...fresh, after: Number(e.target.value.replace(/\D/g, '')) || 0 };
                    setFresh(v);
                    keep(FRESH, v);
                  }}
                />
                songs:
                <select
                  value={fresh.factor}
                  onChange={(e) => {
                    const v = { ...fresh, factor: Number(e.target.value) };
                    setFresh(v);
                    keep(FRESH, v);
                  }}
                >
                  {[1.5, 2, 3, 5].map((f) => (
                    <option key={f} value={f}>
                      ×{f} more
                    </option>
                  ))}
                </select>
              </label>
              <div className="meta" style={{ marginTop: '.25rem' }}>
                Leave a count empty to switch it off. "Played" includes the last 50 songs Spotify remembers from before
                you pressed Play.
              </div>
            </>
          )}
        </div>

        <div className="shuffle-section">
          <div className="shuffle-label">Queue</div>
          <label style={{ display: 'flex', gap: '.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            Keep
            <input
              inputMode="numeric"
              value={aheadDraft ?? String(ahead)}
              style={{ width: '5em' }}
              onChange={(e) => setAheadDraft(e.target.value.replace(/\D/g, ''))}
              onBlur={() => void saveAhead()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveAhead();
              }}
            />
            songs queued ahead, topped up as they play
          </label>
          <div className="meta" style={{ marginTop: '.25rem' }}>
            {order === 'random'
              ? `Between ${minAhead} (the songs before one can come back) and ${maxAhead} (the songs in the lists you picked).`
              : `Between 1 and ${maxAhead}, the songs in the lists you picked.`}
          </div>
        </div>

        {order === 'random' && (
          <details className="shuffle-boosts">
            <summary>
              <b>Boosts</b>
              {boosted.length > 0 ? ` · ${boosted.length} set` : ''}
              <div className="meta">add weights to random play</div>
            </summary>
            {boosted.length > 0 && (
              <div className="shuffle-list" style={{ marginTop: '.4rem', maxHeight: 'none' }}>
                {boosted.map((b) => (
                  <div key={`${b.kind}:${b.id}`} className="shuffle-row">
                    <span className="shuffle-name">
                      {b.kind === 'artist' ? '🎤 ' : '♪ '}
                      {b.name}
                    </span>
                    {boostPicker(b.kind, b.id, b.w)}
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: '.5rem', marginTop: '.75rem', flexWrap: 'wrap' }}>
              <button className={browse === 'artists' ? 'btn primary' : 'btn'} onClick={() => setBrowse('artists')}>
                Artists {found.artists.length}
              </button>
              <button className={browse === 'songs' ? 'btn primary' : 'btn'} onClick={() => setBrowse('songs')}>
                Songs {found.songs.length}
              </button>
            </div>
            <input
              type="search"
              placeholder={browse === 'artists' ? 'Filter artists' : 'Filter songs or artists'}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: '100%', marginTop: '.5rem', boxSizing: 'border-box' }}
            />
            <div className="shuffle-list" style={{ marginTop: '.4rem' }}>
              {browse === 'artists'
                ? found.artists.map((a) => (
                    <div key={a.id} className="shuffle-row">
                      <span className="shuffle-name">
                        {a.name} <span className="meta">{a.songs === 1 ? '1 song' : `${a.songs} songs`}</span>
                      </span>
                      {boostPicker('artist', a.id, weights.artists[a.id] ?? 1)}
                    </div>
                  ))
                : found.songs.map((s) => (
                    <div key={s.uri} className="shuffle-row">
                      <span className="shuffle-name">
                        {s.title} <span className="meta">— {s.artist}</span>
                      </span>
                      {boostPicker('song', s.uri, weights.songs[s.uri] ?? 1)}
                    </div>
                  ))}
              {(browse === 'artists' ? found.artists : found.songs).length === 0 && (
                <div className="meta">Nothing matches.</div>
              )}
            </div>
          </details>
        )}
      </details>
    </div>
  );
}
