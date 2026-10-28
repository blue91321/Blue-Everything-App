# @everything/server

The server: Fastify over SQLite (libsql through Drizzle). It is the only thing
that writes the database, and it serves the app (`packages/web/dist`) on the
same origin as the API.

```bash
npm run dev -w @everything/server     # on :8787, migrations applied on boot
```

| Where | What |
| --- | --- |
| `src/main.ts` | Starts it. `src/app.ts` builds the Fastify app: auth, core routes, then packages. |
| `src/routes/` | Core's API, one file per area (`tasks.ts`, `habits.ts`, `attention.ts`, …). |
| `src/nudge-engine.ts` | `shouldDeliver()`: whether this moment may carry a nudge. |
| `src/db/` | `schema.ts` (every table), `client.ts`, `migrate.ts`. Migrations are in `../drizzle/`. |
| `src/auth.ts` | Who may call what: this PC by loopback, everything else by device token. |
| `src/config.ts` | The only file that reads `process.env`. |
| `src/paths.ts` | Every path on disk, resolved from this file's location. |
| `src/features.ts`, `src/modules.ts` | Which built-in features and which packages are on, and loading the packages. |
| `src/module-api.ts` | What a package's server half may import (`@everything/server/module-api`). |
| `src/notes/` | Notes' storage, and importing and exporting other apps' formats. |
| `src/instances.ts` | Friends' copies of the server (Settings → People). |
| `src/cli/` | The checks: `smoke`, `vault-check`, `features-check`, … (`npm run checks` runs them). |

**Migrations are written by hand**, with an increasing `when` in
`drizzle/meta/_journal.json`. Never run `drizzle-kit`.

**New code here must not shell out to the operating system.** Anything that
needs the machine is the agent's job. See [ARCHITECTURE.md](../../ARCHITECTURE.md).
