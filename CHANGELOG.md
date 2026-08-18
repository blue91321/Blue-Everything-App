# Changelog

All six packages carry the same version and move together — they are one app
released as one thing. See **Versions** in `CLAUDE.md` for why, and for the
second step `npm version` does not do for you.

## Unreleased

### Twitch, and a Live tab

- **Twitch connects**, bringing two things: the channels you follow, which join
  the Following tab, and which of them is on air.
- **A Live tab** on Connections, between Friends and Following — the same shape
  of question as Friends, and news in a way Following is not. A **Who is live**
  panel for the Dashboard's side column alongside it.
- `GET /helix/streams/followed` answers the whole question in one request, which
  is what makes any of this affordable.
- **YouTube is not on that tab.** There is no endpoint for "which of my
  subscriptions are live"; the only route is `search.list` per channel at 100
  quota units against a 10,000/day default, so one sweep of 408 subscriptions
  costs 40,800 units — four times the day, for one refresh, and it would take the
  playlist and Following syncs with it. The reasoning is in `CLAUDE.md` rather
  than on the screen: a permanent block explaining a service that will never
  appear is a tax on every visit to a tab about Twitch. `integrations-check`
  asserts YouTube's absence, not a count of one — a second service that can
  genuinely answer this is a change to welcome.
- **`live` is deliberately not a flavour of `follows`.** Following is a standing
  fact about you; being live is a fact about them that is true for an evening.
  So `replaceLive` deletes and re-inserts where `replaceFriends` upserts and
  prunes — nothing points at a live row, while churning a friend's key once
  destroyed the links joining their accounts.
- **The first provider here that genuinely needs a client secret.** Twitch has
  never shipped PKCE for the authorization code flow, so `pkce: false` is a
  declaration rather than an omission and the card has a second box.
- Refreshed on read at a 30-second window rather than the friends list's 60: a
  stream that ended three minutes ago is a link to a channel that is not on.
- Twitch shipped wearing YouTube's 📺 for about ten minutes. The glyph is how a
  row is picked out of seven at a glance, so `integrations-check` now asserts
  they are all distinct.
- **The redirect URI default is per-provider now.** `OAUTH_REDIRECT_BASE` was one
  global string defaulting to the loopback IP, because Spotify and Google stopped
  accepting `http://localhost`. Twitch is the other way round — it documents
  `http://localhost:PORT` and its console refused the numeric form — so no single
  value served both. `oauth.loopbackHost` says which spelling a provider wants; a
  base set by hand is still used exactly as typed.
- The setup steps warn that "Redirect URIs must use HTTPS protocol" is *also*
  what the Twitch console says for a blank row in the redirect list. Which means
  it is unproven whether the IP literal was ever really the problem — only that
  `localhost` works and is documented.
- **`scope` is a string in RFC 6749 and an array at Twitch**, so
  `token.scope.split(' ')` threw after the token had already been issued — the
  connection failing at the last step with an error naming a string method.
  `TokenResponse.scope` is the union now and one helper normalises it; an absent
  or empty value falls back to what was asked for, since several providers omit
  it on a refresh.
- **Star a live channel**, and a control in Settings to narrow the Dashboard
  panel to starred ones. The Connections tab always lists everybody; only the
  panel filters, so the endpoint returns everything and carries the scope.
- The star is a flag on `follows`, so unfollowing takes it away and an ordinary
  sync does not. Found on real data: it needs a `follows` row to exist, and the
  live list is what people open while the followed list waits for a manual sync
  — so 21 live channels had a star that refused all of them. `syncLive` now
  syncs the followed list once when it has never synced.
- The panel subscribes to `settings` as well as `integrations`; without it,
  changing the scope left an open Dashboard on the old filter.
- Two empty states, since a narrowed panel showing nothing while four people are
  live is not a quiet evening — it says which of the two it is.
- Migrations `0037` and `0038`.

## 0.2.2

Coursework arrives on its own, habits stopped being only a counter, and the
Dashboard gained a second column. Every item below was found or confirmed by
running the app rather than by reading about it — several of them are bugs the
first version of the same feature shipped with.

### Canvas

- **Coursework becomes tasks the nudge engine can hold.** Assignments, quizzes
  and graded discussions with a due date, read from `/api/v1/planner/items` —
  the same planner the Canvas dashboard draws, so it has already decided which
  courses are current, and it carries the submission state.
- **A deleted task stays deleted.** `integration_task_links` remembers that an
  item became a task even after the task is gone. Deduplicating against `tasks`
  itself — which a `(source, source_id)` unique index would give you — recreates
  something you deliberately threw away on the very next sync.
- **Afterwards only the deadline is carried across.** Extensions happen weekly
  and a stale `dueAt` makes the engine wrong; a title you renamed is yours, and
  nothing here could tell "you renamed it" from "they renamed it". Compared
  against what Canvas last said rather than the task's own date.
