# Blue Everything

A personal, single-user assistant for one person on one Windows PC and one iPhone.
Not a product. No multi-tenancy, no accounts, no sign-up flow — ever.

## What this actually is

The headline feature is **not** a to-do list. It is an *interruption-aware nudge
engine*: something that knows what you are doing on Windows, holds a reminder
while you're mid-game, and delivers it the instant you hit a natural break.

Tasks, habits, time tracking, and notes exist to give that engine something
worth saying. When a design decision is ambiguous, favour the one that makes
nudges land at better moments.

## Architecture

```
Windows Electron agent  ──┐
  · tray + global hotkey  │
  · attention sensor      ├──►  Fastify + SQLite  ◄── Tailscale ── iPhone PWA
  · Windows toasts        │      (runs on the PC)          · web push
  · push-to-talk voice   ─┘      · tasks/habits/time/notes  · quick capture
                                 · nudge queue
```

- `packages/agent` — headless Node service. Owns all Win32 introspection and local toasts.
- `packages/server` — Fastify + SQLite (Drizzle). The only writer of the database.
- `packages/web` — React PWA. Served by the server on the same origin; also the Windows UI in a browser.
- `packages/shared` — types and Zod schemas shared by all three.

## Where this is heading: every platform, and the server in Docker

Stated as a goal on 2026-10-14, and it outranks convenience in any decision
made from here on: **the app is meant to work on every platform eventually, and
the server is meant to run in Docker**, since nearly every computer and server
can run Docker. Today it runs on one Windows PC; nothing new should make that
harder to change.

**Docker carries the server, not the agent, and that split is already the
architecture.** A container is Linux (on Windows and macOS, inside a Linux VM),
and it is cut off from the machine it runs on: it cannot ask which window is in
front or whether a game fills the screen, read how long since the keyboard was
touched, open the microphone, or put an icon in the tray. (None of that is
recording: the agent never captures the screen, and audio never leaves it as
anything but text. It asks the operating system a handful of questions about
windows and processes.) So everything that senses or acts on the machine stays native, in an
agent per platform: the attention sensor, the tray icon, the popup over games,
hotkeys, sounds and voice capture. The server is the part that moves. The two
already speak only HTTP ("the agent is an HTTP client like any other"), which
is the boundary that makes this possible; keep it.

**Rules that follow, for anything written from now on:**

- **The server must not shell out to the operating system.** No PowerShell, no
  `cmd /c start`, no `explorer.exe`, no Windows paths. If something needs the
  machine (launching a game, opening a folder, restarting the native install),
  it is the agent's job, asked for over HTTP.
- **Prefer dependencies that ship for Windows, macOS and Linux, x64 and arm64.**
  The voice engine is the live example: it was Vosk, bound through koffi to a
  bundled Windows `libvosk.dll`, and is now sherpa-onnx, which publishes
  prebuilt packages for all six (switched 2026-10-14; see **Voice**). Voice runs
  in the agent, so Docker does not decide it, but the every-platform goal does.
- **Anything Windows-only is fenced behind a platform check and degrades with a
  sentence**, the way the manga setup already says "setting up automatically is
  for Windows" rather than failing.

**Where it stands (2026-10-14).** Server-side code that assumes Windows today,
found by searching for shell-outs, and what each would become:

| Where | What it does | Belongs |
| --- | --- | --- |
| `routes/restart.ts`, `routes/update.ts`, `routes/agent-start.ts`, `routes/desktop-icon.ts` | run the `.ps1` scripts through `cmd /c start` | the native install's own tools; in Docker the container restarts itself and updates by image |
| `routes/games.ts` | launches a game, shows it in Explorer | the agent |
| `modules.ts` | opens the packages folder in Explorer | the agent, or a download in the browser |
| `routes/connect.ts` | reads `tailscale.exe status` | per-platform lookup, or a Tailscale sidecar in Docker |
| `modules/manga/server/process.ts`, `setup.ts` | downloads a Windows Java, runs `java.exe`, opens logs in Notepad | in Docker, Suwayomi as its own container beside the server |

**The Dockerfile is stale and would not work as it is.** It copies
`packages/shared` and `packages/server` only, so a container built from it has
no shipped packages (`packages/modules/`: manga, voice's server half,
integrations, weather, vault, push) and no built PWA to serve. It was written
before either existed and has never been run since.

## Features: switched off, or gone entirely

The nudge engine is the app; everything else is optional. Which optional parts
run is a property of the *install*, declared in `features.json` at the repo root
(gitignored — copy `features.example.json`). `npm run features` shows what is on
and what is actually on disk.

```
npm run features                        # what am I running?
npm run features -- --set voice=off     # switch something off
npm run features-check                  # prove it still boots without them
```

`packages/shared/src/features.ts` is the one list all three packages read, so
they cannot disagree about what "voice is off" means. The PWA is the exception —
it does not import `shared` — so the server hands it a plain `string[]` on
`/api/session`.

**Three levels, and they are genuinely different things:**

| | Means | Costs back |
| --- | --- | --- |
| **off** | routes unmounted, tab hidden, agent never loads it | the RAM and the microphone |
| **deleted** | the folder is gone; the app boots and says "not installed" | the disk, and the code you'd otherwise have to trust |
| **not removable** | can only be switched off | — |

`habits`, `notes` and `time` are switchable but **not** removable: the Dashboard
renders habits inline, and deleting them would leave a hole in the one screen
that is the point of the app. The manifest says so rather than pretending
otherwise, because a `removable: true` that isn't sends somebody deleting a
folder and into a broken build.

**Enabled and installed are tracked separately**, on purpose. "You switched the
vault off" and "the vault folder is gone" look identical if you collapse them
into one boolean, and they have completely different fixes. `/api/session`
returns `features` and `featuresMissing` for exactly that reason.

**Core must never import a feature — not even a type.** A type-only import is
erased at runtime, so it would not crash; it would just fail the type check for
whoever removed the folder, silently, until they tried to build. That is why
`VoiceConfig` lives in `client.ts` (core, which fetches it) rather than in
`features/voice/voice.ts` (deletable, which uses it).

Where core genuinely needs a feature, it calls through a port:
`push-port.ts` holds a no-op implementation that the push feature replaces when
it loads. The fallback is not a stub — "push is not installed" and "no phone is
subscribed" are the same situation, and the engine already handled the latter
correctly.

**What does not go away is the database schema.** Migrations are a linear
journal and skipping one breaks every later hash, so `vault`, `vault_entries`
and `voice_commands` are created whatever is switched on. They sit empty. That
is the honest boundary of "removable" here.

`features-check` copies `src` to `src.featurecheck` — the same depth, so every
relative path still resolves — deletes a feature from the *copy*, and boots it.
Nothing in the real tree is renamed or deleted, so an interrupted run cannot
cost anybody their source.

## The PWA

React + Vite, no router and no state library — the current view is `useState`,
data loading is a 30-line `useAsync`. React and ReactDOM are the only runtime
dependencies of the app itself, which is 66KB gzipped and nearly all of it
framework. The one other is Leaflet, inside the Trips screen's own chunk: see
**Trips**.

### Screens

- **Dashboard** — capture, the nudge queue, then tasks bucketed as *Due today*,
  *Anytime* (no date) and *Coming up*, habits left, and *Finished today*.
  Every task has a home here; one with no date used to vanish from view.
- **Tasks** — the full list with editing, open above, done below.
- **Habits** — *management*: reorder, edit, pause, delete, and a −/+ stepper to
  correct the tally. Ticking one off day to day belongs on the Dashboard.
- **Notes** — a linked notebook: folders, `[[wiki-links]]`, backlinks, tags, a
  graph, and a way in from fourteen other apps. See **Notes** below.
- **Settings**.
- **Home** — every other screen as a tile. See below.

### The phone opens on a home screen

`Home.tsx`: every part of the app as a tile, four across, and the first screen
on anything under 768px wide. On a phone the drawer is off-screen, so opening
the app went straight to the Dashboard and everything else was a slide and a tap
away; a launcher is one tap to anywhere, and it is how the phone around it
already works.

**The tiles are the drawer's own list**, the same items in the same order with
whatever is switched off already gone and any package's tab included, so the
two cannot disagree about what the app has. The PC still opens on the
Dashboard, and Home is in the drawer on both.

**It draws its own heading, so the page's is hidden** while it shows, through
`.app:has(> .home-screen)` for the reason the Dashboard's second column uses
`:has()`. With the heading gone a banner would be the first thing on the page,
under the fixed ☰, so it keeps the row the heading held.

**Hover is only applied where there is one** (`@media (hover: hover)`). A phone
applies `:hover` to whatever was last tapped and leaves it there, so the tile
you just came back from would stay lit.

### Sections: a screen's parts in the menu and on Home

A feature's `meta.ts` can declare `sections`: parts of its screen worth
reaching directly. Connections declares its five tabs. Each is listed under its
screen in the menu (indented, `button.sub`) and offered as a Home tile.
Opening one opens the screen with the section id as `focus`, which the screen
reads as "show this", the same opaque `focus` the right-click menu uses. App
also keeps which section was opened, so the menu can mark it.

**On Home "once it is set up".** A section's `onHome` can be `'ready'`, with a
`ready()` App asks on load and on every change announcement. Music is ready
when Spotify is connected and allowed to play. Before that its tile would only
open a setup screen, which is not worth a place on the first screen.

**Your choices are overrides, per device** (`menu-prefs.ts`, `localStorage`):
the menu is mostly the PC's, and which tiles fit on a phone's first screen is a
fact about that phone. Only overrides are stored, so a section added later
follows its default instead of being invisible for not being in a saved list.
A screen is always in the menu: one reachable only by a tile you might hide
would be lost. App publishes its entries to `menu-prefs`, which is how Settings
lists them without knowing anything about navigation.

**A screen with tabs says which is showing** (`showingSection` in `nav.ts`),
so the menu's mark follows the tab: picking Friends on Connections left Music
marked, because the menu only knew what it had itself opened. App marks the
section when the menu lists it and the screen's own entry when it does not, and
clicking the screen's entry while already on it leaves the tab's mark alone,
since the tab stays where it was.

**Home can be your own list** (`homeList`). Until arranged it shows the defaults;
once arranged in Settings → Home screen, which is the Dashboard's
`OrderedPicker`, it shows exactly that list in that order. So hiding everything
but a few is what an arranged Home is, and *Remove everything* starts from
nothing. The cost is the Dashboard order's: a section added later is not on an
arranged Home until you add it, and Settings offers it underneath and says so.
The menu's section switches are a card of their own.

**The Music tab is its own setup.** Until Spotify is connected and has the
playback permission, it shows three steps and the Spotify card from Services,
exported as `ProviderCard` and opened (`startOpen`). It is the same card, not a
copy. "Go to the Services tab and find Spotify" was a second errand before the
first.

### Groups: screens under one heading in the menu

**World** holds Weather and Trips (`menu-groups.ts`). A group is a heading
that folds, not a screen: each member is still its own screen and its own
package, and either can be switched off or deleted. That is why it was chosen
over one screen with two tabs, which would have tied two deletable packages
together.

**Each member names the group in its own `meta.ts`** (`group: { id, label,
glyph }`), because there is nowhere shared to write it once: a package may not
import another, and core does not know which packages exist. The menu gathers
every screen naming the same id at the place of the first of them, whatever
their `order`, and the first member's label wins if they disagree. A group with
one member left keeps its heading; one with none is not drawn.

**Only the menu is grouped.** Home keeps a tile per screen, since it is a
launcher of screens, and Settings lists screens as before. **A group starts
folded**, so World is one line until opened; what is stored, per device in
`localStorage` like the notes tree, is the groups you opened, which makes a
group added later folded too. A folded group still shows the screen you are on,
so the mark saying where you are is never folded away.
Verified in the browser: folded, the menu lost Weather and Trips and kept the
heading; opened on Trips and folded, Trips stayed, marked as current.

### Both columns are chosen side by side

The two pickers sit as two columns of equal width on the Settings screen,
because they configure the two columns of the Dashboard. Stacked — which is how
they first shipped — they read as two unrelated settings, and the second was
below the fold on a laptop.

**A container query, not a media one.** What decides whether two columns fit is
the width this screen actually has, and docking the menu takes 260px of it
without the window changing at all. Measured at a 1440px window with the menu
docked: the pair has **1141px**, not 1440, and splits into two 564.5px columns.
At 820px it has 521 and stacks. A viewport query would have been asking about a
number that is not the one that matters — the same mistake the notes screen made
and the same fix.

**The container is a wrapper, not the grid**, and that is not tidiness. A
`@container` rule styles *descendants* of the container and never the container
itself, so declaring both on one element is a rule that silently never applies —
the layout stays stacked at every width with nothing anywhere saying why. Caught
by writing it the wrong way first.

`align-items: start`, so the shorter card keeps its height rather than
stretching to its neighbour's and leaving a long run of empty card under
whichever list is shorter.

**The refresh rate moved above both.** It used to sit inside the side-column
section, on the reasoning that the panels are the part of the Dashboard whose
content moves without anybody touching it. That was true when the main column
held only your own tasks; it is not now that a shelf card can sit there and go
stale exactly as a panel does. It governs both columns, so it sits above both.

### The Dashboard itself is a list too

`settings.dashboard_blocks`, the same shape as the panel list below: a JSON
array of opaque ids. The main column used to be a fixed run of JSX, so "put
habits at the top" was an edit to `Dashboard.tsx` rather than a setting — and a
package could contribute a card to the narrow column *beside* the content but
never to the content itself.

**Core's seven sections are ids like any other.** `blocks.ts` lists them with
`core:` ids and `Dashboard.tsx` looks each up in a map it builds from its own
state. They are closures, not components, deliberately: every one reads the same
`tasks`, `habits`, `settling` and `reloadAll`, so making them components would
mean threading all of that through each to gain nothing. The ordering is a list
of strings; what the strings name is that map.

**A panel put in this column is resolved exactly as the side column resolves
it**, through `resolvePanel`. So the main column holds two kinds of thing and
the loop that draws it does not know which is which — which is the whole point,
and is what lets a package's card sit between your tasks and your habits with
nothing in core learning it exists. Verified by putting the weather card
between habits and capture.

**Empty means the default order, not an empty Dashboard**, and that is the one
place this differs from the panel list, where empty is a real choice. An empty
side column is something somebody picks; an empty Dashboard is not, and it is
what every install in existence would have had on the morning this shipped. So
`[]` means "whatever the app ships with", `CORE_BLOCKS` is both the registry and
that default, and removing everything gives you the default back rather than a
blank page.

The cost is stated on the screen rather than hidden: once you have chosen an
order, a section added in a later version does not appear until you add it — so
the picker lists everything available rather than only what is unused, and says
which of the two states you are in.

**A core section whose feature is switched off is dropped**, which today means
`core:habits`. The section is core's but the feature is not always on, and a
heading with nothing under it is worse than its absence — the same respect
`notes:recent` pays its own switch.

**The picker is one component used twice.** It was written for the side column
and the main column needed exactly it, so `OrderedPicker` took the ↑/↓, the
add/remove and the "not in this build, kept for when it is back" note, and both
sections render it. The same call `useButtonMenu` made when the New menu wanted
the right-click menu's measuring and clamping.

Cost: **101.4KB → 102.3KB** gzipped on the main bundle for the whole thing.

### The Dashboard's side column

A second column on a wide screen, holding **as many panels as you like, one
under the other, in an order you choose** — who is online, who is live, recent
notes; by default nothing. `settings.dashboard_panels` is a JSON array of opaque
ids, server-side like the theme so the PC and the phone agree.

**`dashboard_panel` is still written, as the first entry.** It is not dead
weight: the PWA and the server update independently, so a browser holding an
older bundle reads that field and draws one panel rather than an empty column.
Migration `0039` backfills the list from it, so nobody loses what they had.

Reordering is **↑/↓ *and* a drag**, both writing the whole list, the same idiom
the Habits screen uses. A panel is appended when added rather than inserted,
because the bottom is predictable and anywhere else is a guess about intent.

**The drag reverses what this said**, which was that "drag and drop is the one
interaction that has to be built twice — once for the mouse and once for touch".
That is true of HTML5 drag-and-drop, which does not exist on iOS at all and is
why the notes tree's drag is desktop-only and documented as a gap. **Pointer
events are not that**: one set of handlers, and a finger is a pointer. The
objection was to a particular way of building one, not to the thing. Reported as
the arrows being fiddly once the list grew past three or four, which they are.

**The grip is a handle, not the whole row**, and that is what makes it work on a
phone. A drag can only begin on touch once the browser is told to stop scrolling
— `touch-action: none` — and on the whole row that would mean the list could not
be scrolled past at all. On a grip it costs nothing: everywhere else in the row
still scrolls.

**The arrows stay, and not out of politeness.** They are the keyboard's way: the
grip is `aria-hidden` and deliberately not focusable, since a third control that
does what the two beside it do and cannot be operated by keyboard is noise to
anybody using one.

**The list on screen is a draft until the save comes back.** Dropping writes the
whole list, and clearing the draft at that moment would snap the row to its old
place for the length of the round trip and then jump it forward again — which
reads as the drag having failed and then un-failed. The draft is held until the
saved value arrives and matches. A drag that ends where it started writes
nothing at all.

Verified by driving real pointer events both ways: a mouse drag of the last row
to the top, and a `pointerType: 'touch'` drag of the first row to the fourth,
each reordering live during the drag and persisting after it.

Each panel gets **its own Suspense boundary**, not one around the column: they
are separate chunks that arrive independently, and a shared boundary would hold
every panel back until the slowest had landed.

A chosen panel whose feature is switched off **keeps its place in the list** and
says so on the settings screen, rather than being dropped — the stored order is
left alone so turning the feature back on restores it, and the Dashboard simply
draws one fewer meanwhile.

**Core cannot import the panel it most wants.** The Dashboard is core and the
friends list lives in `features/integrations`, which is deletable. That is the
same bind the drawer was in, solved the same way: a feature declares `panels` in
its `meta.ts` and exports a lazy `panel.tsx`, and `features/index.ts` finds them
with `import.meta.glob`. A build with the folder deleted offers one fewer
option and nothing in core changes — verified by building the PWA with
`features/integrations` moved aside.

The stored id is **opaque**, like `settings.hidden_providers` and `tasks.source`.
Nothing validates it, and an id nothing answers to draws no panel — which is
what should happen while a feature is switched off, and means switching it back
on restores the panel you had rather than finding the setting silently rewritten
to empty. The Settings screen says so rather than leaving a column mysteriously
absent.

Three details:

- **The container widens through `.app:has(.dash.has-panel)`**, not through a
  class `App` passes down. `App` does not read settings, and threading one
  boolean through it to set a `max-width` would touch three components for a
  layout question the child already knows the answer to. Where `:has()` is
  unsupported the page stays at its reading width with the panel stacked
  underneath — which is the narrow-screen layout, so the fallback is a real one.
- **The breakpoint is 1100px, not the drawer's**, and they are deliberately
  different questions: the drawer's is "is there room for a drawer beside the
  content", this is "is there room for a second column without squeezing the
  first". At 900 — which is what the drawer's default used to be, and is now the
  lowest it offers — with the drawer showing, the task list would be left about
  320px, narrower than the phone layout it was designed for. That mismatch is
  part of why the drawer's default moved to 1200.
- **Panels are lazy, and one import nearly cost 9.5KB.** `panel.tsx` imported
  `STATE_LABEL` from `Friends.tsx`, so choosing the panel pulled in the whole
  Connections screen — searching, filtering, account linking — to render six
  words. Rollup cannot tree-shake that: importing any part of a module pulls the
  module in. `presence.ts` now holds the table, and the panel costs 1.0KB
  gzipped against the 9.5KB it was dragging.

**Each person is a button, and the panel has one of its own.** Clicking a row
lands on Connections → Friends with that name in the search box; "Change what's
here" goes to the setting that decides what the column holds. The whole row is
the button rather than a magnifying glass beside the name — in a 320px column an
icon per row is width taken from the thing the column is for, and a row-sized hit
target is easier to hit than a 20px square. The settings button lives on the
Dashboard's `aside` rather than inside each panel, so every panel gets it and no
feature has to know that the setting exists.

The friends panel shows only `in-game`, `online`, `away` and `dnd`. `unknown` is
excluded, which matters more than it sounds: Discord's REST API carries no
presence, so every Discord-only friend is `unknown` — 87 of them here against a
couple of dozen of everything else — and including them would bury the handful
of people who are genuinely there.

**Settings is pinned to the foot of the drawer**, not merely last in the list.
The list grows — every feature adds a tab above it — and a Settings entry
drifting down the middle of things you use daily is how it becomes hard to find.
One `margin-top: auto`, since the nav is already a flex column.

**Settings has tabs**: *General*, *Notifications*, *Devices*, *Packages*. One
long scroll was fine when the screen was a theme picker and a quiet-hours
switch; it is now appearance, reminders, push, sound, four kinds of device and
the switches that decide which parts of the app exist — and whatever you came to
change was always in the middle of it. Which tab is open is `useState`, like
every other bit of navigation here.

### Packages, from the app rather than a terminal

`npm run features -- --set voice=off` has always written `features.json`. Having
that as the *only* way meant the answer to "how do I turn the microphone off"
was "open a terminal", which is the friction the three double-clickable files in
the repo root exist to remove. `GET/PATCH /api/features` does the same write,
local-only like every other change that touches this machine.

**It takes a restart and says so.** `features.ts` resolves the set once at
module load, because half the app's structure depends on it — routes registered
or not, the agent importing a folder or not. Re-resolving live would mean
unregistering Fastify routes at runtime, which is a large fragile thing to build
for a switch flipped twice a year. So the screen reports `pendingRestart` when
the file no longer matches what is running, and the tray's **Restart** is one
click away. Verified end to end: switching `time` off wrote the file, and after
a restart `/api/time/current` returned 404 and the feature left
`/api/session`.

**The path to `features.json` is exported from `features.ts`, never re-derived.**
The route sits one directory deeper and counted `..` by hand, so it read *and
wrote* `packages/features.json` — self-consistent, and therefore convincing: the
screen reported the change, asked for a restart, and the restart would have
changed nothing at all.

`EVERYTHING_FEATURES` overrides the file, so when it is set the switches are
disabled with that as the reason. A toggle that silently fails to apply is worse
than one that explains why it cannot.

**Each package shows a version, and today they are all the app's.** That is the
honest answer rather than a limitation: everything in the list ships out of this
repo in one commit, and the five workspace packages deliberately share one
number. A `FeatureSpec` may carry its own `version`, and when it does the row
says **(separate)** — that field exists for the case being built toward, a
package downloaded rather than bundled, which genuinely can differ from the app
around it. Verified by giving one a version and watching the row diverge.

**Check for updates is present and disabled**, with the reason on screen:
`UPDATE_URL` is unset and there is nowhere to ask yet. Nothing is fetched from
it even when set, because the format does not exist — declaring the setting now
is what makes turning it on a small change rather than a new concept. A button
that fails when pressed would be worse than one that says why it cannot.

### Weather, and what "once a day" actually means

`packages/modules/weather/` — the first thing built *as* a package rather than
migrated into one, which makes it the honest test of whether the last two
sessions' work was worth it. It needed no change to core: a tab, a Dashboard
panel, four endpoints and a file on disk.

**Open-Meteo, because it needs no account and no key.** Every alternative worth
using wants a registration, and this would then have arrived as a screen that
could only apologise until you had gone and made one. `npm run weather-check -w
@everything/server` proves the decisions; `--live` also fetches for real.

#### "Once a day" is a staleness window, not a timer

The obvious reading is a `setInterval` at 24 hours, and there deliberately isn't
one. This project requires anything on a timer to justify itself against the
attention loop's numbers, and a timer loses on all three: it fetches on a machine
nobody is looking at, it needs a handle and an `unref` and an `onClose` or
`smoke` hangs on an app that will not close, and it *still* would not guarantee
fresh data when you look — the reading could be twenty-three hours old.

So `GET /api/weather` refreshes anything older than a day as a side effect of
being read, exactly as the friends list and the live streams do. Opening the tab
five times costs one fetch; never opening it costs none. The observable behaviour
is "about once a day", and a PC left alone makes no requests at all.

The screen says so rather than letting you infer it, because somebody watching
for a fetch at midnight should know it will not come.

**Once an hour is a third window, not a third mechanism.** `STALE_AFTER` maps
each mode to its window and `manual` to null — null rather than Infinity, since
"only when I ask" is the *absence* of a window rather than a very long one. A PC
nobody is looking at still makes no requests in any mode.

#### The number moves without fetching again

A once-a-day reading taken at eight in the morning was still showing eight in the
morning's temperature at four in the afternoon — stale in the one way anybody
notices, and refetching to fix it would throw away the reason the mode exists.

But the reading already contains the answer: `hours` is the next twenty-four and
one of them is now. `nowFromReading()` reads it forward, at no request, matching
the hour by string for the reason `sliceHours` does — the timestamps are local to
the place with no offset, so arithmetic against `Date.now()` is right only while
the server and the place agree. Verified on this install: a reading fetched 100
minutes earlier said 76°, and the screen said 71°.

**It is a forecast, not a measurement, and it says so.** The hour the fetch
happened in is the real observation and keeps its own values — it is a
measurement, and it carries the humidity and wind the hourly rows do not. Every
hour after it is what the service expected, and the screen labels it rather than
presenting an expectation as a reading.

**"Feels like" had to move with it, and that took a new field.** The first
version moved the temperature and left the fetched comfort beside it, so the line
read *"71°, feels like 76°"* — contradicting itself. `apparent_temperature` is
now requested hourly and stored per hour; a reading written before that field
existed has none, so the clause is **omitted rather than guessed**.

Resolved server-side, like the gauge level: in the browser it would depend on the
*device's* clock, and a phone a few minutes out would disagree with the PC about
which hour it is.

**Manual mode never does this.** `isDue` returns false outright — a setting
called "only when I ask" has to mean it or it is not worth having, the same rule
`quietHoursEnabled` follows. `weather-check` asserts both tempting cases: never
fetched, and a reading a month old.

#### The hourly graph

Twenty-four hours as a line, drawn by hand in SVG like `Gauge.tsx`. A chart
library would be the largest dependency in this repo by some margin, for one
graph on one screen in a bundle that is 90KB and nearly all of it React. The
whole tab costs **3.1KB gzipped and only when it is opened**; the panel is
0.8KB, and the main bundle did not move.

**It fits, at every width.** This first shipped as a fixed-width SVG in an
`overflow-x: auto` box — the rule this document states for wide content, and the
wrong rule here: a graph you have to drag sideways is not one you can glance at,
which is the only reason to draw a graph instead of printing a table. Scaling it
with `viewBox` plus `width: 100%` is worse again, because it scales the *text*
and a phone gets six-pixel labels.

So the box is measured and the SVG drawn at exactly that width, text at a fixed
size — what `ContextMenu` does rather than guessing. All twenty-four hours are
always plotted; what gives way on a narrow screen is how many are **labelled**,
which is the one thing that can go without the graph becoming a different graph.
Twelve labels at 1280px, eight at 375px, and the step is chosen from divisors of
the day so they land on hours a person thinks in.

`min-width: 0` on the wrapper is what actually lets it shrink — it sits in a flex
card, and a flex child defaults to `min-width: auto` and refuses to go below its
content. That was the scrollbar.

**Three measurements, and the reason is that the test environment cannot check
the good one.** `ResizeObserver` is correct — the width that matters is the
card's, and opening the drawer narrows it without the window changing — but a
browser pane that is not compositing frames delivers **no RO callbacks at all**,
not even the initial one. So there is also a `resize` listener and a re-measure
after each render, both verified working with RO dead: 325 → 240 on a resize
event, 240 → 200 on a re-render.

Worth knowing beyond this graph: **`ResizeObserver` joins `requestAnimationFrame`
on the list of things that measure nothing in a pane nobody is looking at.**

**Which hour is "now" is not a subtraction.** Open-Meteo returns timestamps
local to the *place*, with no offset — `2026-08-22T14:00` means two in the
afternoon there. Parsing that with `new Date()` yields a value in the *server's*
zone, so comparing it against `Date.now()` is correct only while the two happen
to agree: right all year in Philadelphia, five hours out for London. So the
current hour is found by asking `Intl` what time it is there and matching the
string. String matching looks crude beside date arithmetic and is the thing that
is actually correct, because the strings are the authority. `weather-check`
asserts the same instant starts at 14:00 in New York and 19:00 in London.

**Timestamps are stored, not just values.** A reading can be days old in manual
mode, and a bare array of numbers would be drawn as though it started now.

Three smaller choices:

- **Night is darker than day**, which the first version had backwards. The band
  was `--muted` at low opacity, on the reasoning that a neutral grey is the least
  intrusive thing available — but grey over a dark card is *lighter* than the
  card, so the night hours were the bright part of the chart. It is black now, at
  0.3 on dark and 0.09 on light: the same intent needs different arithmetic over
  near-black and over white, which is why the accents are declared twice too.
- **Rain bars are scaled against the wettest hour, not against 100.** A day of
  light drizzle would otherwise draw as a flat empty strip and read as no rain
  at all.
- **The line takes `--accent`; rain keeps its own blue.** The same distinction
  the presence dots draw: the line is a shape, the blue is a meaning learned
  from every other weather app, and an amber accent would make a downpour look
  like a warning about something else. Checked across three accents.
- **Night is drawn as runs, not a rect per hour**, which leaves hairline seams at
  some zoom levels — and clamped to the chart rather than left to the SVG
  overflow default to tidy up.

A colour and a line say nothing to a screen reader, so the SVG carries an
`aria-label` giving the range, the span and the starting hour — the summary a
person would give if asked what it showed.

#### The button is always there, in both modes and on both surfaces

In `manual` it is the only way to fetch; in `daily` it is how you get a reading
*now* rather than whenever the window lapses. A control that appeared and
disappeared with a setting would be one more thing to work out.

It is on the **panel** as well as the tab, because "always there" has to mean the
screen you are actually on — having to open a settings tab to press it would make
manual mode not worth choosing.

#### The last reading is kept, and its age is always on screen

Which is what makes manual mode usable rather than a blank screen: you press the
button when you want, and what you saw last stays, labelled. A failed fetch is
**stored next to the reading it could not replace**, so the screen shows
yesterday's weather *and* why it is yesterday's — either alone is worse, since a
stale number with nothing admitting it is stale is the failure this app is
against.

#### Two smaller things

- **A package cannot add a table.** Migrations are a linear journal and the
  schema is core's whatever is installed, so state goes in `data/weather.json` —
  the same arrangement the app logo and the habit pictures use. `dataDir` is
  exported from `module-api` for exactly this, with the warning that two packages
  choosing `cache.json` would find each other's.
- **A place is searched for, not typed as coordinates.** Nobody knows their own
  latitude, so that setup step would have been "go and look it up somewhere
  else". The candidates are listed rather than the first hit taken, because there
  are a great many places called Springfield — and the live check confirms it:
  Philadelphia returns five, in two different states.

### Trips: flights, a map, and the to-do list

`packages/modules/trips/`. A trip is a name, optional dates, and three lists:
flights, places and a checklist. Each feeds the to-do list, which is the reason
it is in this app rather than in an airline's: "leave for the airport" is the
reminder that must not land mid-match and must not be missed either, and as an
ordinary task with a due time the nudge engine already does both. `npm run
trips-check -w @everything/server` proves the rules with no network.

**A flight is a number and a date.** With a flight service key, one lookup
fills in the airports and times. Without one, or when the service does not know
the flight, the screen asks for the two airports and two times, and those are
**times at those airports**: 8:30 at DEN is 8:30 in Denver whatever zone the PC
is in. `zonedToUtc` places them with each airport's zone, asked of `Intl`; near
a clock change the first guess can be an hour out, so the offset at the guess is
tried and kept if it holds, and 2:30 on the morning clocks go forward lands an
hour later, as a wall clock does. Every time on screen is shown in its airport's
zone too, the way a boarding pass shows it.

**The airport table is fetched, not shipped.** Typed times need a zone and the
map needs a position, so `airports.ts` fetches the MIT-licensed `mwgg/Airports`
list once, cuts it to the ~7,000 airports with an IATA code and keeps it as
`data/trips-airports.json`. The voice models' reasoning: data from elsewhere,
fetched when needed. With a key the service sends each airport's position and
zone, so the table is only the fallback.

**Live status is AeroDataBox through RapidAPI**, with your own key, chosen
because it has a free plan you sign up for, needs no card, and reports gates.
`GET /flights/number/{number}/{date}`, the date being the departure date at the
departure airport, the date on a booking. Its free allowance is counted in
units, and the unit price of a lookup is theirs to set, so this counts
*requests* against a monthly budget you choose (250 by default) and the screen
says to check their pricing. Every request goes through the one function that
counts. The key is local-only to set and never sent back to a browser, like
every credential in the integrations package.

#### Watching a flight is the one timer here, and it is a single timeout

Delay alerts cannot be refresh-on-read: a gate change is only worth something if
it reaches you while you are doing something else, the argument the coursework
sync makes for its half-hourly check. But it is one `setTimeout` to the next
moment any flight is due a look (`nextCheckAt`), re-armed after every change and
at least every six hours, `unref`ed and cleared on close. With no key it never
runs; with no flight inside a day of leaving it sleeps until one is.

The spacing: nothing until a day before, every four hours until four hours out,
every twenty minutes until it leaves, hourly in the air, and once just after
landing for the baggage belt. About twenty requests a flight, all on its day,
which `trips-check` counts (22 for a three-hour flight). The windows run from
the **best known** times, so a flight three hours late is watched until it
actually goes. Reading the trips list also starts a look at anything due, in
the background, so a phone opened after the PC slept is not shown an old gate.

Lookups hold the store across somebody else's server, so the store is read
again afterwards and only the lookup's fields are copied, onto flights that
still exist. The manga sweep's lesson, applied from the start.

**What is worth a nudge** (`changesWorthSaying`): a departure moving by fifteen
minutes or more, a gate being announced or changed, a terminal change, a
cancellation or diversion. Not the first reading, which has nothing to compare
with. Within three hours of leaving the nudge carries a passed deadline, so the
engine delivers it at once, into a game if need be; further out it waits for a
stopping point like any reminder.

#### The tasks follow the coursework sync's rules

Check in (24 hours before by default), leave for the airport (2 hours domestic,
3 international, by whether the two airports are in different countries), and
each checklist item on its day relative to the trip's first day, which is typed
or taken from the flights. `tasks.ts` holds the rules, and they are the ones
Canvas already settled:

- **A deleted task stays deleted.** Each link keeps `made: true` after its task
  is gone, and a made link is never made again. Verified by deleting a check-in
  task and re-syncing.
- **A due date you moved is yours.** A task is moved to follow the trip only
  while its due date is still the one this package last set.
- **Removing a flight or a trip removes only its open tasks.** `done` and
  `dropped` are records.
- **Delays do not move "leave for the airport".** Bag drop closes by the
  timetable however late the plane is, and a reminder that slid later with
  every delay would talk you into missing it. The airline *retiming* the
  flight moves the timetable, and that moves the task.

#### The map is the one runtime dependency besides React

Leaflet 1.9.4, over OpenStreetMap's own tiles. It is 42KB gzipped and arrives
only with the Trips screen's chunk, which is 50KB gzipped in all; the main
bundle gained only the menu entry, under a kilobyte. A pannable, zoomable map is the one thing here that cannot be drawn
by hand the way the weather graph is, and it was chosen when the screen was
asked for.

- **No marker images.** Leaflet's default pin is a PNG found by a path its CSS
  guesses, which a bundler breaks. Markers are SVG circles in the accent.
- **Names go into tooltips as text nodes.** A tooltip given a string sets
  `innerHTML`, and a place's name came from a stranger's map edit or from you.
  The notes renderer's reasoning.
- **Flights are drawn along the great circle**, computed on the server
  (`greatCircle`), with the longitude carried past 180 rather than jumping the
  map. New York to Tokyo goes over Alaska, as it does.
- **Dark theme inverts the tiles** with a CSS filter. OpenStreetMap draws only
  a light map.
- **The map is redrawn only when its contents change**, keyed on a signature
  of ids and positions. The screen redraws as its clock ticks, and refitting on
  every render threw away wherever you had panned to.

Places are found through OpenStreetMap's Nominatim, from the server, because it
asks for a User-Agent naming the app (a browser cannot set one) and no more than
a request a second, which a queue in `places.ts` keeps to.

**The store refuses to read a damaged file**, unlike the weather's. The weather
is a cache and treats a bad file as empty; trips are typed, and treating a stray
comma as no trips and then saving would replace all of it. So an unreadable
`trips.json` is an error on screen and nothing is written over it. Writes go to
a temporary file and are renamed into place.

**A flight route answers two outcomes as replies, not errors**: `legs` when a
number flies several legs that day, and `needsTimes` when the service cannot
say. `apiRequest` keeps only an error's message, so anything the screen has to
act on has to arrive as a reply.

Verified against the running app with throwaway trips, then deleted: typed
times placed correctly in Denver, San Francisco, London and New York; the five
tasks made with the right due times; a deleted task not made again; the
checklist task moving a day when the trip's first day did; deleting the trip
leaving no task behind; and the map loading OpenStreetMap tiles with both routes
and four markers drawn, with no sideways scroll at 375px. **Not verified here**:
live status, which needs a key, and how the screen looks, since the browser pane
was hidden and would not take a screenshot.

### Manga is laid out like a reader

`packages/modules/manga/web/view.tsx`. The screen takes the shape of the
reading app it replaced on the phone: a bar across the top with the screen's
name and a search, the library as covers three across, and five tabs along the
bottom: **Browse, Library, History, Downloads, More**. A layout your thumb
already knows is worth more here than one argued from first principles.

**The top bar's left corner is the app's ☰**, not a button of its own. That
button is fixed to the top-left of the screen on every page, so the bar leaves
it a cell and the page's own title is hidden while this screen shows (this bar
is the title). The 🔍 goes to Browse → Search with the box focused; the Title
box on Library only filters what you already follow.

**The tab bar is sticky, not fixed.** Fixed pins it to the *window*, which with
the menu docked is 260px too far left; sticky pins it to the bottom of the
screen's own column, so it is one bar at every width without knowing the drawer
exists. The screen is at least the window's height, so the bar sits at the
bottom of a nearly empty tab too. Verified at 375px (0–375 across the bottom)
and at 1440px docked (260–1440). On a wide window the five items stay together
in the middle rather than spreading 240px apart.

**Each cover says four things**, and the order is how the old app drew them:

- **NEW** when the source has a chapter past the furthest you have read *or are
  partway through*, and only once you have read something. Before that every
  chapter is unread, and a badge on every cover says nothing.
- **The bar**, the newest chapter's number, across the tile: in the accent,
  or red when there is a chapter you have not read, so it says the same thing
  as NEW from across the room. Red whatever the accent, because red is what
  "something you have not seen" is on a phone.

  **WebKit gives every `<button>` `align-items: flex-start`; Chrome does not.**
  A tile is a button, so on the PC each line under the cover stretched to the
  cover's width and on the iPhone each shrank to its text: the bar became a
  small box around the number, and a long title ran into the next one instead
  of ending in "…". Found from a screenshot of the phone, since nothing on the
  PC could show it. `.manga-lib-tile` states `align-items: stretch`; a button
  used as a flex container anywhere else needs the same.
- **Where you read it**, with the language suffix stripped: it is the same on
  every tile and cost a third of the width.
- **!** on the cover when the last check failed, with the reason on hover and to
  a screen reader. The number beside it is then older than it looks, and
  saying nothing about that is the failure this app is built against.

The server resolves what the grid needs onto each series in `/api/manga`:
`latestNumber`, `readUpTo`, `lastReleaseAt` and `lastReadAt`. Only the badge's
comparison is done in the browser, since it is a comparison of two numbers the
server already decided.

**A Browse result is a cover, a title and a chapter count, in every tab.**
Search drew rows with every source that had the series, other editions and a
Follow button per row; Popular and Latest drew covers with a Follow button.
Following belongs on the series' page, after looking at it, which is where you
find out whether it is the right series and whether you want it at all. So
Search is the same grid, a tap opens the page with the other copies beside it,
and "· following" marks what you already follow.

The count is distinct chapter numbers (`distinctChapters`), not entries:
MangaFire lists two editions of most chapters. What Suwayomi has stored comes
with the results in one local query; the rest are asked for with
`/browse/chapters`, six at a time and **only for tiles that have come on
screen**, because a search can return two hundred results and a count not stored
is a request to that site: asking for all of them would be two hundred requests
for one search, which is how a source starts refusing. Measured: 8 asked for
on the first screen of a 198-result search. The observer is the same
`IntersectionObserver` the Library uses, so in a pane that is not drawing,
nothing is asked for until it is.

**Browse is at least three across too.** A column is 130px or a third of the
row, whichever is smaller (`minmax(min(130px, calc((100% - 16px) / 3)), 1fr)`),
and the covers fill their columns. It had been `minmax(130px, 1fr)` with a
fixed 110px cover centred in each cell, which on a phone was two covers and a
lot of nothing. Measured: three at 320px (85px covers) and 375px (103px), five
at 768px, ten at 1440px, with 8px between covers at every width.

**The last ten chapters opened are kept on disk** (`page-cache.ts`,
`data/manga-pages/`), page list and images, so going back to check something
is served by this machine rather than a round trip to the site through a
Suwayomi that may be asleep — a cached chapter opens with Suwayomi stopped.
Images are fetched in the background, one at a time, once a chapter's page
list is asked for, and a page the reader asks for first is kept as it passes
through. Bounded by chapters, not bytes: a long webtoon chapter is tens of
megabytes, so ten is a few hundred at most. `index.json` is the only record,
and a folder it does not name is removed on the next write.

**And a few are fetched ahead of you** (More → *Fetch ahead while reading*),
0 to 3, **one by default**. The cache above fills *behind* you — a chapter is
kept once opened — so going back was instant and going forward was not, which
is the direction people read in. One ahead is the chapter you are nearly
certainly about to open, and it costs one chapter of somebody else's bandwidth
for one you were going to ask for anyway; two is a guess and three is a guess
that costs three. Zero is genuinely off.

**Three at most, because the cache keeps ten.** A bound here is a bound on how
much of your history a guess may take: at three ahead, seven of the ten are
still chapters you opened yourself.

Four things about it are deliberate, and three are about not taking something
away to provide it:

- **It never starts Suwayomi.** `reader()` would, which is right for a chapter
  you asked for and wrong for a guess about one you have not — `on-demand`
  exists so a JVM is not resident for something used in bursts, and waking it to
  speculate would quietly undo that. So it asks whether Suwayomi is *already*
  up, the same question the release sweep asks, and does nothing if not.
- **It runs after the current chapter is filled, one chapter at a time.** The
  reader's own page requests are what must be fast; a prefetch racing them for
  the same source would make the chapter you are reading slower in order to
  serve the one you are not.
- **"Next" is by chapter number, not list position** — the rule the reader's
  arrows already follow. Verified on Eleceed, which lists two entries for most
  numbers: opening chapter 1 fetched 2 and 2.1 and skipped the duplicates at
  227 and 229. Decimal numbers are real and are not rounded past.
- **Anything already archived or already complete is skipped**, so re-reading a
  series you have saved costs nothing.

**A prefetched chapter is recorded as older than the one you are reading**, and
getting that wrong is silent. The ten are evicted by when they were opened, and
a chapter fetched ahead was never opened at all — recorded as "now" it sits in
*front* of the chapter in your hands, so at three ahead the one you are reading
is evicted before three you have not looked at.

The first version did exactly that, and the reason is worth keeping: the offset
was `Date.now() - 1 - i`, evaluated **when the prefetch runs** — which is after
the current chapter has finished downloading. Twenty seconds of downloading
later, "one millisecond behind" was ten seconds in front, and the cache ordered
itself backwards: no.4, no.3, then what was actually being read. Measured on
Archmage Curriculum before the fix and on Eleceed after it.

`readAheadAt(openedAt, nth)` is named and exported for one reason: so it can be
asserted. **The first version of that test asserted the intended numbers rather
than how they are derived, so it passed against the broken code** — it builds
the offsets through the real function now, with a twenty-second gap between the
open and the prefetch, which is the thing that was wrong.

**Shelves** (More → Shelves) group the library however you like, and
**membership is many-to-many**. A series could have belonged to one shelf like a
file to a folder, which is simpler to build and answers "which one is this in"
— these behave like tags instead, because that is what somebody sorting nine
hundred series wants and a single field would have made every arrangement
exclusive. The cost is stated rather than hidden: counts overlap, so the shelves
do not add up to the total, and the screen says so rather than letting the
arithmetic look broken.

Named on the More tab and **put on from the chapter list's head**, where a row
of chips sits under the title: one per shelf, plus the star, tapped to add and
tapped again to remove.

That was a correction. The first version offered it only in the tile's
right-click menu — which is a desktop affordance, and **touch has no
right-click**, so on a phone there was no way to shelve anything at all and on a
PC it was a feature you had to already know about. Reported as not being
findable, which it was not. The chips are visible rather than behind the ⋯ beside
them for the same reason: a menu is where you put what somebody already knows to
look for. The menu keeps its ticked lines, which are quicker once you know.

**A shelf can be hidden**, which keeps what is on it out of *Everything*,
and off the Dashboard: the shelf card and "landed lately" leave it out, and a
new chapter of one is recorded without a task or a reminder (`isPutAway` in
`library.ts`, asked by both). That is for
the pile you do not want to look at, without unfollowing it and losing where you
were. It is still one tap away, and the row marks it with a ◌.

**Hidden wins over every other shelf a series is on.** With many-to-many
membership a series can be on a hidden shelf and a visible one at once, and the
two say opposite things about *Everything* — so the one answering "keep this out
of my way" takes it, because an unreliable hide is worth nothing. Picking the
shelf itself always shows what is on it.

**And the count says so**: *890 of 891 · 1 put away*. It read "891 series" with
one deliberately kept out, which is the stale-number-as-fact this app is against
— and a count that has quietly dropped is the thing somebody goes looking for a
bug in.

Two things this cost, both found by measuring rather than reading:

- **`seriesSummary` did not carry `libraries`**, so every shelf filtered to
  nothing while the counts beside them said otherwise. The counts are computed
  server-side from the store and were right; the grid had nothing to filter on.
- **"Everything" is stored as the empty string**, and `getItem` hands that back
  as `''` rather than null — so a *reload* filtered for a shelf whose id is `''`
  and drew an empty library reading "0 of 891". Only on a reload, which is
  exactly when nobody is watching the thing they just changed.

**Removing a shelf keeps every series on it**, and the button says so in full
rather than relying on the word "remove" — a file manager's "delete folder"
takes the contents and nothing here does. The only things deleted are a name and
a set of memberships. Which shelf you are looking at is per device, like the
sort.

**Reading something you do not follow is recorded too.** Opening a chapter from
Browse used to write nothing at all — no history, no place kept — so dipping
into something and coming back a week later meant finding it again and
remembering where you were. The reader asks the server for a record the first
time a chapter opens, keyed on the source and its id, and from then on it
behaves exactly like a followed series: the same read route, the same position
route, the same History, with *not following* on the row.

**The reader's context resolves one too**, and leaving it out broke the whole
feature on its first real use: the reader asks `/api/manga/:id/chapters/:id/pages`
by id, that route's `reader()` helper looked only at `store.series`, and the
answer was **"no such series"** — a message about the one thing this exists to
avoid needing. Reported as "it says no such series but works after I add it".

Widening the helper's return to `Series | Glimpse` rather than casting is what
made the compiler name the one caller of ten that genuinely needs a followed
series: the chapter list's bookkeeping, which clears the failure flag the grid
shows and takes a baseline for the sweep. A glimpse has neither, so that block
is guarded and the rest of the route — title, source, read log, position — works
on either.

**And the series' own page reads it too**, which it did not: the details page
looked up read marks and the saved place only for a *followed* series, so a
series twenty-three chapters in drew every chapter unread and offered **"Read
chapter 1"**. `GET /api/manga/browse/manga/:mangaId` now finds the glimpse by
source and id, returns its marks and place, and hands back `glimpseId` so the
page writes into the record it has rather than asking for one. The top button is
a choice in order — *Continue ch. N* at your page, else *Next: ch. N* after the
furthest read, else *Read ch. N again* on the newest, else chapter 1 — because
always-chapter-1 was a button for the one place you were sure not to want.

**Deliberately a list of its own, not a `Series` with a flag.** 87 places in
this module read `store.series` — the sweep, the counts, the grid, the matcher,
the archive — and every one would have had to learn to skip a kind of series it
had never heard of. `store.glimpses` is a list nothing reads unless it means to.
Its fields are *named* to match `Series` where they overlap, which is not
tidiness either: `/api/manga/:id/read` and both position routes then work on one
unchanged, because they touch only those fields.

**Following one absorbs it.** The read log and the place move onto the new
series and the row goes, or History would list the same chapters twice — once as
"not following" and once not, with neither wrong. Verified: two rows before,
two rows after, and the glimpse gone.

**A record is asked for by the reader, not by Browse.** Looking at a cover is
not reading it, and a history of everything glanced at on a browse page would be
worth less than none.

**A series can be starred**, and that is a smaller set than the library. Every
series here is followed — that is what being in the library means — and the
Manga Reader import made the library *itself* "things you chose", since its
favourites became the whole shelf. So a star is the set inside it you actually
keep up with. On the ⋯ menu of a chapter list, first in that menu because it is
the only entry you would use more than once; everything below it is something
you do to a series once and never again. **Favourites** is second in the
Library's filter row, next to All rather than at the end — the other three are
fault-finding and this is the one you would leave on.

**Only `true` is ever stored.** Nine hundred series arrived from the import and
nobody starred any of them, so writing `false` onto every one would be a lot of
JSON saying nothing; `favourite` is optional and absent means no.

**The Dashboard card is `manga:shelf`**, a second panel from the same module —
`panel.tsx` branches on the id rather than becoming two chunks, since the two
share the request, the covers and the empty states. It shows the library or
only the starred, in an order that **follows the Library tab by default**.

That default is a `localStorage` read on purpose. The Library's sort is per
device — sorting the phone's shelf should not reorder the PC's — so a card that
followed a server-side copy would disagree with the screen it claims to follow.
Pinning an order instead stores it on the server, so a pinned card agrees
everywhere. The storage follows the wish rather than the other way round: "keep
these in step" is per device because the thing it follows is, and "I want this
one order" is shared because you said it once about the card itself. Verified
both ways on a real library of 890.

**The sort had to leave `Library.tsx` to be usable here.** Importing any part of
that file pulls the whole Library screen into the card's chunk — Rollup cannot
tree-shake that, which is the 9.5KB the friends panel once paid to render six
words. `shelf.ts` holds the comparators and has **no imports but a type**, the
same property `presence.ts` and `chapter-nav.ts` have, and `Library.tsx`
re-exports from it so no importer had to change.

**It draws the Library's own tile and the Library's own grid**, rather than a
list of thin rows. That was the first version and it was wrong in a way worth
naming: a card showing the same series as rows is a *second way of drawing a
shelf*, and the one you have to learn twice. The cover, the NEW badge, the
newest chapter on its bar and the source underneath are what a shelf looks like
here, so the card is those.

`Tile.tsx` is the extraction that made it possible — importing it from
`Library.tsx` would have pulled the paging, the filters and the sort row into
the card's chunk, which is the 9.5KB mistake again. Its four actions are
optional and the right-click menu is built from whichever arrived: the Library
offers all of them, the card offers only opening, because details, other-sources
and stop-following are things you do *to* a library rather than from a glance at
one.

**The card declares `container: manga-library`, the same name the Library
screen does.** The grid is three across until a `@container manga-library
(min-width: 560px)` rule widens it, so without that the card would be three
tiles across at every width including the full Dashboard. Named together rather
than the card copying the grid rules, which would be two definitions of one
shelf and the second to drift. Measured: 3 columns at 390px with 115px tiles,
5 columns at an 809px main column with 151px tiles, no sideways scroll at
either.

**Twelve tiles, and a count of the rest.** Every tile fetches its cover when it
mounts and this install follows nine hundred series — the Library draws sixty at
a time for that reason, and a Dashboard card is a glance rather than a page.
Twelve divides by three, four and six, so it ends on a full row at most of the
widths the grid produces; at five columns it does not, and a ragged last row is
what any responsive grid does. The "and N more" button underneath is what says
the list was cut rather than ended.

**"New chapters on top" is half of the order, and following only the other half
read as not following at all.** The Library's sort and its tick box are one
control there; the first version followed the sort and passed `false` for the
box, so a card claiming to mirror the Library put nothing new at the top of it.
In `follow` both come from that device. Pinned, the box is the card's own
(`shelfNewFirst`, server-side) so a pinned card agrees across devices in both
halves rather than one — and the box only *appears* in the settings while the
sort is pinned, because a second copy of it that did nothing is the lie the
disabled-slider case already argues against.

**Its settings are on the Manga tab, not in Settings.** Everything they decide
is about manga — which series, in which order — while Settings decides only
whether the card is on the Dashboard and where in the column it sits. The same
split the live panel's scope draws, from the other side.

**So the card carries its own button to them**, and that needed one thing core
had never wired. The side column has a single *Change what's here* on its
`aside`, which every panel gets free: the slot is core's, so the button about
the slot is core's. A card in the **main** column has no such shared edge — it
sits among the task sections with nothing around it — so the button has to be
the package's, and it goes somewhere core could not have sent you anyway.

`FeatureViewProps` carried `search` and not `focus`. Core has carried `focus`
for its own screens since the right-click menu, and this document already
describes it as "opaque, read differently by each screen" — it simply was never
handed to a feature, so a package's card had no way to link to the setting that
configures it. It is passed now, and `MangaView` answers `focus: 'shelf'` by
opening More and bringing that card into view with a moment of highlight, on a
`setTimeout` rather than `requestAnimationFrame` for the reason the Settings
screen took three goes to learn.

**It is not called "Change what's here".** Both buttons can be on screen at
once — this card in the main column, core's on the `aside` — and two buttons
with one label going to two different screens is worse than one name being
longer. Found by clicking the wrong one while testing.

**New-chapter notifications can be switched off** (More → New chapters),
beside the task switch. Off, chapters are still noticed and recorded, so the
NEW badge, the catch-up count and "last updated" carry on; only the nudge is
skipped. Switching off also expires the ones already waiting, because "I don't
want these" said while four sit on the Dashboard means those four as well.

**Browse hides tags you choose** in Popular and Latest, per device
(`hidden-tags.ts`). **Ecchi, Mature and Adult** always come first and are on
unless switched off; any other tag (BL, Romance) is added from quick picks, your
library's own tags, or typed. They were two levels, "adult" and "adult plus
mature", because sources tag violence and seinen "Mature" as well as sex
(MangaFire's popular page had it on Kingdom, Jujutsu Kaisen, Berserk and Tokyo
Ghoul); three switches say that more plainly. A hidden tag is matched as a
family where sources disagree (`mature.ts`): Adult covers smut, hentai, 18+,
R-18 and the rest; BL covers Boys' Love, Yaoi and Shounen Ai; GL covers Girls'
Love, Yuri and Shoujo Ai. Any other tag matches as written, ignoring case,
spaces and hyphens, and only whole tags, so Romance does not hide Romantic
Comedy. The line under the tabs says how many each tag hid. The old
`manga.browse-hide` value carries over once, and the server still takes an
older screen's `safe=` as the three it meant.

Neither obvious signal works: Suwayomi marks nearly every source installed here
NSFW because each *can* carry adult titles, and a listing rarely carries genres
(3 of 50 on MangaFire's popular page). So each title's genres are looked up —
Suwayomi's stored copy first, then the site, six at a time inside an
eight-second budget — and Suwayomi keeps what it fetched, so a page is slow once
and immediate after. A title still unknown when the budget runs out is **shown
and counted**, because hiding every unknown would empty a first visit to a slow
source.

**Opening a series fetches its chapters the first time.** The chapter list is
read from Suwayomi's stored copy so opening one does not scrape a site — and a
series just linked has no stored copy, so it opened empty, on whichever source
was picked. An empty copy now falls through to asking the site once. Found on
Second Life Ranker, whose source had all 234 chapters the whole time.

**Sort** is five orders (last read, most to catch up on, last updated, title,
recently added) plus a ticked **New chapters on top**, all remembered in
`localStorage` like the folded note folders, because sorting the phone's shelf
should not reorder the PC's. "New chapters first" used to be its own order; it
is last read with the box ticked now, so "what was I reading" is available
without "what has moved" pinned over it. *Most to catch up on* counts whole
chapters between where you are and the newest, which is also what the badge
says (`12 NEW`) — an estimate, since sources skip and split numbers.

**Favourites on top** is a second box beside it, off by default. With both
ticked the order is four groups: starred with a new chapter, new chapter,
starred, the rest, each in the chosen sort. New outranks the star because that
box is about what has moved; the star then orders each half. `sorted` ranks by
`2 × new + starred`, which gives exactly that, and either box alone moves only
its own group. The Dashboard card follows it like the other box, or keeps its
own on the server when pinned (`shelfFavFirst`). `shelf.ts` now has no imports
at all: its one type import pulled `manga-api.ts` into the server's typecheck
when `manga-check` started asserting the groups, so it describes the fields it
reads as `ShelfRow`.

**"Source not answering" was three things wearing one label**, which an audit of
a real library settled: 698 linked series, 8 of them marked broken, and the 8
were two unrelated problems with two different fixes.

- **A timeout** (5 of 8) — Suwayomi busy, a site slow. Nothing is wrong by the
  time you look.
- **"No chapters found"** (3 of 8) — the source *answered*, and said it has
  nothing for that id. This file already said so in the source-comparison
  route: "an answer rather than a failure — exactly what you wanted to know".
  That reading was honoured there and nowhere else. It has its own filter now,
  **Source has nothing for it**, because waiting does not mend it: the wrong
  entry was linked, or the series has been taken off that source, and the fix is
  to find another one.

**And a failure was sticky for days.** The oldest timeout was two days old. The
first attempt at that was to make a failed row *due* sooner — an hour instead of
its daily slot — and it changed nothing, because they were already due. The
measurement is what found it: those four rows had **216, 331, 451 and 216
series queued ahead of them**, all equally due, against a back half of twelve
slots that clears about eight an hour. A row 451 deep waits more than two days.

So `RETRY_SLOTS` reserves two of the twelve for rows whose last check failed —
the same answer `RECENT_SLOTS` gives the series you are reading. Two, not more:
a source genuinely down would otherwise spend a sixth of every sweep failing,
and these are the rows least likely to reward one. Verified on the real library:
**two sweeps took it from two to zero**, and the three that genuinely have
nothing stayed, which is correct.

**A series nothing can be asked about is skipped, not failed.** With its source
down (Suwayomi stopped, which in on-demand mode is most of the time) the sweep
falls back to MangaUpdates, and a series with no MangaUpdates id has nothing
there: it was asked anyway, as `/series/` with no id, and the 405 was written on
the row. Recently read series filled "source not answering" with it. Such a row
is now passed over without a record and checked when the source is back.

**Passed over before the slots are shared, not after.** The first version
skipped it inside the sweep, after `dueForCheck` had picked the twelve.
Skipped, it kept its old `checkedAt`, so with Suwayomi stopped it was at the
front of the queue again next sweep, and the next: the slots went to series
nothing could answer for, and the ones MangaUpdates could check waited behind
them for as long as Suwayomi stayed off. `dueForCheck` takes an `askable` test
now, and `manga-check` asserts twenty unaskable series leave all the slots to
five that can be asked. Found
after Suwayomi was stopped for a few minutes: 11 rows, 10 of them fine the
moment their chapter lists were opened.

**Eligibility and priority are different things**, and that is the part worth
keeping: a queue where everything is due is a queue where "sooner" means
nothing.

**The tile says when, not just what.** "Not answering" reads as a claim about
right now and is a claim about whenever it was last asked, which for something
you have not opened in a while can be a day or two ago. The hover now carries
the age beside the message.

**Filters** across the top: new chapters, **source not answering**, source has
nothing for it, no source yet, and a tag. Not answering means the last check or the last opening of its
chapter list failed — the chapter list now records a failure on the series and
clears it when the source answers, because the sweep alone reaches a dozen
series every half hour. In that view a cover opens the search for another
source instead of a chapter list that will only fail again.

**Tags come from the linked source** (`tags.ts`): Suwayomi's own stored copy
first, in one local query, then the site for the rest, a few per sweep and all
of them after an import's search finishes. Never by starting Suwayomi. They are
tidied to one spelling each, because sources disagree about case and one writes
"Manwha". The tag is not remembered: coming back to a shelf silently narrowed
to one genre would read as series gone missing.

**Manage extensions says what each is worth** (`extension-usage.ts`): the series
linked to its sources and the chapters finished there, distinct by series and
number, and is sorted by that, so one nothing reads from sorts last. Sources
are mapped to extensions by Suwayomi (`sources { extension { pkgName } }`), and
a chapter counts where it was read, not where its series is linked now; reads
from before the log recorded a source count nowhere, which is why imported
libraries show few. Each installed one has **Browse**, opening the Browse tab on
its source in a language you read (`pick`, which works on a Browse already
open), and Browse has a **Manage extensions** button back. What there is to add
can be scrolled in your languages, forty at a time, without typing.

**Any device installs, removes and updates, which reversed "a phone flags; the
PC installs".** Installing was local-only on the grounds that an extension is
code that runs here, and a phone could only flag one for the PC to install. But
the phone already reaches Suwayomi's own interface through More (`/manga/ui`),
which installs extensions and sets repositories with no such rule, so the guard
protected nothing and only added a trip across the room. The extension routes
and the repository list are now open to any paired device, like the rest of the
manga screen; repositories are still https only. Anything flagged from before
is listed first with Install and Unflag (`data/manga-extension-flags.json`),
and nothing makes new flags.

**Updating is on the same screen.** An extension with an update has its own
**Update**, and the Installed heading carries **Update all (N)**, or **Check for
updates** when nothing is known to be waiting, since it asks the repositories
again before updating and can find one the list has not shown yet. It is
`updateWaitingExtensions`, the daily run's own function, so the button and the
automatic run cannot disagree, and it leaves the same note the setup card shows.

**Ignored sources** (More, under the import card) are left out of searching,
browsing and finding imports, by id. Mangakakalot went there first: every
search answered "Cloudflare bypass currently disabled". A series already linked
to an ignored source still opens, since asking by id is untouched.

**Tapping a cover opens its chapter list**, which now carries the series' head
(cover, source, status, when it was checked and whether that failed) and a ⋯
holding what the library row's four buttons did: details, other sources, check
the site, unlink, stop following. Nothing was lost; it moved one tap in. A
series with no source yet has no chapter list, so its cover opens the
comparison that finds one. Right-click on a cover offers the same on the PC.

The head also has the series' **description**, two lines of it, with **More**
for the rest and who made it and its genres (`About.tsx`, `/api/manga/:id/about`).
It is the same component the series' page uses before you follow, so the two
screens about one series read alike. Suwayomi's stored copy is read first and the
site only when that has no description, so opening a chapter list does not
scrape a page for a blurb. Two lines rather than a character count, measured, so
it is two lines at any width.

**The chapters can be a grid** (*List | Grid* above them, per device in
`localStorage` like *One row per chapter*): each tile the chapter's number, and
under it your page, "read", or the upload date as "Apr 30", since "4/30" beside
"p. 4/30" reads as a page. A column is 110px or a quarter of the row, whichever
is smaller, so a phone is four across (77px tiles at 375) and a 1280px window
with the menu docked is ten. Saving one chapter stays on the list's ⬇; the grid
shows ✓ for a saved one and the Save bar still saves ahead. The read and
started colours are the rows', so the two views mark the same things alike.

The head counts **distinct chapter numbers**, not entries. MangaFire lists two
editions of most chapters, and the first version read "864 chapters" for a
series at 419.

**History** lists every chapter finished and the one in progress, by day, from
what the server already keeps: the read log on each series and the saved
places. `GET /api/manga/history` writes nothing to exist. It is mounted only
while shown, so it is fetched fresh each time, because the place is saved
without announcing a change and a copy held from earlier would be missing the
page you just left.

**More** holds what is set once and visited rarely: following by name through
MangaDex, the release settings, where chapters come from, and **series that
need a look**. The last is new. Those reasons were printed on each row of the
old list, a grid of covers has no room for a sentence, and a series that
silently never nudges looks exactly like a broken feature.

#### Reading: the controls get out of the way

`Reader.tsx`. A bar across the top (Back, the chapter's number, a gear) and
one across the bottom (previous and next page, the page counter, a strip of
every page to jump to), laid out like the reading app it replaced. They show
when a chapter opens and go after a countdown; a tap on the pages toggles them;
touching the controls restarts the countdown. With them away, the chapter, page
and time sit small in a corner.

**The reader takes the whole screen by leaving the app.** It is drawn into
`body` through a portal and `body.manga-reading > #root` hides the app, the ☰
included. It opens from four places (a chapter list, a series' details, a
details card inside Browse, the offline shelf) and inside each it wore that
screen's surroundings: a card's margins, Browse's tabs, and Manga's tab bar
drawn over the page strip. One rule beats a list of things to hide that grows
with every screen that learns to open a chapter. The window still scrolls, so
the read line and `scrollY` are unchanged, and closing restores the scroll
position taken during the reader's first render, before the page shrank.

**Handing the screen back nudges the window a pixel and back** (`take-screen.ts`).
Reported from an iPhone: after reading a while, the list came back blank until
it was scrolled. Not reproducible on the PC, so both suspects are covered. The
hiding was `body:has(> .manga-reader) > #root`, and WebKit has had bugs
re-checking a `:has()` when the element it names is removed; a class set by the
reader and the waiting screen (`useTakeScreen`, counted, since one replaces the
other in a single commit) is the plainest change to notice. And Safari under the
memory pressure of 48MB page strips drops the tiles of what is hidden and does
not always repaint it when shown, so closing the reader, and lifting the Manga
tabs' `hidden` when a chapter list or other overlay closes, both scroll 1px and
back 60ms later (`repaintSoon`). It does nothing while a reader is open again,
where putting the scroll back would undo the reader finding your page.

- **The arrows go between chapters, not pages.** Scrolling and the thumbnail
  strip already move between pages; the arrows were the one way to leave a
  chapter without scrolling to its end. Next from **the end of the chapter**
  marks it read, as the button at the end does; from partway through it only
  moves on, since skipping is not finishing — and it is drawn in the accent
  when it will finish, so which of the two a press will do is visible before
  it is pressed. What "the end" means is the next bullet but three. Each screen that opens the reader
  answers "the chapter beside this one" from its own list, by number, so a
  source listing two editions of chapter 50 does not stop the arrow at the
  second.
- **After a chapter with point chapters, Next has a second destination.** A
  source may list 2, then 2.1 and 2.2, then 3 — and **nothing can know what
  those are.** Sometimes 2 is a compilation that already contains them and the
  point chapters are the same pages split up; sometimes they are side stories
  or a later correction and genuinely come next. The numbering carries no
  signal, so guessing would be wrong about half the libraries it met.

  So it is not a rule about which to show. The arrow still goes to 2.1, because
  that is what "next" means when nobody has said otherwise, and a second
  control beside it goes to 3 — which is how you say otherwise. It is labelled
  with the number rather than given an icon, because "skip" says nothing
  without saying where to, and a second arrow-like glyph beside the first is
  the one thing guaranteed to be mistaken for it.

  **Offered only when it does something different**: not when the next chapter
  is already whole, not on the last chapter, and not when there is no whole
  chapter ahead at all. Nor when the next whole chapter is not the next
  whole *number*: from 2 or 2.1 it goes to 3 and no further. A source with a hole
  after the point chapters (2.1, then 8) turned it into a six-chapter jump
  labelled as skipping the extras; Next still goes there, and asks first. A control on every chapter that did the same as the
  arrow beside it is one nobody could learn. On Eleceed it appears on 40 of 461
  chapters.

  **Finishing by it marks the chapters passed over read**, and that follows
  from what pressing it means: skipping 2.1 and 2.2 to reach 3 is the claim
  that chapter 2 contained them, so leaving them unread would put a NEW badge
  and a catch-up count on chapters you have in substance read — and nothing
  later would ever clear it. From partway through it marks nothing, which is
  the arrow's own rule.

  **The Next arrow does not move when it appears, and nothing is reserved to
  achieve that.** The skip sits *before* Next inside a group pinned to the
  right, so the group grows **leftwards** into slack the bar already has: Next
  is flush right whether or not a skip is there.

  That took two goes, and the first is the instructive one. It had the skip
  *after* Next and always rendered, hidden with `visibility`, to hold the room
  open — Next stayed put, and every chapter without a skip showed 48px of
  reserved nothing at the end of the bar. **Reserving space is not the only way
  to stop something moving**, and it is the way that costs a hole; pinning the
  far edge and letting the group grow inwards costs nothing. Reported from the
  PC, a day after the same button was reported from a phone for the counter
  below.

  **The bar is three columns rather than `space-between`**, and finding out why
  cost a report from a phone. `space-between` centres the middle item between
  its *neighbours*, not in the bar — so the moment the right-hand side became
  wider than the left the page counter sat about 24px left of centre on **every**
  chapter, including the ones with no skip. Two equal `1fr` tracks put it in the
  middle of the bar whatever the sides weigh, and the sides still reach the
  edges — which is also what gives the group its slack to grow into.

  Measured at 1280px and at 390px, with the skip showing and absent: both arrows
  10px from their own edge, the counter off centre by **0**, and 59px between
  the counter and the skip at phone width. One button has now pushed this bar
  around twice; the three numbers above are what it is checked against.

  Unlike the chrome's own hiding, this one is meant to leave the tab order:
  `visibility: hidden` plus `disabled`, because a button that would do nothing
  should not be something to tab onto.

  `chapter-nav.ts` holds `beside`, `skipTarget` and `skippedBetween`. `beside`
  had been copied into `Chapters.tsx`, `SeriesDetail.tsx` and `offline.tsx`,
  and this would have been a fourth, fifth and sixth copy — "what is next" is
  one question however many screens can open a reader. The file has **no
  imports**, the same property that lets `presence.ts` be asserted, so
  `manga-check` tests the rule directly.

- **Hidden is `opacity` plus `pointer-events: none`, not `visibility`**, so a
  hidden control cannot catch a tap meant for the page but can still be reached
  by keyboard, where focusing it brings the bars back.
- **The bottom of the chapter means its last page**, whatever the geometry says.
  The counter otherwise takes the first page crossing the read line, which is
  right everywhere except the very end: a chapter whose **last page is shorter
  than the screen** leaves the page before it still crossing that line at
  maximum scroll, so the counter stops one short and can never reach the end.
  Next then reads as "skipping, not finishing" however far you scrolled, and the
  chapter is never marked read.

  Reported as chapters not counting when reading several in a row, which is
  exactly when it shows: it is **deterministic per chapter**, so a run loses the
  ones with a short final page and keeps the rest — which is why the read log
  had gaps like 16→19 and 20→22 inside otherwise clean sessions. Measured at
  860px with a 120px last page: fully scrolled, the counter said page 84 of 86.
- **And "the end" is no longer the counter's answer at all**, because that fix
  covered one shape of a wider mistake. The counter names the page crossing a
  line 8px from the *top* of the screen, so the last page counted only once
  the page before it had scrolled entirely off the top — and on a phone you
  read the last page while the end of the one above is still showing, then
  tap Next. Roughly one chapter in three was lost that way in a run, and the
  server's request log showed it plainly: chapter 3's pages asked for at 5:07,
  after five minutes in chapter 2, with no "chapter 2 read" anywhere before
  them.

  `reachedTheEnd` in `chapter-nav.ts` asks the *bottom* of the screen instead,
  which is where your eyes are by the end: finished once the last page is a
  fifth of the way up the screen, or once what is left below is under a tenth
  of the chapter **and** under two and a half screens — the second for
  chapters whose last page or two are credits nobody scrolls through. Both
  halves of that are needed: a tenth alone called a chapter cut into 127 short
  strips finished eleven screens early, which measuring at phone size caught.
  Asked only once every page has loaded, since a strip of placeholders is
  short and wholly on screen the moment a chapter opens; latched per chapter,
  so scrolling back up to look again does not un-finish it.

  Measured at 390×800 on a real 131-page chapter: the arrow switched to
  finishing with 1,800px left and not at 2,100, at a counter reading 127 of
  131 — which the old rule called a skip.
- **Jumping to a page is returning to one.** Pages above a target load now
  rather than lazily and the scroll is re-applied as each lands, the same
  machinery `resume` uses. Verified: a thumbnail put page 5's top on the read
  line at 7.7px, and Next put page 6's at 8.2px.
- **Thumbnails are drawn small, not shown small.** A tiny `<img>` of the page
  decodes the whole page, and these strips run to 800×15000, about 48MB each.
  Each page is decoded once into a 60×84 JPEG, one at a time, nearest the
  current page first, and only while the controls are showing.
- **The thumbnail strip listens for the wheel, not for scroll.** The code that
  keeps the current page centred scrolls it too, and a scroll handler took that
  for a touch and held the controls up for as long as you read.

#### Leaving from the end is finishing, and Next asks at the moment it is pressed

Two more doors the same lost chapter came through, found when chapter 1 of a
not-followed series went unrecorded with every later one counted. The server's
log was decisive about *what* happened — no read was ever written on the
device — and silent about which of two ways it happened, and neither could be
reproduced. So both are closed rather than one guessed at:

- **Next and the skip ask `finishedNow()` when pressed**, rather than reading
  the latched state. That state comes from a measurement throttled to 300ms and
  paused while a jump settles, so a press inside either gap read an answer that
  was out of date.
- **Leaving a chapter from its end records it** through `onLeftAtEnd` — Back,
  the swipe, or closing to tap the next chapter in the list. Next was the only
  way a chapter counted, which made reading to the end and choosing the next
  one by hand a way to lose it. Measured before the reader closes, while the
  strip is still there to measure.

**The order inside `leave` matters, and the first version had it backwards.**
Closing saves the place you left; recording the read clears it. Recorded first,
the close then put the place back, and the page offered to *continue* the
chapter just finished — caught by driving it in the browser with the outgoing
requests intercepted, so nothing reached the real library. The server holds the
same line from its side: `PUT /position` refuses a place older than a read of
that chapter or a later one, because the two are sent in the same instant and
can arrive in either order.

**And moving on from a place at the end is finishing too.** A place left on
the last page of a chapter, or the one before it (`placeIsAtEnd`), counts as
read once you move past it: when opening a later chapter replaces that place
(`PUT /position`), or finishing a later one clears it (`settleAfterRead`). It's
recorded at the time the place was saved. Before this, both routes simply
dropped the place, and with it the only record that the chapter had been
finished. Chapter 38 of Master Swordsman's Stream went that way: read to the
end on 10/4, before leaving counted, and left with Back. On 10/7, opening 39
replaced its place, and 38 showed as unread. It looked like a chapter being
unmarked, but it had never been marked.

**Next asks before it jumps over whole chapters.** It goes by number, so a
source with a hole, or one wrongly numbered chapter, sends it to the next number
there is, however far. One press took a friend's reader from about chapter 9 to
about 126 (his server log: source position 17 straight to 252, with no read in
between), and nothing said so. `nextIsOk` asks with a `confirm()` when the next
number is more than one whole chapter on. A point chapter such as 9 → 9.5 isn't
asked about. Each screen passes `nextNumber` from the same `beside` it uses for
`hasNext`.

**The newest chapter's end button says so**: *Last chapter finished ✓*, tinted
in `--ok` rather than the accent, because there is nothing to go on to. The
offline shelf passes `lastLabel` — its last chapter is the last one *saved*,
and it must not claim to be the end of the series.

#### Saved pages that will not draw are fetched again, and mended

"Tap to try again" asked `manga.reader.page` for the page — which returns the
saved copy first — so a downloaded page that would not draw failed the same way
on every retry, for good, and on the train where nothing else can fetch it.
Reported as a worry rather than a failure, and it was a real one.

- **`{ fresh: true }` skips the saved copy**, and sends `&fresh=1` so the
  server skips its archive and page cache too: either could be the bad copy.
- **What comes back replaces the saved copy** (`replaceSavedPage`, which only
  ever replaces — reading a chapter is not asking to keep it), so a chapter
  mends itself the next time it is read with a connection.
- **Every saved copy is checked on the way in and on the way out**:
  `image-bytes.ts` looks at the two ends of the file — the type from the first
  bytes, and for JPEG, PNG and GIF the end marker, for WebP its declared length.
  A download that arrived cut off or as an error message is a missing page,
  counted and retried, rather than a saved page with a gap in it. The server's
  page cache and archive refuse the same files.

Only the ends, deliberately: a full decode per page is the 48MB the thumbnails
already avoid, to catch what the markers catch. Before trusting it, it was run
over all 445 pages in the PC's cache and three pages from each of nine working
sources — JPEG, WebP and PNG — and accepted every one, while refusing
TopManhua's error messages. A check that refused real pages would have emptied
every chapter, which is why that was measured rather than assumed.

#### A page that fails is asked for again before you are

Most pages that fail are **refused, not slow**. MangaFire's image server now
and then answers with a Cloudflare challenge, Suwayomi has no bypass set up,
and it gives up in under a second: "Cloudflare bypass currently disabled" was
52 of the 74 page failures in one evening's log, and only 3 were timeouts. The
challenge comes and goes, which is why tapping "try again" a few times worked.
So that tapping is now done for you, in two places:

- **The server asks three times** (`page-fetch.ts`), pausing 1.5s then 4s, on
  no answer, a 5xx or a body that isn't a whole picture. A 4xx is not retried.
  Each try now waits 45s rather than 30.
- **The reader gives what still failed a second go** once the rest of the
  chapter is in: 3s later, one page at a time, past any saved copy. Only what
  fails that too gets the button.

The background fill (`fillChapter`) used to stop at its first failure, so one
blip left the rest of the chapter to be fetched while you read. Now it passes
over a page that won't come, and stops only after three failures in a row.

The real cure for a Cloudflare-fronted source is FlareSolverr, which Suwayomi
can use. It isn't set up here: it's another program to install and keep
running.

#### A page being fetched is fetched once, however many ask

`sharedPage` in `page-fetch.ts`. Measured: two people opening the same chapter
at the same moment took 63 seconds each for twenty pages, against 27 for one
alone, because each page went to the site twice and the chapter's background
fill asked a third time. Now a page already being fetched is waited for, not
asked for again: the reader, Browse, the background fill and the archive worker
all go through it. A friend's copy fetches pages through the host
(`/api/manga/host/page`), so the host's sharing covers copies too.

**It shares, it does not cache**: an entry goes when its fetch settles, and
"try again" (`fresh`) asks on its own beside the one that may be stuck.
`manga-check` proves three asks at once make one fetch.

Measured too, and worth knowing: two people on the same source at once each
take about twice as long, since they share the site's speed and the
extension's rate limit; different sources do not slow each other; a chapter
already on the PC is 20 pages in 0.2s.

#### A page that is slow, rather than refused, says so and offers a way round

Reported from a phone: page 11 of a Thunder Scans chapter sat as a bare "11"
for over two minutes. The log showed three requests for it (the first, a fresh
retry, and a reopen), each answered 502 after about 2 minutes 20 seconds: three
tries of 45 seconds. Suwayomi's own log showed the download stalling part-way
through the body, and asking Suwayomi directly failed with "timeout" after 30 to
50 seconds, again after it re-read the page list. **The site was not the
problem**: the same image (`0012_c08906f7.jpg`, the site lists its first image
last) came straight from Thunder Scans in 0.4s over HTTP/1.1 and HTTP/2, with and
without browser headers, from all three of its Cloudflare addresses, and other
uncached pages came through Suwayomi in half a second. The page loaded fine
later the same morning. What inside Suwayomi stalled was not found.

Three changes, for whatever the cause next time:

- **A slow failure is retried once** (`page-fetch.ts`). A failure that took 20s
  or more counts as slow, and two of them end it with a 504 saying it timed out,
  about 90 seconds in. Refusals, which fail in under a second, keep their three
  tries. `manga-check` drives it with a fake clock.
- **The reader says when a page is slow.** Ten seconds without it, the slot
  reads "the site is slow to send it. Still trying…". A page that took 40s or
  more to fail skips the reader's own second go, which would be another 90
  seconds of the same, and gets the button at once.
- **Read this chapter from another source.** Offered in the first slot that is
  slow or failed. `GET /api/manga/:id/elsewhere?number=` searches your sources
  in your languages and lists chapters on up to six results whose title is the
  series' own once `titleKey` has folded it (with its old names), leaving out
  the series' own source. Strict for the import's reason: a loose match opens
  another series' chapter with nothing saying so. Picking one swaps the
  reader's chapter for that copy's id under the same series, which the pages
  route has always accepted, from the top since pages are split differently.
  Reads are kept by number, so finishing it there counts here; a saved place in
  it falls back to your source's chapter from the top. Measured on the chapter
  that started this: Manga Demon and MangaHub both had chapter 64, found in
  12.8 seconds, and Manga Demon's opened with 15 pages to Thunder Scans' 14.
- **Two ways to ask again by hand.** A slow slot has **Try again now**, a
  fresh request alongside the one still waiting, whichever answers first. And
  the gear has **Reload**: the pages not on screen yet, fresh and in reading
  order, or every page when all are here, for one that arrived but draws
  wrong. Pages already showing stay up until their new copy lands.

**And a reload reopens the chapter.** The URL already brings you back to the
Manga screen, but the reader is state inside it, so reloading mid-chapter landed
on the library. That was the obvious thing to try when pages would not draw.
`open-chapter.ts` keeps the open chapter in `sessionStorage`, written by the
chapter list and cleared when the reader or the list closes. It is read once, at
module load, so the list writing "nothing open" on its first render can't clear
it before it's used. The chapter reopens at the saved place, and every page is
asked for again. `sessionStorage` because this is about this tab: a chapter left
open last week should not spring open the next time the app starts. Only chapters
opened from a followed series' list come back this way. Once more than one page
has failed, every failed slot also offers **Try all N again**.

#### Saving to the device: one line, said in full, and reading while it fills

`offline-store.ts` saves one chapter at a time, three pages at a time, as it
always has. What changed is how much of that you can see and steer.

**The queue is `current` plus a line**, not one array whose head happened to be
running. With the head doubling as "the one saving now", reordering the line
meant special-casing index 0 everywhere; now moving something to the front is a
splice of the line, and the chapter saving now always finishes. Stopping it
halfway would throw away what it had fetched.

**`useOffline().jobs` is in the order they will be saved**: saving, then the
line, then failures. So "next" and "3rd in line" are a position, and a screen
does not work them out again. `useDownloadCount` is the same without the
manifest, for the tab bar's badge: it redraws on every page saved, and the
Manga screen around it holds sixty covers with no reason to redraw.

**A chapter that fails still counts in the run.** "Chapter 3 of 10" is
finished plus failed plus what is left, so a failure does not make the total
shrink under you, and the line says how many did not save.

**Opening a chapter reorders what is already queued** (`prioritiseFrom`): Next
10 asked for from chapter 2 and then reading chapter 6 would otherwise spend the
next minutes on 3, 4 and 5. Only what is waiting moves, so this never saves
anything nobody asked for.

**A page is fetched once however many ask** (`fetchPage`). Reading a chapter
while it saves had the reader and the download each fetching every page, the
same picture over the same tunnel twice. It is a coalescer, not a cache: an
entry goes when its request settles. `fresh` (tap to try again) skips it, since
sharing the request that just failed would fail the same way.

**Read while you wait** is a mode of the chapter list, on until the reader
closes. **It is one of three states of the one button at the top of the
list**, not a button of its own: *Continue* (your place, or the next after the
furthest you finished), *Read first chapter* on a series not started, and
*Read while you wait* only while chapters of this series are saving or waiting
and the PC can be reached. It first shipped as a second button on the Save bar,
offered with nothing downloading, beside a Read that opened the same chapter.
All three open that chapter; the third only waits for it. A series read to its
newest chapter has no card, as before. While on, every way into a chapter goes through `openChapter`: it saves
that chapter and the `KEEP_READY` (3) after it, at the front of the line, and if
the chapter is not saved yet it shows `WaitForChapter` instead of the reader.
That screen is drawn into `body` with the reader's own class, so going from the
end of one chapter to it and on to the next never flashes the list in between.
It opens the chapter the moment the manifest has it.

Three is a chapter's saving time against a chapter's reading time, with room for
a slow source or a short chapter read quickly. Every one more is a chapter of
the phone's storage spent on a guess.

**"Next" had to agree with the list first.** `beside` takes the first entry with
the next number, and on a source listing two editions that is not always the
copy `pickOnePerNumber` shows. Saving ahead then saved one copy while the row's
✓ looked at the other: on the first real run the list read "2 saved" with every
row still showing ⬇, and Next 5 saved nothing at all, because the copy it picked
was the one already saved. `shownCopy` maps a number to the row's copy whenever
the list shows one per number, and Next, Previous, skip, the end of a chapter,
Next 5 and All all go through it. With every version showing, there is no one
row to agree with, so `beside`'s answer stands.

**Testing it in the browser pane marks chapters read.** The pane lays out no
pages while it isn't drawing, so the strip measures as already at its end, and
closing the reader counts as finishing the chapter. A write blocked with a fake
`ok` answer is then recorded in the reading log as *sent*, and the log re-sends
the last month on its own later. So block writes before opening the reader,
and remove any row it added to `manga-reading-log` afterwards.

#### What you read is written down on the device first

`reading-log.ts`. A read was one request, sent once: finish a chapter, PUT it,
and if the request never arrived — a tunnel, a sleeping PC, iOS killing the app
the moment it is swiped away — the read was gone with nothing anywhere to say
it happened. The order is reversed now. Every read goes into a log on the
device first, synchronously, and is sent from there: at once when the server
answers, and whenever it next does when not.

**The last month of it is sent again** each time the Manga screen opens, at
most twice an hour. That is what makes it work *regardless* rather than merely
eventually: a read the server had and then lost — the sweep that overwrote the
store, a restore from a backup, anything nobody has found yet — is put back by
the device that did the reading. A re-send that changes nothing writes nothing
and announces nothing, so this costs one small request.

**Repeating everything is only safe because of `read-marks.ts`**, which is the
part worth understanding before touching any of it. Every claim carries when it
happened, and the later one wins: re-sending a read is harmless, an older read
never moves a record backwards, and marking something unread leaves a
tombstone (`unreadAt`) so a phone re-sending last week's read cannot quietly
undo it. A read *newer* than the tombstone is a re-read and counts. Without the
tombstone the re-send would be a machine for resurrecting what you took back.
`PUT /api/manga/:id/read` goes through the same function, so the two routes
cannot disagree about what a read is.

`POST /api/manga/journal` takes a batch. Too old (45 days) is ignored rather
than stamped "now" the way `happenedAt` does for a single queued change: a
re-sent claim wearing its arrival time would beat every genuine claim made
since, which is exactly backwards.

**It is a CSV, because it was asked for as one** and because a record of what
you read should be readable. One row per claim — when, which series, which
chapter, read or unread, whether the PC has it, and the title — stored as that
text in `localStorage`, and handed over as a file by More → Reading log. Not a
real file on disk: a browser will not let a web app write one unprompted, and
this has to be written in the instant a chapter ends. The codec is `log-csv.ts`
with no imports, so `manga-check` round-trips a title with a comma and quotes
in it — the row a hand-rolled CSV gets wrong.

**Incognito is enforced in `logRead` itself**, the one place every reader
writes through. It had been checked by the chapter list and not by a series'
details page or the offline shelf, so two of the four ways into the reader
recorded what that switch said they would not.

The old queue (`sync-queue.ts`) still carries saved *places*, which are
last-writer-wins on their own and have no history worth keeping.

**Three smaller windows closed alongside**, the sweep's lesson applied where it
had not been: linking a source and following from a source each held the store
across a MangaUpdates or MangaDex request and wrote it afterwards, so a chapter
marked read during that round trip was overwritten. Both re-read the store
after the request now.

**`start.ps1` empties `logs/server.log` on every start**, after moving the
last run's to `server.prev.log` (and the agent's to `agent.prev.log`; an
`.err.log` only when it has something in it, so the last crash survives an
empty run). One run back is all that is kept, so still copy it before
restarting twice when investigating anything — the request timeline that proved the
cause above was lost to a restart minutes after it was read, and the missing
chapters had to be refilled from notes taken before it.

#### Getting down a long chapter

- **The scrollbar is back, and is a choice.** It was hidden outright on the
  reasoning that a 15px strip down one side is the last piece of browser left
  showing and the page counter already says where you are. The counter says
  where you are — **it is not something you can grab**, and a long chapter is
  exactly where you want to throw yourself two thirds of the way down. The
  default is now to show it, because a scrollbar is what a page normally has
  and its absence was the surprise; the gear hides it for anybody who wanted
  the clean edge.
- **The page can be dragged to scroll, with a mouse.** `pointerType === 'mouse'`
  only, deliberately: a finger already scrolls by dragging, and claiming that
  gesture would mean fighting the browser for it and losing momentum and
  rubber-banding, which touch does better than this could.
- **Four pixels of slop, and the click that ends a drag is swallowed.** A tap on
  the pages toggles the controls, so without both of those a drag would scroll
  *and* hide the chrome, and a click with a twitch in it would scroll a few
  pixels instead of toggling. The pointer is captured only once a drag is known
  — taken on `pointerdown` it would eat every ordinary click.
- **A drag that starts on the controls does nothing.** That is somebody missing
  a button, and scrolling the page out from under them is the wrong apology.
- **The pages refuse to be dragged out of the window**, and without that the
  feature worked everywhere except on a page. An `<img>` is draggable by
  default — to another tab, to the desktop — and that native drag begins on
  mousedown and takes every event after it. So pressing on the margin beside a
  page scrolled and pressing on the page itself dragged a ghost of it around,
  which is exactly how it was reported.

  `user-select: none` does not cover this: selecting text and dragging an image
  are two mechanisms and each refuses separately. **Both spellings are needed**
  — the `draggable` attribute is what Chrome and Firefox read, `-webkit-user-drag`
  is what WebKit reads, and this reader is used on an iPhone. Not gated on the
  drag-to-scroll setting, since nobody drags a manga page to their desktop on
  purpose mid-chapter and gating it would make one switch change two things.
- **The position is a ref, not state.** A `setState` per `pointermove` would
  re-render a strip of seventy images sixty times a second — the same reason
  `useEdgeDrawer` keeps its drag position in one.
- **Letting go slides, as a phone does** (`glide.ts`). The speed is the drag's
  over its last 80ms, so a drag that slowed before release is thrown at the slow
  speed; held still for 60ms first, it is put down rather than thrown. It slows
  at iOS's own rate (0.998 a millisecond: a 2px/ms flick goes about a thousand
  pixels in two seconds), capped at 6px/ms, and stops at the top or the bottom.
  **Pressing again stops it dead**, anywhere, and that press is not also a tap
  on the page, or catching a slide would flash the controls every time; a wheel
  or a key stops it too. Reduced motion gets no slide.

  The distance is integrated per frame rather than taken as speed × time, so it
  goes as far at twenty frames a second as at sixty. And each frame is asked for
  twice, by `requestAnimationFrame` and by a 34ms timeout, whichever comes first:
  rAF does not fire in a window that is not drawing, which is how this was
  tested, and a slide must not hang half-done there.

  **The slide keeps its own position, to the fraction, and never reads it back.**
  The first version added each frame's distance to `window.scrollY`, and on a
  screen without scaling the browser keeps that in whole pixels, so the fraction
  was thrown away every frame: a slow slide went 1px and 2px by turns, or, where
  the browser truncates, a third short and then stuck. Reported as a hitch at low
  speeds. Only a jump of more than 2px from somewhere else (a page loading above)
  resets it. The slide also ends at 0.05px/ms rather than 0.02, under a pixel a
  frame, because past that a whole-pixel page can only show a pixel, a pause, a
  pixel. `manga-check` simulates both kinds of snapping.

  **Dragging while pages load caught, for three reasons, all fixed together.**
  Pages are `decoding="async"`: a strip is up to 800×15000, 48MB decoded, and
  decoding one on the main thread as it scrolled in held the drag for that long.
  Thumbnails decode straight to their own size (`createImageBitmap` with
  `resizeWidth`, falling back to a whole decode where that is not supported)
  instead of decoding each full page only to shrink it. And the drag scrolls by
  the distance since the last move rather than to a place worked out at the
  press: a page loading above makes the browser scroll down to keep your place,
  and the absolute version put the page back on the next move, a lurch the
  height of a page. Not measured here: the browser pane was hidden, and a hidden
  pane lays out no pages at all, eager or not.

Measured by driving real pointer events in a reader with every write blocked: a
200px pull over 100ms slid 958px more after release, easing out over two seconds;
the same pull downwards slid 977px up; a quarter of the speed slid 236px; held
still before letting go slid 0; a press mid-slide stopped it in place with the
controls left alone; and a plain click with nothing sliding still toggled them.

Measured by driving real pointer events: a 300px drag scrolls exactly 300px and
leaves the controls alone; a plain click still toggles them; a 2px twitch
scrolls nothing and still toggles; a `pointerType: 'touch'` drag is ignored
entirely, so native scrolling keeps it; and a drag begun **on a page** scrolls
its full distance with **no** native image drag started.

The Library needed none of this — it scrolls with the window and has always had
the scrollbar, drawing sixty tiles at a time with a *Show more* button behind
the observer that adds the next sixty.

#### The gear, and what a web app cannot do from it

`ReaderSettings.tsx`, shaped like the panel in the old app: sliders, then Reset
and More, with the two countdowns behind More.

- **Pages fit the screen's width**, with no cap. The 900px column they had was a
  reading measure, and around a webtoon it is the app showing through. The page
  width slider (40–100%) narrows it for a monitor where full width is a metre
  tall, and the place is kept across the change: taken before, put back in a
  layout effect after, so the jump is never painted. Verified: page 4 held at
  the read line from 375px wide to 225px.
- **Brightness dims the pages; it does not touch the screen.** A web app cannot
  set an iPhone's brightness, so the slider is a black veil over the pages and
  under the controls, and says what it is rather than posing as Control
  Centre. The old app's rotation lock is left out for the same reason:
  `screen.orientation.lock` does not exist on iOS.
- **Two countdowns, each with Never**: one for when a chapter opens, one for
  after a tap brings the controls back. They are different moments — arriving,
  when a glance at the number is all you want, and reaching for a control, when
  you may want it to stay — so one number would make one of them wrong. Which
  one is running is a ref (`phase`); touching the controls restarts that one.
  The panel holds everything up while open, and a tap on the page closes it
  rather than hiding everything, which is what a tap outside a popover means.
- **All of it is per device** (`reader-prefs.ts`, `localStorage`), unlike the
  theme. Every value is a fact about the screen in your hand: a width for a
  3440px monitor is a stamp on a phone, and dimming for bed is wrong at a desk.
  Read back defensively, and a stored countdown is only taken if it is one on
  offer, so a stray number cannot leave the controls up for an hour.
- **The counter needed a pixel of tolerance.** A zoom or a jump puts a page's
  top on the read line and scaling lands it a fraction off, so the page above,
  with a sliver still showing, was counted: page 4 at the top and "3 / 10".
- **The gear's teeth need square ends.** Every other icon uses round caps, and
  on a dashed ring those grow each dash by half its width at both ends until the
  gaps close and the cog is a ring.

### Bringing a library in from Manga Reader: retired

The importer for Manga Reader's iMazing backup was removed on 2026-10-23,
having done its one job: Blake's own library, brought in once. Its reader
(`mangareader.ts`, `bplist.ts`), the background search that linked what came
in (`matching.ts`), its card on More, its routes and its tests went with it.

What it brought in stays, because it is the library: every series, the read
marks, the old app's names in `altTitles`, and each series' `origin` (the site
and title it came from). A series still without a source is under the
Library's **No source yet** filter, and a cover there opens the search for one,
which is how any series is linked by hand.

### Installing a package, the way you would a texture pack

`modules/` at the repo root, one folder per package, gitignored. **Settings →
Packages → Installed** lists them, takes a `.zip` dropped on the page, opens the
folder in Explorer, and deletes one from disk.
`npm run modules-check -w @everything/server` proves the zip reader, the
manifest rules and a real install/remove round trip.

**A built-in feature could never work this way, and that is what forced a second
concept.** `FeatureSpec.owns` shows a feature is up to *three* folders across
three workspaces — the vault owns a server folder, a web folder and the whole
extension — so there is no single directory to open, drag into, or delete. A
module is *defined* as exactly one folder. That constraint is the feature; the
rest follows from it.

So the screen has two headings. **Built in** is the seven that ship in the repo:
switchable, deletable by hand, never installed from here. **Installed** is what
you added. Collapsing them would put "Remove" against the vault, which is a lie
about what the button can do.

**The comparison to a texture pack breaks in exactly one place, and it is the
important one.** A resource pack is *data*; a package here may be *code* — one
with a `server` entry is imported into the server process and handed the Fastify
instance, with the database, the filesystem and the network. There is no sandbox
and none is pretended. The warning sits **above the drop zone**, not in the
README, because the person about to drag a file in is the person who needs it.
It is nearer to installing a mod than a texture pack, and it says so.

That is also why a package arrives **switched off**. A built-in's default is a
decision this repo made about code it ships; a module is code from somewhere
else, and running it should be a thing you chose rather than a consequence of
dropping a file in a folder.

#### The zip reader is hand-rolled, and reads the central directory

`zip.ts` — no dependency, the same call the PNG encoder and the WAV writer make:
the format we need is two structs and one `zlib.inflateRawSync`. A zip library
would be third-party code sitting directly in the path of untrusted input.

It reads the **central directory**, never the local headers. Both describe every
entry and the local one is tempting because it sits against the bytes — but with
the streaming bit set (anything that zipped to a pipe) its sizes and CRC are
zero and the real values trail the data. The central directory is always
complete.

Guards, all of which `modules-check` fires at it:

- **Zip slip.** An entry named `../x`, or the backslash spelling — treated as a
  separator *because this is Windows*, where a name containing one is a single
  segment to the spec and two to the filesystem, and the filesystem creates the
  file. Checked in the reader **and** again as each file is written: the first is
  about the archive, the second about the disk, and they are the same check only
  while both are right.
- **Declared size before inflating**, so a decompression bomb is refused rather
  than expanded and then measured.
- **The CRC**, which is in the archive already — so a half-downloaded zip is a
  clear message instead of a package that installs and then will not parse.
- ZIP64 and encryption are refused **by name**, since half-extracting one leaves
  a broken package behind.

**A wrapping folder is stripped when every entry shares it.** Archives are made
both ways depending on whether the author zipped the folder or its contents, and
requiring one spelling would reject half of all correct packages for a reason
invisible from outside.

#### Two Windows details that cost a debugging session each

- **A BOM is stripped before every hand-edited JSON parse.** `Out-File -Encoding
  utf8` in Windows PowerShell writes one, Notepad wrote one for years, and
  `JSON.parse` refuses it — the error prints as `Unexpected token '﻿'`, an
  invisible character. Found building a test package with `Out-File`. `json.ts`
  now serves `module.json`, `modules.json` **and `features.json`**, which is the
  one that mattered most: it is documented as hand-editable and a BOM in it
  stopped the server booting.
- **A `.js` file under `modules/` is CommonJS.** Node resolves module-ness from
  the nearest `package.json` going *up*, and the nearest above `modules/` is the
  repo root, which has no `type`. So a package written the obvious way died on
  its own first `export`, with `Cannot require() ES Module … in a cycle` —
  naming neither the package nor the problem. `installFromZip` writes
  `{"type":"module"}` when the package ships no `package.json` of its own, and
  never overwrites one that does, since an author who included it has said what
  they meant.

#### Everything deletable is a package now

`vault`, `voice`, `integrations` and `push` all live in `packages/modules/<id>/`
with a `server/`, `web/` and `agent/` half as they need one. `FEATURE_IDS` is
down to `habits`, `notes` and `time` — the three that are woven into the
Dashboard and have no folder to delete. All four packages appear on the Packages
tab with a size, a version and a **Remove** button.

**Shipped packages are deletable, and that reversed an earlier decision.** The
first version refused on the grounds that the folder is part of your checkout.
But "deleted: the folder is gone, and the app boots and says not installed" has
been one of this project's three levels from the start, and `features-check`
proves each survives it. Refusing would have made this screen the one place that
could not do what the rest of the app promises. The row says which cost applies.

**A shipped package keeps its compiled UI.** Vite globs
`packages/modules/*/web/` from outside its own root — it will, which is the fact
that made this affordable — so the vault and Connections screens bundle exactly
as before. Only *downloaded* packages are fetched and imported at runtime. Two
kinds of browser half for two genuinely different situations: one is compiled
with the app, the other arrived afterwards.

**`session.features` carries running package ids alongside real features.** Every
reader — the drawer, the panel picker, `featureEnabled('voice')` three components
deep inside the habit editor — is asking the same question either way, and
teaching each of them about a second list would have been a wide change to
answer a question they already ask correctly.

`@app/…` is a Vite alias for `packages/web/src`, so a module's web half does not
count `../` out to the app. The agent's halves use plain relative paths instead:
that resolution happens at runtime through tsx, where a path alias is one more
thing that can silently fail and stop the agent booting.

#### Five things this migration got wrong

Worth keeping, because three of them are failures this document already warned
about happening in some *other* place.

- **`modules/` in `.gitignore` matched `packages/modules/` too.** A pattern with
  no leading slash matches at any depth, so the instant the three features moved,
  git stopped seeing them — on a public repo. `/modules/` now. An ignore rule
  that matches too much fails exactly like one that matches too little.
- **The smoke suite deleted the vault.** It sent `DELETE /api/modules/vault`
  expecting a refusal, which was true while `vault` was a reserved *feature* id
  and false the moment it became a package. It now names only ids that can never
  be real, and asserts at the end that it removed no shipped package — because
  the failure presented as a wall of module-not-found errors in *other* suites,
  with nothing pointing at the check that caused it.
- **The repo root was counted by hand a third time.** `routes/restart.ts` looked
  for `packages/scripts/restart.ps1` and disabled the very button that is meant
  to always work. `paths.ts` owns every path now, including the module roots,
  which are overridable so a destructive suite can point at a temp directory.
- **The voice models' ignore rule named the old folder.** Exactly the failure the
  comment above it described.
- **A bulk import rewrite was too greedy.** It turned every `../x.js` in the
  agent halves into a path out to the agent package, including the ones that were
  always siblings inside the module — so `mic.js` and `vosk.js`, which live in
  the voice module itself, pointed at files that do not exist. Invisible to
  `npm run typecheck`, because the tsconfigs did not include the module folders.
  They do now, in all three workspaces; that is what makes the move safe to
  repeat.

#### Restarting from inside the app

A **Restart** button in the banner that appears whenever a package is added,
removed or switched. It exists because deleting something used to end with "now
go and find the tray icon".

It is built to survive the case it is for — a package having broken something —
so it is registered in core **before any package loads**, reads no database, no
settings and no manifest, and answers *before* restarting rather than trying to
report on a process that is being killed. It asks the server whether it can
restart before offering, so the button is disabled with a reason rather than
failing when pressed.

`start.ps1` watches `packages/modules` as well as `packages/web/src`, or a
deleted package's tab would stay on screen until something unrelated changed —
and it records the module **count** beside the build, because a deleted folder
leaves nothing behind that could be "newer" than anything.

**Its first version shipped with `stdio: 'ignore'` and no logging**, so when the
first restart failed the app was left stopped with not one line written anywhere.
Output now goes to `logs
estart.log` through PowerShell's own `*>>` — not a
`>>` on the cmd line, because `start /b` hands the child cmd's handles and cmd's
were `ignore`. That is written down two sections above, about the tray, and was
reproduced here anyway.

#### Two roots: shipped, and installed

`modules/` is gitignored on purpose — it holds code downloaded from elsewhere,
which is not ours to commit. So moving a first-party feature into it would
**delete that feature from the repository**, silently, on a repo that is public.

Shipped packages therefore live in `packages/modules/`, which is committed and
typechecked with everything else, and both roots are scanned by the same loader.
The difference a person sees is one line: a shipped package says **built in** and
has no Remove button, because removing it would mean deleting part of your
checkout rather than a folder you added — a `git checkout` away from coming back.

**Shipped is scanned first, and that ordering is a guard.** Without it, dropping
a folder named `push` into `modules/` would replace the real one with somebody
else's code. It is the same protection `RESERVED_MODULE_IDS` gives feature names,
one level down.

**A shipped package defaults on; an installed one defaults off.** Shipping
something is this repo deciding it should run; dropping a zip in a folder is not
yet a decision to run it.

**Except one that says `startsOff`**, which is the vault (2026-10-23). A
password manager nobody set up is a tab asking for a master password, and on
a friend's first visit that read as the app being confusing. It is still
shipped and one switch away on Packages; only the default moved, so an install
that had it on in `modules.json` keeps it on.

#### `@everything/server/module-api`

A package in its own folder cannot write `import { db } from '../../db/client.js'`
— that path is a fact about where the *server's* source sits. So there is a
stable surface it imports instead, resolved from `node_modules` whether the
package shipped or was unzipped.

The surface is **the ten things the four removable features actually use**,
arrived at by counting rather than guessing: `db`, `schema`, `config`, `changes`,
`getSettings`, `providePush`, `recordHabitDone`, `undoHabitDone`. That is a real
commitment — the difference between an internal that can be renamed and one that
cannot — and it is not a sandbox: a package could reach past it with a relative
path or `node:fs` whenever it liked. It exists so honest code has something
stable to build against.

The browser side already had its equivalent in `register(host)`, and the two
surfaces were measured the same way: the web features import exactly five things
from core (`api`, `controls`, `format`, `nav`, `useAsync`).

#### `push` has moved, and what it cost

The first feature to become a package, chosen because it is 175 lines with no UI
and no agent half. It is `packages/modules/push/`, out of the feature manifest
entirely, and `POST /api/devices/me/push` now asks `moduleIsRunning` rather than
`isEnabled`.

Three things went wrong doing it, all of which the next migration will hit:

- **`RESERVED_MODULE_IDS` was a hand-written copy of the feature list**, so the
  moment `push` left that list the reserved copy still held it — and the loader
  rejected the package's own folder name as invalid. The symptom was a row
  labelled `push` with no manifest and nothing running. It is derived from
  `FEATURE_IDS` now, so the next feature to move takes itself off the list.
- **A folder outside a `"type": "module"` scope is CommonJS to TypeScript too**,
  not just to Node: it resolved drizzle's CJS types and produced a wall of
  "separate declarations of a private property". The same `package.json` the
  installer writes for a downloaded package, committed for a shipped one.
- **A switch has to survive the move.** A shipped package defaults *on*, so a
  `push: false` in `features.json` would have turned phone notifications back on
  for somebody who had deliberately silenced them. `carryOverFromFeatures` reads
  the old key once at boot and writes it into `modules.json` — verified in both
  directions. `MOVED_TO_PACKAGES` also stops `npm run features` calling the
  leftover key a typo when it is a setting being honoured elsewhere.

**The other three are not moved, and the reason is the browser half.** `vault`,
`voice` and `integrations` are ~16,000 lines, and their web halves are compiled
into the PWA bundle by Vite today. A package's browser half must be **one
self-contained file**, so each would need its own build step — and every core
helper it uses either gets inlined into that bundle (the 9.5KB duplication
problem, once per package) or added to `PackageHost`, which turns five internal
modules into a public API. `voice` additionally needs an agent-side loader that
does not exist. Those are decisions to take deliberately, not consequences to
discover.

#### A package can draw, not just serve

`import.meta.glob` resolves at **build time** — that is what makes deleting a
feature folder a supported operation, and it is exactly why it can never see a
package installed afterwards. So a package's browser half is loaded the only way
a browser can load code it did not know about: **fetched with the token, then
imported as a blob URL.**

`<script src>` and a bare `import('/api/…')` send no Authorization header — the
constraint that put the icons and the tones *outside* `/api/`. That escape is not
available here: those are a colour and a sine wave, this is code from a package
you installed, on a server that binds `0.0.0.0`. So it is fetched like any other
API call and turned into a blob, the same move the habit pictures make with their
bytes.

**The cost is that a blob has no base URL**, so a relative `import './x.js'`
inside a package cannot resolve. A browser half must be **one self-contained
file** — which is also why React is *handed to it* rather than imported.

**One React, passed in.** A package importing its own would ship a second copy
and, far worse, hooks from one React inside a tree rendered by another throw in
ways that read as the package being broken. `register(host)` receives the app's
React, its API client, `useAsync` and `goTo`, so a package bundles nothing at
all. Verified: a package's button held state across clicks and left no React
global behind.

**The manifest declares, the code draws.** `tab` and `panels` are static in
`module.json` so the drawer and the panel picker can be built without loading
every package's code — the same split `meta.ts` and the lazy `panel.tsx` already
make for features. A `tab` or `panels` without a `web` entry is **refused rather
than ignored**, because the alternative is a drawer entry that opens an empty
screen with nothing anywhere saying why.

**Panel ids are prefixed by the server, not by the author.** A package declares
`now` and the app stores `weather:now`, so two packages cannot collide however
carelessly they are named and nobody can get the convention wrong. An author who
prefixes it themselves is refused.

**Tab ids are namespaced as `package:<id>`** in the drawer, so a package cannot
take over a core screen by calling itself `settings`.

**A glyph is one grapheme, not one code point.** `[...glyph][0]` was the first
version and silently truncated 👨‍💻 to 👨 — three code points joined by a
zero-width joiner. `Intl.Segmenter`, guarded, since this file is also read while
deciding how much of the app exists.

**A broken package must not take the app down, and this is the case that
matters most:** if it did, a bad package would be one you could not reach the
screen to uninstall. `lazy` rejects into the nearest error boundary and this app
has none, so a load failure is turned into a component that renders it — naming
the package, quoting the error, and pointing at Settings → Packages. Verified by
installing a package whose entry throws on purpose: the drawer stayed intact and
the banner appeared where the screen would be.

**Only *running* packages reach `/api/session`.** The browser half alone would
need no restart — it is fetched at runtime — but a tab that appeared instantly
while its endpoints waited for a restart is worse than one rule applied evenly.

#### Loading is deliberately unlike `registerFeature`

The import is a genuine dynamic `import()` of a file URL rather than a static
`() => import(...)`, which works only because the server runs through `tsx`
rather than a bundle.

And a failure is **caught rather than rethrown**, which is the opposite call.
`registerFeature` rethrows anything that is not a missing module, because a
broken feature is a bug in this repo and should stop the app. A broken *module*
is somebody else's bug, and taking the app down over it would mean a bad package
could stop you reaching the screen that uninstalls it. The reason is kept and
shown on that package's row.

Packages load **after every built-in route**, so one registering a conflicting
path loses to the app rather than shadowing it.

#### What the screen refuses to hide

A folder whose manifest will not parse is **listed, with its problems named by
field**. Dropping a bad zip and seeing nothing happen is indistinguishable from
the drag not having worked, which is the most confusing outcome available here.
Its toggle is disabled and the API refuses to enable it — a switch reading "on"
against something that cannot load is the same lie the `EVERYTHING_FEATURES`
lock is disabled to avoid.

#### Everything that changes anything is local-only

Installing runs someone else's code on this machine and removing deletes a
folder from it, so both sit with minting a device token and writing
`features.json`. **Proved over a real socket**, not with `app.inject()`: the
smoke suite sets `AUTH_REQUIRED=false`, which short-circuits `isLocal` to true
before `isTrustedLocal` is consulted, so an injected cross-site request is
allowed there — which looks exactly like a broken gate and is a disabled one.
Smoke says so rather than asserting either way.

The gate was instead driven with **hand-written HTTP over `node:net`**, because
`Host` is a forbidden header name for `fetch`, which drops it silently — a probe
built on fetch reports the most important vector here as passing when it was
never sent. All five module routes refuse a tailnet `Host`, a cross-site
`Sec-Fetch-Site`, an `X-Forwarded-For` and a foreign `Origin`, and `localhost`
by name is still allowed.

**Opening the folder is the server's job, not the agent's**, which is the one
place this departs from the division voice draws. A hotkey or a browser acts on
whatever machine you are sitting at; this opens a folder on the *server's own*
filesystem, so routing it through the agent would open the wrong machine's
folder the day the server moves.

**The upload has its own `bodyLimit`.** Fastify defaults to 1MB globally, and
raising *that* to accept a package would widen how much memory any request can
ask the process to buffer, for one endpoint that is already local-only.

### Finishing something takes a moment to move

`useSettling.ts` pins a just-ticked row in place for 1.8s before it drops to the
*Finished today* section. Having it vanish under your finger loses the
confirmation you hit the right one and makes the list jump. The delay is purely
visual — the server is updated immediately.

Finished work stays on screen, dimmed and below a divider, rather than being
hidden behind a toggle.

### The queue never lies about being empty

A task due later today has no nudge yet — the sweep only queues within an hour
of the due time. Showing "Nothing queued" while a task is due in two hours is
false, so the Dashboard also lists what *will* queue, marked `later` with the
time it'll fire.

### Right-click to get to the thing that edits it

A task or habit on the Dashboard opens its own editor from a context menu, on
the screen that owns it. One item today — the menu is a list because it is going
to grow, and one item is the honest amount to ship.

**It replaces the browser's menu, so it makes two concessions.** A non-empty text
selection passes straight through, so copying a task title never stops working —
that is the one thing the native menu is genuinely used for here. And only rows
that offer something intercept the event; the rest of the page behaves exactly as
it did.

**There is no long-press.** Touch has no right-click, so this is a desktop
affordance and is stated as one rather than half-built. Nothing lives *only*
here: the phone reaches the same editors through the tab and the `edit` button.

**Navigation goes through a port, not a prop.** `nav.ts` holds one listener that
`App` registers, because the thing asking is a row three components below the
only component that knows what a view is, and none of the components in between
have any business carrying a navigate function. It is deliberately not a router:
the whole navigation model here is one `useState` holding a string, and adding a
router to satisfy one menu item would be a dependency and a concept for something
a callback already does.

A request carries `focus` — **opaque, read differently by each screen**: a row id
on Tasks and Habits, a section id on Settings — and `search`, which is separate
rather than encoded into it because "open this one thing" and "show me everything
matching" are different requests and a screen may want both.

### Tapping the number on the Habits screen edits it

That screen describes its stepper as a way to *correct* the tally, and
correcting "nine, not two" by pressing + seven times is not correcting. So the
value between − and + is a button, and pressing it turns it into a box.
`PUT /api/habits/:id/value` puts the tally at a number rather than nudging it.

**A button, not a `<span onClick>`.** That is the whole reason it works without a
mouse: a span is not focusable, receives no Enter or Space, and is announced as
plain text with nothing to suggest it does anything. One element, and it buys the
non-mouse half of "click or tap".

**The two modes mean different things by "the value".** For a gauge it is the
level, written straight to `gauge_level` and its anchor — and **no entry is
recorded**, because pressing + means "I did one" and typing 80 means "it is
actually 80% now". Filing a correction as a completion would put a tick in the
history for something you never did. For `target` and `interval` the value is a
count of entries, so entries move: newest removed until the sum fits, remainder
re-inserted. Newest-first is what keeps `interval` honest, since its next-due
time comes from the last entry.

That remainder is not a nicety — an entry may carry a count above one, since "I
drank three waters" is a single row. `smoke` builds exactly that shape (one entry
of five, then two of one) and drops it to two.

**Enter commits directly, and the blur that follows is the fallback.** The first
version only blurred and let the blur handler commit, which makes the primary
path depend on a focus event — the one class of event that does not always
arrive. Measured: a document that is not focused dispatches **no `blur` and no
`focusout` at all**, even from a direct `.blur()` on a focused input. Phone
keyboards also vary in what their Go key does. A `pending` ref makes the second
call a no-op, and the route is a `PUT` so a double-send would be harmless anyway.

Worth adding to the list: **focus events join `ResizeObserver` and
`requestAnimationFrame` as things that do not happen in a pane nobody is looking
at.** All three have now cost a debugging session here.

**And so do CSS transitions**, which is the newest member and the most
misleading, because it does not look like a missing callback — it looks like a
broken feature. Opening the drawer in a non-compositing pane left
`getComputedStyle(...).transform` and `getBoundingClientRect()` reporting the
*start* of the 0.22s slide indefinitely, so the drawer measured as off-canvas
while its inline style said `translateX(0px)` and the backdrop sat at full
opacity. Every piece of React state was correct and every measurement said the
feature was broken.

The tell is that the inline style and the computed style disagree. Setting
`transition: none` and forcing a reflow snaps the value to its target, which is
how to tell "the transition has not run" from "the value is wrong" — and worth
doing before believing any geometry taken from a transitioning element here.

**A failed save says so, and that was reported as the feature not working.**
`commit()` first shipped with a `try/finally` and no `catch`. The route was new,
the running server had not been restarted, every save answered 404, and the
number simply snapped back — indistinguishable from Enter not registering. The
message names the number you typed (`Could not set to 17 — …`) rather than
reopening the editor, which would steal focus back from wherever the tap went.
It renders on the row rather than in the stepper, which is 120px wide.

**And the control has to be declared at the top level.** It was first written
inside `ManagedHabit`, which is legal JavaScript and quietly wrong in React: a
component defined during render is a *new type* every render, so the parent
re-rendering unmounts the input and takes what you were typing with it. It
survived testing only because the parent does not re-render on a keystroke —
the draft lives inside the control — which is precisely the kind of luck that
stops holding the moment anything else on the row becomes stateful.

Three smaller things:

- **An emptied box does not commit as zero.** Tapping the number, changing your
  mind and tapping away is exactly how somebody backs out, and wiping the tally
  for it would be the worst available reading of an empty field.
- **`inputMode="numeric"`, not `type="number"`.** The phone keypad is the point;
  a number input adds spinner arrows beside the two stepper buttons that already
  do that job, and eats a scroll wheel passing over it on desktop.
- **The button and the box are one fixed width.** `min-width: 22px` fitted a
  single digit and nothing else: a gauge reading 100% shoved both buttons
  sideways, and the box was ten pixels wider than the button it replaced, so the
  stepper jumped the instant you typed. Measured at 117 → 108 before, 120 → 120
  after.

### Getting to a particular setting

`settings.dashboard_panel` is chosen on a Settings tab, which the friends panel
links straight to. Tabs made Settings navigable and made linking *into* it
impossible without help: the section you are pointed at may be behind a tab you
are not on, and landing on General while the answer is under Packages is worse
than not linking at all. `SECTION_TAB` maps a section id to the tab that holds
it, and a moment of highlight says "we brought you here" — otherwise arriving is
indistinguishable from the tab you opened happening to look like that.

**Three goes at the scroll, and the first two silently did nothing.** All three
switched the tab correctly, because that part is synchronous — the half that
worked hiding the half that did not, every time:

1. One `requestAnimationFrame`. The section is behind its tab *and* behind a
   `useAsync`, so at the next frame it is usually not in the document.
2. Retrying across frames — and cancelling on cleanup, while announcing
   "handled" up front. Clearing the request changes `focus`, which re-runs the
   effect, whose cleanup cancelled the loop it had just started. `onFocused` is
   now called at the *end*.
3. Still on `requestAnimationFrame`, which **does not fire at all when the page
   is not compositing** — a hidden tab, a window nobody is showing. `setTimeout`
   runs regardless, throttled at worst, for identical complexity.

Worth knowing beyond this one button: a probe built on `requestAnimationFrame`
measures nothing in a browser pane that is not on screen, so it will happily
report a working feature as broken and a broken one as working.

Three things there are worth knowing:

- **The hooks sit above `App`'s early returns**, and that is not style. React
  counts hooks per render, so a `useEffect` written after `if (checking) return
  …` is called on some renders and not others — it took the whole app down with
  error #310 on the pairing screen, which is exactly the render where those
  returns fire. The values the listener needs are fed to a ref further down,
  where they exist.
- **The focus request survives a render or two.** `App` holds the id and the
  target screen clears it once honoured, because that screen mounts and fetches
  at the same moment — firing once on mount would find an empty list and open
  nothing. Clearing it on use is what stops closing the editor reopening it.
- **The menu is measured, then clamped.** Its width depends on its longest label,
  which will change as items are added, so a hard-coded estimate is a thing that
  silently stops being true. `useLayoutEffect`, so the correction lands before
  paint rather than as a visible jump.

### Navigation

One left drawer, two behaviours, decided by a width you choose:

- **Docked** — always visible, content offset by its width.
- **Overlaid** — slides over the content. Opens by dragging from the left edge
  or with the ☰; closes by dragging back, tapping the backdrop, picking an item,
  or Escape.

**It can be put away at every width, which it could not.** The toggle used to
appear only below the breakpoint, so on a wide screen the menu was permanent
furniture: 260px of navigation you could not reclaim while reading something
that wanted the room.

#### The ☰ is fixed to the top-left of the screen and never moves

That is the whole feature, and it took three goes to get right — worth writing
down because the first two were both reasonable and both wrong.

1. **In the page header.** It moved with the content: docked, the header starts
   260px in and its column is centred in what is left, so toggling the menu slid
   the button up to 260px sideways. A control that is somewhere else every time
   you look for it is one you stop trusting.
2. **Inside the drawer**, with a handle on the screen edge once it collapsed.
   Worse: the control went away with the thing it opens, and the handle that
   replaced it was somewhere else again — vertically centred, which is not where
   anyone looks for a menu.
3. **`position: fixed`, top-left, above the drawer's z-index, rendered once
   outside both.** Verified at (10, 10) through docked → collapsed → docked, and
   again on a phone through closed → open → closed.

It is the behaviour every browser and YouTube have, and the reason is that a
menu button is hit without looking. A fixed hit target costs a little layout
work; a moving one costs a search every single time.

**It has a background of its own** (`--surface`, with a border). It had none,
so once a page scrolled under it the three lines sat on a chapter's number or a
cover and read as part of it.

**And a Back can sit beside it** (`FloatingBack.tsx`): a screen with a ‹ Back at
its top passes that button's ref, and once it has scrolled above the ☰'s line a
second Back appears next to the ☰, in the same pill on the same line, and goes
when the real one is back. A chapter list four hundred chapters long was a
scroll to the top to leave. Measured on scroll and resize rather than by an
`IntersectionObserver`, and drawn into `#root` rather than `body`, so the
reader, which hides `#root`, hides it too. Used by the chapter list, a series'
page, other sources, extensions and the offline shelf. A pane that is not
drawing delivers no scroll events, so testing it there needs one dispatched.

**Two things have to clear it**, and three custom properties are what keep them
honest: `--menu-clear`, `--menu-top` and `--menu-size`.

**The wordmark sits on the button's line**, and the alignment is derived rather
than eyeballed. The drawer's head takes the button's own top offset as padding
and reserves exactly the button's height, so `align-items: center` lands the
logo's centre on the button's centre whatever those two numbers become. A
hand-tuned `padding-top` would be right once and quietly wrong the first time
the button changed size. Measured: button, logo and wordmark all centre on
**y=26**.

**The title steps aside whenever the menu is not docked, and that is the second
time this rule has been written.** The first version did exactly this and was
replaced by a rule per column width: while the page was a centred 720px column,
a wide screen put the button hundreds of pixels from the title, and the indent
only pushed the heading out of line with the cards beneath it.

Uncapping the page ended that. Every screen now starts at the left edge of the
window, as Notes always did, so no width is wide enough to centre clear of the
button — and the per-width media queries went on answering the old question.
They took the indent away above 820px, which left the title sitting *under* the
button on every screen except the Dashboard-with-panel and Notes they named.
Found on the manga screen, where "Manga" was drawn through by the ☰.

A rule keyed to a layout fact is a claim about that fact, and it goes on
compiling after the fact changes. The cap was removed in one place and the
consequence surfaced in another.

Measured after the fix, title / end of the button / first card:

| width | menu | screens | title |
| --- | --- | --- | --- |
| 1440 | docked | Dashboard, Tasks, Manga, Settings | 272, aligned with the cards at 272 |
| 1440 | collapsed | the same, and Notes | 52, clear of the button at 46 |
| 1024 | overlaid | Dashboard, Tasks, Notes, Manga, Settings | 52 |
| 375 | overlaid | Dashboard, Tasks, Notes, Manga | 52, no sideways scroll |

The collapsed row needed the drawer's transition snapped first: in a pane that
is not compositing, its computed transform stayed at the *start* of the slide,
so `elementFromPoint` on the title hit the drawer and reported it covered.

The button sits **above** the drawer rather than below it, so an open drawer
does not cover the control that closes it. Asserted with `elementFromPoint`
rather than by reading the z-indexes, since that is the thing that actually
decides which one you hit.

**The breakpoint is `settings.drawer_breakpoint`, and the default moved from 900
to 1200.** 900 answered "is there room for a drawer beside a *task list*" — one
column of short lines — and a screen with columns of its own is squeezed a long
way above that: at 900 with the drawer showing, the content is left about 640px.
Offered as four named widths rather than a slider or a box, the same call the
refresh rate makes: these are a handful of real answers and "1200" is not a
decision anybody can make while "from a large laptop up" is. The top of the
range means *never dock*, which is a legitimate choice rather than a broken one.

**`settings.drawer_docked` is the default, not a live record of the toggle.**
Collapsing the menu to read something is a thing you do for a minute, and
persisting it would turn a temporary choice permanent by accident. The setting
says how the app opens; the button says what you have done since.

That distinction needed a guard. The shell reloads its settings on **every**
change announced over the SSE stream — a habit ticked off on the phone comes
down the same pipe — so an effect that simply applied `docked` would have
snapped the menu back open under your hands on any unrelated save. A ref holds
the last value actually applied, so only a change to *this* preference re-applies
it. Verified: collapsed by hand, then an unrelated setting written, and it stayed
collapsed.

`drawerDocked` is a **`number` in `api.ts`**, like every other boolean on that
type, because the row returns 0 or 1 — `voiceRetryMatchesFollowUp` is the
cautionary tale and it is quoted at the top of that file.

`useEdgeDrawer.ts` makes the drawer follow the finger rather than snapping at a
threshold, because a menu that moves with you reads as a drawer and one that
jumps reads as a bug. Two things there are load-bearing:

- **Axis locking.** Nothing is `preventDefault`ed until the drag is known to be
  horizontal. A vertical drag that happens to start near the left edge is
  someone scrolling the list, and stealing it would make the app feel broken.
- **The drag position lives in a ref, not in state.** Deciding open-or-closed
  from rendered state is a bug: React batches updates, so when the last
  `touchmove` and the `touchend` fall in the same frame the rendered value is
  stale and the gesture is silently dropped.

**The PWA does not import `@everything/shared`.** Its entry point pulls in zod,
which is 14KB gzipped in a bundle whose whole point is being almost entirely
framework — measured, when one helper was imported for a warning string. That is
why `api.ts` redeclares its row types by hand, and why the odd piece of display
copy is duplicated rather than shared. Anything with consequences stays in
`shared`, where it is under test, and the server enforces it.

Served by Fastify from the same origin as the API, so there's no CORS, no
configured API host, and one URL for both the app and its data. Auth is the same
bearer token the agent uses, held in `localStorage`; any 401 drops the whole app
back to the pairing screen.

Only `/api/*` requires a token — the shell has to load before there's anywhere
to type one, and it carries no data of its own.

### iOS needs HTTPS — plain Tailscale HTTP will not do

Service workers and web push require a *secure context*. `localhost` is exempt,
which is why it works on the PC, but `http://100.x.y.z:8787` over Tailscale is
not — on the phone the app would load and then silently fail to install or
receive push.

The fix is free and built into Tailscale:

```bash
tailscale serve --bg 8787
```

That publishes it at `https://<machine>.<tailnet>.ts.net` with a real
Let's Encrypt certificate, which iOS accepts. Use that URL on the phone, not the
raw tailnet IP. (`tailscale serve` keeps it inside the tailnet; `funnel` would
expose it to the public internet, which this app should never use.)

This machine's actual name is deliberately not written down here — the repo is
public, and **Settings → Add a device** reads it live from `tailscale status`
and shows the URL to use. A hostname in a document is one more thing to keep
true. Note that the Windows installer does **not** put `tailscale.exe` on PATH,
so anything shelling out to it must try `%ProgramFiles%\Tailscale\tailscale.exe`
too — looking it up by name alone reports "not installed" on a machine where it
is running fine.

### Theme and accent

Two independent axes, both stored server-side so the phone and the PC agree:
`theme` is `dark` (default) / `light` / `system`, and `accentColor` is one of
eight names. Blue on dark is what a fresh install gets.

Server-side rather than in `localStorage` because picking a colour on the phone
and finding the PC still amber reads as the change not having saved. The browser
still keeps a copy, but only as a *cache* — written from server responses,
never from a click.

Applied as attributes on `<html>`:

```
<html data-theme="dark" data-accent="blue">
```

Kept as two attributes rather than one combined class because they are chosen
separately, and folding them together would mean eight accents × two themes =
sixteen blocks to keep in step. Each accent instead declares two lines per
theme, and nothing else has to know it exists.

**Each accent is defined twice, once per theme, and that is not duplication to
factor out.** The dark values are light enough to read against `#14161c`; the
light ones are darkened until they carry white text. No single hex satisfies
both, and the one that "mostly works" is the one that makes a button label
unreadable on exactly one screen. `--accent-text` is stored alongside each so
legibility is a decision someone made rather than a runtime luminance guess.

**`system` is resolved in JS, not by a media query.** The setting has three
values and CSS understands two, so leaving it to `prefers-color-scheme` would
make `dark` and `system` indistinguishable in the stylesheet — and an explicit
`dark` would flip to white the moment Windows decided it was morning.
`resolveTheme()` in `theme.ts` is the one place that decides.

**An inline script in `index.html` stamps the cached look before first paint.**
The real setting is a round trip away, which is long enough to paint the default
first — on a dark app that is a white flash on every cold load, the most
noticeable thing a theme can get wrong. It is blocking and inline on purpose; a
deferred module would run after first paint and defeat the point.

The swatches on the Settings screen carry their own `data-accent` and inherit
the real `--accent` from the same rules the app uses, so the button shows
literally what applying it will do. A second copy of the palette there would be
one more thing to keep in step, and the first colour to drift would be the one
nobody looks at twice.

Changes apply optimistically on click, before the save returns — a colour picker
that waits for a round trip to show you the colour is the one interaction where
latency is unacceptable, since you are choosing by looking.

### The mark

Five choices: the pause glyph (default), a circle, a triangle, a square, or an
uploaded picture. It takes the accent colour, so the icon and the app always
agree.

**Rendered per request, not at build time.** `src/icon.ts` draws the PNG and
`routes/icon.ts` serves `/icon/<size>.png` and a generated
`/manifest.webmanifest`. A static file could not follow a setting — the home
screen and the tab would keep showing whatever was current when the app was
built.

Both are **outside `/api/`**, and that is load-bearing: `auth.ts` protects
exactly that prefix, and the manifest and icons are fetched by the browser
itself — the iOS installer, the taskbar, the tab strip — none of which will
ever send a bearer token. Under `/api/` the app would have been uninstallable
on the phone, and only on the phone. The *writes* are `/api/logo` and local-only
like every other write that touches this machine.

**Icon URLs carry `?v=accent-shape-version`.** Browsers, the iOS home screen and
the Windows shell all cache icons hard; without a changing URL a new mark would
never appear. The server ignores the query — it only exists to change the URL.

In the page the mark is **inline SVG** (`Logo.tsx`) rather than an `<img>`, so it
repaints from `var(--accent)` in the same frame as everything else. Fetching a
PNG would make the logo the one thing that lagged a round trip behind the colour
that was just picked. That means the four shapes exist twice — as SVG here and
as arithmetic in `icon.ts` — which is real duplication, accepted because the
alternative was an SVG rasteriser on the server or a visibly laggy logo.

**The accent hex table is also duplicated**, in `ACCENT_HEX` (shared, for the
renderer) and in `styles.css` (for the app), because the PWA does not import
shared and CSS cannot import TypeScript. Neither copy can go, so
`make-icons.mjs` compares them and **fails the build** if they drift.

**It also refuses a `var(--x)` that nothing declares**, and that check exists
because of a real one. `--card` was used by nine rules and defined by none: the
context menu, the gauge track, code blocks, the live thumbnail and four hover
states. CSS has no error for this — an undefined custom property makes the
*whole declaration* invalid, so `background: var(--card)` is not a wrong colour,
it is **no background at all**. The right-click menu had been transparent for as
long as it had existed, with the page showing through it, and nothing anywhere
said so.

It is the same class of mistake as the palette drift and is refused in the same
place. `var(--x, fallback)` is exempt, since a fallback is a deliberate default
rather than a typo. All nine became `--surface-raised`, which is what the name
was reaching for — a surface lifted slightly off the one behind it.

`logo_shape` is `image` when a picture is uploaded rather than there being a
separate flag — the two are exclusive, and a `useCustomLogo` boolean alongside
a shape would allow "custom picture *and* triangle". Setting it to `image` with
nothing uploaded is refused by the route, since the schema cannot see the disk
and a silent fallback to the pause glyph looks exactly like a failed upload.

### Icons on disk

Three things still cannot be served: the Windows shortcut's `.ico`, the
extension's toolbar icons, and the `dist/` fallbacks referenced before any
JavaScript runs. `npm run icons -w @everything/web` builds those from the
defaults, and takes `--accent` / `--shape` to match a changed setting. It
imports `drawIcon` straight from the server — Node strips the types — so there
is one definition of what a triangle looks like rather than two that disagree.

`packages/web/scripts/make-icons.mjs` generates them at build time with a small
hand-rolled PNG encoder — no image library, no checked-in binaries. The mark is
a pause glyph, since the app's whole idea is holding something back until the
moment is right.

## Decisions already made (2026-08-05)

Paths that matter at runtime — the database, the agent's config, the migrations
folder — are resolved from the source file's own location, never from the
working directory. Task Scheduler starts processes in `C:\Windows\System32`, and
a relative database path would quietly create a second, empty database there.

| Decision | Choice | Why |
| --- | --- | --- |
| iPhone app | Installable PWA | No Mac, no Apple Developer account. iOS 16.4+ supports web push for home-screen PWAs, which was the blocker. |
| Sync | Server on the Windows PC, reachable over Tailscale | Free, private, no cloud. Trade-off: the phone only syncs while the PC is awake. |
| Password vault | Own vault, own browser extension | Decided 2026-08-06 after comparing Bitwarden, Vaultwarden, KeePassXC and 1Password. You want to own all of it. |
| Voice | Always-on wake word → local sherpa-onnx | Revised 2026-08-06, engine switched 2026-10-14. Push-to-talk is cheaper and cannot false-positive, but the requirement was a wake word you can *change from a text box*, and hands-free mid-game. Vosk did that with a closed grammar, which is what made it wake on "harvest festival"; a keyword spotter does it without one. See **Voice** below. |
| Source control | Local git, heading for a public GitHub repo | Revised 2026-08-08. `npm run publish-check` is the gate: it asks git whether the sensitive paths are ignored, refuses to pass on a tracked database or key, and warns about personal identifiers. Run it before pushing. |
| Licence | MIT | Decided 2026-08-08, over AGPL-3.0. AGPL's network clause would have forced anyone hosting it to publish their changes, which suits a product with users to protect; this has one user and the point of publishing it is that the ideas get taken. Copyright is held as `blue91321` rather than a legal name, matching the history rewrite that took the personal address out. |
| Commit identity | `blue91321 <blue91321@users.noreply.github.com>` | History was rewritten 2026-08-08 to remove a personal email. Trees verified byte-identical before and after; only metadata changed. `git config user.email` is set locally so new commits match — check it after any fresh clone, because that setting does not travel. |
| Platforms | Every platform eventually; the server in Docker | Decided 2026-10-14. The agent stays native per OS, since a container cannot ask about windows, idle time or the microphone. See **Where this is heading** at the top: the server must not shell out to the OS, and new dependencies should ship for Windows, macOS and Linux. |
| Windows agent | Headless Node service, **not Electron** | Electron costs 150–250MB resident to show a tray icon. The agent is 55MB — toasts go through WinRT via PowerShell, and the UI is the PWA in a browser. It *does* now draw a tray icon, via `Shell_NotifyIconW` for well under a megabyte; what was rejected was Electron's price for one, not the icon. See **The tray icon**. |

## Leanness

This runs forever on a gaming PC, so cost is a measured constraint, not a vibe.
`npm run bench -w @everything/agent` prints the current numbers.

| | Naive | Now |
| --- | --- | --- |
| Resident memory | 150–250MB (Electron) | **55MB** (one Node process), **220MB with voice on** |
| DB rows/day | ~43,000 | **~1,500** (measured: 5 rows per 201s of mixed activity) |
| CPU | 0.26% of a core | **~0.002%** typical |

Three mechanisms, all in `attention.ts` and `routes/attention.ts`:

1. **Games are found by snapshot, then watched by PID.** A full process scan is
   ~5ms and everything else combined is ~0.1ms. Once a game's PID is known,
   `processIsAlive` watches it ~2500x cheaper, so catching the end of a match
   never waits on a rescan.
2. **Tick rate follows state** — 5s in-game, 15s free, 30s away.
3. **Samples are coalesced server-side**, written only on a state change, a
   stopping point, or a 5-minute heartbeat. Attention history is pruned past 90
   days at boot and daily.

Before adding anything that runs on a timer, check it against these numbers.

**Voice is the one thing that breaks this budget**, and since the switch to
sherpa-onnx it breaks it in bursts rather than all day. Measured in the
listener harness (`voice-listen`), on top of whatever the agent already holds:

| | resident | when |
| --- | --- | --- |
| wake word spotter | **+50MB** | while voice is on |
| command recogniser | **+155MB** | from a wake until 10 minutes after the last command |
| speaker model | +25MB | from the first wake or enrolment |
| CPU | **~11ms per second of audio** | only while the room is audible — the RMS gate skips silence |

Under Vosk the whole set was resident whenever voice was on: **212MB** for the
agent, inside the 150–250MB this project rejected Electron over. Idle now, the
agent with voice on is roughly 120MB; it reaches Vosk's figure only for the ten
minutes after somebody actually spoke a command, which is the cost of a command
recogniser that can transcribe any English rather than a closed grammar of a
hundred words.

**Switching voice off gives it back.** `shutdown()` ends the command worker,
drops the spotter and the speaker model, and calls `global.gc` (the agent runs
with `--expose-gc` for exactly this). The binding has no explicit free, so
without the collection "off" would be a lie about everything except the
microphone until the collector next got round to it. What it does not return is
the onnxruntime DLLs, which stay mapped — about 30MB.

## Versions

All five packages carry the **same** version and move together, because they are
one app released as one thing — independent numbers would imply a release
cadence that does not exist, and would leave you diffing four of them to work
out what is actually deployed.

`version.ts` reads it from `package.json` at boot rather than keeping a second
copy in a constant, which is one `npm version` away from being a lie. It is
served on `/health` and `/api/session`, and shown on the Settings screen — the
PWA and the server update independently, so "which version am I looking at" is
the first question whenever something looks wrong.

Bump with `npm version <patch|minor|major> --workspaces --include-workspace-root`.

**Check what it committed before you walk away, because it does not commit all
of it, and it no longer even *bumps* all of it.** Twenty files carry a version
now and `npm version --workspaces` can see five: the root and the four
workspaces. It misses

- **the browser extension**, which has a `manifest.json` and no `package.json`,
  and moved to `packages/modules/vault/extension` when the vault became a
  package;
- **every shipped package** — `packages/modules/<id>/module.json` *and* its
  `package.json` — because the workspace glob is `packages/*` and those are one
  directory deeper.

The module manifests are the ones that matter to look at, because their version
is **on screen**: the Packages tab prints it against every row, so leaving them
behind puts the app at 0.3.0 and everything it ships at 0.2.3, on the one screen
whose whole job is saying what version things are.

And of the five it does bump, the commit and tag it creates contain **only the
root `package.json`** — the four workspace bumps are left sitting in the working
tree, unstaged. Nothing warns you about any of it.

That is worse than untidy. `version.ts` reads `packages/server/package.json`, so
a clone at the tag `v0.2.0` starts up and reports `0.1.0` on `/health` and on the
Settings screen — the exact question the version exists to answer, answered
wrongly, by a tag that looks authoritative. Caught when 0.2.0 was cut for the
integrations module.

So the bump is two steps, and the second is not optional:

```bash
npm version minor --workspaces --include-workspace-root
# then bump the fifteen it cannot see, and only then:
git add -A && git commit --amend --no-edit && git tag -d v0.3.0 && git tag v0.3.0
```

Verify at the **tag**, not in the working tree — `git show v0.3.0:<file>` — since
that is what a clone gets and the whole failure mode is a file that never made it
into the commit.

That is about the **workspace packages**, which are one app. The *features* on
the Packages screen are a different axis: they report the app's version while
they ship with it, and gain their own `version` in the manifest if one is ever
downloaded separately. Keeping those apart is what stops "one version for the
app" and "this package is newer than that one" contradicting each other.

## Typechecking

`npm run typecheck` covers **server, agent and web**. The server was missing for
a long time and that is worth knowing about, because it is the package with the
most code in it and the one that runs through `tsx` — which strips types without
looking at them. The first thing to notice a mistake was therefore the process
failing to start, and a deleted closing brace shipped exactly that way.

Adding a tsconfig turned up eleven errors. Ten were one bug written ten times
and one was cosmetic:

- **A conditional spread does not override.** The zod schemas describe the
  *input* — booleans, because that is what JSON has — while the columns are
  integers, because SQLite has no boolean type. `{ ...body, pinned: x ? 1 : 0 }`
  is fine; `{ ...body, ...(x === undefined ? {} : { pinned: … }) }` is not,
  because on one branch it contributes nothing and the schema's boolean is left
  where a number belongs. The fix is to pull the field *out* of the spread,
  which `habits.ts` already did for `voicePhrases` and had already written down
  the reason for. The idiom was here; it just had not been applied to the
  booleans, because nothing was checking.
- `smoke.ts` built an `AttentionReport` without `audioPlaying` or `windowsDnd`,
  both of which are required — so the helper's return type was a claim it did
  not meet.
- `tasks.ts` re-tested `body.status !== 'done'` in an arm the first branch had
  already taken every `'done'` out of. Harmless, and dead.

None of these were live bugs. That is the point: they are the class of thing
that is invisible until it isn't, and the server had no net under it.

## Ground rules

- **Dependencies, as of 2026-10-23: `npm audit` reports none.** zod went 3 to 4
  for a memory-exhaustion advisory fixed only in 4, and one behaviour changed:
  `.default()` now applies inside `.partial()`, so update schemas are built with
  `patchOf` in `shared`, or an edit that leaves a field out gets its default
  back. drizzle-kit's loader pins an esbuild with a development-server advisory;
  an `overrides` entry gives it a patched one, and drizzle-kit still reads the
  schema. Majors not taken yet: Vite 8, TypeScript 7, koffi 3, sherpa-onnx 2,
  @fastify/cors 11.
- **Never run `drizzle-kit generate`.** Snapshots stop at `0007`; every later
  migration was written by hand, so it compares against a months-old schema and
  writes a migration re-creating tables that exist. Migrations are written by
  hand, with an increasing `when` (see the memory note).

- **Never commit real data.** `data/`, `*.db`, `.env`, `agent.config.json`,
  `features.json`, `modules/` (installed packages, **not** `packages/modules/`,
  which ships), `modules.json`, the avatar and `logs/` are gitignored. The database is
  personal; treat it as such. `npm run publish-check` is the gate — run it
  before any push, and never loosen a rule to make it pass.

  Two things it exists to catch, both of which had already happened:
  `.claude/settings.local.json` was covered only by a *global* gitignore, which
  does not survive a clone; and the models rule named a path that stopped being
  true when the folder moved, which would have put 150MB of binaries in the
  first public commit. An ignore rule that silently stops matching looks exactly
  like one that is working.
- The agent is read-only about the system, **with one deliberate exception**. It
  observes windows and processes; it does not close, kill, or manipulate them.
  `packages/agent/src/features/voice/actions.ts` breaks that rule on purpose so a voice command
  can press a hotkey or open a site — decided 2026-08-06. It is the only file
  allowed to, and it is the most dangerous code here: a mis-heard phrase does
  not write a wrong row, it presses keys into whatever window has focus. Keep
  its guards intact and do not add a second such file without the same care.
- Prefer boring, debuggable code. This app has one user and needs to survive
  being ignored for six months and then edited again.

## Running it on this PC

Three double-clickable files in the repo root, because you should never need a
terminal to use your own app:

| File | Does |
| --- | --- |
| `Blue Everything.cmd` | Installs deps on first run, rebuilds the PWA if stale, starts both services, opens the app window. Double-clicking again just re-opens it. |
| `Stop Blue Everything.cmd` | Stops both. |
| `Create Desktop Icon.cmd` | Desktop + Start Menu shortcut with the app icon. |
| `Start Automatically.cmd` | Toggles the logon Scheduled Task on or off. |

Underneath they are `scripts\start.ps1 -Open`, `stop.ps1`,
`create-shortcut.ps1`, and `install-autostart.ps1 -Toggle`.

### Guest copies: friends on this PC

Plan A of "Blue Everything for friends" (the doc of that name): a friend gets
their own copy of the server on this PC rather than an account in yours.
Phase 1 is built, managed from **Settings → People** on your copy: add a
person, send them their sign-in link, start, stop and remove their copy, from
the PC or your phone. Several copies run side by side and share nothing but
Suwayomi. `npm run instance-check -w @everything/server` proves the rules
against a throwaway copy.

**From any of your devices, not only this PC.** Every device paired to the
host is yours, since friends pair to their own copies, so the People routes
(`/api/people`) take any of them (`isOwner` in `instances.ts`). That is what
lets it be run from a phone, which was asked for outright. A copy's key is
kept out by `INSTANCE_PREFIX` before it gets there.

**The host runs the copies.** Each is a detached child process of the host,
started with the host's own Node, `--import tsx` and `--instance=<name>`, the
way the manga package starts Suwayomi; started again when the host starts
unless it was stopped by hand (`autostart` in `instance.json`). Its environment is the host's less
everything that names the host's copy (`copyEnvironment`): a guest started
with the host's `DATABASE_URL` would be the host. A copy writes its own pid,
which is how one started by `start.ps1` or an earlier run of the host is
stopped. Measured: a copy answers 1.6s after it is made.

**Each copy is published on Tailscale**, at `https://<machine>.ts.net:<port>`
(`tailscale serve --bg --https=<port>`, tailnet only, kept across reboots by
`--bg`). A phone needs `https`, and `serve` was publishing only the host's
port. It needs no admin rights, which was checked before relying on it, and
removing a copy takes its port back off. The Tailscale helpers moved from
`routes/connect.ts` to `tailscale.ts`.

**Signed in by link, not by token.** A sign-in link is
`https://<machine>.ts.net:<port>/#invite=<code>`: single use, a day long. The
host writes only the code's hash, into the copy's own `invites.json`; the copy
swaps a matching code for a device token at `/api/invite/redeem`, the one
route a copy answers without one, and spends the code before minting so two
devices opening it at once cannot both get in. The host never opens a copy's
database. The PWA spends the link before it asks for its session
(`redeemInviteInUrl`) and takes it out of the address bar.

**Removing a copy moves it, it does not delete it**: stopped, unpublished, its
key revoked, and its folder moved to `instances/_removed/`, because it is
somebody's data. The name is typed to confirm.

Verified for real once, with a throwaway copy on the running PC: made in
1.6s, a link redeemed and the session answering as that copy, `/health` over
Tailscale `https`, stopped, started, removed, and `serve status` back to the
host's port alone.

```
.\scripts\start.ps1 -Instance sam        # the same from a terminal: make "sam" (first time) and start it
.\scripts\stop.ps1 -Instance sam         # stop it; -Instance '*' stops every copy
```

**A copy is a folder**, `instances/<name>/` (gitignored), holding its
database, `data/`, `logs/`, `features.json` and `modules.json`, and an
`instance.json` with the port it keeps (the first free one from 8788). Set
by `EVERYTHING_INSTANCE`; empty is the host, your copy, which runs exactly as
before. `paths.ts` moves everything under the folder, so nothing a copy
writes lands in another's.

That turned up three paths counted by hand rather than taken from `dataDir`:
the habit pictures, the logo, and the voice avatar. The avatar's had been
wrong since voice became a package: `../../data` from
`packages/modules/voice/server` is `packages/modules/data`, where it has been
saved since. The host still reads one left there until a new one is uploaded.

**A guest trusts nobody by where they are** (`isTrustedLocal` is false on a
guest), so your own browser on this PC needs a token for a friend's copy, and
every local-only route is closed. Those are the routes that act on this PC
(restart, update, launch a game, open a folder) and the ones that change the
install (pair a device, switch features, connect a service). A friend adds a
device with another sign-in link from you; connecting their own services is
phase 5.

**No agent, and no closing without one.** A guest's agent will run on the
guest's PC (phase 4), so a copy is started as a server only, without
`EXIT_WITHOUT_AGENT`. Each copy's command line carries `--instance=<name>`,
which is how `stop.ps1 -Instance <name>` stops one copy and leaves yours, and
how `Test-AgentRunning` never takes a copy for the agent. Without `-Instance`,
`stop.ps1` stops every copy too, so the tray's Restart moves them all onto new
code; your copy then starts again the ones that were running. Leaving them up
across a restart was the first version, and left friends on the old code.

#### Ratings, and what keeps itself

**A series can be rated 1 to 10** (`Series.rating`, only stored when set,
like the star), from a chip beside Favourite on the chapter list. 1 to 10
because MyAnimeList and AniList use it, so ratings can be compared and one
day exported.

**The Local collection can fill itself** (Manga → Downloads → Local collection and
ratings): every favourite, and anything rated at or above a chosen number.
`autoKeep` in `index.ts` runs from the release sweep and right after a star,
a rating or a rule changes, three series a run, since each is a whole series
to download; a guest's are kept by the host like everything else. Off unless
chosen.

**Sharing ratings is off unless chosen**, as asked, per copy. On, a copy hands
the host its whole set (`shared-ratings.ts`, `data/manga-shared-ratings.json`
on the host, the only writer), and a series' page shows "Rated by sam 8/10".
Off takes the set back out, so off means nobody sees them. Sharing with other
servers and exporting to MyAnimeList or AniList are on the card, disabled and
marked as coming: the first waits on linking servers, the second on
registering an app with MyAnimeList.

#### Names: who asked, who rated, who kept

**Onboarding asks for a display name first** (`names.ts`), and Settings →
General has it after. **It can be skipped**: until one is chosen a friend's
copy is called what the host named it (`sam`), and the host "user"
(`defaultName`, on the session too, so the box shows it). It is shown wherever something of one person reaches
another: who asked for a source, who rated a series, who a kept series was
kept for, and on People. **A label, not an identity**: everything is still
recorded by the copy's own name (`sam`), and the display name is looked up
when shown (`nameFor`, which also turns your own entry into "you" and the
host's into the host's name), so renaming is one write.

Each copy keeps its own in `data/profile.json`. A guest also tells the host,
`PUT /api/host/name` with its key, which the host writes into that copy's
`instance.json`; `/api/host/` is the second prefix an instance key may reach
(`INSTANCE_PREFIXES`). The host reads its own files, not a copy's, which is
the plan A rule and the Docker shape.

#### Onboarding, and a friend with only a phone

**After an update, a hand-picked list is asked about what is new**
(`NewScreens.tsx`). Onboarding records which of the three was picked
(`preset`) and every screen on offer (`known`). "Everything" takes a new screen
in by itself, being the empty list meaning all; "just the manga" means only
manga; so only `custom` is asked, once per screen: both **Show** and **Not
now** record today's screens as known. A list chosen before this has no
`known`, and is taken as today's without asking. A list sent without its
choice is read as one (`presetOf`), or saving "just the manga" by list alone
left the old choice standing, which `instance-check` caught. Checked in the
browser on `test`: a list of Manga and Notes was asked about six screens, and
keeping Tasks added only Tasks.

**A new copy opens on onboarding** (`Onboarding.tsx`, state in `onboarding.ts`):
install to the Home Screen, what's on, then notifications and quiet hours,
last, in the order asked for. The host starts done, having been set up before
it existed; **Settings → General → Go through setup again** starts it over.
Kept per copy on the server, so every device of one person agrees.

**What's on is what shows, not what loads.** "Just the manga" (first, as
asked) keeps Manga and Settings in the menu and on Home and opens on Manga;
Everything, or a hand-picked list. It is `shown` in `onboarding.json`, applied
where the menu's list is built, at once and from a phone. Switching a part off
for real is Settings → Packages, which takes a restart and is the PC's to do:
the wrong price for somebody's first minute. A hidden part still runs, which
on a new copy is nothing.

**The installed app opens signed out, so the install step shows a code.** An
iPhone keeps a Home Screen app's storage apart from Safari's, so a phone
signed in by its link in Safari opens the installed app with no token. The
install step makes a hand-off code (`POST /api/devices/handoff`, from any
signed-in device of the copy: eight letters, no look-alikes, ten minutes,
once), and the sign-in screen takes it where a token goes, typed loosely
(`ab cd 2345` works). It is redeemed at the same no-token route as a link's
code, now on every copy, held to twenty tries a minute. It is also a friend's
only way to add a device to their own copy, since pairing from Settings is
local-only and a guest has no local.

**A copy with no agent delivers to the phone itself** (`phoneOnlyDelivery` in
`routes/attention.ts`). Everything used to be delivered from the agent's
heartbeat, so a friend with only a phone would never have had a notification,
and onboarding's last step would have switched on something that never fired.
On a guest, once a minute, unless an agent reported in the last five minutes,
it sweeps and delivers as though the person were away from a PC: `free` with a
long idle, not `away`, because the engine never delivers a passed deadline to
`away` and the phone is where one should go. Quiet hours still hold.

Verified: `test` read as not onboarded and the host as done, after a restart
of both; on a computer the first step was "What do you want it for?", the
install step skipped. `instance-check` covers the rest, the code typed with a
space and in lower case included.

#### One Suwayomi, run by the host

A JVM per friend would be several hundred MB each, and sources are worth
managing once. So the host's copy runs the one Suwayomi as it always has, and
a guest:

- **wakes it through the host**: `HostSuwayomi` in `process.ts` stands where
  `SuwayomiProcess` does on a guest, with the same five members, so the
  nineteen routes that call `ensureRunning` work unchanged. It asks
  `POST /api/manga/host/wake` and counts as somebody using it, so the host's
  idle timer does not stop it under a guest's reading. A guest's store reads
  as managed with `HOST_SUWAYOMI` in place of a jar (`library.ts`).
- **asks for a source instead of installing one.** Install, update, remove,
  update-all, auto-update, the repositories and Suwayomi's own interface are
  refused on a guest. Manage extensions offers **Ask for it**, which sends
  `POST /api/manga/host/requests`; the host's Manage extensions lists it
  under *Asked for*, naming who asked, with Install and Unflag. Flags gained
  `askedBy` to say who.
- **asks with a key**: a device of kind `instance`, minted by the host for
  each copy it finds (at its start, or when `start.ps1` makes one) and written
  to `instances/<name>/host-key`. An `instance` key opens only
  `/api/manga/host/` (`INSTANCE_PREFIX` in `auth.ts`), and nobody can pair one
  (`pairableDeviceKinds`).

**On one PC that key is a courtesy, not a wall**, and it is worth knowing
why. Every copy runs as the same Windows user, so a guest's process could read
the host's database file directly, and the host trusts loopback anyway. The
key is the shape for Docker, where each copy is a container with no shared
disk and no loopback trust, and the key is then all a guest can do to the
host. Real isolation between friends on this PC is the code not crossing, not
the operating system stopping it.

#### One store of kept manga, for everyone on the PC

**One edition of each chapter.** A source can list a number twice (MangaFire
does for 408 of Eleceed's 464), and keeping both was the series twice, into
one folder: the folder is named by number, so the edition fetched second wrote
`001.jpg` and on over the first's, and the first's manifest then pointed at
another edition's pictures. `pickEdition` keeps the newer upload, as the
chapter list shows it, and records the others as `sameAs`, so opening any of
them reads the kept one. `mendEditions` repaired what was kept, once at
startup: the edition whose pages are all still the size it recorded stays (an
overwritten page is a different picture), the other's own leftover files go,
and one left with neither whole is fetched again. The queue takes turns
between series (`nextInQueue`), so a series kept today does not wait behind
every chapter of a long one.

"Keep every chapter in the Local collection" (`archive.ts`, once "on the PC") is one store on the host's disk,
read by every copy and added to by every copy, which is what was asked for.
Only the host writes it: a guest's **Keep** asks `POST /api/manga/host/archive`,
and the host lists the chapters from the shared Suwayomi and downloads them
itself. So there is one copy of each series and one thing downloading, and a
friend cannot fill your disk without the host's worker doing it at its usual
pace.

**Keyed by Suwayomi's id, not a series id.** A series id belongs to one copy's
library; your copy and a friend's call the same series by different ids, and
only the Suwayomi they share agrees with itself. Index entries carry
`mangaId` (read from the manifest for an entry written before), and every
lookup takes it beside the series id (`entryFor`), so your copy finds a series
a friend asked for and the other way round. A series kept for a copy and in no
library here is entered as `kept-<mangaId>`; **Catch up** on one reads what it
is from its manifest (`keptEntry`). `keptFor` says who asked.

**A guest reads it through the host**: `/api/manga/host/archive/pages` and
`/page`, with its key, checked against a list of what is kept that the guest
asks for at most once a minute (`hostKept`), so a series nobody kept costs no
request. A guest may not stop keeping one or delete it, since it may be what
somebody else is reading; the Archive screen there shows the store without
those buttons.

**Two ways to find it.** Browse opens on **Local collection** until a source is
chosen, and goes back to it when the chosen one is gone (it opened on the
first source alphabetically, which nobody picked). It is `kept`, remembered
like any source, and lists everything kept, by anyone,
opened and read like any other source's results, from the kept copy, so a
series whose site has gone is still here. And the Library has a **Local collection** filter (was "On this
PC** filter (`kept` on each series).

**Looked after on Downloads**, not More: "Kept for good" and "Local collection
and ratings" sit under the device's own downloads, with **Read it in Browse**
opening Browse on the Local collection. Keeping a series is a download, to the
PC rather than the device, so the two are found in one place.

Verified on the running PC: the `test` copy listed the one series the host
keeps, opened a chapter, and its first page came back in 40ms through
`/api/manga/host/archive/page`, with no source asked.

The rest of the library is the guest's own: series, read marks, places,
shelves, the page cache, the downloads. Suwayomi's ids are shared because
the Suwayomi is.

### Popups and sounds

`popup.ts` owns the one overlay window; `sound.ts` makes the noises. Both are
**core**, and everything with something to say goes through them.

The overlay started inside `features/voice/`, which made it deletable along with
the microphone and — much worse — meant **nudges could not use it**. A nudge is
delivered at a stopping point, which very often means the instant a match ends
with a game still holding the screen. A Windows toast raised then is a toast you
may never see, so the app spent all that effort picking the right moment and
then announced it somewhere invisible. The overlay draws above exclusive
fullscreen; that is the whole reason it exists.

**The Windows toast is gone.** It was raised alongside the popup on the
reasoning that the two fail in opposite ways — the overlay gets *noticed*, above
an exclusive-fullscreen game, while the toast *persists* in the Action Centre.
What killed it is what one costs: there is no WinRT binding here, so every
notification spawned PowerShell — a process and a few hundred milliseconds, for
the half you were less likely to look at. `notify.ts`, `toast.ps1` and
`npm run toast` went with it.

What is genuinely lost is the Action Centre entry: a nudge you miss is now
missed rather than waiting in a list. The queue still holds it, and an
undelivered nudge is on the Dashboard either way.

**The popup wears the app's accent, and did not.** `COLOR.accent` was
`#ffb454` hard-coded — amber, the default — so every popup title came up orange
whatever the Settings screen said, and the one window that draws above a
fullscreen game was the one place the app did not look like itself.

The colour rides the **attention heartbeat** rather than the voice config, for
the reason `soundEnabled` does: the popup is core, an install with the voice
package deleted still raises nudges through it, and that is the only request the
agent always makes. Applied every heartbeat, so picking a colour reaches the
overlay without restarting the agent.

The **dark** value always, since the overlay has one background and it is the
dark one — the light-theme variants are the pair darkened to carry white text.

`accentFromHex` is split out from `setAccent` purely so it can be asserted:
**GDI wants `0x00BBGGRR`**, so a byte-order slip does not throw, it draws blue as
orange — which is the bug being fixed, and would be a poor thing to reintroduce
inside the fix. `popup-check` covers all eight accents, a missing `#`, capitals,
and that no two collide.

`overlay-try` reads the accent from the server too. Without that the diagnostic
would be the last place still showing amber, and would "prove" a bug that had
been fixed.

**The popup reads as a conversation.** Within one exchange each turn is appended
rather than replacing the last, and the window grows — measured at 76px for a
bare "Listening…" up to 164px for a wake, a command, a reply and a follow-up.
What you said is right-aligned and what it did is left-aligned, so the two are
distinguishable without a "you said" prefix eating the width of a 380px window.
A fresh wake word calls `show` and starts over; that is the reset, and it is
deliberate rather than a timer.

**It has a ✕.** Every other way out was a timer, Escape, or clicking somewhere
that is not a choice — none of them *visible*, so a popup that had stayed up
looked like something to wait out. It is the one control here that needs an `x`
as well as a `y` in the hit test: choice rows span the full width, so testing
height alone was enough until something sat in a corner.

**`show({forMs: 0})` means "stay up"; `hide(0)` means "hide now".** They are
opposites and they briefly shared a code path, which drew the "Listening…"
popup and hid it in the same frame. The symptom was not a missing popup — it
was *apparent latency*: the wake sound played instantly, nothing appeared, and
the first visible popup was the result one a second later, so the fast path
looked like the slow one. `npm run popup-check -w @everything/agent` asserts the
timing against `visible()`, because "did that window flash for one frame" is not
something anyone can check by eye.

The window itself is not a latency cost and never was: **2ms median to show,
6ms worst, 2ms to create at boot** — measured, when this was suspected. Anything
that looks like popup lag is somewhere else.

There is exactly one popup instance. Two owners would eventually both be
visible, or would fight over the hide timer and leave a window up forever — so
the lifecycle lives in `popup.ts` and callers pass content. Voice claims only
the click handler, being the only thing that offers a choice. It is created at
startup rather than on first use: ~3ms, and the alternative is paying it exactly
when somebody is waiting to see whether the wake word worked.

**The sounds are generated, not shipped** — the same reasoning that has the app
icons drawn by `make-icons.mjs` rather than committed. A WAV header is 44 bytes
of arithmetic and a sine is one line, so binaries in git would buy nothing.
Each tone fades in and out over a few milliseconds, which is not decoration: a
sine cut off mid-cycle clicks, and on a 70ms blip the click is most of what you
hear. `npm run sound-try -w @everything/agent` plays them.

They go out through `PlaySoundW` from winmm — the library `mic.ts` already loads
— rather than PowerShell like `notify.ts` does. A toast is rare and can afford
a few hundred milliseconds to spawn a process; a sound accompanies the wake word,
where a few hundred milliseconds is the entire point missed.

**Which tone goes with which moment is a setting.** Four moments — a nudge
arriving, voice starting to listen, a command working, a command missed — each
pointed at a name from a palette of nine (`rise`, `chime`, `arrive`, `sink`,
`knock`, `soft`, `blip`, `fall`, `none`).

A named list rather than a synth editor: what anybody wants from "customise the
tones" is for the wake sound to be distinguishable from the nudge sound and for
neither to be irritating, which is a choice between options rather than a design
task. Empty means "the default for that moment" rather than storing the default
name, so changing `DEFAULT_TONE` later reaches installs that never touched it.
The WAVs are cached by *tone*, not by event, so two moments set to the same tone
share one file. An unknown name falls back to the default rather than to
silence.

### Picking a tone plays it

A dropdown of nine words is not a choice anybody can make — `knock` and `blip`
are not self-describing — and for a while the only way to tell them apart was
`npm run sound-try -w @everything/agent -- --tones`, which is exactly the "open
a terminal to change a setting" friction the three double-clickable files exist
to remove.

**The browser cannot ask the agent to play one.** The agent holds no inbound
connection; it polls. A preview routed through the attention heartbeat would
land five to fifteen seconds after the click, and from the phone — where the
setting is equally editable — it would never land at all.

So the *server* renders the WAV and the browser plays it, from
`/sounds/<tone>.wav`. Measured at **6ms** from selecting a tone to the bytes
arriving.

That is why `TONES`, the palette and the WAV encoder now live in
`packages/shared/src/sound.ts` rather than in the agent that plays them: both
the server and the agent have to reach them. The agent keeps the part that is
genuinely about this machine — winmm, the temp file, and which tone each event
currently points at.

**The gain is not tidiness, it is that the preview cannot lie.** The obvious
alternative was a Web Audio approximation in the PWA, and its failure mode is
the worst available: a preview that sounds nearly like what interrupts you, with
nothing to catch the drift. This project already fails a build over `ACCENT_HEX`
drifting from `styles.css`. Both sides call the same `wav()` over the same
table, and the agent's temp files were compared byte-for-byte against the
route's responses for all eight audible tones — identical.

Two details:

- **It is outside `/api/`, like the icons and the manifest.** `auth.ts` protects
  exactly that prefix, and an `<audio>` element sends no bearer token — under
  `/api/` this would 401 in a way whose only symptom is silence. Nothing is
  exposed: a tone is a sine computed from nine numbers.
- **`none` answers 204, not a zero-length WAV.** An empty audio file is
  something every browser is entitled to call broken, and the console error
  would be the only feedback from choosing "silent". The picker does not ask for
  it anyway; the route is honest regardless.

The tone is played *before* the save returns, for the same reason the accent
swatches apply their colour before theirs: you are choosing by listening, and a
round trip in front of that is the one latency that cannot be spent.

`soundEnabled` rides on the **attention** heartbeat, not the voice one, because
popups are core: an install with `features/voice` deleted still raises nudges,
and that is the only request the agent always makes. On by default, unlike
voice — it attaches to something you already asked to be told about rather than
opening a device — but a noise you cannot switch off is the fastest way to make
someone switch the whole app off instead.

### The tray icon

`packages/agent/src/tray.ts` puts Blue Everything in the notification area —
under the `^` arrow, with the other background apps. Left-click opens the app;
right-click offers **Open**, **Restart** and **Stop**.

**Every server on this PC is under this one icon.** With friends' copies, the
menu lists each under *Friends' copies*, ticked while running, as **Stop
sam** or **Start sam** (`TrayCopies`), and Restart and Stop read *everything*,
which they already were. The list is the People route, asked as the menu
opens; the menu waits up to 1.5s for it, so it is current without a timer.
Copies never had icons of their own; this is where they are run from now.

**The icon is the claim that the app is running, so Stop takes Suwayomi with
it.** Suwayomi is started by the server and stopped by its `onClose` hook — but
`stop.ps1` force-kills the server, so that hook never ran and the JVM carried on
serving manga sources with no icon anywhere. `stop.ps1` now stops anything whose
command line names this checkout and "suwayomi" and is a Java or CEF helper
process (the JVM, rooted in our data folder, and its helpers), which leaves a
Suwayomi you run yourself alone. Restart passes `-KeepSuwayomi`: the icon is
back in seconds and the server adopts the JVM on its port rather than paying
most of a minute to start another. Suwayomi's own tray icon and its
open-a-browser-on-launch are both switched off at launch, so the one icon is the
only one.

**And when the icon goes, the app goes.** The icon belongs to the agent, so an
agent that has stopped, crashed or been killed means the server is running with
nothing on screen admitting it. A server started by `start.ps1`
(`EXIT_WITHOUT_AGENT`, set there and nowhere else) closes itself after 90s
without a word from the agent, and its `onClose` hooks stop Suwayomi — passing
the port, so a JVM adopted after a restart and not yet asked anything still
goes. `npm run dev`, `smoke` and a server on a VPS leave the switch off and run
as they always have. `agent-watch.ts` has the rest; two things there matter:

- **The signal is `POST /api/agent/alive` every 20s, not the attention
  heartbeat.** After an ordinary server error the agent goes quiet for five
  minutes by design (`BACKOFF_MAX_MS`), which would have read as the icon being
  gone. The check-in writes nothing and is not announced. The heartbeat still
  counts, so an agent from before the check-in keeps a newer server up.
- **Sleep is not absence.** Nothing runs while the PC sleeps, so on waking the
  last check-in is hours old. A watch tick arriving far later than due means the
  machine was suspended, and the agent gets a fresh window instead of the app
  shutting itself down the moment the PC wakes.
- **`forceCloseConnections: true`, or the close never finishes.** Fastify runs
  `onClose` hooks only after in-flight requests end, and the event stream never
  ends: every open app window holds one. The first live test stopped listening
  and then sat there, process alive and Suwayomi still up, because the hook
  that stops it was waiting on a browser tab. Connections are cut on close now,
  and the shutdown is bounded at 15s on top, since a close that hangs leaves
  exactly the iconless process this exists to prevent.

This changes what the Voice screen's **Start it** is for on this PC: it now
brings the agent back within the ninety seconds before the server follows it,
rather than into a server that would have waited indefinitely.
`npm run tray-try -w @everything/agent` shows it without starting the agent.

It exists because both services run hidden, so the app had nowhere to be
*found*: two anonymous `node.exe` processes and a `.cmd` file in a folder you
had to remember the path to.

**This is not the tray Electron was rejected for.** That comparison was
150–250MB to draw an icon. `Shell_NotifyIconW` is four calls and a 976-byte
struct, and Windows owns the pixels — the same reasoning that let `overlay.ts`
draw a real window without a browser engine, with less to justify because this
draws nothing.

The agent hosts it rather than the server, and that is load-bearing: the server
binds `0.0.0.0`, ships a Dockerfile and is meant to move to a VPS. Win32 code in
it would end that. The agent is already the Windows-side process and already
owns every `koffi` binding here.

Three things there are easy to get wrong:

- **The menu items shell out through `cmd /c start`, and that form is not
  optional.** Two requirements pull against each other, and only it satisfies
  both — measured, after the obvious version shipped doing nothing at all:

  | launched as | runs? | survives the parent being killed? |
  | --- | --- | --- |
  | `spawn('powershell.exe', …)` | yes | **no** |
  | …plus `detached: true` | **no** | — |
  | `cmd /c start /b "" powershell.exe …` | yes | yes |

  The child must outlive its parent, because `stop.ps1` kills every Node
  process whose command line names this project — including the agent whose menu was
  just clicked. But `detached: true` on Windows means `DETACHED_PROCESS`, and
  `powershell.exe` needs a console host: with no console it exits instantly
  without running a line. `start` has the command processor create the process
  and cmd then exits, so what runs belongs to nobody and has a console of its
  own. `restart.ps1` exists for the same reason: the sequencing has to survive
  the process that asked for it.
- **A menu item that fails has to say so.** The first version used
  `stdio: 'ignore'` and no logging, which is why the above was invisible: a
  broken launch and an unclicked menu item look identical. Output goes to
  `logs\tray.log` — via PowerShell's own `*>>`, not a `>>` on the cmd line,
  because `start /b` hands the new process cmd's handles and cmd's were
  `ignore`, so a shell redirect there creates the file and captures nothing.
  The icon is also **put back if the launch fails**, since it is taken down
  before restarting and an app with no icon and no explanation is the worst of
  both.
- **`NOTIFYICONDATAW` fails silently when its size is wrong.** `cbSize` is how
  the shell picks which version of the struct it was handed, and a mismatch is
  not an error — it is a `FALSE` return and an icon that never appears. On x64
  the modern layout is 976 bytes.
- **The window must not be message-only.** `HWND_MESSAGE` looks right for a
  window that is never shown, but such a window cannot receive broadcasts — and
  `TaskbarCreated`, which is how the shell says Explorer has restarted and taken
  every tray icon with it, is broadcast. Without it an Explorer crash leaves the
  agent running and unreachable until a reboot.

**A warning on stderr ended a restart halfway.** `start.ps1` runs with
`$ErrorActionPreference = 'Stop'`, and Windows PowerShell 5.1 turns each line a
native program writes to stderr into an error, but only when the output is
redirected. In a console it passes through, so `Blue Everything.cmd` was fine,
while the tray's Restart, which sends everything to `logs	ray.log`, died at
vite's "rendering chunks" on a harmless dynamic-import warning: after the stop,
before any start, so the app was left stopped. npm goes through `Invoke-Npm`
now, which lowers the preference for that call and leaves failure to
`$LASTEXITCODE`. Reproduced both ways under `*>>` before trusting it.

The message pump is polled like the overlay's, at 250ms rather than 16ms — a
tray click can afford a quarter of a second, and a menu nobody has opened should
not cost 60Hz forever. The two pumps are safe together: `PeekMessageW` with a
null window drains the whole *thread* queue, and `DispatchMessageW` routes each
message to the window procedure it belongs to.

If the icon cannot be created at all the agent logs one line and carries on. A
session with no desktop is not a reason to stop watching for stopping points.

### Closing the window: the tray, or everything

**Settings → General → When you close the app**, also asked in onboarding on a
computer (`Closing.tsx`): keep running in the background (the tray icon, like
Discord or Steam), or close everything with the window. Per copy, in
`data/closing.json` (`closing.ts`). Keep is the default.

**It closes anyway when nothing needs it.** `keeps(side)` lists in words what
needs the background now: voice, reminders (an active habit that reminds, or
an open task with a due time), and on the PC that runs the server, friends'
copies that are running and devices used in the last month. Empty, the window
closing ends it whichever was chosen: a friend here for manga has nothing for a
tray icon to do. The list is on the setting live, as what closing would stop.

**The agent notices and acts** (`packages/agent/src/closing.ts`). The
launcher writes each app window it opens to `logs\app-windows.txt`
(`Save-AppWindows`); a three-second check asks Windows whether those are still
windows, and when the last one goes it asks `/api/closing`. Stopping waits five
seconds (opening it again in that time keeps it), then is the tray's own Stop
(`tray.quit()`). **No popup**, as asked: the choice and what it stops are said
where it is made. On the host, stopping is `stop.ps1`, so friends' copies and
Suwayomi go too, which the list says.

**Not verified live**: closing a window and watching it stop. The rule, the
routes and the defaults are in `instance-check`.

### Its own window, not a browser tab

`Open-AppWindow` in `start.ps1` launches the first Chromium-based browser it
finds with `--app=<url>`: no tabs, no address bar, its own taskbar button and
its own Alt-Tab entry. Losing the app among browser tabs was a real complaint,
and this fixes it without Electron's 150–250MB.

The shortcut points at `start.ps1 -Open`, not at the browser directly, so
clicking it works whether or not the services are already running.

**And the two are one taskbar button** (`scripts/app-id.ps1`). Windows groups
buttons by AppUserModelID, and the shortcut runs powershell.exe while the
window is Brave's, so a pinned shortcut sat beside the app it had opened. Both
get `BlueEverything.App`: the .lnk files as a property (Desktop, Start Menu,
and any pinned copy that runs `start.ps1`, by `create-shortcut.ps1`), and the
window as a window property, set from outside once it opens
(`SHGetPropertyStoreForWindow`), which the taskbar follows when it changes.
The window is found by its exact title, "Blue Everything" (or the wordmark's
"Blue Dabadee"): an --app window's title has no " - Brave" after it, so a tab
of the app in an ordinary window is not taken for it. If the C# cannot be
compiled the app still opens, with two buttons as before.

Three things cost a round each. **A PROPVARIANT is 24 bytes on x64**, not 16:
declared at 16, every read came back empty (Claude, Discord, Brave all "no
ID") while the writes had worked, which read as stamping being impossible
across processes. It is not: Explorer reads every window's ID, and a write
from another process holds. **Only a window without the ID ends the wait**:
counting every match, an app window stamped earlier ended it before the new
one opened, which kept Chromium's own `Brave.127.0.0.1_/`. And Explorer may
hold a pinned button's old ID until it restarts, so an already-pinned
shortcut can need unpinning and pinning again from the Start Menu.

`assets/everything.ico` is generated by the same script as the PWA icons, with a
small hand-rolled ICO container at 16/32/48/256 — Windows picks different sizes
for the taskbar, Alt-Tab and the desktop, and letting it downscale one large
image looks muddy.

`start.ps1` rebuilds the PWA when anything in `packages/web/src` is newer than
`dist/index.html`. Without that, editing the app and restarting silently serves
the old build, which is a baffling thing to debug.

Both services launch as plain `node --import tsx <absolute path>` rather than
through `npm run`, which would leave an extra npm wrapper process alive per
service. Two processes, ~135MB combined.

The absolute entry path matters beyond tidiness: `-WorkingDirectory` is what
lets `--import tsx` resolve the loader, but only the *command line* is visible to
`Get-CimInstance`, and that's how `stop.ps1` distinguishes these from every
other node process on the machine.

#### The two processes say which they are

They were two rows reading `node.exe`, which is no use for the question anybody
actually asks of Task Manager: which of these is mine, what is it costing, and
what do I end if it misbehaves. A dev machine has several node processes and
none of them says whose it is. They are **Blue Everything** and **Blue
Everything Server** now, so a resource check is
`Get-Process "Blue Everything*"` rather than a hunt through command lines.

**A running program cannot name itself here, which is the whole reason this is
a launcher change.** Windows takes a process's name from the file it was
started from. `process.title` renames the process on Linux and on Windows only
sets the console window title — and these run hidden, so it sets nothing at
all. So the only way to be legible in that list is to be *started from* a file
with the right name, and `node-runtime.ps1` makes two of those beside the Node
it already owns.

**Hard links, not copies.** node.exe is 89MB, and relabelling two rows should
not cost a quarter of a gigabyte. They are made in the folder node.exe is
already in, so they are on the same volume by construction — the one thing a
hard link needs — and being beside it means the process starts in exactly the
environment it did before. Measured: three names, one 89MB file, **0 KB** of
disk.

**Every step of it falls back to `node.exe` itself.** A label is worth a few
milliseconds at startup and not worth an app that will not start, so a volume
with no links to give gets a copy, and a folder that refuses both gets the
plain name and no label. `stop.ps1` therefore matches all three names and not
just the new two — and that is not legacy either: `npm run dev`, `npm run
agent` and anything started by hand all run the plain name.

**The staleness check is length *and* write time**, which is the one test that
covers both shapes: a hard link shares them with node.exe by definition, so it
can only ever fail for a copy left behind by a Node upgrade. That case matters
more than it sounds — a stale copy of an older Node would go on running the app
on a version it is not meant to be on, invisibly, because everything would
still work.

**The release zip leaves them out.** A zip cannot hold a link, so each would go
in as another whole Node — and `node-runtime.ps1` makes them on first run
against whatever node.exe is actually there, which is also what keeps them from
going stale across an update.

**Naming them turned up a bug, which is not a coincidence.** Ending a process
from Task Manager is the thing a name invites you to do, and the day these got
names somebody ended the agent — and found the app neither closed nor came back.

Both halves of that were real. The server *did* close itself, ninety seconds
later, exactly as `agent-watch.ts` says it should; what it did not do is say so,
and two minutes of an app that looks stuck is indistinguishable from one that is.
The second half was the actual fault: **`start.ps1` treated "the port is open" as
"the app is running"**, and the app is a server *and* an agent. So
double-clicking it printed "already running" and did nothing, the agent never
came back, and the server then closed for the lack of it — a restart that
appeared to shut the app down.

The fix is one question asked properly. `Test-AgentRunning` sits beside
`Test-Listening` and asks it the way `stop.ps1` already does — an image name
Node is started from here, and a command line naming this checkout. The server's
command line names the checkout too and ends in `packages\server\src\main.ts`,
so it can never match on `agent`. When the server is up and the agent is not, it
hands over to **the `-AgentOnly` path that already existed** for this exact
shape: the Voice screen's *Start it* is the same situation reached from inside
the app. A second way to start an agent would have been a second thing to keep
right.

**"Names this checkout" means the folder and a separator.** The scripts
matched the folder's path anywhere in a command line, and Windows compares
without case, so an install at `...\Everything app test user\...` named
`...\Everything App` too: `start.ps1` took the test folder's desktop client for
its own agent and never started one, and `stop.ps1` stopped both. `start.ps1`,
`stop.ps1` and `desktop.ps1` match `<folder>\` now.

The reverse is guarded too, and was never reachable before: with the server down
and the agent alive, the full path used to start a second agent — two tray
icons, two sets of nudges, and two microphones wanting one device.

**Which also removes the silence.** Restarting now brings the agent back inside
the ninety seconds, it checks in, and the server never closes at all — so the
window nobody could see through is a window nobody has to wait out. Verified by
ending the agent and double-clicking: same server pid, new agent pid, one agent,
and the watchdog never fired.

What is *not* labelled is the app window: that is Brave or Edge with
`--app=http://127.0.0.1:8787`, so its memory belongs to the browser and its name
always will. It is still findable by that command line, and worth counting
separately — it is a browser rendering a page, not part of the 135MB above.

**`start.ps1` said `Check $logDir\agent.err.log` and printed `Check .err.log`
and a beep.** The `\a` was stored as an actual 0x07, so PowerShell read
`$logDirgent` — an undefined variable — and the message for a failed agent start
named no file. Found while reading that branch for this change, and it is the
second escape sequence to ship as the byte it names: the first was a lone `\r`
in `create-shortcut.ps1`, which cost a debugging session and broke that script
on every PC. So `publish-check` no longer checks for one byte. Tab, newline and
a CR that is part of a CRLF are the only control bytes a script has any use
for; **anything else in one is refused by name and offset.** Verified by
planting a bell in a tracked script and watching it fail.

### Offline: the app keeps working without the server

`web/src/offline-sync.ts` and `offline-effects.ts`. Every screen opens with what
this device last saw, under a banner saying it is offline and since when; what
you do meanwhile is queued and sent when the server answers again.

**Reads are kept by `send()`, not by the service worker.** Every successful
read under `/api/` goes into the `everything-data-v1` cache, keyed by path, and
answers when the server cannot — at once when already known to be offline,
after a timeout when the PC is asleep (a request over Tailscale to a sleeping
machine hangs rather than failing), and when `tailscale serve` answers with its
own non-JSON gateway page. The service worker still never caches `/api/`; it
keeps the shell, as before.

**Never kept**: the vault, whose decrypted secrets have no place in a browser
cache; the event stream; who is online and the voice agent's state, which are
lies when stale; and browsing manga sources. The list is `NEVER_KEPT`.

**The banner is not optional.** A list from this morning shown as the current
one is the stale-data-as-fact this app is built against, so every screen says
when its data is from and how many changes are waiting.

**What it says depends on the device.** Downloads and kept reads live in *this*
browser, so what can happen to them is a fact about the device: iOS clears a
web app's storage when the phone runs short of space (and, in a Safari tab
rather than from the Home Screen, after about a week unvisited), a computer's
browser only when its disk is nearly full, and on the PC that runs the server
"offline" can only mean the app has stopped — so "needs the PC" is nonsense
said to the PC. `web/src/device.ts` answers which device this is, once; it had
been three copies, in the banner, the offline screen and push. The manga
package's sentences are gathered in `device-text.ts` so its four screens word
each fact one way. None of it is a security decision: what a device may *do*
is still the server's call.

**Writes queue only when they have a local effect.** `registerOfflineEffect`
says how a change edits the kept reads — a tick bumps the saved habit's count —
and answers as the route would, so it shows at once. A change with no effect
registered is refused with "needs the PC" instead: an action queued invisibly
reads as the app ignoring you. Registered: tasks (add, change, delete), habits
(tick, untick, set, edit, reorder), notes (write, edit, delete), dismissing and
snoozing reminders, and settings. Note folders and anything about devices or
packages are deliberately not.

- **Replayed in order, with the time it happened.** `x-happened-at` rides on
  each replayed change, and `server/src/happened-at.ts` honours it for habit
  ticks, finishing a task and time entries — within a month back, and never the
  future. `smoke` asserts a tick from a day and a half ago lands on that day.
- **Things created offline get a temporary id** (`offline-…`), swapped for the
  real one on replay — in the queue and in any later request, since a screen may
  still hold the temporary one. Changes wait behind anything already queued, or
  a note created offline could be edited on the server before it exists.
- **Consecutive edits to one thing merge.** A note typed offline saves every
  second; forty replays of one paragraph would be forty requests to reach the
  last of them.
- **A change the PC refuses on replay is listed on the banner**, not dropped
  quietly — it did not happen, and you should know.

**A request that times out is not yet "offline".** `send` asks `/health`
first, which needs no token and answers in milliseconds from a server that is
merely busy. If it answers, the request was slow, not lost: nothing is marked
offline, and a change is **not** queued, because one that timed out may well
have happened and replaying it would do it twice. A read with a saved copy shows
that copy; anything else says the PC is taking too long. The session is the
exception and still goes to the offline screen, since an ordinary error there
would mean the pairing screen. This was a slow Play being reported as the PC
being gone.

**Coming back is noticed twice**: the live stream reconnecting, and a probe
every twenty seconds while offline *and on screen*. Either flushes the queue and
refetches every screen. The probe does nothing in a hidden pane, which is why a
test in the browser pane sees the stream find it first.

Packages with their own clients (manga, weather) go through `apiRequest`, core's
request exported, so they are kept and refused the same way rather than each
writing a copy of the rules.

**The service worker must never delete caches it does not own.** It deleted
every cache but its own on update, which was harmless until anything else
stored data — and would then have emptied downloads and kept reads on the first
update. It deletes only `everything-shell-*` now.

**Testing it** needs no stopped server: a small proxy on another port forwards
to the app and, when switched, drops every `/api/` request mid-connection, as
losing signal does. The in-app browser refuses service workers, so the shell's
own offline behaviour is proven on the phone, not there.

**What it costs**: about 4KB gzipped on the main bundle (94.8 → 98.8), for the
cache, the outbox, the effects and the banner.

### A window older than the build reloads itself

`stale-build.ts`. Screens and Dashboard cards are separate files fetched the
first time they are shown, named by a hash that changes every build, so a window
open across a rebuild asks for names the server no longer has. The failed import
took the whole page down: a blank window, which is also exactly what an app that
has broken looks like. Found by opening the Dashboard in a window left open
through a restart.

Vite raises `vite:preloadError` for a failed import, and cancelling it stops the
error, so the page cancels it and reloads, which picks up the new build because
the service worker fetches the page network-first. Three guards:

- **Cancelled only when reloading.** Cancelled and not reloaded, the import
  resolves to nothing and React fails on that instead, worse than the error.
- **Once a minute at most** (`sessionStorage`), so a build that is genuinely
  missing a file shows its error rather than reloading forever. If storage
  refuses the record, it does not reload at all, for the same reason.
- **Not while offline**, where a reload would trade what is on screen for the
  cached shell and still could not fetch the part being opened.

Verified by renaming the shelf card's file in `dist/` under an open window:
opening the Dashboard reloaded once, and with the file still missing it stopped
there.

**The window still went white, because the server said yes.** A missing file
under `/assets/` fell through to the single-page fallback, which answers every
unknown path with `index.html` and a 200. So the old build's main script came
back as HTML: the browser refuses to run it, no `vite:preloadError` fires
because it is not a lazy chunk, and `stale-build.ts` lives inside the very
script that never ran. The service worker then saved the HTML under the
script's name. Found in `server.log` on 0.5.7's first morning: at 07:09, as a
game ended, the window asked for `index-C2EHJ3IR.js` and `index-H441vTLu.css`,
names from builds earlier that day, without asking for the page first, and got
the page back for both. A reload at 10:34 fetched the page and was fine.

Three changes, one per layer that got it wrong:

- **The server 404s a missing file** (`app.ts`): anything under `/assets/` or
  with an extension. Only extensionless paths are client-side routes, which is
  all this app has, since its views are in the hash.
- **The page reloads itself when its own script or stylesheet fails** — an
  inline listener in `index.html`, before the module script, because it has to
  run without it. Same once-a-minute record as `stale-build.ts`, and not
  offline. Verified by adding a script for a missing file to an open page: it
  reloaded and drew; a second within the minute did nothing.
- **The service worker hands back the shell only for a page** (`sw.js`). Offline
  it answered a missing script with `index.html` too, the same white window by
  another road. Its cache is `v2`, so the v1 copy holding HTML under a script's
  name is deleted on activation.

### When the server is not running, the window is still there

The service worker caches the shell, so stopping the server leaves the app
window open and looking fine while every request fails. That failure used to be
indistinguishable from a 401 — it dropped you on the **pairing screen**, asking
for a device token, which is the one thing that was not broken. `api.ts` now
throws `ServerUnreachable` for a network failure specifically, and `App.tsx`
renders `Offline.tsx` instead.

**That screen is now the first-run case only.** A device that has used the app
opens it offline with what it last saw — see **Offline** below — so this screen
appears only when there is no saved session at all. On the PC itself, where
"offline" means the server is stopped, the offline banner carries the same
**Start it** link, so nothing that screen offered is lost.

That screen offers to start it, through an `everything:` URL registered in HKCU
by `scripts/register-protocol.ps1` (run by `Create Desktop Icon.cmd`, alongside
the shortcut — both answer "set this machine up to run the app"). A web page has
no other way to launch a process.

**The command takes no `%1`.** Nothing from the link reaches PowerShell, so the
whole of what any page on the internet achieves by invoking `everything://` is
starting your own app — the same thing the desktop shortcut does. Verified:
`Start-Process "everything://start"` with the server down brought it back up.

**The click itself is a real `<a href>`, not `location.href` in a handler.**
Chromium gates handing a URL to an external program on a user gesture and treats
an anchor navigation as one far more readily than a scripted assignment, which
it drops silently. Expect a one-time "Open Blue Everything?" prompt; that is the
browser asking the right question in the right place.

**This is the one part not verified end to end here.** The automation browser
refuses external-protocol launches outright, so a real click produced no launch
and no console error — which is what that policy looks like, and also what a
broken button looks like. The handler and the screen are each verified
independently; the handoff between them needs one press in a real window.

The fallback is therefore always on screen rather than behind the failure — the
file to double-click, named — because a protocol that was never registered does
nothing visible at all. The button is hidden entirely off loopback: from the
phone over Tailscale it could only ever appear to do nothing.

### Nothing to install first, and nothing outside the folder

The first person to try this on another PC had to install Node.js before it
would start, then failed to run manga twice: their Java was 17 and Suwayomi
needs 21 (`UnsupportedClassVersionError … class file version 65.0`), and then
they pointed the app at Suwayomi's `.msi` installer, which is not a jar. Each is
now impossible rather than explained.

- **The app's own Node, in `runtime\node`** (`scripts/node-runtime.ps1`,
  dot-sourced by `start.ps1`, `update.ps1` and `create-shortcut.ps1`). It is put
  first on the process's PATH, so the server, the agent and npm all inherit it,
  and a Node installed on the PC is never used. **It has a floor, `$NodeMinimum`**, raised
  by hand when Node ships a security release: the folder used to be filled
  only when `node.exe` was missing, so an install kept the Node it first
  downloaded for good (24.21.0 when 24.22.1 was a security fix). An older one
  is replaced at the next start that finds nothing running from the folder,
  moved aside rather than deleted so a locked file cannot leave half a Node.
  Tested on a copy: 24.15.0 became 24.22.1; a second start downloaded nothing;
  a copy held open by a running node was left alone with a line saying so. A git clone downloads it on
  first run; a release zip already has it and every dependency (`--bundle` in
  `package-release.mjs`), leaving out only npm's four links to the app's own
  packages — a zip cannot hold a link — which `start.ps1` makes with
  `npm install --offline`. `runtime/` is gitignored.
- **Set up manga is one button** (`server/setup.ts`): Temurin's Java 21 JDK from
  Adoptium and Suwayomi's plain `.jar`, both into
  `packages/server/data/suwayomi-runtime/`, then management on, Suwayomi
  started, and the extension repository added — a fresh Suwayomi lists nothing
  until one is. The launcher prefers that Java whenever it exists. About 210MB.
- **Java's folder must not be called `jre`.** Named that, Suwayomi started,
  migrated and then died setting up GraphQL ("The configured packages do not
  contain any valid classes: [suwayomi.tachidesk.graphql]") under Temurin's JRE
  *and* JDK, while the same jar ran under a Java installed anywhere else. The
  library that finds those classes, ClassGraph, reads a `java.home` ending in
  `jre` the Java 8 way — as the inside of a JDK — and skips everything under the
  folder above it as part of Java itself, which is where the jar sits. It is
  `suwayomi-runtime/java/`. Found by running the jar by hand on throwaway data
  folders, varying one thing at a time, after the JDK "fixed" it in one test
  and not in the next.
- **Suwayomi stopping took the server down, until it didn't.** Its two outputs
were piped into one log file, and a pipe closes its destination when its source
ends; the exit handler then wrote "exited" into the closed file, an `error`
event with no listener, and Node ended the process. It stops by itself after
fifteen idle minutes in on-demand mode, so the app went offline while nobody
was using it. The pipes now leave the file open (`end: false`), it is closed on
`close` once both have finished, and a failed write to it is ignored. Found in
`server.err.log`, which `start.ps1` now keeps a run back as `server.err.prev.log`.

**Suwayomi listens on 127.0.0.1 only** (`server.ip`, passed at launch). Its
default is every interface with `authMode = NONE`, and the firewall rule Windows
made for the app's Java allows Private networks, which home Wi-Fi and Tailscale
both are: anything on either that reached port 4567 had all of Suwayomi,
extension installs included, which is code running on this PC. Found in an
audit, verified by a refused connection to the PC's Wi-Fi address afterwards.
Nothing here talks to it from anywhere else, and the phone's way to its web
interface is `/manga/ui`, which checks the session cookie. A property rather
than an edit to `server.conf`, so a fresh data folder or a hand-edited one gets
it too.

**And one start, however many ask at once.** `ensureRunning` set `starting` only
once the launch began, after awaiting the check for one already answering, so
every request in that moment spawned its own JVM: six in a second after a
restart with Browse open, all but one quitting for the port. The check is now
inside the shared start. Verified: six simultaneous requests, one start.

**Extensions update themselves once a day** unless switched off on Manage
extensions (`autoUpdateExtensions`, on by default) (`updateExtensionsIfDue`), from
the release sweep rather than a timer of their own, and only while Suwayomi is
already running: it is never woken for this. When it last ran and what it did is
in `data/manga-extensions.json`, so a restart does not check again at once, and
the card shows it. An out-of-date extension is the commonest reason a source
stops working, which is why this one is automatic and Suwayomi itself is not:
a Suwayomi version jump migrates its database and is worth choosing.

**Updating is setup run again** (the card's *Update Suwayomi and extensions*).
Every run asks GitHub for the newest release, so on a working install it is the
update: a newer jar is downloaded beside the runtime, the running Suwayomi is
stopped (forced, since an update was asked for and it holds the port and the
database), `database.mv.db` is copied to `data/suwayomi/backups/` because the
version jump migrates it and migrations only go forward (two copies kept), and
the new jar is started. **The old jar is removed only after the new one
answers**: removed straight after the download, it was still the running
Suwayomi's jar, which Windows may refuse to delete (failing the whole update),
and a new version that would not start left nothing to go back to. The two
newest backups are kept by when they were made, not by name, since `v2.10`
sorts before `v2.4`. Then every installed extension with `hasUpdate` gets
`updateExtension(patch: { update })`. `result` says what was done, so "already
up to date" is an answer rather than a button that seemed to do nothing. First
run here: v2.3.2243 to v2.4.2366 and 7 extensions, with Browse, search and
chapter lists checked against it afterwards.

**Its temp folder is cleared of what only grows**, each time the app launches its
own Suwayomi: `Tachidesk/manga-cache` (its copy of every page it served, 6.2GB
in 25,283 files here) and a `tachidesk_network_cache…`, `jna-…` and `zstd-kmp…`
per launch. `thumbnails` stays, since clearing it would fetch every cover again.
Each entry is removed on its own: one `rmSync` of the whole folder stopped at the
first locked file and removed nothing. 6.5GB to 260MB.

**The start timeout counts silence, not time.** A fresh Suwayomi downloads its
  web interface and a 260MB browser component before it answers, which on an
  ordinary connection is past 90 seconds, and the launcher killed it mid-download.
  Now it fails only after 90 seconds with no output. Its temp files go to
  `data/suwayomi/tmp` (`-Djava.io.tmpdir`) rather than the system's.
- **Only the app's folders are searched for a jar.** `findJars` looked in
  Downloads and the home folder, and that is how an `.msi` was offered; a path
  that is not a `.jar` is refused with the reason.
- **Failures are put in words** (`explainFailure`): an old Java (with its
  version worked out from the class-file number), an installer as the jar, a
  port in use, out of memory. Anything else ends "the log below says why", and
  the card shows the log's end — from the phone too — with Open in Notepad on
  the PC. `/api/logs/:name` does the same for the app's own logs, so the update
  banner's log is a button rather than a path.
- **Every Manga tab has a banner** while it is not set up or not starting, and
  its button opens the More tab's setup card and scrolls to it; the card also
  opens itself while anything needs doing.
- **`START HERE.txt`** at the root says what to run, what is needed (Windows 10
  or 11, 64-bit — nothing else) and the manga steps. CRLF, for Notepad.

**Every `.ps1` carries a UTF-8 byte-order mark, and publish-check refuses one
with non-ASCII bytes that does not.** Windows PowerShell 5.1 reads a script
without one as ANSI, so an em dash becomes three characters, one of them a
curly quote it accepts as a string delimiter. In a comment that is harmless;
inside a string the script does not parse. `create-shortcut.ps1` was in that
state — "Create Desktop Icon.cmd" failed on every PC — and the new
`update.ps1` would have been too. Found by parsing every script with
`[Parser]::ParseFile`, which is worth doing after any edit to one.

### Blue Everything Desktop: the agent, on a PC with no server

A second download on every release, `BlueEverything-Desktop-<version>.zip`
(`scripts/package-desktop.mjs`), for a Windows PC whose Blue Everything runs
somewhere else: a friend's copy on this PC, or a second PC of yours. It is the
part a browser cannot be: the tray icon, the popup above games, noticing a
match end, voice and Riot presence. The app itself is still the web page, in
its own window (`Open-AppWindowAt`, shared with `start.ps1`). The app links to
it from Settings → Devices → **Sign in another device** and from the Voice
screen when no agent can be started (`DESKTOP_APP_URL`).

**It is the agent and nothing else**, which the architecture made possible:
the agent has only ever spoken HTTP. The zip is the agent, `shared`, the agent
halves of voice and integrations (still at `packages/modules/<id>/agent`,
where the agent looks), the app's Node, and only the libraries the agent's
package.json files lead to (seven, 60MB). `@everything/shared` is a junction
`desktop.ps1` makes, since a zip cannot hold npm's link.

**It is its own app on the taskbar and the Desktop.** Its shortcuts are
"Blue Everything Desktop" (`Create Desktop Icon.cmd` in the zip, which is
`desktop.ps1 -Shortcut`), and its ID is `BlueEverything.Desktop`, so on a PC
that also runs the full app the two keep a button each. That needed the
window stamping to take **only the window a launch opened**: both open windows
titled "Blue Everything", so stamping by title alone gave each the other's
windows. `Open-AppWindowAt` lists the Chromium windows first and stamps only
a new one.

**It wears its copy's icon.** The server draws the chosen colour and shape as
an .ico too (`/icon/app.ico`, with `encodeIco` moved from `make-icons.mjs`
into `icon.ts` so both use it), and `desktop.ps1` fetches it at each start for
the shortcuts, the sign-in window and the tray (`assets/app.ico`). The
shortcuts' copy is named by its contents (`app-<hash>.ico`), since Windows keeps
a shortcut's icon by path and would show the old picture under the old name.

**Moving the folder is survived.** The `@everything/shared` junction holds an
absolute path, and the first real install was unzipped in Downloads and then
moved: the junction pointed at a folder that had gone, and the agent stopped
with "Cannot find package '@everything/shared'". It is checked at every start
and replaced when it points anywhere else, and the shortcuts there are are made
again each start, pointing at where the folder is now.

**It is optional, and runs only if wanted.** A friend needs nothing in the
background: the app is the web page, in a browser or on a phone. The desktop
client is for popups over games and voice, which need a process watching the
PC. "Start when I sign in to Windows" starts unticked. On the host's own PC
while testing, its tray icon sits beside the host's: they are two apps.

**"The PC" is said from where the reader is** (`thePc`, `serverPc` in
`device.ts`). To the host it is the PC; to a friend, whose own PC is in front of
them, it is "the host's PC", and "friends on this PC" is "friends who share this
Blue Everything". App records which kind of copy it is from the session in
localStorage, because the manga wording is built when its code loads.
"Keep every chapter on the PC" is **Keep every chapter in the Local
collection**, true for both. "Away from the PC" is left alone: it means the
reader's own.

**It needs no server, only Node.** `runtime/node` runs the agent, which listens
on nothing: every request goes out to the address it signed in to.

**A local build takes new files too, and checks its imports.** Both
packagers listed only tracked files, so a zip built before a commit left new
ones out: the desktop client without the agent's `closing.ts` stopped as it
started with "Cannot find module". They take untracked, unignored files now,
and `package-desktop.mjs` refuses to zip when a relative import in its code
has no file beside it (comments aside).

**It knows what it is by what is missing**: no `packages/server`
(`desktopOnly` in `tray.ts`), so the tray's Open, Restart and Stop go through
`desktop.ps1` instead of scripts that start a server.

**Signing in is a code, not a token.** `desktop.ps1` shows a small window: the
app's address (or a pasted sign-in link, which carries its code) and a code
from Sign in another device. It redeems it at `/api/invite/redeem` as a
`windows-agent` and writes `agent.config.json`, where the agent always looked.
It offers to start with Windows (a Startup-folder shortcut) and makes a Start
Menu one, both with the shared app ID.

**Voice from somewhere else.** Toggling voice and enrolling were local-only, on
the grounds that the agent is on the server's PC. They now take the agent's own
key, and on a guest any of that person's devices (`agentSide` in voice's
routes). Launching a game and opening its folder are still the server's, so
they do not work for a desktop client yet; they belong in the agent.

**And it downloads from the app** (`routes/desktop-app.ts`): Settings → Devices
→ Sign in another device has **Download Blue Everything Desktop**, as does the
Voice screen when nothing can listen. The server hands out
`dist/release/Blue-Everything-Desktop-<version>.zip`: built here by
`npm run desktop-zip`, or else fetched once from this version's GitHub release
and kept there. A browser download sends no token, so the button asks for a
two-minute ticket and the browser fetches `/download/desktop-app?ticket=…`,
outside `/api/` like the icons. Verified: a ticket downloaded the 62MB zip whole,
and no ticket or a made-up one is refused (`smoke`).

Verified: built here, unzipped into a scratch folder, signed in to the `test`
copy over its Tailscale https address with a code, and the copy reported the
agent running from its attention and check-in requests; `desktop.ps1 -Stop`
stopped it and left the host's agent alone. **Not verified**: the sign-in
window by hand, and a PC that is not this one. It has no updater: a new
version is downloaded again.

### Releases, and updating without losing anything

**Two configurations, and a desktop client** (2026-10-23; no central website,
which was decided against). Each release carries:

| file | is |
| --- | --- |
| `Blue-Everything-<v>.zip` | Everything |
| `BlueEverything-JustManga-<v>.zip` | the reader on its own: manga and push, and none of voice's speech engine |
| `BlueEverything-Desktop-<v>.zip` | the agent alone, for a PC with no server (see **Blue Everything Desktop**) |

`package-release.mjs --config just-manga` leaves the other packages' folders
out (the deleted level `features-check` proves boots), writes
`configuration.json` into the zip, and the server's first-run defaults read it
(`configuration` in `paths.ts`): a Just Manga install opens on Manga. The PWA is
built whole, so their screens' code is in the bundle and never offered, being
from packages that are not there. Verified: built, unzipped and booted on a
spare port, it ran manga and push and opened on Manga.

**An install updates from its own kind.** `update.ps1` reads
`configuration.json` and downloads that zip by exact name, so Just Manga never
downloads the rest; `-Configuration everything` switches, through the same
release-files rule. The other names avoid `Blue-Everything-*`, which is what an
updater from before this matches and takes the first of: renaming them is what
keeps a 0.5.9 install from updating itself into the desktop client. **The
download is checked against the release's `SHA256SUMS.txt`** before anything is
touched, and refused if it differs.

**A version tag builds a release.** `.github/workflows/release.yml` runs on
`windows-latest` — the app is a Windows app and the checks should run where it
runs — typechecks, runs every suite with no hardware or network in it, builds
the PWA, and `scripts/package-release.mjs` zips every tracked file plus the
built `packages/web/dist`. The zip is published as a GitHub Release, with the
version's own section of `CHANGELOG.md` as its notes, and kept as a workflow
artifact too, so running the workflow by hand produces a download without
publishing anything. **The tag must match `package.json`** and the packaging
refuses otherwise: a release called 0.4.1 reporting 0.4.0 on its Settings
screen is the failure **Versions** describes.

`node_modules` is deliberately not in the zip: native modules are built per
machine, and `Blue Everything.cmd` installs them on first run.

**Windows' own `tar.exe`, by path.** A bare `tar` on a machine with Git Bash is
GNU tar, which cannot write a zip and reads `C:` in a path as a remote host to
connect to. Found running the packaging locally before trusting it to CI.

**Every release carries `release-files.txt`**, the list of files it shipped, and
that list is the whole of what makes updating safe. `scripts/update.ps1` —
behind `Update Blue Everything.cmd` and Settings → Packages → Update now —
copies the new release's files over and deletes a file the *old* list names
that the new one does not, or a removed package would linger and still load.
A file neither list names is never touched, which is how the database, your
installed packages and the voice models survive: by construction, not by a list
of exceptions somebody has to keep current.

- **Backed up first**, to `backups\<when>-v<version>.zip`: the database and
  JSON stores, `features.json`, `modules.json`, the agent's config and `.env`.
  Not Suwayomi (hundreds of MB, and an update does not touch it), the chapter
  cache or the old `.bak` copies. Migrations only go forward, so this is the way
  back. The last five are kept; `backups/` is gitignored and publish-check
  proves it.
- **A git clone pulls instead**, with `--ff-only`, and refuses outright if
  tracked files have been changed — somebody's edits are not this script's to
  merge.
- **Only when asked.** "Check for updates" asks GitHub's latest-release
  endpoint (`UPDATE_URL`) when pressed, never on a timer; Update now is
  local-only and launched like Restart, through `cmd /c start /b`, answering
  before it acts because this server is one of the things it stops.
- `-FromZip` installs a zip already on disk and `-NoStart` leaves the app
  stopped, which is how it was tested: a copy unpacked from the zip, planted
  with a database, settings, an installed package, the agent's token and one
  file only an "older" release listed. After the update all of it was intact
  and backed up, and only that file was gone.

## Running the parts individually

```bash
npm run build -w @everything/web       # build the PWA; the server serves it from dist/
npm run dev -w @everything/server      # server on :8787, migrations applied on boot
npm run agent -w @everything/agent     # the Windows agent — needs the server up

npm run dev -w @everything/web         # PWA with hot reload, proxying /api to :8787

npm run doctor -w @everything/agent    # verify the Win32 layer is healthy
npm run bench -w @everything/agent     # what one poll costs
npm run toast -w @everything/agent     # prove notifications reach the screen
npm run tray-try -w @everything/agent  # show the tray icon, without running the agent
npm run overlay-try -w @everything/agent   # show the popup — core, so it survives deleting voice
npm run sound-try -w @everything/agent     # hear the generated notification tones
npm run popup-check -w @everything/agent   # prove the popup stays up and goes when it should
npm run sensor -w @everything/agent    # live attention readout; --seconds N to bound it
npm run smoke -w @everything/server    # end-to-end proof the nudge engine holds and releases
npm run instance-check -w @everything/server  # a guest copy keeps to its folder, trusts no one, and only asks the host

npm run voice-setup -w @everything/agent   # fetch the models if missing; is the mic live?
npm run voice-try   -w @everything/agent   # prove the recognisers, without saying anything
npm run voice-listen -w @everything/agent  # drive the live listener with synthesised speech
npm run voice-enrol -w @everything/agent   # teach it your voice — say the wake word ten times
npm run voice-check -w @everything/server  # prove the phrase matcher, in memory
npm run wake-falsing -w @everything/agent  # how often ordinary conversation wakes it
npm run pair -w @everything/server -- "Device name" phone   # mint a bearer token, shown once

npm run notes-check -w @everything/server  # the Markdown parser, wiki-links, tags, folders
npm run integrations-check -w @everything/server  # the categoriser, the Takeout reader, the coursework rules

npm run features         # what is switched on, and what is actually on disk
npm run features-check   # prove each one can be switched off and deleted
npm run modules-check -w @everything/server  # the zip reader, and installing a package
npm run publish-check    # is this repo safe to make public?
npm run typecheck        # all three TypeScript packages, server included
```

The voice CLIs live inside the feature (`src/features/voice/cli/`), so they stop
existing when it does. That is correct: `npm run voice-setup` failing on an
install with no voice is a better answer than a setup script for a feature that
is not there.

The agent reads `packages/agent/agent.config.json` (gitignored — it holds this
machine's bearer token), or `EVERYTHING_SERVER_URL` / `EVERYTHING_TOKEN`.

Add games without editing source via `extraGames` in that file, or
`EVERYTHING_EXTRA_GAMES=starfield.exe,foo.exe`. Anything that grabs exclusive
fullscreen is already treated as a game; the list is for the ones that don't.

### Testing stopping points without playing a game

Set `EVERYTHING_EXTRA_GAMES=notepad.exe` and open and close Notepad. Opening it
reads as `in-game`, closing it fires a `prime` stopping point.

Note that idle time is real: if nothing touches the keyboard for 5 minutes the
state becomes `away` and *nothing* fires, which will look like a bug when it
isn't. A synthetic zero-pixel `mouse_event` resets the idle timer if a test
needs to look present.

## Server

Fastify + libsql (SQLite), migrations applied at boot. Built to be moved: it
already binds `0.0.0.0`, reads everything from env, and ships a Dockerfile.
Relocating it to a VPS is a `DATABASE_URL` / `HOST` change plus a deploy —
libsql speaks to a local file and a remote server through the same client.

**The agent is an HTTP client like any other.** It never imports the database or
shares a process with the server. If that boundary is ever crossed, the server
stops being movable — so don't cross it.

`src/config.ts` is the only file allowed to read `process.env`.

### Live updates between devices

`GET /api/events` is a server-sent-event stream. Every open client — the
desktop window, the phone, a stray browser tab — reloads the moment anything
changes, so two sessions can't drift apart.

Server-sent events rather than polling because an idle connection costs nothing
while a 15-second poll would wake the database forever whether or not anything
happened. Rather than WebSockets because updates only ever flow one way and this
needs no extra dependency.

**The scope is carried through to the client, and readers subscribe to theirs.**
The server has always sent `{ scope, at }`; `live.ts` used to drop it and wake
every reader, so one settings toggle refetched the notes list, the task list and
the device list. `useAsync(fn, deps, ['settings'])` names what a reader is
actually showing. An unknown scope, or `all`, still wakes everything — the
server saying "I don't know what changed" must not be silently narrowed.

**Concurrent GETs for the same path are coalesced** in `api.ts`. One
announcement reaches every reader at once, and the Settings screen alone holds
three readers of `/api/settings` plus the one in `App` — measured at **six
identical requests for one click on a toggle**. They ask the same question at
the same instant and cannot get different answers. The entry is dropped as soon
as the response settles, so it is a coalescer and not a cache: a stale read is
the one thing this cannot afford, since the whole point is that two devices
never disagree. With both changes that click is 3 requests, and the device list
no longer reloads at all.

**`checkSession` must not blank the app.** `checking` renders "Connecting…"
*instead of* the shell, so setting it on a re-check unmounted every screen and
rebuilt it — losing the scroll position and flashing. It was reported as the app
"refreshing to the top of the page", and looked exactly like one. Only the first
check blocks now; a later one refreshes in place.

**`loading` means "nothing to show yet", never "refreshing".** The same bug one
level down, and the more common one: screens are written
`if (x.loading) return <spinner/>`, so a `loading` that went true on every
reload replaced the whole screen with one line of text — the page collapsed and
the browser took the scroll position with it. `Voice.tsx` did exactly this, so
changing where the popup appears sent you back to the top.

That is not a mistake to fix per file. It is the only sensible reading of the
word, so `useAsync` now means it: `loading` is true only before the first result
ever arrives, and `refreshing` is there for anything that genuinely wants to
show a reload happening over data already on screen.

Two things here are load-bearing and easy to get wrong:

- **The `onResponse` announcer must attach to the root instance**, not inside a
  `register`. Fastify encapsulates plugins, so a hook added alongside the SSE
  route fires only for that route — it silently announced nothing else.
- **`/api/attention` is excluded** from the generic announcer and emits only
  when it actually changed something. It fires every few seconds; broadcasting
  it would make every client reload on a timer, which is the polling this
  avoids.

The browser reads the stream with `fetch`, not `EventSource`, because
`EventSource` can't send an Authorization header and the alternative is putting
the bearer token in a query string where it lands in history and proxy logs.
`live.ts` holds one shared connection for the whole page, reconnects with
backoff, and refetches on `visibilitychange` — iOS suspends a backgrounded PWA
and kills the stream with it.

### Time passing is something changing

"Only when something changes" was the default and was not quite true: *time* was
changing and the screen was not showing it. A friend read "away 25m" for an hour,
a gauge said "empty in 4 hours" all evening, and the weather said "1 hour ago"
long after it was three. Every one of those is arithmetic on data already in
hand, so the fix is not a refetch — the screen only needs telling that the clock
moved.

`clock.ts` is **one interval with a subscriber list**, started when the first
component asks and stopped when the last goes, so a screen with no durations
pays nothing. Ten seconds, which is finer than anything displayed: nothing shows
seconds, so a number is never more than ten seconds late, and a minute-long tick
would leave "away 4m" standing for up to a minute after it became five — the
sort of small wrongness that is hard to notice and impossible to trust.

**It makes no requests, and that is the distinction the two settings draw.** The
refresh interval decides how often to ask the *server* anything; this decides how
often what is already on screen is redrawn. Leaving refresh off and still having
the timers tick is what "only when something changes" should have meant.

#### Ageing a value the server resolved

A gauge is the harder half, because its level and both countdowns are computed
server-side and are correct only as of the response. `useAsync` therefore reports
`receivedAt`, and the row ages the numbers forward by `Date.now() - receivedAt`.

**That is a duration, not a comparison, and the difference is what keeps it
compatible with the rule that the level is resolved on the server.** The
objection there was that a phone a few minutes out would draw a different gauge
from the PC — true, because comparing a server timestamp against a local clock
inherits the offset. A stopwatch started when the bytes arrived is the same
length on both devices however wrong either clock is, and it re-syncs to the
server's answer on the next fetch.

Verified with the refresh setting **off**: a gauge went 38% → 37%, away timers
went 23m → 28m and 4h 4m → 4h 9m, and the only requests in that window were the
handful the server announced.

**One thing still needs a fetch**, and is worth knowing rather than discovering:
the weather's *temperature* is picked from the stored hours server-side, so
crossing an hour boundary changes it only on the next read. The age beside it
ticks; the number waits. Doing that in the browser would mean a second copy of
the timezone matching `sliceHours` documents at length.

### Refreshing the Dashboard on a clock, if you ask

**Nothing here polls, and that is worth stating before the exception.** A change
made anywhere announces itself over `/api/events` and every reader refetches
when one lands — which is why a habit ticked off on the phone appears on the PC
with no timer involved. There is no interval anywhere in the PWA.

What that cannot cover is data moving at *somebody else's* server with nobody to
tell us: a friend going idle on Steam, an hour passing inside a stored forecast,
a duration on screen counting up. Those advance only when something happens to
trigger a read, so a Dashboard left open sits still — which is what prompted
this.

`settings.dashboard_refresh_seconds`, **0 and off by default**, offered as five
named options rather than a slider: a slider is right for a number on a
continuum and wrong for a handful of alternatives where every position between
them is a worse version of a neighbour.

**It reuses `notify('all')`, which is the whole design.** That is exactly what
`visibilitychange` already does when the app returns from being backgrounded —
the same claim, "anything could have changed", through the same path. Nothing
new subscribes, and no reader learns a timer exists.

**Only while the tab is visible.** A background tab that kept refetching would
spend requests on a screen nobody is looking at, and coming back to the app
refetches anyway through the visibility handler.

**One tick is one request per endpoint, not per reader**, because `api.ts`
coalesces concurrent GETs of the same path. Measured in the browser at a 30s
setting: two ticks exactly thirty seconds apart, seven requests each, against a
Dashboard whose readers number rather more than seven.

Bounded 0–3600 and integer-only. Below ten seconds this stops being a refresh
and becomes the polling the attention loop was tuned to avoid; above an hour it
is off with extra steps.

Verifying the visible branch needed the pane's `visibilityState` overridden,
because a browser pane that is not compositing reports `hidden` forever — the
same limitation that makes `requestAnimationFrame` and `ResizeObserver` measure
nothing there.

### The one endpoint that matters

`POST /api/attention` is the agent's heartbeat and does everything in one round
trip: records the sample, sweeps tasks coming due into the queue, and returns
whatever earned the right to interrupt. Clients stay dumb; all judgement is
server-side so the phone and the PC can never disagree about what a good moment
is.

### Two holes found by auditing, and what they teach

Both were in code this project wrote by hand, and both were confirmed by
actually firing them at the running server rather than by reading.

**Reflected XSS on the OAuth callback.** `/oauth/callback/:provider` builds HTML
by hand — it has to, being a real navigation rather than a fetch — and dropped
the provider's `error` and `error_description` straight in. Those come off the
query string of an *unauthenticated* route, so
`?error=<script>…` came back at HTTP 200 as `text/html` with the tag intact, on
the same origin that holds the device bearer token in `localStorage`. `esc()`
now escapes `&`, `<`, `>`, `"` and `'` — the quotes matter as much as the angle
brackets, since a value landing inside an attribute escapes it without needing a
tag at all.

The general lesson is narrow and worth keeping: **this is the only place the app
builds HTML by hand.** Everywhere else React escapes by construction, which is
exactly why the one exception went unexamined.

**Path traversal on the habit picture.** The id goes into a filename as
`habit-${id}.png`, and `habit-` is *its own path segment* — so a `..` after it
pops that segment and every further `..` climbs out. `..%2F..%2Favatar` returned
`data/avatar.png` byte-for-byte, and four levels up read a file outside `data/`
altogether. The read route was the one that leaked because it had no `habits`
lookup at all; the upload route happened to be safe only because it looked the
habit up first.

Two things bounded it and neither excuses it: the extension is fixed by the
caller, so only `.png/.jpg/.gif/.webp` were ever reachable and the database never
was, and `/api/` requires a token. The guard is a `^[A-Za-z0-9-]{1,64}$` test
inside `imagePath` and `storedImage` rather than in the route, so a second caller
cannot reintroduce it.

`smoke` now fires both, plus backslash and mixed forms, and asserts an ordinary
id still reads its own picture — a guard that merely says no to everything is
not a fixed feature.

### Auth: this machine is trusted, everything else needs a token

Requests arriving from loopback are allowed without a token. Making you paste
a token into a browser on the same PC that runs the server protects nothing and
was the single biggest piece of friction in the app.

Loopback trust is guarded four ways. **The Host check is not optional** — see
below for why leaving it out handed the entire tailnet unauthenticated access:

- the **Host header must name loopback**. `tailscale serve` terminates TLS and
  proxies to `127.0.0.1`, so every tailnet caller arrives on a loopback socket.
  What a proxied request cannot fake is the name it asked for: it still carries
  `desktop-xxx.ts.net`, not `127.0.0.1`;
- any **forwarding header** (`X-Forwarded-*`, `Forwarded`) disqualifies it,
  since a direct call has none;
- the **raw socket address** is checked, never `request.ip`, which honours
  `X-Forwarded-For` when trustProxy is on;
- a cross-site **`Origin` or `Sec-Fetch-Site`** is refused, blocking a malicious
  page POSTing to 127.0.0.1 in the background, and DNS rebinding with it.

Local trust is also disabled outright when `TRUST_PROXY` is set, and CORS
defaults to same-origin only.

Testing this needs the *proxied* path specifically. Hitting the raw tailnet IP
(`http://100.x.y.z:8787`) arrives on a non-loopback socket and is correctly
refused whether or not the bug is present, so it proves nothing. The smoke suite
covers the proxy shapes directly.

Everything else — the phone over Tailscale — needs a bearer token, stored as a
SHA-256 hash. Tokens are minted in the app under **settings → Add a device**,
and that route rejects anything that isn't local, so a token stolen from the
phone still can't mint more. `npm run pair` remains as a CLI equivalent.
`/health` is the only fully public path.

**Revoking and removing are two steps, and `DELETE /api/devices/:id` refuses to
be the first one.** Revoking is the part that matters and is instant; the row
left behind is the *record* of it, and it is worth reading before it goes —
"phone, revoked, last seen three weeks ago" is how you notice you revoked the
wrong one. So the route 409s on a device that is still live. But a list that only
grows becomes a wall of struck-through names where four revoked "iPhone" entries
are indistinguishable, so the record can be closed once it has been read. Local
only, like minting, and the button asks first: it is the only irreversible thing
on that screen and it sits next to one that isn't.

### A held nudge is re-checked before it lands

The queue exists to wait for a good moment, so a nudge routinely sits for an
hour — and in that hour the thing it is about can be done. `"3 of 8 so far
today"` is baked in when a habit reminder is raised, and a match is plenty of
time to drink five more glasses. Delivering that afterwards is worse than
delivering nothing: it is *confidently wrong*, and the whole value of waiting
was spent saying something untrue.

`freshenForDelivery()` runs in the instant before a nudge goes out. It
recomputes the habit count, and drops anything whose reason has gone — a habit
finished while it waited, a habit paused, a task completed or dropped. Nothing
clears a queued nudge when the underlying row changes, deliberately, since the
queue is the record of what was asked for; so the check belongs at the one point
where it matters. Dropped ones are marked `expired`, which is exactly what
happened: unfired, not `acknowledged` (you never saw it) and not `dismissed`
(you never chose).

**The interval runs from `deliveredAt`, not `createdAt`**, and that is the
difference between a reminder and a queue. A nudge raised at ten and held
through a match until eleven has only just been *said*; spacing from when it was
written down made the next one due immediately, so a long session was rewarded
with two reminders in a minute. A nudge you never saw did not remind you, so an
undelivered one still counts from when it was raised — the fallback is doing
real work, not defending a null.

### Nudge policy

Defined once, in `shouldDeliver()` in `src/nudge-engine.ts`:

- `in-game` and `focused` never yield to quality alone; only a passed deadline breaks through.
- `away` yields to nothing at all — a toast fired at an empty chair is spent for nothing.
- A passed deadline escalates and is recorded as such, so ignored deadlines are visible later.
- Ignoring a nudge means "not now", so a delivered task backs off for
  `RENUDGE_COOLDOWN_MS` (45 min) instead of re-queueing. Without that the sweep
  re-nudges on every 2-second poll.
- **Going quiet outranks everything, including a passed deadline.** "Don't wake
  me up" has to mean it or it isn't a setting worth having.

### Phone push, and how "away" is decided

When you are genuinely away from the PC, nudges go to your phone instead of the
screen. Never both: a toast you're sitting in front of beats a buzz in your pocket.

`isAwayFromPc()` in `packages/shared` needs **both**:

1. no keyboard or mouse for 15 minutes, and
2. no sound played in the last 2 minutes.

The second condition is the whole point. Idle time cannot tell an empty chair
apart from a film — both look identical to the keyboard and need opposite
behaviour. `packages/agent/src/audio.ts` reads the WASAPI peak meter through COM
(vtables by hand via koffi; `powercfg /requests` needs admin and the audio
interfaces aren't automation-friendly, so nothing simpler exists). It costs
0.08ms a poll.

Sound is remembered for 2 minutes rather than sampled instantaneously, because
speech dips to near silence between words and a single sample can land in a gap.

Deliberately conservative: a missed phone nudge is a small loss, a phone buzzing
mid-film is exactly the badly-timed interruption this app exists to prevent.

### Not everything deserves a pocket

Each task and habit carries `push_to_phone`, and it has **three** states: yes,
no, and null — which follows `settings.push_default`. The Settings screen sets
the default; each editor overrides it.

**The null is the whole design, not laziness about a boolean.** Stamping every
new task with the default would look identical on the day it was made and
diverge silently forever after: change your mind about the default and
everything already on the list keeps answering the old question, with nothing on
screen to say why. `resolvePush()` in `shared` is the one place three states
become two, so the sweep, the API and the settings screen cannot disagree.

`pushDefault` is separate from `pushEnabled` because they answer different
questions — "does this install push at all" versus "of the things that could,
which do by default". Folding them together would make switching push off
indistinguishable from setting the default to no, and only one of those leaves
your per-item choices intact when you switch back.

**The answer is resolved when a nudge is raised, not when it is delivered.** The
nudge row carries its own copy: by then "undecided" has been decided, re-reading
the source row on every delivery pass would be work for nothing, and a nudge
whose task has since been deleted would have nothing left to inherit from.

A nudge that opted out is **skipped on the phone leg, never consumed** — nothing
marks it delivered, so it keeps waiting and toasts the moment you sit back down.
"Not worth a phone" and "not worth telling me" are different claims and only the
first is being made. The filter runs *before* the send, so a queue of desk-only
nudges cannot spend the ten-minute cooldown on a notification that was never
going out.

Other guards:

- **A 10-minute cooldown** between pushes, and several waiting nudges become one
  notification. Stepping out for an afternoon shouldn't mean a pocketful of
  buzzes on the way back.
- **Nothing is marked delivered until a push actually succeeds**, so with no
  phone subscribed the queue simply waits and toasts when you sit down.
- **Quiet hours and DND still apply** — away doesn't override asleep.
- Subscriptions the push service reports as dead (404/410) are cleared
  automatically.

VAPID keys are generated once into the `settings` row; only the public half is
ever sent to a browser. iOS only exposes push to a Home-Screen install over
HTTPS, which `checkPushSupport()` explains rather than failing silently.

**The VAPID `sub` claim must name a real-looking domain.** It is only a contact
for the push service, so `mailto:everything-app@localhost` looks harmless — but
Apple rejects it with `403 BadJwtToken` on every single send. Because it fails
identically every time, it presents as "push doesn't work" rather than "one
claim is malformed". `VAPID_SUBJECT` is validated in `config.ts` and refuses
localhost outright.

Two things made that bug expensive to find, both now fixed:

- **Push failures were swallowed.** A failed send must not fail the agent's
  heartbeat, but it must still be logged, or `pushed: 0` is undiagnosable.
- **`audioPlaying` wasn't recorded.** With only idle time in the sample log,
  "you were idle 52 minutes and nothing pushed" could not be answered after the
  fact. Samples now carry `audioPlaying` and `awayFromPc`, and a change in
  either forces a row.

`npm run push-test -w @everything/server` sends to every subscribed device and
prints the push service's response verbatim. `--subject <uri>` tries an
alternative `sub` without changing config.

### Three ways to go quiet, because one schedule doesn't fit

`quietReason()` in `packages/shared` is the single decision, so the server, the
phone and the settings screen can't disagree about *why* it's silent:

| Method | For |
| --- | --- |
| **Follow Windows Do Not Disturb** (default on) | An irregular sleep pattern. It's a switch flipped when you actually turn in, not at a predicted hour. Costs nothing — the agent already reads `SHQueryUserNotificationState`. |
| **Manual pause** (`dndUntil`) | One-offs: an early night, a nap. |
| **Quiet hours** (off by default) | A settled routine. Minutes since local midnight; start > end wraps past midnight. |

`quietHoursEnabled` is a real flag, **not** `start == end`. Using the times as
their own off-switch meant turning quiet hours off destroyed them and left
nothing to turn back on.

Windows' DND is live state, so the server keeps the agent's last report in
memory (`currentWindowsDnd`) rather than deriving it from the sample log —
samples are coalesced and couldn't answer "is it on right now" anyway.

### Three kinds of habit, differing in one question

`habits.mode` is `target`, `interval` or `gauge`, and they differ in **when does
this want doing** and nothing else. Entries, reminders, voice phrases, push
choices and the nudge queue are identical across all three, which is why this is
a column rather than three tables — and why adding a fourth mode means answering
that one question again and nothing more.

| mode | wants doing when | nag spacing |
| --- | --- | --- |
| `target` | done this period < target | `reminderEveryMinutes`, null to never interrupt |
| `interval` | `intervalMinutes` since the last tick | `reminderEveryMinutes` ?? `intervalMinutes` |
| `gauge` | the level is at or below `gaugeRemindAt` | `reminderEveryMinutes`, null to never interrupt |

`habitWantsDoing()` in `shared` is the one place that table lives, so the sweep,
the API and the screens cannot disagree — the same role `resolvePush` and
`quietReason` play for their own decisions. `freshenForDelivery` calls it too,
which is what stops a nudge raised an hour ago being delivered about a gauge you
topped up during the match.

**`interval` falls back to its own interval for nag spacing**, so "water the
plants every four days" is one number rather than two. Setting both is for the
case that genuinely wants them: due every four days, and once it *is* due, say so
every couple of hours. That fallback is also why the sweep now selects every
active habit rather than filtering on `reminder_every_minutes IS NOT NULL` — that
filter would have made the one mode it exists for permanently silent.

**`met` and `wantsDoing` are two questions, and collapsing them was a mistake.**
`met` was widened to mean "nothing wanted right now" on the reasoning that one
word could serve the screens and the engine alike. It cannot. The two are the
same question for a counted habit — hitting the target answers both — and they
come apart for the other two modes. The symptom was reported from the Dashboard:
a water gauge at 20% sitting under **Finished today**, a heading claiming you
were done with something visibly draining.

So `habitIsFinished()` sits beside `habitWantsDoing()` in `shared`:

| mode | finished when | wants doing when |
| --- | --- | --- |
| `target` | the target is met | the target is not met |
| `interval` | done *today* **and** not due again | the interval has elapsed |
| `gauge` | **never** | the level is at or below `gaugeRemindAt` |

A gauge is draining the moment it is full, so there is no instant at which it is
finished — which is why a full one still belongs in the list rather than under a
heading saying otherwise. The engine asks `habitWantsDoing`; every screen asks
`met`. Both halves of the `interval` rule are load-bearing: without "done today"
one ticked off last Tuesday reads as finished all week, and without "not due
again" a four-hour habit done at nine still reads as finished at two.

A gauge is also excluded from the **settling** animation, which exists to pin a
row in place before it drops to *Finished today*. A gauge never drops, so there
is no movement to cushion.

### The gauge stores a level, and that is the whole design

Two columns: `gauge_level` and `gauge_level_at` — a level, and the moment that
level was true. Everything in between is computed by `gaugeLevelAt()` in
`shared`. **Nothing runs on a timer**, which this project demands of anything
that would otherwise tick, and the database is written once per action rather
than once per minute.

The obvious alternative is deriving the level from the last tick — full minus
the time since you last did it — and it cannot express the two things a gauge is
*for*: one topped up twice in a morning, and one neglected for a fortnight and
then filled halfway. Both have the same last tick and different levels.

- **Filling tops up from the current level rather than jumping to full**, which
  is what makes a partial fill mean anything: at 25% a tick, four glasses of
  water refill it from empty.
- **Undo is not a true inverse and cannot be.** Filling clamps at 100, so a tick
  that would have taken it to 130 loses the overflow and there is nothing left
  to give back. Storing the overflow would mean a level that reads 100 and
  secretly holds 130, which is a worse lie than an imperfect undo.
- **A backwards clock must not refill it.** A resumed laptop or a corrected
  timezone gives a negative elapsed time, and draining by a negative amount
  fills. Clamped at the stored level.
- **The level is resolved on the server**, not in the browser, though it is one
  subtraction. In the browser it would depend on the *device's* clock, and a
  phone a few minutes out would draw a different gauge from the PC — which is
  the same reason the theme is stored server-side.
- **Switching a habit into gauge mode re-anchors it.** A habit that has been
  `target` for a year has never had an anchor written, so its `gauge_level_at`
  is the migration's 0 — the epoch — and it would compute as bone empty the
  instant you changed modes. Only on the transition, so editing the drain rate
  of a half-empty gauge does not secretly refill it.

**Undo on a gauge is not gated on there being an entry in this period**, and
that was a real bug rather than a hypothetical. For a counted habit "nothing to
undo" is a true statement about today; for a gauge the level *is* the state and
it was very likely last filled yesterday. The early return left the − button
working exactly once and then silently doing nothing — found by pressing it
three times and watching the level stop at 75%. The Habits screen's stepper had
the matching bug: it disabled − on `doneThisPeriod` and showed the number of
top-ups today where the level belonged.

### Recording a completion is one function, and briefly was two

`recordHabitDone()` in `routes/habits.ts` is the only thing that writes a habit
entry, and `undoHabitDone()` the only thing that removes one. The voice feature
had its own copy — it inserted the entry and counted the period up by hand —
which was *identical* to the HTTP route right until gauge mode arrived. The fill
went into the route, so saying "I drank water" logged an entry and left the
gauge exactly where it was. Reported as the voice command not working, and it
had not: it had done half the write, silently.

The spoken reply came back from the same place for the same reason. It was
hard-coded to `${name} — ${done} of ${target}`, which for a gauge is a sentence
about a target it does not have; it now says "Drink water — 56% full".

A spoken count fills that many times, so "I drank two waters" is two ticks.

### "To max" fills it, without you knowing the number

`spokenAmount()` reads `max`, `maximum` or `full` out of a transcript, the way
`spokenCount` reads "two". It exists because **for a gauge you rarely know the
number**: six glasses refills a 16%-a-glass gauge from empty and four does it
from a third, and working that out in your head is exactly the arithmetic saying
it aloud is meant to avoid.

`ticksFor()` turns it into a count, and it is a different one per mode — which
is why the *habit* resolves it and not the caller:

| mode | "to max" is |
| --- | --- |
| `gauge` | however many top-ups reach full from where it is now |
| `target` | whatever is left of the target |
| `interval` | one — there is no more done than done |

Never zero. A full gauge asked to max still records a tick, because a command
that answers "done" having written nothing is indistinguishable from one that
failed.

The three words go in `ALWAYS_IN_VOCABULARY`, on the same bargain the counting
words struck: a closed grammar can only emit what it contains, so without them
"drink water to max" comes back with the "max" replaced by whatever sounded
nearest — reading for a word the recogniser was never allowed to say. They are
kept to three for the opposite reason: each one is another thing an unrelated
noise can become. **"all the way" was the obvious fourth and is not here**, since
it would put "all" and "way" permanently into the vocabulary to save two
characters over "max".

In a chain, the amount is read from the *segment* rather than the sentence, so
"water to max and one coffee" maxes only the first.

### It asks before it is empty, and says when it will

`gauge_remind_at` is the level at which it starts asking. **0 is the default and
is exactly the old behaviour** — ask when there is nothing left — which is right
for a glass of water and wrong for anything you need warning about: a plant set
that way reminds you once it is already dead. Capped at 90, because a threshold
of 100 is not a reminder, it is the absence of one.

The Dashboard row therefore carries **two countdowns**, and they answer different
questions: *reminds in 3 hours · empty in 7 hours*. At a threshold of 0 they are
the same instant, so only one is shown — two identical times side by side read as
a bug rather than as thoroughness. Below the line it says *needs doing* in place
of the first.

`gaugeReachesInMs()` computes both, and `gaugeEmptyInMs()` is now just the
`level: 0` case of it. Neither schedules anything: they are arithmetic done when
somebody is looking, which is what keeps a gauge free of timers. A gauge with no
drain returns `null` rather than 0 — a countdown to a moment that is not coming
would be worse than no countdown.

The raised nudge says *"down to 20% — it drains 200% a day"* rather than
"empty", since with a threshold it very often is not.

### Drawn, not a progress bar

`Gauge.tsx` renders four shapes as SVG with the fill clipped to the path, so a
triangle empties to a point and a circle to a lens. A bar would have been three
lines of CSS; the reason for a shape is that it is read *without* being looked
at, which is the same argument the whole app runs on.

**Any emoji works too**, which covers "a picture that empties" for most habits
at no cost at all — the same decision the overlay avatar made, and the same
reasoning that has the app icons generated rather than committed. An emoji cannot
be clipped by an SVG path, so it is drawn twice: once greyed as the empty part,
once inside a wrapper with a height and `overflow: hidden` on top. `gauge_shape`
is therefore **opaque** — validated for length, not against the list of four —
and anything unrecognised is drawn as text.

**And a picture of your own**, uploaded per habit. `gauge_shape` is set to
`image`, a sentinel rather than a separate boolean, because the two are exclusive
and a flag beside a shape would allow "custom picture *and* triangle" — the app
logo settled the same question the same way. The file lives in `data/` beside the
database rather than in it, since a habits list is fetched on every page load and
has no business carrying a JPEG.

Three things there are worth knowing:

- **It is under `/api/`, unlike the icons and the tones**, and the difference is
  what it carries. Those are a colour and a sine wave, fetched by machinery that
  will never send a bearer token. This is a picture you uploaded, personal in the
  way the rest of the database is — so it stays behind auth, and since `<img
  src>` sends no token either, the PWA fetches the bytes and wraps them in an
  object URL. Cached by `id:updatedAt`, which the upload route bumps.
- **Not local-only**, unlike the app logo. That restriction exists because a logo
  is a property of *this machine's* installation; a habit is your data, editable
  from the phone like everything else about it.
- **Deleting a habit deletes its file.** Nothing cascades to a file, so without
  that every removed gauge would leave a JPEG in `data/` for good.

**The editor says what the numbers mean, in the unit that fits.** Two
percentages are two abstractions: "empties by 200% a day" and "each tick adds
40%" are both true and neither is the thing you want to know, which is that it
means about five glasses a day. So the drain reports how long a full gauge lasts
— `spanLabel` switching between minutes, hours and days rather than reporting
"0.3 days" or "20.0 days" — and the fill reports the rhythm the two imply,
flipping from "about 5 a day to keep up" to "one every 4 days" at the crossover.
That is the number you can hold against your actual life and decide the settings
are wrong.

The gauge follows `var(--accent)`, unlike the presence dots which deliberately
do not. Nothing is learned about a gauge's colour, whereas green meaning online
is learned from every other chat client on the machine.

**The gauge is the button.** A tick box beside it would raise the question of
what the tick did that the shape did not, and the answer would be "nothing" —
topping it up is the only thing you can do to a gauge. It is never struck
through either: struck means finished, and a full gauge is already draining
again.

### Recurring habit reminders expire — they never stack

A habit can carry `reminderEveryMinutes` ("drink water, every 2 hours"). The
sweep raises at most one live nudge per habit and stamps it with
`expiresAt = now + interval`.

That expiry is what makes "hold everything while gaming" survivable. Holding
alone would mean a three-hour session ends in six identical water reminders —
technically a correct queue and practically worse than silence. A missed
periodic reminder is simply missed.

Verified by simulating a two-hour session with a 30-minute reminder: four
raised, none delivered mid-game, **exactly one** delivered at the stopping
point, and an empty queue afterwards.

Habit reminders are `minQuality: 'any'` and never carry a deadline, so they can
never break into a match.

Note for tests: quiet hours default to 23:00–07:30, so anything asserting
delivery must switch them off first or it passes or fails by time of day.

## Notes

A linked notebook rather than a list of text blobs.
`npm run notes-check -w @everything/server` proves the text model — the parser,
the link and tag extraction, the folder rules and the date reader — with no
database and no network. Run it before trusting a change to any of them.

**One parser, three renderers.** `packages/shared/src/notes.ts` turns Markdown
into blocks; the screen, the PDF and the `.docx` all render *that*. The
alternative is three readings of the same text that drift, and the drift is
invisible until somebody opens an export and finds a table missing. It has **no
imports at all** — which is what lets the PWA use it, since the rule is that the
PWA never pulls in `@everything/shared`'s entry point and its zod.

### Links are the feature

`[[Wiki-links]]` in Obsidian's syntax, deliberately, because that is what makes
the export a real vault rather than an approximation of one.

**A link is matched on a key, not on the text.** `noteKey()` folds case and
punctuation, so `[[reading LIST]]` finds "Reading list". Storing that key on the
row rather than computing it per query is what makes the backlink lookup an
index scan instead of a walk over every note.

**A backlink is quoted with its line.** "Three notes link here" is nearly
useless; the line the link sits in says *why*. That cost one real bug worth
keeping: `contextAround` first searched the **rendered** text for the link — and
rendering a wiki-link into its label is exactly what removes it, so every
context came back empty. It searches the raw line and renders that line.

**A link to a note that does not exist still works**, drawn dashed, and clicking
it creates the note. They are listed under **not written yet**, which is the
notebook telling you what it is missing — the one thing a plain list of notes
can never do.

**Tags are read out of the body, never stored beside it.** A second copy is a
second thing to keep in step, and the first edit that bypassed the writer would
desynchronise it silently. `extractTags` skips headings, URL fragments, bare
numbers and code, all of which contain a `#` and none of which is a tag.

**Reindexing is delete-then-rewrite, never a diff.** A note's links and tags are
derived entirely from its body, so the body is the authority and a diff is an
opportunity to disagree with it. `reindexNote` is the only writer.

### The editor is one box

Obsidian's split view is the thing most people turn off first: two copies of one
note competing for the width, with the cursor in one and your eyes in the other.
Here the note is rendered until you click into it, and what you type in is the
raw Markdown. One column, and the switch is clicking the thing you want to
change.

**The renderer builds React elements and never `dangerouslySetInnerHTML`.** A
note can arrive by dropping a stranger's Evernote export into the app, so its
body is genuinely untrusted input — and this app's one reflected-XSS hole was
found in the one place that assembles HTML by hand. A Markdown renderer emitting
a string would be the second, over a far wider input. The one hole that survives
building elements is the `href`, since React will set it to anything, so a link
is restricted to `http:`, `https:`, `mailto:` and same-origin — the same rule
voice commands follow. A refused link is **shown with its address** rather than
dropped, because a link that vanishes looks like the renderer losing content.

**A task checkbox is read-only.** Ticking it would have to write back into the
Markdown by position, and a body edited from two places at once is how a note
loses a paragraph. The box is a picture of the text.

**Opening a note must not write it.** The autosave keeps a signature of the last
thing written so an unchanged draft is never sent — and that ref started *empty*,
so the first debounce fired 700ms after opening a note and saved it unchanged.
That bumps `updatedAt`, and the list is sorted by it, so reading a note shuffled
it to the top. It is seeded from what was loaded now. A notebook that rearranges
itself as you browse it is worse than one that saves a little late.

### The graph

Hand-drawn SVG, like `Gauge.tsx` and the weather chart, for the same reason: a
graph library would be the largest dependency in this repo, to draw circles and
straight lines.

**The layout is seeded from each note's id**, not from `Math.random`. A force
simulation seeded randomly draws a different picture every time the tab is
opened — and recognising the shape you saw yesterday is most of what a graph
view is *for*. It runs to completion once rather than animating, since a
simulation ticking behind a tab is exactly the sort of timer this project
measures before adding.

Only connected notes are labelled; two hundred labels is a grey rectangle. An
unlinked note is drawn **hollow** rather than in another colour — the same
distinction the `unknown` presence dot draws, and for the same reason: a filled
shape in a second colour reads as a *kind* of note rather than one with no
connections.

### Attachments

Dropped or pasted straight into the body. The allow-list is in `files.ts` and
**SVG is deliberately not on it**: an SVG is a document that can carry script,
so it is not an image for this purpose.

They sit behind `/api/` like the habit pictures and for the same reason — they
are your data, unlike the icons and the tones — so an `<img src>` cannot fetch
one, and the bytes are fetched with the token and wrapped in an object URL.
Revoked on unmount, or every render of a note with pictures leaks one per image.

### Fourteen ways in, six ways out

**The format is detected from the contents, not chosen from a dropdown.** Asking
somebody which of fourteen formats their export is asks them the one thing they
are least sure about, and the answer is sitting in the file.

Reads: Obsidian vaults, Notion, Evernote `.enex`, Google Keep, Roam, Logseq,
Joplin `.jex`, Bear, Standard Notes, Apple Notes, Markdown, Word, CSV and plain
text. Writes: an Obsidian vault, Markdown, plain text, CSV, PDF and Word.

**Two-phase, exactly like the vault's password import.** The first call reports
what it found and writes nothing, because a mis-detected format produces a
plausible number of plausible-looking rows and a wrong guess should cost a click
rather than a thousand notes. Imports land in a folder you name: a folder can be
taken apart afterwards and a merge into an existing notebook cannot.

**No new dependencies.** The PDF writer, the `.docx` writer and the zip *writer*
are hand-rolled, the same call `zip.ts`, `icon.ts` and the WAV writer already
made. Three details that cost something to get right:

- **The PDF is assembled as `latin1`, and that is load-bearing.** Every `xref`
  offset is a byte count, so encoding the same string as UTF-8 shifts every
  offset past the first non-ASCII character and produces a file that opens as
  corrupt. It carries real Helvetica AFM widths rather than a fixed pitch,
  because a PDF with no embedded font and guessed widths is a page of overlapping
  words.
- **The `.docx` uses direct formatting and no `styles.xml`.** A document
  referring to a style it does not define is what triggers Word's "repair the
  file" dialog — which reads as the export being broken, whatever it then
  recovers.
- **Filename collisions are resolved case-insensitively.** Two notes called
  "Home" and "home" are two files on Linux and one on Windows, and the second
  silently replacing the first is data loss inside a backup.

**The vault export is a real Obsidian vault.** Unzip it into Obsidian and the
links work, because they were Obsidian's syntax the whole time. Verified by
round-tripping one back in.

**What each format loses is on screen before you pick it.** PDF and Word flatten
links, CSV and plain text flatten formatting too, and the PDF can only draw
Latin alphabets — an emoji comes out as a question mark. Discovering that on
opening the file is worse than reading it next to the button.

### It takes the window, and that is the second exception to 720px

`.app` is 720px because that is a comfortable measure for a **task list** — one
column of short lines. Notes is three columns and one of them is a document, and
inside 720px that document column measured **172px at a 1280px window**: a
Markdown editor about twenty characters wide. The reading-width rule was right
about the screen it was written for and wrong about this one.

`.app:has(.notes)` lifts it, the same way `.app:has(.dash.has-panel)` already
does for the Dashboard's second column — `:has()` rather than a class threaded
down from `App`, because `App` does not read which screen wants what width and
the child already knows. Where `:has()` is unsupported the page stays at 720px
with the columns stacked, which is the phone layout, so the fallback is real.

**There is no replacement cap, and that is the part worth arguing for.** A
larger fixed number is still a fixed number: 1700px on a 3440px monitor leaves
1500px of nothing, which is the same complaint one step further out. So the
container is uncapped and the columns are `clamp`ed instead — a folder tree and
a list of titles each want *some* of a wide window and neither should take a
third of it, so they grow and stop, and everything left goes to the note.

**What stops the prose sprawling is a measure on the text, not a narrow page.**
`.md-p`, `.md-h`, `.md-list` and `.md-quote` cap at 90ch; tables, code blocks,
rules and images are shapes rather than sentences and take the whole column. 90
rather than the classical 70 because this only has to stop an ultrawide — a cap
that bit on an ordinary monitor would be the narrowness arriving by a different
route. At 1280px it does not bind at all.

**The box you type in gets no measure.** Reading prose wants a short line;
editing Markdown wants a table row, a long URL and a `[[link]]` not to wrap,
since a wrapped table stops looking like a table. Measured: 172px → 505px at
1280, 976px at 2560.

#### The backlinks move beside the note when there is room

A wide window gave the note a column far wider than its prose wants, so reading
one left several hundred pixels blank down the right while the backlinks sat
underneath — off the bottom of a long note, which is the half of the notebook
you are least likely to scroll to and the half most worth seeing.

**A container query, not a media query.** What decides whether they fit is the
width of *that card*, which opening the drawer changes without the window moving
at all; asking the viewport would put the rail back while the drawer squeezed
the card. It is also pure CSS, so it works where `ResizeObserver` does not —
worth knowing given that the weather graph needs three separate ways to measure
itself for exactly that reason.

**`has-rail` is a real class rather than letting an empty track collapse.** A
grid gap is drawn between tracks whether or not the second holds anything, so a
note with no links would carry a stray column of padding. `hasNoteLinks()` is
the single statement of the condition, asked once by the layout and once by the
panel that returns null on it.

#### New is a menu, and folders can exist while empty

**New** offers *Note* or *Folder*, from a table rather than two buttons, because
that is the list which grows — a template, a note from the clipboard, a daily
note are all the same shape and each is one entry rather than another control
competing for the same corner. It reuses the right-click menu's own component:
the measuring, the clamping to the viewport and the six ways it dismisses are
the fiddly parts, and a second copy is a second one to keep right. Only where it
opens differs, so `useButtonMenu` sits beside `useContextMenu` in the same file.

**"New folder" needed somewhere to put the answer.** A folder was a path prefix
on notes and nothing else — a good model, since it needs no maintenance, cannot
disagree with where the notes actually are, and moves with one prefix rewrite.
What it cannot do is hold *nothing*, so an empty folder could not exist at all.

`note_folders` is the smallest fix: a list of paths made by hand, which
`folderTree` unions with the derived ones at a count of zero. A folder that
appears because a note is filed there still needs no row, and the two cannot
contradict each other because **the derived side always wins on counts** —
`counts.has` rather than `counts.set`, so a declared folder that has since been
filled shows its real number.

Three consequences worth knowing:

- **Its ancestors are declared too.** A folder at `a/b/c` implies `a` and `a/b`,
  and without them the tree renders a child indented under a parent that is not
  there.
- **The declarations move with the notes.** `moveDeclaredFolders` runs inside the
  rename route, or moving an empty folder would appear to do nothing and moving
  a full one would leave a ghost at the old path.
- **The declarations move with the notes.** `moveDeclaredFolders` runs inside
  the rename route, or moving an empty folder would appear to do nothing.

**The name is typed in the tree, not in a `prompt`.** A modal dialogue sits in
front of the thing you are adding to, so you cannot see where the folder is
going while you name it. The field appears indented in the place the row will
be, which is what every file manager does and says where it is landing without
needing a sentence to explain it. **Enter commits and the blur is the fallback**
— the ordering the habit stepper had to learn, because a document that is not
focused dispatches no `blur` at all — with a `committed` ref so pressing Enter,
which blurs an instant later, does not fire both.

#### "Delete folder" means two things, so it offers both

The first version disabled *Remove* on a folder with notes in it and labelled it
*"Remove — 3 inside"*. That reads as a menu refusing to do the thing you opened
it for, and it was solving the wrong problem: the action is not impossible, it
is **ambiguous**. Deleting a folder can mean *throw away what is in it* or *get
rid of the grouping*, and only one of those can be undone.

So nothing is greyed. An empty folder offers **Delete folder**. One with
something in it offers both, named for what each actually does:

- **Keep the N notes, remove the folder** — the rename primitive again, `a/b`
  into `a`, so the notes move up a level in one prefix rewrite and nothing is
  touched note by note.
- **Delete folder and N notes** — in the warning colour, and it asks first,
  because there is no trash here. `notes=delete` on the route is the caller
  stating which reading it meant; without it the endpoint still refuses and says
  how many are in the way, so the destructive path is reachable only on purpose.

Verified end to end: declining the confirmation left the note untouched,
accepting removed folder and note together, and *Keep the notes* left the note
alive one level up with the folder gone.

#### "Not in a folder" was showing every note

Reported, and it was one branch. Every other folder shows what is *under* it,
which is right — a tree where clicking a parent shows nothing because everything
sits one level down reads as broken. The root is the exception, because
everything is under the root.

The empty case pushed `undefined` into the condition list, `filter(Boolean)`
dropped it, and the query went out with **no folder condition at all**. So the
two entries in the tree rendered identical lists, and the one that answers "what
have I not filed yet" was the one that broke. The root now means notes whose
folder *is* the root; "All notes" is the separate question, asked by sending no
folder at all. Smoke asserts the root is both non-empty and smaller than the
whole list, since either alone would pass on an empty notebook.

#### Branches fold, and stay folded

An arrow beside any folder that has something inside it, and **only** those —
a leaf gets a spacer of the same width instead, so names line up down the tree
rather than jogging left and right depending on whether a folder has children.

**The arrow is set larger than the row's type so that it *paints* the same size
as a `<` or `>` beside it**, and matching the font-size alone does not achieve
that. A geometric shape carries far less ink than punctuation at the same em:
measured in the app's own font at 13.76px, `>` paints 8×7 while `▸` paints 6×5,
about a quarter smaller. At 1.2rem the triangle paints 8×7 — the same. Worth
knowing before "just make it the same font-size" looks like the obvious fix.

**Collapsing hides every descendant, not only the children.** Shutting `a` has
to take `a/b/c` with it; testing the parent alone would leave grandchildren on
screen under a folder that is visibly not showing its own children, which reads
as the tree being broken rather than folded.

**Remembered in `localStorage`**, matching the voice command groups and for the
reason they give: reopening them every visit is a chore. Deliberately *not* in
`settings` beside the theme — this is a view preference about one screen on one
device, and a tree you folded up on the phone should not fold up on the PC where
there is room for it.

**A folder row is now two controls, not one button.** The twist folds the branch
and the name opens the folder, and a button inside a button is not something a
browser will render. The drop target and the drag handle moved out to the row
with them, so the whole width still takes a note and the whole width can still
be picked up — including the arrow, which would otherwise be a dead strip down
the side of the tree. Verified after the restructure that selecting, dropping
and the drop highlight all still work.

#### The folders inside the one you are in, among the notes

Standing in a folder, the list leads with the folders directly inside it and
then the notes — folders first, as every file manager orders them, because they
are the smaller group and the one you are scanning for when navigating rather
than reading.

**They deliberately do not look like notes.** A note row is a `.card`: padded,
on `--surface`, with a title, two clamped lines of preview and a date. A folder
has none of those, so it is a single short line on `--surface-raised` with a
glyph, a count and a chevron pointing inwards — 40px against 77px, and a
different background. A place you go into should not look like a thing you open
and read, or the only way to tell them apart is to click one and find out.

**One level, not every descendant.** This is where you are standing, not a
summary of everything beneath you; the sidebar is where the whole tree lives.

**"Not in a folder" gets them too, and "All notes" does not.** The root is a
real place, so it lists the top-level folders and the notes filed nowhere —
which is what a file manager shows when you open a drive. "All notes" is a flat
view of everything and has no inside. A search hides them for the same reason:
you are looking across the whole notebook, and a folder row would answer a
question you did not ask.

That distinction matters most where the sidebar is not there. **On a phone the
tree is off-screen**, so these rows are the only way down into the notebook
rather than a duplicate of something already visible — which also makes this the
first piece of folder navigation that works on touch at all.

They are drop targets and drag sources like the tree's rows, and carry the same
right-click menu, because they are the same folder seen twice. `useFolderDnd`
holds the handlers once for both; each column keeps its own `over`, so they
highlight independently rather than lighting up together.

#### Dragging notes and folders about

A note dragged onto a folder is filed there; a folder dragged onto another moves
with everything under it; and either dropped on **Not in a folder** comes back
out. "All notes" is deliberately *not* a target — it is a filter rather than a
place, and accepting a drop there would have to silently pick a folder.

**Moving a folder needed no new endpoint.** A folder here is a path prefix on
notes rather than a row of its own, so moving `a/b` into `c` is renaming that
prefix to `c/b` and every note underneath follows in one update. The rename
route already existed for exactly that arithmetic.

**The rules live in `shared` and both ends read them.** `canMoveFolder` refuses
four things, and the third is the one that matters: **a folder cannot go inside
its own descendant.** That would rewrite every path under it to a prefix that is
itself about to move — which does not error, it silently mangles the tree. The
fourth refusal is the no-op of dropping something where it already is, refused
so the target never lights up rather than accepting a drop that changes nothing,
which reads as the drag having failed.

**`preventDefault` on `dragover` is the whole mechanism**, and calling it only
for a legal move is what makes an illegal one show the browser's own "no entry"
cursor with no styling required to say so.

**The decision comes from a ref and the highlight from state, and that split is
not tidiness.** `setDragging` in `dragstart` does not reach the handlers until
React re-renders, and `dragover` can arrive in the same frame — which read
`null`, refused to `preventDefault`, and made the first pass over a folder
silently not a target. `useEdgeDrawer` documents this identical trap in the same
words. It showed up here as `accepted: false` on a synthetic drag and would have
shown up in real use as a drag that needed jiggling before it took.

`dataTransfer` cannot answer this instead: a page may only read what is being
dragged when it is **dropped**, so that a page cannot snoop on a file you drag
past it. It still carries a plain text label, because Firefox will not begin a
drag with nothing set and a title is the honest thing to hand any other app.

**This is mouse-only, and that is a real gap rather than an oversight.** HTML5
drag and drop does not exist on iOS, so on the phone a note is still moved by
typing a path into the folder box on its editor, and a folder cannot be moved at
all. That is not a regression — folders had no UI of any kind before this — but
it is the half still missing, and a "move to…" picker is what would close it.

Verified against the running app with probe notes rather than real ones, then
deleted: a note into a folder and back out to the root, a folder with a nested
child into a sibling (`zzprobe/from` → `zzprobe/to/from`, child following as
`zzprobe/to/from/deeper`) and back out to the root, and all three refusals
leaving the tree byte-identical.

#### Whether three columns fit is asked of the columns, not of the window

This was a `max-width: 1100px` media query, and it stopped being able to answer
its own question the moment the menu's width became a setting. A media query
asks the *window*; what decides whether three columns fit is the space they
actually have, and the menu is 260px of that. At a 1250px window with the menu
docked the notes screen has 990px and the viewport query cheerfully kept three
columns in it — then collapsing the menu handed back 260px and nothing changed,
because nothing in the query could see it.

So `.notes` is a query container and the rule is `@container`. Measured at one
fixed 1150px window: menu docked, the screen is **851px and stacks to one
column**; menu collapsed, it is **1126px and lays out three** (170 / 248 / 684).
No media query can tell those two apart.

**Both containers are named, and that is load-bearing rather than tidy.**
`.notes-note` is already a container for the backlinks rail, and the Back button
sits inside it — so an unnamed `@container` would resolve against the nearest
one, which is the note card, and hide the button whenever the *card* was wide.
On a phone with a note open the card is the full width, which is exactly when
the button is the only way out. `notes-screen` and `notes-card` say which
question is being asked.

**The tracks are `cqi` rather than `vw`** for the same reason: a percentage of
the notes screen, so docking the menu narrows them instead of leaving them sized
for room they no longer have.

**The number changed with the unit, from 1100 to 900, and had to.** The old
figure had the menu's width baked into it — it could not see the menu, so it
compensated. 900 is what the columns genuinely need: 170 for the sidebar, 240
for the list, 24 of gaps, and something worth having left for the note.

Container queries are Chrome 105 and Safari 16, both below this app's existing
floor of iOS 16.4 for web push, so unlike the `:has()` rules there is no older
browser here to keep a fallback for.

**One thing this turned up and did not change.** The sidebar is `position:
sticky` and, in a notebook of half a dozen short notes, it is the tallest column
— so the grid is exactly its height and sticky has nowhere to travel. That reads
as broken and is not: with a long note open it pins at its `top` as intended,
verified by scrolling 600px and watching it hold at 8px. Confirmed it predates
the container work by toggling `container-type` off at runtime and measuring the
same result both ways.

#### On a phone a note is a place you go, not a row that grows

Stacked into one column, an open note sat below the sidebar *and* the whole
list, so tapping one scrolled you to the foot of the page to find it.

The alternative was expanding it inline under the row you tapped, accordion
style, and that is right for a preview and wrong for a document: the thing being
opened is a full-screen editor with a title, a folder, a Markdown box and a
backlinks panel, and putting one inside a list leaves it wearing the list's
width with the rest of the list still above and below it. Every notes app on a
phone uses a detail view, and the reason is the same one.

So below the breakpoint the sidebar and the list are taken off screen and the
note has the width, with a **‹ Back** button that exists only there — above it
the list never left, so there is nowhere to go back to and the control would
close a note for no visible reason.

**`display: none`, not unmounting.** Going back is instant and the list returns
with its scroll position and its search box exactly as they were. React keeps
the state; CSS decides what is shown. The class is `has-open` on the layout,
which is state React already had.

#### And the editor header is one row

Title, folder, then Edit and Delete. It was two rows of one field each, which
paired Edit with the title and Delete with the folder — reading as though each
button acted on the box beside it, with a destructive button sitting against a
text field. The buttons wrap as a group, so a narrow column never drops Delete
onto a line of its own underneath the folder box.

### The screen is fetched, not bundled

Notes is **the one core view behind `lazy`**. Every other one is a few kilobytes
of form controls; this one carries a parser, a renderer, a graph and the
transfer UI, and it put **8KB gzipped into the eager bundle** — on a bundle whose
whole argument is that it is 92KB and almost entirely React. That is the 9.5KB
the friends panel nearly cost, arriving by a different door.

It takes the shape a feature's screen already has: its own chunk, its own
Suspense boundary, fetched the first time the tab is opened. Measured: 92.6KB
before any of this, 100.4KB bundled, **93.3KB** fetched, with the screen itself
7.8KB gzipped and only when opened.

### Two smaller things

- **`saveNote` is exported from `module-api`**, because the voice feature's
  `note` command and the HTTP route must write a note the same way. The habit
  path learned this the expensive way: voice had its own copy of "record a
  completion", identical to the route until gauge mode arrived, and then
  silently did half the write.
- **The list carries a `preview`, never the body.** A notes list is fetched on
  every visit and on the Dashboard panel, and a notebook of long notes would send
  the whole thing to draw two clamped lines.

## Password vault

`npm run vault-check -w @everything/server` proves the cryptography. Run it
before trusting any change to `src/features/vault/`.

**No crypto dependencies.** Argon2id and AES-256-GCM both come from Node's
built-in `crypto`, which is OpenSSL. Node 24 exposes Argon2 directly, so there
is no WASM build, no native module, and no JavaScript cipher implementation
anywhere near the passwords. (`kdbxweb` would have given KeePass-format support,
but it depends on a `@xmldom/xmldom` with five high-severity advisories that npm
refused to override — and the format was not needed.)

### Envelope encryption

```
master password ──Argon2id(salt)──► passwordKey ──┐
                                                  ├─► unwraps vaultKey
recovery code ────HKDF-SHA256─────► recoveryKey ──┘

vaultKey ──AES-256-GCM──► every item
```

Items are encrypted with a random `vaultKey`; that key is *wrapped* separately
by each way of unlocking it — the same design 1Password and Bitwarden use.
Changing the master password or adding a recovery method re-wraps 32 bytes
rather than re-encrypting the vault.

Argon2id runs at m=256MiB, t=3, p=1 — far above the OWASP floor of 19MiB/t=2,
measured at ~680ms here. A vault is unlocked rarely and the attacker pays that
cost on every guess. Memory is what defeats GPU and ASIC cracking, so it is
preferred over passes.

The recovery code uses HKDF, not Argon2: it is 256 random bits, so there is no
dictionary to slow down.

### The recovery kit screen must outrank everything

`Vault.tsx` holds the freshly generated shares in the *parent*, not in the setup
form. Creating a vault broadcasts a change; every loader refetches; the parent
then sees `configured: true` and would re-render straight past the shares into
the unlocked vault — unmounting the only screen those codes will ever appear on.

That is not hypothetical. It happened on the first real run, and the kit was
gone: `hasRecovery: true` with nothing ever displayed. Anything that can
navigate away from that screen destroys the kit, so it is rendered above the
status check and gated on an explicit tick rather than a button.

### Split recovery

`splitSecret` is a one-time pad — share A is random, share B is the code XORed
with it. Either share alone carries *literally no information* about the code,
not merely "is hard to break", so one can live in Google Password Manager and
one on paper. Both are needed; losing one leaves only the master password.

Shares are printed in Crockford base32 (no I, L, O or U) because they get
written down and typed back months later. Decoding folds the ambiguous
characters rather than silently producing a wrong key.

A kit can be reissued at any time from an unlocked vault — no need for the old
one. Unlocking already proved the master password, so asking for it again would
be friction without a check. Reissuing invalidates the previous shares, which is
the point: a half-lost kit is worse than none, because whoever finds the
surviving share is one step from the vault rather than two.

**A browser's "save password?" prompt is not the same as saving a share**, and
appears at exactly the wrong moment. You lost a share to precisely that, so
the kit screen now says so outright and tells you to verify it is really stored
before ticking the box.

### Deleting the vault

Takes the master password, not merely an unlocked session — it cannot be undone
by anyone, since the entries are encrypted under a key that exists only inside
what is being deleted. An unlocked vault sitting on screen is far too easy to
destroy by accident.

### Importing a browser export

`npm run import-check -w @everything/server` covers the reader; the API side is
in `vault-api`.

Reads Chrome/Brave/Edge, Firefox, Bitwarden, Safari and KeePass exports, and
falls back to guessing columns by name. Rows without a password are skipped —
those are "never save" markers, not logins.

**Two-phase on purpose.** The first call reports what it found and writes
nothing, so a mis-detected layout is caught before a thousand mangled entries
land in the vault. Only `commit: true` writes.

The CSV is the most dangerous thing that will ever pass through this app: every
password you own, in plaintext. It is parsed in memory, never written to
disk, never logged, and never echoed back — the preview returns counts and
titles only, because a preview that showed passwords would just be a second way
to read the file. The success screen's main job is telling you to delete the
export.

The hand-rolled CSV reader exists because splitting on commas quietly corrupts
exactly the entries hardest to notice are wrong: a comma inside a note, a quote
inside a password, a newline inside either.

### The browser extension

`packages/extension` — Manifest V3, loaded unpacked from `brave://extensions`
with developer mode on. Pair it under **Settings → Browser extension**.

**No background worker and no content scripts.** Nothing runs until the toolbar
icon is clicked: no listener on every page, nothing injected into sites, no
long-lived process holding a token. `activeTab` + `scripting` inject the fill
function into one tab, once, on an explicit click. That is both leaner and a
much smaller thing to trust.

All network calls happen in the popup, which is an extension page — host
permissions cover it, so there is no preflight to satisfy.

Two things had to give for this to work:

- **CORS allows `chrome-extension://` and `moz-extension://`.** The extension's
  requests are cross-origin by definition, so without it the browser discards
  responses the server already sent. Not a real loosening: every `/api` route
  still needs a bearer token, and the vault additionally needs an
  `extension`-kind device. A `browser`-kind token gets 403 from the vault and
  200 from `/api/tasks`, which is the intended split.
- **Local trust cannot apply.** The extension's `Origin` is cross-site, so
  `isTrustedLocal` correctly refuses it — hence the token. That is the auth
  design working, not something to route around.

Field detection prefers *position* over names: the username box is the last
text-ish input before the visible password box, within the same form. Site
naming conventions vary far too much to match on.

Filling goes through the prototype value setter and dispatches `input` and
`change`, because assigning `.value` on a React-controlled field is silently
reverted on the next render.

## Voice

Say the wake word, then `"I drank water"`, and the drink-water habit is ticked
off. `npm run voice-check -w @everything/server` proves the matcher; run it
before trusting any change to the phrase logic.

**Its own tab, not a section of Settings.** It is the only feature that holds a
microphone open, so the switch that turns it off must never be something you
have to go hunting through another screen for.

### Three tabs, split by how often you touch them

This screen grew from a switch and a text box into appearance, reminders,
shortcuts, enrolment, the vocabulary and every phrase you can say — one long
scroll in which whatever you came to change was always in the middle. It is
*General*, *Settings* and *Commands* now, the same idiom the Settings screen
uses, with the open tab in `useState` like every other bit of navigation here.

**The split is by how often you touch something, not by subject.** General is
what you actually open this screen for — is it on, is it hearing me, which
microphone, and the wake word. Everything set once and left is behind Settings.
The phrase list is long enough to deserve its own tab, and the two questions
"why is it not hearing me" and "what can I say" were never the same visit.

**The wake word is on two tabs, and it is one component rendered twice.** It
earns the duplication by being the setting people come back to: everything else
here is set once, while a wake word that keeps mishearing gets tried three or
four times in an evening — and somebody on Settings changing the decoys should
not have to switch tabs to change the word those decoys are about. What must not
happen is the two drifting, so there is one `WakeWordCard`; the version that
warns about a word the model cannot pronounce is the whole reason the box is
worth looking at, and a copy-pasted second one would be the one that quietly
lost it.

**The draft lives in the card, so switching tabs mid-edit discards it.** That is
the right loss rather than a bug: the two boxes are the same setting, and a
half-typed value appearing somewhere you did not type it is worse than starting
again.

### The screen must not be write-only

A switch reading "on" while the agent is stopped, the models are missing, or the
wrong microphone is selected is *worse* than no switch, because it looks like it
worked. So the agent reports what it is actually doing, and the Voice tab shows
it: whether the agent is alive, which device is open, a live input level, and
any error — the four states that have four different fixes.

`POST /api/voice/agent` is one endpoint doing both directions: the agent says
what it's doing and is told what to do in the same round trip. It has no live
connection to the server, so folding the answer into the report it was already
sending keeps that at one request rather than two.

**It long-polls.** The server holds the request open until something the agent
cares about changes, keyed on a `voiceVersion` counter bumped by settings and
habit edits and by arming a test. Asking on a timer instead lost both ways: at
10 seconds, a quarter of a test window was gone before the microphone was even
listening, *and* it cost a request every 10 seconds forever. Measured after the
change: **487ms** to enter a test, and 3 requests a minute idle instead of 6.

The exception is while a test runs, where the screen shows a live level meter
and wants frequent readings rather than a held connection — a 400ms poll, for
the forty-five seconds it lasts.

**A report is gathered before the config that arrives with it is applied**, so a
settings change would otherwise show up a whole poll late — which reads as "the
microphone I just picked didn't take", the exact doubt this screen exists to
remove. When something actually changed, the agent re-reports 600ms later, once
the new device has had a moment to open.

Status lives in memory on the server, like `currentWindowsDnd`. "Is a microphone
open right now" cannot be answered from a log, and writing a row every ten
seconds for it would be the polling this app avoids everywhere else.

### Starting it, rather than being told to go and start it

The status card answered a stopped agent with *"Nothing is listening. Start it
with Blue Everything.cmd."* — accurate, and exactly the friction the three
double-clickable files in the repo root exist to remove. An app that can tell
you something is not running can start it, so there is a **Start it** button
where that sentence was.

**It is not the Restart button.** Restarting stops the server too, and the
server is demonstrably fine — you are reading its response. Taking it down to
fix the other half would drop every open browser onto the offline screen to
solve a problem none of them had. `POST /api/agent/start` starts only the agent.

**And it hands off to `start.ps1 -AgentOnly` rather than spawning node itself.**
That script already owns the entry path, the working directory that lets
`--import tsx` resolve, and the log files; a second recipe here would be a
second thing to keep true. The switch exists because the ordinary path
**short-circuits on the server's port already being open** — so "the agent has
stopped while the server is fine" is precisely the case `start.ps1` could not
serve, and the button would have done nothing at all.

Registered in core beside `restartRoutes` and before anything optional, for the
same reason: "the agent has stopped" is a state the app must be able to fix from
inside, and a package must not be able to be the reason it cannot.

The button asks whether it *can* before offering, like the Restart button — over
Tailscale from the phone it genuinely cannot, since the agent runs on the PC. The
file name is still named in that fallback, because a machine with no
`start.ps1` has to be told something.

**The switch above it is the whole system, and now says so.** `voiceEnabled` is
a server-side setting, so turning it off from the phone closes the microphone on
the PC — but the card underneath reports a *second* thing, whether the agent is
running, and without a line saying which is which the two read as one confusing
switch.

**Which state the screen shows lags by up to `AGENT_STALE_MS` (45s).** That is
deliberate and not a bug to tighten: the agent long-polls, so an idle report
arrives about every twenty seconds, and a window much under a minute would
flicker the screen into "the agent is down" on an ordinary slow tick.

### Two keys, for what the wake word cannot do

**Voice → Keyboard shortcuts.** Both unset by default, both system-wide, so they
work from inside a game.

- **Turn voice on and off.** This is the one that had no alternative: a
  microphone that is off cannot hear you ask for it to be switched on, so before
  this the only ways back were the tray, a browser tab, or the phone.
- **Listen now, without the wake word.** Same tone, same popup, same command
  window — reached by a route that cannot be misheard. Strictly more reliable
  than the wake word, since nothing has to be recognised before it works.

**Neither ships set.** Registering one takes that combination away from every
other program on the machine, which is not a thing to do to somebody who has not
asked for it.

**It lives in the voice package, and works while voice is off.** Those are only
compatible because switching voice off does not *unload* the module — it disposes
the models and closes the microphone, while the agent half keeps polling, which
is how it learns to turn back on. Deleting the package takes the hotkeys with it,
which is right. It also keeps the virtual-key table in one place: `actions.ts`
already owns one for sending keystrokes.

**`RegisterHotKey` is given a window, not null.** With a window, `WM_HOTKEY` is
posted to it and `DispatchMessageW` routes it to a window procedure like any
other message. Registered against a null window the message lands in the bare
*thread* queue, where `DispatchMessageW` has nowhere to send it — and with three
pumps in this process, whichever peeked first would silently eat it.

**`MOD_NOREPEAT` is not optional.** Without it, holding the combination repeats
at the keyboard's autorepeat rate, which for "toggle voice" means flipping it
thirty times a second.

**A combination another program owns is reported, not logged.** `RegisterHotKey`
simply returns false, and a hotkey that does nothing is indistinguishable from
one that was never saved. Windows will not say *which* program has it, so the
message says what to do instead of pretending to diagnose it. Verified by asking
for `ctrl+alt+delete`, which Windows reserves.

**The server owns the flip.** `POST /api/voice/toggle` reads and writes in one
place, so two presses in quick succession cannot both read the same "before" and
have the second undo nothing. Local-only, like every other write that decides how
this machine behaves.

#### The number pad, and a Record button

`numpad0`–`numpad9` and the five operator keys are in `HOTKEY_KEYS`. They are the
natural home for a global hotkey — far from anything a game binds, and spare on
most keyboards — and they are spelled `numpad*` rather than reusing the digit
names because they are genuinely different virtual-key codes: registering `5`
does nothing for the pad.

Two things about them are worth stating on screen rather than leaving to be
found:

- **Numpad Enter is deliberately absent.** Windows gives it the same virtual-key
  code as the main Enter and separates them only by an extended flag
  `RegisterHotKey` cannot see, so offering it would be offering a key that
  silently binds a different one.
- **They follow Num Lock.** With it off the keyboard sends navigation codes
  instead, so the hotkey simply stops answering — and nothing else on screen
  would explain why. The field says so whenever the value contains `numpad`.

**`isGlobalHotkey` is stricter than `parseHotkey`, and the difference is real.**
`parseHotkey` refuses a bare *letter*, because sending one into whatever window
has focus is too easy to do by accident — but it allows a bare `f5`, which is
fine to *send* and disastrous to *register*: it would take F5 from every program
on the machine. Registering therefore requires a modifier outright. The screen
enforced this all along and the schema did not, which is the sort of gap that
holds until somebody uses the API directly.

**There is a Record button, and it reverses an earlier decision.** This shipped
as a text box only, on the reasoning that a capture box cannot see the
combinations Windows and the browser take first — `ctrl+w` closes the tab,
`alt+f4` the window, and neither reaches a `keydown` handler. That reasoning is
still true; it just is not a reason to withhold the button. **Both exist**: the
recorder for the ordinary case, the box for what it cannot capture, and a line
while recording saying which is which.

It reads `event.code`, the physical key, rather than `event.key`, which is what
that key produces. They differ exactly where it matters: `key` for the number pad
is `"5"` whether you pressed the digit row or the pad, and varies by layout;
`code` says `Numpad5` on every keyboard.

Three behaviours, all verified in the browser: a modifier on its own keeps
waiting rather than failing, since it is somebody still reaching for the second
key; a key with no modifier is ignored, matching what can actually be
registered; and Escape cancels.

#### Borrowing the microphone while voice is off

**Voice → "Let it work while voice is off"**, under the listen shortcut, off by
default. Switched on, that key is push-to-talk: voice stays off, the wake word
stays silent, and the key opens the microphone for **one exchange** before
closing it again. The setting is never changed — pressing it does not turn voice
on.

It is affordable only because of a number this project already measured. The
198MB resident cost is the price of an *always-on wake word*, not of listening,
and the models load in about 0.2s — which the leanness note names as exactly the
trade push-to-talk would make. Verified on this machine: **91MB with voice off,
222MB within a second of the press, back to 100MB when the window closed**, with
`voiceEnabled` still 0 throughout.

**A pause is borrowed through as well.** The agent cannot tell "off" from
"paused" — the server folds both into `enabled: false` — but the answer would be
the same either way: a pause silences the *wake word*, which is something the
room can trigger, and pressing a key on this keyboard is not. The pause is not
cleared.

**The window is a timer, not an event.** An exchange can end four ways — a
command lands, nothing usable is said, a retry reopens it, a follow-up reopens it
again — and hooking each would be four places that must all remember to close the
microphone. One bound that outlasts every path is a single thing to get right,
and being generous costs a few seconds of microphone rather than a leak.

#### Three ways it did nothing at all

Worth keeping, because each was silent and each looked identical from outside.

- **`EMPTY_VOICE_CONFIG` dropped the flag.** The agent rebuilds its config from
  that shell whenever voice is off — and this setting is *only ever read* in that
  state, so it was discarded in exactly the case it exists for. The hotkeys
  themselves had already been lost this way once.
- **`configure()` loads nothing.** It arms the listener's poll, and the models
  are pulled in on the first tick — so `listenNow()` on the next line found no
  recognisers and refused, every time. It is retried for up to
  `LISTEN_READY_MS` now rather than assumed.
- **The handler is `async`, so its rejection escaped the pump's `try/catch`**
  and landed as an unhandled rejection nobody prints. For the most consequential
  key on the machine, that is the worst available failure: indistinguishable from
  the key never being registered. It logs now, and so does every press.

All three were found the same way — by watching the agent's resident memory not
move — because none of them produced a message anywhere.

#### The hotkey outranks the speaker check

`requireKnownSpeaker` does not apply to a manually started exchange, and that is
a deliberate widening. It is a filter against the *room* — the television, a
video, somebody else talking — and none of those can press a key on this
keyboard. Holding it to a voiceprint would fail every time regardless, since
there is no wake word to take an embedding from, so the feature would read as
broken for exactly the people who had switched the protection on. The Voice
screen says so where the setting is, rather than leaving it to be discovered.

#### On and off mean what you can see, and four ways they did not

Reported as the hotkeys being weird and voice reading off when it was on. All
four were real, and each was the stored switch standing in for what the
microphone was doing.

- **The listen shortcut while voice is off never ran a command.** The agent
  opened the microphone and heard you, and `/api/voice/command` refused
  everything while `voiceEnabled` was 0, so every borrowed exchange came back
  `disabled`. It had been verified by watching memory rise when the key was
  pressed, which it did; nobody had looked at the answer. The listener now marks
  a shortcut exchange `manual`, and the server takes one while voice is off if
  *Let it work while voice is off* is on. It also skips the voiceprint for it,
  which it had been enforcing server-side even though the agent already
  skipped it: a key pressed here is the proof, and there is no wake word to
  take a voiceprint from. `smoke` covers all three answers.
- **The toggle flipped the stored switch.** Paused, or asleep because you had
  been away, the switch is on and the microphone is shut, so the key you pressed
  to get voice back turned it *off* and said "Voice off". The agent now works
  out what a press should make voice from what is actually happening
  (`effectivelyOn`: switched on, not paused, you at the desk, not a borrowed
  exchange) and sends that as a target; `/api/voice/toggle` takes it, and its
  own flip, kept for an older agent, counts a pause as off. A press within four
  seconds of the last goes from what that press asked for, since the answer
  takes a poll to come back. Turning it on also marks you present, because a
  key was just pressed here.
- **The screen showed the state from the last check-in**, which can be twenty
  seconds old: the voice loop spends most of its life parked in a long poll,
  and the report it parked with is what the server holds. Coming back to the
  desk, the toggle, and the listen shortcut now send a second report
  (`reportSoon`, 600ms after, once the models are in). The server keeps the
  latest body; the parked request only refreshes the timestamp. Measured with
  synthesised presses of the real shortcuts: on and listening 3s after the first
  toggle, off 3s after the second, and "listening for one command" 3s after the
  listen shortcut.
- **The big switch read "on" while paused.** It shows on only when the setting
  is on *and* not paused now, from the same two-second reading as the status
  card (`useVoiceStatus`, lifted out of the card so both use one answer).
  Switching it on while paused resumes, since saving `voiceEnabled` clears a
  pause. A borrowed exchange has its own line on the card, *Listening for one
  command*, instead of *Switched off* beside an open microphone.

#### It worked exactly once

The first version toggled voice off and then the key stopped working. Switching
voice off rebuilds the agent's config from `EMPTY_VOICE_CONFIG` — which is how it
forgets everything about a feature that is not running, and it dropped the
hotkeys with everything else. So the press that turned voice off also
unregistered the key that turns it back on, one poll later.

The code carried a comment saying the registration is deliberately *not* gated on
`enabled`. It was not; the config it read from had simply been emptied. **A
guard is only as good as the data still being there to guard**, and that is the
kind of gap only pressing the thing twice will find.

### Testing it

**Test it** arms a 45-second window in which the agent *reports* what it hears
instead of acting on it. `/api/voice/heard` refuses outside that window, so there
is no path by which checking whether the microphone works could quietly log four
glasses of water.

**A matched command ends the test immediately.** Running the full window anyway
meant standing there talking at a microphone that had already answered the
question, and every extra sentence added noise to the readout. Only a *match*
stops it — a command that matched nothing is exactly the case worth another go.

The window is generous because the first time through you are reading the
instructions and finding the wake word. It was 30s, and appeared to end early
for a second reason on top of that: the agent only learned a test had started on
its next poll, so up to a third of the window was spent not listening while the
countdown ran anyway.

The replay buffer is cleared at every utterance boundary, and at every wake —
under Vosk a close-talk headset could hold the gate open through breathing
between sentences, and a buffer spanning two deliveries came back transcribed
as one: "hey jarvis drink water hey jarvis drink water".

During a test the command recogniser runs alongside the spotter, and words
heard while still waiting for the wake word are reported as `speech`. That
distinction is the whole value of the test: "it can't hear me" and "it hears me
fine but the wake word isn't landing" look identical on a level meter and need
opposite fixes.

**The two models answer independently**, so the command recogniser can finish
before the spotter has said anything (under Vosk, a block or two before the wake
recogniser). Reporting that as "but not the wake
word" over a transcript that plainly contained it was a flat lie that sent you
looking for the wrong problem. The agent now decides `matchedWake` — it is the
only side that knows the wake word without the PWA importing zod — and the
readout says "wake word in there" instead.

`npm run voice-try -w @everything/agent` is the same idea without a microphone —
Windows' own speech synthesiser writes the audio, so it exercises the spotter,
the command recogniser and the block feed. It proves nothing about the speaker
check beyond the model producing an embedding, since it is not your voice.
`voice-listen` goes one further and drives the listener itself.

### Choosing a microphone

Stored as the device **name**, not its index. Windows renumbers inputs whenever
something is plugged in or unplugged, so a saved index quietly starts meaning a
different microphone. Matched on prefix, because `waveInGetDevCapsW` truncates
names to 31 characters — "Headset Microphone (5- Arctis Pro Wireless)" comes
back as "Headset Microphone (5- Arctis P".

A named device that is missing is reported as an error rather than silently
falling back to the default: "it stopped hearing me" and "your headset is
unplugged" want very different reactions.

### The PWA can outrun the server, and must not explode when it does

The three packages restart independently, and `start.ps1` rebuilds the PWA when
the sources are newer — so the ordinary case right after an edit is a browser
holding the new bundle while the old server process is still running. The voice
fields are therefore **optional in `AppSettings`**, with a `serverSupportsVoice`
guard, and the screen says "the server is running an older version" instead of
rendering.

That is not hypothetical: reading `wakeWord` off a response that predated it
threw, and took the entire Settings screen down with it. A stale server should
look stale, not broken.

**Off by default.** It is the only feature that holds a microphone open, so it
is something you switched on, not something you find already running. Turning
it off in Settings releases the device immediately.

### It stops listening when you are not there

An always-on microphone in an empty room is the one state this app should never
leave running by accident, so the agent closes it when `isAwayFromPc()` says the
chair is empty — the *same* function the server uses to decide whether a nudge
may go to your phone, so the two can never disagree about what "away" means.

It goes through the same `enabled: false` path as the off switch, which means
the speech models go too. Measured under Vosk, whose models were all resident
whenever it was listening:

| | listening | resident |
| --- | --- | --- |
| at the desk | yes | 204MB |
| away | no | **80MB** |
| back | yes | 199MB |

Decided in the agent from the snapshot it already has, rather than read back
from the server: closing a recording device must not wait on a round trip, and
must keep working while the server is down. So the call sits *above* the
in-flight and backoff guards in the attention tick.

The reason is reported on the heartbeat and the Voice screen has its own rung
for it — **"Asleep — you are away"** — placed before `listening` for the same
reason `paused` is: the setting is still on, so without it the screen would say
"Starting up…" at a microphone that had been closed deliberately.

**The trade is real and worth knowing.** Away needs 15 minutes with no keyboard
or mouse *and* no sound played, so reading something long in silence eventually
counts as gone — and the wake word will not answer until you move the mouse.
That is the honest cost of not holding a microphone open at an empty desk, and
the screen says which state it is in rather than leaving you guessing.

```
microphone ──► RMS gate ──► wake spotter ──► command recogniser
  (winmm)      (silence is    ("hey jarvis",      (any English, in a worker
                free)          ~50MB, always)      thread, loaded on wake)
                                                         │
                                                speaker check (ERes2Net)
                                                         │
                                                         ▼
                                                POST /api/voice/command
                                                (server decides intent)
```

### sherpa-onnx, and why it replaced Vosk

Switched 2026-10-14. Three models from the k2-fsa sherpa-onnx project, through
its prebuilt Node binding (`sherpa-onnx-node`, pinned at 1.13.8): a **keyword
spotter** for the wake word, a **streaming transducer** for the command, and a
**speaker model** for "only my voice". `engine.ts` holds all three; nothing
else touches the binding.

**The reason was the wake word.** Vosk could only listen for one by running a
general recogniser in a *closed grammar* — the wake word and `[unk]` — and a
closed grammar has to answer every sound with something it contains. Much of
this file's voice history was a fight with that: "harvest festival" landing on
"hey jarvis", a dog called Harley waking it, decoy words filled in by hand, and
confidence scores reading 1.00 for everything because inside a grammar the
chosen path is the only path. A keyword spotter is asked the right question —
*was this phrase said* — and can answer no.

Measured on the same synthesised audio with `wake-falsing`:

| | false wakes on chatter | wakes on the real thing |
| --- | --- | --- |
| Vosk, no decoys | 1 / 14 | yes |
| Vosk, decoys filled in by hand | 0 / 14 | yes |
| **spotter, no decoys** | **0 / 16** | yes — normal, fast, run together, name only |

Checked across "hey jarvis", "hey everything" and "hey computer", each 0/16.
The two new chatter lines are the ones most likely to catch a spotter out —
"hey are you coming to dinner" and "jars of jam".

**It answers mid-sentence, and that changed the shape of the listener.** Vosk
reported the wake word only when the whole *utterance* ended, so the command
had to be dug back out of a replay buffer once you stopped talking. The spotter
fires about 0.3s after the word itself, while the command is still being said.

**The wake word is still a runtime string**, which is the property Vosk was
chosen for in the first place. The spotter takes its keywords as text at
construction, so the box on the Voice tab still works without training
anything. The one wrinkle is that it takes them as **SentencePiece tokens**
(`▁JA R VI S`), not words, and the `modelingUnit`/`bpeVocab` options that encode
text for the streaming recogniser are not applied to keywords. `wake-tokens.ts`
encodes them. **The file is called `bpe.model` and is a unigram model**: BPE
merges got four of the nine example keywords that ship with it wrong, by id
order and by the stored scores alike, and unigram Viterbi got all nine. The
protobuf is read by hand — two fields of one message — the call `zip.ts` makes.

**The command recogniser is open-vocabulary**, which Vosk's grammar never was.
It writes "Hey, Jarvis, I drank 2 waters." with capitals, commas and digits, so
`cleanTranscript` lowers it, strips punctuation and spells numbers up to twenty
back out, since `spokenCount` reads words. The machinery that let the grammar
say "drank" (`spokenVariants`, the joined `nevermind` forms) no longer decides
whether a sentence can be heard. It stays, because the matcher still stems and
a recogniser that writes "nevermind" as one word still has to be answered.

#### Three models, three lifetimes

| | resident | loaded | why |
| --- | --- | --- | --- |
| spotter (gigaspeech 3.3M, int8) | ~50MB | while voice is on | it is what listens |
| command (kroko, English) | ~155MB | on wake, in a worker; dropped after 10 min unused | needed for seconds at a time |
| speaker (3D-Speaker ERes2Net) | ~25MB | on first use | only to check a wake word or enrol |

**The command model loads on the wake, and 10 minutes was the user's choice.**
Keeping it resident all day would be the 200MB this project already apologised
for under Vosk; loading it per utterance would put 1.4s in front of every
command. So the first command of a session pays the load and a run of them does
not.

**It loads in a worker thread, because the microphone's ring is 800ms.** Eight
100ms buffers, and the load is 1.4s: on the listener's thread it would drop the
start of the very command it was loaded for, and freeze the tray and the popup
while it did. In a worker, the audio sent meanwhile waits in the port's queue,
in order, for free. `command-worker.mjs` is plain JavaScript for that reason:
whether `--import tsx` reaches a worker is one more thing that could silently
leave voice deaf.

**And ending the worker is how its memory comes back.** The binding has no
explicit free; memory returns when the objects are collected. Terminating the
thread gives back all of it at a moment of our choosing — 196MB → 55MB in the
spike. The spotter and speaker model live on the listener's thread, so
switching voice off drops them and calls `global.gc`, which `start.ps1` exposes
with `--expose-gc` on the agent for exactly this.

**The window runs from when the recogniser could hear, not from the wake.** The
first command of a session waits 1.4s for the model, and what was said meanwhile
is queued rather than lost — so charging that second and a half to
`VOICE_COMMAND_TIMEOUT_MS` would time out commands that had been said perfectly
well.

#### Taking the wake word back out of the command, by time

The command recogniser is given **the whole sentence so far**, wake word
included, and the wake word is then dropped by *when* it was said. Each model
stamps every token with the moment its sound begins; the spotter's last token
is the start of the wake word's last syllable, and any word the recogniser says
started more than 0.1s after it belongs to the command.

Cutting the *audio* at the keyword was tried first, and it mangles the next word
however the cut is tuned, because a word cut in half is a different word:

| cut at the last token plus | "hey jarvis I drank two waters" | "…drink water" | "…skip this track" |
| --- | --- | --- | --- |
| 0.2s | "rank two waters" | "water" | "this track" |
| 0 | "i drank two waters" | "drink water" | "gip this track" |
| −0.1s | "i drank two waters" | "strike water" | "skip this track" |

Timing gets all of them right, and it beats dropping the wake word by *text* for
a reason that showed up on the first run: the recogniser heard one fast "hey
jarvis" as **"Hage Arba"**. Matched by text, that would have gone through as two
words of the command; matched by time, it went where it belonged. Speech
*before* the wake word in the same breath ("ok so hey jarvis…") goes the same
way.

`afterWake` still strips through a recognised wake word as a second line of
defence, and `hasCommand` still treats a transcript of nothing but the wake
word as you pausing to think.

**A test that stops feeding needs two seconds of silence, not one.** The
recogniser will not commit to an endpoint until its look-ahead has seen enough
quiet; a live microphone always supplies that, a test harness has to.

#### The tone waits for a pause

The spotter fires while you may still be talking, and a beep over the rest of
"…I drank two waters" is noise. So the "go ahead" tone plays once 300ms of
quiet follows the wake word, and not at all if you carried straight on — the
run-together case gets the result tone alone, as it always did. The popup still
goes up the instant the wake word is heard. `voice-listen` asserts both.

#### What carried over, and what did not

- **Leading attention words are still optional.** `wakeWordRequired` gives
  "jarvis" for "hey jarvis", and the spotter is handed both, so a swallowed
  "hey" still wakes it and a bare "hey" still does not.
- **One-word wake words are still allowed and warned about.** A spotter for
  "everything" fires on every "everything is fine" — that is the word's fault,
  not the engine's.
- **Decoys still work, differently.** They are keywords beside the wake word: a
  sound that matches "harley" better than "jarvis" is a hit on "harley", which
  the listener ignores. With no closed grammar they are needed far less, and the
  setting stays for the case `wake-falsing` cannot make — a slurred name across
  a room.
- **The dictionary warnings mostly went away.** "Can this word be heard" was
  Vosk's lexicon: "unmute" was missing and a phrase using it never fired. An
  open vocabulary has no such list. What is left is spelling — a number written
  in digits is never in a transcript, since speech is written as words — so
  `unknownWords` flags that and nothing else, and the warnings on the commands
  screen say "write two, not 2". The wake word box only takes letters, so its
  warning was removed.
- **"Everything it can hear" was removed.** It listed the grammar, grouped by
  where each word came from, because a closed grammar's contents explained most
  of what voice did. An open recogniser has no list to show, and a screen
  presenting one would be a claim about a constraint that no longer exists.
- **The spotter is rebuilt only when the wake word or the decoys change**, not on
  every `version` bump, which also moves with each command phrase. It knows
  nothing about phrases, and a rebuild is half a second on the listener's thread.

#### Voiceprints from Vosk are stale, and say so

Vosk's speaker embeddings were 128 numbers and ERes2Net's are 192, and the two
cannot be compared — not even by truncating, since the dimensions mean nothing
to each other. `VOICEPRINT_DIMENSIONS` in `shared` is 192, and a voiceprint of
any other length is **kept but not enforced**: enforcing it would refuse every
command, since nothing can score against it, and deleting it would switch the
protection off behind your back. `/api/settings` carries `voiceprintStale`, and
the Voice screen says *Needs teaching again* until you enrol. The agent and the
server both skip the check, for the reason they both run it. `smoke` asserts
both lengths, both ways.

On synthesised voices the same voice scores 0.73–0.79 against itself and
0.15–0.21 against a different one, so the default 55% threshold sits well clear
of both.

#### The models arrive by themselves

Switching voice on with the models missing fetches them — about 100MB from the
sherpa-onnx GitHub releases, six seconds on this connection — and the Voice
screen says *Getting the speech models* with how far it has got. The agent
reports every second while it does, rather than parking in the long poll.
`models.ts` is the one function, and `voice-setup` calls it too. It replaced a
page of instructions — three zips, which folder each unpacks into, "keep the
folder name" — which was the open-a-terminal friction the double-clickable files
exist to remove.

Each archive is unpacked into a scratch folder and only the named files are
moved into place, so a half-finished download leaves nothing that looks
installed. Windows' own `tar.exe`, by path, for the reason the release packaging
gives. A failure becomes the error on the Voice screen and is retried after ten
minutes rather than at the listener's 10Hz. Once the new set is whole, Vosk's
DLLs and model folders are deleted; one still mapped by a running agent is left
for the next start.

**The file names are short on purpose.** onnxruntime reports a path over
Windows' 260 characters as the file *not existing*, and the upstream names
(`encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx`), under a checkout in a
OneDrive folder with spaces in it, did exactly that in the spike.

**It is cross-platform, which Vosk here was not.** The binding ships prebuilt
for Windows, Linux and macOS on x64 and arm64 as optional dependencies, so the
lockfile carries all six and npm installs the one that fits. That is a step
toward the platform goal above, not the end of it: the microphone is still
winmm, and on macOS the binding needs `DYLD_LIBRARY_PATH` pointed at its folder.

#### The tools

- `voice-setup` — fetch the models if missing, list the microphones, load the
  spotter and listen for three seconds.
- `voice-try` — the spotter, the speaker model and the command recogniser over
  synthesised speech, and what the server's matcher would do with the result.
- `voice-listen` — **the listener itself**, driven through a stand-in
  microphone at real speed: a paused command, a run-together one, chatter, and
  silence after the wake word, asserting what reaches `post` and when the tone
  plays. `createVoiceListener` takes a `microphone` option for it, and nothing
  else passes one.
- `wake-falsing` — the false-wake count. `EVERYTHING_WAKE_THRESHOLD` (0.25) and
  `EVERYTHING_WAKE_SCORE` (1.0) are read by the spotter, so a change can be
  measured here first.

`wake-probe`, `wake-confidence` and `voice-latency` were Vosk's: a partial
printed block by block, per-word confidence in grammar mode, and how long its
endpointer took. A spotter has no equivalent question to ask, so they went too.

The versions that were measured: `sherpa-onnx-node` 1.13.8,
`sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01` (int8),
`sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06`, and
`3dspeaker_speech_eres2net_sv_en_voxceleb_16k`.

### The server decides what was said, the agent only hears it

The agent posts a transcript to `/api/voice/command`; all matching happens
server-side, like `/api/attention`. So phrases live next to the habit in the
database, are editable from the phone, and never have to be synced onto another
machine.

The agent *does* fetch a vocabulary hint from `/api/voice/config` to constrain
the recogniser. That is a recognition aid, not a decision. Its `version` is a
**hash of the words**, not a count — renaming a phrase from "drink water" to
"sip water" leaves the count identical, and a counted version left the agent
listening for the old vocabulary indefinitely.

**Audio never leaves the agent process.** There is deliberately no endpoint that
accepts a recording. Nothing is written to disk and nothing is logged but text.

**Voice cannot touch the vault.** Habits, tasks and notes only — a spoken
password manager is not a feature.

### A phrase can do five things, not one

`voice_commands` replaced `habits.voice_phrases`, which could only ever tick off
a habit. Migration `0010` copies the old phrases across and the column is then
left alone — the Voice tab is the single place phrases are edited, so two
sources of truth would only ever disagree.

| Kind | Does | Target |
| --- | --- | --- |
| `habit` | records one against it, honouring "two" / "three" | habit id |
| `note` | writes down whatever was said *after* the phrase | — |
| `url` | opens it in the default browser | http(s) address |
| `hotkey` | presses keys into the focused window | e.g. `ctrl+shift+m` |
| `media` | play/pause, skip, back, stop, volume, mute | one of `mediaActions` |
| `launch` | starts a game or app | an **exe on the games list** |
| `pause` | closes the microphone, for N minutes or until switched back on | — |
| `cancel` | drops the sentence in progress; the microphone stays on | — |

**`music` starts Spotify from the server, not by pressing keys**: shuffle,
random, queue, or stop topping up, as Connections → Music does. Voice and
integrations are separate packages and either can be deleted, so voice may not
import the shuffle. It POSTs to that package's own route on loopback instead,
which local trust lets through without a token. A 404 becomes "Music isn't
installed". The Music tab's settings are on the server, so voice plays with the same lists,
gap, recency, boosts and queue size; only Shuffle or Random comes from the command.

**The division of labour is deliberate.** Anything touching *data* happens on
the server, which owns the database. Anything touching *this machine* — a
browser, a keystroke — comes back as an instruction for the agent to carry out,
because the server is meant to be movable and has no business assuming it runs
on your desk.

#### Starting a game by voice, without a spoken "run anything"

**The target names a row on the games list, and the path is read from that
row.** That is the whole safety property of the kind, and it is the same rule
`POST /api/games/:exe/launch` follows: the path was filled in by the agent
watching that executable actually run here, so what a mis-heard phrase can start
is bounded by what this machine has already started on its own. A target that
could hold a path would be a spoken "run anything", which is a categorically
larger thing than "open the game I named".

So `isLaunchTarget` **refuses a separator rather than normalising it**. Accepting
`C:\Windows\System32\cmd.exe` and then merely failing to find a row for it
would work by accident, and what has to hold is the rule — that is what somebody
editing this next will read.

**Both ends check, and they are checking different things.** The server refuses a
target that is not a bare name and resolves the row; the agent refuses a path
that is not an existing `.exe` before handing it to the shell. One is about the
list and the other is about the disk, and they are the same check only while both
are right — the arrangement the zip reader's path guard already uses.

**Three failures are told apart, because they have three different fixes.** Not
on the list, on the list with no path known yet, and gone from disk. "It didn't
work" is not a fix; *"run it once and I will know where it is"* is — and the
editor says that at the moment you pick such a row rather than waiting for the
command to fail, since a row with no path saves perfectly and then answers with
what reads as the command being broken.

**The picker offers nothing when the list is empty**, and says why. An empty
dropdown is indistinguishable from a broken screen, and the fix — go and run the
thing once — is not guessable from one.

Nothing had to be added to the grammar: phrase words are expanded by
`vocabularyFor` whatever kind they belong to, so "start warframe" contributed
`start`, `warframe`, their generated forms and the run-together `startwarframe`
on its own. A game name the model cannot pronounce gets the same warning every
other phrase word already gets.

**Media commands are gated on something actually playing.** They go out as the
system media keys rather than a `hotkey`, so they reach whatever owns playback
without that window being focused — which is the point when the music is behind
a game. But an always-on microphone mishearing "skip" in a silent room is worse
than most misfires, because nothing happens that you would notice was wrong. So
`mediaIsPlaying()` in `audio.ts` gates them: no sound on the output meter in the
last two minutes and the key is never sent, with the overlay saying why.

The check lives in the agent because only it can see the meter, and it is the
same WASAPI reading `attention.ts` already takes each tick — so the guard costs
nothing. It refuses when the meter is *unavailable* too: an unknown answer is
not a yes for something that presses keys. The two-minute memory is deliberate,
so a track paused a moment ago still takes "play".

Volume steps send the key five times, because one press moves Windows' volume
about two percent and nobody means that by "volume up".

**`cancel` and `pause` are one choice on screen and two kinds underneath.** The
Voice tab offers a single "Stop listening", with a scope: *just this sentence*,
*for a few minutes*, or *until I switch it back on*. The first writes `cancel`,
the other two write `pause`. Offering them as two peers in the same dropdown
made two near-identical entries and left you guessing which meant "never mind".

The split stays in the data because they genuinely do different things: `cancel`
abandons the exchange, closes the follow-up window and takes the popup away
while the microphone stays open — the wake word works again immediately —
whereas `pause` shuts the microphone. Saying "never mind" should not cost the
next five minutes of voice, which is what using `pause` for it did. Editing a
saved command reads the scope back off the kind, so the round trip holds.

`pause` is the one that justifies the rest: an always-on microphone you can only
silence by walking to the keyboard is silent at exactly the wrong moment.
`voicePausedUntil` holds `-1` for "until switched back on by hand", which is
distinct from null, so the difference survives a restart.

**A pause needs a way out, and it must be the obvious one.** Two, in fact: the
Voice screen shows a **Paused** state with a *Start listening* button, and
switching the master toggle on clears the pause as a side effect. It first
shipped with neither — only a `/api/voice/resume` endpoint nothing called — so
an open-ended pause was a dead end, and the screen cheerfully reported
"Starting up… loading the speech models" at something that was never going to
start. `paused` has to be checked *before* `listening` in that status ladder,
because the setting is still on the whole time.

Guards on `hotkey` and `url`, since these are the parts with teeth: only stored
commands can fire, `parseHotkey` is an allow-list that requires a modifier so a
stray letter can never be sent, and only `http:`/`https:` open so the shell is
never handed a `file:` path or a protocol handler.

### The overlay at the cursor

`packages/agent/src/overlay.ts` — `CreateWindowExW` and GDI through koffi, the
same trick `audio.ts` uses for WASAPI and `mic.ts` for waveIn.
`npm run overlay-try -w @everything/agent` shows it without saying anything.

**It is core, not part of voice** — see **Popups and sounds** below. Voice was
where it was built, and leaving it there meant nudges could not use the one
surface in this app that draws above a fullscreen game.

Electron was rejected at 150–250MB to draw a tray icon and was never going to be
accepted to draw four lines of text. A borderless browser window was the other
candidate and fails the case that matters most: it takes most of a second to
appear and will not float above an exclusive-fullscreen game, which is exactly
when you are talking rather than typing. This appears in about a millisecond,
sits above everything, and is `WS_EX_NOACTIVATE` so it never steals focus from
whatever you are playing.

Three things there are easy to get wrong:

- **`DrawTextW` is in user32, not gdi32.** It is a layout helper built on GDI
  rather than a GDI primitive, and looking for it in the obvious library fails
  at load time with "cannot find function".
- **koffi's type registry is process-wide.** `win32.ts` already owns `RECT` and
  `MONITORINFO`, so the overlay's structs are prefixed. A collision throws on
  import and takes the agent down before it starts.
- **The message pump is polled, not looped.** Windows wants a thread sitting in
  `GetMessage`; Node owns this thread. So `PeekMessageW` runs on a timer — 16ms
  while visible, 200ms while hidden to drain strays — and `DispatchMessageW`
  calls the window procedure synchronously on the same thread, which is what
  makes the koffi callback safe. Nothing is ever invoked from a thread V8 has
  not heard of. The callback pointer is held in a variable so it cannot be
  collected while Windows still has it.

The window is created lazily on first use and kept, because recreating it per
utterance would waste the speed that justified building it. If it cannot be
created at all, voice carries on without it — a missing overlay is a poor reason
to lose the feature.

### Exclusive fullscreen, and why no window style fixes it

Reported from real use: in exclusive fullscreen, a popup made the game lose the
display and minimise, so it had to be clicked back into.

**It is not focus theft, and checking that first saved fixing the wrong thing.**
The window already refuses focus every way Windows offers — `WS_EX_NOACTIVATE`
at creation, `SW_SHOWNOACTIVATE` to show, `SWP_NOACTIVATE` to move, and
`WS_EX_TOOLWINDOW` to stay out of Alt-Tab. It never takes the foreground.

What happens instead is that **exclusive fullscreen owns the display rather than
merely the screen**. A game in true D3D fullscreen has the output to itself, and
for Windows to draw *anything* above it that mode has to break so the desktop
compositor can take over. Plenty of games read that as losing the display and
minimise. No style prevents it, because the cost is in compositing at all rather
than in who has focus.

So the only thing that works is to put the popup where the game is not.
`screenOwnedByGame()` finds the monitor the foreground window has claimed and
`place()` anchors to a different one — the primary if it is free, otherwise
whichever is left. With one monitor there is nowhere to go and nothing changes.

**Only for `RUNNING_D3D_FULL_SCREEN`, never for borderless.** Borderless is
already composited, so a popup over it costs nothing, and moving the window to
another screen would be a change of behaviour bought for no reason. That is why
the *shell's* notification state is asked rather than the geometry check the
games list uses: those two questions look identical and are not. It is also the
same call `quietReason` makes about Do Not Disturb, so nothing new is bound.

**A named screen wins.** Pinning the popup to a monitor is an explicit statement
about where popups go, and quietly overriding it would be worse than the flicker
this avoids.

Verified on this machine mid-game: the shell reported `RUNNING_D3D_FULL_SCREEN`,
the foreground window was a game owning the 3440×1440 primary, and the popup
resolved to the 1920×1080 beside it.

### Where it appears, and what face it wears

`cursor` is the original behaviour. A **5×5 grid** pins it somewhere fixed
instead, which is what a multi-monitor desk wants: the pointer is wherever you
last clicked, not where you are looking. Three by three only offered corners,
edges and dead centre, and a third of the way down the right-hand edge is a
perfectly reasonable place to want a popup.

Cells are `grid-<row><col>`, 1-indexed from the top left. Coordinates rather
than names because there is no honest English for the square two-fifths across
— "upper-midleft" is worse at saying where it is than a number. **The nine
original names are still accepted** and map onto the corners, edges and middle
of the finer grid, so nothing had to be migrated: a value the schema no longer
accepted would be a settings row that fails to save on the next unrelated
change. `placementCell()` in `shared` is the one place that reconciles the two,
and `place()` interpolates a fraction per axis rather than branching on names —
which is why a finer grid cost nothing to add. A pinned popup can follow **whichever screen
the mouse is on** or stay on **one named screen** — stored by device name
(`\.\DISPLAY25`), never by index, because unplugging a monitor renumbers the
rest exactly as it does microphones. A named screen that has gone falls back to
the mouse's rather than opening somewhere that no longer exists.

`listScreens()` uses `EnumDisplayMonitors` with a koffi callback and reports the
**work area**, so an anchored popup sits above the taskbar rather than under it.
The list is read live and comes from the agent — `window.screen` in the PWA
describes only the display that tab is on.

Avatars are **emoji by default**: Windows draws them in colour from Segoe UI
Emoji, so a gallery costs no checked-in binaries, matching how the app icons are
generated rather than committed. A picture of your own is uploaded to
`data/avatar.<ext>` — beside the database, not in it, because a settings row
read on every page load has no business carrying an image — and the agent
downloads it once per `avatarVersion`. GDI+ decodes it, since `LoadImageW` only
understands BMP and nobody has a BMP. `probeAvatar()` exists because a failed
decode is otherwise silent: the gutter just stays empty.

### It is a conversation, not a receipt

After answering, the listener calls `listenAgain()`: the microphone stays open
for one more command **without the wake word**, because having just replied it
is still your turn and making you say "hey jarvis" again would be the point
missed. A `pause` is the exception — you asked for silence, so carrying on
listening would be perverse.

**One box makes it one setting.** "Use this after a miss too" sits under the
follow-up slider and hides the retry card entirely — the two numbers are the
same for most people, and a second slider you have to keep in step is a chore
rather than a choice.

`voiceRetryMatchesFollowUp` is a **real flag, not `retry === followUp`**. Two
settings that happen to hold the same number is not the same statement as "keep
these together": inferring it would tick the box by coincidence and then start
dragging one slider with the other. `quietHoursEnabled` is a real flag for
exactly this reason, and for the same reason **the retry value is left alone
while the box is ticked** — resolved on read, so unticking gives back the number
you chose rather than whatever the follow-up happened to be. Verified: 12s,
ticked, follow-up moved to 9, unticked, still 12s.

Hidden rather than disabled, because a disabled slider sitting at a number that
is no longer in use is a worse lie than not showing it. The agent is told one
figure and never learns the box exists — judgement server-side, as everywhere
else here.

**It cost a type lie to get right.** `AppSettings` declared it `boolean`, the
row returns `1`, and `=== true` was quietly false — so the card never hid while
the setting saved perfectly. `api.ts` opens with a warning about exactly this;
every other boolean on that type is a `number`.

**How long it waits is two settings**, both 0–30 with sliders on the Voice tab.
`voiceFollowUpSeconds` is the wait after it *works* — you may add a second
thing. `voiceRetrySeconds` is the wait after it *misses* — you are about to
repeat yourself, which takes longer because you have to notice it failed first,
so it defaults higher at 8. **0 switches either off**, which is a legitimate
choice rather than a broken one.

The retry is **bounded to one per wake**. Reopening on every failure would let a
misheard cough hold the microphone open indefinitely: nothing said, retry,
nothing said, retry. `retryUsed` resets when the wake word actually fires again.

**Individual commands can opt out**, via `allowFollowUp` on `voice_commands`.
Chaining suits some and not others: two habits in a row is natural, while
opening a site or pressing a hotkey means attention has already gone elsewhere
and a live microphone is just exposure. Defaults on, so nothing changed for
commands that existed before the column did.

It is deliberately *not* the same number as `VOICE_COMMAND_TIMEOUT_MS`. That one
is how long it waits for the first thing after the wake word, where you are
part-way through a sentence and the answer is fixed. `inFollowUp` in `voice.ts`
is what keeps the two apart. The overlay stays up for whichever is longer, so
"it is still waiting for me" and "it has finished" are never the same picture.

When two commands answer to the same phrase the server returns `ambiguous` with
`choices` rather than guessing, and the overlay draws them as buttons.
`POST /api/voice/command/:id/run` carries out whichever is clicked. Guessing
would be the worst option available: a wrongly fired hotkey is not something
anyone would notice was wrong.

### Two commands in one breath

`"I drank water and skip this track"` does both. `segmentUtterance()` in
`shared` proposes the segments; `planChain()` in the server's `actions.ts`
decides whether to take them.

**Do not split on the word "and". It was tried, and it cannot be made to work.**
`spokenVariants` puts an `-ing` form of every phrase word into the grammar, so
`watering` is something the recogniser is allowed to emit — and *"water and" is
acoustically identical to "watering"*. Asked to choose, it frequently chose the
single word; the joint vanished and the sentence quietly did only its first
half. This is not fixable by tuning: `tracking`, `backing`, `minding` and
`thing` are all sitting in the same grammar, so narrowing it only moves which
pairs collide.

So the joint is never looked for. `segmentUtterance` walks the words left to
right and closes a segment the moment what it has accumulated matches a stored
command, then starts a new one. "and" is filler to `voiceTokens` and simply
lands inside whichever segment it falls in — and if it came back as "watering"
instead, that stems to `water` and the segment matches anyway. Dropping it
entirely ("drink water take vitamins") works too.

**Chaining is tried first, and has to be.** "I drank water and took my meds"
matches `drink water` perfectly as a whole sentence — every content word of the
phrase is in there — so resolving first and segmenting on failure would never
chain anything.

The rules are strict because the cost of being wrong is asymmetric. Failing to
chain means saying the second thing again; chaining something that was not a
chain fires a command nobody asked for, and with a hotkey in the list that is
not something you would notice was wrong. So:

- **every segment must match strictly** — no loose matching, no clipped-tail
  allowance. Those exist to rescue a sentence that would otherwise be lost
  entirely, and here there is a perfectly good fallback;
- **every meaningful word must be consumed**, or accounted for as a clipped
  command — see below. Words left over that are neither mean part of the
  sentence was not understood, and that abandons the whole chain, which is what
  keeps "I drank water and went to the shops" a single command. Trailing
  *filler* is tolerated; "…please" should not cost it;
- **at least two segments**, or it is simply one command;
- **no segment may be ambiguous**, because asking about one part of a chain
  means holding the rest of the sentence somewhere while a popup waits;
- **no `note`**, whose content is free text — "note buy milk and eggs" would
  file "buy milk" and try to run "eggs". A note is allowed to contain "and";
  that is rather the point of dictating one;
- **nothing runs until every segment has resolved**, so a chain never half-fires.

Anything that fails these falls back to resolving the sentence whole, exactly as
before. That is also what keeps a stored phrase containing "and" working: no
prefix of `salt and pepper` matches on its own, so it closes exactly one segment.

Segments close at the *earliest* point they match, so a phrase that is a strict
prefix of another would close early — but such a pair is already ambiguous in
the single-command path, and the leftover rule turns a mis-segmentation into a
clean fallback rather than a wrong action.

`and` stays in `ALWAYS_IN_VOCABULARY`, but for a smaller reason than it was put
there for: nothing reads it, and it is only there so the recogniser has
somewhere harmless to put the sound. A closed grammar must emit *something* for
every noise it hears, and denying it the real word only pushes the guess onto a
neighbour.

Each segment carries its own count — "two waters and three coffees" is 2 then 3.

#### A half-heard command must not vanish into the next one

A segment only has to *contain* its phrase's words, so a command whose tail is
clipped never closes and its words ride along until the next one closes for
both. `"pause the [music] and I drank water"` arrived as tokens
`[paus, drink, water]`, matched `drink water`, and **the pause was silently
dropped** — one command where two were asked for. That is worse than failing
outright, because the half that worked hides the half that did not.

So the words a segment carried that its own phrase cannot account for are
collected and offered to `matchVoiceCommandLoosely`, which exists for exactly
this: a command whose last word was never heard. Two conditions have to hold,
and the second is what stops it inventing commands:

1. **exactly one loose candidate**, and
2. **the leftovers contain only words of that candidate's phrase.**

The second is not optional. "went to the shops" loosely matches `go for a walk`
all on its own — "went" stems to "go", and the lenient matcher may lose the
phrase's last word. What rules it out is "shops", which belongs to nothing in
that phrase: a genuinely clipped command contains *only* its own words, while a
sentence about something else brings its own vocabulary.

Leftovers **inside** a segment that name nothing are ignored rather than fatal,
so a stray word the recogniser invented cannot cost a chain that is otherwise
perfectly clear. Leftovers **after** the last match are explained by no command
at all, so those do abandon it. The wake word is passed in and excluded, since
it is a leftover by this measure and must never become a command.

Recovered steps are flagged `lenient`, so the overlay says it guessed.

### The stemmer has to be the exact inverse of the generator

`spokenVariants` widens the grammar and `stem` folds it back, and CLAUDE.md has
claimed since the widening went in that "every generated form stems back to the
word it came from". **That was only ever tested on "drink", and was false
elsewhere**, in ways that silently lost common sentences:

- `-es` was stripped from anything, so `coffees` became `coffe` while `coffee`
  stemmed to itself — "I drank two coffees" could not match `drink coffee`. It
  is only a plural ending after a sibilant, which is exactly the condition
  `spokenVariants` uses to *add* it.
- `-ing` and `-ed` attach to a stem that has already dropped its silent `e`, so
  `taking` reduced to `tak` while `take` stayed `take` — **"I'm taking my
  vitamins" never matched `take vitamins`**. `dropSilentE` now collapses the `e`
  on both sides rather than trying to restore it, because putting it back
  correctly needs a syllable measure and still gets "agreed" and "paused" wrong
  in opposite directions. Two words differing only by a final `e` now collide,
  which costs nothing in a vocabulary of phrases you wrote yourself.
- The irregular table returned early and bypassed all of it, so `took` gave
  `take` against a stored `tak`.

**Doubling before `-ed` and `-ing` was the third case, and it broke a whole
class of ordinary short verbs.** "sip" gives "sipped", so stripping `ed` left
`sipp` while the stored `sip` reduced to `sip` — and the generator was no help
either, offering the grammar `siped` and `siping`, spellings nobody says and
Vosk drops as absent from its lexicon. So the recogniser could not emit the word
and the matcher could not have folded it back if it had. `jog`, `plan`, `stop`,
`nap`, `log` and `trim` all failed the same way. `undouble()` and
`doublesFinal()` are the two halves, and `l`, `s` and `z` are excluded from the
first because plenty of words simply end in those doubled — collapsing "pressed"
to "pres" would trade one broken class for another.

**A lone `-s` is never the plural of a word ending `-ss`**, which was a separate
pre-existing bug found by the round-trip check the above added: `press` reduced
to `pres` while `pressed` reduced to `press`, so the two halves of one word
stopped matching. `pass` and `floss` failed identically.

`voiceTokens` also filters filler **before** stemming as well as after, because
`FILLER` is spelled the way people write these words and `have` had already
become `hav` by the time it was checked.

`voice-check` now runs the round trip over a spread of endings rather than one
verb. A property this load-bearing has to be checked on the words that break it.

The outcome is `chained` with a `steps` array of ordinary outcomes. The agent
runs each `action` in the order it was said and gives the overlay a line per
step, so a part that failed stands out in its own colour instead of being buried
in a run-together summary. `allowFollowUp` is granted only if every part allows
it, and a `pause` or `cancel` anywhere in the chain closes the exchange —
otherwise the microphone would reopen on top of a pause that had just shut it.

`/api/voice/test` calls the same `planChain`, because a dry run that disagrees
with the real one is worse than none: it is believed.

### Matching is on meaning, not strings

`matchVoiceCommand()` in `packages/shared` compares stemmed content words with
irregular pasts folded, so one stored phrase `drink water` already covers "I
drank some water". Exact matching does not survive contact with speech
recognition.

Every content word of the phrase must appear — **except the last, and only on a
second pass.** The tail of a sentence is where speech actually gets lost: the
voice drops, Vosk decides the utterance ended, and "mute my mic" arrives as
"mute my". Strict matching then found nothing at all.

`matchVoiceCommandLoosely` is deliberately narrow, because looseness here ticks
off real things:

- only the **last** content word may be missing, never a middle one,
- the phrase needs at least two content words, so a one-word phrase can never
  match on nothing,
- it runs only after the strict pass found nothing, and
- it returns *every* candidate rather than a winner. "drink water" and "drink
  coffee" both reduce to "drink", and guessing between them is precisely the
  failure worth all this ceremony — so the overlay asks instead.

A single loose match still fires, but the overlay says so: *Drink water — 9 of
16 (heard "drink water" partly)*. Wrong data with nothing to prompt going to
look for it is the thing to fear, and that suffix is the prompt.

A habit with no phrases is unreachable by voice; it is never matched on its name.

**Unmatched speech is dropped, not filed as a note.** It used to become one, on
the reasoning that a silent drop had no way back so a junk note beat losing a
sentence. The overlay changed that: a miss is *visible* the moment it happens,
so the drop is no longer silent — while clipped speech had been filing a steady
stream of half-sentences ("mute my", "hey my go"). Notes come from a `note`
command now, and only from it. `/api/voice/misses` still lists the leftovers
from before.

The list is **grouped by what the command does**, in collapsible `<details>`
sections with a count each — a flat list stopped being scannable at about six
entries, and this is a list that only grows. `<details>` rather than hand-rolled
state, so keyboard and screen-reader behaviour comes from the browser.

Which sections are shut is remembered in `localStorage`; reopening them on every
visit is exactly the sort of small chore that makes a screen annoying. Empty
groups are hidden entirely, and saving a new command **opens the section it
landed in** — otherwise adding a hotkey while Hotkeys is collapsed looks like
nothing happened.

Phrases are editable in two places, on purpose. In the habit editor on the
Habits screen, next to the thing they belong to; and on the Voice tab, because
"what can I say, and how do I change it" is a question about voice, and
answering it used to mean leaving the screen and opening every habit in turn.
Both write the same `voicePhrases` array. Edits save immediately rather than
behind a Save button, matching how ticking a habit off works everywhere else.

`/api/voice/test` (Voice → "Try a phrase") answers "what would this
do" without doing it. The failure everyone hits is a phrase that reads perfectly
and never matches; the alternative way to find that out is repeating it at the
microphone while watching a log.

### The vocabulary was on screen

**Voice → "Everything it can hear"** listed Vosk's grammar, grouped by where each
word came from — typed, generated, always included — because a closed grammar's
contents explained most of the confusing things voice did ("I drank water" heard
as "resume water", since the grammar had no "drank"). Removed with Vosk: an
open-vocabulary recogniser has no list, and showing one would describe a
constraint that no longer exists. `/api/voice/vocabulary` and
`vocabularyBreakdown` went with it.

### Only responding to your voice

**Voice → "Teach it my voice"** — say the wake word ten times, and the mean of
the length-normalised embeddings is stored as the voiceprint. Enrolling on the
wake word rather than free speech means the enrolled vectors and the runtime
vectors come from the same words at the same distance from the same microphone,
which is what lets the threshold be strict.

**Enrolment is a mode the running agent enters, not a separate program.** It
cannot be anything else: the agent already holds the microphone, so a second
opener gets `MMSYSERR_ALLOCATED` — which meant the old CLI failed precisely when
someone was most likely to run it, with voice switched on. The server arms a
90-second window, the agent collects wake-word embeddings during it, and
progress appears both on the Voice screen and on the overlay at the cursor.
`npm run voice-enrol` still works and now drives that same path rather than a
second one.

Refused with a reason when voice is off or paused, since it borrows the
microphone that those turn off.

With an always-on microphone this is doing real work: it is what stops the
television, a video on this PC, or someone else in the room from logging habits.
**It is a filter against the room, not a security control** — a recording of your
voice passes it.

Checked in the agent *and* on the server. The agent's copy avoids a pointless
round trip per television advert; the server's is the one that cannot be
bypassed by a stale agent config.

`requireKnownSpeaker` defaults **off** and is switched on by enrolment. On by
default would have meant the settings screen reading "only respond to my voice:
on" while nothing was enrolled and nothing was being checked — a switch claiming
a protection it was not providing.

## App integrations

Canvas for coursework; Spotify and YouTube for what you listen to and watch;
Steam, Discord and Riot for who is around; Twitch for who is on air. `npm run integrations-check -w
@everything/server` proves the parts with no network in them — run it before
trusting a change to the categoriser, the Takeout reader, or the rules that
decide what happens to a synced task.

**Off by default**, unlike everything else that is switchable. Every other
feature works the moment it is switched on; this one does nothing at all until
you have registered an app with a third party and put an id in the environment,
so defaulting it on would add a tab that can only apologise.

### The capability matrix is the feature

Four of these services **cannot do the obvious thing**, for four different
reasons, and finding that out one provider at a time — after building a screen
that shows an empty list — is the expensive way to learn it. So a capability in
`shared/src/integrations.ts` is not a boolean. It carries a `status` and a
`why`, and the screen renders the `why` next to the thing it explains.

| | playlists | following | who's online | coursework | who's live |
| --- | --- | --- | --- | --- | --- |
| **Spotify** | yes* | artists you follow | — | — | — |
| **YouTube** | yes | subscriptions | — | — | **quota says no** |
| **Steam** | — | — | **yes, properly** | — | — |
| **Discord** | — | — | needs their approval | — | — |
| **Riot** | — | — | local client only | — | — |
| **Canvas** | — | — | — | **yes, properly** | — |
| **Twitch** | — | channels you follow | — | — | **yes, properly** |

\* **Spotify needs Premium.** Since February 2026 a Development Mode app stops
working the moment the owner's subscription lapses — it answers
`403 Active premium subscription required for the owner of the app`. The same
change stopped returning *contents* for playlists you merely follow: you get the
name and nothing else unless you own or collaborate on it. Both are in the
capability text, because a 403 on a playlist read otherwise looks like a broken
token.

**Play history was here and has been removed.** Spotify would only ever return
the last fifty plays, so a local history had to be accumulated by polling; a
Google Takeout import covered YouTube, whose API has served an empty watch
history since 2016. Both worked. Neither is here, because the thing they fed —
a taste profile inferred from counts — was never going to be worth the machinery
once `audio-features` was withdrawn. `media_plays` is dropped in migration 0023,
which cost nothing: it held zero rows.

**Battle.net and Epic were here and have been removed.** Blizzard publishes no
social namespace at any access level, and Epic's Friends interface needs a
registered EOS product *and* per-friend consent, so it can never return the
launcher list. Both were rows whose entire content was an explanation of why
they could do nothing, plus launcher-process detection reporting "the launcher
is open" — true, and not worth a row on a screen about who is around.

The research was worth doing and the answer is recorded here; the *rows* were
not worth keeping. `integrations-check` now asserts no shipped capability is
`unavailable` and no provider exists purely to apologise. The status itself
stays in the type, because a future provider may have a dead end worth stating
next to things that work — as YouTube's history did before the Takeout importer
made it real.

**`follows` and `friends` are separate capabilities, and collapsing them was the
first mistake here.** A Steam friend is a mutual relationship with somebody who
is either around or not; a subscribed channel or a followed artist is a one-way
interest in an account that has no presence and never will. Filing the second
under the first put *"Spotify — friends: not possible"* on a screen about who is
online, which answers a question nobody asked and pushes down the one they did.
`integrations-check` asserts the split in both directions, because the tempting
fix is to add the key back "for completeness".

Followed accounts get **their own table** rather than a collection of channels,
which is what they were first. That shape stored a channel as a `media_item` of
kind `video`, so every subscription arrived in the music library with no
duration and no plays, and was counted in the category breakdown as though it
were a track.

### Nothing here needs a text editor

Every credential is a text box on the Services tab. They were environment
variables and nothing else, which made setting a provider up read "open a
terminal, edit a file, restart the app" — the exact friction the three
double-clickable files in the repo root exist to remove.

`ProviderSpec.credentials` declares the fields; the form, the "is this
configured" check and the env-var fallback all read that one list, because three
places listing which fields exist is how they stop agreeing. The value typed in
**wins over the environment variable**, or pasting one would appear to work and
change nothing — the same shape of bug as `features.json` being read from a
directory nobody was writing to.

Three things there are easy to get wrong:

- **A stored value is never sent back to the browser.** The box for a field that
  is set renders empty with a placeholder saying so. Round-tripping a secret
  would put it in the DOM, the response cache and any devtools left open, to
  save one paste.
- **Blank therefore means "leave it", not "clear it".** Following directly from
  the above: a blank box is the normal state for a field that is already set, so
  clearing is an explicit button that sends `''`. Omitting the key means leave.
- **`connected` is decided by having a token, not by the row existing.** The row
  is created the moment you save a client id, which is *configured but not
  connected* — a state that did not exist while these were env vars. Reading
  `account !== null` showed Spotify as connected the instant its id was pasted,
  hid the Connect button, and left no way to finish.

The redirect URI is **sent by the server with a copy button**, not written into
the setup text: it depends on the port and on `OAUTH_REDIRECT_BASE`, so a
hard-coded one would be wrong for anybody who changed either — and wrong in a
way whose only symptom is a rejected login.

Steam went first, for a reason worth keeping: its Web API key is issued to *your
account*, so it is personal data of the same kind as the Steam ID beside it. A
Spotify or Discord client id identifies the *application*. Both now live in the
app, but only the second has any business being an env var at all.

### Every site you have to visit is a link

`setup` is a list of `SetupStep`, not of strings: each step carries an optional
`{ url, label }`, and the screen renders a real anchor. A domain in prose is a
step you retype into the address bar by hand, and linkifying prose with a regex
gets the boundaries wrong exactly where these strings are worst — the Steam one
is `steamcommunity.com/dev/apikey — it asks for a domain`, where the em dash
lands against the path. `integrations-check` asserts every link is an absolute
`https:` URL; a relative one would resolve against the app's own origin and open
a 404 inside the PWA, which reads as a broken app rather than a bad link.

`sourceUrl` is separate from `source` for the same reason it is optional: half
the citations name endpoints rather than pages — `ISteamUser/GetFriendList +
GetPlayerSummaries` — and linking those would invent a URL.

**The setup list stays visible after connecting**, collapsed, retitled *Setup
and troubleshooting*. Hiding it on success removed the links at exactly the
moment they became useful: "Steam returned no friends" is nearly always the
privacy setting, and the link that fixes it is in that list.

**Spotify's 2026 changes broke the sync three ways, all as a bare 403
"Forbidden"** with no hint of which request. Probed one at a time with the
stored token:

- `/playlists/{id}/tracks` refuses even your own playlists. It is
  `/playlists/{id}/items` now, each entry's song is under `item` rather than
  `track`, and the playlist's count is `items.total`.
- **A playlist you follow but don't own refuses both.** A Development Mode app
  reads only playlists you own or collaborate on, so those are skipped and
  counted on the sync's note.
- `/artists?ids=` and `/tracks?ids=` are gone. `/artists/{id}` still answers,
  but with no `genres` field at all. So `ArtistGenres` makes no requests: every
  track's genres are empty, and the categoriser says `unknown`. Paying a request
  per artist for the same nothing would be worse.

The four that hurt, and why they are stated rather than worked around:

- **Spotify no longer tells you how a song sounds.** `audio-features`,
  `audio-analysis` and `recommendations` were withdrawn on 27 November 2024 and
  return 403 to any app registered since. There is no replacement. Categories
  therefore come from the genre strings attached to *artists*, which is why
  syncing costs an extra `/artists` fetch per batch, and why the Music tab says
  what it is doing rather than presenting a genre count as taste modelling.
- **YouTube's watch history has been an empty placeholder since 12 September
  2016**, and the `activities` endpoint that partly replaced it is deprecated.
  Takeout is not a workaround for a missing endpoint — it is the only complete
  record, and it goes back further than an API ever would. The capability is
  therefore `partial` rather than `unavailable`: it read "not possible" directly
  above the button that imports it, which is a row contradicting the control
  beneath it.
- **An optional scope must never make an account unconnectable.** Discord
  answers `invalid_scope` at the *authorize page* for an application without the
  Social SDK enabled — before any token exists — so asking for the friends scope
  unconditionally did not cost the friends list, it cost the whole connection.
  `oauth.optionalScopes` is asked for once, and a refusal is recorded on the
  account so the next attempt drops them and succeeds. The card says which part
  is missing and carries the button that starts asking again, for once the
  feature has been enabled at the provider's end.

  The failure mode this replaces is the worst kind: pressing Connect, being
  refused, and having no route out from inside the app.

- **A gated capability has to say how to ungate it.** `CapabilitySpec.unlock`
  carries the steps, attached to the capability rather than to the provider's
  `setup`, because it is not part of connecting — you can have a working
  connection and still not have this. They render under the capability, and
  again inside the refusal banner, which is the moment you actually want them;
  only one copy shows at a time. `needs-approval` without steps is the same dead
  end `unavailable` was, so `integrations-check` refuses it.

  **Name the menu path, and deep-link to the account's own application.** The
  first version said "look for Social SDK in the left menu", and it is not there
  — it is under *Games*. A step naming a menu entry that does not exist is worse
  than no step. The portal's application id and the OAuth client id are the same
  value, so a `{appId}` placeholder in a link is substituted server-side once one
  has been pasted: the link opens your application rather than a list you then
  search. `resolveSetupLinks` falls back to the generic page when nothing is
  stored, and the check covers both directions plus "no placeholder survives".

- **Discord's friends list comes through `sdk.social_layer_presence`.**
  `grantedScopes` is checked rather than assumed, and that stays whatever the
  approval position is: a token can come back with a scope silently dropped, and
  the difference between "no friends online" and "we were not given permission
  to look" has to be visible. The other route people use is a user token lifted
  out of the desktop client, which is against Discord's terms and is not
  implemented.
### Who is live, and why that is one service and not two

`GET /helix/streams/followed` takes your Twitch user id and returns every
followed channel currently broadcasting, sorted by viewers — **one request, no
per-channel fan-out**. That is the whole reason a Live tab is possible.

**YouTube cannot be asked, and the number is why.** There is no "which of my
subscriptions are live" endpoint. The only route is `search.list` per channel at
**100 quota units** against a **10,000/day** default, so at the 408
subscriptions on this install a single sweep costs 40,800 units — four times the
day's allowance, for one refresh, and it would take the playlist and Following
syncs down with it. So YouTube does not declare the capability, and
`integrations-check` asserts `LIVE_PROVIDERS` has exactly one member: "add it for
completeness" is precisely the change somebody would make.

That arithmetic was on the Live tab for a while, under a heading naming YouTube,
on the reasoning that a service absent from a screen you expected it on reads as
an oversight. It has been taken off: a permanent block of explanation about a
service that will never appear is a tax on every future visit to a tab that is
about Twitch. **The research is recorded here and the row is gone** — the same
call the Battle.net and Epic providers got, and for the same reason.

`integrations-check` still asserts YouTube does not declare the capability, since
that is the part a future change could get wrong. It asserts YouTube's absence
rather than a count of one: a second service that genuinely can answer this is a
change to welcome, not to block.

**`live` is not a flavour of `follows`.** Following somebody is a standing fact
about you; being live is a fact about them that is true for three hours on a
Tuesday. One list you curate, the other empties itself — which is also why
`replaceLive` deletes and re-inserts where `replaceFriends` upserts and prunes.
Nothing points at a live row, so churning its primary key costs nothing, whereas
doing that to a friend destroyed the `person_id` links that join their accounts.

**Starring a channel is a flag on `follows`, not its own table.** A favourite is
a property of a channel you follow, and unfollowing should take it with you —
which the prune-by-`seen_at` in `replaceFollows` does for free. The star survives
an ordinary sync because that upsert names the columns it overwrites explicitly,
the same protection `group_id` already relies on.

That home cost one thing, and it showed up immediately on real data: **the star
needs a `follows` row to exist, and the live list is what people open while the
followed list is only fetched by a "Sync now" nobody has a reason to press.** The
symptom was 21 live channels and a star that refused every one of them with a
message telling you to go and press a button. `syncLive` now syncs the followed
list once when it has never synced — same permission, same account, one extra
request the first time, which is a far better answer than a feature that depends
on somebody reading an error.

**The panel narrows, the tab does not.** `/api/integrations/live` always returns
everything and carries the scope alongside; the panel filters. Filtering
server-side would have meant a second endpoint or a query parameter to tell the
two callers apart, when the tab is precisely where you go to see everybody and
press the stars.

The panel subscribes to `settings` as well as `integrations`, because the scope
it filters by is a setting. Subscribed to only `integrations`, changing "Starred
only" left an open Dashboard showing the old filter until something unrelated
changed — which reads as the setting not having saved.

Two empty states, because a narrowed panel showing nothing while four people are
live is not the same as a quiet evening, and "Nobody is live" would be a lie in
the first case. It says *"None of your starred channels are live — 21 others
are"*, and the count in the header reads "2 of 21" while the filter is hiding
something.

**Two buttons, not a slider.** A slider is right for a number on a continuum —
the gauge drain and fill both earn one. This is a pair of named alternatives,
where a slider would have two positions, no labels at the stops and no way to
show which is live except by where the handle sat.

**The redirect URI default had to become per-provider.** `OAUTH_REDIRECT_BASE`
was one global string defaulting to the loopback IP, because Spotify and Google
stopped accepting `http://localhost` and require `http://127.0.0.1`. Twitch is
the other way round: it documents `http://localhost:PORT`, and the numeric form
is what its console refused. No single value serves both, so
`oauth.loopbackHost` says which spelling a provider wants and `redirectUri`
applies it — while a base somebody actually set is used exactly as typed, since
rewriting a deliberate value would work everywhere except the place it was chosen
for. `integrations-check` asserts both providers' opposite rules.

**And the error message that sent us here may not have meant what it said.**
"Redirect URIs must use HTTPS protocol" is also what the Twitch console shows for
a *blank row* left in the redirect list, where the fix is to delete the empty
field and press Save rather than only Add. So it is genuinely unproven whether
the IP literal would have been accepted; what is settled is that `localhost`
works and is what Twitch documents. The setup steps say both, because somebody
hitting that message needs to check the boring cause before believing the
interesting one.

**`scope` is a string in RFC 6749 and an array at Twitch.** Spotify, Google and
Discord all answer `"a b c"`; Twitch answers `["user:read:follows"]`, so
`token.scope.split(' ')` threw `token.scope.split is not a function` — **after
the token had been issued**, which is the worst place for it: the handshake had
succeeded, the connection failed at the last step, and the message named a string
method rather than the provider that broke the assumption. `TokenResponse.scope`
is now the union and `grantedFrom` normalises it, so the next provider with an
opinion is a compile error rather than a runtime one three lines later.

An absent or empty `scope` falls back to what was *asked* for, deliberately:
several providers omit it on a refresh, and reading that as "nothing granted"
would report a working connection as having lost its permissions. An empty
*array* is taken at its word, since that is a provider saying something.

**Twitch is the first provider here that genuinely needs a client secret.** PKCE
has never shipped for their authorization code flow — the request has sat open on
their forums for years — so `pkce: false` is a declaration rather than an
omission, and there is a second box on the card. `integrations-check` asserts
both halves, since a `pkce: true` here would send a verifier and no secret and
the token endpoint would refuse every login with nothing on screen but a 400.

Refresh-on-read like the friends list, at a **30-second** staleness window rather
than 60: a friend who came online a minute ago is the same news either way, while
a stream that ended three minutes ago is a link to a channel that is not on.
Still nothing at all while the tab is closed.

### Canvas: the one capability that writes into core

Everything else in this module ends up on a screen the module owns. A Canvas
deadline ends up as an ordinary **task**, which the nudge engine then holds and
releases exactly like one you typed. That is the whole reason to want it — the
engine is the app, and a deadline it cannot see is a deadline it cannot hold for
you.

**Read from `/api/v1/planner/items`, not from each course's assignment list.**
Both exist, and the obvious one is worse in three ways: `/courses` then
`/courses/:id/assignments` is a request per course, it returns last year's
courses unless every one of them is filtered by term, and it says nothing about
whether you handed anything in. The planner is what the Canvas dashboard itself
draws, so it has already answered "which of these are current" the way a student
expects — and it carries the submission state, which is what lets handing
something in on Canvas tick it off here.

Three things about it are unlike every other provider here, and all three are
worth knowing before rather than after:

- **It has no fixed address.** Every school runs its own Canvas, so the host is
  half the credential. That is a `base_url` column on `integration_accounts`
  rather than being folded into `external_id`, which means "who you are to
  them" — a hostname is not that, and storing it there would have worked and
  read as a mistake forever after. Generic on purpose: anything self-hosted
  joins by filling it in.

  It is also why the setup steps name a menu path in words rather than linking
  it, which nothing else in this file does. The page you get the token from is
  on the server you have not named yet.

- **The token is not read-only, and cannot be made so.** Every other provider is
  connected with a scoped read-only grant. A Canvas personal access token is the
  whole account — grades, submissions, messages — because Canvas issues no
  narrower kind to a personal app. This module stores tokens in the clear, for
  the reason set out above, so the setup text and the connect form both say so
  where you will read it. `https` is therefore **refused rather than assumed**:
  `canvasHostInput` rejects an `http://` host outright instead of upgrading it,
  because a scheme typed by mistake would put that token on the wire in the
  clear, and a next-page link on a different origin is not followed for the same
  reason.

- **Assignments become tasks, and the rules for that are the interesting part.**
  They live in `syncTasksFromService` in `store.ts`, not in the provider, so a
  second school platform inherits them rather than forming a second opinion.

#### A deleted task must stay deleted

`integration_task_links` remembers that an item was turned into a task **even
after that task is gone**. That table is the whole design, and the obvious
alternative is the bug: deduplicating against `tasks` itself — which a
`(source, source_id)` unique index would give you — recreates a task you
deliberately threw away, on the very next sync, within the minute, with nothing
on screen to explain it. Whichever way that argument is had, you lose it.

So `task_id` goes null when the task goes, and a null one means "made once, and
gone" — a decision, not a gap, never acted on again. The same null records an
assignment that was **already handed in when we first looked**, which is what
stops a term's worth of finished work arriving as a hundred tasks the first time
you connect.

#### Afterwards, only the deadline is carried across

Extensions happen weekly and a stale `dueAt` makes the nudge engine wrong, which
is the one thing this feature exists to get right. A title that changed at Canvas
is rare and a stale one is merely untidy — whereas overwriting a title *you*
renamed is an edit nobody asked for, and there is no signal here that could tell
the two apart. `notes` is never touched for the same reason: it holds the course
name to begin with and is yours after that.

The comparison is against **what Canvas last said**, not against the task's own
`dueAt`, so moving a deadline yourself is not undone by a service that has not
changed its mind.

**Ticking off only ever goes one way.** Canvas saying "handed in" closes the
task; Canvas saying nothing never reopens one you closed. Submissions get
retracted and windows reopened, and a task coming back to life would be the app
arguing with you about something you had finished.

#### What the id has to carry

`plannable_id` is unique only within a kind, so `assignment:91` and `quiz:91` are
two things. Without the prefix the second would silently never become a task.

`planner_note` and `calendar_event` are deliberately not coursework:
the first is a to-do you wrote *in Canvas*, and importing those would have two
apps quietly competing over one list; the second is a fact about your timetable
rather than something with an outcome. Something Canvas reports as `dismissed` is
left alone, since that is the same request made of a different screen.

`submissions` arrives as `false` when there is nothing to hand in, rather than as
an object with everything unset — reading it as truthy would mark everything
done.

#### Two columns on `tasks`, and they are core

`source` and `source_url` are on the core `tasks` table, holding **opaque
slugs** that are deliberately *not* validated against `PROVIDER_IDS` — those
live in a deletable folder, and core checking against them would be core
depending on a feature. Exactly the arrangement `settings.hidden_providers`
uses. All core does is render the string, so a slug that no longer means anything
shows a label nobody clicks.

They exist because a task appearing on your Dashboard that you did not write is
confusing in a specific way — "did I write this, can I delete it, will it come
back" — and the chip is what answers it.

#### The one thing in this module on a timer

Everything else here is refresh-on-read, and a 60-second friends poller was
refused at 1,440 requests a day. Coursework is the opposite case, and the
difference is what the data is *for*: a friends list is something you go and
look at, so reading it is the moment it has to be true, whereas a deadline's
whole job is to reach the nudge queue while you are thinking about something
else. A "Sync now" button as the only route in would mean the one feature that
exists to remember things for you had to be remembered.

**48 requests a day while connected, none at all otherwise** — half an hour,
chosen against the sweep, which queues a task within an hour of its due time. It
lives inside `integrationRoutes` with an `onClose` hook and both handles
`unref`ed, so it goes away with the folder, core never learns it exists, and
`smoke` and `features-check` can still close an app without hanging on it.

#### Two smaller things this turned up

- **The api-key connect form was Steam's alone**, gated on `provider.auth ===
  'api-key'`. Correct exactly until a second api-key provider existed, at which
  point Canvas would have been shown a box asking for a Steam profile. Both are
  now gated on the provider id, since the two credential pairs have nothing in
  common.
- **"Services to leave out" listed every provider**, and that panel governs only
  the Friends and Following lists. Canvas feeds neither, so its box would have
  done precisely nothing — with a line underneath admitting as much. The list is
  now filtered to providers that actually contribute to one of the two.

### Who is online, and which process asks

Steam and Discord are web APIs the server calls. Riot is not reachable that way,
so the **agent** gathers it and POSTs to
`/api/integrations/presence` — the same division the voice feature draws.
Anything about *data* happens on the server, which owns the database; anything
about *this machine* happens in the agent, because the server is meant to be
movable and has no business assuming League is installed on the same box.

- **Riot** is the League client's own loopback API. It writes a `lockfile` next
  to itself containing a port and a password while it runs, and deletes it on
  exit — so the file's presence *is* the liveness check. TLS verification is off
  because the certificate is Riot's own self-signed one; the connection is to
  `127.0.0.1` on a port named by a file only this user could have written, so
  there is no network path to sit in the middle of.

  **What it plays is asked of the client, not looked up in a table here.** The
  friends payload names the mode as an internal enum — `RANKED_SOLO_5x5`,
  `CHERRY`, `KIWI` — which reached the screen verbatim. A hand-written table
  fixed the obvious ones and got two of seven live friends wrong:
  `/lol-game-queues/v1/queues` calls `KIWI` **ARAM: Mayhem** and queue 1740
  **Bravery Arena**, not simply Arena. So the queue list is fetched once per
  client session — keyed on the lockfile port, since a new port is the only way
  it can have changed — and the table survives only as the fallback for a client
  that will not answer. It is ~150KB, which is nothing once and absurd every 30
  seconds.

  Both `gameQueueType` and `gameMode` arrive as **empty strings rather than
  absent** when the client has no answer, so `??` kept the empty one and put
  friends on screen playing nothing at all.

  **`availability` says far more than it knows, so `online` has to be earned.**
  It answers "is this account signed in to Riot somewhere" — true of a launcher
  left open on the desktop and of the phone companion app, and reported as
  `chat`, the same value somebody in champion select gets. Measured against a
  live list: six friends were `chat` with `productName: "Riot Client"` and no
  League data at all, and were on screen as online.

  The `lol` block is the honest signal. The client fills it in for anybody it
  can see a League session for and leaves it empty otherwise, so an empty one
  means "signed in, but not here" — which covers the launcher and the phone with
  one rule rather than a list of product names to keep up with. The demotion
  only ever *weakens* a claim: `offline` and `away` are taken as given, and only
  `online` needs the evidence.

  They become `away` rather than being dropped — "reachable, but not about to
  join a game" is what `away` already meant for the companion app.

  **`hosting_` is a prefix, not a value.** `IN_GAME_STATUSES` listed a literal
  `hosting_GAME` that never appears — the real ones name the queue, so
  `hosting_JADE_RANKED_SOLO_5x5` and `hosting_PVE_PUZZLE_TFT` both fell through
  to merely `online`. A lobby counts as in-game here: a queue has been picked
  and they are waiting on players. Fourteen people read as in-game where seven
  did.

### A friend row that does not squash, and a way to message them

The chip and the buttons were holding their width while the name and status
column shrank around them, so at 375px the text broke into ragged lines beside a
full-width "steam + discord". Measured on the real list before and after:

| | before | after |
| --- | --- | --- |
| narrowest text column | **32px** | 214px |
| names broken over more than one line | **13 of 40** | 0 |
| worst status line | **8 lines** | 2 |

Two rules, and neither hides anything. `flex-basis` plus `min-width: 0` on the
text column is what actually lets it ellipsis — a flex child defaults to
`min-width: auto` and refuses to shrink below its content — and `flex-wrap` lets
the trailing controls drop underneath instead of squeezing what is worth
reading. Hiding the chip below a breakpoint was the alternative and costs the one
place that says which services a merged row came from. At 1280 nothing wraps, so
the wide layout is exactly as it was.

**Message opens Discord**, via `discord://-/users/<id>`. One link covers both
ends: the desktop client claims the scheme on this PC and the Discord app claims
it on a phone, so there is no platform sniffing. A real `<a href>` rather than a
click handler, for the reason `everything://` needs one — Chromium gates handing
a URL to an external program on a user gesture and treats an anchor navigation as
one far more readily than a scripted assignment.

That needed `providerUserId` on each account in the friends payload: the `id`
beside it is this app's row key and means nothing to Discord. It is carried for
every provider rather than only the one using it today, since it is already in
hand.

**Like the `everything://` button, the handoff itself is not verified here.** The
automation browser refuses external-protocol launches outright, so a click
produces no launch and no error — which is what that policy looks like and also
what a broken link looks like. The href is asserted to be a well-formed
`discord://-/users/<snowflake>` on 104 of 113 rows; whether Discord opens needs
one press in a real window.

Steam has an equivalent — `steam://friends/message/<id>` — and is deliberately
not there yet: Discord is where the messaging happens, and a second button per
row costs width on the screen this change was about.

### Switching whole statuses off

A second row of chips under the services one, one per status with its count and
its own coloured dot. The two things it is for pull in opposite directions and
are the same control: everything but *in-game* off answers "who could I join",
and *offline* off answers "stop showing me the other hundred and thirty".
Toggles rather than a one-of-these picker, since both are several clicks of the
same kind and a picker could only do the first.

**The state is a list of what is hidden, not of what to show.** That makes
"everything" the empty case, so a new presence state appears on screen the day
it is added rather than being invisible until somebody remembers to add it to an
include list.

Two things there are easy to get wrong and were checked on the real list:

- **The counts are taken before this filter applies.** Counting what survives it
  would send every count to zero the moment you switched that status off.
- **A status that is switched off keeps its button**, even with nobody in it.
  Hiding `offline` on a list that is mostly offline is exactly when you want to
  undo it, and the button is the only way back. There is a **Show all** too,
  because undoing four toggles one at a time is how a filter gets left on.

Switched-off chips are dimmed *and* struck through — opacity alone did not read
as off across a row of six — while the count stays legible, since "offline 136"
is the number that says what switching it back on would cost.

An empty list names **which** filter emptied it. Three stack here — service,
search, status — and "nobody matches" while a status toggle is off sends
somebody looking for a problem that is a button they pressed.

### Presence has a colour, and it is not the accent

A dot on the corner of each avatar: **blue in-game, green online, yellow away,
red busy, grey offline**, with "I cannot tell" drawn as a hollow ring.

**`in-game-away` exists because a friend was mistaken for available.** Steam and
Riot each report "in a game" and "idle" as *separate* facts, and both providers
were collapsing them: `gameextrainfo ? 'in-game' : …` and
`playing ? 'in-game' : state` each checked the game first and threw the
availability away. So somebody AFK mid-match showed the same blue dot as
somebody actually at the keyboard. That is worse than missing information — it
is a confident claim in the wrong direction, which is the failure this whole
screen exists to avoid. On the live list the moment it was fixed: **two of four
people who looked available were not**.

A game still beats `online`, which is the weaker half of what the provider said,
and no longer beats `away`. `dnd` is deliberately untouched: busy while playing
is a choice somebody made rather than idle time accruing.

**The dot is the away yellow carrying a ring of the in-game blue**, and the fill
is the load-bearing half — the mistake was reading blue as "available", so it has
to belong to the away family at a glance. The ring adds the second fact rather
than replacing the first, composing two colours already learned instead of
inventing a seventh. It sits in the away group, whose heading was *"signed in,
but not in a game"* and is now *"not answering"*, because the old wording became
false for exactly these rows.

`STATUS_ORDER` on the Friends screen is a hand-written list, so a new state has
no filter chip until it is added there — `in-game-away` had none for one build,
which is a filter you cannot switch off. `integrations-check` now walks every
state.

**`dnd` had to become a real state to draw it.** Riot and Steam both publish it
and both were folded into `away`, which loses the only thing it says — the
person is *there* and has asked not to be disturbed, where away is the opposite
claim. It ranks above `away` and sits in the top group, because busy is a choice
somebody made and idle is what happens when they walk off.

**The colours deliberately do not follow the accent.** Everything else on screen
does, and these must not: green means online in every chat client on this
machine, and re-teaching that per accent would make the one row of colour
carrying meaning the one you cannot read at a glance — with the accent applied,
choosing red would have made every online friend look busy. They are declared
twice, once per theme, for the same reason the accents are: the pale dark-theme
green and yellow vanish against white.

`unknown` is a hollow ring rather than a sixth colour, because any filled dot
would be a claim about somebody nobody can vouch for, and grey would say offline
— the specific thing that state exists to avoid saying. Each dot carries a
`title` and an `aria-label`, since a colour is nothing to a screen reader and
nothing to anybody who cannot tell the green from the red.

**The friends list counted `away` as online, which was the same lie one level
up.** "N online" meant "not offline", so a Riot list — which is mostly launchers
and phones — reported 39 people online when 9 were. `away` is now its own count
and its own section, headed *"Away — signed in, but not in a game"*, sitting
between online and offline. Being signed in somewhere is worth showing; it is
not the same claim as being here.

  Avatars come from Community Dragon, the public mirror of the client's own
  assets: Riot reports an icon id and no URL. Same arrangement as the Steam and
  Discord avatars — a URL the browser fetches, nothing this app stores.

**A local report names its provider once, on the envelope.** `localPresenceSchema`
used `friendSchema`, which requires `provider` on every row; the agent sent it
at the top level, correctly, since a snapshot cannot span two providers. So
**every report carrying actual friends was rejected 400 and only the empty ones
landed** — and both paths that send an empty list are failure paths, so the
screen showed a stale "connection refused" from whenever the client last
restarted while 164 live friends never arrived. The only evidence was a wall of
identical zod issues in `logs\agent.log` that nothing surfaced.

The schema now `omit`s the field, so sending it is impossible rather than
merely redundant, and `replaceFriends` takes the narrower `ReportedFriend[]` —
it always took the provider as its own argument and never read it off the row.
Unknown keys are still *stripped rather than refused*, because rejecting them
would recreate the same failure with the sides swapped: a newer agent sending
one extra field would have its whole report thrown out. `integrations-check`
asserts both halves.

Epic and Battle.net were also gathered here, by launcher process name, off a
`processes` event `attention.ts` emitted so the scan it already takes could be
reused. Both the providers and that event have been removed — an event in core
existing for one deleted feature is exactly the sort of thing that survives by
being cheap.

Three things there are easy to get wrong:

- **`clientRunning` is stored separately from an empty friends list.** "League
  is closed" and "everybody is offline" both draw zero rows and mean completely
  different things. A closed client therefore does **not** write through: the
  last real snapshot is kept and marked stale, so quitting League leaves the
  names on screen rather than emptying the list.
- **A silent agent is a third state again.** Five minutes with no report is
  reported as stale, distinct from a closed client, because the fixes differ —
  start the agent, versus start the game.
- **The presence POST is excluded from the change announcer.** It arrives on a
  timer and nearly always says the same thing, so `recordLocalPresence`
  fingerprints the snapshot and announces only a genuine difference. Left to the
  generic hook it would reload every open browser every thirty seconds, which is
  the polling the SSE stream exists to replace.

### Discord knows who your friends are; Steam knows whether they are about

**Discord's REST API carries no presence.** `GET /users/@me/relationships`
returns the friends list with no `presence` key on any entry — presence reaches
Discord's own client over the gateway, not over REST. Everything was therefore
defaulting to `offline`, which reported a hundred people as away from their
computers on no evidence at all.

So `unknown` is a presence state distinct from `offline`, and sorts **last** —
below offline. It was between the two at first, on the reasoning that "I cannot
tell" might be hiding somebody who is around; with a hundred unknowns against
eighteen of everything else, that buried the part of the list which answers the
question under the part that cannot.

**"No presence over REST" is not the same as "no presence".** Presence reaches
Discord's own client, and the Social SDK, over the **gateway** — a WebSocket —
and there are two ways to reach it:

- **A bot with the `GUILD_PRESENCES` intent.** Fully documented and stable. A
  bot in a server sees `PRESENCE_UPDATE` for that server's members, so it covers
  people who share a guild with it rather than your whole friends list. It needs
  `GUILD_MEMBERS` as well, and both are ticked on in the portal without review
  while the bot is unverified and in under a hundred servers. The cost is a
  persistent WebSocket in the server process and a bot token to keep.
  **Decided against 2026-08-11** — it buys presence for the subset of friends who
  share a server with a bot, where linking already buys it for the subset who
  have Steam, and only one of those needs a socket held open forever.
- **The Social SDK's own gateway session**, which is what the SDK does with the
  OAuth token. It is a native library and the wire protocol is not documented
  for third-party clients, so this route is reverse-engineering.

Neither is built. Discord rows read `discord` where a status would go — naming
the service rather than the absence, since they are the only rows that can have
one and it says where the entry came from.

**Linking is what makes it useful, and a linked person is one row.** They were
returned per account, so somebody you had just matched up appeared twice — the
opposite of what linking them was for. `friends.person_id` marks two accounts as
one human and the read merges them, answering two questions from two rows:

- *who is this* follows `IDENTITY_PREFERENCE`, **Discord first**, because that is
  where somebody chose a name and a picture for themselves rather than whatever
  their Steam persona happens to be. `imacowboyybaybaayy` on Steam is
  `THEREALCTHULHU` on Discord, and only one of those is any use to you;
- *what are they doing* comes from whichever account actually knows, which is
  never Discord — labelled `via steam` so a borrowed status is never mistaken
  for a reported one.

Merged on read rather than stored: the underlying rows refresh on their own
schedules, and a merged copy in the database would be a third thing to keep in
step. Unlinking works by `personId` and dissolves the group, because the row *is*
the person — taking one account out of a pair would leave the other looking
unchanged.

A shared id rather than a links table, because the relation is a grouping and
not a pair — a third service joins by taking the same id, and unlinking is
setting one back to null. `replaceFriends` never touches the column, so a sync
cannot undo your work.

**Auto-linking from Discord is not possible, and the suggestions are guesses.**
A friend's connections live on `GET /users/{id}/profile`, which is a client-only
endpoint and answers 401 to an OAuth app; even `/users/@me/connections` needs a
scope that would only ever describe you. There is nothing authoritative to
import. So names are compared — exact after normalising, or one containing the
other when it is long enough to mean something — and *proposed*. A wrong link
silently attributes one person's status to another, which is worth a click to
avoid.

### The Following list sorts by what you actually listen to

Four hundred names in alphabetical order is a phone book. The default sort is
how many of that account's tracks or videos are in your collections, which puts
the artists you play at the top and the ones you followed once in 2019 at the
bottom.

**That count is why `media_items` carries `creator_ids`.** Matching a followed
artist to their tracks by *name* gets both halves wrong: a collaboration's
`creator` is "A, B" and equals neither artist's name, and a short name is a
substring of longer ones — "Air" would collect everything by Airbourne. The ids
are the same ones `follows.provider_account_id` holds, so the join is exact.
Rows synced before the column existed fall back to an exact whole-name match,
which is right for a solo track and declines to guess at a collaboration.

Counted only where the item is in a collection: a track can be in the library
because it turned up somewhere and since been removed from every playlist, and
"in my playlists" has to mean what it says. One statement for the whole list,
because 408 follows is otherwise 408 round trips for a screen that opens once.

### A box per playlist, on the Music tab

`media_collections.ignored` leaves one playlist out of syncs *and* out of the
"in my playlists" counts the Following tab sorts by. The boxes live in the
collapsible playlist list on the Music tab, next to the playlists they are
about.

This replaced a provider-wide "skip Liked Videos" switch on the Services tab,
and the move is the point: the reason to skip a playlist is that it is enormous
and drowns out everything else, which is a property of the *playlist* and not of
the service it came from. The `ProviderOption` mechanism that switch needed went
with it — `integration_accounts.options` is left behind and unused, because
migrations are a linear journal.

**Liked Videos is ticked by default**, set on insert only so unticking it is not
undone by the next sync. The numbers say why: on this install it is 1,803 items
against 1–16 for every other playlist, and excluding it took the Following
counts from 195 accounts to 12 — which is the difference between "everyone I
ever liked a video from" and "people whose music I actually keep".

**Ticked means ticked everywhere**: out of syncs, out of the Following tab's
counts, and out of the Music tab's own breakdown. That last one was missed at
first, so the library header read 1,879 tracks while ninety-five per cent of
them came from the one playlist that had been excluded — a tick that only half
applies is worse than no tick, because the number looks authoritative either
way. One `exists` condition now serves both counts.

Items in *no* collection are excluded by the same condition. There are none
today, but a playlist deleted at the provider would leave some, and "my library"
means what is in my playlists rather than everything ever seen.

Nothing already synced is deleted when you tick a box; it simply stops being
refreshed and stops counting.

**Every provider card is a `<details>`, collapsed.** Five providers with their
capability lists, citations, credential forms and setup steps is several screens
to scroll past on the way to the one you came to change, on a screen visited
twice a year. The summary carries the name, the state, and a `problem` chip when
the last attempt failed — its own chip rather than the `unavailable` capability
status, which renders "not possible" and is a claim about the *service* rather
than about one failed attempt that will retry.

### Linking accounts that are the same person, or the same creator

`friends.person_id` groups accounts that are one person; `follows.group_id` does
the same for one creator. `linkFriends` and `linkFollows` both **absorb whole
groups**, so a third account joins a pair and two pairs merge into a four.

**Friends could only ever be a pair, and only the screen said so.** "Link" was
replaced by "Unlink" the moment two accounts joined, so the only way to add a
third was to take the pair apart and start again — the server had supported it
all along.

**One button per row, `Link` / `Manage links` / `Done`, on both tabs.** Adding
and removing are the same job, and splitting them across two controls put the
two halves in different places while spending a second slot on every row of a
270-row list for something done a handful of times. The panel lists what is
joined *before* the box that joins more, because you cannot decide what to add
without seeing what is there — a list that previously existed nowhere.

Unlinking is per account inside that panel. The row's old button dissolved the
whole group, which is the same thing for a pair and wrong for three: there was
no way to correct one bad link without losing the good one. A pair still comes
apart in one click, because the server dissolves a group left with one member.

Two things had to be fixed to make that real:

- **The picker filtered on the identity's service, not the group's.** It
  compared against whichever account supplied the name, which is Discord nearly
  always, so a second Steam account was offered to a person who already had one
  and the server rejected it after the click.
- **The server's same-service guard compared only the two named rows.** Right
  while a group was always a pair; wrong once a third could be added, since the
  screen passes the group's *first* account. It now checks the whole merged set
  — and must **deduplicate by row id first**, because `a` and `b` are already
  inside the members query whenever they carry a person id. Without that, every
  legitimate third was refused with "that would give one person two steam
  accounts", naming a service that had exactly one.

**Follows differ deliberately, in two ways.**

*Two accounts on the same service are allowed.* A main channel and a clips
channel is the commonest reason to want this, and "one person, one Discord" is
simply not true of channels. The link route therefore does **not** reuse
`linkFriendsSchema` — sharing the schema would have invited sharing the rule.

*The main one is chosen by hand*, not by a preference order like
`IDENTITY_PREFERENCE`. No rule can say which of two YouTube channels is the main
one; it is a fact about the creator, and picking the bigger or older one would be
wrong often enough to be irritating. `ensurePrimary` runs after every membership
change so a group never renders headless, and unlinking the main promotes
another rather than leaving nobody.

`inPlaylists` is **summed across the group**, not taken from the main account.
It is what the list sorts by, so counting only the main channel's share would
rank a creator below people you listen to far less.

Unlinking is per account on both tabs, and a group of one is dissolved rather
than kept — left alone it renders identically to an unlinked row while still
quietly absorbing whatever was linked to that id next. `unlinkPerson` remains
on the server for dissolving a whole group in one call; nothing on screen needs
it now that the panel lists the accounts.

### How long they have been away

"Away" and "away for three hours" are different answers to whether it is worth
messaging somebody, and only the second is useful. `friends.state_since` records
when an account was first seen in the state it is in now, and the row says
`· away 25m`.

**The whole difficulty is one line of the upsert.** `replaceFriends` runs on
every read of the friends list, so writing `now` unconditionally would peg every
timer to zero several times a minute and the screen would report everyone as
having just stepped away. The column takes `now` only when the state actually
differs — a `CASE` in `onConflictDoUpdate`, so a rename or a changed game leaves
it alone.

**A row with no clock gets one on the next sync**, rather than waiting for a
state change that may never come. Everything predating the column starts null,
and on the real install 120 rows sat that way — visible as friends in the away
section with nothing beside them while their neighbours had numbers, which reads
as broken rather than as restraint. The `CASE` therefore fires on a differing
state *or* a null one, which makes the rule one sentence for every row: this is
when we first saw them in the state they are in now.

**That means a backfilled value understates**, and the row says so on hover
rather than presenting itself as a fact about the person — `AWAY_TITLE` lives
beside the formatter so the tab and the panel cannot word it differently. It
becomes exact at their next transition.

**Only the first minute is silent, and it was five.** Five was reasoning about
the wrong thing — that a fresh "away 1m" is noise — but on a real list it left
rows blank for five minutes among neighbours that had numbers. A small fact beats
a puzzle.

**Null still draws nothing**, which is now only ever the case for a provider that
has never reported presence at all. Every value is a lower
bound anyway: it is measured from when this app noticed, not from when the person
walked away. Guessing a duration for a row we have never watched change would be
the confident kind of wrong this screen exists to avoid.

**Only the two away states get one.** `online` for twenty minutes is a fact about
nothing, `offline` already has the better line in "last on Tuesday", and
`unknown` is specifically the state meaning nobody can vouch for anything.
Anything under five minutes shows nothing either — that is "they just stepped
away", and a number there would tick distractingly on a list that reloads every
minute.

**`presence.ts` now has no imports at all, and that is load-bearing twice.** It
was already split out of `Friends.tsx` so the Dashboard panel would not drag in
the 9.5KB Connections chunk to render six words. Having nothing to resolve is
what additionally lets `smoke` import it and check the formatting — `@app/api` is
a Vite alias, so one type import from it put the file beyond the server's
typechecker the moment the suite reached for it.

**It is on the Dashboard panel too**, where it matters more rather than less:
that column is the glance that decides whether to bother somebody, and "away"
alone does not answer it.

**And it survives being two accounts.** A merged row wears one account's name
and another's status — Discord leads for identity because that is where somebody
chose a name for themselves, and Discord's REST API carries no presence at all,
so the status always comes from elsewhere. The clock follows the *status*, not
the name, or every linked person would silently lose their timer. Asserted end to
end: a Steam↔Discord pair renders the Discord name, the Steam state, and the
Steam clock.

Two things only real data showed:

- **"away · away 2h 15m".** The duration was appended after the status word. It
  joins the word when there is nothing else on the line, and follows a game when
  there is — which is what `in-game-away` is for: "Warframe · away 2h 15m".
- **A row ending in a bare `·`.** The merged-handles list renders after a
  separator, and the filter that drops the name already shown can empty it —
  which it does whenever somebody uses the same handle on both services.

#### The test that deleted a friends list

Written down because it cost real data. The first attempt at verifying this drove
`POST /api/integrations/presence` against the **running app** with one fabricated
friend — and `replaceFriends` prunes anything absent from a snapshot, so that one
row replaced a 163-strong Riot list and every Riot↔Discord link went with it.
The same failure this document already describes one section below, reproduced by
hand.

It was invisible for a second reason worth knowing: `riot` was in
`hidden_providers`, so the probe never appeared in the response either, and
"nothing showed up" read as the write having failed rather than having worked.

The suite drives `replaceFriends` directly against smoke's own throwaway
database now, and the section ends by asserting that an empty snapshot prunes —
the very behaviour that makes the endpoint dangerous, stated where somebody
reaching for it will read it.

### A name keeps; a status goes off

Reported from real use: the Riot client had been shut for hours and somebody was
still on screen playing a match, long after they had gone to bed.

The rows are kept deliberately when a client closes — that is what stops
quitting League emptying your friends list, and the section below is about how
much it cost to get that right. But **keeping the names and keeping the claim
about what those people are doing were one decision, and they are two.** A name
a few hours old is a list. A status a few hours old is a lie with a coloured dot
next to it, which is the failure this whole screen exists to avoid.

So `trustedPresence()` decays a state to `unknown` once nothing has confirmed it
for `PRESENCE_TRUSTED_MS`. `unknown` is exactly right and already existed: a
hollow ring rather than a filled dot, sorted last, left out of the Dashboard
panel, and specifically the value that means *nobody can vouch for this*.

**It is applied on read, after the refresh**, which is what lets one rule cover
every provider. A web service that answered has a fresh `seenAt`; one that
failed does not; a local client that is shut never had the chance. Three causes,
one observable fact — when did anybody last confirm this — and the merge already
excludes `unknown` when choosing which account speaks, so a decayed Riot row
silently defers to a live Steam one for the same person.

**Every state decays, `offline` included.** The tempting version spares it as
"the quiet answer", and it is wrong twice: `unknown` exists in the first place
because *"grey would say offline — the specific thing that state exists to avoid
saying"*, and a rule that decays only some states needs a list of which, which is
what silently goes wrong the day a state is added to it. `STATUS_ORDER` missing
`in-game-away` is the same failure one level up.

**Three minutes, and the number has to clear every legitimate gap.** The longest
is a web provider's 60s `PRESENCE_STALE_MS` refresh window plus the fetch; the
agent's Riot poll is 30s, so this is six missed tries. Much tighter and it flaps
on one slow request, which is worse than the bug — a dot that keeps changing
teaches you to ignore it. It is deliberately *shorter* than
`LOCAL_PRESENCE_STALE_MS`, so "the agent has stopped" is still reported as its
own thing rather than being swallowed.

**The count is reported per service, not merely applied**, for the reason
`hiddenCount` is: 163 hollow rings with nothing saying why reads as the app
having broken rather than as a client that is shut.

#### The fourth state of a local provider, which was missing

Finding this turned up the thing that made it confusing. The status card had
three rungs — agent quiet, client running, client closed — and Riot has a
fourth: **the launcher runs while the game does not.** `riotclientservices.exe`
holds the lockfile open, so `clientRunning` is true and every request for the
friends list answers `404 /lol-chat/v1/friends`.

`recordLocalPresence` handled that correctly and had since the `error` guard
went in — it declines to write an errored report through. The *card* did not:
it read the boolean, skipped the error beside it, and said **"Client running,
last checked just now"**, which is the most reassuring of the four messages
printed over the one state that was quietly serving hours-old statuses.
Measured on this machine at the moment of the report: `clientRunning: true`,
`error: "League client returned 404"`, 163 rows unconfirmed.

### An errored report must not be written through as an empty list

`recordLocalPresence` refused to write when `clientRunning` was false, and that
was only half of it. The agent's *other* empty-list path is "the client is up
but would not answer" — starting, patching, mid-restart — which reports
`clientRunning: true` with an error and no friends. `replaceFriends` prunes
anything absent from the snapshot, so **every Riot friend was deleted and
re-inserted with fresh ids on the next good poll, taking every link to a Discord
account with it**.

Nothing about that was visible. The names came straight back; they were just no
longer joined to anybody, and the Discord side kept a `person_id` nothing else
shared — a group of one, which renders exactly like an unlinked row while
offering "Unlink" for a link that no longer existed. Five pairs were found
unpicked this way. Migration `0031` nulls those, and the guard is now
`clientRunning && !error`: both cases were always the same claim — "I cannot see
the list right now" — and only one of them said so.

### Searching, and the handle you actually know them by

Both long lists lead with a search box, on its own full-width row above the
filters. On Following it had been the last item of a row containing two groups
of buttons, which at any real width put it on a wrapped third line — present,
and the last thing anybody would find.

**Friends matches every handle a person has, not just the name on the row.** A
merged person is displayed under whichever account `IDENTITY_PREFERENCE` picked,
which is Discord almost always — so searching the Steam persona you know them by
found nothing while the row sat there in plain sight. That failure is something
the merge introduced and the search box has to undo. Verified: typing a Steam
handle finds the person shown under their Discord name.

The game is matched too, so "who is in Arena" is a search rather than a scroll.

While a search is running the counts lead with **how many matched**. "1 online"
above a filtered list is true of the list and alarming as a statement about your
friends. The link suggestions are hidden as well — proposals about two other
people are noise when you are looking for a third.

### Two filters, and they are not the same filter

**A selector** across the top — All, then one chip per service with a count.
Transient, `useState` like every other bit of navigation here. It is built from
the `sources` the server already returns rather than a list written in the
component, so adding a presence provider gives it a chip with a count attached
and nothing to edit in a second place. A service contributing nobody is left
out: a chip reading "Discord 0" invites a click that leads to an empty screen,
and the sources panel explains that case properly.

**A collapsible panel at the top of the Services tab** — services to leave out
for good. Stored server-side in `settings.hidden_providers`, like the theme,
because a filter set on the PC that left the phone showing everybody would read
as not having saved.

It began on Friends and does not belong there. Being left out is a fact about a
*service*, the same kind of thing as whether it is connected — and it governs
Following too, so a home on Friends made it both hard to find and wrong about
its own scope.

**One switch, two effects, because no service contributes both kinds of thing.**
Steam, Discord and Riot bring people; YouTube brings channels and Spotify brings
artists. Separate friend and follow settings would have been two lists with no
provider ever appearing in both. Each row says which it costs you — read off the
provider's own capabilities, so a new service says the right thing without that
file being edited.

A follow belongs to exactly one service, so `isHiddenByProviders` covers it
unchanged: with a single account, the every-account test *is* the
single-provider test.

Both lists report what they are leaving out and **name the tab that did it** —
"159 hidden by Services". The panel opens itself whenever anything is ticked.
A count you cannot trace, or a filter you cannot see, is the failure this whole
screen is against; Following's empty state distinguishes the two causes rather
than telling somebody who has hidden both services to go and connect them.

**The two tests are deliberately opposite, and that is the whole design.** The
selector shows a person if *any* account matches; the hidden list drops them
only when *every* account matches. Picking Steam should include the friend you
also know from Discord, and hiding Riot must not remove them — someone you know
from two places is someone you wanted to see, and a filter that quietly takes
them away is one you stop trusting. `isHiddenByProviders()` in `shared` is the
one place that rule lives, and `integrations-check` asserts both directions
along with the empty-accounts case, since `every` on an empty array is true and
would have made a stray row vanish for a reason nothing on screen could explain.

The hiding happens **server-side**, not in the PWA, because the PWA cannot
import `shared` — filtering there would mean a second copy of the condition,
and the phone would need its own. The response carries `hiddenProviders` and
`hiddenCount`, and the header shows "· 159 hidden" beside the online count: this
screen's principle is that a short list explains itself, and "nobody is online"
reads as a broken integration when the real answer is a filter set weeks ago.

The **link picker is not filtered**. Hiding Riot and then being unable to find a
Riot account to link a Discord friend to would make the visible-because-linked
case unreachable — the one thing that rescues a person from a hidden service.

`hidden_providers` is a core `settings` column holding **opaque slugs**,
not validated against `PROVIDER_IDS`: those live in the deletable integrations
feature, and core validating against them would be core depending on a feature.
An id that no longer exists matches nobody, which is also the right behaviour
when a provider is dropped — the setting goes quiet rather than failing to save.
Riot is why it could not live on `integration_accounts` instead: it has no
account row at all, so a `hidden` flag there could not express the one service
most worth hiding.

### Refresh-on-read, not a poller

`GET /api/integrations/friends` refreshes anything staler than 60s and returns.
There is no background poll, and that is a number-backed decision: a 60-second
poller is 1,440 requests a day forever, against a project that tuned its
attention loop down to ~1,500 database rows a day and requires anything on a
timer to justify itself against those figures. Nobody watches a friends list at
four in the morning, and a list nobody is looking at does not need to be right.
The cost is that the first render may be a minute old; after that it is live for
as long as the screen is open.

`friends` is upserted in place and pruned by `seenAt`, never delete-then-insert.
Forty friends stay forty rows however long the app runs, and nobody is handed a
new primary key every minute.

### Tokens are not in the vault, deliberately

`integration_accounts` holds live bearer tokens to your Spotify and Google
accounts in the clear. The vault is unlocked by typing a master password, and a
library sync that runs while you are out cannot type one — so putting them
behind it would mean the feature only worked while you were sitting there having
just unlocked the vault, which is not a feature. Every scope requested is
read-only, and the mitigation is the one the rest of the app already relies on:
`npm run publish-check` refuses to pass on a tracked database.

Connecting and disconnecting are **local-only**, like minting a device token.
The OAuth redirect comes back to a browser on this PC, so a phone over Tailscale
could not finish a handshake it started. Reading is not restricted — seeing who
is online from the sofa is the point of the phone.

**The callback lives at `/oauth/callback/:provider`, outside `/api/`** — the same
move the icons and the manifest had to make, for the same reason: `auth.ts`
protects exactly that prefix, and these are requests the browser's own machinery
makes, which will never carry a bearer token.

It was under `/api/` first, and this document confidently explained why that was
safe: the redirect arrives on a loopback socket with a loopback Host, so
`isTrustedLocal` allows it. **That was wrong**, and it failed on the first real
connection with `{"error":"missing bearer token"}`. `isTrustedLocal` also refuses
a cross-site `Sec-Fetch-Site` — and a redirect from `accounts.google.com` is
precisely a cross-site navigation. That check is correct and stays; it is what
stops a page you are reading from POSTing to 127.0.0.1 in the background. The
route is what had to move.

Nothing is lost by being unauthenticated, because the `state` parameter is what
protected this endpoint all along: 32 random bytes, single-use, ten-minute
window, issued only by the authorize route — which *is* local-only.

**Neither `app.inject()` nor curl sends `Sec-Fetch-Site`**, which is exactly why
this survived being tested. `npm run smoke` now drives the callback with the
header a browser would actually send, and asserts both halves: that the check
still refuses a cross-site request, and that the callback no longer depends on
it.

The redirect URI is **shown on the Services tab with a copy button, read live
from the server**, and is deliberately not written into the setup text. It
depends on the port and on `OAUTH_REDIRECT_BASE`, so a hard-coded copy goes
stale silently — and when it moved out of `/api/`, four hard-coded copies in the
instructions were each one rejected login waiting to happen.

`OAUTH_REDIRECT_BASE` defaults to the **loopback IP literal**, not `localhost`:
Spotify and Google both stopped accepting `http://localhost` while continuing to
accept `http://127.0.0.1`. They are the same machine and not the same string,
and the error message says neither.

### Shuffle properly

`providers/spotify-shuffle.ts`, and a card at the top of the Music tab.
Spotify's shuffle is weighted, so on a playlist of a thousand songs it keeps
returning to the same fifty or so. It also carries its order across devices,
so switching from the phone to the PC picks the same sequence back up. Both go
away if the shuffling is done **here, once, uniformly** (Fisher–Yates over
`crypto.randomInt`), and Spotify is told to play the result **in order**.
Measured over 20,000 deals of 1,000 songs: every song landed in the first 50
between 886 and 1,115 times, against an expected 1,000.

**No playlist is made.** The first version wrote one called "Shuffled", which
was the thing not wanted: a new playlist in the library to avoid making one.
Now it is one of two:

- **Play**: `PUT /me/player/play` with the first song, then the rest through
  the queue (`POST /me/player/queue`, one track per request). Spotify's own
  shuffle is switched off, or it would reshuffle the queue its own way.
- **There is no "Add to queue".** It did nearly the same: songs in Spotify's
  queue play before the album underneath, so both began the shuffle after the
  song on, and the one difference (the album resuming after Stop) was not worth a
  second button. Voice commands saved as `queue` play.

**Two orders, from `shuffle-rules.ts`** (no imports, so they are checked
directly):

- **Shuffle**: every song once, evenly.
- **Random**: drawn afresh for every slot, so a song can come back, but not
  within `repeatAfter` songs of its last play. That gap is capped at one less
  than the number of songs, or a short list runs out. Boosts apply here only:
  a song's own weight times its artists' strongest boost up and strongest
  boost down, not every artist's multiplied, or a collaboration between two
  boosted artists would outrank both of their solo songs. Boosts go down as
  well as up (×0.5, ×0.25, ×0.1), and 0 is "never". An artist set to never
  keeps out every song they are on, duets included. The card lists only the
  songs in the ticked lists and counts artists from those, so `songsIn`
  returns each song's `lists`. Measured: an artist at ×5 played 4.8 times as often
  as an unboosted one over 20,000 draws, and no song returned inside a gap of
  10 in 2,000.

**Random can also weigh when a song last played** (`Recency` in
`shuffle-rules.ts`). A song heard within the last X songs is multiplied down,
and one not heard within the last Y, or not at all, is multiplied up. Both are
nudges, not rules, unlike the gap. What played before Play is pressed is
included: the last 50 from `GET /me/player/recently-played`, seeded at slots
−1, −2, … so the gap and recency see them exactly as they will see what plays
next. **The song playing when Play is pressed is added at the head**:
recently-played lists only finished songs, so without it Random dealt the song
still on as the second one, inside a gap of five. Measured on 40 songs: repeats within 15 fell from 32% to 5.5% at ×0.1,
and with 20 heard and ×5 for unheard, an unheard song came first 85% of the
time against an expected 83%.

**One song, however Spotify lists it.** The same track id in two playlists is
the easy case. The other is a song released twice, on the single and the album
or as "Remastered 2011", which Spotify gives two ids. `songKey` is the title
with anything in brackets or after " - " removed, plus the first artist. Your
library: 93 listings, 80 songs.

Boosts are in `data/spotify-weights.json` (a package cannot add a table), keyed
by track URI and artist id. **Every other setting is in `spotify-shuffle.json`
and shared too**: which lists, the order, the gap, recency and the queue size.
They were per device, like the Library's sort, and that was wrong here: there is
one queue and one session, so the phone's card described choices the PC was not
using. The card saves each change (number boxes after half a second of no
typing) and takes the server's copy on every `integrations` announcement, except
while a save of its own is pending, or the reload would type over you. `saved`
is false until the first save, and the first device to open the card after this
landed hands over what its browser had, so nobody's choices went to the defaults.

**It keeps the queue topped up, and that is the one timer in this module
besides coursework.** Play starts the first song and queues the next N behind
it, where N is the setting (`spotify-shuffle.json`, default 20, no upper limit,
server-side because the session that reads it is). In Random it is never
fewer than the repeat gap, and it is never more than the songs in the chosen
lists (one each), since past that it can only queue repeats. The gap is held
one below that count, or nothing would be allowed to play. The card keeps the
number you typed and applies the limit, and the server clamps again. Spotify never says when a song ends, so a session asks
`GET /me/player` every 45s and tops up when fewer than N of its songs are
ahead. `dealer` in `shuffle-rules.ts` hands out the next song on demand, so the
gap and the deck carry across top-ups: a reshuffled deck never starts with the
song just played. It follows the music across devices: each check reads the device from
`GET /me/player` and adopts it when it changes. Spotify carries the queue over
when you switch from the PC to the phone, but top-ups addressed to the old
device would fail once it is idle, or pull playback back to it. The session is
held in memory and ends itself when something
not from it plays (after its first song has), or on Stop. A restart does **not** end it: the session is saved to
`spotify-shuffle-session.json` whenever it changes (a song finished, a top-up,
a device switch), and `resumeSession` picks it up five seconds after boot,
rebuilding the dealer with what was sent as its history so the gap and the
deck carry on, however old the file is, since a paused session is only written
when something changes. Stop deletes the file; the server closing only pauses
it. `stopped` on the session stops a top-up already under way, so Stop does not
keep adding songs.

**Paused, it slows down rather than ending.** It used to end once nothing had
played for half an hour, so after a long pause the songs already queued played
out and nothing followed them. Now, after ten minutes with nothing playing
(`SLOW_AFTER_MS`), the 45-second timer still ticks but asks Spotify only every
fifteen minutes (`IDLE_CHECK_MS`): about four requests an hour to an empty room,
against eighty while music plays. A late noticing costs nothing you would hear,
because the queue already holds a full `queueAhead` of songs for when the music
comes back. Failing checks slow down the same way, and only a full day of them
(`FAILING_MS`: a lost permission, a deleted device) ends the session.

**"Something else started" is decided by the queue, not by the song.** A song
you added by hand mid-shuffle plays, and is not one of the session's, but
Spotify still plays the session's queued songs after it. So an unknown song
ends the session only once none of the session's songs are still waiting in
`GET /me/player/queue`; until then it is an interlude. Checks never overlap
(`checking`), or a slow top-up and the next check would both add songs.

**It reads the queue, because Spotify keeps app-queued songs like hand-queued
ones.** A second Play while the first's songs still waited put the same songs
in again, a few places apart: two shuffles that knew nothing of each other.
`GET /me/player/queue` is read on Play and before every top-up. On Play, waiting
songs from the chosen lists are **adopted** into the session: counted as
queued, not dealt again, and followed as they play. Anything else waiting is
`foreign`, and meeting it is waiting, not "something else started". The dealer
takes an `avoid` set: Random skips those songs, and Shuffle takes the next card
not in it, keeping the skipped one for later. Spotify shows only the next 20 or
so, so adoption beyond that is not possible.

**Where playback is, is searched forward from where it was.** In Random with a
gap shorter than the queue, one song can be queued twice; searching back from
the end found the later copy, read the session as further on than it was, and
over-filled the queue. `lastIndexOf` is only the fallback, for a skip back.

**The menu's dot asks `/spotify/status`**, three booleans, and only on
`integrations` changes (`SectionMeta.watch`). It had asked the card's full
route, every song and artist, on every change anywhere in the app.

**Play lets the song on finish, always. There was a setting to cut it off,
and it was removed:** nothing here can empty a queue, so it is all adding to
one, and interrupting the song bought only a skip. **It is a workaround,
because the API cannot empty a queue.** The song playing is started again as the only thing playing, with
`position_ms` at the point it had reached, and the shuffle is queued behind it.
What was coming next (the rest of an album or playlist) goes, the song carries
on with at most a blip, and the session waits until the first of its own songs
plays. Songs queued by hand in Spotify cannot be removed by any app, and stay.

**Which device: where you pressed Play, not Spotify's "active" one.**
Spotify's active device is the last one that played, paused or not, so Play on
the phone with the PC paused from earlier started the music on the PC.
`pickDevice` keeps a device that is **playing**, so music on is never moved.
Otherwise it uses the kind of device Play came from (the card sends `phone` or
`computer` from `isMobile()`; voice and older cards count as the PC), and only
then falls back to active, then first.

It needs a device. The active one if there is one, else the first Spotify
lists, so a phone with the app open but idle works. **A cold device is woken by an album**
(`startOn`). With the desktop app just opened and nothing played (its own play
button greyed out), Spotify answered every play and queue request OK and did
nothing: the card read "21 queued" over silence. Probed one at a time: `uris`
did nothing, with or without handing playback over first (`PUT /me/player`,
`play` true or false), and so did a bare play. A `context_uri` woke it. So if
`/me/player` never shows the song, it is started inside its own album
(`offset` by uri), then played again on its own at that point so the album
doesn't follow the shuffle. Play fails rather than leave a session claiming
songs Spotify never took. **And the desktop app 1.3.6.1921 refuses the shuffle
outright** (2026-10-21, the evening it updated itself): awake and playing, a
`uris` play or a queue add answers OK and stops it, with or without a song
started by hand first; only a context plays. The phone's app took the same
requests that evening. Play says so in words and points at the phone. With none, it says to open
Spotify, because the API cannot start the app. It needs
`user-modify-playback-state` and `user-read-playback-state`, which older
connections lack, and it says "press Connect once" rather than surfacing a
bare 403. Not local-only: pressing it on the phone before music is the point.

A sync runs first (at most every ten minutes, and waited on for five seconds
at most; past that it finishes in the background), and a song in several lists
appears once. **Play answers once the music has started**: the
song playing and the first of the shuffle in place. The rest of the queue is
added afterwards (`fill`), marked as a check in progress so the 45-second check
does not top up alongside it. It used to queue everything first, one request a
song under the rate limit, and after a while away that passed the 15s the app
gives a change: the app said "offline" while the server was starting the music.
It is given 90s anyway, since a 429 can hold every Spotify request for 30. Lists with nothing
stored are not offered: a playlist you follow but don't own never has any.

**That turned up a sync bug.** `upsertCollection` wrote the incoming
`snapshot_id` on insert, so a brand-new playlist compared equal to itself and
its songs were never fetched. Three playlists here had a count and no songs,
which is what "those playlists have no songs" was. It inserts null now, and the
sync skips only when `syncedAt` is set too, so rows already stuck fill
themselves on the next sync.

`apiSend` sits beside `apiGet` in `oauth.ts`, so writes get the same refresh on
a 401 and `Retry-After` handling. An empty body is sent as `''`, not
`"null"`: a PUT without a length is refused with a 411.

### The Music tab counts artists, not genres

Spotify's 2026 changes left every Spotify song "uncategorized", so the genre
breakdown was one bar saying nothing. `artistBreakdown` replaced it on screen,
folded away by default: how many tracks each artist is on, in the playlists you
haven't left out. A song counts toward every artist credited on it, the
Shuffle card's rule, and a video counts under its channel. Within a service the
id decides; across services, the same name is one row, because CG5 on Spotify
and CG5's channel on YouTube are one artist to anybody reading the list. **Songs are counted, not rows.** A song saved on Spotify and its video on
YouTube were two rows, and CG5 read 10 for five songs. `songName` reduces a
title to the song: the first part of a Spotify title ("GOT IT MAID - CG5
VERSION"), the last real part of a video's ("CG5 - Inspector Royale (Official
Music Video)"), with brackets, quotes, "w/ @…", "Lyric Video" and the credited
names taken out. Each artist counts a set of those. Titles that still differ
after that are counted twice, which is the safer mistake than folding two songs
into one. The
categoriser below still runs and still files YouTube; it simply isn't shown.

### Categorising, and what it honestly is

`categoriseGenres` folds several thousand provider genre strings into eighteen
families. Coarse on purpose — `escape room` and `deep filthstep` are wonderful
and useless for finding anything, because almost every such tag has a handful of
artists in it and no two people agree what it means.

**The keyword table is an array, not a record, and the order is load-bearing.**
`melodic death metal` contains "metal" and "death"; `pop punk` contains "pop"
and "punk"; `jazz rap` contains both. Narrow families are checked first and
`pop` — a substring of dozens of unrelated names — goes very nearly last. That
property is a test rather than a comment, and it caught a real one: `jazz rap`
landed in jazz until hip-hop was moved above it.

`unknown` is a real member, not a failure. Self-released artists routinely have
no genres at all, and filing those under whatever came closest is how a library
ends up confidently wrong. `categoryBecause` records *which* string decided it,
because a category nobody can explain is a category nobody trusts.

### The Takeout import is two-phase

Same shape as the vault's CSV import, for the same reason: a Takeout archive
contains several files that look alike — search history, comment history,
YouTube Music — and picking the wrong one produces a plausible number of
plausible-looking rows. The first call reports what it found and the window it
covers and writes nothing; you confirm against dates you recognise.

Re-importing is safe. A unique index on `(item, played_at, source)` makes both
feeding mechanisms idempotent, which they have to be: Spotify hands back its
last fifty every single time, and a Takeout file is the whole history every time.

Videos already known from a playlist sync keep the details they have, so an
import can never downgrade a categorised track to a bare title.

### Games: what counts as one, and what may interrupt it

**Settings → Games.** The nudge engine's most consequential rule lives here —
`in-game` has never been a moment, which is the whole reason this is a nudge
engine rather than a to-do list — and until now that rule had no screen at all.
The game list was a constant in `packages/agent/src/games.ts` plus an
`extraGames` array in a config file on the PC, and an app that grabbed exclusive
fullscreen was written to the agent's console and nowhere else.

**No game names ship onto the list.** A row means "this ran here" — anything
else is a catalogue of titles you may not have installed, which buries the two
you do. The built-in names still exist, in `shared`, purely so a game is
*recognised* the first time it runs; they never create a row.

That distinction is what the deadlock below is really about, and it is worth
stating as a rule: **the agent recognises, the server records.**

#### How a game is found, and why the first answer was wrong

Discovery originally hung off `RUNNING_D3D_FULL_SCREEN`, which is Windows'
*exclusive* fullscreen flag. Most people play **borderless**, which never sets
it — so an entire library was invisible and the only thing ever discovered was
the rare game that grabs the display outright. Reported from real use, and the
sort of bug that looks like nothing happening.

Two signals replaced it, and they answer different halves of the question:

- **The window covers its monitor** — `isFullScreen`, which is geometry rather
  than a Windows flag, so borderless counts and exclusive fullscreen still does.
  A *maximised* window does not, because it stops at the work area, which makes
  this narrower than "a big window". Held for two consecutive snapshots, so a
  transition or an installer flashing up does not get listed.
- **The executable lives in a game library** — `looksLikeGameInstall`, matching
  `steamapps/common`, `Epic Games`, `Riot Games`, `GOG`, `Xbox Games` and the
  rest. This is by far the stronger signal, because it is true whatever shape
  the window is.

**Covering the screen gets it listed; the path is what switches it on.** A
browser at F11 and a film both fill a monitor, so that alone can only ever make
a candidate — while an executable under `steamapps/common` is a game whatever it
looks like, and making somebody tick that would be busywork. Verified live: a
borderless Warframe was found, switched on from its Steam path, and its location
recorded, on a machine where the old check had found nothing at all.

The markers are deliberately unambiguous. `Battle.net/` is the launcher's own
folder rather than where Blizzard games install, and `WindowsApps/` holds every
Store app including Notepad — **a marker that catches non-games is worse than
one that misses games**, because a wrongly detected game silently holds your
reminders back and nobody would think to blame this list for it.

**And the desktop is a window covering its whole monitor.** `explorer.exe` was
listed as having filled the screen within a day of this shipping, which it had:
the shell becomes the foreground window every time you alt-tab out of a game, so
the geometry check was right and the conclusion was absurd. `looksLikeSystemApp`
is the counterpart to the library markers and stops something being a *candidate*
at all — a stronger claim, so the folders in it have to be unambiguous.

The omission that matters there is `WindowsApps/`: every Game Pass title installs
beside Notepad, so excluding it would hide a library to be rid of a text editor.
It is checked in the **agent and the server both** — one stops the shell being
reported, the other stops an older agent putting it back — which are the same
check only while both are right, the arrangement the zip reader's path guard
already uses.

**"Interrupt me during this one" is three-state** — yes, no, and follow the
setting above. The null is the design, not laziness about a boolean: stamping
every row with today's default would look identical on the day it was made and
diverge silently forever after. `push_to_phone` made the same choice for the
same reason, and `gamesAllowInterruption` in `shared` is the one place the three
states become two.

**The most restrictive running game wins.** Being interrupted mid-match is the
exact failure this app exists to prevent, and the cost is asymmetric: a nudge
held back arrives a few minutes later, one let through lands in a fight.

**Resolved by rewriting the state, not by teaching `momentQuality` about games.**
That function is the policy table this project keeps small and testable, and
"which executables count" is not a fact about attention states. `resolveMoment`
turns `in-game` into `free` when the settings allow it and hands that to the
same table.

#### The deadlock, and the fix that was worse than the bug

The agent takes its list from the server so the screen can edit it, and it has
to *suppress* anything the screen unticks — otherwise unticking would do nothing
until a restart.

Written as "watch exactly these", that produced: empty table → agent watching
nothing → nothing detected → table stays empty. It reported itself as
`watching 0 games`.

**The first fix was to seed the table from the built-in list, and it was wrong.**
It cured the deadlock and filled a fresh install's screen with sixteen titles the
machine had never run — a list of games you do not own, which is exactly what
this screen should not be.

So the server **overrides** rather than replaces: `exes` adds names the agent
would not know, `off` removes ones the screen has unticked, and the shipped list
stays where it is as recognition. An empty table now means "nothing has run yet",
which is true, rather than "watch nothing", which was fatal.

Both halves of the version hash matter for the same reason: unticking a *shipped*
game removes nothing from `exes`, so hashing only the watch list would leave the
change never reaching the agent.


#### Some games cannot be started by their own executable

Reported from real use: `"start warframe"` ran `Warframe.x64.exe` and got
**"start warframe from launcher"** back. That is not a Warframe quirk — plenty
of Steam games are a thin binary behind a launcher that expects Steam to have
set the environment up first, so the executable is the wrong thing to run even
though it is exactly what was running when the app saw it.

So a row carries a `launch_url` beside its path, and **the address wins whenever
there is one**. `steam://rungameid/230410` is what the desktop shortcut holds,
and it is what works.

**The app id is not in the path, but it is next to the game.** Steam writes an
`appmanifest_<appid>.acf` per install into the library's `steamapps` folder, and
each one records its `installdir` — which *is* the folder name in the path. So
`steamapps/common/Warframe/…` finds the manifest whose `installdir` is
`Warframe`, and that manifest carries `230410`. The `.acf` is read with a regex
rather than parsed, the same call `zip.ts` makes about its own format: two quoted
strings on a line is all that is needed.

**The agent resolves it, and only for games it sees running** — the same rule the
path already follows, and the same division voice and the Riot reader draw. A row
that predates this gets its address the next time the game runs, or you paste one
in: the Games tab has a field for it, because the address is already sitting in
the properties of a shortcut you have.

**This is the one place the shell is handed a protocol other than http, and the
guard is a shape rather than a scheme.** Voice commands may open `http:` and
`https:` only, precisely so a registered handler is never invoked with an
argument we did not write. `isLaunchUrl` allows `steam://rungameid/<digits>` and
nothing else — no query, no fragment, no second segment — because `steam://` can
also install, uninstall and open pages in its own browser. Checked when the value
is stored, and again by the launcher before the shell sees it: those are two
different claims, and they agree only while both are right.

#### Run it, or see where it lives

Each row carries the executable's full path, read from the PID the monitor is
already tracking — so it costs one call per game per snapshot, only while one is
running, and only until the path is known.

**The path is never taken from the caller.** `POST /api/games/:exe/launch` reads
it from the row, which the agent filled in by watching that executable actually
run here; a route that accepted a path would be a remote "run anything" button
wearing a game's name. Local-only on top of that, and `cmd /c start` with the
game's own folder as the working directory, since plenty of games look for files
beside themselves.

Filling a path in had to bypass the write cache, which is the one non-obvious
part: a row created before paths existed is "recently written", so every
heartbeat carrying its location was skipped and the Run button would never have
appeared — on precisely the rows an upgraded install starts with.

#### It costs nothing per poll

The heartbeat arrives every two to fifteen seconds and names the same
executables every time, so `recordSeen` keeps an in-memory set of what this
process has already written and does nothing for anything seen in the last five
minutes. The steady state — one game running for an hour — is zero queries, not
one per poll, which is the row-per-tick cost the attention log was shaped to
avoid arriving by a different door.

The response carries a **hash of the list**, not the list: a hundred executables
on every poll would be the same waste in bandwidth. The agent fetches
`/api/games/watching` only when the hash moves. Hashed rather than counted, for
the reason the voice vocabulary already learned — swapping one game for another
leaves the count identical.

## Attention model

`packages/agent/src/attention.ts` classifies each moment as `free`, `in-game`,
`focused`, or `away`, and emits a `stopping-point` event on the transitions that
matter. Ranked `prime` (a match just ended, back from a break) or `decent` (done
with a call or video) so a queue can wait for a good break instead of spending
itself on a mediocre one.

Game detection lives in `packages/agent/src/games.ts`. The launcher list matters
as much as the game list: `LeagueClientUx.exe` is the lobby — the *best* time to
interrupt — while `League of Legends.exe` is a live match. Unrecognised apps that
grab exclusive fullscreen fire `unknown-fullscreen-app` so the list can grow.
