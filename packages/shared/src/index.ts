/**
 * Vocabulary shared by the server, the PWA, and the Windows agent.
 *
 * These three talk only over HTTP, so this package is the single place where
 * their understanding of a task, a nudge, or an attention state can drift.
 * Keep it free of runtime dependencies beyond zod.
 *
 * Each topic is its own file beside this one; this file only gathers them, so
 * an importer writes `from '@everything/shared'` whichever it needs.
 */

export * from './attention.js';
export * from './records.js';
export * from './habits.js';
export * from './voice.js';
export * from './voice-commands.js';
export * from './nudges.js';
export * from './settings.js';
export * from './devices.js';
export * from './vault.js';

/* ------------------------------------------------------------------ */
/* App integrations                                                    */
/* ------------------------------------------------------------------ */

/*
 * The provider manifest is at `@everything/shared/integrations`, and is
 * deliberately **not** re-exported from here, like `./features`: it is large,
 * and only the integrations package and its checks want it.
 *
 * Anything that loads this package must resolve `./x.js` to the `.ts` beside
 * it, as tsx and every bundler do. Plain `node` does not, which is why
 * `make-icons.mjs` runs under `node --import tsx`: it used to run under plain
 * node, and this file had to stay one file with no imports of its own for it.
 */
