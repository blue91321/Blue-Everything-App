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

/** The database handle, and the schema every table is declared in. */
export { db } from './db/client.js';
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
