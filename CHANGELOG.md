# Changelog

Everything in this repo carries the same version and moves together — the four
workspaces, the browser extension, and the five shipped packages. They are one
app released as one thing. See **Versions** in `CLAUDE.md` for why, and for the
files `npm version` does not touch.

## 0.3.0

Packages you can install, delete and restart into — and everything optional in
the app moved onto that footing. Weather is the first thing built *as* a package
rather than migrated into one, which is what makes it the honest test of whether
the rest was worth doing.

### Install a package the way you would a texture pack

- **`modules/` at the repo root**, one folder per package, listed under
  **Settings → Packages → Installed**. Drop a `.zip` on the page, open the
  folder in Explorer, switch one on, delete one from disk.
- **A built-in feature could never work this way.** `FeatureSpec.owns` shows one
  is up to three folders across three workspaces — the vault owns a server
  folder, a web folder and the whole extension — so there is no single directory
  to open or delete. A module is *defined* as one folder; that constraint is the
  whole feature. The screen says **Built in** and **Installed** rather than
  putting a "Remove" button against the vault that could not work.
- **The texture-pack comparison breaks in one place, and the screen says so.** A
  resource pack is data; a package here may be code, imported into the server
  process with the database and the machine. There is no sandbox. The warning is
  above the drop zone rather than in a README, and a package arrives switched
  off — running code that came from outside should be a decision.
- **A hand-rolled zip reader**, no dependency, the same call the PNG encoder and
  the WAV writer make. It reads the central directory rather than the local
  headers, which are allowed to carry zeros when the streaming bit is set.
  Refuses zip slip in both spellings, checks declared sizes before inflating so
  a decompression bomb cannot expand, verifies the CRC, and refuses ZIP64 and
  encryption by name. A wrapping folder is stripped when every entry shares one,
  since archives are made both ways.
- **A broken package is listed with its problems, never hidden.** Dropping a bad
  zip and seeing nothing happen is indistinguishable from the drag not working.
- **Installing, switching, removing and opening the folder are local-only**, and
  the gate was proved over a real socket with hand-written HTTP — `Host` is a
  forbidden header for `fetch`, which drops it silently, and the smoke suite
  disables auth entirely, so neither could test the vector that matters.
- `npm run modules-check -w @everything/server`, including a zip built by
  `Compress-Archive` — a hand-rolled parser tested only against a hand-rolled
  writer proves the two agree, which is worth much less than it looks.

### A package can draw its own screens

- **A package can add a tab and Dashboard panels**, not just endpoints. Declared
  in `module.json`, drawn by one self-contained JS file the app fetches and
  imports at runtime.
- **Fetched with the device token and imported as a blob**, because neither
  `<script src>` nor a URL import sends an Authorization header — and unlike the
  icons and the tones, a package's code is not something to put outside auth on
  a server that binds `0.0.0.0`.
- **React is handed to the package rather than imported by it**, so there is one
  copy on the page and hooks work. A package bundles nothing.
- **A broken package cannot take the app down** — which is the case that matters,
  since it would otherwise be one you could not reach the screen to uninstall.
  The failure renders as a banner naming the package and quoting the error.
- A glyph is now taken as one *grapheme*: the first version truncated 👨‍💻 to 👨.

### One timer instead of two, if you want

- **"Use this after a miss too"** under the follow-up slider. Ticking it hides
  the retry card and uses one number for both.
- A real stored flag rather than inferring it from the two numbers matching —
  two settings that happen to be equal is not the same as "keep these together".
- **The retry value is left alone while it is ticked** and resolved on read, so
  unticking gives back the number you chose. Verified: 12s, ticked, follow-up
  moved to 9, unticked, still 12s.
- Hidden rather than disabled: a disabled slider showing a number that is no
  longer in use would be the worse lie.

### See what the recogniser can actually hear

- **Voice → "Everything it can hear"** lists the whole grammar, collapsed, with a
  count — 136 words on this install.
- **Grouped by where each word came from**: the wake word, your decoys, the words
  you typed, the forms it generated for itself, and the counting words it always
  includes. The provenance is the point — "drank" being generated rather than
  typed is the sort of thing that explains a baffling transcript.
- The groups partition the grammar exactly, which `voice-check` asserts: a list
  that quietly omitted part of it would be worse than no list.
- Words the speech model cannot pronounce are marked, reusing the warning the
  wake word and phrases already had.

### Stop things that are not the wake word from waking it

- **A list of words that keep setting it off**, on the Voice tab. They go into
  the wake grammar so the recogniser has somewhere better to put that sound —
  measured with `wake-falsing`: 1/14 false wakes down to 0/14, both real wakes
  still firing. They are never matched against and can never trigger anything.
