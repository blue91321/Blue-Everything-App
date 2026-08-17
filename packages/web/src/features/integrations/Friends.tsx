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
import { useEffect, useState } from 'react';
import { api, type FriendRow, type FriendSource } from '../../api';
import { useAsync } from '../../useAsync';
import { STATE_LABEL } from './presence';
import { relativeTime } from './Integrations';


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

export function Friends({ seed }: { seed?: string | null } = {}) {
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  /*
   * A name handed in from elsewhere — the Dashboard panel's "find this person".
   *
   * Applied through an effect rather than as `useState(seed)`, because this
   * screen is already mounted when a second request arrives: you can right-click
   * one person, then another, without leaving the tab. An initial value would
   * only ever honour the first.
   */
  useEffect(() => {
    if (seed) setSearch(seed);
  }, [seed]);
  /**
   * Statuses switched off, rather than the one status to show.
   *
   * A list of what is *hidden* makes "everything" the empty case, so a new
   * presence state appears on screen the day it is added instead of being
   * invisible until somebody remembers to add it to a list of what to include.
   * It also matches how the question gets asked — "hide the offline ones" — and
   * lets several be off at once, which picking one never could.
   */
  const [hiddenStates, setHiddenStates] = useState<FriendRow['state'][]>([]);

  const toggleState = (state: FriendRow['state']) =>
    setHiddenStates((current) =>
      current.includes(state) ? current.filter((s) => s !== state) : [...current, state]
    );

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

  /*
   * Three filters in a row, and the status one is applied last on purpose.
   *
   * Its own chips count over `candidates` — everything the service and the
   * search left — rather than over what survives the status filter, or every
   * count would drop to zero the moment you switched that status off and there
   * would be nothing left to switch back on.
   */
  const candidates = (
    filter === 'all'
      ? view.data.friends
      : view.data.friends.filter((f) => f.accounts.some((a) => a.provider === filter))
  ).filter((f) => matchesSearch(f, needle));

  const shown = candidates.filter((f) => !hiddenStates.includes(f.state));

  /*
   * `away` is its own group, and lumping it in with online was a lie the count
   * told out loud.
   *
   * "N online" counted everybody who was not offline, so a launcher left open
   * and a phone signed in were reported as people who are around — and on a
   * Riot list, which is mostly those, the number was wrong by a factor of
   * several. Being signed in somewhere is worth showing; it is not the same
   * claim as being here.
   */
  // `dnd` belongs up here: they are at the keyboard, and "busy" is a choice
  // somebody made rather than the absence idle time reports.
  const around = shown.filter((f) => f.state === 'in-game' || f.state === 'online' || f.state === 'dnd');
  const away = shown.filter((f) => f.state === 'away');
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

      <StatusFilter
        friends={candidates}
        hidden={hiddenStates}
        onToggle={toggleState}
        onReset={() => setHiddenStates([])}
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
          {/* Named separately, because "signed in somewhere" is a weaker claim
              than "here", and most of a Riot list is the weaker one. */}
          {away.length ? ` · ${away.length} away` : ''}
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
      {shown.length === 0 && (candidates.length > 0 || needle) && (
        <div className="empty">
          {/*
            Which filter emptied it, named. Three of them stack here — service,
            search, status — and "nobody matches" while a status toggle is off
            is the one that sends somebody looking for a problem that is a
            button they pressed.
          */}
          {candidates.length > 0
            ? `Everybody here is filtered out by status — ${candidates.length} ${
                candidates.length === 1 ? 'person is' : 'people are'
              } hidden by the buttons above.`
            : `Nobody matches "${search.trim()}"${filter === 'all' ? '' : ` on ${filter}`}.`}
          {view.data.hiddenCount
            ? ` ${view.data.hiddenCount} more are left out by the service filter on the Services tab.`
            : ''}
        </div>
      )}

      {around.map((friend) => (
        <FriendCard key={friend.id} friend={friend} onChanged={view.reload} />
      ))}

      {/*
        Between online and offline, where it belongs — these are people who are
        signed in but not here: a launcher left open, the phone companion app,
        or somebody idle in the League client. Under its own heading rather than
        mixed into the list above, so the top of the screen answers "who could I
        actually play with" without qualification.
      */}
      {away.length > 0 && (
        <>
          <div className="meta" style={{ margin: '1rem 0 .5rem' }}>
            Away — signed in, but not in a game
          </div>
          {away.map((friend) => (
            <FriendCard key={friend.id} friend={friend} onChanged={view.reload} />
          ))}
        </>
      )}

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

/**
 * The order statuses are offered in, which is the order they matter in.
 *
 * Fixed rather than derived from what is present, so the row does not reshuffle
 * as people come and go — a filter whose buttons move under the cursor is worse
 * than one with a gap in it.
 */
const STATUS_ORDER: Array<FriendRow['state']> = ['in-game', 'online', 'dnd', 'away', 'offline', 'unknown'];

/**
 * Switch whole statuses off.
 *
 * The two things this is for pull in opposite directions and are the same
 * control: switching everything but *in-game* off answers "who could I join
 * right now", and switching *offline* off answers "stop showing me the other
 * hundred and thirty". Toggles rather than a single choice, because both are
 * several clicks of the same kind and a one-of-these picker could only do the
 * first.
 *
 * Each carries its own presence colour, so the row doubles as the legend for
 * the dots on the avatars — there is nowhere else that says what blue means.
 */
function StatusFilter({
  friends,
  hidden,
  onToggle,
  onReset,
}: {
  friends: FriendRow[];
  hidden: Array<FriendRow['state']>;
  onToggle: (state: FriendRow['state']) => void;
  onReset: () => void;
}) {
  const countFor = (state: FriendRow['state']) => friends.filter((f) => f.state === state).length;

  /*
   * Statuses somebody is actually in — **plus any switched off**, which have to
   * keep their button or there is no way back. That is not hypothetical: the
   * counts are taken before this filter applies, but a status with nobody in it
   * would still vanish, and hiding `offline` on a list that is mostly offline is
   * exactly when you want to undo it.
   */
  const offered = STATUS_ORDER.filter((state) => countFor(state) > 0 || hidden.includes(state));
  if (offered.length < 2) return null;

  return (
    <div className="row" style={{ gap: '.4rem', flexWrap: 'wrap', marginBottom: '.75rem' }}>
      {offered.map((state) => {
        const off = hidden.includes(state);
        return (
          <button
            key={state}
            className={off ? 'btn subtle status-off' : 'btn subtle'}
            // Pressed means *showing* — the state of the thing the button
            // controls, rather than of the button itself.
            aria-pressed={!off}
            title={off ? `Show ${STATE_LABEL[state]}` : `Hide ${STATE_LABEL[state]}`}
            onClick={() => onToggle(state)}
          >
            <span className={`status-dot presence-${state}`} aria-hidden="true" />
            {STATE_LABEL[state]} {countFor(state)}
          </button>
        );
      })}

      {/* One click back to everything. Undoing four toggles one at a time is
          how a filter gets left on and forgotten about. */}
      {hidden.length > 0 && (
        <button className="btn subtle" onClick={onReset}>
          Show all
        </button>
      )}
    </div>
  );
}

function FriendCard({ friend, onChanged }: { friend: FriendRow; onChanged: () => void }) {
  const [linking, setLinking] = useState(false);

  return (
    <div className="card">
      <div className="row" style={{ alignItems: 'center', gap: '.75rem' }}>
        {/*
          The dot rides on the avatar, so it needs a positioned wrapper that
          exists whether or not there is a picture — the fallback glyph gets one
          too, or half the list would have no status light.
        */}
        <span className="avatar-wrap">
          {friend.avatarUrl ? (
            <img src={friend.avatarUrl} alt="" width={32} height={32} style={{ borderRadius: 6 }} />
          ) : (
            <span className="glyph" aria-hidden="true">
              👤
            </span>
          )}
          {/* The colour is the whole message, so it carries a text one too —
              a dot is invisible to a screen reader and to anybody who cannot
              tell the green from the red. */}
          <span
            className={`presence-dot presence-${friend.state}`}
            title={STATE_LABEL[friend.state]}
            aria-label={STATE_LABEL[friend.state]}
            role="img"
          />
        </span>

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
          One button, opening one panel.

          It was two — "Link"/"Add" beside "Unlink" — which put the two halves
          of one job in different places and spent a second slot on every row of
          a 270-row list for something done a handful of times. Adding and
          removing are both *managing the links*, so they live together behind a
          single control, the same shape the Following tab uses.
        */}
        <button className="btn subtle" onClick={() => setLinking((open) => !open)}>
          {linking ? 'Done' : friend.accounts.length > 1 ? 'Manage links' : 'Link'}
        </button>
      </div>

      {/*
        Kept open across a change, unlike before.

        The panel used to close itself on every successful link, which was fine
        while linking was one action and wrong now that it is a session — you
        add a second account, look at what you have, and take one back out.
      */}
      {linking && <LinkPicker friend={friend} onChanged={onChanged} />}
    </div>
  );
}

