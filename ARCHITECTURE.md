# How Blue Everything is put together

A map for working on the code. The [README](README.md) says what the app is and
how to run it. [CLAUDE.md](CLAUDE.md) is the long record of *why* each part is
the way it is, written as it was built; search it for a feature's name when
something here is not enough.

## The idea, in one paragraph

The app is an **interruption-aware nudge engine**. An agent on the PC watches
what you are doing (in a game, in a call, away) and reports it to the server a
few times a minute. The server keeps a queue of reminders (nudges) and, on each
report, decides whether this is a good moment to deliver one. Tasks, habits,
notes and the optional packages exist to give that engine something worth
saying. When a design choice is unclear, pick the one that makes nudges land at
better moments.

```
packages/agent  ──HTTP──►  packages/server  ◄──HTTP──  packages/web (the app, in a
 (on the PC: tray,          (Fastify + SQLite,          browser window on the PC,
  popup, attention,          the only thing that         or installed on a phone)
  voice)                     writes the database)
```

The three only ever talk over HTTP. The agent is an HTTP client like the
browser; it never touches the database. That boundary is what lets the server
move into Docker one day while the agent stays native.

## Where things are

| Folder | What it is |
| --- | --- |
| `packages/server` | The server: routes, the database, the nudge engine. [README](packages/server/README.md) |
| `packages/agent` | The Windows agent: attention sensor, tray icon, popup, sounds. [README](packages/agent/README.md) |
| `packages/web` | The app itself, a React PWA with no router. [README](packages/web/README.md) |
| `packages/shared` | Types, schemas and rules all three agree on. [README](packages/shared/README.md) |
| `packages/modules/<id>` | **Packages** that ship with the app: manga, voice, vault, integrations, weather, trips, push. Each can be switched off or deleted. |
| `modules/` | Packages *installed* from a zip (Settings → Packages). Gitignored. |
| `scripts/` | Start, stop, update, package a release, and the checks. |
| `instances/` | Friends' copies of the server (Settings → People). Gitignored. |

### Core and packages

**Core** is `packages/server`, `packages/agent`, `packages/web` and
`packages/shared`: the nudge engine, tasks, habits, notes, time tracking,
settings and devices. **A package** is one folder under `packages/modules/`
that core does not know about. Deleting it must leave the app booting, with the
package reported as not installed (`npm run features-check` proves this).

So the one rule that shapes most of the code: **core never imports a package,
not even a type.** Where core needs something a package provides, it calls
through a port (`packages/server/src/push-port.ts`) or finds the package by
looking (`import.meta.glob` in `packages/web/src/features/index.ts`).

A package folder holds up to three halves, each loaded by its side of the app:

```
packages/modules/weather/
  module.json        id, label, blurb, version; "server": "server/index.ts"
  package.json       {"type": "module"}, so Node reads its .ts as ES modules
  README.md          what it is and where its code is
  server/index.ts    exports routes(app): its /api/weather/* endpoints
  web/meta.ts        its menu entry, Home tile, Dashboard panels (read eagerly)
  web/view.tsx       its screen (loaded when first opened)
  web/panel.tsx      its Dashboard panels (loaded when shown)
  web/offline.tsx    what it can show offline, if anything
  web/weather-api.ts its client for its own endpoints
  web/weather.css    its styles, imported by view.tsx and panel.tsx
  agent/index.ts     what it runs on the PC, if anything (voice, integrations)
```

