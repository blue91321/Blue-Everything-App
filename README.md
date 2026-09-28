# Blue Everything

An **interruption-aware nudge engine** for one person, one Windows PC and one
iPhone.

It is not a to-do list. The point is that it knows what you are doing on
Windows, holds a reminder while you are mid-match, and delivers it the instant
you hit a natural break. Tasks, habits, time tracking and notes exist to give
that engine something worth saying.

Built for one user. There is no multi-tenancy, no accounts and no sign-up flow,
and there is not going to be. If you want to run it, you run your own copy.

```
Windows agent  ──┐
 · attention sensor │
 · Windows toasts   ├──►  Fastify + SQLite  ◄── Tailscale ── iPhone PWA
 · voice listener  ─┘      (runs on your PC)         · web push
                           · tasks/habits/notes      · quick capture
                           · nudge queue
```

## Pick what you actually want

The nudge engine is the app. Everything else is optional:

| | What it does |
| --- | --- |
| **on** | the default for everything that ships |
| **off** | routes unmounted, tab hidden, the agent never loads it |
| **deleted** | remove the folder; the app boots and reports it as not installed |

**Settings → Packages** lists them — the password vault, voice, app
integrations, phone push, weather and manga, each in `packages/modules/<name>/`
— with a switch, its size and a Remove button. A change takes a restart, and
the screen has the button for it. Habits, notes and time tracking can be
switched off but not deleted: the Dashboard uses them.

The same switches are in `features.json` and `modules.json` (per-install, and
gitignored), and `npm run features-check` proves each package can be switched
off and deleted without breaking the build.

## Running it

Requires **Windows**, **Node 24+** and git. The server and PWA are portable;
only the agent is Win32-specific.

```bash
git clone https://github.com/blue91321/Blue-Everything-App.git
```

Then double-click **`Blue Everything.cmd`** in the folder. The first run
installs dependencies and builds the app, which takes a few minutes; after that
it opens in its own window in seconds, with a tray icon under the `^` arrow.
**`Create Desktop Icon.cmd`** adds a shortcut, **`Start Automatically.cmd`**
starts it at logon, and **`Stop Blue Everything.cmd`** stops it, as does **Stop** on the
tray icon.

Nothing is shared between installs: your database lives in `data/` in your
copy and is never committed.

From a terminal instead:

```bash
npm install
npm run build -w @everything/web      # build the PWA; the server serves it
npm run dev   -w @everything/server   # server on :8787, migrations applied on boot
npm run agent -w @everything/agent    # the Windows agent — needs the server up
```

### Manga, if you want it

Chapters come from [Suwayomi](https://github.com/Suwayomi/Suwayomi-Server/releases/latest),
a separate program: download the `Suwayomi-Server-….jar` and install **Java 21
or newer** so that `java` is on your PATH. Then **Manga → More → Where chapters
come from** finds the jar (or takes its path), and the app starts Suwayomi when
you read and stops it afterwards. Add sources from **Extensions** on the same
card — a fresh Suwayomi has none, and finds nothing until you do.

### The phone

The PWA installs from the server over Tailscale. iOS requires a **secure
context** for service workers and push, so a plain tailnet IP will not do:

```bash
tailscale serve --bg 8787
```

That publishes it at `https://<machine>.<tailnet>.ts.net` with a real
certificate, which iOS accepts. `serve` keeps it inside your tailnet; `funnel`
would expose it to the internet, which this app should never use.

### Voice, if you want it

The speech models are ~150MB of third-party binaries and are **not in git**.

```bash
npm run voice-setup -w @everything/agent
```

prints exactly what to download and where to put it, then proves the microphone
and recognisers work. Voice is off by default in settings even when installed —
it is the only feature that holds a microphone open, so it should be something
you switched on rather than something you find already running.

## Checking your work

Each risky subsystem has a script that proves it, because the failures here are
quiet ones:

```bash
npm run smoke         -w @everything/server   # the nudge engine holds and releases
npm run vault-check   -w @everything/server   # the cryptography
npm run vault-api     -w @everything/server   # the vault over HTTP
npm run import-check  -w @everything/server   # the CSV reader
npm run voice-check   -w @everything/server   # the phrase matcher
npm run features-check -w @everything/server  # features can be switched off and deleted
npm run doctor        -w @everything/agent    # the Win32 layer
npm run bench         -w @everything/agent    # what one poll costs
```

## Leanness

This runs forever on a gaming PC, so cost is a measured constraint.

| | Naive | Here |
| --- | --- | --- |
| Resident memory | 150–250MB (Electron) | **55MB**, or 212MB with voice on |
| DB rows/day | ~43,000 | **~1,500** |
| CPU | 0.26% of a core | **~0.002%** typical |

Voice is the one thing that breaks this budget, and it breaks it badly — an
always-on wake word means the acoustic model, decoding graph and speaker model
all stay resident. Switching it off gives it back (198MB → 75MB, measured);
deleting it gives back the disk too. That trade is the reason the feature
switches exist.

## Make it yours

**Settings → Appearance** picks the theme (dark by default), one of eight accent
colours, and the app mark — a pause glyph, circle, triangle, square, or your own
picture. The accent applies to the icon too, so the tab, the taskbar and your
phone's home screen all match the app.

Icons are rendered per request rather than built, which is what lets them follow
the setting; a static file would keep showing whatever was current when the app
was built. The Windows shortcut icon is the exception — it is a real file the
shell reads, so `npm run icons -w @everything/web -- --accent green --shape
triangle` rebuilds it to match.

## Your data stays yours

`data/`, `*.db`, `.env`, `agent.config.json`, `features.json`, the avatar and
`logs/` are all gitignored. Before pushing anything anywhere:

```bash
npm run publish-check
```

It asks git whether the sensitive paths are genuinely ignored — rather than
re-reading `.gitignore` — refuses to pass on a tracked database or key, and
warns about personal identifiers such as tailnet hostnames and real email
addresses. It runs with no dependencies, so it works on a fresh clone.

Audio never leaves the agent process. There is deliberately no endpoint that
accepts a recording, nothing is written to disk, and nothing is logged but text.

## Licence

[MIT](LICENSE). Take it, change it, build on it — just keep the copyright
notice. No warranty: it reads your window titles and holds your passwords, so
satisfy yourself it does what you want before trusting it with either.
