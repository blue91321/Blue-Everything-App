# Changelog

All six packages carry the same version and move together — they are one app
released as one thing. See **Versions** in `CLAUDE.md` for why, and for the
second step `npm version` does not do for you.

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