- **Confidence gating was measured and rejected.** Per-word confidence is now
  available, and in grammar mode it is 1.00 for everything — a forced match and
  a real one score identically, because inside a closed grammar the chosen path
  is the only path. `npm run wake-confidence` shows it.
- **A generic word list was measured and rejected too.** 108 common English
  words changed nothing; the competitor has to actually sound like the wake
  word. That is why this is a list you fill in, and why it is cheap.
- A decoy the model cannot pronounce gets the same dictionary warning a phrase
  does, since Vosk drops unknown words without a murmur.

### Tap the number on the Habits screen to edit it

- The value between − and + is now a button; pressing it turns it into a box.
  Correcting "nine, not two" no longer means pressing + seven times.
- A gauge takes a level and records **no entry** — pressing + is a completion,
  typing 80 is a correction, and filing one as the other would put a tick in the
  history for something you never did.
- A count moves the entries themselves, newest first, splitting one whose count
  is above one — which "I drank three waters" creates.
- Enter commits directly rather than relying on the blur it causes: an unfocused
  document dispatches no focus events at all, and phone keyboards vary. The blur
  is still a fallback and cannot double-commit.
- An emptied box does not wipe the tally, letters are filtered as you type, and
  the button and box share one width so the stepper never jumps.
- **A failed save says so.** It was swallowed, which is how "I pressed Enter and
  nothing happened" got reported: the route was new, the app had not been
  restarted, and every save 404'd in silence.
- The control moved to the top level. Defined inside the row it was a new
  component type every render, which would remount the input mid-typing.

### Weather

- **A Weather tab and a Dashboard panel**, from Open-Meteo — no account, no key,
  nothing to set up but the place you are in.
- **Two settings: "Once a day" or "Only when I ask."** The first is a staleness
  window rather than a timer: reading the weather refreshes it if it is a day
  old, so opening the tab five times costs one fetch and a PC left alone costs
  none. Manual mode never fetches on its own — `weather-check` asserts that for
  a reading never taken and one a month old.
- **The Check now button is always there**, in both modes, on the tab *and* the
  panel — having to open a settings screen to press it would make manual mode
  not worth choosing.
- **The last reading is kept and its age is always shown**, so manual mode is a
  usable screen rather than a blank one. A failed fetch is stored beside the
  reading it could not replace: you get yesterday's weather and the reason.
- Search for a town rather than typing coordinates, with the candidates listed —
  Philadelphia alone returns five, in two states.
- The first thing built *as* a package rather than migrated into one, and it
  needed no change to core.
- **An hourly temperature graph** on the Weather tab: twenty-four hours as a
  line, with night shaded, rain as bars under it, and a glyph per labelled hour.
  Hand-drawn SVG — 3.1KB gzipped, loaded only when the tab is opened.
- **It fits at every width, with no scrollbar.** The box is measured and the SVG
  drawn at exactly that width, text at a fixed size — all 24 hours always
  plotted, with fewer of them *labelled* when there is less room (12 at 1280px,
  8 at 375px). `min-width: 0` on the wrapper is what lets a flex child shrink
  below its content, which was the scrollbar.
- **Night is darker than day now**, which was backwards: the band was a neutral
  grey, and grey over a dark card is lighter than the card.
- Finding "now" in the forecast is a string match against what `Intl` says the
  time is *there*, not date arithmetic: Open-Meteo's timestamps carry no offset,
  so parsing them locally is right in Philadelphia and five hours out in London.

### Everything deletable is a package, and there is a Restart button

- **The vault, voice and integrations have moved** into `packages/modules/`
  alongside push. All four appear on the Packages tab with a Remove button, a
  size, and their own version. Deleting one takes it out of the app.
- **Shipped packages are deletable after all.** The first version refused, on the
  grounds that the folder is part of your checkout — but "the folder is gone and
  the app says not installed" has been one of this project's three documented
  levels from the start, and `features-check` already proves every one survives
  it. The row says which cost you are paying: `git checkout` brings a shipped one
  back, an installed one needs the zip again.
- **A Restart button**, in the banner that appears whenever something is added,
  removed or switched. Registered in core *before* any package loads, reads no
  database and no manifest, and answers before restarting rather than trying to
  report an outcome from a process that is being killed — because the whole point
  of it is the case where a package has broken something else.
- **A shipped package keeps its compiled UI**; only downloaded ones are loaded at
  runtime. Vite globs `packages/modules/*/web/` from outside its own root, which
  it turns out it will do, so the vault and Connections screens are bundled
  exactly as before — just from a folder you can delete.
- **`@everything/server/module-api`** grew to ten exports: the whole schema (a
  package owns no tables — migrations are a linear journal), plus the two
  opaque-slug parsers core owns and a package gives meaning to.
