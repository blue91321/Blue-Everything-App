/**
 * What a server-side package is allowed to reach into.
 *
 * The browser half of a package is handed React and the API client through
 * `register(host)`; this is the same idea on the server, and it exists for the
 * same reason. A package that lives in its own folder cannot say
 * `import { db } from '../../db/client.js'` — the relative path is a fact about
 * where the *server's* source happens to sit, and moving a feature into a folder
 * of its own breaks every one of them.
 *
 * So a package imports `@everything/server/module-api` instead, which resolves
 * from the repo's `node_modules` whether the package ships in
 * `packages/modules/` or was unzipped into `modules/`.
 *
 * ### This is a promise, not a convenience
 *
 * Everything re-exported here is something a package may depend on across
 * versions of the app. That is a real cost — it is the difference between an
 * internal that can be renamed on a whim and one that cannot — so the surface is
 * deliberately the ten things the four built-in features actually use, arrived
 * at by counting rather than by guessing at what somebody might want.
 *
 * ### It is not a sandbox and does not pretend to be
 *
 * A package is imported into this process. It could reach past this file with a
 * relative path, `process`, or `node:fs` any time it liked. The point of the
 * surface is to give honest code a stable thing to build against, not to contain
 * dishonest code — which is why the Packages screen says plainly that installing
 * one runs a program.
 */

/** The database handle. */
export { db } from './db/client.js';

/**
 * Every table, both as a namespace and by name.
 *
 * The whole schema, deliberately, rather than the tables a package "owns" —
 * because a package does not own any. Migrations are a linear journal and
 * skipping one breaks every later hash, so `vault_entries`, `voice_commands`
 * and the integration tables are created whatever is switched on. That was
 * already the honest boundary of "removable" here; this just makes the code
 * match it.
 *
 * Both shapes because both are already in use: the moved features import tables
 * by name, and `schema.settings` reads better in code that touches several.
 */
export * from './db/schema.js';
export * as schema from './db/schema.js';

/**
 * Environment, already parsed and validated.
 *
 * `config.ts` is the only file allowed to read `process.env`, and that rule
 * holds for packages too — which it can only do if they are given this.
 */
export { config } from './config.js';

/**
 * Announcing a change, so every open client refetches.
 *
 * A package that writes something and does not announce it leaves the phone and
 * the desktop disagreeing until something unrelated happens, which is the exact
 * failure the live stream exists to prevent.
 */
export { changes, type ChangeScope } from './events.js';

/** Settings as the nudge engine reads them, resolved and typed. */
export { getSettings } from './nudge-engine.js';

/**
 * The port a push implementation registers itself through.
 *
 * Core holds a no-op that the push package replaces when it loads — the reason
 * this is a port at all is that "push is not installed" and "no phone is
 * subscribed" are the same situation, and the engine already handled the second
 * one correctly.
 */
export { providePush } from './push-port.js';

/**
 * The only two functions that write a habit entry.
 *
 * Exported because the voice package needs them and there must not be a second
 * copy: there was one once, it was identical to the HTTP route right up until
 * gauge mode arrived, and then saying "I drank water" logged an entry and left
 * the gauge exactly where it was.
 */
export { recordHabitDone, undoHabitDone } from './routes/habits.js';

/**
 * Reading the two opaque-slug settings columns.
 *
 * `hidden_providers` and `dashboard_panels` are stored as JSON arrays of
 * strings that core deliberately never validates — the ids belong to packages,
 * and core checking them against a package's list would be core depending on a
 * package. Which means core owns the *parsing* and a package owns the meaning,
 * so the parser has to be reachable from both.
 */
export { parseHiddenProviders, parsePanelList } from './routes/settings.js';
