# Blueprints

Boxes joined by wires that make the app do things, like Unreal's blueprints:
**when** something happens (a match ends, a habit is ticked, a time of day),
**check** a thing or two (am I in a game, is it the weekend, is this habit
done), decide from several at once (**logic**: a gate, a repeat, a
sequence), and **do** something (nudge me, add a task, tick a habit, write in
a note, wait, press keys, open a site, a media key, start a game, play music,
make a note). A hotkey can start one, so a blueprint can be a macro, and so
can a phrase: **every voice command is a blueprint** with a *When I say* box,
provided to the voice package through core's spoken port. The app runs them;
nobody writes code.

| Where | What |
| --- | --- |
| `web/catalogue.ts` | Every kind of box: its fields and its outputs. Imports only `keys.ts` and `maths.ts`, so the server and the screen read one list. |
| `web/maths.ts` | Sums typed into a box, read the way Desmos reads them: a parser of its own (no `eval`), the functions, and what a sum's letters are. No imports, so the board previews a sum exactly as the server works it out. |
| `web/keys.ts` | Key combinations: the names allowed, one spelling for each, and reading one from a browser key press. No imports, so the agent half reads it too. |
| `web/engine.ts` | What a blueprint is, cleaning a graph before it is kept, and the walk a run takes: checks, gates, repeats, sequences, and several wires from one way out, all started at once. |
| `server/fine-timer.ts` | A finer timer from Windows during a short wait, so "wait 20 ms" is 20 rather than 31. Fenced to Windows, with a portable fallback. |
| `web/loops.ts` | What could go round for ever, worked out from the board: loops of wires, and blueprints that set each other off. No side effects, so `blueprints-check` asserts it. |
| `web/schedule.ts` | When the timed boxes are due, and the note under *Every so often*. No imports but the catalogue's helpers. |
| `server/index.ts` | Its API, listening to core's `happenings`, the asking and the doing, the run log, the one timer for time-of-day boxes, and the agent's hotkeys and key presses. |
| `server/store.ts` | `data/blueprints.json`, `data/blueprints-runs.json` and `data/blueprints-variables.json`. |
| `server/rules.ts` | The templates, a game's name from its file, and what an old voice command becomes. |
| `web/view.tsx` | The screen: the list, the bar (On, Test, Run) and the last run. |
| `agent/index.ts` | The agent half: long-polls the server for the hotkeys to listen for and the keys to press, and puts up *Show a popup* and *Ask me* in core's popup. |
| `agent/keys.ts`, `agent/machine.ts` | Pressing keys; opening a site, a media key, starting a game. The only files in the agent that act on the PC, and they say how carefully. |
| `server/convert-voice.ts` | Voice's old commands made into blueprints, once. The mapping is in `rules.ts`. |
| `web/Canvas.tsx` | The board: dragging boxes, pulling wires, panning and zooming, by mouse or finger. |

`npm run blueprints-check -w @everything/server` proves the rules.
