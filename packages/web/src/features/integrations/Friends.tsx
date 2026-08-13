/**
 * Who is online.
 *
 * The whole point of this screen is that **an empty list explains itself**. Six
 * services can contribute here and only one of them — Steam — works without a
 * caveat, so a bare "nobody is online" would be indistinguishable from "you
 * have not connected anything", "your Steam profile is private", "League is
 * closed", and "Discord has not approved this app". Those have five different
 * fixes, so the sources panel sits under the list and names the one that
 * applies.
 */
import { useState } from 'react';
import { api, type FriendRow, type FriendSource } from '../../api';
import { useAsync } from '../../useAsync';
import { relativeTime } from './Integrations';

const STATE_LABEL: Record<FriendRow['state'], string> = {
  'in-game': 'playing',
  online: 'online',
  away: 'away',
  offline: 'offline',
  /*
   * Named after the service rather than the absence.
   *
   * It read "status unknown", which is accurate and says nothing you can act
   * on. These rows are Discord friends and nothing else — Discord is the only
   * provider here whose API carries no presence — so naming the service tells
   * you where the entry came from and, by implication, why there is no status
   * next to it.
   */
  unknown: 'discord',
};

/**
 * Which service's people to show right now.
 *
 * `all` is a real value rather than an empty selection, so "showing everyone"
 * and "you have deselected everything" can never look the same.
 */
type Filter = 'all' | string;

/**
 * Does this person answer to what was typed?
 *
 * **Every handle they have, not only the name on the row.** A merged person is
 * shown under whichever account `IDENTITY_PREFERENCE` picked — Discord, almost
 * always — so searching the Steam persona you actually know them by would find
 * nothing while the row sat there in plain sight. That is the exact failure the
 * merge introduced, and the one a search box has to undo.
 *
 * The game is included too, which makes "who is in Arena" a search rather than a
 * scroll. It cannot be confused with a name match: both put the row on screen,
 * and the row says which it was.
 */
function matchesSearch(friend: FriendRow, needle: string): boolean {
  if (needle === '') return true;

  return (
    friend.name.toLowerCase().includes(needle) ||
    (friend.game ?? '').toLowerCase().includes(needle) ||
    friend.accounts.some((account) => account.name.toLowerCase().includes(needle))
  );
}