/**
 * Everything about who this person's accounts are: what is joined, and what to
 * join next.
 *
 * Both halves in one place because they are one job. It began as a picker
 * alone, with unlinking as a separate button on the row — which meant the list
 * of what you had linked existed nowhere, and taking one account out of a group
 * of three was not reachable at all.
 *
 * Searchable, because the list it picks from is everybody on every other
 * service, and a hundred names is not something to scroll through in a
 * dropdown.
 */
function LinkPicker({ friend, onChanged }: { friend: FriendRow; onChanged: () => void }) {
  const [search, setSearch] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const all = useAsync(() => api.integrations.friends(), [], ['integrations']);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setProblem('');
    try {
      await action();
      onChanged();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

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
  const needle = search.trim().toLowerCase();

  return (
    <div style={{ marginTop: '.6rem', display: 'grid', gap: '.4rem' }}>
      {/*
        What is joined, listed before the box that joins more — you cannot
        sensibly decide what to add without seeing what is there. Shown only
        when there is a group, since one account is not a list.
      */}
      {friend.accounts.length > 1 && (
        <>
          <div className="meta">Linked accounts</div>
          {friend.accounts.map((account) => (
            <div key={account.id} className="row" style={{ alignItems: 'center', gap: '.5rem' }}>
              <span className="grow">
                {account.name} <span className="meta">({account.provider})</span>
              </span>
              <button
                className="btn subtle"
                disabled={busy}
                title="Take this one out, leaving the rest joined"
                /*
                 * Per account, not per person.
                 *
                 * The row's old button dissolved the whole group, which is the
                 * same thing for a pair and wrong for three — there was no way
                 * to correct one bad link without losing the good one. A group
                 * left with a single member is dissolved by the server, so a
                 * pair still comes apart in one click.
                 */
                onClick={() => void run(() => api.integrations.unlinkFriend(account.id))}
              >
                Unlink
              </button>
            </div>
          ))}
        </>
      )}

      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={`Search other services for ${friend.name}`}
        aria-label="Search for the matching account"
        type="search"
        autoFocus
      />
      {needle === '' ? (
        <span className="meta">Type a name to find them on another service.</span>
      ) : options.length === 0 ? (
        <span className="meta">Nothing on another service matches "{search.trim()}".</span>
      ) : (
        options.map((other) => (
          <button
            key={other.id}
            className="btn subtle"
            style={{ justifyContent: 'flex-start' }}
            disabled={busy}
            /*
             * Takes the whole entry, never a bare id.
             *
             * A row's `id` is a *person* key — `solo:<rowId>` when unlinked, the
             * person id when not — and linking works on *account* ids. Both are
             * strings called `id` on objects a few lines apart, so passing the
             * wrong one typechecks perfectly and fails at the server with "one
             * of those is not in the list". That is exactly what happened.
             */
            onClick={() =>
              void run(() => api.integrations.linkFriends(friend.accounts[0].id, other.accounts[0].id))
            }
          >
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
