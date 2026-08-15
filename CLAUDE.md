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
dependencies, which is 66KB gzipped and nearly all of it framework.

### Screens

- **Dashboard** — capture, the nudge queue, then tasks bucketed as *Due today*,
  *Anytime* (no date) and *Coming up*, habits left, and *Finished today*.
  Every task has a home here; one with no date used to vanish from view.
- **Tasks** — the full list with editing, open above, done below.
- **Habits** — *management*: reorder, edit, pause, delete, and a −/+ stepper to
  correct the tally. Ticking one off day to day belongs on the Dashboard.
- **Notes**, **Settings**.

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

### Navigation

One left drawer, two behaviours, decided by a single `(min-width: 900px)` query:

- **Desktop** — always visible, content offset by its width.
- **Phone** — slides over the content. Opens by dragging from the left edge or
  with the ☰ button; closes by dragging back, tapping the backdrop, picking an
  item, or Escape.

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
| Voice | Always-on wake word → local Vosk | Revised 2026-08-06. Push-to-talk is cheaper and cannot false-positive, but the requirement was a wake word you can *change from a text box*, and hands-free mid-game. See **Voice** below for what that costs. |
| Source control | Local git, heading for a public GitHub repo | Revised 2026-08-08. `npm run publish-check` is the gate: it asks git whether the sensitive paths are ignored, refuses to pass on a tracked database or key, and warns about personal identifiers. Run it before pushing. |
| Licence | MIT | Decided 2026-08-08, over AGPL-3.0. AGPL's network clause would have forced anyone hosting it to publish their changes, which suits a product with users to protect; this has one user and the point of publishing it is that the ideas get taken. Copyright is held as `blue91321` rather than a legal name, matching the history rewrite that took the personal address out. |
| Commit identity | `blue91321 <blue91321@users.noreply.github.com>` | History was rewritten 2026-08-08 to remove a personal email. Trees verified byte-identical before and after; only metadata changed. `git config user.email` is set locally so new commits match — check it after any fresh clone, because that setting does not travel. |
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

**Voice is the one thing that breaks this budget, and it breaks it badly.**
Measured on this machine, voice on and idle:

| | Agent, voice off | Agent, voice on |
| --- | --- | --- |
| Resident | 66MB cold, 75MB after voice has run | **212MB**, flat once warm (198MB before the overlay module) |
| CPU | ~0.002% | **1.9ms per 100ms block** — ~2% of a core *while the room is audible* |
| Model load | — | 0.2s, on switch-on rather than at startup |

The RMS gate bounds the CPU: a silent room skips the model entirely, so the
honest figure is "2% of a core times the fraction of the day something is
making noise", not 2% flat.

**The memory is the uncomfortable number.** 198MB is inside the 150–250MB range
this project rejected Electron over. The comparison is not quite fair — Electron
cost that to draw a tray icon, this buys continuous speech recognition — but the
raw figure is what it is, and the leanness argument above cannot be quoted while
pretending voice is free.

It is unavoidable *for an always-on wake word*: the acoustic model, the decoding
graph and the speaker model all have to stay resident to answer within a second.
Push-to-talk would not pay it — 0.2s to load means the models could be pulled in
per utterance and dropped again. That is the cost of the wake word being
always-on, as distinct from the cost of it being editable.

**Switching voice off gives it back**, which is why `shutdown()` in `voice.ts`
calls `disposeVosk()` rather than only closing the microphone: 198MB → 75MB,
measured. Without that, "off" would have been a lie about everything except the
microphone — the models would have sat there for a feature nobody had enabled.
The 9MB it doesn't return is heap the allocator keeps, and the DLLs stay mapped.

Recogniser handles must be freed *before* the models they point into, or the
frees dangle. `shutdown()` does them in that order deliberately.

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
of it.** That command bumps all five files, but the commit and tag it creates
contain **only the root `package.json`** — the four workspace bumps are left
sitting in the working tree, unstaged. Nothing warns you.

That is worse than untidy. `version.ts` reads `packages/server/package.json`, so
a clone at the tag `v0.2.0` starts up and reports `0.1.0` on `/health` and on the
Settings screen — the exact question the version exists to answer, answered
wrongly, by a tag that looks authoritative. Caught when 0.2.0 was cut for the
integrations module.

So the bump is two steps, and the second is not optional:

