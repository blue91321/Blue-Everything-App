# @everything/agent

The Windows agent: one Node process with no window of its own. It watches what
you are doing, reports it to the server, and shows what comes back. It talks to
the server only over HTTP, as the browser does.

```bash
npm run agent -w @everything/agent    # needs the server running
npm run doctor -w @everything/agent   # is the Win32 layer healthy?
npm run bench -w @everything/agent    # what one poll costs
```

| Where | What |
| --- | --- |
| `src/index.ts` | Starts everything, and loads the packages' agent halves (`packages/modules/<id>/agent/index.ts`). |
| `src/attention.ts` | The attention loop: `free`, `in-game`, `focused` or `away`, and stopping points. |
| `src/games.ts` | Finding games and watching them by process id. |
| `src/win32.ts`, `src/audio.ts` | Win32 and WASAPI through koffi: windows, idle time, whether sound is playing. |
| `src/popup.ts`, `src/overlay.ts` | The one popup window, drawn above fullscreen games. |
| `src/tray.ts` | The tray icon and its menu. |
| `src/sound.ts` | The tones. |
| `src/closing.ts` | Stopping the app when its last window closes, if that is the setting. |
| `src/client.ts`, `src/config.ts` | Talking to the server; `agent.config.json` holds this PC's token (gitignored). |
| `src/cli/` | Try-it scripts: `tray-try`, `overlay-try`, `sound-try`, `popup-check`. |

**It only observes.** It reads window titles and process names; it never
records the screen, and never closes, kills or types into anything. The one
exception is the voice package's `agent/actions.ts`.