export function Friends() {
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  /*
   * The read refreshes stale providers server-side — see `refreshPresence` for
   * why there is no background poller. Watching the `integrations` scope means
   * the agent pushing a new Riot snapshot updates this list without the phone
   * having asked for anything.
   */
  const view = useAsync(() => api.integrations.friends(), [], ['integrations']);

  const forceRefresh = async () => {
    setRefreshing(true);
    try {
      await api.integrations.friends(true);
      view.reload();
    } finally {
      setRefreshing(false);
    }
  };

  if (view.loading) return <div className="empty">loading…</div>;
  if (view.error) return <div className="empty">Could not load: {view.error.message}</div>;
  if (!view.data) return null;

  /*
   * The selector shows a person if *any* of their accounts is on that service,
   * which is the opposite test to the hidden-services one below. Both readings
   * are right for what they do: picking Steam should include the friend you
   * also know from Discord, while hiding Riot should not remove them.
   */
  const needle = search.trim().toLowerCase();

  const shown = (
    filter === 'all'
      ? view.data.friends
      : view.data.friends.filter((f) => f.accounts.some((a) => a.provider === filter))
  ).filter((f) => matchesSearch(f, needle));

  const around = shown.filter((f) => f.state !== 'offline' && f.state !== 'unknown');
  const unknown = shown.filter((f) => f.state === 'unknown');
  const offline = shown.filter((f) => f.state === 'offline');

  return (
    <>
      {/*
        First, and on its own row.

        This list is 270 people; searching it is the main thing you do here, and
        it should not be the control you find last. The Following tab had its
        box wrapped below two rows of buttons for the same reason it was easy to
        miss there — both are now in the same place.
      */}
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search friends"
        aria-label="Search friends by name, handle, or what they are playing"
        type="search"
        style={{ marginBottom: '.75rem' }}
      />

      <PlatformFilter
        sources={view.data.sources}
        friends={view.data.friends}
        value={filter}
        onChange={setFilter}
      />

      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="meta">
          {/*
            While searching, the counts describe the *matches* — so they lead
            with how many there are. Without that, "1 online" over a filtered
            list reads as one person online out of everybody, which is a
            different and much more alarming statement.
          */}
          {needle ? `${shown.length} matching · ` : ''}
          {around.length === 0 ? 'Nobody online' : `${around.length} online`}
          {offline.length ? ` · ${offline.length} offline` : ''}
          {/* Counted separately and named, so a hundred rows nobody can vouch
              for never read as a hundred people who are definitely out. */}
          {unknown.length ? ` · ${unknown.length} unknown` : ''}
          {/*
            What the persistent filter is costing, and *where the switch is*.
            The panel moved to the Services tab, so a bare count would be the
            one thing on this screen you could not trace back — which is the
            opposite of what this screen is for.
          */}
          {view.data.hiddenCount ? ` · ${view.data.hiddenCount} hidden by Services` : ''}
        </div>
        <button className="btn subtle" onClick={forceRefresh} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* Hidden while searching: proposals about two other people are noise
          when you are looking for a third. */}
      {!needle && <Suggestions onLinked={view.reload} />}

      {/*
        A search that finds nobody says so, rather than leaving three empty
        sections and the sources panel to imply the integration broke.
      */}
      {needle && shown.length === 0 && (
        <div className="empty">
          Nobody matches "{search.trim()}"
          {filter === 'all' ? '' : ` on ${filter}`}.
          {view.data.hiddenCount
            ? ` ${view.data.hiddenCount} people are left out by the service filter on the Services tab.`
            : ''}
        </div>
      )}

      {around.map((friend) => (
        <FriendCard key={friend.id} friend={friend} onChanged={view.reload} />
      ))}



      {/*
        Offline friends stay on screen below a divider rather than being hidden
        behind a toggle — the same choice finished tasks get on the Dashboard.
        Knowing somebody exists and is not around is useful; making you click to
        find that out is not.
      */}
      {offline.length > 0 && (
        <>
          <div className="meta" style={{ margin: '1rem 0 .5rem' }}>Offline</div>
          <div className="done-area">
            {offline.map((friend) => (
              <FriendCard key={friend.id} friend={friend} onChanged={view.reload} />
            ))}
          </div>
        </>
      )}

      {/*
        Last, below offline. It sat between the two at first, on the reasoning
        that "I cannot tell" might be hiding somebody who is around — but there
        are a hundred of these against eighteen of everything else, so putting
        them in the middle buried the part of the list that answers the question.
      */}
      {unknown.length > 0 && (
        <>
          <div className="meta" style={{ margin: '1rem 0 .5rem' }}>
            Discord — its API carries no presence, so link one to a Steam account to see whether they are
            about
          </div>
          <div className="done-area">
            {unknown.map((friend) => (
              <FriendCard key={friend.id} friend={friend} onChanged={view.reload} />
            ))}
          </div>
        </>
      )}

      <Sources sources={view.data.sources} anyFriends={view.data.friends.length > 0} />
    </>
  );
}

/**
 * Show one service, or all of them.
 *
 * **Built from `sources`, never from a list written here.** That is what makes
 * adding a platform free: a new presence provider appears in the manifest, the
 * server returns it, and a chip for it shows up with a count already attached.
 * A hard-coded `['steam','discord','riot']` would need editing in a second
 * place every time, and the one that gets forgotten is the new one.
 *
 * Chips rather than a `<select>` because there are three or four of these and
 * the counts are worth showing — a dropdown hides both the options and how many
 * people are behind each until you open it.
 */
function PlatformFilter({
  sources,
  friends,
  value,
  onChange,
}: {
  sources: FriendSource[];
  friends: FriendRow[];
  value: Filter;
  onChange: (next: Filter) => void;
}) {
  const countFor = (provider: string) =>
    friends.filter((f) => f.accounts.some((a) => a.provider === provider)).length;

  /*
   * Only services that actually contribute somebody.
   *
   * A provider you have not connected has no rows, and a chip reading
   * "Discord 0" invites you to click it and find an empty screen — the sources
   * panel below already explains that case properly. `all` is always offered so
   * there is a way back even if everything else vanishes.
   */
  const offered = sources.filter((source) => countFor(source.provider) > 0);
  if (offered.length < 2) return null;

  return (
    <div className="row" style={{ gap: '.4rem', flexWrap: 'wrap', marginBottom: '.75rem' }}>
      <button
        className={value === 'all' ? 'btn primary' : 'btn subtle'}
        onClick={() => onChange('all')}
        aria-pressed={value === 'all'}
      >
        All {friends.length}
      </button>
      {offered.map((source) => (
        <button
          key={source.provider}
          className={value === source.provider ? 'btn primary' : 'btn subtle'}
          onClick={() => onChange(source.provider)}
          aria-pressed={value === source.provider}
        >
          {source.label} {countFor(source.provider)}
        </button>
      ))}
    </div>
  );
}