A package's server half imports from `@everything/server/module-api` (a stable
surface: the database, settings, change announcements) and its web half from
`@app/...` (core's `api`, `controls`, `format`, `nav`, `useAsync`). It never
imports another package.

## Following a nudge through the code

1. The agent's attention loop (`packages/agent/src/attention.ts`) classifies the
   moment as `free`, `in-game`, `focused` or `away`, and notices *stopping
   points*: a match ending, coming back from a break.
2. It posts that to `POST /api/attention` (`packages/server/src/routes/attention.ts`).
3. The server records the sample (only when something changed), moves tasks
   coming due into the nudge queue, and asks `shouldDeliver()` in
   `packages/server/src/nudge-engine.ts` which queued nudges this moment may
   carry. Quiet hours and Do Not Disturb are decided by `quietReason()` in
   `packages/shared/src/settings.ts`.
4. The answer goes back in the same response, and the agent shows it with the
   popup (`packages/agent/src/popup.ts`), which draws above fullscreen games.
5. If you are away from the PC (`isAwayFromPc()`, `packages/shared/src/attention.ts`),
   the push package sends it to the phone instead.

The app's screens see every change at once through `GET /api/events`, a
server-sent event stream (`packages/web/src/live.ts`): a habit ticked on the
phone appears on the PC with no polling.

## Where do I change…

| To change | Look in |
| --- | --- |
| When a nudge may interrupt | `packages/server/src/nudge-engine.ts`, `packages/shared/src/attention.ts` |
| What counts as a game | `packages/shared/src/games.ts`, Settings → Games (`packages/web/src/views/settings/GamesTab.tsx`) |
| A database table | `packages/server/src/db/schema.ts`, plus a migration written by hand (below) |
| An API route in core | `packages/server/src/routes/<area>.ts`; its client is `packages/web/src/api.ts`, its reply shape `api-types.ts` |
| A core screen | `packages/web/src/views/`; Settings is `views/Settings.tsx` with one file per tab in `views/settings/` |
| Navigation and the menu | `packages/web/src/App.tsx`, `nav.ts`, `menu-prefs.ts`, `menu-groups.ts` |
| Core styles | `packages/web/src/styles/`, in the order `styles.css` imports them |
| Edit mode (renaming and hiding text, moving sections) | `packages/web/src/edit-mode.ts`, `ui-text.tsx`, `reorder.ts`; `packages/web/ui-text-plugin.mjs` makes the source's wording editable at build time; text is stored by `packages/server/src/ui-text.ts` |
| A package | its folder under `packages/modules/`; start at its README |
| The tray, popup or sounds | `packages/agent/src/tray.ts`, `popup.ts`, `overlay.ts`, `sound.ts` |
| Starting, stopping, updating | `scripts/start.ps1`, `stop.ps1`, `update.ps1` |

## Rules worth knowing before you start

- **Core never imports a package.** See above.
- **The server must not shell out to the operating system** in new code: no
  PowerShell, no `cmd /c start`, no Windows paths. Anything that needs the
  machine is the agent's job, asked for over HTTP. (A few old routes still do;
  CLAUDE.md lists them under "Where this is heading".)
- **Migrations are written by hand**, in `packages/server/drizzle/`, each with a
  `when` larger than the one before (a smaller one is silently skipped), and an
  entry in `drizzle/meta/_journal.json`. Never use `drizzle-kit`: its snapshots
  stop at migration 0007, so it would try to recreate tables that exist.
- **`packages/server/src/config.ts` is the only file that reads `process.env`.**
- **Paths are resolved from the source file's own location** (`paths.ts`), never
  from the working directory, because Task Scheduler starts the app in
  `C:\Windows\System32`.
- **The agent only observes**, except `packages/modules/voice/agent/actions.ts`,
  which presses keys and opens sites for voice commands. Keep its guards.
- **Nothing personal is committed.** Run `npm run publish-check` before any push.

## Checking your work

```bash
npm run typecheck        # server, agent and web
npm run checks           # every suite that needs no hardware or network
npm run features-check   # each package can still be switched off and deleted
npm run build -w @everything/web
```

`npm run checks` is also what runs on every push (`.github/workflows/checks.yml`)
and before every release. The suites are listed in `scripts/run-checks.mjs`.
The voice and Win32 checks need a microphone and a desktop, so they are run by
hand; CLAUDE.md lists them under "Running the parts individually".

**The suites leave the running app alone.** `smoke` builds its own server, which
listens on no port, over its own database (`data/smoke.db`), so it can run
while the app is open. The
real app is started by `Blue Everything.cmd` and stopped by `Stop Blue
Everything.cmd`.
