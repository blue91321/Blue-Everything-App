# Phone notifications

Web push to the installed app on a phone, for a nudge that comes due while you
are away from the PC. It fills the push port core calls; with this folder gone,
nudges simply wait for you at the PC.

| Where | What |
| --- | --- |
| `server/index.ts` | Provides the push port to core (`packages/server/src/push-port.ts`). |
| `server/push.ts` | Sending, the cooldown, and clearing dead subscriptions. |

`npm run push-test -w @everything/server` sends a test to every subscribed
phone. iOS needs the app installed to the Home Screen over HTTPS; see the
[README](../../../README.md).