```bash
npm version minor --workspaces --include-workspace-root
git add -A && git commit --amend --no-edit && git tag -d v0.2.0 && git tag v0.2.0
```

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

- **Never commit real data.** `data/`, `*.db`, `.env`, `agent.config.json`,
  `features.json`, the avatar and `logs/` are gitignored. The database is
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
`knock`, `soft`, `blip`, `fall`, `none`). `npm run sound-try -w @everything/agent
-- --tones` plays the palette, which is the only way to choose between them.

A named list rather than a synth editor: what anybody wants from "customise the
tones" is for the wake sound to be distinguishable from the nudge sound and for
neither to be irritating, which is a choice between options rather than a design
task. Empty means "the default for that moment" rather than storing the default
name, so changing `DEFAULT_TONE` later reaches installs that never touched it.
The WAVs are cached by *tone*, not by event, so two moments set to the same tone
share one file. An unknown name falls back to the default rather than to
silence — the palette lives in the agent, and the server deliberately does not
know the list.

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

  The child must outlive its parent, because `stop.ps1` kills every `node.exe`
  whose command line names this project — including the agent whose menu was
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

The message pump is polled like the overlay's, at 250ms rather than 16ms — a
tray click can afford a quarter of a second, and a menu nobody has opened should
not cost 60Hz forever. The two pumps are safe together: `PeekMessageW` with a
null window drains the whole *thread* queue, and `DispatchMessageW` routes each
message to the window procedure it belongs to.

If the icon cannot be created at all the agent logs one line and carries on. A
session with no desktop is not a reason to stop watching for stopping points.

### Its own window, not a browser tab

`Open-AppWindow` in `start.ps1` launches the first Chromium-based browser it
finds with `--app=<url>`: no tabs, no address bar, its own taskbar button and
its own Alt-Tab entry. Losing the app among browser tabs was a real complaint,
and this fixes it without Electron's 150–250MB.

The shortcut points at `start.ps1 -Open`, not at the browser directly, so
clicking it works whether or not the services are already running.

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

### When the server is not running, the window is still there

The service worker caches the shell, so stopping the server leaves the app
window open and looking fine while every request fails. That failure used to be
indistinguishable from a 401 — it dropped you on the **pairing screen**, asking
for a device token, which is the one thing that was not broken. `api.ts` now
throws `ServerUnreachable` for a network failure specifically, and `App.tsx`
renders `Offline.tsx` instead.

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

npm run voice-setup -w @everything/agent   # are the mic and the models actually working?
npm run voice-try   -w @everything/agent   # prove the recognisers, without saying anything
npm run voice-enrol -w @everything/agent   # teach it your voice — say the wake word ten times
npm run voice-check -w @everything/server  # prove the phrase matcher, in memory
npm run voice-latency -w @everything/agent # where the delay between speaking and acting goes
npm run wake-probe -w @everything/agent    # what the wake partial says, block by block
npm run wake-falsing -w @everything/agent  # how often ordinary conversation wakes it
npm run pair -w @everything/server -- "Device name" phone   # mint a bearer token, shown once

npm run integrations-check -w @everything/server  # the categoriser and the Takeout reader

npm run features         # what is switched on, and what is actually on disk
npm run features-check   # prove each one can be switched off and deleted
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

### The one endpoint that matters

`POST /api/attention` is the agent's heartbeat and does everything in one round
trip: records the sample, sweeps tasks coming due into the queue, and returns
whatever earned the right to interrupt. Clients stay dumb; all judgement is
server-side so the phone and the PC can never disagree about what a good moment
is.

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

The replay buffer is cleared at every utterance boundary Vosk reports, not just
on an RMS gap — a close-talk headset can hold the gate open through breathing
between sentences, and a buffer spanning two deliveries comes back transcribed
as one: "hey jarvis drink water hey jarvis drink water".

During a test the wide-vocabulary recogniser runs alongside the wake one, and
words heard while still waiting for the wake word are reported as `speech`. That
distinction is the whole value of the test: "it can't hear me" and "it hears me
fine but the wake word isn't landing" look identical on a level meter and need
opposite fixes.

**The two recognisers endpoint independently**, so the wide one routinely
finishes a block or two before the wake one. Reporting that as "but not the wake
word" over a transcript that plainly contained it was a flat lie that sent you
looking for the wrong problem. The agent now decides `matchedWake` — it is the
only side that knows the wake word without the PWA importing zod — and the
readout says "wake word in there" instead.

