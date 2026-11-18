# Calendar

Your own events, calendars read from a link (the secret iCal address Google,
Outlook and Apple give a calendar), `.ics` files imported, and a reminder
before each event, through the nudge queue like every other reminder.

| Where | What |
| --- | --- |
| `server/index.ts` | Its API. |
| `server/store.ts` | `data/calendar.json`, never written over a damaged file. |
| `server/time.ts`, `recur.ts` | Dates and zones, and which days a repeat lands on. |
| `server/ics.ts`, `merge.ts` | Reading an `.ics` file, and putting it into a calendar by UID. |
| `server/link.ts` | Fetching a calendar link, never anywhere inside this network. |
| `server/occurrences.ts`, `reminders.ts` | Events as the occurrences a screen draws, and the one timer that raises reminders. |
| `web/view.tsx` | The screen: a month or a list, the editor, and Calendars. |
| `web/panel.tsx` | "Coming up", for the Dashboard. |
| `web/ask.tsx`, `onboarding.tsx` | The one question it asks: remind you before events? |
| `web/calendar-api.ts` | Its client, and the dates and words it shows. `web/calendar.css` has its styles. |

`npm run calendar-check -w @everything/server` proves the rules.
