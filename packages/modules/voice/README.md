# Voice commands

A wake word you choose, and spoken commands; plus two keyboard shortcuts. What
a command does is a blueprint: a *When I say* box in the Blueprints package
holds its phrases, and its Do boxes do the work. Voice keeps the hearing (the
matching, two commands in one breath, "did you mean") and its own two
commands, stop listening and never mind, which work with Blueprints off.
Recognition is local (sherpa-onnx), and audio never leaves the agent. Off by
default.

| Where | What |
| --- | --- |
| `agent/voice.ts` | The listener: the microphone, the wake word, then a command. |
| `agent/engine.ts`, `models.ts` | The three speech models, and fetching them. |
| `agent/gate.ts` | What is loud enough to listen to: a line set from the room's noise, and the half-second before it opens. No imports, so the test harness runs the same rule. |
| `agent/hotkeys.ts` | The global shortcuts. |
| `agent/cli/` | `voice-setup`, `voice-try`, `voice-listen`, `voice-enrol`, `wake-falsing`. |
| `server/routes.ts`, `actions.ts` | What a sentence means: matching it against the blueprints' phrases (through core's spoken port) and voice's own two, and running the one it was. |
| `web/Voice.tsx` | The screen. `web/voice-api.ts` is its client, `web/voice.css` has its styles. |
| `web/VoiceCommands.tsx` | The Commands tab: the voice blueprints, each with Open, and voice's own two. |

What was said is matched by `packages/shared/src/voice-commands.ts`, and
`npm run voice-check -w @everything/server` proves it.
