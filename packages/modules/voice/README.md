# Voice commands

A wake word you choose, and spoken commands that tick off habits, take notes,
press keys, open sites and control music; plus two keyboard shortcuts.
Recognition is local (sherpa-onnx), and audio never leaves the agent. Off by
default.

| Where | What |
| --- | --- |
| `agent/voice.ts` | The listener: the microphone, the wake word, then a command. |
| `agent/engine.ts`, `models.ts` | The three speech models, and fetching them. |
| `agent/actions.ts` | Pressing keys and opening sites: the one file in the agent allowed to act. |
| `agent/hotkeys.ts` | The global shortcuts. |
| `agent/cli/` | `voice-setup`, `voice-try`, `voice-listen`, `voice-enrol`, `wake-falsing`. |
| `server/routes.ts`, `actions.ts` | What a sentence means: matching it and carrying it out. |
| `web/Voice.tsx` | The screen. `web/voice-api.ts` is its client, `web/voice.css` has its styles. |

What was said is matched by `packages/shared/src/voice-commands.ts`, and
`npm run voice-check -w @everything/server` proves it.