function FriendCard({ friend, onChanged }: { friend: FriendRow; onChanged: () => void }) {
  const [linking, setLinking] = useState(false);

  return (
    <div className="card">
      <div className="row" style={{ alignItems: 'center', gap: '.75rem' }}>
        {friend.avatarUrl ? (
          <img src={friend.avatarUrl} alt="" width={32} height={32} style={{ borderRadius: 6 }} />
        ) : (
          <span className="glyph" aria-hidden="true">
            👤
          </span>
        )}

        <div className="grow">
          <div className="title">{friend.name}</div>
          <div className="meta">
            {/* What they are playing outranks the status word: "playing Deep Rock
                Galactic" is the answer, and "online" is the less useful half of it. */}
            {friend.game ?? friend.detail ?? STATE_LABEL[friend.state]}
            {/* Where a borrowed status came from. Without it, a Discord row
                showing a game looks like Discord told us, and the next person to
                wonder why the others are blank has nothing to go on. */}
            {friend.statusFrom ? ` · via ${friend.statusFrom}` : ''}
            {friend.state === 'offline' && friend.lastOnlineAt
              ? ` · last on ${relativeTime(friend.lastOnlineAt)}`
              : ''}
            {/* The handles this was merged from, so a name you do not recognise
                on one service can still be placed by the other. */}
            {friend.accounts.length > 1
              ? ` · ${friend.accounts
                  .filter((account) => account.name !== friend.name)
                  .map((account) => `${account.provider}: ${account.name}`)
                  .join(', ')}`
              : ''}
          </div>
        </div>

        {/* Every service this person is on, not just the one whose name is
            being shown — a merged row is two accounts and should look it. */}
        <span className={`chip presence-${friend.state}`}>
          {friend.accounts.map((account) => account.provider).join(' + ')}
        </span>

        {/*
          Both, on a merged row.

          "Link" used to be replaced by "Unlink" the moment two accounts were
          joined, which made a pair the most anybody could ever have — the only
          way to add a third was to take the pair apart and start again, and
          nothing on screen said so. The server always supported it:
          `linkFriends` absorbs whole groups.
        */}
        <button className="btn subtle" onClick={() => setLinking((open) => !open)}>
          {linking ? 'Cancel' : friend.personId ? 'Add' : 'Link'}
        </button>

        {friend.personId && (
          <button
            className="btn subtle"
            title="Stop treating these as the same person"
            // By person, because the row is the person: unlinking one account
            // of a pair would leave the other looking unchanged.
            onClick={() => void api.integrations.unlinkPerson(friend.personId!).then(onChanged)}
          >
            Unlink
          </button>
        )}
      </div>

      {linking && <LinkPicker friend={friend} onDone={() => { setLinking(false); onChanged(); }} />}
    </div>
  );
}

/**
 * Pick the account on another service that is the same person.
 *
 * Searchable, because the list it picks from is everybody on every *other*
 * service — a hundred names is not something to scroll through in a dropdown.
 * Restricted to other providers because linking two Discord accounts to each
 * other says nothing, and the server refuses it anyway.
 */
function LinkPicker({ friend, onDone }: { friend: FriendRow; onDone: () => void }) {
  const [search, setSearch] = useState('');
  const [problem, setProblem] = useState('');
  const all = useAsync(() => api.integrations.friends(), [], ['integrations']);

  /*
   * Filtered on the *group's* services, not the identity's one.
   *
   * `other.provider !== friend.provider` was right while a row was one account
   * and wrong once it could be three: it compared against whichever account
   * supplied the name — Discord, nearly always — so a second Steam account was
   * offered for a person who already had one, and the server rejected it after
   * the click. Excluding every service already in the group asks the same
   * question the server asks.
   *
   * Rows that are themselves groups are offered now rather than filtered out:
   * `linkFriends` absorbs both sides, so merging two pairs works, and refusing
   * it here only hid something that already functioned.
   */
  const taken = new Set(friend.accounts.map((account) => account.provider));

  const options = (all.data?.friends ?? [])
    .filter((other) => other.id !== friend.id)
    .filter((other) => other.accounts.every((account) => !taken.has(account.provider)))
    .filter((other) => other.name.toLowerCase().includes(search.trim().toLowerCase()))
    .slice(0, 8);

  /*
   * Takes the whole entry, never a bare id.
   *
   * A row's `id` is a *person* key — `solo:<rowId>` when unlinked, the person id
   * when not — and linking works on *account* ids. They are both strings called
   * `id` on objects a few lines apart, so passing the wrong one typechecks
   * perfectly and fails at the server with "one of those is not in the list".
   * That is exactly what happened. Reading `.accounts[0].id` in one place is
   * what stops the two being confusable at the call sites.
   */
  const link = async (other: FriendRow) => {
    try {
      await api.integrations.linkFriends(friend.accounts[0].id, other.accounts[0].id);
      onDone();
    } catch (error) {
      setProblem((error as Error).message);
    }
  };

  return (
    <div style={{ marginTop: '.6rem', display: 'grid', gap: '.4rem' }}>
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={`Search other services for ${friend.name}`}
        aria-label="Search for the matching account"
        type="search"
        autoFocus
      />
      {options.length === 0 ? (
        <span className="meta">Nothing unlinked matches on another service.</span>
      ) : (
        options.map((other) => (
          <button key={other.id} className="btn subtle" style={{ justifyContent: 'flex-start' }} onClick={() => void link(other)}>
            {other.provider}: {other.name}
          </button>
        ))
      )}
      {problem && <div className="banner">{problem}</div>}
    </div>
  );
}

