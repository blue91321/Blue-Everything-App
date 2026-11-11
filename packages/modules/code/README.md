# Code

The app's own source, inside the app: a map of its parts, every file the
repository ships, and an editor that colours them. Any of your devices can read
it; saving is only from the PC running the app, and a save is used the next
time the app starts.

| Where | What |
| --- | --- |
| `server/index.ts` | Its API: the list, one file, the committed copy, and saving. |
| `server/files.ts` | Which files are offered (only what git or the release ships, never a secret), reading, and saving with the file's own line ends. Also the syntax check before a save. |
| `web/view.tsx` | The screen: the map, the tree and an open file. |
| `web/Editor.tsx` | The editor: a text box over a coloured copy of the same text. |
| `web/highlight.ts` | The colouring and the "what changed" diff, with no imports. |
| `web/code-api.ts` | Its client. `web/code.css` has its styles. |

`npm run code-check -w @everything/server` proves the rules.
