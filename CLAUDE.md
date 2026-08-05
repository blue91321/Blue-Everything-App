# Everything App

A personal, single-user assistant for one person on one Windows PC and one iPhone.
Not a product. No multi-tenancy, no accounts, no sign-up flow — ever.

## What this actually is

The headline feature is **not** a to-do list. It is an *interruption-aware nudge
engine*: something that knows what Blake is doing on Windows, holds a reminder
while he's mid-game, and delivers it the instant he hits a natural break.

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

### Icons

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
| Password vault | Deferred | Build the rest first; leave a vault-shaped hole in the schema. Revisit as "wrap Bitwarden CLI" vs "own Argon2id + XChaCha20 vault". |
| Voice | Push-to-talk on a global hotkey → local Whisper | Far more reliable than an always-on wake word, and the phone can post audio to the same endpoint. |
| Source control | Local git only | Not going on GitHub until Blake is happy with a version. Keep the repo clean enough to publish later. |
| Windows agent | Headless Node service, **not Electron** | Electron costs 150–250MB resident to show a tray icon. The agent is 55MB and has no UI at all — toasts go through WinRT via PowerShell, and the UI is the PWA in a browser. |

## Leanness

This runs forever on a gaming PC, so cost is a measured constraint, not a vibe.
`npm run bench -w @everything/agent` prints the current numbers.

| | Naive | Now |
| --- | --- | --- |
| Resident memory | 150–250MB (Electron) | **55MB** (one Node process) |
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

## Ground rules

- **Never commit real data.** `data/`, `*.db`, and `.env` are gitignored. The
  database is personal; treat it as such.
- The agent is read-only about the system. It observes windows and processes; it
  does not close, kill, or manipulate them.
- Prefer boring, debuggable code. This app has one user and needs to survive
  being ignored for six months and then edited again.

## Running it on this PC

Three double-clickable files in the repo root, because Blake should never need a
terminal to use his own app:

| File | Does |
| --- | --- |
| `Everything App.cmd` | Installs deps on first run, rebuilds the PWA if stale, starts both services, opens the app window. Double-clicking again just re-opens it. |
| `Stop Everything.cmd` | Stops both. |
| `Create Desktop Icon.cmd` | Desktop + Start Menu shortcut with the app icon. |
| `Start Automatically.cmd` | Toggles the logon Scheduled Task on or off. |

Underneath they are `scripts\start.ps1 -Open`, `stop.ps1`,
`create-shortcut.ps1`, and `install-autostart.ps1 -Toggle`.

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
npm run sensor -w @everything/agent    # live attention readout; --seconds N to bound it
npm run smoke -w @everything/server    # end-to-end proof the nudge engine holds and releases
npm run pair -w @everything/server -- "Device name" phone   # mint a bearer token, shown once
```

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

Requests arriving from loopback are allowed without a token. Making Blake paste
a token into a browser on the same PC that runs the server protects nothing and
was the single biggest piece of friction in the app.

Loopback trust is guarded so a web page can't abuse it:

- the raw socket address is checked, never `request.ip`, which honours
  `X-Forwarded-For` when trustProxy is on;
- local trust is disabled entirely when `TRUST_PROXY` is set, since behind a
  proxy every request looks local;
- a cross-site `Origin` or `Sec-Fetch-Site` is refused, which blocks both a
  malicious page POSTing to 127.0.0.1 in the background and DNS rebinding;
- CORS defaults to same-origin only.

Everything else — the phone over Tailscale — needs a bearer token, stored as a
SHA-256 hash. Tokens are minted in the app under **settings → Add a device**,
and that route rejects anything that isn't local, so a token stolen from the
phone still can't mint more. `npm run pair` remains as a CLI equivalent.
`/health` is the only fully public path.

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