/**
 * Accounts whose names look like the same person.
 *
 * Proposals, never applied automatically. Discord will not tell us a friend's
 * Steam profile — that endpoint is client-only and answers 401 to an OAuth app
 * — so there is nothing authoritative to import and a name match is a guess. A
 * wrong link silently attributes one person's status to another, which is worth
 * one click to avoid.
 */
function Suggestions({ onLinked }: { onLinked: () => void }) {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const view = useAsync(() => api.integrations.linkSuggestions(), [], ['integrations']);

  const shown = (view.data?.suggestions ?? []).filter((s) => !dismissed.includes(s.a.id));
  if (shown.length === 0) return null;

  return (
    <div className="card">
      <div className="title">These might be the same people</div>
      <div className="meta" style={{ marginTop: 2 }}>
        Matched on name only — Discord does not publish its friends' other accounts, so this is a guess
        worth checking. Linking one lets a Discord friend show their Steam status.
      </div>

      {shown.map((suggestion) => (
        <div key={suggestion.a.id} className="row" style={{ alignItems: 'center', gap: '.5rem', marginTop: '.5rem' }}>
          <div className="grow">
            <div className="title">
              {suggestion.a.name} <span className="meta">({suggestion.a.provider})</span> ={' '}
              {suggestion.b.name} <span className="meta">({suggestion.b.provider})</span>
            </div>
            <div className="meta">{suggestion.because}</div>
          </div>
          <button
            className="btn primary"
            onClick={() => void api.integrations.linkFriends(suggestion.a.id, suggestion.b.id).then(onLinked)}
          >
            Same person
          </button>
          <button className="btn subtle" onClick={() => setDismissed((d) => [...d, suggestion.a.id])}>
            No
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Why the list above looks the way it does.
 *
 * Always rendered, even when everything is working — a panel that only appears
 * on failure is one you have to learn the existence of, and this is the first
 * place to look when somebody you know is definitely online is not shown.
 */
function Sources({ sources, anyFriends }: { sources: FriendSource[]; anyFriends: boolean }) {
  return (
    <details className="card" style={{ marginTop: '1.5rem' }} open={!anyFriends}>
      <summary>Where this list comes from</summary>

      {sources.map((source) => (
        <div key={source.provider} style={{ marginTop: '.75rem' }}>
          <div className="row" style={{ alignItems: 'center', gap: '.5rem' }}>
            <strong>{source.label}</strong>
            {/*
              Only for providers there is something to connect. Riot and Epic
              have no account to link — the agent finds the client or it does
              not — and "not connected" beside them read as a step you had
              forgotten to do rather than as a category that does not apply.
              Their own line, below, says the useful thing instead.
            */}
            {source.status !== 'unavailable' && !source.local && (
              <span className="meta">{source.connected ? 'connected' : 'not connected'}</span>
            )}
          </div>

          <div className="meta" style={{ marginTop: 2 }}>{source.why}</div>

          {/* The three states a local provider can be in, which need three
              different things done about them. */}
          {source.local && (
            <div className="meta" style={{ marginTop: 2 }}>
              {source.local.stale
                ? 'The Windows agent is not reporting — is it running?'
                : source.local.clientRunning
                  ? `Client running, last checked ${relativeTime(source.local.reportedAt)}`
                  : `Client is closed — showing what it last saw, ${relativeTime(source.local.reportedAt)}`}
            </div>
          )}

          {/*
            Suppressed when the capability is impossible anyway. Spotify's
            client id is genuinely needed — for playlists — but on a panel about
            *friends*, telling you to go and set it implies that doing so would
            produce a friends list, which is the one thing it cannot do.
          */}
          {source.status !== 'unavailable' && source.missingConfig.length > 0 && (
            <div className="meta" style={{ marginTop: 2 }}>
              Needs{' '}
              {source.missingConfig.map((name, i) => (
                <span key={name}>
                  {i > 0 && ', '}
                  <code>{name}</code>
                </span>
              ))}{' '}
              in the environment.
            </div>
          )}

          {source.lastError && (
            <div className="meta" style={{ marginTop: 2 }}>
              Last error: {source.lastError}
            </div>
          )}
        </div>
      ))}
    </details>
  );
}
