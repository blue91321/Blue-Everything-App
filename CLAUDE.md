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

Set up on this machine as `desktop-aqo6lhd.tail5a2a48.ts.net`. Note that the
Windows installer does **not** put `tailscale.exe` on PATH, so anything shelling
out to it must try `%ProgramFiles%\Tailscale\tailscale.exe` too — looking it up
by name alone reports "not installed" on a machine where it is running fine.

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
| Password vault | Own vault, own browser extension | Decided 2026-08-06 after comparing Bitwarden, Vaultwarden, KeePassXC and 1Password. Blake wants to own all of it. |
| Voice | Always-on wake word → local Vosk | Revised 2026-08-06. Push-to-talk is cheaper and cannot false-positive, but the requirement was a wake word Blake can *change from a text box*, and hands-free mid-game. See **Voice** below for what that costs. |
| Source control | Local git only | Not going on GitHub until Blake is happy with a version. Keep the repo clean enough to publish later. |
| Windows agent | Headless Node service, **not Electron** | Electron costs 150–250MB resident to show a tray icon. The agent is 55MB and has no UI at all — toasts go through WinRT via PowerShell, and the UI is the PWA in a browser. |

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

## Ground rules

- **Never commit real data.** `data/`, `*.db`, and `.env` are gitignored. The
  database is personal; treat it as such.
- The agent is read-only about the system, **with one deliberate exception**. It
  observes windows and processes; it does not close, kill, or manipulate them.
  `packages/agent/src/actions.ts` breaks that rule on purpose so a voice command
  can press a hotkey or open a site — decided 2026-08-06. It is the only file
  allowed to, and it is the most dangerous code here: a mis-heard phrase does
  not write a wrong row, it presses keys into whatever window has focus. Keep
  its guards intact and do not add a second such file without the same care.
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

npm run voice-setup -w @everything/agent   # are the mic and the models actually working?
npm run voice-try   -w @everything/agent   # prove the recognisers, without saying anything
npm run overlay-try -w @everything/agent   # show the cursor overlay, without saying anything
npm run voice-enrol -w @everything/agent   # teach it your voice — say the wake word ten times
npm run voice-check -w @everything/server  # prove the phrase matcher, in memory
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

When Blake is genuinely away from the PC, nudges go to his phone instead of the
screen. Never both: a toast he's sitting in front of beats a buzz in his pocket.

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

Other guards:

- **A 10-minute cooldown** between pushes, and several waiting nudges become one
  notification. Stepping out for an afternoon shouldn't mean a pocketful of
  buzzes on the way back.
- **Nothing is marked delivered until a push actually succeeds**, so with no
  phone subscribed the queue simply waits and toasts when he sits down.
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
  "he was idle 52 minutes and nothing pushed" could not be answered after the
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
before trusting any change to `src/vault/`.

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
appears at exactly the wrong moment. Blake lost a share to precisely that, so
the kit screen now says so outright and tells him to verify it is really stored
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
password Blake owns, in plaintext. It is parsed in memory, never written to
disk, never logged, and never echoed back — the preview returns counts and
titles only, because a preview that showed passwords would just be a second way
to read the file. The success screen's main job is telling him to delete the
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
word" over a transcript that plainly contained it was a flat lie that sent Blake
looking for the wrong problem. The agent now decides `matchedWake` — it is the
only side that knows the wake word without the PWA importing zod — and the
readout says "wake word in there" instead.

`npm run voice-try -w @everything/agent` is the same idea without a microphone —
Windows' own speech synthesiser writes the audio, so it exercises grammar
construction, the block feed and `[unk]` handling. It proves nothing about the
speaker check, since it is not Blake's voice.

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
is something Blake switched on, not something he finds already running. Turning
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

The models are **not in git** (`packages/agent/models/`, ~85MB of third-party
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
accident. It is also the thing that survives being half-heard, so it is Blake's
trade to make. The schema validates shape only; `wakeWordAdvice()` supplies the
warning.

Two things keep that affordable:

1. **An RMS gate in front of the recogniser.** A silent room costs nothing;
   without it the model would run on all 86,400 seconds of every day.
2. **Two recognisers.** The wake recogniser knows two or three words, so it is
   cheap enough to run continuously and rarely fires by accident. Only once it
   fires does the wide-vocabulary command recogniser get fed anything.

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
| `pause` | closes the microphone, for N minutes or until switched back on | — |

**The division of labour is deliberate.** Anything touching *data* happens on
the server, which owns the database. Anything touching *this machine* — a
browser, a keystroke — comes back as an instruction for the agent to carry out,
because the server is meant to be movable and has no business assuming it runs
on Blake's desk.

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

Electron was rejected at 150–250MB to draw a tray icon and was never going to be
accepted to draw four lines of text. A borderless browser window was the other
candidate and fails the case that matters most: it takes most of a second to
appear and will not float above an exclusive-fullscreen game, which is exactly
when Blake is talking rather than typing. This appears in about a millisecond,
sits above everything, and is `WS_EX_NOACTIVATE` so it never steals focus from
whatever he is playing.

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

### It is a conversation, not a receipt

After answering, the listener calls `listenAgain()`: the microphone stays open
for one more command **without the wake word**, because having just replied it
is still Blake's turn and making him say "hey jarvis" again would be the point
missed. A `pause` is the exception — he asked for silence, so carrying on
listening would be perverse.

When two commands answer to the same phrase the server returns `ambiguous` with
`choices` rather than guessing, and the overlay draws them as buttons.
`POST /api/voice/command/:id/run` carries out whichever is clicked. Guessing
would be the worst option available: a wrongly fired hotkey is not something
anyone would notice was wrong.

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

### Only responding to Blake's voice

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
**It is a filter against the room, not a security control** — a recording of his
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
