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

**A nudge now raises both**, and they fail in opposite ways: the popup is the
half that gets *noticed*, the toast is the half that *persists* in the Action
Centre afterwards.

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
npm run pair -w @everything/server -- "Device name" phone   # mint a bearer token, shown once

npm run features         # what is switched on, and what is actually on disk
npm run features-check   # prove each one can be switched off and deleted
npm run publish-check    # is this repo safe to make public?
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

### The wake word fires on a *partial*, or it feels broken

Vosk answers `accept` only when its endpointer decides the speaker has stopped.
Measured with `npm run voice-latency -w @everything/agent`, against synthesised
speech and no microphone:

| | wake word |
| --- | --- |
| speech ends | 1700ms |
| **partial names it** | **700ms** — a second *before* the speech ends |
| endpoint fires | never, inside six seconds of silence |

That is the whole of the "voice is laggy" complaint, and it was paid twice —
once to notice the wake word and again to read the command.

So `voice.ts` watches `wake.partial()` and begins the exchange the moment the
partial contains the wake word. The popup appears while you are still saying it.

**The speaker check must not become collateral.** A partial carries no
embedding, so waking early takes on a debt: the wake recogniser keeps being fed
through the command window until it endpoints and produces one, and
`settleSpeaker()` flushes it if the exchange ends first. That has to run
*before* `wake.reset()`, which discards the audio the embedding comes from —
hence one function called from both endings rather than a line each caller has
to remember. Without it, firing early would report "no voice sample to check
against" and reject every command on a machine with "only my voice" on: a fast
path that silently broke the feature it was speeding up.

Tests and enrolment deliberately stay on the final result. Enrolment needs the
embedding, and a test is a readout of what the recogniser *decided*, not what it
was leaning towards.

The command side gets a smaller version of the same idea: a partial that has not
moved for `SETTLED_POLLS` (300ms) means the decoder has settled and the rest of
the wait is the endpointer being polite. Flushing then is not acting on a
partial — `flush()` finalises properly — it is declining to wait for a verdict
that is already in. In practice the command endpointer is prompt (measured at
100ms after speech ends), so this is a safety net rather than the main path.

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

The warning appears **everywhere the word does**, not only as a summary:

- on the command's own row — the one you are looking at when you wonder why the
  phrase never fires,
- on the group heading, so collapsing a section cannot hide a broken command,
- on the offending phrase chip inside the editor, and
- under the wake word, which is the worst case of all: nothing wakes at all and
  every other diagnostic on the screen looks perfectly healthy.

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

`cursor` is the original behaviour. The nine anchors pin it to a corner instead,
which is what a multi-monitor desk wants: the pointer is wherever you last
clicked, not where you are looking. A pinned popup can follow **whichever screen
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
