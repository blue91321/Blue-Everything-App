# App integrations

Canvas coursework as tasks; Spotify and YouTube libraries; who is online on
Steam, Discord and Riot; who is live on Twitch; and a proper shuffle for
Spotify. Nothing happens until a service is connected, on the **Connections**
screen.

| Where | What |
| --- | --- |
| `server/routes.ts` | Its API, `/api/integrations/*`, and its two timers (the coursework sync and the Spotify forum watch). |
| `server/providers/` | One file per service, plus `spotify-shuffle.ts` (the shuffle) and the rules files beside it. |
| `server/store.ts`, `sync.ts`, `oauth.ts` | Storage, syncing, and connecting accounts. |
| `agent/` | Riot's friends list, read from the League client on this PC. |
| `web/Integrations.tsx` | The screen's tabs: Friends, Live, Following, Music, Services. |
| `web/panel.tsx` | The Dashboard's friends and live panels. |
| `web/integrations-api.ts` | Its client. `web/integrations.css` has its styles. |

The list of services and what each can do is `packages/shared/src/integrations.ts`.
`npm run integrations-check -w @everything/server` proves the rules. CLAUDE.md,
"App integrations", says why each service works the way it does.