- Handing something in on Canvas ticks the task off. Canvas going quiet never
  reopens one you closed.
- **The only background timer in the module** — half-hourly while connected, none
  at all otherwise. A friends list is something you go and look at; a deadline's
  whole job is to reach the queue while you are thinking about something else.
- The token is the whole Canvas account and cannot be scoped, so the setup text
  and the connect form say so. `http://` hosts are refused rather than upgraded.
- Two things this turned up: the api-key connect form was Steam's alone and
  would have shown Canvas a box asking for a Steam profile, and "Services to
  leave out" listed every provider while governing only Friends and Following.

### Habits

- **Three modes, differing in one question — when does this want doing.**
  `target` is unchanged; `interval` is due again a fixed time after the last
  tick, with no target to fall behind on; `gauge` is a level that drains and is
  topped up by doing the thing.
- **The gauge stores a level and the moment it was true.** Everything between
  anchors is computed, so it costs no timer and one write per action. Deriving
  it from the last tick cannot express a gauge topped up twice in a morning, nor
  one neglected a fortnight and then filled halfway.
- Drawn as SVG clipped to the path so a triangle empties to a point, or as any
  emoji, or as **a picture of your own** uploaded per habit.
- **`met` and `wantsDoing` are two questions**, and collapsing them was the
  mistake: a gauge at 20% sat under *Finished today*, a heading claiming you
  were done with something visibly draining. A gauge is never finished; an
  interval habit is finished only if it was done *today* and is not due again.
- **A threshold, so it asks before it is empty** — reminding at empty is fine for
  a glass of water and wrong for a plant. The row carries two countdowns,
  *reminds in* and *empty in*, and shows one when they are the same instant.
- **Say "to max"** and it fills the rest of the way, which is a different number
  in every mode — for a gauge you rarely know how many top-ups reach full.
- The editor says what the numbers mean: how long a full gauge lasts in the unit
  that fits, and the rhythm the drain and fill imply — "about 5 a day to keep
  up" rather than two percentages.
- **Undo on a gauge is not gated on an entry in this period.** For a counted
  habit "nothing to undo" is true about today; for a gauge the level *is* the
  state and it was last filled yesterday. The − button worked exactly once.
- **Recording a completion is one function again.** The voice feature had its own
  copy, identical to the HTTP route until gauge mode arrived — so saying "I drank
  water" logged an entry and left the gauge where it was. The spoken reply came
  from the same place: it said "1 of 16" about something whose whole state is a
  percentage.

### The Dashboard

- **A second column**, holding one thing worth having in the corner of your eye:
  who is online, recent notes, or nothing. Features declare panels in their
  `meta.ts` and export a lazy `panel.tsx`, so core never imports the panel it
  most wants — verified by building the PWA with `features/integrations` gone.
- **Right-click a task or habit** to get to the screen that edits it, with its
  editor open. A text selection still gets the browser's own menu, so copying a
  title keeps working.
- Each person in the friends panel finds themselves in Connections; the panel
  itself links to the setting that decides what the column holds.

### Elsewhere

- **Picking a notification tone plays it.** `TONES` and the WAV encoder moved to
  `shared` so the server can render what the agent plays — byte-for-byte, checked
  across all eight audible tones, rather than a Web Audio approximation that
  could drift. 6ms from selecting to the bytes arriving.
- **A friend row that does not squash.** At 375px the chip and buttons held their
  width while the text was crushed to 32px and 13 of 40 names wrapped; now 214px
  and none. Nothing is hidden — the controls wrap underneath instead.
- **Message** on a friend row opens Discord, via `discord://-/users/<id>` — one
  link the desktop client claims here and the phone app claims there.
- Two stemmer bugs found while checking a voice phrase reached its habit at all:
  English doubles the final consonant before `-ed`/`-ing`, so "sipped" matched
  nothing against a stored "sip" and the grammar was offered "siped", a spelling
  nobody says; and a lone `-s` was stripped from words ending `-ss`, so "press"
  and "pressed" reduced differently. `jog`, `plan`, `stop`, `nap`, `log`, `trim`,
  `pass` and `floss` all failed one way or the other.

### Notes

- Migrations `0033`–`0036`: Canvas task links and `tasks.source`, the Dashboard
  panel setting, habit modes and the gauge columns, and the gauge threshold.
- `packages/extension` still carries a `manifest.json` and no `package.json`, so
  `npm version --workspaces` cannot see it and it is bumped by hand.
- Three things that only presented as "the feature does nothing": hooks written
  below `App`'s early returns took the whole app down with React error #310 on
  the pairing screen; clearing a focus request cancelled the work that request
  had started; and `requestAnimationFrame` does not fire at all when a page is
  not compositing, which broke a scroll *and* the probe measuring it.