`npm run voice-try -w @everything/agent` is the same idea without a microphone —
Windows' own speech synthesiser writes the audio, so it exercises grammar
construction, the block feed and `[unk]` handling. It proves nothing about the
speaker check, since it is not your voice.

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
the speech models go too. Measured:

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
microphone ──► RMS gate ──► wake recogniser ──► command recogniser
  (winmm)      (silence is    ("hey everything",      (habit vocabulary)
                free)          + speaker embedding)          │
                                                             ▼
                                                    POST /api/voice/command
                                                    (server decides intent)
```

### Everything is Vosk, and that is why there is no second dependency

One `libvosk.dll` does both jobs: it recognises the wake word *and* emits a
128-dimension speaker embedding for what it just heard. The obvious alternative
— an ONNX speaker model — meant `onnxruntime-node` (~150MB native) on top of a
separate wake-word engine. Bound through koffi rather than the `vosk` npm
package, which is built on `ffi-napi` and does not build on Node 24.

The models are **not in git** (`packages/agent/src/features/voice/models/`, ~150MB of third-party
binaries). `npm run voice-setup -w @everything/agent` checks what is present and
prints exactly what to download and where to put it.

### An editable wake word is the expensive choice, deliberately

Porcupine and openWakeWord are cheap *because* the keyword is trained into a
model — changing it means retraining on someone's web console. That was the one
property that had to hold, so the wake word is recognised by a general speech
model constrained to a grammar, and is a plain string in `settings`.

**Leading attention words are optional, and one word is allowed.** `"hey"` is
short, unstressed and run into whatever follows it, so the recogniser returns
`jarvis` far more often than `hey jarvis`. Requiring the whole phrase meant the
wake word failing on utterances where the distinctive part came through
perfectly. `wakeWordRequired()` drops leading `hey/ok/hi/yo/…`, so `hey jarvis`
answers to `jarvis` too — verified against the real recogniser, along with bare
`hey` *not* waking it.

A one-word wake word is permitted but warned about rather than refused. It
genuinely is worse — there is nothing before it to rule out ordinary
conversation, and with an always-on microphone that means habits ticked off by
accident. It is also the thing that survives being half-heard, so it is your
trade to make. The schema validates shape only; `wakeWordAdvice()` supplies the
warning.

Two things keep that affordable:

1. **An RMS gate in front of the recogniser.** A silent room costs nothing;
   without it the model would run on all 86,400 seconds of every day.
2. **Two recognisers.** The wake recogniser knows two or three words, so it is
   cheap enough to run continuously and rarely fires by accident. Only once it
   fires does the wide-vocabulary command recogniser get fed anything.

### The wake word waits for a settled answer, not a guess

Vosk answers `accept` only when its endpointer decides the speaker has stopped,
and it can be slow or simply decline to answer at all. So it was tried the other
way: fire on `wake.partial()`, the decoder's current best guess, which names the
wake word around 700ms in — before the word has even finished.

**That was wrong, and the number that says so is the false-wake rate.** Measured
over ten lines of ordinary conversation, none of it addressed to the app, with
`npm run wake-falsing -w @everything/agent`:

| | false wakes on chatter | a brisk "hey jarvis" |
| --- | --- | --- |
| fire on a partial | **3 / 10** | **misses** |
| wait for settled | 1 / 10 | fires |

Three times the interruptions — and it was not even reliable at the job it was
added for, because a quickly spoken wake word never settles into the partial and
only appears in the committed result. An always-on microphone in a room with
other people in it cannot spend that. A wake word that answers a moment later is
strictly better than one that goes off while you are talking to someone.

The partial is also inherently unable to satisfy the speaker check, since it
carries no embedding — so waking on one meant running the wake recogniser
onwards through the command window to collect the evidence afterwards, which is
a lot of machinery to support a guess.

`Recogniser.partial()` still exists, and only the diagnostics use it. That is
how the recogniser inventing "hey jarvis" out of a plain "hey" was caught in the
first place — `wake-probe` prints it block by block.

**What replaced it is asking at the right moment instead of guessing early.**
The RMS gate already knows when an utterance ended: quiet for longer than
`HANGOVER_MS`. At that boundary the wake recogniser is `flush()`ed — a real
finalisation, with the embedding attached — rather than waiting for Vosk to
volunteer an answer, which `voice-latency` shows it may not do inside six
seconds. The boundary is better defined than the endpointer anyway: it is
exactly the moment the sentence stopped, and nothing has to infer when that was.

The command side is the same: its partial is not consulted either. The command
endpointer is prompt — measured at 100ms after speech ends — so there was never
much to win, and acting on a revisable transcript risks running the wrong
command rather than merely a late one.

**The remaining false wake is acoustic, not a rule.** "harvest festival is on
the weekend" genuinely sounds like "hey jarvis" to a grammar that is only
allowed to answer with those words. No decision rule fixes that: a more
distinctive wake word does, and so does switching on **only respond to my
voice**, which is what the enrolled voiceprint is for.

**The tone marks the end of the trigger, and the popup goes up with it.** Both
now happen once you have stopped speaking, so there is no longer a gap to
manage — the listener emits `wake` for the window and `listening` for the tone,
and the run-together case skips the tone because there was no pause to
acknowledge and the result tone is a moment away.

**The pause after the wake word falls inside the command window**, which made
"Didn't catch that" arrive before you had said anything. The command recogniser
endpoints on that pause holding only the replayed wake word — measured:
`2000ms ENDPOINTED text="hey jarvis"`, then `4600ms ENDPOINTED text="drink
water"`. That first result is not a miss, it is "you have not started yet", so
it resets the recogniser and keeps listening. `VOICE_COMMAND_TIMEOUT_MS` still
bounds the exchange, and a miss is reported when the window is genuinely up —
which is the point at which it is true.

