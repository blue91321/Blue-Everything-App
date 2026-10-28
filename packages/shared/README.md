# @everything/shared

What the server, the agent and the app must agree on: input schemas (zod), and
the rules all three apply, such as when it is quiet and when you count as away.
They only ever talk over HTTP, so this is the one place they can drift apart.

`src/index.ts` gathers the topic files, so an importer writes
`from '@everything/shared'`:

| File | What |
| --- | --- |
| `attention.ts` | Attention states, how good a moment is, `isAwayFromPc()`. |
| `records.ts` | Tasks and projects, time entries, notes. |
| `habits.ts` | The three kinds of habit and `habitWantsDoing()`. |
| `voice.ts`, `voice-commands.ts` | The wake word and vocabulary; matching what was said against stored phrases. |
| `nudges.ts`, `settings.ts`, `devices.ts`, `vault.ts` | Their inputs. `settings.ts` has `quietReason()`. |

Some are subpaths instead, deliberately not gathered: `features.ts` (the
built-in features), `integrations.ts` (the provider manifest), `modules.ts`,
`games.ts`, `sound.ts` and `notes.ts` (the Markdown parser, which has no imports
at all, so the app can use it without zod).

It is TypeScript source and is never built: everything that loads it (tsx, Vite)
reads the `.ts` directly. Plain `node` cannot, which is why the icon script
runs under `node --import tsx`.