## 0.2.1

The app integrations module, as actually used: everything below was found by
running it against a real Steam, Discord, YouTube and League account rather than
by reading documentation.

### Riot

- **The friends list never reached the database.** `localPresenceSchema` reused
  `friendSchema`, which requires a `provider` on every row, while the agent named
  it once on the envelope where it belongs. Every report carrying actual friends
  was rejected 400 and only the empty ones landed — and both paths that send an
  empty list are failure paths, so the screen showed a stale connection error
  while 164 live friends sat in the agent's log as identical zod issues.
- **Game modes are asked of the client, not guessed.** `RANKED_SOLO_5x5` and
  `CHERRY` reached the screen verbatim. A hand-written table got two of seven
  live friends wrong; `/lol-game-queues/v1/queues` calls `KIWI` *ARAM: Mayhem*
  and queue 1740 *Bravery Arena*. Fetched once per client session.
- **A launcher and a phone are not "online".** Riot's `availability` answers
  "signed in to Riot somewhere" and reports both as `chat` — the same value
  somebody in champion select gets. Six friends were on screen as online with no
  League data at all. The `lol` block is the honest signal, and they are `away`.
- **Lobbies count as in-game.** `hosting_` is a prefix, not a value: the real
  statuses name the queue, so `hosting_JADE_RANKED_SOLO_5x5` fell through to
  merely online.
- Avatars, from Community Dragon — Riot publishes an icon id and no URL.
- **An errored report no longer empties the list.** "The client is up but would
  not answer" reported `clientRunning: true` with no friends, so every Riot row
  was pruned and re-inserted with fresh ids, silently destroying five links to
  Discord accounts. Migration `0031` tidies what that left behind.

### Discord and Steam

- Discord's REST API carries no presence at all, so its friends are `unknown`
  rather than offline, labelled by the service they came from. A linked Steam
  account lends its status, and the row says where that status came from.
- The `sdk.social_layer_presence` scope is requested as *optional*: an
  unapproved application refused the whole authorization, which made Discord
  entirely unconnectable rather than partly useful.
- Steam's "busy" is a do-not-disturb and keeps its own state instead of being
  folded into away.

### Linking

- **Groups can hold more than two accounts.** The server always allowed it;
  "Link" was replaced by "Unlink" the moment two joined, so the only way to a
  third was to take the pair apart. The same-service guard now checks the whole
  merged set — deduplicated by row id, without which every legitimate third was
  refused for a service that had exactly one account.
- **Followed accounts group too**, with the main one chosen by hand. Two YouTube
  channels from one creator is the commonest case, so same-service linking is
  allowed here and no preference order could pick a main.
- One **Manage links** button per row on both tabs, opening a panel that lists
  what is joined before offering to join more.

### Filtering and finding

- A search box on Friends and Following, leading each list. Friends matches
  **every handle a person has**, not just the name on the row — a merged person
  wears their Discord name, so the Steam persona you know them by found nothing.
- Chips to show one service, and a second row to switch whole **statuses** off:
  everything but in-game, or everything except offline.
- **Services to leave out**, at the top of the Services tab, covering both lists:
  hiding Riot drops friends you know only from there, hiding YouTube drops its
  channels, hiding Spotify drops its artists. A person is dropped only when
  *every* account they have is on a hidden service.
- A presence dot per friend — blue in-game, green online, yellow away, red busy,
  grey offline, hollow for "cannot tell". Deliberately not the accent colour.

### Elsewhere

- **The app offers to start the server when it is not running.** The service
  worker keeps the shell, and a network failure used to be indistinguishable
  from a 401 — so it asked for a device token, the one thing that was not broken.
- Every credential is a text box in the app; none of them needs a file opened.
- The OAuth callback moved out of `/api/`, where `isTrustedLocal` correctly
  refuses a cross-site redirect and returned `missing bearer token`.
- The server is typechecked, which immediately found eleven real errors
  including a trimmed function that had taken `syncFollows` with it.
- Playlists are ignored individually, and ignored ones leave the Music tab's
  counts as well as its lists.

### Notes

- Migrations `0028`–`0031`. `hidden_friend_providers` was renamed to
  `hidden_providers` once it stopped being only about friends.
- `packages/extension` carries a `manifest.json` and no `package.json`, so
  `npm version --workspaces` cannot see it — it had been left at 0.1.0 while
  everything else moved to 0.2.0, and is bumped by hand here.

## 0.2.0

- The app integrations module: Spotify, YouTube, Steam, Discord and Riot, each
  declaring what it is genuinely able to do and why, rather than presenting an
  empty list. Playlists, followed accounts, music categorisation and who is
  online, with the parts that cannot work saying so on screen.