### Speaking without a pause used to lose the command

Vosk reports the wake word only when it decides the *utterance* ended, not when
the wake word did. Say "hey jarvis I drank water" in one breath and the whole
sentence goes into the wake recogniser — which returns `hey jarvis`, the rest
being `[unk]`, once you finally stop. The command had already been consumed and
thrown away. Measured before the fix: a pause gave `drink two water`, the same
sentence run together gave `""`.

So the listener keeps a **four-second replay buffer** and feeds it to the
command recogniser the moment the wake word fires. That is what makes fluent
speech work; without it the app rewarded talking like a robot.

The replay deliberately includes the wake-word audio, so the command transcript
usually starts with it. Extra words are harmless to the matcher — but a
transcript of *only* the wake word is not a command, and `hasCommand()` guards
that, or trailing off after "jarvis" would file a note reading "jarvis".

Verified across four deliveries: 600ms pause, 1.5s pause, run together, and run
together at speed. All four deliver.

### The grammar must be able to say what people actually say

The matcher stems, so a stored `drink water` covers "I drank some water". The
**recogniser cannot help**: a grammar only emits words it contains, and the
stored phrase gave it `drink`, never `drank`. Asked to transcribe "drank" it had
to pick something from the list anyway, and what it picked was arbitrary —
"I drank water" came back as **"resume water"**, which matched a one-word
`resume` phrase and paused the music.

So `vocabularyFor` expands every phrase word through `spokenVariants`: the
irregular past, `-s`/`-es`, `-ed`, `-ing`. Widening a grammar normally widens
what can be mis-matched, but not here — every generated form stems back to the
word it came from, so a mis-hear between two of them still reaches the same
command. That property is checked in `voice-check`.

The counting words (`one`…`ten`, `twice`, `once`, `couple`) are in the grammar
**always**, whatever the phrases are. `spokenCount` reads them out of the
transcript, and without them the recogniser was never allowed to say "two" —
"I drank two waters" came back as `waters` and matched nothing at all. A feature
reading for words the recogniser could not produce.

The wake word is deliberately *not* expanded: it is a name, and widening the one
grammar that most needs to stay narrow buys nothing.

`checkWords` carries the literal phrase words separately, so the
can-this-be-heard warning below reports what you typed rather than the
generated forms.

### A grammar can only contain words the model can pronounce

`vosk_recognizer_new_grm` silently drops any word missing from the model's
lexicon, with a warning on stderr nobody reads — so the phrase reads perfectly
and can never match. `"unmute my mic"` was live for days before anyone noticed.

`unknownWords()` in `vosk.ts` asks the model directly via
`vosk_model_find_word`, and the agent reports the result on its heartbeat. That
check generalises: it stays right whichever model is installed, because it asks
that model rather than assuming a word list.