- `features-check` now drives packages through `modules.json` rather than
  `FEATURES`, and proves each of the four can be **deleted from disk** with the
  server still booting and the other three unaffected.

### Four things that went wrong, all worth knowing

- **`modules/` in `.gitignore` matched `packages/modules/` too.** A pattern with
  no leading slash matches at any depth, so the moment the vault, voice and
  integrations moved, git stopped seeing them. Anchored to `/modules/` now. An
  ignore rule that matches too much fails exactly like one that matches too
  little: silently, in the direction you were not looking.
- **The smoke suite deleted the vault.** It sent `DELETE /api/modules/vault`
  expecting a refusal — true while the vault was a reserved *feature* id, false
  the moment it became a package. The suite now names only ids that can never be
  real, and asserts at the end that it deleted none of the shipped packages.
- **The repo root was counted by hand a third time and got wrong a second
  time**, disabling the very Restart button that is meant to always work.
  `paths.ts` owns every path now.
- **The voice models' ignore rule named the old folder** and stopped matching
  when voice moved — the exact failure the comment above it warned about.

### Phone notifications is a package now

- **Two module roots.** `packages/modules/` ships with the app and is committed;
  `modules/` holds what you installed and stays gitignored. Moving a first-party
  feature into the ignored one would have deleted it from the public repo.
  Shipped is scanned first, so a downloaded folder cannot shadow a real one.
- **`@everything/server/module-api`** — the stable surface a server-side package
  imports instead of reaching into the server's own source with `../../`. Eight
  exports, arrived at by counting what the four removable features actually use.
- **`push` moved out of the feature manifest** into `packages/modules/push/`, and
  loads through the package loader. It shows as built-in on the Packages screen,
  switchable but not removable — deleting it would mean deleting part of your
  checkout.
- **Your switch survives the move.** A shipped package defaults on, so a
  `push: false` would otherwise have turned notifications back on for anyone who
  had silenced them. The old key is read once and carried into `modules.json`.
- `vault`, `voice` and `integrations` have **not** moved. Their browser halves
  are compiled into the PWA bundle, and a package's must be one self-contained
  file — see `CLAUDE.md` for what each would cost.

### Two Windows details, each found by hitting it

- **A byte-order mark is now stripped before every hand-edited JSON parse.**
  PowerShell's `Out-File -Encoding utf8` writes one and `JSON.parse` refuses it,
  reporting `Unexpected token '﻿'` — an invisible character. This covers
  `features.json` too, where a BOM stopped the server booting.
- **A `.js` file under `modules/` is CommonJS**, because Node resolves
  module-ness from the nearest `package.json` upward and the nearest above
  `modules/` is the repo root. A package written the obvious way died on its own
  first `export` with an error naming neither the package nor the cause.
  Installing now writes `{"type":"module"}` when a package ships no
  `package.json`, and never overwrites one that does.

## 0.2.3

Twitch and a Live tab, a side column that stacks, a presence state that stops a
friend being mistaken for available — and two vulnerabilities found by auditing
this release rather than by anything going wrong.

### Security

- **Reflected XSS on the OAuth callback, fixed.** The provider's `error` and
  `error_description` were interpolated into hand-built HTML on an
  unauthenticated route — same origin as the device bearer token in
  `localStorage`. Confirmed live before the fix: 200, `text/html`, script intact.
- **Path traversal on the habit picture, fixed.** `habit-${id}.png` put the id
  in a filename, and the `habit-` prefix is its own path segment, so `..` after
  it climbed out of `data/`. It read `data/avatar.png` and then a file outside
  `data/`. Guarded at the path helper, not the route.
- Both are covered by `smoke` now, along with an assertion that an ordinary id
  still reads its own picture.

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
- **The side column holds several panels now**, one under the other, in an order
  you set with ↑/↓ — the same idiom the Habits screen reorders with. Backfilled
  from the single choice, and `dashboard_panel` is still written as the first
  entry so a PWA older than the column still draws something.
- Each panel gets its own Suspense boundary rather than one around the column:
  they are separate chunks and a shared boundary would hold all of them back
  until the slowest arrived.
- **A state for playing but away.** Steam and Riot both report "in a game" and
  "idle" separately, and both were collapsing them — the game was checked first
  and the availability discarded, so somebody AFK mid-match showed the same blue
  dot as somebody at the keyboard. Reported the only way it could be: a friend
  was mistaken for available. Two of four apparently-available people on the live
  list turned out to be AFK the moment it was fixed.
- Drawn as the away yellow with a ring of the in-game blue: the fill is the half
  that matters, since reading blue as "available" was the whole mistake.
- Migrations `0037`–`0039`.

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