**A phrase said as one word is offered to the grammar too.** "never mind" is
stored as two words, so the grammar could only ever hold them separately — and
a closed grammar has to map every sound onto something it contains. Said as
*"nevermind"*, the recogniser could not answer with the word actually spoken and
picked whatever was nearest, which on this machine was `went` (present only
because `go` is, via the phrase "stop go away", and `spokenVariants` reads the
irregular-past table backwards).

So `vocabularyFor` adds the phrase joined up, and `matchVoiceCommand` treats
that joined token as covering the whole phrase. The two halves are useless
apart: the grammar change lets the recogniser say a word the matcher would
otherwise reject. Adding it is free when it is not a real word — Vosk drops
anything outside the lexicon, so `stopgoaway` and `forgetit` cost nothing and
disappear, while `nevermind` and `drinkwater` survive and work.

`remainderAfterPhrase` and `segmentUtterance` both account for the joined form
as well, or a note would begin with its own trigger and a chained segment would
report every word of itself as unexplained.

The warning appears **everywhere the word does**, not only as a summary:

- on the command's own row — the one you are looking at when you wonder why the
  phrase never fires,
- on the group heading, so collapsing a section cannot hide a broken command,
- on the offending phrase chip inside the editor, and
- under the wake word, which is the worst case of all: nothing wakes at all and
  every other diagnostic on the screen looks perfectly healthy.

Each warning also says what to *do*, because the fix is nearly always the same
one and working it out from first principles is a poor use of anybody's evening:
separate the compound into two ordinary words. That advice sits next to the
warning rather than in a help page, since the warning is where the question gets
asked.

**It is not a small-vocabulary problem, and a bigger model would not fix it.**
Probed against `vosk-model-small-en-us-0.15`: `obstreperous`, `quixotic`,
`netflix`, `youtube`, `obsidian`, `unfollow`, `livestream`, `rewind`, `shuffle`
and `spotify` are all present. What is missing is coinages and compounds —
`unmute`, `unpause`, `playpause`, `fastforward`, `doomscroll`, `valorant`. The
lexicon is the usual ~200k CMU-derived dictionary; a larger model buys acoustic
accuracy, not those words. Two ordinary words beat one invented compound.

`[unk]` must stay in every grammar. Without it Vosk cannot represent "that was
none of these" and forces everything it hears onto the nearest phrase — which
for an always-on microphone means the wake word firing on coughs and music.

**And `[unk]` must be stripped out of the transcript**, in `vosk.ts`. A closed
grammar can only ever emit vocabulary words, so ordinary speech comes back
studded with it — "i drank two waters" arrives as `[unk] drink two water [unk]`.
Stripping it at that boundary means an utterance of *entirely* unknown words
reduces to the empty string, and empty already means "heard nothing" everywhere
downstream. Left in, every unrecognised sentence in earshot would have been
filed as a note reading `[unk] [unk]`.

The models are third-party binaries, so the versions that were actually tested:
`vosk-win64-0.3.45`, `vosk-model-small-en-us-0.15`, `vosk-model-spk-0.4`.

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
| `pause` | closes the microphone, for N minutes or until switched back on | — |
| `cancel` | drops the sentence in progress; the microphone stays on | — |

**The division of labour is deliberate.** Anything touching *data* happens on
the server, which owns the database. Anything touching *this machine* — a
browser, a keystroke — comes back as an instruction for the agent to carry out,
because the server is meant to be movable and has no business assuming it runs
on your desk.

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

Spotify and YouTube for what you listen to and watch; Steam, Discord and Riot
for who is around. `npm run integrations-check -w
@everything/server` proves the parts with no network in them — run it before
trusting a change to the categoriser or the Takeout reader.

**Off by default**, unlike everything else that is switchable. Every other
feature works the moment it is switched on; this one does nothing at all until
you have registered an app with a third party and put an id in the environment,
so defaulting it on would add a tab that can only apologise.

### The capability matrix is the feature

Four of these seven services **cannot do the obvious thing**, for four different
reasons, and finding that out one provider at a time — after building a screen
that shows an empty list — is the expensive way to learn it. So a capability in
`shared/src/integrations.ts` is not a boolean. It carries a `status` and a
`why`, and the screen renders the `why` next to the thing it explains.

| | playlists | following | who's online |
| --- | --- | --- | --- |
| **Spotify** | yes* | artists you follow | — |
| **YouTube** | yes | subscriptions | — |
| **Steam** | — | — | **yes, properly** |
| **Discord** | — | — | needs their approval |
| **Riot** | — | — | local client only |

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
